/**
 * 证据阶梯（evidence ladder）：区分「真的做过（observed）」与「只是声称（prepared）」，
 * 把「声称 file_id 但查不到 / 工具失败仍报成功」判为 mismatch（CONTRACT.md §7.2）。
 *
 * 为什么需要：成员回合落到库里的原本只有一个 `text` 字符串（`store.js:348-362`），群主说"已保存"和文件管家
 * 真的调过 `room_file_save` 在库/UI 里完全同形；`room.js:739-746` 还把失败写成中文 notice。
 * omh 的价值就在这条：声明与观察分家、`observed: false` 是默认值（`HARNESS_QUALITY.md:757-761`）、
 * prepared coverage 不能抬高 observed achievement（`ROLES.md:13`）。
 *
 * 取舍：采纳"声明有类型、有证据引用"；改写 omh 的四态为群聊回合三态（可观测副作用只有 pi 工具调用）；
 * 不采纳完整 prepared coverage 阶梯 / revision 绑定 / 多来源 store_state（见 docs/hermes/EVIDENCE.md §4）。
 *
 * 约束：`classifyClaims` 是纯函数（无 IO、不改入参、表驱动）；`createEvidence` 只写自建表 `ev_records`。
 */
import { createLogger } from "../log.js";

const log = createLogger("evidence");

/** 契约 §7.2 的三态。声明 -> 观察 -> 不符，mismatch 优先级最高。 */
export const EVIDENCE_STATUS = ["observed", "prepared", "mismatch"];

/** UI 徽标文案；判定逻辑不依赖它，避免文案多处复制。 */
export const EVIDENCE_LABELS = { observed: "已观测", prepared: "仅声明", mismatch: "证据不符" };

/**
 * file_id 两种写法（契约 §7.2）：`file_id: abc123` / `file_id：abc123`（可带反引号、大小写、任意空白），
 * 以及反引号包裹的 6+ 位 hex：`` `abc123` ``。注：`room_file_save` 回显用 `file_id=`，不在契约内
 * （见 docs/hermes/EVIDENCE.md §6 决策点）。
 */
// `file_id:` / `file_id：`（全角）/ `file_id=`（room_file_save 的回显格式，见 EVIDENCE.md §6）。
const FILE_ID_FIELD_RE = /file_id\s*[：:=]\s*`?([0-9a-f]{6,})`?/gi;
const FILE_ID_QUOTED_RE = /`([0-9a-f]{6,})`/g;

/** claims_json 必须有界：每回合最多 20 条工具声明、单条 ≤160 字符（对齐 Hermes 的 bounded summary）。 */
const MAX_TOOL_CLAIMS = 20;
const MAX_CLAIM_CHARS = 160;

/**
 * 判定规则表：新增一类"声称"只加一行。`requires` 两种语义：`success` = 必须有成功结果；
 * `no_failure` = 只有"调用过且全失败"才算 mismatch（没调用不判，可能读自群聊上下文）。
 */
const CLAIM_RULES = [
  {
    id: "save",
    kind: "saved",
    tools: ["room_file_save"],
    requires: "success",
    patterns: [
      { re: /已(?:经)?(?:成功)?(?:保存|写入|写盘|落盘|存储)(?:到|至|为|了)?(?!失败|不了|不成功|出错)/g },
      { re: /已(?:经)?(?:把|将)[^。；;！!，,\n]{0,12}?(?:保存|写入|写盘|落盘|存储)(?!失败|不了|不成功|出错)/g },
      { re: /(?:保存|写入|写盘|落盘)(?:成功|完成)/g },
      { re: /\b(?:saved|wrote|written|persisted)\b/gi, guard: notNegated },
    ],
    codes: {
      missing: "claim_save_without_successful_room_file_save",
      failed: "claim_save_but_room_file_save_failed",
    },
  },
  {
    id: "read",
    kind: "read",
    tools: ["room_file_read"],
    requires: "no_failure",
    patterns: [
      { re: /已(?:经)?(?:成功)?(?:读取|阅读|查看|打开)(?:了|过)?(?!失败)/g },
      { re: /已(?:经)?(?:把|将)[^。；;！!，,\n]{0,12}?(?:读取|阅读|查看|打开)(?:了|过)?(?!失败)/g },
      { re: /读取成功|读取完成|已读文件/g },
      { re: /\b(?:read|opened|viewed)\s+(?:the\s+)?(?:file|room_file)\b/gi, guard: notNegated },
    ],
    codes: { failed: "claim_read_but_room_file_read_failed" },
  },
];

