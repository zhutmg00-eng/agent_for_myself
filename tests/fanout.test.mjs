/**
 * Fanout 单测（node:test）。
 *
 * 契约：docs/hermes/CONTRACT.md §8.1 —— 写域重叠且无依赖 = 硬报错；依赖环 = 硬报错；
 * 拓扑序同层保持声明序；frontier 按依赖前沿推进。
 *
 * 模块是纯函数（不碰 store/磁盘/网络），这里额外守住三条不变量：
 * 输出确定性、不改入参、错误码只来自 FANOUT_ERROR_CODES。
 */
import { TEST_DATA_ROOT } from "./_helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FANOUT_ERROR_CODES,
  FANOUT_LIMITS,
  frontier,
  normalizeScope,
  planTasks,
  scopesOverlap,
} from "../src/rooms/fanout.js";

const MEMBERS = ["boss", "coder", "reviewer", "writer", "analyst"];

/** 构造一条任务（默认给 coder，避免每个用例都写 bot_id）。 */
function task(id, extra = {}) {
  return { id, bot_id: "coder", ...extra };
}

/** 只取错误码，便于断言顺序。 */
function codes(plan) {
  return plan.errors.map((error) => error.code);
}

test("env: 测试数据根被隔离在 D:（模块本身不写盘，这条守住 import 顺序）", () => {
  assert.ok(TEST_DATA_ROOT);
  assert.ok(!/^c:/i.test(TEST_DATA_ROOT), `拒绝在 C: 上跑测试: ${TEST_DATA_ROOT}`);
});

test("FANOUT_LIMITS 与契约逐字一致且冻结；错误码清单完整", () => {
  assert.deepEqual({ ...FANOUT_LIMITS }, { maxTasks: 12, maxScope: 8, maxIdLength: 40 });
  assert.equal(Object.isFrozen(FANOUT_LIMITS), true);
  assert.equal(Object.isFrozen(FANOUT_ERROR_CODES), true);
  assert.deepEqual([...FANOUT_ERROR_CODES], [
    "duplicate_id",
    "empty_id",
    "id_too_long",
    "unknown_member",
    "unknown_dependency",
    "self_dependency",
    "cycle",
    "write_conflict",
    "too_many_tasks",
    "scope_too_large",
    "invalid_task",
  ]);
});

test("空输入：返回空计划而不是抛错", () => {
  const empty = { ok: true, errors: [], warnings: [], order: [], units: [], conflicts: [] };
  assert.deepEqual(planTasks(), empty);
  assert.deepEqual(planTasks({}), empty);
  assert.deepEqual(planTasks({ tasks: [], members: [] }), empty);
  assert.deepEqual(frontier([], []), []);
  assert.deepEqual(frontier(undefined, undefined), []);
});

test("normalizeScope：小写、反斜杠转正斜杠、去尾斜杠、去空去重、结尾通配折成目录", () => {
  assert.deepEqual(normalizeScope("Src\\Lib\\"), ["src/lib"]);
  assert.deepEqual(normalizeScope(["A/", "a", "", "   ", "./B/"]), ["a", "b"]);
  assert.deepEqual(normalizeScope("src/**"), ["src"]);
  assert.deepEqual(normalizeScope("src/*"), ["src"]);
  assert.deepEqual(normalizeScope("**"), []);
  assert.deepEqual(normalizeScope("D:/WS/"), ["d:/ws"]);
  assert.deepEqual(normalizeScope("//srv//share//"), ["/srv/share"]);
  assert.deepEqual(normalizeScope(""), []);
  assert.deepEqual(normalizeScope(null), []);
  assert.deepEqual(normalizeScope([null, 42, {}]), [], "非字符串条目直接丢弃");
});

