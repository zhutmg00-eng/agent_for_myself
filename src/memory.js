/**
 * 持久记忆（memory）—— 把 Hermes 的跨会话记忆内核移植到群聊工作台。
 *
 * 为什么：群聊里每个成员每回合都要重新认识世界。Hermes 把"跨会话仍然成立的事实"分成两个小库
 * （memory = 世界/项目事实，user = 用户画像），每回合注入提示，模型通过带写入闸门与审计的
 * memory 工具增量维护（docs/hermes/MEMORY.md §1）。这里只取内核：mem_entries（条目）+
 * mem_fts（FTS5 外部内容表）+ mem_audit（留痕）。
 *
 * 关键取舍（§4）：FTS5 的 unicode61 把一整段连续汉字切成一个 token，中文子串几乎必然零命中
 * （Hermes 为此内置 cjk_unicode61 扩展，hermes_state_fts.py:34-40）；我们无扩展可用，于是照它的
 * 路由——FTS 优先，零命中退化为 LIKE 子串 + 2 字二元组打分（hermes_state_search.py:1117 / 143-151）。
 * 全模块纯确定性：不调 LLM、不联网、不写文件。
 */
import { createLogger } from "./log.js";
import { makeId } from "./store.js";

const log = createLogger("memory");

/** 归属维度：房间共享 / 单个机器人私有 / 全局（整个世界与项目）。 */
export const SCOPES = ["room", "bot", "global"];
/** 记忆目标：memory = 世界与项目事实；user = 用户偏好画像（对应 Hermes 的 MEMORY.md / USER.md）。 */
export const TARGETS = ["memory", "user"];
export const DEFAULT_HALF_LIFE_DAYS = 30;
export const MAX_ENTRY_CHARS = 4000;
export const DEFAULT_BUDGET_CHARS = 2000;