/** 否定语境（"not saved" / "并未保存"）不算声称成功；中文两种写法已被正则本身排除。 */
function notNegated(body, hit) {
  const before = body.slice(Math.max(0, hit.index - 10), hit.index);
  return !/(?:\bnot|\bnever|\bno|n't)\s*$/i.test(before);
}

function truncate(value, max = MAX_CLAIM_CHARS) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** 工具结果归一：契约形态 `[{ name, ok, summary }]`；只有显式成功（true / 1）才算成功。 */
function normalizeToolCalls(toolCalls) {
  const calls = [];
  if (!Array.isArray(toolCalls)) return calls;
  for (const entry of toolCalls) {
    if (!entry || typeof entry !== "object") continue;
    const name = String(entry.name ?? entry.tool ?? "").trim() || "unknown";
    const ok = entry.ok === true || entry.ok === 1;
    calls.push({ name, ok, summary: truncate(entry.summary ?? "") });
  }
  return calls;
}

/** knownFileIds 与 files（群文件行）合并成一个小写 file_id 集合；两种入参都容忍。 */
function collectKnownIds({ knownFileIds, files }) {
  const ids = new Set();
  const add = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      const id = value.trim().toLowerCase();
      if (id) ids.add(id);
    } else if (typeof value === "object") add(value.file_id ?? value.fileId ?? value.id);
  };
  if (knownFileIds !== null && knownFileIds !== undefined) {
    if (typeof knownFileIds === "string") add(knownFileIds);
    else if (typeof knownFileIds[Symbol.iterator] === "function") for (const id of knownFileIds) add(id);
    else add(knownFileIds);
  }
  if (Array.isArray(files)) for (const file of files) add(file);
  return ids;
}

