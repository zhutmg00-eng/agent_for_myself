/**
 * 执行期 fanout 单测（node:test）。
 *
 * 契约：docs/hermes/CONTRACT.md §9.1 —— 状态机单向、失败向传递下游传播 skipped、
 * 兄弟分支不受影响、nextReady 只给依赖全 done 的单元、isComplete/summarize。
 *
 * 模块是纯函数（不碰 store/磁盘/网络），额外守住：确定性、不改入参、未知 id 容错。
 */
import { TEST_DATA_ROOT } from "./_helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNIT_STATES,
  createExecutionPlan,
  isComplete,
  markResult,
  markRunning,
  nextReady,
  summarize,
} from "../src/rooms/executor.js";

/** 造一个单元。 */
function unit(id, extra = {}) {
  return { id, bot_id: "coder", depends_on: [], ...extra };
}

/** 从单元数组建计划。 */
function planOf(units, order = []) {
  return createExecutionPlan({ units, order });
}

/** 把计划 JSON 化，方便断言「不改入参」。 */
const snapshot = (value) => JSON.stringify(value);

test("env: 测试数据根被隔离在 D:（模块本身不写盘，这条守住 import 顺序）", () => {
  assert.ok(TEST_DATA_ROOT);
  assert.ok(!/^c:/i.test(TEST_DATA_ROOT), `拒绝在 C: 上跑测试: ${TEST_DATA_ROOT}`);
});

test("UNIT_STATES 与契约逐字一致且冻结", () => {
  assert.deepEqual([...UNIT_STATES], ["pending", "ready", "running", "done", "failed", "skipped"]);
  assert.equal(Object.isFrozen(UNIT_STATES), true);
});

test("空计划：结构为空、nextReady 为空、isComplete 为真、summarize 全零", () => {
  const plan = createExecutionPlan();
  assert.deepEqual(plan, { order: [], units: {}, states: {}, skippedReason: {} });
  assert.deepEqual(nextReady(plan), []);
  assert.equal(isComplete(plan), true);
  assert.deepEqual(summarize(plan), { done: 0, failed: 0, skipped: 0, pending: 0, running: 0 });
  assert.deepEqual(markResult(plan, "ghost", { ok: true }), { plan, changed: [], skipped: [] });
});

test("布局：roots 初始 ready、其余 pending；order 缺省用声明序", () => {
  const plan = planOf([unit("a"), unit("b", { depends_on: ["a"] }), unit("c", { depends_on: ["b"] })]);
  assert.deepEqual(plan.order, ["a", "b", "c"]);
  assert.deepEqual(plan.states, { a: "ready", b: "pending", c: "pending" });
  assert.deepEqual(plan.units, {
    a: { id: "a", bot_id: "coder", depends_on: [] },
    b: { id: "b", bot_id: "coder", depends_on: ["a"] },
    c: { id: "c", bot_id: "coder", depends_on: ["b"] },
  });
  assert.deepEqual(plan.skippedReason, {});
  assert.deepEqual(summarize(plan), { done: 0, failed: 0, skipped: 0, pending: 3, running: 0 });
});

test("单链成功：nextReady → running → done 逐层推进，最后 isComplete", () => {
  let plan = planOf([unit("a"), unit("b", { depends_on: ["a"] }), unit("c", { depends_on: ["b"] })]);

  assert.deepEqual(nextReady(plan), ["a"]);
  plan = markRunning(plan, "a");
  assert.equal(plan.states.a, "running");
  assert.deepEqual(nextReady(plan), [], "running 不再出现在前沿里");

  const first = markResult(plan, "a", { ok: true });
  assert.deepEqual(first.changed, ["a"]);
  assert.deepEqual(first.skipped, []);
  plan = first.plan;
  assert.equal(plan.states.a, "done");
  assert.deepEqual(nextReady(plan), ["b"]);

  plan = markResult(markRunning(plan, "b"), "b", { ok: true }).plan;
  plan = markResult(markRunning(plan, "c"), "c", { ok: true }).plan;
  assert.deepEqual(summarize(plan), { done: 3, failed: 0, skipped: 0, pending: 0, running: 0 });
  assert.equal(isComplete(plan), true);
});

