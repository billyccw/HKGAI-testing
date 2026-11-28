import { MemoryRunStore } from "../src/core/runtime/store.ts";
import { startRun, stepRun, decideAction } from "../src/core/multiAgents.ts";
import { type RunRecord } from "../src/core/runtime/types.ts";

/** 測試用：跳過所有工具sleep*/
export const noop = { sleep: async () => {} };

type NodeSpec = {
  id: string;
  title: string;
  nodeType: "text" | "reference";
  text: string;
};

export function snapshot(nodes: NodeSpec[], edges: [string, string][] = []) {
  return {
    version: 1,
    projectName: "runtime-test",
    nodes: nodes.map((n) => ({
      id: n.id,
      type: "creative" as const,
      position: { x: 0, y: 0 },
      data: { nodeType: n.nodeType, title: n.title, status: "idle", textContent: n.text },
    })),
    edges: edges.map(([source, target], i) => ({ id: `e${i + 1}`, source, target })),
  };
}

/** 標準畫布：创意简报 -- reference */
export const briefWithReference = () =>
  snapshot(
    [
      { id: "brief", title: "创意简报", nodeType: "text", text: "安静的摄影棚" },
      { id: "ref", title: "场景参考", nodeType: "reference", text: "白模构图参考" },
    ],
    [["brief", "ref"]],
  );

export const INSTRUCTION = "将创意简报拆开成三个机位";
export const REFERENCE_TEXT = "白模构图参考";

/** 只取 composer 任務：加第三個角色時這個 helper 不會被影響 */
export const composeTasks = (run: RunRecord) =>
  run.tasks.filter((t) => t.role === "composer");

export const eventsSince = (run: RunRecord, mark: number) => run.events.slice(mark);

export async function newRun(instruction = INSTRUCTION) {
  const store = new MemoryRunStore();
  const run = await startRun(
    { runId: 1, instruction, snapshot: briefWithReference() },
    store,
  );
  return { store, run };
}

/** 一直推進到停下來 */
export async function stepUntilStop(run: RunRecord, max = 40): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (!(await stepRun(run, noop))) return;
  }
}

/** 跑到出現待審批提案（或 run 結束） */
export async function stepUntilApproval(run: RunRecord, max = 40): Promise<void> {
  for (let i = 0; i < max; i++) {
    await stepRun(run, noop);
    if (run.pendingActions.length > 0 || run.status !== "running") return;
  }
}

/** 一路推進到結束，看到提案就依 decision 處理 */
export async function driveToEnd(
  run: RunRecord,
  decision: "approved" | "rejected" = "approved",
  max = 120,
): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (run.pendingActions.length > 0) {
      for (const action of [...run.pendingActions]) {
        decideAction(run, action.actionId, decision);
      }
      continue;
    }
    if (!(await stepRun(run, noop)) && run.pendingActions.length === 0) return;
  }
}