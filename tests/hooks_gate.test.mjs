/**
 * tool_call 钩子的完整判定链：hooks.json 静态规则 → approval 地板 / 缓存 / 模式 → 人工审批。
 *
 * 为什么单独测这条链：approval.js 的单测只覆盖「判定函数」，而真正决定一次工具调用
 * 能不能跑的是 hooks.js 里的异步扩展（它可以 await 人工裁决）。这条链的任何一处
 * fail-open 都会让「审批」变成摆设，所以这里用假 pi 对象驱动真实扩展。
 */
import { TEST_DATA_ROOT } from "./_helpers/env.mjs"; // 必须第一个导入：先固定数据根
import assert from "node:assert/strict";
import test from "node:test";

import { Store } from "../src/store.js";
import { createApproval } from "../src/approval.js";
import { createHooksExtension } from "../src/hooks.js";

const ROOM = "room-hooks-gate";
const BOT = "coder";

/** 用假 pi 驱动真实扩展：收集 handler，返回可直接调用的 toolCall。 */
function harness(opts = {}) {
  const handlers = new Map();
  const pi = { on: (name, fn) => handlers.set(name, fn) };
  createHooksExtension(opts.rules ?? [], opts)(pi);
  return {
    toolCall: (toolName, input, ctx = {}) => handlers.get("tool_call")({ toolName, input }, ctx),
  };}

function store() {
  return new Store(`${TEST_DATA_ROOT}/hooks-gate-${Math.random().toString(36).slice(2)}.db`);
}

const CTX = { roomId: ROOM, botId: BOT };

test("hooks 静态规则：deny 命中即阻断，allow 规则放行", async () => {
  const rules = [
    { id: "r1", event: "tool_call", match: "bash", action: "deny", reason: "禁跑命令" },
  ];
  const { toolCall } = harness({ rules });
  const blocked = await toolCall("bash", { command: "ls" });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /禁跑命令/);

  const read = await toolCall("read", { path: "D:/x" });
  assert.equal(read, undefined, "未命中规则的调用放行");
});

test("hooks 内置 C 盘守卫：write 到 C: 一律阻断，D: 放行", async () => {
  const { toolCall } = harness({ rules: [] });
  const blocked = await toolCall("write", { path: "C:/Users/x/a.md" });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /C 盘/);

  const allowed = await toolCall("write", { path: "D:/ws/a.md" });
  assert.equal(allowed, undefined);
});

test("hooks 坏正则必须 fail-closed，而不是让规则静默消失", async () => {
  const rules = [
    { id: "bad", event: "tool_call", match: "bash", arg: "command", denyPattern: "([", action: "deny" },
  ];
  const { toolCall } = harness({ rules });
  const result = await toolCall("bash", { command: "echo hi" });
  assert.equal(result.block, true, "非法 denyPattern 不能让整条 deny 规则失效");
  assert.match(result.reason, /fail-closed/);
});

test("approval 地板：C 盘写入在 yolo 下也阻断（静态层与审批层双保险）", async () => {
  const s = store();
  const approval = createApproval({ store: s });
  approval.setMode("yolo");
  const { toolCall } = harness({ rules: [], approval });
  const result = await toolCall("write", { path: "C:/evil.txt" }, CTX);
  assert.equal(result.block, true);
  assert.match(result.reason, /地板|C 盘/);
  s.close();
});

test("approval ask：人工批准后放行，拒绝后阻断", async () => {
  const s = store();
  const approval = createApproval({ store: s });
  approval.setMode("ask");
  const requested = [];
  const { toolCall } = harness({
    rules: [],
    approval,
    onApprovalRequested: (req) => requested.push(req.id),
  });

  const pending = toolCall("bash", { command: "echo hello" }, CTX);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requested.length, 1, "ask 模式要挂一张审批单");
  approval.resolve(requested[0], { decision: "allow", scope: "session", by: "owner" });
  assert.equal(await pending, undefined, "批准后工具调用继续");

  // session 授权后同类调用不应再挂单（缓存命中直接放行）
  const again = await toolCall("bash", { command: "echo hello" }, CTX);
  assert.equal(again, undefined);
  assert.equal(requested.length, 1);

  s.close();
});

test("approval ask：超时按拒绝处理，明确告诉模型原因", async () => {
  const s = store();
  const approval = createApproval({ store: s });
  approval.setMode("ask");
  const { toolCall } = harness({ rules: [], approval, approvalTimeoutMs: 60 });
  const result = await toolCall("bash", { command: "echo never" }, CTX);
  assert.equal(result.block, true);
  assert.match(result.reason, /超时/);
  s.close();
});

test("approval ask：abort 立即撤回等待，不占用回合", async () => {
  const s = store();
  const approval = createApproval({ store: s });
  approval.setMode("ask");
  const { toolCall } = harness({ rules: [], approval, approvalTimeoutMs: 60_000 });
  const controller = new AbortController();
  const pending = toolCall("bash", { command: "echo abort" }, { ...CTX, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const result = await pending;
  assert.equal(result.block, true);
  assert.match(result.reason, /中止/);
  s.close();
});

test("没有 approval 实例时退回纯静态策略（零行为变化）", async () => {
  const { toolCall } = harness({ rules: [] });
  const result = await toolCall("bash", { command: "node --test" }, CTX);
  assert.equal(result, undefined, "未注入审批层时不应阻断普通命令");
});
