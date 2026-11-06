/**
 * 群聊上下文装配：水位（watermark）+ 确定性摘要（digest）+ 字符预算。
 *
 * 为什么需要它：`room.js` 每轮把 `renderTranscript()` 的结果（≤12000 字符）重新拼进
 * **同一条持久 pi 会话**。同一会话里前几轮的内容本来就已经在上下文里，于是第 N 轮
 * 重复 N-1 轮的量，成本近似 O(N²)；而 pi 的自动压缩按 token 触发
 * （`docs/compaction.md:29-35`，默认 `reserveTokens=16384`），永远追不上这份人工注入量。
 *
 * 这里只做三件事，全部确定性、无 LLM、无网络、无新依赖：
 *   1. `digestText()` 把"房间长期状态"压成一段稳定摘要（主题 → 最近结论 → 文件清单 → 未决分派）；
 *   2. `deltaFor()` 只取水位之后的新发言，水位持久化在 store 的 kv
 *      （`ctx:wm:<roomId>:<botId>` = 已被注入过的最大 seq）；
 *   3. `compose()` 把 digest + delta 拼成一段受 `budget` 约束的注入文本：超预算时
 *      **从旧到新整条丢弃**并标注「（已省略 N 条更早发言）」，单条超长按 budget 的 1/3 截断。
 *
 * 与契约的关系：`docs/hermes/CONTRACT.md:187-204` 定义了对外签名，本文件逐字实现。
 * 幂等语义：`compose` 自身会前进水位（第二次 compose 的 delta 为空，只剩 digest），
 * 因此同一成员在同一房间里不会重复消费同一条发言；`markInjected` 是单调不减的显式确认入口。
 */
import { createLogger } from "../log.js";

const log = createLogger("context");

/** 水位键前缀；完整键见 `_key()`（契约 §7.1）。 */
export const WM_KEY_PREFIX = "ctx:wm";

/** 上下文档位（对齐 `room.js` 的 effectiveContextLevel）。 */
export const LEVELS = ["none", "summary", "full"];

export const DEFAULT_DELTA_LIMIT = 200;
/** 首次 compose（无水位）时退化的条数。 */
export const FIRST_FULL_RECENT = 30;
/** summary 档固定展示的最近条数。 */
export const SUMMARY_RECENT = 4;
export const DIGEST_MAX_CHARS = 1600;
/** digest 内部扫描的尾部窗口（够覆盖"最近 3 条结论"与未决分派）。 */
export const DIGEST_SCAN = 100;
export const CONCLUSION_COUNT = 3;
export const CONCLUSION_CHARS = 120;
export const FILE_LIMIT = 20;
export const ASSIGN_LIMIT = 5;
export const ASSIGN_SCAN = 50;

const DELTA_HEADER = "=== 自上次注入以来的新发言 ===";
const DIGEST_CUT_MARK = "…（摘要超出预算，已截断）";

/* --------------------------------------------------------------- 纯工具 */

function requireBotId(botId) {
  const id = String(botId ?? "").trim();
  if (!id) throw new Error("需要非空 botId");
  return id;
}

