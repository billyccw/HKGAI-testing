import { parseSnapshot } from "./canvas.ts";
import { plannerAgent } from "./agents.ts"
import { LocalRunStore } from "./runtime/store.ts";
import { type RunRecord } from "./runtime/types.ts";

export type AgentPhase = "received" | "planning" | "tooling" | "validating" | "completed" | "blocked";
export type AgentEvent = {
  id: string;
  runId: string;
  phase: AgentPhase;
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
  // 初始化runtime:index 和runtime:run:<runId>
  const store = new LocalRunStore();
  await store.createRun({ runId: request.runId, requirementVersion: 0, requirements: [], tasks: [], events: [], status: "running"});

  const events: AgentEvent[] = [];
  const emit = (phase: AgentPhase, kind: AgentEvent["kind"], message: string, metadata?: AgentEvent["metadata"]) => {
    events.push({
      id: `${request.runId}:${events.length + 1}`,
      runId: store.runKey(request.runId),
      phase,
      kind,
      message,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, events.length)).toISOString(),
      ...(metadata ? { metadata } : {}),
    });
  };
  const blocked = async (message: string): Promise<RunRecord> => {
    emit("blocked", "error", message);
    const run: RunRecord = { runId: request.runId, requirementVersion: 1, requirements: [], tasks: [], events: events, status: "blocked" };
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
  emit("planning", "stage", "呼叫planner进行分工", { nodeCount: snapshot.nodes.length });
  // 实作开始
  const result = await plannerAgent(instruction);
  if (!result["ok"]){
    return blocked("拆分任务失败，未执行工具。");
  }
  const tasks = result["tasks"]
  // 后续未处理
  if (request.simulateFailure) return blocked("模拟工具失败；起步包不自动重试。");

  for (const task of tasks) {
    emit("planning", "stage", `${task.role} 接受 ${task.id}`, { taskId: task.id } as never);
  }

  const output = `任务：${instruction}\n画布：${snapshot.projectName}\n节点：${snapshot.nodes.map((node) => node.data.title).join("、")}\n连接：${snapshot.edges.length} 条\n结果：已完成本地结构摘要，未调用模型或生成媒体。`;
  emit("validating", "validation", "摘要已生成，未修改画布或执行外部副作用。");
  emit("completed", "stage", "模拟运行完成。");
  const run: RunRecord = { runId: request.runId, requirementVersion: 1, requirements: [], tasks: result["tasks"], events: events, status: "completed", output: output};
  await store.saveRun(run);
  return run;
}