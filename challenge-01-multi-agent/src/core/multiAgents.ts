import { parseSnapshot } from "./canvas.ts";
import { plannerAgent, referenceRetrievingAgent, nodeAddingAgent, type Task, type Artifact, type Tool, type PendingAction } from "./agents.ts";
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

/** 角色 → agent 實例。實例必須完全無狀態，因為它是 module 層單例、跨 run 共用。 */
const AGENTS: Record<Task["role"], plannerAgent | referenceRetrievingAgent | nodeAddingAgent> = {
  retriever: new referenceRetrievingAgent(),
  composer: new nodeAddingAgent(),
  critic: new plannerAgent(),
};

const planner = new plannerAgent();

// emit 直接寫進 run.events，不再需要另一個 events 陣列
export function appendEvent(
  run: RunRecord,
  phase: EventPhase,
  kind: AgentEvent["kind"],
  message: string,
  metadata?: AgentEvent["metadata"],
): void {
  run.events.push({
    id: `${run.runId}:${run.events.length + 1}`,
    runId: String(run.runId),
    phase,
    kind,
    message,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, run.events.length)).toISOString(),
    ...(metadata ? { metadata } : {}),
  });
}

function makeEmit(run: RunRecord) {
  return (phase: EventPhase, kind: AgentEvent["kind"], message: string,
          metadata?: AgentEvent["metadata"]) => appendEvent(run, phase, kind, message, metadata);
}

/**
 * 依 dependsOn 收集上游產物。
 * 這是唯一的輸入來源——沒有 inputRefs，也沒有跨 task 寫入。
 */
function resolveInputs(run: RunRecord, task: Task): Artifact[] {
  const byId = new Map(run.tasks.map((t) => [t.id, t]));
  return task.dependsOn.flatMap((id) => byId.get(id)?.outputRefs ?? []);
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
    baseSnapshot: { nodes: [], edges: [] },   // 驗證通過後才填入
    tasks: [],
    events: [],
    pendingActions: [],                                           
    approvals: [],                                              
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
  run.baseSnapshot = { nodes: snapshot.nodes, edges: snapshot.edges };   // 驗證通過後填入

  emit("planning", "stage", "呼叫规划Agent进行分工", { nodeCount: snapshot.nodes.length });

  const result = await planner.plan(instruction);
  if (!result.ok) return fail(result.message);

  run.tasks = result.tasks;
  for (const task of run.tasks) {
    task.workflow = AGENTS[task.role].createWorkflow();
    emit("planning", "stage", `${AGENTS[task.role].name} 接受 ${task.id}`, { taskId: task.id });
  }

  if (request.simulateFailure) return fail("模拟工具失败；起步包不自动重试。");

  await store.saveRun(run);
  return run;
}

/** 推進一輪；耗時由呼叫的tool注入的 sleep 決定 */
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Plan = {
  task: Task; toolName: string; tool: Tool; inputs: Artifact[];
  snapshot: RunRecord["baseSnapshot"];
  slot: number | null;
};