const DAY_MS = 86_400_000;
const SCAN_LIMIT = 500; // 候选上限：先粗筛，再在 JS 里精排
const FTS_TOKEN_LIMIT = 8;
const MAX_TAGS = 20;
const MAX_LINE_CHARS = 500; // contextBlock 单条渲染上限，避免一条长记忆吃掉整个预算
const NOTE_RESERVE = 48; // 给"已截断 N 条"预留的空间
const FTS_MARKER_KEY = "mem:fts_rebuilt:v1";
// CJK（汉字 + 假名 + 韩文音节）没有空格分词，必须走二元组；ASCII 标点视为分隔符。
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const ASCII_PUNCT_RE = /[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]/g;
const CJK_PUNCT_RE = /[，。、；：！？…—·“”‘’（）《》【】〈〉〔〕「」『』]/g;
const SCOPE_LABELS = { room: "房间", bot: "机器人", global: "全局" };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mem_entries(
  seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, room_id TEXT, bot_id TEXT,
  target TEXT NOT NULL DEFAULT 'memory', content TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'agent', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_mem_owner ON mem_entries(scope, room_id, bot_id, target);
CREATE INDEX IF NOT EXISTS idx_mem_updated ON mem_entries(updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
  content, content='mem_entries', content_rowid='seq', tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS mem_audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT, action TEXT NOT NULL, scope TEXT, room_id TEXT, bot_id TEXT,
  target TEXT, source TEXT NOT NULL DEFAULT 'agent', reason TEXT, detail_json TEXT, ts TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS mem_entries_ai AFTER INSERT ON mem_entries BEGIN
  INSERT INTO mem_fts(rowid, content) VALUES (new.seq, new.content); END;
CREATE TRIGGER IF NOT EXISTS mem_entries_ad AFTER DELETE ON mem_entries BEGIN
  INSERT INTO mem_fts(mem_fts, rowid, content) VALUES ('delete', old.seq, old.content); END;
CREATE TRIGGER IF NOT EXISTS mem_entries_au AFTER UPDATE OF content ON mem_entries BEGIN
  INSERT INTO mem_fts(mem_fts, rowid, content) VALUES ('delete', old.seq, old.content);
  INSERT INTO mem_fts(rowid, content) VALUES (new.seq, new.content); END;
`;

/* ------------------------------------------------------------------ helpers */

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

const clamp01 = (n) => (!Number.isFinite(n) ? 0 : n < 0 ? 0 : n > 1 ? 1 : n);
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const hasCjk = (text) => CJK_RE.test(String(text ?? ""));
const words = (text) => new Set(String(text ?? "").split(" ").filter((t) => t.length > 1));
const escapeLike = (term) => String(term).replace(/[\\%_]/g, (m) => `\\${m}`);

/** 匹配用的归一化：小写、标点当空格、空白折叠（同 Hermes `_normalize_for_match`，memory_tool_store.py:80-85）。 */
function normalizeText(text) {
  return String(text ?? "").toLowerCase().replace(CJK_PUNCT_RE, " ")
    .replace(ASCII_PUNCT_RE, " ").replace(/\s+/g, " ").trim();
}

function bigrams(text) {
  const out = new Set();
  const s = String(text ?? "");
  for (let i = 0; i + 1 < s.length; i += 1) {
    const g = s.slice(i, i + 2);
    if (g.trim()) out.add(g);
  }
  return out;
}

function overlap(source, target) {
  let hit = 0;
  for (const item of source) if (target.has(item)) hit += 1;
  return hit;
}

/**
 * 0..1 相似度：字面相等 1；包含关系且短的一半以上被包含也算同一条（追加事实 = 超集更新）；
 * 否则取 bigram Dice 与词 Jaccard 的较大值（中文走 Dice，英文走词）。
 */
function similarity(a, b) {
  const x = normalizeText(a), y = normalizeText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  if (long.includes(short) && short.length / long.length >= 0.5) return 1;
  const bx = bigrams(x), by = bigrams(y);
  const dice = (2 * overlap(bx, by)) / (bx.size + by.size || 1);
  const wx = words(x), wy = words(y);
  const shared = overlap(wx, wy);
  const jaccard = wx.size && wy.size ? shared / (wx.size + wy.size - shared) : 0;
  return Math.max(dice, jaccard);
}

/** 相关度：整串子串命中满分；否则按二元组/词覆盖率打折，中英文可比。 */
function textRelevance(query, content) {
  const q = normalizeText(query), c = normalizeText(content);
  if (!q || !c) return 0;
  if (c.includes(q)) return 1;
  const qb = bigrams(q);
  if (!qb.size) return 0; // 单字/单词只认子串，避免把整条记忆当命中
  const cover = overlap(qb, bigrams(c)) / qb.size;
  const qw = words(q), cw = words(c);
  const wordCover = qw.size ? overlap(qw, cw) / qw.size : 0;
  return clamp01(Math.max(cover, wordCover) * 0.9);
}

/** FTS5 MATCH 串：逐词加引号（特殊字符在归一化时已清掉），ASCII 词加前缀星。 */
function toFtsQuery(query) {
  const cleaned = normalizeText(query);
  if (!cleaned) return null;
  const tokens = cleaned.split(" ").filter(Boolean).slice(0, FTS_TOKEN_LIMIT);
  return tokens.length ? tokens.map((t) => (/^[a-z0-9_]/.test(t) ? `"${t}"*` : `"${t}"`)).join(" AND ") : null;
}

/** LIKE 退化路径的检索词：整串 + 二元组 + ASCII 词，长的优先，最多 6 个（OR 关系）。 */
function likeTerms(query) {
  const cleaned = normalizeText(query);
  if (!cleaned) return [];
  const terms = new Set([cleaned]);
  for (const token of cleaned.split(" ")) {
    if (token.length >= 2) terms.add(token);
    if (hasCjk(token) && token.length >= 2) {
      for (let i = 0; i + 2 <= token.length; i += 1) terms.add(token.slice(i, i + 2));
    }
  }
  return [...terms].sort((a, b) => b.length - a.length).slice(0, 6);
}

function normTags(tags) {
  const out = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw ?? "").trim().slice(0, 48);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, MAX_TAGS);
}

function normLimit(limit, fallback = 100, max = 500) {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

function oneLine(content) {
  const text = String(content ?? "").replace(/\s+/g, " ").trim();
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
}

/* ------------------------------------------------------------------ factory */

/**
 * @param {{store:object, now?:()=>number, halfLifeDays?:number, pinnedBonus?:number,
 *          decayWeight?:number, dedupeThreshold?:number, log?:object}} options
 * @returns {object} Memory（接口见 docs/hermes/CONTRACT.md §3.4）
 */
export function createMemory({
  store, now = () => Date.now(), halfLifeDays = DEFAULT_HALF_LIFE_DAYS, pinnedBonus = 0.25,
  decayWeight = 0.15, dedupeThreshold = 0.85, log: logger = log,
} = {}) {
  if (!store || !store.db || typeof store.db.prepare !== "function") {
    throw new Error("createMemory 需要 { store }（src/store.js 的 Store 实例）");
  }
  const db = store.db;
  db.exec(SCHEMA); // 自建表/索引/触发器（不改 store.js）

  const halfLife = Number(halfLifeDays) > 0 ? Number(halfLifeDays) : DEFAULT_HALF_LIFE_DAYS;
  const pinBonus = Number.isFinite(Number(pinnedBonus)) ? Number(pinnedBonus) : 0.25;
  const decayW = Number.isFinite(Number(decayWeight)) ? Number(decayWeight) : 0.15;
  const dedupeMin = Number.isFinite(Number(dedupeThreshold)) ? clamp01(Number(dedupeThreshold)) : 0.85;
  const q = (sql) => (typeof store.prepare === "function" ? store.prepare(sql) : db.prepare(sql));

  function nowMs() {
    const v = typeof now === "function" ? now() : Date.now();
    const ms = v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : Number(v);
    return Number.isFinite(ms) ? ms : Date.now();
  }
  const isoNow = () => new Date(nowMs()).toISOString();
  const normSource = (source) => String(source || "agent").slice(0, 64);
  const getRow = (id) => q("SELECT * FROM mem_entries WHERE id = ?").get(String(id)) || null;
  const entryOf = (r) => ({
    id: r.id, scope: r.scope, roomId: r.room_id, botId: r.bot_id, target: r.target, content: r.content,
    tags: parseJson(r.tags_json, []), pinned: Number(r.pinned) === 1, source: r.source,
    createdAt: r.created_at, updatedAt: r.updated_at,
  });

  /** FTS 是外部内容表：老库/被外部改过的库可能没有索引，首次打开时重建一次（本地 kv 记标记）。 */
  function ensureFts() {
    const hasKv = typeof store.getKV === "function" && typeof store.setKV === "function";
    if (hasKv && store.getKV(FTS_MARKER_KEY) === "1") return false;
    rebuildFts();
    if (hasKv) store.setKV(FTS_MARKER_KEY, "1");
    logger.debug("mem_fts 已重建（首次打开）");
    return true;
  }

  function rebuildFts() {
    db.exec("INSERT INTO mem_fts(mem_fts) VALUES('rebuild')");
    return { ok: true };
  }

  function writeAudit(a) {
    const detail = a.detail ? JSON.stringify(a.detail).slice(0, 1200) : null;
    q(`INSERT INTO mem_audit(entry_id, action, scope, room_id, bot_id, target, source, reason, detail_json, ts)
       VALUES(?,?,?,?,?,?,?,?,?,?)`).run(a.entryId ?? null, String(a.action), a.scope ?? null, a.roomId ?? null,
      a.botId ?? null, a.target ?? null, normSource(a.source), a.reason ?? null, detail, a.ts || isoNow());
  }

  function assertScope(scope) {
    const s = String(scope);
    if (!SCOPES.includes(s)) throw new Error(`非法记忆作用域：${s}（可用：${SCOPES.join("/")}）`);
    return s;
  }

  function normTarget(target) {
    const t = String(target ?? "memory");
    if (!TARGETS.includes(t)) throw new Error(`非法记忆目标：${t}（可用：${TARGETS.join("/")}）`);
    return t;
  }

  /** 作用域决定归属维度：room 只认 roomId，bot 只认 botId，global 都不认。 */
  function normScope({ scope, roomId, botId }) {
    const s = assertScope(scope ?? "room");
    if (s === "room") return { scope: s, roomId: String(roomId || "") || null, botId: null };
    if (s === "bot") return { scope: s, roomId: null, botId: String(botId || "") || null };
    return { scope: "global", roomId: null, botId: null };
  }

  function checkContent(content) {
    const text = String(content ?? "").trim();
    if (!text) throw new Error("记忆内容不能为空");
    if (text.length > MAX_ENTRY_CHARS) {
      throw new Error(`记忆内容过长：${text.length} 字符 > 上限 ${MAX_ENTRY_CHARS}，请拆成多条`);
    }
    return text;
  }

  /**
   * SQL 过滤条件。归属维度跟随 scope：global 忽略 roomId/botId（而不是过滤成空），room 只认
   * roomId、bot 只认 botId —— 调用方（房间工具/HTTP）习惯把三个参数一起传，这里负责归一。
   */
  function filters({ scope, roomId, botId, target }) {
    const s = scope === undefined || scope === null || scope === "" ? null : assertScope(scope);
    const cond = [];
    if (s) cond.push(["scope = ?", s]);
    if (target !== undefined && target !== null && target !== "") cond.push(["target = ?", normTarget(target)]);
    if (s !== "global" && s !== "bot" && roomId !== undefined && roomId !== null) {
      cond.push(["room_id = ?", String(roomId)]);
    }
    if (s !== "global" && s !== "room" && botId !== undefined && botId !== null) {
      cond.push(["bot_id = ?", String(botId)]);
    }
    return {
      where: cond.length ? ` WHERE ${cond.map(([sql]) => sql).join(" AND ")}` : "",
      params: cond.map(([, value]) => value),
    };
  }

  /* -------------------------------------------------------------- mutations */

  function save({
    scope = "room", roomId = null, botId = null, target = "memory", content, tags = [], pinned = false, source = "agent",
  } = {}) {
    const text = checkContent(content);
    const owner = normScope({ scope, roomId, botId });
    if (owner.scope === "room" && !owner.roomId) throw new Error("room 作用域的持久记忆需要 roomId");
    if (owner.scope === "bot" && !owner.botId) throw new Error("bot 作用域的持久记忆需要 botId");
    const tgt = normTarget(target);
    const tagList = normTags(tags);
    const ts = isoNow();

    // 去重只在同一归属（scope+room+bot+target）内比较，避免把两个房间的笔记合并。
    const rows = q(`SELECT * FROM mem_entries
      WHERE scope = ? AND target = ? AND IFNULL(room_id,'') = ? AND IFNULL(bot_id,'') = ?
      ORDER BY updated_at DESC, seq DESC LIMIT 200`)
      .all(owner.scope, tgt, owner.roomId || "", owner.botId || "");
    let best = null;
    for (const row of rows) {
      const sim = similarity(text, row.content);
      if (sim >= dedupeMin && (!best || sim > best.sim)) best = { row, sim };
    }
    if (best) {
      const before = best.row;
      const oldNorm = normalizeText(before.content), newNorm = normalizeText(text);
      // 新内容是老内容的超集（或仅排版不同）时才采用新文本，否则保留原文、只刷新时间。
      const adopt = newNorm === oldNorm || (newNorm.length > oldNorm.length && newNorm.includes(oldNorm));
      const nextContent = adopt ? text : before.content;
      const nextTags = normTags([...parseJson(before.tags_json, []), ...tagList]);
      const nextPinned = Number(before.pinned) === 1 || Boolean(pinned) ? 1 : 0;
      q("UPDATE mem_entries SET content = ?, tags_json = ?, pinned = ?, updated_at = ? WHERE id = ?")
        .run(nextContent, JSON.stringify(nextTags), nextPinned, ts, before.id);
      writeAudit({
        entryId: before.id, action: "dedupe", ...owner, target: tgt, source, ts,
        reason: `与已有记忆相似度 ${round6(best.sim)}，合并而非新增`,
        detail: { similarity: round6(best.sim), adoptedNewContent: nextContent !== before.content, tags: nextTags },
      });
      logger.info("memory deduped", before.id, round6(best.sim));
      return { ...entryOf(getRow(before.id)), deduped: true };
    }

    const id = makeId(8);
    q(`INSERT INTO mem_entries(id, scope, room_id, bot_id, target, content, tags_json, pinned, source, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, owner.scope, owner.roomId, owner.botId, tgt, text, JSON.stringify(tagList), pinned ? 1 : 0,
        normSource(source), ts, ts);
    writeAudit({ entryId: id, action: "save", ...owner, target: tgt, source, ts, detail: { pinned, chars: text.length } });
    return { ...entryOf(getRow(id)), deduped: false };
  }

  function replace(id, { content, tags, pinned, source = "agent" } = {}) {
    const row = getRow(id);
    if (!row) throw new Error(`记忆不存在：${id}`);
    const before = entryOf(row);
    const text = content === undefined ? before.content : checkContent(content);
    const tagList = tags === undefined ? before.tags : normTags(tags);
    const pin = pinned === undefined ? before.pinned : Boolean(pinned);
    const ts = isoNow();
    q("UPDATE mem_entries SET content = ?, tags_json = ?, pinned = ?, updated_at = ? WHERE id = ?")
      .run(text, JSON.stringify(tagList), pin ? 1 : 0, ts, before.id);
    writeAudit({
      entryId: before.id, action: "replace", scope: before.scope, roomId: before.roomId, botId: before.botId,
      target: before.target, source, reason: "显式替换记忆内容", ts,
      detail: { beforeChars: before.content.length, afterChars: text.length, pinned: pin },
    });
    return entryOf(getRow(before.id));
  }

  /** 删除是破坏性操作：source 与原因必须留痕（Hermes destructive_ops 语义，memory_tool.py:173-176）。 */
  function remove(id, { source = "agent", reason = null } = {}) {
    const row = getRow(id);
    if (!row) return { ok: false, removed: null, error: `记忆不存在：${id}` };
    const before = entryOf(row);
    const ts = isoNow();
    q("DELETE FROM mem_entries WHERE id = ?").run(before.id); // 触发器同步清 mem_fts
    writeAudit({
      entryId: before.id, action: "remove", scope: before.scope, roomId: before.roomId, botId: before.botId,
      target: before.target, source, reason: reason || "未提供删除原因", ts,
      detail: { chars: before.content.length, pinned: before.pinned, content: before.content.slice(0, 200) },
    });
    return { ok: true, removed: before };
  }

  /** 按作用域批量清理（房间/机器人被删掉时用）：逐条走 remove，保证每条都留审计。 */
  function clear({ scope, roomId, botId, source = "system", reason = null } = {}) {
    if (!scope) throw new Error("clear 需要显式 scope（room/bot/global），避免误清全部记忆");
    const entries = list({ scope, roomId, botId, limit: 500 });
    let removed = 0;
    for (const entry of entries) {
      if (remove(entry.id, { source, reason: reason || "作用域批量清理" }).ok) removed += 1;
    }
    return { ok: true, removed };
  }

  /* ------------------------------------------------------------- read paths */

  function get(id) {
    const row = getRow(id);
    return row ? entryOf(row) : null;
  }

  function list({ scope, roomId, botId, target, limit = 100 } = {}) {
    const { where, params } = filters({ scope, roomId, botId, target });
    return q(`SELECT * FROM mem_entries${where} ORDER BY pinned DESC, updated_at DESC, seq DESC LIMIT ?`)
      .all(...params, normLimit(limit, 100)).map(entryOf);
  }

  function scoreRow(row, query) {
    const entry = entryOf(row);
    const relevance = textRelevance(query, entry.content);
    const parsed = Date.parse(entry.updatedAt);
    const ageDays = Number.isFinite(parsed) ? Math.max(0, (nowMs() - parsed) / DAY_MS) : 0;
    const decay = Math.pow(0.5, ageDays / halfLife);
    return {
      entry, relevance, decay, seq: Number(row.seq) || 0,
      score: round6(relevance + (entry.pinned ? pinBonus : 0) + decayW * decay),
    };
  }

  function ftsRows(query, base) {
    const match = toFtsQuery(query);
    if (!match) return [];
    const where = base.where ? `${base.where} AND mem_fts MATCH ?` : " WHERE mem_fts MATCH ?";
    return q(`SELECT e.* FROM mem_fts JOIN mem_entries e ON e.seq = mem_fts.rowid${where}
      ORDER BY mem_fts.rank LIMIT ?`).all(...base.params, match, SCAN_LIMIT);
  }

  function likeRows(query, base) {
    const terms = likeTerms(query);
    if (!terms.length) return [];
    const clauses = terms.map(() => "content LIKE ? ESCAPE '\\'").join(" OR ");
    const where = base.where ? `${base.where} AND (${clauses})` : ` WHERE (${clauses})`;
    return q(`SELECT * FROM mem_entries${where} ORDER BY updated_at DESC, seq DESC LIMIT ?`)
      .all(...base.params, ...terms.map((t) => `%${escapeLike(t)}%`), SCAN_LIMIT);
  }

  /** 诊断用：返回本次实际走的检索路径（fts / like / none / empty），便于接 UI 与测试断言。 */
  function searchDebug({ query, scope, roomId, botId, target, limit = 10 } = {}) {
    const text = String(query ?? "").trim();
    if (!text) return { path: "empty", hits: [] };
    const base = filters({ scope, roomId, botId, target });
    const cap = normLimit(limit, 10, 100);
    for (const path of ["fts", "like"]) {
      let rows = [];
      try {
        rows = path === "fts" ? ftsRows(text, base) : likeRows(text, base);
      } catch (err) {
        logger.warn(`memory ${path} 检索失败，退化到下一路径`, err?.message || err);
      }
      const hits = rows.map((row) => scoreRow(row, text))
        .filter((hit) => hit.relevance > 0)
        .sort((a, b) => b.score - a.score || b.seq - a.seq)
        .slice(0, cap)
        .map(({ entry, score }) => ({ entry, score }));
      if (hits.length) return { path, hits };
    }
    return { path: "none", hits: [] };
  }

  const search = (opts = {}) => searchDebug(opts).hits;

  /* ----------------------------------------------------------- context block */

  /**
   * 上下文块的候选条目：严格按 scope 取（room 只取该房间、bot 只取该机器人、global 只取全局）。
   * 组合交给调用方（room.js 的三段式注入），这样拼接后同一条记忆不会出现两次。
   */
  function contextRows({ scope = "room", roomId, botId } = {}) {
    const s = assertScope(scope || "room");
    const order = "ORDER BY pinned DESC, updated_at DESC, seq DESC";
    if (s === "global") return q(`SELECT * FROM mem_entries WHERE scope = 'global' ${order}`).all();
    if (s === "bot") {
      if (!botId) throw new Error("bot 作用域的上下文块需要 botId");
      return q(`SELECT * FROM mem_entries WHERE scope = 'bot' AND bot_id = ? ${order}`).all(String(botId));
    }
    if (!roomId) throw new Error("room 作用域的上下文块需要 roomId");
    return q(`SELECT * FROM mem_entries WHERE scope = 'room' AND room_id = ? ${order}`).all(String(roomId));
  }

  /** 注入群聊上下文的 Markdown 块：置顶优先、按 scope 过滤、超预算截断并标注条数。 */
  function contextBlock({ scope = "room", roomId, botId, budgetChars = DEFAULT_BUDGET_CHARS } = {}) {
    const budget = Math.max(0, Math.floor(Number(budgetChars) || 0));
    if (!budget) return "";
    const s = assertScope(scope || "room");
    const entries = contextRows({ scope: s, roomId, botId }).map(entryOf);
    if (!entries.length) return "";

    const label = s === "global" ? "全局记忆" : s === "bot" ? `机器人记忆（${botId}）` : `房间记忆（${roomId}）`;
    const pinned = entries.filter((e) => e.pinned);
    const rest = entries.filter((e) => !e.pinned);
    const groups = [
      { label: "置顶记忆", tag: true, items: pinned },
      { label, tag: false, items: rest },
    ];

    let block = "<!-- 持久记忆（AgentFusion）：以下是跨回合累积的记忆，不是本轮新消息，作为权威参考使用 -->\n## 持久记忆\n";
    let used = block.length;
    let truncated = 0;
    for (const group of groups) {
      if (!group.items.length) continue;
      const heading = `\n### ${group.label}\n`;
      const lines = group.items.map((entry) =>
        `- ${group.tag ? `[${SCOPE_LABELS[entry.scope]}] ` : ""}${oneLine(entry.content)}\n`);
      if (used + heading.length + lines[0].length > budget - NOTE_RESERVE) {
        truncated += lines.length;
        continue;
      }
      block += heading;
      used += heading.length;
      let i = 0;
      while (i < lines.length && used + lines[i].length <= budget - NOTE_RESERVE) {
        block += lines[i];
        used += lines[i].length;
        i += 1;
      }
      truncated += lines.length - i;
    }
    if (truncated) block += `\n> 已截断 ${truncated} 条（预算 ${budget} 字符）\n`;
    if (block.length > budget) block = block.slice(0, budget); // 极端小预算下的硬上限
    return block;
  }

  /* ------------------------------------------------------------ audit/stats */

  function audit({ limit = 50 } = {}) {
    return q("SELECT * FROM mem_audit ORDER BY id DESC LIMIT ?").all(normLimit(limit, 50)).map((row) => ({
      id: Number(row.id), entryId: row.entry_id, action: row.action, scope: row.scope, roomId: row.room_id,
      botId: row.bot_id, target: row.target, source: row.source, reason: row.reason,
      detail: parseJson(row.detail_json, null), ts: row.ts,
    }));
  }

  function stats() {
    const rows = q("SELECT scope, COUNT(*) AS n, COALESCE(SUM(pinned), 0) AS p FROM mem_entries GROUP BY scope").all();
    const byScope = { room: 0, bot: 0, global: 0 };
    let total = 0, pinned = 0;
    for (const row of rows) {
      const n = Number(row.n) || 0;
      total += n;
      pinned += Number(row.p) || 0;
      if (row.scope in byScope) byScope[row.scope] = n;
    }
    return { total, pinned, byScope };
  }

  ensureFts();
  return {
    save, replace, remove, clear, get, list, search, searchDebug, contextBlock, audit, stats, rebuildFts,
  };
}

export default createMemory;
