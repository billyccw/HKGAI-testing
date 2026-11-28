import assert from "node:assert/strict";
import test from "node:test";
import { decideAction } from "../src/core/multiAgents.ts";
import { composeTasks, driveToEnd, newRun, stepUntilApproval } from "./runtime-support.ts";

test("每個 composer 各提一筆待審批，run 停在 awaiting_approval", async () => {
  const { run } = await newRun();
  await stepUntilApproval(run);

  const awaiting = composeTasks(run).filter((t) => t.status === "awaiting_approval");
  assert.equal(run.status, "awaiting_approval");
  assert.ok(awaiting.length > 0);
  assert.equal(run.pendingActions.length, awaiting.length);
  assert.equal(new Set(run.pendingActions.map((a) => a.taskId)).size, awaiting.length);
  assert.ok(run.pendingActions.every((a) => a.payload.title.startsWith("机位 ")));
  assert.ok(run.pendingActions.every((a) => a.payload.connectFrom === "brief"));
});

test("全部核准後 run 完成，所有任務 done，且明確標示未修改畫布", async () => {
  const { run } = await newRun();
  await driveToEnd(run, "approved");

  assert.equal(run.status, "completed");
  assert.ok(run.tasks.every((t) => t.status === "done"));
  assert.equal(
    run.approvals.filter((a) => a.decision === "approved").length,
    composeTasks(run).length,
  );
  assert.ok(run.events.some((e) => e.message.includes("未修改画布")));
});

test("拒絕一筆只取消該任務，run 最終阻塞", async () => {
  const { run } = await newRun();
  await stepUntilApproval(run);

  const [first, ...rest] = run.pendingActions;
  decideAction(run, first.actionId, "rejected");
  for (const action of rest) decideAction(run, action.actionId, "approved");
  await driveToEnd(run, "approved");

  assert.equal(run.tasks.find((t) => t.id === first.taskId)!.status, "cancelled");
  assert.equal(run.status, "blocked");
  assert.equal(run.approvals.filter((a) => a.decision === "rejected").length, 1);
});

test("重複決定同一筆 action 不會產生第二筆紀錄", async () => {
  const { run } = await newRun();
  await stepUntilApproval(run);

  const action = run.pendingActions[0];
  decideAction(run, action.actionId, "approved");
  decideAction(run, action.actionId, "approved");

  assert.equal(run.approvals.length, 1);
});

test("需求版本不符的審批直接作廢，且不留紀錄", async () => {
  const { run } = await newRun();
  await stepUntilApproval(run);

  run.requirementVersion += 1;
  const action = run.pendingActions[0];
  const pendingBefore = run.pendingActions.length;
  decideAction(run, action.actionId, "approved");

  assert.equal(run.approvals.length, 0, "過期審批不得被記錄");
  assert.equal(run.pendingActions.length, pendingBefore - 1, "只得移除這一筆");
  assert.equal(run.tasks.find((t) => t.id === action.taskId)!.status, "stale");
  assert.match(run.events.at(-1)!.message, /过期/);
});