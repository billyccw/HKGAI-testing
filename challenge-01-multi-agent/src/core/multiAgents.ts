import { parseSnapshot } from "./canvas.ts";
import { plannerAgent, referenceRetrievingAgent, nodeAddingAgent } from "./agents.ts"
import { LocalRunStore } from "./runtime/store.ts";
import { type RunRecord } from "./runtime/types.ts";

export type EventPhase = "received" | "planning" | "tooling" | "validating" | "completed" | "blocked";
export type AgentEvent = {
  id: string;
  runId: string;
  phase: EventPhase;
  kind: "stage" | "tool" | "validation" | "error";
  message: string;
  createdAt: string;
  metadata?: Record<string, string | number | boolean | null>;
};
export type MockMultiAgentRequest = {
  runId: number;
  instruction: string;
  snapshot: unknown;
  simulateFailure?: boolean;
};

export async function runMultiMockAgent(request: MockMultiAgentRequest): Promise<RunRecord> {
  // 初始化store和agents
  const store = new LocalRunStore();
  const planner = new plannerAgent();
  const referenceRetriever = new referenceRetrievingAgent();
  const nodeAdder = new nodeAddingAgent();
  const agentLabels = { retriever: referenceRetriever, composer: nodeAdder, critic: planner }; // role -> agent
  const maxConcurrency = 3;

  const run: RunRecord = { runId: request.runId, requirementVersion: 1, requirements: [], tasks: [], events: [], status: "running"};
  const events: AgentEvent[] = [];
  const emit = (phase: EventPhase, kind: AgentEvent["kind"], message: string, metadata?: AgentEvent["metadata"]) => {
    events.push({
      id: `${request.runId}:${events.length + 1}`,
      runId: store.runKey(request.runId),
      phase,
      kind,
      message,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, events.length)).toISOString(),
      ...(metadata ? { metadata } : {}),
    });
    run.events = events;
  };
  const blocked = async (message: string): Promise<RunRecord> => {
    run.status = "blocked";
    emit("blocked", "error", message);
    await store.saveRun(run);
    return run;
  };
  emit("received", "stage", "已接收任务；当前为Multi Agent 确定性模拟。 ");
  if (!store.runKey(request.runId).trim()) return blocked("运行 ID 不能为空。");
  const instruction = request.instruction.trim();
  if (!instruction || instruction.length > 2000) return blocked("指令须为 1 至 2000 个字符。");
  let snapshot;
  try {
    snapshot = parseSnapshot(request.snapshot);
  } catch {
    return blocked("画布快照校验失败，未执行工具。");
  }
  if (!snapshot.nodes.length) return blocked("请先添加至少一个节点。");
  emit("planning", "stage", "呼叫规划Agent进行分工", { nodeCount: snapshot.nodes.length });
  await store.saveRun(run);
  // 实作开始

  // 分工
  const result = await planner.plan(instruction);
  if (!result["ok"]){
    return blocked(result.message);
  }
  run.tasks = result.tasks;
  await store.saveRun(run);

  // 将工作交给agents
  for (const task of run.tasks) {
    const corrspondAgent = agentLabels[task.role]
    task.workflow = corrspondAgent.createWorkflow();
    corrspondAgent.acceptedTasks.push(task)
    emit("planning", "stage", `${corrspondAgent.name} 接受 ${task.id}`, { taskId: task.id });
  }
  await store.saveRun(run);

  if (request.simulateFailure) return blocked("模拟工具失败；起步包不自动重试。");

  // 排程执行任务直到所有task都完成/阻塞/过时
  let round = 0;
  while (round++ < 500) {
    // 记录当下所有task状态，将没有未处理dependsOn的task从pending设置为ready
    const snap = new Map(run.tasks.map(t => [t.id, t.status]));
    for (const t of run.tasks) {
      if (t.status === "pending" && t.dependsOn.every(id => snap.get(id) === "done")){
        t.status = "ready";
        emit("planning", "stage", `${t.id} 准备就绪`, { taskId: t.id });
      }
    }

    // 2) 挑出這一輪要推進的task（併發上限）
    const active = run.tasks
      .filter(t => t.status === "ready" || t.status === "running")
      .slice(0, maxConcurrency);

    if (active.length === 0){ // 所有任务都没有办法再推进，判断结果并返还
      for (const t of run.tasks) {
        if (t.status != "done"){
          return blocked(`再无可以run的task，阻塞原因：${t.id} 状态 == ${t.status}`)
        }
      }
      run.status = "completed";
      const output = `任务：${instruction}\n画布：${snapshot.projectName}\n节点：${snapshot.nodes.map((node) => node.data.title).join("、")}\n连接：${snapshot.edges.length} 条\n结果：已完成本地结构摘要，未调用模型或生成媒体。`;
      run.output = output
      emit("validating", "validation", "摘要已生成，未修改画布或执行外部副作用。");
      emit("completed", "stage", "模拟运行完成。");
      await store.saveRun(run);
      return run;
    }

    // 3) 各推進一步
    for (const task of active) {
      task.status = "running";
      if (task.workflow){
        const nextWork = task.workflow?.find(s => !s.done);
        if (nextWork) {
          emit("tooling", "tool",  `${agentLabels[task.role].name} ${task.id} 调用本地 ${nextWork.name} 模拟工具。`, { tool: nextWork.name, attempt: 1 });
          nextWork.done = true;
        }
        else{ //没有剩下未完成的nextWork，代表task完成了
          task.status = "done";
          emit("completed", "stage", `${agentLabels[task.role].name} 完成整个 ${task.id}`);
        }
      }
    }
    await store.saveRun(run);
  }
  return blocked("当前run超时。");
}