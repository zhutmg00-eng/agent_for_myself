/**
 * Toolset 单测（node:test）。
 *
 * 契约：docs/hermes/CONTRACT.md §3.2 —— includes 复用、disabled 末端严格减除、
 * posture 裁剪、输出去重且顺序稳定、未知名字可查询。
 *
 * 本模块是纯常量 + 纯函数，不碰 store/磁盘/网络；这里额外验证「声明序」这一
 * 输出不变量，因为 Lead 要用它替换 bot.js 的静态 tools 映射，顺序变化会直接
 * 改变 pi 会话拿到的工具列表。
 */
import { TEST_DATA_ROOT } from "./_helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CORE_TOOLS,
  MUTATING_TOOLS,
  POSTURES,
  READ_ONLY_TOOLS,
  ROLES,
  TOOLSETS,
  expandToolset,
  isKnownToolset,
  listToolsets,
  resolvePosture,
  resolveToolsets,
  toolsForRole,
  unknownToolsets,
} from "../src/toolsets.js";

/** 全局声明序下的期望全集（CORE_TOOLS 定序在前，群工具按 TOOLSETS 声明序补）。 */
const FULL_SURFACE = [
  "read",
  "write",
  "edit",
  "bash",
  "powershell",
  "grep",
  "find",
  "ls",
  "skill_list",
  "skill_invoke",
  "room_list_members",
  "room_assign_task",
  "room_grant_permission",
  "room_revoke_permission",
  "room_set_context_policy",
  "room_set_topic",
  "room_create_subgroup",
  "room_file_list",
  "room_file_read",
  "room_file_save",
  "room_file_move",
  "room_evidence_status",
  "memory",
];

const hasMutating = (tools) => tools.some((tool) => MUTATING_TOOLS.includes(tool));

test("env: 测试数据根被隔离在 D:（模块本身不写盘，这条守住 import 顺序）", () => {
  assert.ok(TEST_DATA_ROOT, "TEST_DATA_ROOT 必须可用");
  assert.ok(!/^c:/i.test(TEST_DATA_ROOT), `拒绝在 C: 上跑测试: ${TEST_DATA_ROOT}`);
});