/** 只接受非负整数 seq；其它输入（旧版本写入的对象等）一律按 0 处理。 */
function asSeq(value) {
  if (value && typeof value === "object" && "seq" in value) return asSeq(value.seq);
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 按字符（不是字节）截断，用于中文安全。 */
function clip(text, max, mark = "…") {
  const s = String(text ?? "");
  const limit = Math.max(0, Math.floor(max));
  if (limit <= 0) return "";
  if (s.length <= limit) return s;
  if (limit <= mark.length) return s.slice(0, limit);
  return s.slice(0, limit - mark.length) + mark;
}

function oneLine(text) {
  return String(text ?? "").replace(/\s*\r?\n+\s*/g, " ").trim();
}

function baseName(relPath) {
  const parts = String(relPath ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/** 一条发言 → 一行注入文本；超过 cap 时截断并标注原文长度。 */
function formatLine(record, cap) {
  const head = `[${record.speaker || "?"}] `;
  const body = String(record.content ?? "").replace(/\s+$/u, "");
  const full = `${head}${body}`;
  if (full.length <= cap) return full;
  const note = `…（已截断，原文 ${full.length} 字）`;
  if (cap <= note.length + head.length) return full.slice(0, Math.max(1, cap));
  return full.slice(0, cap - note.length) + note;
}

const ASSIGN_ZH_RE = /(?:分派给|分配给|指派给)\s*([A-Za-z0-9_.\-\u4e00-\u9fff]+)\s*[：:]\s*([^\n]{1,200})/;
const ASSIGN_MEMBER_RE = /(?:member|成员|to)\s*["']?\s*[:=：]\s*["']?([A-Za-z0-9_.\-\u4e00-\u9fff]+)/;
const ASSIGN_TASK_RE = /(?:task|任务)\s*["']?\s*[:=：]\s*["']?([^\n"']{1,200})/;

/**
 * 从一条发言里识别 `room_assign_task` 形态的分派记录。
 * 两种真实形态：工具调用文本 `{"member":"coder","task":"…"}`，以及工具回执
 * `已把任务分派给 coder：…`（见 `src/rooms/tools.js:70-81`）。识别不到返回 null。
 */
export function extractAssignment(text) {
  const raw = String(text ?? "");
  if (!raw) return null;
  const zh = raw.match(ASSIGN_ZH_RE);
  if (zh) return { member: zh[1], task: zh[2].trim() };
  if (!raw.includes("room_assign_task")) return null;
  const member = raw.match(ASSIGN_MEMBER_RE);
  const task = raw.match(ASSIGN_TASK_RE);
  if (!member || !task) return null;
  return { member: member[1], task: task[1].trim() };
}

/* ------------------------------------------------------------------ 主体 */

class RoomContext {
  constructor({ store, roomId, now }) {
    this.store = store;
    this.roomId = String(roomId);
    this.now = typeof now === "function" ? now : () => Date.now();
    /** @type {Map<string, number>} botId → 已注入的最大 seq（KV 的进程内缓存） */
    this._wm = new Map();
  }

  /* ------------------------------------------------------------- 水位 */

  _key(botId) {
    return `${WM_KEY_PREFIX}:${this.roomId}:${botId}`;
  }

  watermark(botId) {
    const id = requireBotId(botId);
    if (!this._wm.has(id)) {
      let stored = 0;
      try {
        stored = asSeq(this.store.getKV(this._key(id), 0));
      } catch (err) {
        log.warn("水位读取失败，按 0 处理", this.roomId, id, err?.message || err);
      }
      this._wm.set(id, stored);
    }
    return this._wm.get(id);
  }

  markInjected(botId, seq) {
    const id = requireBotId(botId);
    const n = Number(seq);
    if (!Number.isFinite(n) || n < 0) throw new Error(`markInjected 需要非负 seq：${seq}`);
    this._advance(id, Math.floor(n));
    return { ok: true };
  }

  /** 水位只前进（防止回滚导致重复消费）。 */
  _advance(botId, seq) {
    const next = Math.max(this.watermark(botId), Math.max(0, Math.floor(Number(seq) || 0)));
    if (next === this.watermark(botId)) return next;
    this._wm.set(botId, next);
    try {
      this.store.setKV(this._key(botId), next);
    } catch (err) {
      log.warn("水位持久化失败（本次仍生效）", new Date(this.now()).toISOString(), botId, err?.message || err);
    }
    return next;
  }

  /* ----------------------------------------------------------- 数据读取 */

  _messages(limit) {
    try {
      return this.store.listRoomMessages(this.roomId, limit) || [];
    } catch (err) {
      log.warn("读取群消息失败", this.roomId, err?.message || err);
      return [];
    }
  }

  _room() {
    try {
      return this.store.getRoom(this.roomId) || null;
    } catch (err) {
      log.warn("读取房间失败", this.roomId, err?.message || err);
      return null;
    }
  }

  _files() {
    try {
      return this.store.listRoomFiles(this.roomId) || [];
    } catch (err) {
      log.warn("读取群文件失败", this.roomId, err?.message || err);
      return [];
    }
  }

  /* --------------------------------------------------------------- 增量 */

  deltaFor(botId, { limit = DEFAULT_DELTA_LIMIT } = {}) {
    const id = requireBotId(botId);
    const watermark = this.watermark(id);
    const rows = this._messages(limit);
    return rows
      .filter((m) => Number(m.seq) > watermark)
      .map((m) => ({
        seq: Number(m.seq),
        speaker: m.speaker,
        content: m.content,
        kind: m.kind,
        ts: m.ts,
      }));
  }

  /**
   * 内部：一次读取尾部窗口，返回水位之后的发言 + 两个边界事实。
   * `gapBefore` 是"水位之后、读取窗口之前"被跳过的条数（seq 连续，差值即条数）。
   */
  _pending(botId, limit) {
    const watermark = this.watermark(botId);
    const rows = this._messages(limit).filter((m) => Number(m.seq) > watermark);
    const maxSeq = rows.length ? Number(rows[rows.length - 1].seq) : watermark;
    const gapBefore = rows.length ? Math.max(0, Number(rows[0].seq) - watermark - 1) : 0;
    return { rows, maxSeq, gapBefore, watermark };
  }

  /* --------------------------------------------------------------- 摘要 */

  _conclusions() {
    return this._messages(DIGEST_SCAN)
      .filter((m) => String(m.speaker || "") !== "user" && String(m.content || "").trim())
      .slice(-CONCLUSION_COUNT)
      .map((m) => `- ${m.speaker}：${clip(oneLine(m.content), CONCLUSION_CHARS, "…")}`);
  }

  _fileLines() {
    return this._files()
      .slice(-FILE_LIMIT)
      .map((f) => `- file_id ${f.file_id}：${baseName(f.path) || f.path || "（未命名）"}`);
  }

  _assignmentLines() {
    const found = [];
    const seen = new Set();
    const rows = this._messages(DIGEST_SCAN).slice(-ASSIGN_SCAN);
    for (let i = rows.length - 1; i >= 0 && found.length < ASSIGN_LIMIT; i -= 1) {
      const hit = extractAssignment(rows[i].content);
      if (!hit) continue;
      const key = `${hit.member}\u0000${hit.task}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(`- → ${hit.member}：${clip(oneLine(hit.task), CONCLUSION_CHARS, "…")}`);
    }
    return found.reverse();
  }

  /**
   * 确定性摘要：同输入必同输出（刻意不含任何时间戳）。
   * 内容优先级：群主题 → 最近 3 条成员结论 → 群文件清单 → 未决分派。
   */
  digestText({ maxChars = DIGEST_MAX_CHARS } = {}) {
    const budget = Math.max(1, Math.floor(Number(maxChars) || DIGEST_MAX_CHARS));
    const room = this._room();
    const title = String(room?.title || "").trim();
    const sections = [];
    const topic = String(room?.topic || "").trim();
    if (topic) sections.push(`【群主题】${oneLine(topic)}`);
    const conclusions = this._conclusions();
    if (conclusions.length) sections.push(["【最近成员结论】", ...conclusions].join("\n"));
    const files = this._fileLines();
    if (files.length) sections.push([`【群文件清单（${files.length} 条）】`, ...files].join("\n"));
    const assigns = this._assignmentLines();
    if (assigns.length) sections.push(["【未决分派（来自群聊记录，未必仍未完成）】", ...assigns].join("\n"));
    if (!sections.length) return "";

    const header = `=== 群上下文摘要（房间 ${this.roomId}${title ? `：${title}` : ""}） ===`;
    const kept = [];
    let used = header.length;
    let dropped = 0;
    // 严格按优先级：某一项装不下就停，后面的低优先级项不再插队。
    for (const section of sections) {
      if (used + section.length + 1 > budget) {
        dropped = sections.length - kept.length;
        break;
      }
      kept.push(section);
      used += section.length + 1;
    }
    if (!kept.length) return clip(header, budget, DIGEST_CUT_MARK);
    if (dropped > 0) {
      const note = `…（另有 ${dropped} 项摘要因预算省略）`;
      if (used + note.length + 1 <= budget) kept.push(note);
    }
    const text = [header, ...kept].join("\n");
    return text.length <= budget ? text : clip(text, budget, DIGEST_CUT_MARK);
  }

  /* --------------------------------------------------------------- 装配 */

  /**
   * @param {string} botId
   * @param {{level?: "none"|"summary"|"full", roundMessage?: string, budget?: number}} [options]
   * @returns {{text: string, stats: {digestChars:number, deltaCount:number, totalChars:number,
   *   trimmed:number, throughSeq:number, firstSeq:number}}}
   * `throughSeq` = 本次**真正注入给模型**的最大 seq（被预算裁掉的旧消息不算，Lead 据此调
   * `markInjected` 才不会误标已读）；`firstSeq` = 本次注入的最小 seq（0 = 没有逐条发言）。
   * 两者是 Lead 集成时追加的向后兼容字段（契约 §7.1 原有四字段不变）。
   */
  compose(botId, { level = "full", roundMessage = "", budget = 6000 } = {}) {
    const id = requireBotId(botId);
    const tier = String(level ?? "full");
    if (!LEVELS.includes(tier)) throw new Error(`非法上下文档位：${level}`);
    const cap = Math.max(120, Math.floor(Number(budget) || 6000));
    const round = String(roundMessage ?? "").trim();
    const zeroStats = { digestChars: 0, deltaCount: 0, totalChars: 0, trimmed: 0, throughSeq: 0, firstSeq: 0 };
    if (tier === "none") return { text: "", stats: { ...zeroStats } };

    let rows;
    let dropped = 0;
    if (tier === "summary") {
      // summary 只看固定窗口，不消费水位（受限成员随时可被提回 full）。
      rows = this._messages(Math.max(SUMMARY_RECENT, 50)).slice(-SUMMARY_RECENT);
    } else {
      const watermark = this.watermark(id);
      if (!watermark) {
        // 首次没有水位：退化为最近 N 条，并把窗口前的部分计入省略。
        rows = this._messages(DEFAULT_DELTA_LIMIT).slice(-FIRST_FULL_RECENT);
        dropped = rows.length ? Math.max(0, Number(rows[0].seq) - 1) : 0;
      } else {
        const pending = this._pending(id, DEFAULT_DELTA_LIMIT);
        rows = pending.rows;
        dropped = pending.gapBefore;
      }
    }

    // 本轮消息已经单独成段，别在 delta 里重复一遍（它通常已落库为最后一条 user 发言）。
    const delta = rows.slice();
    let carriedSeq = 0; // 被去重、但已作为「本轮消息」注入的那条 seq
    if (round && delta.length) {
      const last = delta[delta.length - 1];
      if (
        String(last.content ?? "").trim() === round &&
        (String(last.kind ?? "") === "user" || String(last.speaker ?? "") === "user")
      ) {
        carriedSeq = Number(last.seq) || 0;
        delta.pop();
      }
    }

    const roundBlock = round ? `=== 本轮消息 ===\n${round}` : "";
    let used = roundBlock ? roundBlock.length + 2 : 0;
    let contextBudget = Math.max(0, cap - used);

    const digestCap = Math.max(0, Math.min(DIGEST_MAX_CHARS, contextBudget, Math.floor(cap / 3)));
    let digestBlock = digestCap > 0 ? this.digestText({ maxChars: digestCap }) : "";
    if (digestBlock.length > contextBudget) digestBlock = clip(digestBlock, contextBudget, DIGEST_CUT_MARK);
    used += digestBlock ? digestBlock.length + 2 : 0;
    contextBudget = Math.max(0, cap - used);

    const singleCap = Math.max(40, Math.floor(cap / 3));
    const lines = delta.map((record) => formatLine(record, singleCap));
    /** @type {Array<{line: string, seq: number}>} */
    const kept = [];
    let deltaUsed = 0;
    // 从新到旧整条收入；遇到装不下的就停（= 从旧到新整条丢弃）。
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const cost = lines[i].length + 1;
      if (deltaUsed + cost + DELTA_HEADER.length + 1 > contextBudget) {
        dropped += i + 1;
        break;
      }
      kept.unshift({ line: lines[i], seq: Number(delta[i].seq) || 0 });
      deltaUsed += cost;
    }
    let marker = dropped > 0 ? `（已省略 ${dropped} 条更早发言）` : "";
    // 标注本身也要占预算：装不下就先再丢最旧的一条（丢到能装下为止）。
    const markerFits = () =>
      deltaUsed + (marker ? marker.length + 1 : 0) + (kept.length ? DELTA_HEADER.length + 1 : 0) <= contextBudget;
    while (marker && !markerFits() && kept.length) {
      const removed = kept.shift();
      deltaUsed -= removed.line.length + 1;
      dropped += 1;
      marker = `（已省略 ${dropped} 条更早发言）`;
    }
    if (marker && !markerFits()) marker = "";

    const keptLines = kept.map((item) => item.line);
    const deltaParts = [];
    if (keptLines.length) deltaParts.push(DELTA_HEADER);
    if (marker) deltaParts.push(marker);
    deltaParts.push(...keptLines);
    const deltaBlock = deltaParts.join("\n");

    // 真正注入给模型的 seq：逐条保留下来的 + 被去重但已作为「本轮消息」注入的那条。
    const injectedSeqs = kept.map((item) => item.seq).filter((n) => n > 0);
    if (carriedSeq > 0) injectedSeqs.push(carriedSeq);
    const firstSeq = injectedSeqs.length ? Math.min(...injectedSeqs) : 0;
    // summary 不消费水位 → throughSeq 恒为 0，Lead 据此跳过 markInjected；
    // 什么都没注入时回落成当前水位（markInjected 变成幂等空操作，不会误吃新消息）。
    const throughSeq = tier === "summary" ? 0 : Math.max(0, ...injectedSeqs) || this.watermark(id);

    const text = [digestBlock, deltaBlock, roundBlock].filter(Boolean).join("\n\n");
    if (tier === "full" && throughSeq > 0) this._advance(id, throughSeq);

    return {
      text,
      stats: {
        digestChars: digestBlock.length,
        deltaCount: kept.length,
        totalChars: text.length,
        trimmed: dropped,
        throughSeq,
        firstSeq,
      },
    };
  }

  /* --------------------------------------------------------------- 统计 */

  _knownBots() {
    const ids = new Set();
    // 只统计"有水位"（>0）的成员：读到过 0 只是缓存，不算被注入过。
    for (const [id, seq] of this._wm) if (seq > 0) ids.add(id);
    try {
      const prefix = `${WM_KEY_PREFIX}:${this.roomId}:`;
      const rows = this.store.db?.prepare("SELECT k FROM kv").all() || [];
      for (const row of rows) {
        const key = String(row.k ?? "");
        if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
      }
    } catch (err) {
      log.warn("统计水位成员失败，只报进程内已知", this.roomId, err?.message || err);
    }
    return [...ids];
  }

  stats() {
    const digest = this.digestText();
    return { bots: this._knownBots().length, digestChars: digest.length, messages: this._messages(0).length };
  }
}

export function createRoomContext({ store, roomId, now = () => Date.now() } = {}) {
  if (!store) throw new Error("createRoomContext 需要 { store }");
  if (typeof store.listRoomMessages !== "function") throw new Error("store 缺少 listRoomMessages(roomId, limit)");
  if (typeof store.getKV !== "function" || typeof store.setKV !== "function") {
    throw new Error("store 缺少 getKV/setKV，水位无法持久化");
  }
  if (!roomId) throw new Error("createRoomContext 需要 { roomId }");
  return new RoomContext({ store, roomId: String(roomId), now });
}

export default createRoomContext;