export async function stepRun(run: RunRecord, deps: StepDeps = {}): Promise<boolean> {
  if (run.status !== "running") return false;

  //有提案需要审批，暂停
  if (run.pendingActions.length > 0) {
    run.status = "awaiting_approval";
    return false;
  }

  const maxConcurrency = deps.maxConcurrency ?? 3;
  const sleep = deps.sleep ?? realSleep; // 可选注入，testing时注入deps即可跳过睡眠
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
      const why = stuck.status === "cancelled" ? "被用户拒绝" : `状态 == ${stuck.status}`;
      emit("blocked", "error", `无法继续：${stuck.id} ${why}` + (stuck.error ? `（${stuck.error}）` : ""), { taskId: stuck.id });
    } else {
      run.status = "completed";
      run.output = `任务：${instructionOf(run)}\n结果：所有任务已完成，未调用模型或生成媒体。`;
      emit("validating", "validation", "摘要已生成，未修改画布或执行外部副作用。");
      emit("completed", "stage", "模拟运行完成。");
    }
    return false;
  }

  // 4) 排好這一輪各要做哪個工具（同步、順序固定）
  const plans: Plan[] = [];
  const composerSlots = new Map(
      run.tasks.filter((t) => t.role === "composer")
              .map((t, i) => [t.id, i + 1] as const),
  );
  for (const task of active) {
    const wasReady = task.status === "ready";
    task.status = "running";
    const next = task.workflow?.find((s) => !s.done);
    if (!next) {
      task.status = "done";
      emit("completed", "stage", `${AGENTS[task.role].name} 完成整个 ${task.id}`);
      continue;
    }

    // 角色級白名單：呼叫自己沒有的工具 → 直接失敗
    const tool = AGENTS[task.role].tools[next.name];
    if (!tool) {
      task.status = "failed";
      task.error = `请求了未授权的工具 ${next.name}`;
      emit("blocked", "error", `${task.id} 请求了 ${AGENTS[task.role].name} 未授权的工具 ${next.name}`);
      continue;
    }

    // 安排task前拿好dependsOn的task的所有输出
    const inputs = resolveInputs(run, task);
    if ( wasReady && inputs.length > 0 ) {
      emit("planning", "stage",
        `${task.id} 接收 ${inputs.length} 份上游资料（${inputs.map((a) => a.artifactId).join("、")}）`,
        { taskId: task.id });
    }

    plans.push({
      task, toolName: next.name, tool, inputs,
      snapshot: run.baseSnapshot,
      slot: composerSlots.get(task.id) ?? null,
    });
    emit("tooling", "tool",
      `${AGENTS[task.role].name} ${task.id} 开始 ${next.name}`,
      { tool: next.name, attempt: 1 });
  }

  // 5) 真的呼叫工具（並行重疊）,工具里面的sleep会真实耗时
  deps.onProgress?.(run);
  const results = await Promise.all(
    plans.map(async (plan) => {
      try {
        const result = await plan.tool({ task: plan.task, inputs: plan.inputs, snapshot: plan.snapshot, slot: plan.slot, sleep });
        return { plan, ok: true as const, result };
      } catch (e) {
        return { plan, ok: false as const, message: String(e) };
      }
    }),
  );


  // 6) 依 active 順序寫回（results 的順序 = plans 的順序，可重現）
  for (const it of results) {
    const { task, toolName, inputs } = it.plan;
    const agentName = AGENTS[task.role].name;

    if (!it.ok) {
      task.status = "failed";
      task.attempts += 1;
      task.error = it.message;
      emit("blocked", "error", `${task.id} 的 ${toolName} 失败：${it.message}`);
      continue;
    }

    // 產物不得引用沒吃到的上游（防止工具憑空捏造來源）
    const allowed = new Set(inputs.map((a) => a.artifactId));
    const forged = (it.result.outputs ?? []) // 从执行结果中找出"来源不明/未授权"的 artifact（产物）引用
      .flatMap((o) => o.derivedFrom ?? [])
      .find((r) => r.type === "artifact" && !allowed.has(r.artifactId));
    if (forged) {
      task.status = "failed";
      task.attempts += 1;
      task.error = "产出了引用不存在的上游资料";
      emit("blocked", "error", `${task.id} 的 ${toolName} 产出了引用不存在的上游资料`);
      continue;
    }

    // 冪等寫回：id 確定性，重跑同一輪只是覆寫同一筆
    for (const out of it.result.outputs ?? []) {
      const artifact: Artifact = {
        artifactId: `art-${task.id}-${out.key}`,
        producedBy: task.id,
        requirementVersion: task.requirementVersion,
        content: out.content,
        derivedFrom: out.derivedFrom ?? [],
      };
      const i = task.outputRefs.findIndex((a) => a.artifactId === artifact.artifactId);
      if (i >= 0) task.outputRefs[i] = artifact;
      else task.outputRefs.push(artifact);

      emit("tooling", "tool", `${agentName} ${task.id} 产出 ${artifact.artifactId}`,
        { tool: toolName, attempt: 1 });
    }

    // 提案：只登記，不執行；這一步先不標 done，等批准
    if (it.result.proposes) {
      const action = it.result.proposes;
      const alreadyDecided = run.approvals.some((a) => a.actionId === action.actionId);

      if (alreadyDecided) {                       // ← 新增：重放時冪等地收尾
        const step = task.workflow?.find((s) => !s.done);
        if (step) step.done = true;
        task.status = "running";
        continue;
      }

      const alreadyPending = run.pendingActions.some((a) => a.actionId === action.actionId);
      if (!alreadyPending){
        run.pendingActions.push(action);
        emit("validating", "validation",
          `等待审批：新建「${action.payload.title}」（模拟，不会修改画布）`,
          { taskId: task.id });
      }
      task.status = "awaiting_approval";
      continue;                     // 不標 step.done、不標 task.done
    }

    const step = task.workflow?.find((s) => s.name === toolName && !s.done);
    if (step) step.done = true;

    // 以前這裡漏掉了 summary，導致「做了什麼」看不出來
    emit("tooling", "tool", `${agentName} ${task.id} 完成 ${toolName}：${it.result.summary}`,
      { tool: toolName, attempt: 1 });
  }

  // 7) 這輪跑完最後一步的 task 直接算完成
  for (const task of active) {
    if (task.status === "running" && !task.workflow?.some((s) => !s.done)) {
      task.status = "done";
      emit("completed", "stage", `${AGENTS[task.role].name} 完成整个 ${task.id}`);
    }
  }

  if (run.pendingActions.length > 0) {
    run.status = "awaiting_approval";
    return false;
  }

  return true;
}