test("CORE_TOOLS 覆盖 archetypes 的真实并集且是 READ_ONLY_TOOLS 的超集", () => {
  assert.deepEqual([...CORE_TOOLS], ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"]);
  for (const tool of READ_ONLY_TOOLS) assert.ok(CORE_TOOLS.includes(tool), `${tool} 必须在 CORE_TOOLS 里`);
  // 8 个 archetype 的 tools 并集（archetypes.js）：read/write/edit/bash/grep/find/ls
  for (const tool of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
    assert.ok(CORE_TOOLS.includes(tool), `${tool} 必须在 CORE_TOOLS 里`);
  }
  assert.equal(new Set(CORE_TOOLS).size, CORE_TOOLS.length, "CORE_TOOLS 不能有重复");
});

test("TOOLSETS 至少 10 个命名工具集，形状与中文描述符合约定", () => {
  const names = Object.keys(TOOLSETS);
  assert.ok(names.length >= 10, `至少 10 个工具集，实际 ${names.length}`);
  for (const required of ["web", "file", "exec", "search", "skills", "room", "room_files", "memory", "delegate", "review"]) {
    assert.ok(names.includes(required), `缺少工具集 ${required}`);
  }
  for (const [name, def] of Object.entries(TOOLSETS)) {
    assert.deepEqual(Object.keys(def).sort(), ["description", "includes", "tools"], `${name} 的字段必须是 description/tools/includes`);
    assert.equal(typeof def.description, "string");
    assert.match(def.description, /[\u4e00-\u9fa5]/, `${name} 的描述要写中文`);
    assert.ok(Array.isArray(def.tools) && Array.isArray(def.includes), `${name} 的 tools/includes 必须是数组`);
  }
  // 工具集名与工具名原则上不得重名（disabled 同时接受两者）。唯一例外是 memory：
  // 「禁用 memory」的意图就是同时下线这个工具面和同名的记忆工具，二义在这里等于正确。
  const toolNames = new Set(Object.values(TOOLSETS).flatMap((def) => def.tools));
  for (const name of names) {
    if (name === "memory") continue;
    assert.ok(!toolNames.has(name), `工具集名 ${name} 与工具名冲突`);
  }
});

test("listToolsets 按声明顺序返回，size 是展开 includes 后的去重数量", () => {
  const listed = listToolsets();
  assert.deepEqual(listed.map((item) => item.name), Object.keys(TOOLSETS));
  const byName = new Map(listed.map((item) => [item.name, item]));

  const search = byName.get("search");
  assert.equal(typeof search.description, "string");
  assert.deepEqual(search.tools, ["grep", "find", "ls"]);
  assert.deepEqual(search.includes, []);
  assert.equal(search.size, 3);
  // 复合工具集：file = file_read(read+search) + file_write(write/edit) = 6
  assert.deepEqual(byName.get("file").tools, []);
  assert.deepEqual(byName.get("file").includes, ["file_read", "file_write"]);
  assert.equal(byName.get("file").size, 6);
  assert.equal(byName.get("review").size, 7, "review = 工作区只读(4) + 群文件只读(2) + 证据查询(1)");
  assert.equal(byName.get("evidence").size, 1, "evidence 只有 room_evidence_status");
  assert.equal(byName.get("room_files").size, 4);
  assert.equal(byName.get("web").size, 0, "web 是空占位");
  assert.equal(byName.get("memory").size, 1, "memory 工具接入后不再是空占位");

  // 返回的是副本：改返回值不能污染常量。
  const first = listed[0];
  first.tools.push("hacked");
  assert.ok(!TOOLSETS[first.name].tools.includes("hacked"));
});

test("includes 递归展开：file 与 review 把子工具集的工具并进来", () => {
  assert.deepEqual(expandToolset("file"), ["read", "write", "edit", "grep", "find", "ls"]);
  assert.deepEqual(expandToolset("review"), ["read", "grep", "find", "ls", "room_file_list", "room_file_read", "room_evidence_status"]);
  assert.deepEqual(expandToolset("room_files"), ["room_file_list", "room_file_read", "room_file_save", "room_file_move"]);
  assert.deepEqual(expandToolset("file_read"), ["read", "grep", "find", "ls"]);
});

test("disabled 支持工具名：末端严格减除，剩余顺序不变", () => {
  assert.deepEqual(resolveToolsets(["file"], { disabled: ["write", "edit"] }), ["read", "grep", "find", "ls"]);
  assert.deepEqual(resolveToolsets(["skills"], { disabled: ["skill_invoke"] }), ["skill_list"]);
  assert.deepEqual(resolveToolsets(["file"], { disabled: ["not_a_tool"] }), expandToolset("file"), "不存在的工具名不影响结果");
});

test("disabled 支持工具集名：连 includes 里带进来的同名工具也一起减掉", () => {
  assert.deepEqual(resolveToolsets(["file", "exec"], { disabled: ["exec"] }), ["read", "write", "edit", "grep", "find", "ls"]);
  // search 是 file 的间接 include，仍被严格减除（Hermes #17309 语义）。
  assert.deepEqual(resolveToolsets(["file"], { disabled: ["search"] }), ["read", "write", "edit"]);
  assert.deepEqual(resolveToolsets(["all"], { disabled: ["all"] }), []);
  assert.deepEqual(resolveToolsets(["file"], { disabled: ["file"] }), []);
});

test("posture：coding 全套 / review 只读 / minimal 最小", () => {
  assert.deepEqual(Object.keys(POSTURES), ["coding", "review", "minimal"]);
  const coding = resolvePosture("coding");
  assert.deepEqual(coding, [
    "read",
    "write",
    "edit",
    "bash",
    "powershell",
    "grep",
    "find",
    "ls",
    "skill_list",
    "skill_invoke",
    "room_file_list",
    "room_file_read",
    "room_file_save",
    "room_file_move",
  ]);
  const review = resolvePosture("review");
  assert.deepEqual(review, ["read", "grep", "find", "ls", "skill_list", "skill_invoke", "room_file_list", "room_file_read", "room_evidence_status"]);
  assert.equal(hasMutating(review), false, "review 姿态不能含写/执行工具");
  assert.deepEqual(resolvePosture("minimal"), ["read", "ls"]);
  assert.deepEqual(resolvePosture("nope"), [], "未知姿态返回空");
  assert.deepEqual(resolvePosture("coding", { disabled: ["exec"] }), coding.filter((t) => t !== "bash" && t !== "powershell"));
});

test("toolsForRole：群主/成员/执行/审查/文件管家/文案/最小各有不同工具面", () => {
  const owner = toolsForRole({ role: "owner" });
  assert.ok(owner.includes("room_assign_task"), "群主要能分派任务");
  assert.ok(owner.includes("room_set_context_policy"));
  assert.ok(owner.includes("read"));
  assert.equal(hasMutating(owner), false, "群主不写盘不执行");

  const member = toolsForRole();
  assert.deepEqual(member, toolsForRole({ role: "member" }), "默认角色是 member");
  assert.equal(hasMutating(member), false);
  assert.ok(member.includes("read") && member.includes("room_file_read"));
  assert.ok(!member.includes("room_assign_task"), "普通成员没有管理面");

  const worker = toolsForRole({ role: "worker" });
  assert.deepEqual(worker, resolvePosture("coding"), "worker 直接吃 coding 姿态");
  assert.ok(worker.includes("bash") && worker.includes("write"));

  const reviewer = toolsForRole({ role: "reviewer" });
  assert.deepEqual(reviewer, resolvePosture("review"));
  assert.equal(hasMutating(reviewer), false);

  const librarian = toolsForRole({ role: "librarian" });
  assert.ok(librarian.includes("room_file_save") && librarian.includes("room_file_move"));
  assert.ok(librarian.includes("room_file_read"));
  assert.equal(hasMutating(librarian), false, "文件管家只用群工具写盘");

  const writer = toolsForRole({ role: "writer" });
  assert.ok(writer.includes("write") && writer.includes("edit"));
  assert.ok(!writer.includes("bash"), "文案不跑命令");

  assert.deepEqual(toolsForRole({ role: "guest" }), ["read", "ls"]);
  assert.notDeepEqual(owner, member);
  assert.notDeepEqual(worker, reviewer);
});

test("toolsForRole：未知角色回落 member，只读角色即使 extraTools 也拿不到写/执行工具", () => {
  assert.deepEqual(toolsForRole({ role: "no-such-role" }), toolsForRole({ role: "member" }));
  assert.deepEqual(toolsForRole({ role: "owner", extraTools: ["bash", "write"] }), toolsForRole({ role: "owner" }));
  assert.deepEqual(toolsForRole({ role: "reviewer", extraTools: ["bash"] }), resolvePosture("review"));
  // 只读约束同样作用于 posture 覆盖：guest + coding 也只拿到只读部分。
  assert.equal(hasMutating(toolsForRole({ role: "guest", posture: "coding" })), false);
  // 非只读角色可以按需加工具（显式 extraTools 生效）。
  const worker = toolsForRole({ role: "worker", extraTools: ["room_list_members"] });
  assert.ok(worker.includes("room_list_members"));
});

test("原型链名字不会穿透：constructor/toString 当角色、姿态、工具集都要安全回落", () => {
  assert.equal(isKnownToolset("constructor"), false);
  assert.equal(isKnownToolset("toString"), false);
  assert.deepEqual(expandToolset("toString"), []);
  assert.deepEqual(resolvePosture("constructor"), []);
  assert.deepEqual(resolveToolsets(["constructor"]), [], "未知工具集名不抛错");
  assert.deepEqual(toolsForRole({ role: "constructor" }), toolsForRole({ role: "member" }));
  assert.deepEqual(toolsForRole({ role: "worker", posture: "constructor" }), resolvePosture("coding"), "未知姿态回落身份默认");
  assert.deepEqual(toolsForRole({ role: "worker", posture: "nope" }), resolvePosture("coding"));
  assert.deepEqual(toolsForRole({ role: "guest", posture: null }), [], "posture:null 表示明确不用姿态");
});

test("toolsForRole：disabledToolsets 与显式 toolsets 叠加，工具名/工具集名都能减", () => {
  const base = toolsForRole({ role: "worker" });
  const noExec = toolsForRole({ role: "worker", disabledToolsets: ["exec"] });
  assert.deepEqual(noExec, base.filter((tool) => tool !== "bash" && tool !== "powershell"));
  const noWrite = toolsForRole({ role: "worker", disabledToolsets: ["write", "edit"] });
  assert.equal(noWrite.includes("write"), false);
  assert.equal(noWrite.includes("edit"), false);
  const plus = toolsForRole({ role: "member", toolsets: ["room"] });
  assert.ok(plus.includes("room_assign_task"), "显式加 room 工具集要生效");
});

test("去重与顺序稳定：输出与传入的工具集顺序无关，且符合全局声明序", () => {
  const forward = resolveToolsets(["file", "exec", "skills"]);
  const backward = resolveToolsets(["skills", "exec", "file"]);
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward, ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls", "skill_list", "skill_invoke"]);
  assert.equal(new Set(forward).size, forward.length, "输出不能有重复");
  assert.deepEqual(resolveToolsets(["file", "file", "file_read"]), expandToolset("file"));
  // 重复调用结果一致（没有跨调用的 seen 泄漏）。
  assert.deepEqual(expandToolset("file"), expandToolset("file"));
});

test("extra 工具：追加、去重、按声明序落位，且同样接受 disabled 减除", () => {
  assert.deepEqual(resolveToolsets(["skills"], { extra: ["bash", "bash"] }), ["bash", "skill_list", "skill_invoke"]);
  const withUnknown = resolveToolsets(["skills"], { extra: ["custom_tool"] });
  assert.deepEqual(withUnknown, ["skill_list", "skill_invoke", "custom_tool"], "未知工具排最后，保持先出现先输出");
  assert.deepEqual(resolveToolsets([], { extra: ["bash"], disabled: ["bash"] }), []);
});

test("未知名称：unknownToolsets 只报未知、去重保序；解析时静默忽略", () => {
  assert.deepEqual(unknownToolsets(["file", "nope", "web", "*", "nope", ""]), ["nope"]);
  assert.deepEqual(unknownToolsets([]), []);
  assert.deepEqual(unknownToolsets(null), []);
  assert.deepEqual(unknownToolsets([null, 42, {}]), [], "非字符串直接忽略");
  assert.deepEqual(resolveToolsets(["nope"]), []);
  assert.deepEqual(resolveToolsets(["nope", "file"]), expandToolset("file"));
  assert.equal(isKnownToolset("file"), true);
  assert.equal(isKnownToolset("all"), true);
  assert.equal(isKnownToolset("*"), true);
  assert.equal(isKnownToolset("nope"), false);
  assert.equal(isKnownToolset(""), false);
  assert.equal(isKnownToolset(null), false);
});

test("all / * 解析为全部工具集的并集", () => {
  const all = resolveToolsets(["all"]);
  assert.deepEqual(all, FULL_SURFACE);
  assert.deepEqual(resolveToolsets(["*"]), all);
  for (const tool of CORE_TOOLS) assert.ok(all.includes(tool));
  assert.deepEqual(resolveToolsets(["all"], { disabled: ["room", "exec"] }), [
    "read",
    "write",
    "edit",
    "grep",
    "find",
    "ls",
    "skill_list",
    "skill_invoke",
    "room_file_list",
    "room_file_read",
    "room_file_save",
    "room_file_move",
    "room_evidence_status",
    "memory",
  ]);
});

test("循环 includes 防御：环与自环都不会递归爆栈", () => {
  const defs = {
    a: { description: "a", tools: ["read"], includes: ["b"] },
    b: { description: "b", tools: ["ls"], includes: ["a"] },
    self: { description: "self", tools: ["find"], includes: ["self"] },
    leaf: { description: "leaf", tools: ["grep"], includes: ["a", "self"] },
  };
  assert.deepEqual(expandToolset("a", { defs }), ["read", "ls"]);
  assert.deepEqual(expandToolset("self", { defs }), ["find"]);
  assert.deepEqual(expandToolset("leaf", { defs }), ["read", "grep", "find", "ls"]);
  assert.deepEqual(resolveToolsets(["a", "b", "leaf"], { defs }), ["read", "grep", "find", "ls"]);
  // 注入的 defs 也支持 disabled 按集合名减除。
  assert.deepEqual(expandToolset("a", { defs, disabled: ["b"] }), []);
  // 不存在的工具集与空名字都安全返回 []。
  assert.deepEqual(expandToolset("missing", { defs }), []);
});

test("空输入与非法输入：工具面为空而不是抛错", () => {
  assert.deepEqual(resolveToolsets([]), []);
  assert.deepEqual(resolveToolsets(null), []);
  assert.deepEqual(resolveToolsets(undefined), []);
  assert.deepEqual(resolveToolsets("file"), expandToolset("file"), "单个字符串也接受");
  assert.deepEqual(expandToolset(""), []);
  assert.deepEqual(expandToolset(null), []);
  assert.deepEqual(expandToolset("file", { disabled: [] }), expandToolset("file"));
  const member = toolsForRole({});
  assert.ok(Array.isArray(member) && member.length > 0, "默认身份永远有得用");
  assert.deepEqual(toolsForRole({ role: "worker", toolsets: [] }), resolvePosture("coding"));
});

test("纯函数：常量深冻结，函数不修改入参", () => {
  assert.equal(Object.isFrozen(TOOLSETS), true);
  assert.equal(Object.isFrozen(TOOLSETS.file.tools), true);
  assert.equal(Object.isFrozen(CORE_TOOLS), true);
  assert.equal(Object.isFrozen(POSTURES), true);
  assert.equal(Object.isFrozen(ROLES), true);
  assert.throws(() => TOOLSETS.file.tools.push("hacked"), TypeError);
  assert.throws(() => TOOLSETS.hacked = {}, TypeError);

  const disabled = ["write"];
  const extra = ["bash"];
  const names = ["file", "exec"];
  const snapshot = JSON.stringify({ disabled, extra, names });
  resolveToolsets(names, { disabled, extra });
  toolsForRole({ role: "worker", disabledToolsets: disabled, extraTools: extra });
  assert.equal(JSON.stringify({ disabled, extra, names }), snapshot, "函数不能改入参数组");
  assert.deepEqual(disabled, ["write"]);
});