/** 抽取文本里的 file_id 声明，按出现位置排序并按 id 去重（大小写归一）。 */
function extractFileIds(body) {
  const found = [];
  for (const match of body.matchAll(FILE_ID_FIELD_RE)) {
    found.push({ index: match.index, raw: match[0], fileId: match[1].toLowerCase(), form: "field" });
  }
  for (const match of body.matchAll(FILE_ID_QUOTED_RE)) {
    found.push({ index: match.index, raw: match[0], fileId: match[1].toLowerCase(), form: "quoted" });
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set();
  const unique = [];
  for (const item of found) {
    if (seen.has(item.fileId)) continue;
    seen.add(item.fileId);
    unique.push(item);
  }
  return unique;
}

/** 在文本里找第一条命中（表驱动）；返回 { index, text } 或 null。 */
function detectClaim(body, rule) {
  for (const pattern of rule.patterns) {
    const re = pattern.re;
    re.lastIndex = 0;
    const match = re.exec(body);
    re.lastIndex = 0;
    if (!match) continue;
    const hit = { index: match.index, text: match[0] };
    if (pattern.guard && !pattern.guard(body, hit)) continue;
    return hit;
  }
  return null;
}

/**
 * 纯函数：判定一个成员回合属于 observed / prepared / mismatch（mismatch 优先级最高）。
 *   1. 文本点名的 file_id 不在 known 集合 -> mismatch（`unknown_file_id:<id>`）
 *   2. 声称已保存/已写入但没有成功的 room_file_save -> mismatch（区分"没调用"与"调用失败"）
 *   3. 声称已读取但 room_file_read 调用过且全失败 -> mismatch
 *   4. 至少一条工具成功 -> observed；其余（无工具 / 全失败）-> prepared
 * @param {{text?:string, toolCalls?:Array<{name:string, ok:boolean, summary?:string}>,
 *          files?:Array<{file_id?:string}|string>, knownFileIds?:Iterable<string>|string}} input
 * @returns {{status:string, claims:Array<{kind:string, text:string, evidence?:object}>, reasons:string[]}}
 */
export function classifyClaims({ text = "", toolCalls = [], files = [], knownFileIds = [] } = {}) {
  const body = String(text ?? "");
  const calls = normalizeToolCalls(toolCalls);
  const successes = calls.filter((call) => call.ok);
  const known = collectKnownIds({ knownFileIds, files });

  const claims = [];
  const mismatches = [];

  // 1) 文本点名的 file_id 必须真实存在。
  for (const item of extractFileIds(body)) {
    const isKnown = known.has(item.fileId);
    claims.push({
      kind: "file_id",
      text: truncate(item.raw),
      evidence: { file_id: item.fileId, known: isKnown, form: item.form },
    });
    if (!isKnown) mismatches.push(`unknown_file_id:${item.fileId}`);
  }

  // 2/3) 成功类声称必须有对应工具的成功结果。
  for (const rule of CLAIM_RULES) {
    const hit = detectClaim(body, rule);
    if (!hit) continue;
    const related = calls.filter((call) => rule.tools.includes(call.name));
    const okCount = related.filter((call) => call.ok).length;
    const failedCount = related.length - okCount;
    claims.push({
      kind: rule.kind,
      text: truncate(hit.text),
      evidence: { tools: [...rule.tools], ok: okCount, failed: failedCount },
    });
    if (rule.requires === "success" && okCount === 0) {
      mismatches.push(failedCount ? rule.codes.failed : rule.codes.missing);
    } else if (rule.requires === "no_failure" && okCount === 0 && failedCount > 0) {
      mismatches.push(rule.codes.failed);
    }
  }

  // 工具事件本身也入 claims，UI 能回答"它到底调了什么、成没成"。
  for (const call of calls.slice(0, MAX_TOOL_CLAIMS)) {
    claims.push({
      kind: "tool",
      text: truncate(call.summary ? `${call.name}: ${call.summary}` : call.name),
      evidence: { name: call.name, ok: call.ok },
    });
  }

  const reasons = [...mismatches];
  const seen = new Set(reasons);
  const pushReason = (reason) => {
    if (!reason || seen.has(reason)) return;
    seen.add(reason);
    reasons.push(reason);
  };
  for (const call of calls) if (!call.ok) pushReason(`tool_failed:${call.name}`);
  for (const call of successes) pushReason(`tool_ok:${call.name}`);
  if (!calls.length) pushReason("no_tool_calls");
  else if (!successes.length) pushReason("no_successful_tool_call");
  if (calls.length > MAX_TOOL_CLAIMS) pushReason(`tool_claims_truncated:${calls.length - MAX_TOOL_CLAIMS}`);

  let status = "prepared";
  if (mismatches.length) status = "mismatch";
  else if (successes.length) status = "observed";

  return { status, claims, reasons };
}

/* ------------------------------------------------------------------ storage */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ev_records(
  room_id TEXT NOT NULL, message_seq INTEGER NOT NULL, bot_id TEXT,
  status TEXT NOT NULL, claims_json TEXT NOT NULL DEFAULT '[]', ts TEXT NOT NULL,
  PRIMARY KEY(room_id, message_seq)
);
CREATE INDEX IF NOT EXISTS idx_ev_records_room_status ON ev_records(room_id, status);
`;

const UPSERT = `
INSERT INTO ev_records(room_id, message_seq, bot_id, status, claims_json, ts)
VALUES(?,?,?,?,?,?)
ON CONFLICT(room_id, message_seq) DO UPDATE SET
  bot_id = excluded.bot_id,
  status = excluded.status,
  claims_json = excluded.claims_json,
  ts = excluded.ts
`;

/** claims_json 存 `{ claims, reasons }`；数组形态（早期/手写数据）也能读。 */
function parseClaimsJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value ?? ""));
  } catch {
    return { claims: [], reasons: [] };
  }
  if (Array.isArray(parsed)) return { claims: parsed, reasons: [] };
  return {
    claims: Array.isArray(parsed?.claims) ? parsed.claims : [],
    reasons: Array.isArray(parsed?.reasons) ? parsed.reasons.map(String) : [],
  };
}

function requireRoomId(roomId) {
  const room = String(roomId ?? "").trim();
  if (!room) throw new Error("evidence 需要非空 roomId");
  return room;
}

function requireSeq(messageSeq) {
  const seq = Number(messageSeq);
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`evidence 需要非负整数 messageSeq（收到 ${JSON.stringify(messageSeq)}）`);
  }
  return seq;
}

function clampLimit(limit) {
  const value = Math.trunc(Number(limit));
  if (!Number.isFinite(value) || value <= 0) return 50;
  return Math.min(500, value);
}

/**
 * 证据记录工厂（CONTRACT.md §7.2）：自建表 `ev_records`，`(room_id, message_seq)` 唯一，
 * 重复 record 幂等覆盖。不调 LLM、不发事件。
 */
export function createEvidence({ store, now = () => Date.now() } = {}) {
  if (!store || !store.db || typeof store.prepare !== "function") {
    throw new Error("createEvidence 需要 store（node:sqlite DatabaseSync 实例）");
  }
  store.db.exec(SCHEMA);

  const summaryByRoom = store.prepare(
    "SELECT status, COUNT(*) AS n FROM ev_records WHERE room_id = ? GROUP BY status",
  );
  const summaryAll = store.prepare("SELECT status, COUNT(*) AS n FROM ev_records GROUP BY status");

  function timestamp() {
    const value = now();
    const ms = value instanceof Date ? value.getTime() : Number(value);
    return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
  }

  /** 调用方漏传 knownFileIds 时的兜底：以本群当前文件空间为准，避免把真文件误判成 mismatch。 */
  function roomFileIds(roomId) {
    try {
      const files = store.listRoomFiles?.(roomId) || [];
      return files.map((file) => file?.file_id).filter(Boolean);
    } catch (err) {
      log.warn("listRoomFiles failed; file_id 校验退化为调用方传入", err?.message || err);
      return [];
    }
  }

  function rowToRecord(row) {
    const { claims, reasons } = parseClaimsJson(row.claims_json);
    return {
      room_id: row.room_id,
      message_seq: Number(row.message_seq),
      bot_id: row.bot_id ?? null,
      status: row.status,
      claims,
      reasons,
      ts: row.ts,
    };
  }

  /**
   * 记录一个成员回合的判定（幂等）；返回归一化记录（含 claims/reasons）。
   * @param {{roomId:string, botId?:string|null, messageSeq:number, text?:string,
   *          toolCalls?:Array<{name:string, ok:boolean, summary?:string}>, knownFileIds?:Iterable<string>}} input
   */
  function record({ roomId, botId = null, messageSeq, text = "", toolCalls = [], knownFileIds } = {}) {
    const room = requireRoomId(roomId);
    const seq = requireSeq(messageSeq);
    const known = knownFileIds === undefined || knownFileIds === null ? roomFileIds(room) : knownFileIds;
    const verdict = classifyClaims({ text, toolCalls, knownFileIds: known });
    const ts = timestamp();
    const claimsJson = JSON.stringify({ claims: verdict.claims, reasons: verdict.reasons });
    store
      .prepare(UPSERT)
      .run(room, seq, botId === null || botId === undefined ? null : String(botId), verdict.status, claimsJson, ts);
    log.debug(`evidence ${room}#${seq} ${verdict.status}`);
    return {
      room_id: room,
      message_seq: seq,
      bot_id: botId === null || botId === undefined ? null : String(botId),
      status: verdict.status,
      claims: verdict.claims,
      reasons: verdict.reasons,
      ts,
    };
  }

  /** 取单个回合的证据；不存在返回 null。 */
  function get({ roomId, messageSeq } = {}) {
    const room = requireRoomId(roomId);
    const seq = requireSeq(messageSeq);
    const row = store
      .prepare("SELECT * FROM ev_records WHERE room_id = ? AND message_seq = ?")
      .get(room, seq);
    return row ? rowToRecord(row) : null;
  }

  /** 列证据记录：最近 N 条、按 message_seq 升序；省略 roomId 时跨房间按 ts 取最近 N 条。 */
  function list({ roomId, limit = 50 } = {}) {
    const size = clampLimit(limit);
    const rows = roomId === null || roomId === undefined
      ? store
          .prepare("SELECT * FROM ev_records ORDER BY ts DESC, rowid DESC LIMIT ?")
          .all(size)
      : store
          .prepare("SELECT * FROM ev_records WHERE room_id = ? ORDER BY message_seq DESC LIMIT ?")
          .all(requireRoomId(roomId), size);
    return rows.reverse().map(rowToRecord);
  }

  /** 三态计数：`total` = observed + prepared + mismatch（空分母报 0 而不是假装有结论，见 doc §4）。 */
  function summary({ roomId } = {}) {
    const rows =
      roomId === null || roomId === undefined ? summaryAll.all() : summaryByRoom.all(requireRoomId(roomId));
    const counts = { observed: 0, prepared: 0, mismatch: 0 };
    for (const row of rows) {
      if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.n || 0);
    }
    return { ...counts, total: counts.observed + counts.prepared + counts.mismatch };
  }

  return { record, get, list, summary };
}

export default createEvidence;