test("scopesOverlap：相等/前缀即重叠，按路径段判定，不误伤同名前缀目录", () => {
  assert.equal(scopesOverlap("D:/ws", "d:/ws/a.md"), true, "目录覆盖文件");
  assert.equal(scopesOverlap("d:/ws/a.md", "d:/ws/a.md"), true, "相等");
  assert.equal(scopesOverlap("D:\\WS\\", "d:/ws/a.md"), true, "大小写与反斜杠归一");
  assert.equal(scopesOverlap("src/**", "src/x/y.md"), true, "结尾 ** 表示整目录");
  assert.equal(scopesOverlap(["a", "b"], ["b/c"]), true, "数组形态");
  assert.equal(scopesOverlap("src", "src2"), false, "按段比较，src 不覆盖 src2");
  assert.equal(scopesOverlap("src/a", "src/ab"), false);
  assert.equal(scopesOverlap("/ws", "ws"), false, "根路径不与相对路径混同");
  assert.equal(scopesOverlap("", "a"), false);
  assert.equal(scopesOverlap([], []), false);
});

test("正常 DAG：拓扑序同层声明序、depth 从 0 起、units 字段与契约一致", () => {
  const plan = planTasks({
    tasks: [
      task("w1", { write_scope: ["src/a"] }),
      task("w2", { bot_id: "reviewer", depends_on: ["w1"], write_scope: ["docs/b"] }),
      task("w3", { bot_id: "writer", depends_on: ["w1"], write_scope: ["docs/c"] }),
    ],
    members: MEMBERS,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.order, ["w1", "w2", "w3"]);
  assert.deepEqual(plan.units, [
    { id: "w1", bot_id: "coder", write_scope: ["src/a"], depends_on: [], depth: 0 },
    { id: "w2", bot_id: "reviewer", write_scope: ["docs/b"], depends_on: ["w1"], depth: 1 },
    { id: "w3", bot_id: "writer", write_scope: ["docs/c"], depends_on: ["w1"], depth: 1 },
  ]);
  assert.deepEqual(plan.conflicts, []);
});

test("同层顺序：无依赖任务按声明顺序输出；跨层仍按层聚合", () => {
  const sameLayer = planTasks({ tasks: [task("c"), task("b"), task("a")], members: MEMBERS });
  assert.deepEqual(sameLayer.order, ["c", "b", "a"]);

  const layered = planTasks({
    tasks: [
      task("x", { depends_on: ["a"] }),
      task("a"),
      task("b"),
      task("y", { depends_on: ["b"] }),
    ],
    members: MEMBERS,
  });
  assert.deepEqual(layered.order, ["a", "b", "x", "y"], "第 0 层 a,b 保持声明序，第 1 层 x,y");
  assert.deepEqual(
    layered.units.map((unit) => [unit.id, unit.depth]),
    [["x", 1], ["a", 0], ["b", 0], ["y", 1]],
    "units 保持声明顺序，depth 反映层号",
  );
});

test("单点依赖：A 完成后 B 才可跑，frontier 第一次只给 A", () => {
  const plan = planTasks({
    tasks: [task("a", { write_scope: ["src/a"] }), task("b", { depends_on: ["a"], write_scope: ["src/b"] })],
    members: MEMBERS,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.order, ["a", "b"]);
  assert.deepEqual(frontier(plan.order, plan.units), ["a"]);
});

test("未知成员：报 unknown_member 并带 task_id/other_id", () => {
  const plan = planTasks({ tasks: [task("a", { bot_id: "ghost" })], members: MEMBERS });
  assert.equal(plan.ok, false);
  assert.deepEqual(codes(plan), ["unknown_member"]);
  assert.equal(plan.errors[0].task_id, "a");
  assert.equal(plan.errors[0].other_id, "ghost");
  assert.deepEqual(plan.order, []);
  assert.deepEqual(plan.units, []);
});

test("未知依赖：报 unknown_dependency 且不把依赖当成层", () => {
  const plan = planTasks({
    tasks: [task("a"), task("b", { depends_on: ["zzz"] })],
    members: MEMBERS,
  });
  assert.equal(plan.ok, false);
  assert.deepEqual(codes(plan), ["unknown_dependency"]);
  assert.equal(plan.errors[0].task_id, "b");
  assert.equal(plan.errors[0].other_id, "zzz");
});

test("自依赖：报 self_dependency，不影响其它任务排序", () => {
  const plan = planTasks({
    tasks: [task("a", { depends_on: ["a"] }), task("b", { depends_on: ["a"] })],
    members: MEMBERS,
  });
  assert.equal(plan.ok, false);
  assert.deepEqual(codes(plan), ["self_dependency"]);
  assert.equal(plan.errors[0].task_id, "a");
  assert.deepEqual(plan.order, ["a", "b"], "去掉自环后仍可排序（出错时 order 是尽力而为）");
});

test("依赖环：报 cycle，环上的任务 depth=-1 且不进 order", () => {
  const plan = planTasks({
    tasks: [
      task("a", { depends_on: ["c"] }),
      task("b", { depends_on: ["a"] }),
      task("c", { depends_on: ["b"] }),
      task("d"),
    ],
    members: MEMBERS,
  });
  assert.equal(plan.ok, false);
  assert.deepEqual(codes(plan), ["cycle"]);
  assert.equal(plan.errors[0].task_id, "a");
  assert.match(plan.errors[0].message, /环/);
  assert.deepEqual(plan.order, ["d"], "只有环外的 d 能排序");
  assert.deepEqual(
    plan.units.map((unit) => [unit.id, unit.depth]),
    [["a", -1], ["b", -1], ["c", -1], ["d", 0]],
  );
});

test("重复 id：保留第一条，第二条报 duplicate_id", () => {
  const plan = planTasks({
    tasks: [task("a", { write_scope: ["src/one"] }), task("a", { write_scope: ["src/two"] })],
    members: MEMBERS,
  });
  assert.equal(plan.ok, false);
  assert.deepEqual(codes(plan), ["duplicate_id"]);
  assert.equal(plan.errors[0].task_id, "a");
  assert.equal(plan.units.length, 1);
  assert.deepEqual(plan.units[0].write_scope, ["src/one"]);

  // 未通过校验的任务不占用 id：后续同名任务可以正常声明（错误互不掩盖）。
  const shadowed = planTasks({
    tasks: [task("a", { bot_id: "ghost" }), task("a", { write_scope: ["src/ok"] })],
    members: MEMBERS,
  });
  assert.deepEqual(codes(shadowed), ["unknown_member"]);
  assert.equal(shadowed.units.length, 1);
});

test("id 长度：40 字符可用，41 字符报 id_too_long；空 id 报 empty_id", () => {
  const forty = "x".repeat(40);
  assert.equal(planTasks({ tasks: [task(forty)], members: MEMBERS }).ok, true);
  const tooLong = planTasks({ tasks: [task("x".repeat(41))], members: MEMBERS });
  assert.deepEqual(codes(tooLong), ["id_too_long"]);

  const empty = planTasks({ tasks: [{ id: "  ", bot_id: "coder" }], members: MEMBERS });
  assert.deepEqual(codes(empty), ["empty_id"]);
  assert.equal(empty.errors[0].task_id, undefined, "没有可用 id 时不带 task_id");
  const missing = planTasks({ tasks: [{ bot_id: "coder" }], members: MEMBERS });
  assert.deepEqual(codes(missing), ["empty_id"]);
});

test("写域重叠且无依赖：write_conflict 硬报错，conflicts 给出冲突对", () => {
  const plan = planTasks({
    tasks: [
      task("a", { write_scope: ["src"] }),
      task("b", { bot_id: "writer", write_scope: ["src/x.md"] }),
    ],
    members: MEMBERS,
  });
  assert.equal(plan.ok, false);
  assert.deepEqual(codes(plan), ["write_conflict"]);
  assert.equal(plan.errors[0].task_id, "a");
  assert.equal(plan.errors[0].other_id, "b");
  assert.match(plan.errors[0].message, /depends_on/);
  assert.deepEqual(plan.conflicts, [["a", "b"]]);
});

test("有依赖边时写域重叠不算冲突，只记 warning（直接依赖）", () => {
  const plan = planTasks({
    tasks: [
      task("a", { write_scope: ["src"] }),
      task("b", { depends_on: ["a"], write_scope: ["src/x.md"] }),
    ],
    members: MEMBERS,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /串行化/);
  assert.match(plan.warnings[0], /a 与 b/);
});

test("依赖闭包内的写域重叠同样放行（A→B→C，A 与 C 重叠也合法）", () => {
  const plan = planTasks({
    tasks: [
      task("a", { write_scope: ["src"] }),
      task("b", { depends_on: ["a"], write_scope: ["docs"] }),
      task("c", { depends_on: ["b"], write_scope: ["src/x.md"] }),
    ],
    members: MEMBERS,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.warnings.length, 1, "a 与 c 的传递依赖让重叠变成串行化");
  assert.match(plan.warnings[0], /a 与 c/);
});

test("目录 vs 文件、大小写/反斜杠：归一后仍判为同一片写域", () => {
  const plan = planTasks({
    tasks: [
      task("a", { write_scope: ["D:\\WS\\"] }),
      task("b", { bot_id: "analyst", write_scope: ["d:/ws/report.md"] }),
    ],
    members: MEMBERS,
  });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.conflicts, [["a", "b"]]);

  const siblings = planTasks({
    tasks: [task("a", { write_scope: ["src"] }), task("b", { write_scope: ["src2"] })],
    members: MEMBERS,
  });
  assert.equal(siblings.ok, true);
  assert.deepEqual(siblings.warnings, []);
});

test("上限：任务数 > maxTasks、单任务写域 > maxScope 都报错", () => {
  const many = Array.from({ length: FANOUT_LIMITS.maxTasks + 1 }, (_unused, index) => task(`t${index}`));
  const tooMany = planTasks({ tasks: many, members: MEMBERS });
  assert.equal(tooMany.ok, false);
  assert.deepEqual(codes(tooMany), ["too_many_tasks"]);

  const boundary = planTasks({ tasks: many.slice(0, FANOUT_LIMITS.maxTasks), members: MEMBERS });
  assert.equal(boundary.ok, true, "正好 maxTasks 条是允许的");

  const scopes = Array.from({ length: FANOUT_LIMITS.maxScope + 1 }, (_unused, index) => `dir${index}/`);
  const tooWide = planTasks({ tasks: [task("a", { write_scope: scopes })], members: MEMBERS });
  assert.deepEqual(codes(tooWide), ["scope_too_large"]);

  const atLimit = planTasks({ tasks: [task("a", { write_scope: scopes.slice(0, FANOUT_LIMITS.maxScope) })], members: MEMBERS });
  assert.equal(atLimit.ok, true);
});

test("invalid_task：非对象任务、tasks 非数组、写域/依赖字段类型错误都被挡住", () => {
  assert.deepEqual(codes(planTasks({ tasks: [null], members: MEMBERS })), ["invalid_task"]);
  assert.deepEqual(codes(planTasks({ tasks: {}, members: MEMBERS })), ["invalid_task"]);
  assert.deepEqual(codes(planTasks({ tasks: [task("a", { write_scope: "src" })], members: MEMBERS })), ["invalid_task"]);
  assert.deepEqual(codes(planTasks({ tasks: [task("a", { write_scope: [42] })], members: MEMBERS })), ["invalid_task"]);
  assert.deepEqual(codes(planTasks({ tasks: [task("a", { depends_on: "b" })], members: MEMBERS })), ["invalid_task"]);
  assert.deepEqual(codes(planTasks({ tasks: [task("a", { depends_on: [1] })], members: MEMBERS })), ["invalid_task"]);
  assert.deepEqual(codes(planTasks({ tasks: [task("a", { depends_on: [""] })], members: MEMBERS })), ["invalid_task"]);
  assert.deepEqual(codes(planTasks({ tasks: [{ id: "a" }], members: MEMBERS })), ["invalid_task"], "缺 bot_id");
});

test("frontier：逐层推进，完成标记后只放下一层；已完成的单元不再返回", () => {
  const plan = planTasks({
    tasks: [task("a"), task("b", { depends_on: ["a"] }), task("c", { depends_on: ["b"] })],
    members: MEMBERS,
  });
  assert.deepEqual(plan.order, ["a", "b", "c"]);

  const done = new Set();
  const mark = (ids) => {
    for (const id of ids) done.add(id);
    return plan.units.map((unit) => (done.has(unit.id) ? { ...unit, done: true } : unit));
  };

  let units = mark([]);
  assert.deepEqual(frontier(plan.order, units), ["a"], "第一层是 a");
  units = mark(frontier(plan.order, units));
  assert.deepEqual(frontier(plan.order, units), ["b"], "a 完成后推进到 b");
  units = mark(frontier(plan.order, units));
  assert.deepEqual(frontier(plan.order, units), ["c"]);
  units = mark(["c"]);
  assert.deepEqual(frontier(plan.order, units), [], "全部完成");

  // status 形态也认，且 done 的单元不会被再次返回。
  assert.deepEqual(frontier(plan.order, [{ id: "a", status: "completed", depends_on: [] }]), []);
  assert.deepEqual(
    frontier(["a", "b", "zzz"], [{ id: "a", status: "done", depends_on: [] }, { id: "b", depends_on: ["a"] }]),
    ["b"],
    "不在 units 里的 id 被忽略",
  );
});

test("纯函数：确定性、不改入参、返回结构可安全修改", () => {
  const tasks = Object.freeze([
    Object.freeze({ id: "a", bot_id: "coder", write_scope: Object.freeze(["src"]), depends_on: Object.freeze([]) }),
    Object.freeze({ id: "b", bot_id: "writer", write_scope: Object.freeze(["docs"]), depends_on: Object.freeze(["a"]) }),
  ]);
  const members = Object.freeze(["coder", "writer"]);
  const snapshot = JSON.stringify({ tasks, members });

  const first = planTasks({ tasks, members });
  const second = planTasks({ tasks, members });
  assert.deepEqual(first, second, "同输入必须同输出");
  assert.equal(JSON.stringify({ tasks, members }), snapshot, "不得修改入参数组/对象");

  first.units[0].write_scope.push("hacked");
  first.order.push("hacked");
  assert.deepEqual(planTasks({ tasks, members }), second, "返回值是副本，不污染后续调用");

  // 每个 error 的 code 都必须来自公开清单，UI 才能安全 switch。
  const bad = planTasks({
    tasks: [
      null,
      { id: "a", bot_id: "ghost" },
      { id: "a", bot_id: "coder", depends_on: ["nope"] },
      { id: "b", bot_id: "coder", depends_on: ["b"] },
      task("c", { write_scope: ["src"] }),
      task("d", { write_scope: ["src/x"] }),
    ],
    members: MEMBERS,
  });
  assert.ok(bad.errors.length >= 4);
  for (const error of bad.errors) assert.ok(FANOUT_ERROR_CODES.includes(error.code), `未知错误码 ${error.code}`);
});

test("空写域合法：没有写域声明的任务不产生冲突，也不误报", () => {
  const plan = planTasks({
    tasks: [task("a"), task("b", { depends_on: ["a"] })],
    members: MEMBERS,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.units[0].write_scope, []);
});

test("members 接受成员记录对象，依赖重复项去重", () => {
  const plan = planTasks({
    tasks: [task("a"), task("b", { depends_on: ["a", "a", "a"] })],
    members: [{ bot_id: "coder", name: "工程师" }, { id: "reviewer" }],
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.units[1].depends_on, ["a"]);
  assert.deepEqual(plan.order, ["a", "b"]);
});
