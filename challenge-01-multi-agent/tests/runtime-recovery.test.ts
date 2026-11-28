import assert from "node:assert/strict";
import test from "node:test";
import { stepRun } from "../src/core/multiAgents.ts";
import { cancelRun, isInterrupted } from "../src/core/runtime/recovery.ts";
import { composeTasks, driveToEnd, newRun, noop } from "./runtime-support.ts";

test("中斷後從 storage 續跑，不產生重複產物", async () => {
  const { run, store } = await newRun();
  await stepRun(run, noop);
  await stepRun(run, noop);
  await store.saveRun(run);

  const reloaded = (await store.getRun(1))!;
  assert.ok(isInterrupted(reloaded), "storage 仍是 running → 判定為中斷");

  await driveToEnd(reloaded);

  assert.equal(reloaded.status, "completed");
  const ids = reloaded.tasks.flatMap((t) => t.outputRefs.map((a) => a.artifactId));
  assert.equal(new Set(ids).size, ids.length, "不得有重複的 artifactId");
  assert.equal(
    reloaded.approvals.filter((a) => a.decision === "approved").length,
    composeTasks(reloaded).length,
  );
});

test("放棄恢復：未完成任務全部取消，且不再被判定為中斷", async () => {
  const { run, store } = await newRun();
  await stepRun(run, noop);
  await store.saveRun(run);

  const reloaded = (await store.getRun(1))!;
  cancelRun(reloaded, "检测到执行中断；用户放弃恢复");
  await store.saveRun(reloaded);

  assert.equal(reloaded.status, "cancelled");
  assert.equal(isInterrupted(reloaded), false);
  assert.ok(reloaded.tasks.every((t) => t.status === "cancelled" || t.status === "done"));
  assert.match(reloaded.events.at(-1)!.message, /放弃恢复/);
});

test("已完成的 run 不會被誤判為中斷", async () => {
  const { run } = await newRun();
  await driveToEnd(run);
  assert.equal(isInterrupted(run), false);
});