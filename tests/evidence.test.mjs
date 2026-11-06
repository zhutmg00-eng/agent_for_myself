/**
 * 证据阶梯测试（node:test）。
 *
 * 覆盖：契约常量 / prepared（只有文本）/ observed（成功工具 + 已知 file_id）/
 * mismatch（file_id 不存在、声称保存但无成功 save、读失败仍声称已读）/
 * 工具全失败 / 多 file_id 混合 / 大小写与空白 / 反引号写法 / 中文与英文否定 /
 * files 与 knownFileIds 两种证据来源 / 纯函数无副作用 / 幂等 / list / summary /
 * 跨重开持久化 / knownFileIds 省略时以群文件空间兜底 / 入参校验 / 跨房间隔离。
 *
 * 数据根由 _helpers/env.mjs 重定向到 D:\能力测试\temp，绝不写 C 盘。
 */
import { TEST_DATA_ROOT, onCleanup } from "./_helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Store } from "../src/store.js";
import { EVIDENCE_LABELS, EVIDENCE_STATUS, classifyClaims, createEvidence } from "../src/rooms/evidence.js";

const ROOM = "room-evidence";
const OTHER_ROOM = "room-evidence-b";
const BOT = "librarian";
const FID = "a1b2c3d4e5f6";
const FID2 = "0ff1ce123456";
const UNKNOWN = "deadbeef00";
const NOW = Date.parse("2026-11-06T00:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

let serial = 0;

function makeStore(tag) {
  const dbPath = path.join(TEST_DATA_ROOT, "data", `${tag}-${serial++}.db`);
  const store = new Store(dbPath);
  onCleanup(() => store.close());
  return { store, dbPath };
}

function makeEvidence(tag) {
  const { store, dbPath } = makeStore(tag);
  const evidence = createEvidence({ store, now: () => NOW });
  return { evidence, store, dbPath };
}

const readOk = (summary = "read 1.2kb") => [{ name: "room_file_read", ok: true, summary }];
const saveOk = (summary = "saved notes.md") => [{ name: "room_file_save", ok: true, summary }];

/* ------------------------------------------------------------------ 契约面 */

test("evidence: 契约常量与 classifyClaims 返回形状", () => {
  assert.deepEqual(EVIDENCE_STATUS, ["observed", "prepared", "mismatch"]);
  assert.deepEqual(Object.keys(EVIDENCE_LABELS), EVIDENCE_STATUS);
  for (const status of EVIDENCE_STATUS) assert.equal(typeof EVIDENCE_LABELS[status], "string");
  const result = classifyClaims({ text: "完成" });
  assert.deepEqual(Object.keys(result).sort(), ["claims", "reasons", "status"]);
  assert.ok(Array.isArray(result.claims) && Array.isArray(result.reasons));
});

/* ------------------------------------------------------------------ 三态判定 */

test("classifyClaims: 只有文本 -> prepared，并给出可解释原因", () => {
  const result = classifyClaims({ text: "我已完成这轮分析，结论如下：A 方案更稳。" });
  assert.equal(result.status, "prepared");
  assert.deepEqual(result.claims, [], "没有 file_id / 保存 / 工具声明时不臆造 claim");
  assert.deepEqual(result.reasons, ["no_tool_calls"]);
});

test("classifyClaims: 成功读取 + 引用已知 file_id -> observed", () => {
  const result = classifyClaims({
    text: `已读取群文件，见 file_id: ${FID}。`,
    toolCalls: readOk(),
    knownFileIds: [FID],
  });
  assert.equal(result.status, "observed");
  const fileIdClaim = result.claims.find((c) => c.kind === "file_id");
  assert.equal(fileIdClaim.evidence.file_id, FID);
  assert.equal(fileIdClaim.evidence.known, true);
  const readClaim = result.claims.find((c) => c.kind === "read");
  assert.equal(readClaim.evidence.ok, 1);
  assert.equal(readClaim.evidence.failed, 0);
  assert.ok(result.claims.some((c) => c.kind === "tool" && c.evidence.ok === true));
  assert.deepEqual(result.reasons, ["tool_ok:room_file_read"]);
});

test("classifyClaims: file_id 不在已知集合 -> mismatch（优先级高于 observed）", () => {
  const result = classifyClaims({
    text: `结果在 file_id: ${UNKNOWN}`,
    toolCalls: readOk(),
    knownFileIds: [FID],
  });
  assert.equal(result.status, "mismatch", "有成功工具也压不过不存在的 file_id");
  const claim = result.claims.find((c) => c.kind === "file_id");
  assert.equal(claim.evidence.known, false);
  assert.ok(result.reasons.includes(`unknown_file_id:${UNKNOWN}`));
});

test("classifyClaims: 声称已保存但没有任何 room_file_save -> mismatch", () => {
  const result = classifyClaims({ text: "文件已保存到群空间，可以直接引用。" });
  assert.equal(result.status, "mismatch");
  assert.ok(result.reasons.includes("claim_save_without_successful_room_file_save"));
  assert.ok(result.reasons.includes("no_tool_calls"));
  const claim = result.claims.find((c) => c.kind === "saved");
  assert.deepEqual(claim.evidence, { tools: ["room_file_save"], ok: 0, failed: 0 });
});

test("classifyClaims: 声称已保存但 room_file_save 失败 -> mismatch", () => {
  const result = classifyClaims({
    text: "已经把结论写入 notes.md。",
    toolCalls: [{ name: "room_file_save", ok: false, summary: "EACCES: permission denied" }],
  });
  assert.equal(result.status, "mismatch");
  assert.ok(result.reasons.includes("claim_save_but_room_file_save_failed"));
  assert.ok(result.reasons.includes("tool_failed:room_file_save"));
});

test("classifyClaims: 保存成功 + file_id 已知 -> observed", () => {
  const result = classifyClaims({
    text: `已保存，file_id: ${FID}。`,
    toolCalls: saveOk(),
    knownFileIds: [FID],
  });
  assert.equal(result.status, "observed");
  const saved = result.claims.find((c) => c.kind === "saved");
  assert.equal(saved.evidence.ok, 1);
  assert.ok(result.reasons.includes("tool_ok:room_file_save"));
});

test("classifyClaims: 工具全部失败 -> prepared（不是 mismatch）", () => {
  const result = classifyClaims({
    text: "正在处理中。",
    toolCalls: [
      { name: "room_file_read", ok: false },
      { name: "room_file_save", ok: false },
    ],
  });
  assert.equal(result.status, "prepared");
  assert.ok(result.reasons.includes("no_successful_tool_call"));
  assert.ok(result.reasons.includes("tool_failed:room_file_read"));
  assert.ok(result.reasons.includes("tool_failed:room_file_save"));
  assert.ok(!result.reasons.some((r) => r.startsWith("claim_")));
});

test("classifyClaims: 多个 file_id 混合（一真一假）-> mismatch 且保留全部声明", () => {
  const result = classifyClaims({
    text: `主文件 file_id: ${FID}，备份 file_id: ${UNKNOWN}。`,
    toolCalls: readOk(),
    knownFileIds: [FID],
  });
  assert.equal(result.status, "mismatch");
  const fileIdClaims = result.claims.filter((c) => c.kind === "file_id");
  assert.equal(fileIdClaims.length, 2);
  assert.deepEqual(fileIdClaims.map((c) => c.evidence.known), [true, false]);
  assert.ok(result.reasons.includes(`unknown_file_id:${UNKNOWN}`));
  assert.ok(!result.reasons.includes(`unknown_file_id:${FID}`));
});

test("classifyClaims: 大小写、全角冒号与空白都能识别 file_id", () => {
  const result = classifyClaims({
    text: `结果见 FILE_ID ：   A1B2C3D4E5F6 \n 以及 file_id:${FID2}`,
    toolCalls: readOk(),
    knownFileIds: [FID, FID2],
  });
  assert.equal(result.status, "observed");
  const fileIds = result.claims.filter((c) => c.kind === "file_id");
  assert.equal(fileIds.length, 2);
  assert.deepEqual(fileIds.map((c) => c.evidence.file_id), [FID, FID2], "统一归一为小写");
  assert.ok(fileIds.every((c) => c.evidence.known === true));
});

test("classifyClaims: 反引号包裹的 6+ 位 hex 也是 file_id 声明", () => {
  const tick = String.fromCharCode(96);
  const result = classifyClaims({
    text: `内容在 ${tick}${FID}${tick} 里，另一个是 ${tick}${UNKNOWN}${tick}`,
    toolCalls: readOk(),
    knownFileIds: [FID],
  });
  assert.equal(result.status, "mismatch");
  const fileIds = result.claims.filter((c) => c.kind === "file_id");
  assert.deepEqual(fileIds.map((c) => c.evidence.form), ["quoted", "quoted"]);
  assert.equal(fileIds[0].evidence.known, true);
  assert.equal(fileIds[1].evidence.known, false);
  assert.ok(result.reasons.includes(`unknown_file_id:${UNKNOWN}`));
});

test("classifyClaims: 中文/英文否定语境不算声称保存", () => {
  const negations = [
    "尚未保存，稍后重试。",
    "我还没有写入文件。",
    "已保存失败，请重试。",
    "not saved yet",
    "The file was not written.",
  ];
  for (const text of negations) {
    const result = classifyClaims({ text });
    assert.equal(result.status, "prepared", text);
    assert.ok(!result.claims.some((c) => c.kind === "saved"), `不该把否定读成成功声称：${text}`);
  }
});

test("classifyClaims: files 与 knownFileIds 两种证据来源等价", () => {
  const text = `已读取，见 file_id: ${FID}`;
  const fromIds = classifyClaims({ text, toolCalls: readOk(), knownFileIds: [FID] });
  const fromFiles = classifyClaims({ text, toolCalls: readOk(), files: [{ file_id: FID, path: "a.md" }] });
  assert.equal(fromIds.status, "observed");
  assert.deepEqual(fromFiles.status, fromIds.status);
  assert.deepEqual(fromFiles.claims, fromIds.claims);
});

test("classifyClaims: 声称已读取但 room_file_read 失败 -> mismatch", () => {
  const result = classifyClaims({
    text: "已读取文件，内容如下……",
    toolCalls: [{ name: "room_file_read", ok: false }],
  });
  assert.equal(result.status, "mismatch");
  assert.ok(result.reasons.includes("claim_read_but_room_file_read_failed"));
});

test("classifyClaims: 工具结果形态容错（只有显式成功才算成功）", () => {
  assert.equal(classifyClaims({ text: "完成", toolCalls: [{ name: "room_file_read", ok: "true" }] }).status, "prepared");
  assert.equal(classifyClaims({ text: "完成", toolCalls: [{ name: "room_file_read" }] }).status, "prepared");
  assert.equal(classifyClaims({ text: "完成", toolCalls: [null, 42, "read"] }).status, "prepared");
  assert.equal(classifyClaims({ text: "完成", toolCalls: "read" }).status, "prepared", "非数组按没有工具处理");
  const weird = classifyClaims({ text: "完成", toolCalls: [{ name: "x", ok: true, summary: "a\nb   c" }] });
  assert.equal(weird.status, "observed");
  assert.equal(weird.claims.find((c) => c.kind === "tool").text, "x: a b c", "summary 压成单行并截断");
});

test("classifyClaims: 纯函数无副作用（冻结入参、重复调用一致、不需要 store）", () => {
  const input = Object.freeze({
    text: `已保存，见 file_id: ${FID}`,
    toolCalls: Object.freeze([Object.freeze({ name: "room_file_save", ok: true, summary: "saved" })]),
    files: Object.freeze([Object.freeze({ file_id: FID })]),
    knownFileIds: Object.freeze([FID]),
  });
  const first = classifyClaims(input);
  const second = classifyClaims(input);
  assert.deepEqual(first, second);
  assert.equal(first.status, "observed");
  // 再调用一次"只有文本"的判定，确认上一次调用没有留下全局状态。
  assert.equal(classifyClaims({ text: "已保存" }).status, "mismatch");
});

/* -------------------------------------------------------------------- 存储 */

test("createEvidence: record/get 幂等，同一 message_seq 只保留最新判定", () => {
  const { evidence } = makeEvidence("idempotent");
  const first = evidence.record({
    roomId: ROOM,
    botId: BOT,
    messageSeq: 7,
    text: `已保存，file_id: ${FID}`,
    toolCalls: [],
    knownFileIds: [FID],
  });
  assert.equal(first.status, "mismatch");
  assert.equal(first.ts, NOW_ISO);
  assert.ok(first.reasons.includes("claim_save_without_successful_room_file_save"));

  const second = evidence.record({
    roomId: ROOM,
    botId: BOT,
    messageSeq: 7,
    text: "本轮没有动文件。",
    toolCalls: [],
    knownFileIds: [FID],
  });
  assert.equal(second.status, "prepared");

  const stored = evidence.get({ roomId: ROOM, messageSeq: 7 });
  assert.equal(stored.status, "prepared", "重复 record 覆盖为最新判定");
  assert.equal(evidence.list({ roomId: ROOM }).length, 1, "唯一键保证不新增行");
  assert.deepEqual(evidence.summary({ roomId: ROOM }), {
    observed: 0,
    prepared: 1,
    mismatch: 0,
    total: 1,
  });
});

test("createEvidence: list 取最近 N 条且按 message_seq 升序", () => {
  const { evidence } = makeEvidence("list");
  evidence.record({ roomId: ROOM, botId: BOT, messageSeq: 1, text: "完成了" });
  evidence.record({ roomId: ROOM, botId: BOT, messageSeq: 2, text: `file_id: ${UNKNOWN}`, knownFileIds: [FID] });
  evidence.record({ roomId: ROOM, botId: BOT, messageSeq: 3, text: "已读取", toolCalls: readOk() });

  assert.deepEqual(evidence.list({ roomId: ROOM }).map((r) => r.message_seq), [1, 2, 3]);
  assert.deepEqual(evidence.list({ roomId: ROOM, limit: 2 }).map((r) => r.message_seq), [2, 3]);
  assert.equal(evidence.list({ limit: 10 }).length, 3, "省略 roomId 时跨房间总览");
});

test("createEvidence: summary 三态计数，空房间报 0 而不是假装有结论", () => {
  const { evidence } = makeEvidence("summary");
  assert.deepEqual(evidence.summary({ roomId: ROOM }), {
    observed: 0,
    prepared: 0,
    mismatch: 0,
    total: 0,
  });
  evidence.record({ roomId: ROOM, botId: BOT, messageSeq: 1, text: "完成了" });
  evidence.record({ roomId: ROOM, botId: BOT, messageSeq: 2, text: `file_id: ${UNKNOWN}`, knownFileIds: [FID] });
  evidence.record({ roomId: ROOM, botId: BOT, messageSeq: 3, text: "已读取", toolCalls: readOk() });
  const summary = evidence.summary({ roomId: ROOM });
  assert.deepEqual(summary, { observed: 1, prepared: 1, mismatch: 1, total: 3 });
  assert.equal(summary.total, summary.observed + summary.prepared + summary.mismatch);
});

test("createEvidence: 跨重开持久化，claims/reasons 可回放", () => {
  const dbPath = path.join(TEST_DATA_ROOT, "data", `evidence-reopen-${serial++}.db`);
  const store1 = new Store(dbPath);
  const evidence1 = createEvidence({ store: store1, now: () => NOW });
  store1.upsertRoomFile(ROOM, { file_id: FID, path: "notes/plan.md" });
  const written = evidence1.record({
    roomId: ROOM,
    botId: BOT,
    messageSeq: 4,
    text: `已保存，见 file_id: ${FID}`,
    toolCalls: saveOk(),
  });
  assert.equal(written.status, "observed");
  store1.close();

  const store2 = new Store(dbPath);
  onCleanup(() => store2.close());
  const evidence2 = createEvidence({ store: store2, now: () => NOW });
  const readBack = evidence2.get({ roomId: ROOM, messageSeq: 4 });
  assert.equal(readBack.status, "observed");
  assert.equal(readBack.bot_id, BOT);
  assert.deepEqual(readBack.claims, written.claims);
  assert.deepEqual(readBack.reasons, written.reasons);
  assert.equal(readBack.ts, NOW_ISO);
});

test("createEvidence: 省略 knownFileIds 时以群文件空间兜底（真文件不误判）", () => {
  const { evidence, store } = makeEvidence("autofill");
  store.upsertRoomFile(ROOM, { file_id: FID, path: "notes/plan.md", description: "计划" });
  const rec = evidence.record({
    roomId: ROOM,
    botId: BOT,
    messageSeq: 5,
    text: `已保存，见 file_id: ${FID}`,
    toolCalls: saveOk(),
    // 故意不传 knownFileIds：record 应自己查 store.listRoomFiles
  });
  assert.equal(rec.status, "observed");
  assert.equal(rec.claims.find((c) => c.kind === "file_id").evidence.known, true);

  // 对照：显式传空集合时，真实存在的文件也算未知（调用方说了算，不猜）。
  const strict = evidence.record({
    roomId: ROOM,
    botId: BOT,
    messageSeq: 6,
    text: `file_id: ${FID}`,
    toolCalls: readOk(),
    knownFileIds: [],
  });
  assert.equal(strict.status, "mismatch");

  // null 等同省略：仍走群文件空间兜底，不会被当成"一个文件都没有"。
  const nullFallback = evidence.record({
    roomId: ROOM,
    botId: BOT,
    messageSeq: 8,
    text: `file_id: ${FID}`,
    toolCalls: readOk(),
    knownFileIds: null,
  });
  assert.equal(nullFallback.status, "observed");
});

test("createEvidence: 入参校验（roomId / messageSeq / store / 缺失记录）", () => {
  const { evidence } = makeEvidence("validate");
  assert.throws(() => evidence.record({ messageSeq: 1 }), /roomId/);
  assert.throws(() => evidence.record({ roomId: "   ", messageSeq: 1 }), /roomId/);
  assert.throws(() => evidence.record({ roomId: ROOM, messageSeq: -1 }), /messageSeq/);
  assert.throws(() => evidence.record({ roomId: ROOM, messageSeq: 1.5 }), /messageSeq/);
  assert.throws(() => evidence.record({ roomId: ROOM, messageSeq: "abc" }), /messageSeq/);
  assert.equal(evidence.get({ roomId: ROOM, messageSeq: 99 }), null);
  assert.equal(evidence.get({ roomId: ROOM, messageSeq: 1 }), null);
  assert.throws(() => createEvidence({}), /store/);
  assert.throws(() => createEvidence(), /store/);
});

test("createEvidence: 跨房间隔离与全局 summary", () => {
  const { evidence } = makeEvidence("rooms");
  evidence.record({ roomId: ROOM, botId: BOT, messageSeq: 1, text: "完成" });
  evidence.record({ roomId: OTHER_ROOM, botId: "writer", messageSeq: 1, text: "已保存" });

  assert.equal(evidence.get({ roomId: ROOM, messageSeq: 1 }).status, "prepared");
  assert.equal(evidence.get({ roomId: OTHER_ROOM, messageSeq: 1 }).status, "mismatch");
  assert.equal(evidence.get({ roomId: OTHER_ROOM, messageSeq: 1 }).bot_id, "writer");
  assert.equal(evidence.list({ roomId: ROOM }).length, 1);
  assert.equal(evidence.list({ roomId: OTHER_ROOM }).length, 1);
  assert.deepEqual(evidence.summary({ roomId: ROOM }), {
    observed: 0,
    prepared: 1,
    mismatch: 0,
    total: 1,
  });
  assert.deepEqual(evidence.summary(), { observed: 0, prepared: 1, mismatch: 1, total: 2 });
});

test("evidence: 兼容 room_file_save 回显的 `file_id=` 写法（Lead 补充）", () => {
  const known = ["705c554b"];
  const observed = classifyClaims({
    text: "已保存，file_id=705c554b，请看",
    toolCalls: [{ name: "room_file_save", ok: true, summary: "saved" }],
    knownFileIds: known,
  });
  assert.equal(observed.status, "observed");

  const mismatch = classifyClaims({
    text: "已保存，file_id=deadbeef",
    toolCalls: [{ name: "room_file_save", ok: true, summary: "saved" }],
    knownFileIds: known,
  });
  assert.equal(mismatch.status, "mismatch", "file_id= 也要参与存在性校验");
});