/**
 * 輸入 run、actionId、決策，就地修改 run 产出副作用並回傳。
 * 注意：副作用是「模擬」的——只寫 approvals 與事件，不修改任何畫布資料。
 */
export function decideAction(
  run: RunRecord,
  actionId: string,
  decision: "approved" | "rejected",
): RunRecord {
  const index = run.pendingActions.findIndex((a) => a.actionId === actionId);
  if (index < 0) return run;

  const action = run.pendingActions[index];
  const task = run.tasks.find((t) => t.id === action.taskId);
  const emit = makeEmit(run);

  // 先檢查過期：需求版本不符就直接作廢，不記錄任何決策
  if (action.requirementVersion !== run.requirementVersion) {
    run.pendingActions.splice(index, 1);
    if (task) task.status = "stale";
    emit("blocked", "error",
      `审批已过期（需求版本 ${action.requirementVersion} ≠ ${run.requirementVersion}），已作废 ${action.taskId}`,
      { taskId: action.taskId });
    if (run.pendingActions.length === 0) run.status = "running";
    return run;
  }

  // 正常決策：先出列，再記錄（冪等：同 actionId 只記一次）
  run.pendingActions.splice(index, 1);
  if (!run.approvals.some((a) => a.actionId === actionId)) {
    run.approvals.push({
      actionId,
      requirementVersion: action.requirementVersion,
      decision,
      decidedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, run.approvals.length)).toISOString(),
    });
  }

  if (decision === "approved") {
    if (task) {
      // 把提出提案的那一步標成完成，讓下一輪能收尾
      const step = task.workflow?.find((s) => !s.done);
      if (step) step.done = true;
      task.status = "running";
    }
    emit("validating", "validation",
      `已应用模拟变更：新建「${action.payload.title}」（未修改画布）`,
      { taskId: action.taskId });
  } else {
    if (task) task.status = "cancelled";
    emit("blocked", "error",
      `用户拒绝模拟变更「${action.payload.title}」，已取消 ${action.taskId}`,
      { taskId: action.taskId });
  }

  if (run.pendingActions.length === 0) run.status = "running";
  return run;
}

function instructionOf(run: RunRecord): string {
  return run.requirements.at(-1)?.text ?? "";
}