test("失败短路：直接下游 skipped、带 skippedReason，兄弟分支不受影响", () => {
  const plan = planOf([
    unit("a"),
    unit("b", { depends_on: ["a"] }),
    unit("c"),
    unit("d", { depends_on: ["c"] }),
  ]);
  const out = markResult(plan, "a", { ok: false, reason: "无文本产出" });
  assert.deepEqual(out.changed, ["a", "b"]);
  assert.deepEqual(out.skipped, ["b"]);
  assert.equal(out.plan.states.a, "failed");
  assert.equal(out.plan.states.b, "skipped");
  assert.equal(out.plan.skippedReason.b, "上游 a 失败（无文本产出）");
  // 兄弟分支 c（root）与 d（c 的下游）原样保留。
  assert.equal(out.plan.states.c, "ready");
  assert.equal(out.plan.states.d, "pending");
  assert.deepEqual(nextReady(out.plan), ["c"]);
  assert.equal(isComplete(out.plan), false, "还有 c/d 没跑，不能算完成");
});

test("失败短路：传递下游全部 skipped（A→B→C，A 失败则 B、C 都跳过）", () => {
  const plan = planOf([unit("a"), unit("b", { depends_on: ["a"] }), unit("c", { depends_on: ["b"] }), unit("d")]);
  const out = markResult(plan, "a", { ok: false });
  assert.deepEqual(out.skipped, ["b", "c"]);
  assert.deepEqual(out.changed, ["a", "b", "c"]);
  assert.equal(out.plan.skippedReason.b, "上游 a 失败");
  assert.equal(out.plan.skippedReason.c, "上游 a 失败", "传递下游记同一个根因");
  assert.equal(out.plan.states.d, "ready");
  assert.equal(isComplete(out.plan), false);
});

test("镜像依赖（A→B、C→B）：B 要等 A、C 都 done；单边完成不提前放行", () => {
  let plan = planOf([
    unit("a"),
    unit("b", { depends_on: ["a", "c"] }),
    unit("c"),
  ]);
  // 无依赖的 a、c 都是 root，一开始就能跑。
  assert.deepEqual(nextReady(plan), ["a", "c"]);

  plan = markResult(markRunning(plan, "a"), "a", { ok: true }).plan;
  assert.deepEqual(nextReady(plan), ["c"], "b 还等 c");
  plan = markResult(markRunning(plan, "c"), "c", { ok: true }).plan;
  assert.deepEqual(nextReady(plan), ["b"]);
  plan = markResult(markRunning(plan, "b"), "b", { ok: true }).plan;
  assert.equal(isComplete(plan), true);
});

test("菱形依赖（A→B、A→C、B+C→D）：分层推进，B 完成不会提前放行 D", () => {
  let plan = planOf([
    unit("a"),
    unit("b", { depends_on: ["a"] }),
    unit("c", { depends_on: ["a"] }),
    unit("d", { depends_on: ["b", "c"] }),
  ]);
  plan = markResult(markRunning(plan, "a"), "a", { ok: true }).plan;
  assert.deepEqual(nextReady(plan), ["b", "c"]);
  plan = markResult(markRunning(plan, "b"), "b", { ok: true }).plan;
  assert.deepEqual(nextReady(plan), ["c"], "d 还差 c");
  plan = markResult(markRunning(plan, "c"), "c", { ok: true }).plan;
  assert.deepEqual(nextReady(plan), ["d"]);
});

test("多 root：按 order 一起返回；跑掉一个后剩下的继续在前沿", () => {
  let plan = planOf([unit("a"), unit("b"), unit("c")], ["c", "a", "b"]);
  assert.deepEqual(nextReady(plan), ["c", "a", "b"], "按 order 而不是声明序");
  plan = markResult(markRunning(plan, "c"), "c", { ok: true }).plan;
  assert.deepEqual(nextReady(plan), ["a", "b"]);
});

