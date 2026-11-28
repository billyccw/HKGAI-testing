import assert from "node:assert/strict";
import test from "node:test";
import { replanRun, stepRun } from "../src/core/multiAgents.ts";
import { composeTasks, driveToEnd, newRun, noop } from "./runtime-support.ts";

test("改成四個機位：舊任務轉 stale，新任務掛新版本並補上 workflow", async () => {
  const { run } = await newRun();
  await stepRun(run, noop);
  run.status = "paused";

  const result = replanRun(run, "改变成四个机位");
  assert.ok(result.ok);
  assert.equal(run.requirementVersion, 2);

  const active = composeTasks(run).filter((t) => t.status !== "stale");
  assert.equal(active.length, 4);
  assert.ok(active.every((t) => t.requirementVersion === 2));
  assert.ok(active.every((t) => (t.workflow?.length ?? 0) > 0), "新任務必須有 workflow");
  assert.deepEqual(active.map((t) => t.slot), [1, 2, 3, 4]);
});

test("replan 後仍可正常審批並完成（版本對齊 regression）", async () => {
  const { run } = await newRun();
  await stepRun(run, noop);
  run.status = "paused";
  assert.ok(replanRun(run, "改变成四个机位").ok);

  await driveToEnd(run);

  assert.equal(run.status, "completed");
  assert.equal(
    run.approvals.filter((a) => a.decision === "approved").length,
    composeTasks(run).filter((t) => t.status === "done").length,
  );
  assert.equal(composeTasks(run).filter((t) => t.status === "done").length, 4);
});

test("要求少於已產出的數量時失敗，且不改動任何狀態", async () => {
  const { run } = await newRun();
  await stepRun(run, noop);
  composeTasks(run).slice(0, 2).forEach((t) => { t.status = "done"; });
  run.status = "paused";

  const before = {
    version: run.requirementVersion,
    tasks: run.tasks.map((t) => [t.id, t.status, t.requirementVersion]),
  };
  const result = replanRun(run, "改变成一个机位");

  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /无法撤销已有节点/);
  assert.deepEqual(
    { version: run.requirementVersion, tasks: run.tasks.map((t) => [t.id, t.status, t.requirementVersion]) },
    before,
    "失敗時不得改動 run",
  );
});

test("無法辨識的需求維持 paused 並回報可接受的句型", async () => {
  const { run } = await newRun();
  await stepRun(run, noop);
  run.status = "paused";

  const result = replanRun(run, "我想要更多机位");
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /未能识别新需求/);
  assert.equal(run.status, "paused");
});