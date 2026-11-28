import { appendEvent } from "../multiAgents.ts";
import { type Task } from "../agents.ts";
import { type RunRecord } from "./types.ts";

/** 中斷的定義：storage 裡還是 running，但当下的page没有在run */
export function isInterrupted(run: RunRecord | null): run is RunRecord {
  return run !== null && run.status === "running";
}

/** 未完成、需要被取消的任務狀態（failed 保留原樣，它本身已是結果） */
const UNFINISHED: ReadonlySet<Task["status"]> = new Set([
  "pending", "ready", "running", "awaiting_approval",
]);

/**
 * 把尚未完成的任務全部取消，run 標記為 cancelled，並留下一則原因事件。
 * 用於兩種情境：使用者放棄恢復、使用者主動中止。
 */
export function cancelRun(run: RunRecord, reason: string): RunRecord {
  const cancelled: string[] = [];
  for (const task of run.tasks) {
    if (UNFINISHED.has(task.status)) {
      task.status = "cancelled";
      cancelled.push(task.id);
    }
  }
  run.status = "cancelled";
  appendEvent(
    run,
    "blocked",
    "error",
    cancelled.length ? `${reason}，已取消 ${cancelled.join("、")}` : reason,
  );
  return run;
}