test("幂等：重复 markRunning / markResult 不重复改状态、不重复 skip", () => {
  let plan = planOf([unit("a"), unit("b", { depends_on: ["a"] })]);
  const running = markRunning(plan, "a");
  assert.equal(markRunning(running, "a"), running, "已 running 时返回原 plan");
  const done = markResult(running, "a", { ok: true });
  assert.deepEqual(done.changed, ["a"]);
  const again = markResult(done.plan, "a", { ok: false });
  assert.deepEqual(again.changed, [], "终态不可覆盖");
  assert.deepEqual(again.skipped, []);
  assert.equal(again.plan.states.a, "done");

  const failed = markResult(plan, "a", { ok: false });
  const noop = markResult(failed.plan, "a", { ok: false, reason: "again" });
  assert.deepEqual(noop.changed, []);
  assert.equal(noop.plan.skippedReason.b, "上游 a 失败");
});

test("无文本失败：ok 缺省/非 true 一律按失败处理（fail closed），reason 可空", () => {
  const plan = planOf([unit("a"), unit("b", { depends_on: ["a"] })]);
  const implicit = markResult(plan, "a");
  assert.equal(implicit.plan.states.a, "failed", "没给 ok 不能当成功");
  assert.equal(implicit.plan.skippedReason.b, "上游 a 失败");

  const truthy = markResult(plan, "a", { ok: 1 });
  assert.equal(truthy.plan.states.a, "failed", "只有严格 true 才算成功");

  const withReason = markResult(plan, "a", { ok: false, reason: "成员本轮没有产出文本" });
  assert.equal(withReason.plan.skippedReason.b, "上游 a 失败（成员本轮没有产出文本）");
});

test("isComplete 边界：ready/running/pending 都算未完成，空计划算完成", () => {
  assert.equal(isComplete(createExecutionPlan()), true);
  const plan = planOf([unit("a"), unit("b", { depends_on: ["a"] })]);
  assert.equal(isComplete(plan), false, "roots ready");
  const running = markRunning(plan, "a");
  assert.equal(isComplete(running), false, "running");
  const done = markResult(running, "a", { ok: true }).plan;
  assert.equal(isComplete(done), false, "b 还 pending");
  assert.equal(isComplete(markResult(done, "b", { ok: true }).plan), true);
});

test("summarize：计数覆盖五种状态，ready 归入 pending", () => {
  let plan = planOf([
    unit("a"),
    unit("b", { depends_on: ["a"] }),
    unit("c", { depends_on: ["a"] }),
    unit("d", { depends_on: ["b"] }),
  ]);
  assert.deepEqual(summarize(plan), { done: 0, failed: 0, skipped: 0, pending: 4, running: 0 });
  plan = markRunning(plan, "a");
  assert.deepEqual(summarize(plan), { done: 0, failed: 0, skipped: 0, pending: 3, running: 1 });
  const failed = markResult(plan, "a", { ok: false });
  // a 失败 → 依赖链上的 b、d 与 c 全部被 skip；没有独立分支留下。
  assert.deepEqual(summarize(failed.plan), { done: 0, failed: 1, skipped: 3, pending: 0, running: 0 });
});

test("未知 id 容错：markRunning 原样返回、markResult 空改动、order 里的未知 id 被忽略", () => {
  const plan = planOf([unit("a")], ["zzz", "a", "zzz"]);
  assert.deepEqual(plan.order, ["a"], "未知 id 不进入执行顺序");
  assert.equal(markRunning(plan, "ghost"), plan);
  assert.equal(markRunning(plan, ""), plan);
  assert.deepEqual(markResult(plan, "ghost", { ok: true }), { plan, changed: [], skipped: [] });
  // 依赖了未知 id 的单元永远等不到（调用方应先用 planTasks 校验）。
  const dangling = planOf([unit("b", { depends_on: ["ghost"] })]);
  assert.deepEqual(nextReady(dangling), []);
  assert.equal(isComplete(dangling), false);
  assert.deepEqual(summarize(dangling), { done: 0, failed: 0, skipped: 0, pending: 1, running: 0 });
});

