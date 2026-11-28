import assert from "node:assert/strict";
import test from "node:test";
import { stepRun, startRun } from "../src/core/multiAgents.ts";
import { MemoryRunStore } from "../src/core/runtime/store.ts";
import {
  composeTasks, eventsSince, INSTRUCTION, newRun, noop, REFERENCE_TEXT, snapshot,
} from "./runtime-support.ts";

test("retriever 先跑；composer 在依賴完成前不啟動", async () => {
  const { run } = await newRun();
  await stepRun(run, noop);

  const tools = run.events.filter((e) => e.kind === "tool");
  assert.ok(tools.length > 0, "第一輪應有工具事件");
  assert.ok(tools.every((e) => e.message.includes("task_1")), "第一輪只應有 retriever");
  assert.ok(composeTasks(run).every((t) => t.status === "pending"));
});

test("所有 composer 在同一輪同時啟動（併發）", async () => {
  const { run } = await newRun();
  const composers = composeTasks(run);

  while (run.tasks.find((t) => t.id === "task_1")!.status !== "done") {
    assert.ok(await stepRun(run, noop), "retriever 完成前不應停下");
  }

  const mark = run.events.length;
  await stepRun(run, noop);
  const starts = eventsSince(run, mark).filter((e) => e.message.includes("开始"));

  assert.equal(starts.length, composers.length, "同輪應同時啟動所有 composer");
  assert.ok(composers.every((t) => t.status === "running"));
});

test("retriever 的產物帶來源，內容交接給 composer", async () => {
  const { run } = await newRun();
  await stepUntilApprovalForTest(run);

  const reference = run.tasks[0].outputRefs.find((a) => a.artifactId === "art-task_1-reference");
  assert.ok(reference, "retriever 應產出 reference artifact");
  assert.match(reference.content, new RegExp(REFERENCE_TEXT));
  assert.ok(reference.derivedFrom.length > 0, "產物必須交代來源");

  // 交接的證據：審批提案的內容含上游的參考描述
  assert.equal(run.pendingActions.length, composeTasks(run).length);
  assert.ok(
    run.pendingActions.every((a) => a.payload.textContent.includes(REFERENCE_TEXT)),
    "每個提案都應帶上游的參考描述",
  );
});

test("缺少「创意简报」節點時阻塞，並說明原因", async () => {
  const store = new MemoryRunStore();
  const run = await startRun(
    {
      runId: 1,
      instruction: INSTRUCTION,
      snapshot: snapshot([{ id: "x", title: "其他", nodeType: "text", text: "a" }]),
    },
    store,
  );
  while (await stepRun(run, noop)) { /* 跑到停 */ }

  assert.equal(run.status, "blocked");
  assert.match(run.tasks[0].error ?? "", /创意简报/);
  assert.match(run.events.at(-1)!.message, /创意简报/);
});

test("缺少相連的参考節點時阻塞，並說明原因", async () => {
  const store = new MemoryRunStore();
  const run = await startRun(
    {
      runId: 1,
      instruction: INSTRUCTION,
      snapshot: snapshot([{ id: "brief", title: "创意简报", nodeType: "text", text: "a" }]),
    },
    store,
  );
  while (await stepRun(run, noop)) { /* 跑到停 */ }

  assert.equal(run.status, "blocked");
  assert.match(run.tasks[0].error ?? "", /参考节点/);
});

test("終態的 run 再呼叫 stepRun 不會改變狀態（幂等）", async () => {
  const { run } = await newRun();
  run.status = "blocked";
  assert.equal(await stepRun(run, noop), false);
  assert.equal(run.status, "blocked");
});

// 這個檔內部用的小工具，避免與 support 的名稱衝突
async function stepUntilApprovalForTest(run: Awaited<ReturnType<typeof newRun>>["run"]) {
  for (let i = 0; i < 40; i++) {
    await stepRun(run, noop);
    if (run.pendingActions.length > 0 || run.status !== "running") return;
  }
}