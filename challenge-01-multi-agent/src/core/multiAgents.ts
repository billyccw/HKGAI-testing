import { parseSnapshot } from "./canvas.ts";
import { plannerAgent, referenceRetrievingAgent, nodeAddingAgent, type Task, TOOLS, type Tool } from "./agents.ts";
import { type RunStore } from "./runtime/store.ts";
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

export type StepDeps = {
  maxConcurrency?: number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (run: RunRecord) => void;
};

const ROLE_META: Record<Task["role"], {
  name: string;
  workflow: () => { name: string; done: boolean }[];
}> = {
  retriever: { name: "检索Agent", workflow: () => new referenceRetrievingAgent().createWorkflow() },
  composer:  { name: "组成Agent", workflow: () => new nodeAddingAgent().createWorkflow() },
  critic:    { name: "分工Agent", workflow: () => new plannerAgent().createWorkflow() },
};

const planner = new plannerAgent();

// emit 直接寫進 run.events，不再需要另一個 events 陣列
function makeEmit(run: RunRecord) {
  return (phase: EventPhase, kind: AgentEvent["kind"], message: string,
          metadata?: AgentEvent["metadata"]) => {
    run.events.push({
      id: `${run.runId}:${run.events.length + 1}`,
      runId: String(run.runId),
      phase,
      kind,
      message,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, run.events.length)).toISOString(),
      ...(metadata ? { metadata } : {}),
    });
  };
}

/** 驗證 + 規劃 + 分配工作流，存檔後返回。不執行任何 task。 */
export async function startRun(
  request: MockMultiAgentRequest,
  store: RunStore,
): Promise<RunRecord> {
  const instruction = request.instruction.trim();
  const run: RunRecord = {
    runId: request.runId,
    requirementVersion: 1,
    requirements: [{ version: 1, text: instruction, createdAt: "2026-01-01T00:00:00.000Z" }],
    tasks: [],
    events: [],
    status: "running",
  };
  const emit = makeEmit(run);
  const fail = async (message: string): Promise<RunRecord> => {
    run.status = "blocked";
    emit("blocked", "error", message);
    await store.saveRun(run);
    return run;
  };

  emit("received", "stage", "已接收任务；当前为Multi Agent 确定性模拟。");
  if (!instruction || instruction.length > 2000) return fail("指令须为 1 至 2000 个字符。");

  let snapshot;
  try { snapshot = parseSnapshot(request.snapshot); }
  catch { return fail("画布快照校验失败，未执行工具。"); }
  if (!snapshot.nodes.length) return fail("请先添加至少一个节点。");

  emit("planning", "stage", "呼叫规划Agent进行分工", { nodeCount: snapshot.nodes.length });

  const result = await planner.plan(instruction);
  if (!result.ok) return fail(result.message);

  run.tasks = result.tasks;
  for (const task of run.tasks) {
    task.workflow = ROLE_META[task.role].workflow(); 
    emit("planning", "stage", `${ROLE_META[task.role].name} 接受 ${task.id}`, { taskId: task.id });
  }

  if (request.simulateFailure) return fail("模拟工具失败；起步包不自动重试。");

  await store.saveRun(run);
  return run;
}

/** 推進一輪；耗時由呼叫的tool注入的 sleep 決定 */
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Plan = { task: Task; toolName: string };

export async function stepRun(run: RunRecord, deps: StepDeps = {}): Promise<boolean> {
  const maxConcurrency = deps.maxConcurrency ?? 3;
  const sleep = deps.sleep ?? realSleep;
  const emit = makeEmit(run);

  // 1) 用回合開始的快照判定 ready
  const snap = new Map(run.tasks.map((t) => [t.id, t.status]));
  for (const t of run.tasks) {
    if (t.status === "pending" && t.dependsOn.every((id) => snap.get(id) === "done")) {
      t.status = "ready";
      emit("planning", "stage", `${t.id} 准备就绪`, { taskId: t.id });
    }
  }

  // 2) 挑出這一輪要推進的task（併發上限）
  const active = run.tasks
    .filter((t) => t.status === "ready" || t.status === "running")
    .slice(0, maxConcurrency);

  // 3) 所有任务都没有办法再推进，判断结果并返还
  if (active.length === 0) {
    const stuck = run.tasks.find((t) => t.status !== "done");
    if (stuck) {
      run.status = "blocked";
      emit("blocked", "error", `再无可以推进的task，阻塞原因：${stuck.id} 状态 == ${stuck.status}`);
    } else {
      run.status = "completed";
      run.output = `任务：${instructionOf(run)}\n结果：所有任务已完成，未调用模型或生成媒体。`;
      emit("validating", "validation", "摘要已生成，未修改画布或执行外部副作用。");
      emit("completed", "stage", "模拟运行完成。");
    }
    return false;
  }

  // 4) 各task推進一步前先把「這一輪各要做哪個工具」排好（同步、順序固定）
  const plans: Plan[] = [];
  for (const task of active) {
    task.status = "running";
    const next = task.workflow?.find((s) => !s.done);
    if (!next) { task.status = "done"; emit("completed", "stage", `${ROLE_META[task.role].name} 完成整个 ${task.id}`); continue; }
    if (!(next.name in TOOLS)) {
      task.status = "failed";
      emit("blocked", "error", `${task.id} 请求了未授权的工具 ${next.name}`);
      continue;
    }
    plans.push({ task, toolName: next.name });
    emit("tooling", "tool", `${ROLE_META[task.role].name} ${task.id} 开始 ${next.name}`, { tool: next.name, attempt: 1 });
  }

  // 5) 真的呼叫工具（並行重疊）,工具里面的sleep会真实耗时
  deps.onProgress?.(run); 
  const results = await Promise.all(
    plans.map(async (plan) => {
      const tool = TOOLS[plan.toolName];
      try {       
        const result = await tool({ task: plan.task, sleep: sleep });
        return { plan, ok: true as const, result };
      } catch (e) {
        return { plan, ok: false as const, message: String(e) };
      }
    }),
  );

  // 6) 依 active 順序寫回（results 的順序 = plans 的順序，可重現）
  for (const it of results) {
    const { task, toolName } = it.plan;
    if (!it.ok) {
      task.status = "failed";
      task.attempts += 1;
      emit("blocked", "error", `${task.id} 的 ${toolName} 失败：${it.message}`);
      continue;
    }
    const step = task.workflow?.find((s) => s.name === toolName && !s.done);
    if (step) step.done = true;
    emit("tooling", "tool", `${ROLE_META[task.role].name} ${task.id} 完成 ${toolName}`, { tool: toolName, attempt: 1 });
  }
  deps.onProgress?.(run);

  // 7) 這輪跑完最後一步的 task 直接算完成
  for (const task of active) {
    if (task.status === "running" && !task.workflow?.some((s) => !s.done)) {
      task.status = "done";
      emit("completed", "stage", `${ROLE_META[task.role].name} 完成整个 ${task.id}`);
    }
  }

  return true;
}

function instructionOf(run: RunRecord): string {
  return run.requirements.at(-1)?.text ?? "";
}