test("markRunning 守卫：依赖未满足的 pending 不许跑；依赖满足后 pending 可直接进入 running", () => {
  const plan = planOf([unit("a"), unit("b", { depends_on: ["a"] })]);
  assert.equal(markRunning(plan, "b"), plan, "依赖未满足时原样返回");
  const doneA = markResult(markRunning(plan, "a"), "a", { ok: true }).plan;
  assert.equal(doneA.states.b, "pending", "依赖完成后 b 仍是 pending（由 nextReady 视作可执行）");
  const runningB = markRunning(doneA, "b");
  assert.notEqual(runningB, doneA);
  assert.equal(runningB.states.b, "running");
});

test("units 支持 Record 形态；order 缺省/部分时按声明序补齐且去重", () => {
  const plan = createExecutionPlan({
    units: {
      a: { bot_id: "coder" },
      b: { bot_id: "writer", depends_on: ["a"] },
    },
  });
  assert.deepEqual(plan.order, ["a", "b"]);
  assert.deepEqual(plan.units.a, { id: "a", bot_id: "coder", depends_on: [] });
  assert.equal(plan.states.a, "ready");

  const partial = createExecutionPlan({
    units: [unit("a"), unit("b", { depends_on: ["a"] }), unit("c")],
    order: ["b"],
  });
  assert.deepEqual(partial.order, ["b", "a", "c"], "已知 id 按传入顺序，漏掉的按声明序补");
});

test("纯函数：确定性、不改入参、两次调用不共享可变结构", () => {
  const units = Object.freeze([
    Object.freeze({ id: "a", bot_id: "coder", depends_on: Object.freeze([]) }),
    Object.freeze({ id: "b", bot_id: "writer", depends_on: Object.freeze(["a"]) }),
  ]);
  const order = Object.freeze(["a", "b"]);
  const before = snapshot({ units, order });

  const first = createExecutionPlan({ units, order });
  const second = createExecutionPlan({ units, order });
  assert.deepEqual(first, second, "同输入必须同输出");
  assert.equal(snapshot({ units, order }), before, "不得修改入参");

  const planBefore = snapshot(first);
  const result = markResult(first, "a", { ok: false });
  assert.equal(snapshot(first), planBefore, "markResult 不得修改传入的 plan");
  assert.notEqual(result.plan.states.a, first.states.a, "返回的是新 plan");

  // 改返回值不影响原始 plan / 后续派生。
  result.plan.states.b = "done";
  result.plan.skippedReason.zzz = "x";
  assert.equal(first.states.b, "pending");
  assert.equal(Object.hasOwn(first.skippedReason, "zzz"), false);
  assert.deepEqual(markResult(first, "a", { ok: false }), markResult(first, "a", { ok: false }));
});

test("终态先到先得：已完成的不回退，已 skipped 的不接受迟到结果，兄弟分支互不影响", () => {
  const plan = planOf([unit("a"), unit("b", { depends_on: ["a"] }), unit("c"), unit("d", { depends_on: ["b"] })]);

  // 1) a 成功后再标失败：终态不可覆盖。
  const done = markResult(markRunning(plan, "a"), "a", { ok: true }).plan;
  assert.deepEqual(markResult(done, "a", { ok: false }).changed, []);
  assert.equal(done.states.a, "done");

  // 2) 独立分支：c 先成功，再让 a 失败 —— c 与 a 无依赖，保持 done。
  const branch = planOf([unit("a"), unit("b", { depends_on: ["a"] }), unit("c"), unit("d", { depends_on: ["b"] })]);
  const cDone = markResult(markRunning(branch, "c"), "c", { ok: true }).plan;
  const aFailed = markResult(cDone, "a", { ok: false }).plan;
  assert.equal(aFailed.states.c, "done", "兄弟分支不受影响");
  assert.equal(aFailed.states.b, "skipped");

  // 3) b 已被 skip 后，迟到的成功结果不生效（否则会跳过验收直接算 done）。
  const late = markResult(aFailed, "b", { ok: true });
  assert.deepEqual(late.changed, []);
  assert.equal(late.plan.states.b, "skipped");
});
