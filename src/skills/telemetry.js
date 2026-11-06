/**
 * 技能使用遥测：每次 list / view / invoke / error 落一条事件，`stats()` 给出"用得多不多、最近还活不活"。
 *
 * 为什么需要：skills.js 现在只有静态目录，curator 判断"这个技能该不该归档"没有任何依据。
 * Hermes 用一个 `.usage.json` 侧车记 `use_count / view_count / patch_count / last_activity_at / state`
 * （tools/skill_usage.py:348 `_empty_record`、:448 `_bump`），我们换成 SQLite 表：
 * 群里多进程/多房间并发写文件会互相覆盖，而 store.db 已经是单点真相。
 *
 * 与 Hermes 的关系：
 *   - 采纳：事件计数 + "最近一次活动时间"（skill_usage.py:123 `latest_activity_at` 排除 created_at
 *     的语义：从未用过的技能不能被当成"很久没用"）、状态派生（active/stale/archive）。
 *   - 改写：计数扩展成可解释的 score = 频次 × 近期性衰减，方便 UI 排序与 curator 排序。
 *   - 不采纳：json 侧车 + 文件锁（:70 `skill_file_lock`），SQLite 事务替代。
 *
 * 约束：只写 `skill_usage_events` 这一张表（模块前缀 `skill_`，见 CONTRACT.md §2），不碰 store.js 的 schema。
 */
import { createLogger } from "../log.js";

const log = createLogger("skills:telemetry");

/** 合法事件类型。`error` 表示一次调用失败（ok=false 也会被计入 errors）。 */
export const EVENTS = ["list", "view", "invoke", "error"];

/** 状态阈值（天）。curator.transitions() 可以按调用参数覆盖，这里是 stats() 的默认口径。 */
export const STATUS_DAYS = { stale: 30, archive: 90 };

/** 近期性半衰期：14 天不用，权重减半。 */
export const HALF_LIFE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skill_usage_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill TEXT NOT NULL,
  event TEXT NOT NULL,
  room_id TEXT,
  bot_id TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  ms INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  ts TEXT NOT NULL,
  ts_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_usage_events_skill ON skill_usage_events(skill, ts_ms);
CREATE INDEX IF NOT EXISTS idx_skill_usage_events_ts ON skill_usage_events(ts_ms);
`;

/** 时间值归一：支持 number / Date / ISO 字符串，非法值回退。 */
function toMs(value, fallback) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * 可解释的 score：频次加权 × 近期性衰减。
 *   invoke 3 分、view 1 分、list 0.5 分、error -1 分（同一技能反复失败说明它不可用）。
 *   再乘 `0.5 ** (ageDays / 14)`：最后使用距今每 14 天权重减半。
 * @param {{views?:number, lists?:number, invokes?:number, errors?:number}} counts
 * @param {number|null} lastMs
 * @param {number} nowMs
 */
export function computeScore(counts = {}, lastMs = null, nowMs = Date.now()) {
  const raw =
    Number(counts.invokes || 0) * 3 +
    Number(counts.views || 0) * 1 +
    Number(counts.lists || 0) * 0.5 -
    Number(counts.errors || 0) * 1;
  if (raw <= 0) return 0;
  if (!Number.isFinite(lastMs)) return 0;
  const ageDays = Math.max(0, (nowMs - lastMs) / DAY_MS);
  const recency = 0.5 ** (ageDays / HALF_LIFE_DAYS);
  return Math.round(raw * recency * 1000) / 1000;
}

/** 由最近活动时间派生状态：unused / active / stale / archive。 */
export function statusFor(lastMs, nowMs = Date.now()) {
  if (!Number.isFinite(lastMs)) return "unused";
  const ageDays = Math.max(0, (nowMs - lastMs) / DAY_MS);
  if (ageDays > STATUS_DAYS.archive) return "archive";
  if (ageDays > STATUS_DAYS.stale) return "stale";
  return "active";
}

/**
 * @param {{store: {db: object, prepare: Function}, now?: () => number}} opts
 */
export function createSkillTelemetry({ store, now = () => Date.now() } = {}) {
  if (!store || !store.db) throw new Error("createSkillTelemetry 需要 store（node:sqlite DatabaseSync 实例）");
  store.db.exec(SCHEMA);

  const insert = store.prepare(
    `INSERT INTO skill_usage_events(skill, event, room_id, bot_id, ok, ms, detail, ts, ts_ms)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  );

  /**
   * 记一条事件。
   * @param {{skill:string, event:string, roomId?:string|null, botId?:string|null, ok?:boolean, ms?:number, detail?:any, ts?:string|number|Date}} evt
   * @returns {{id:number, skill:string, event:string, roomId:string|null, botId:string|null, ok:boolean, ms:number, detail:any, ts:string}}
   */
  function record(evt = {}) {
    const skill = String(evt.skill || "").trim();
    if (!skill) throw new Error("record 需要 skill 名称");
    const event = String(evt.event || "view").trim();
    if (!EVENTS.includes(event)) {
      throw new Error(`未知事件类型：${event}（允许：${EVENTS.join(", ")}）`);
    }
    const tsMs = toMs(evt.ts, now());
    const ok = evt.ok === false ? 0 : 1;
    const ms = Math.max(0, Math.round(Number(evt.ms) || 0));
    const detail =
      evt.detail === undefined || evt.detail === null
        ? null
        : typeof evt.detail === "string"
          ? evt.detail
          : JSON.stringify(evt.detail);
    const ts = new Date(tsMs).toISOString();
    const info = insert.run(
      skill,
      event,
      evt.roomId === undefined || evt.roomId === null ? null : String(evt.roomId),
      evt.botId === undefined || evt.botId === null ? null : String(evt.botId),
      ok,
      ms,
      detail,
      ts,
      tsMs,
    );
    return {
      id: Number(info.lastInsertRowid),
      skill,
      event,
      roomId: evt.roomId === undefined || evt.roomId === null ? null : String(evt.roomId),
      botId: evt.botId === undefined || evt.botId === null ? null : String(evt.botId),
      ok: ok === 1,
      ms,
      detail,
      ts,
    };
  }

  const windowStmt = store.prepare(
    `SELECT skill,
            SUM(CASE WHEN event = 'view'   THEN 1 ELSE 0 END) AS views,
            SUM(CASE WHEN event = 'list'   THEN 1 ELSE 0 END) AS lists,
            SUM(CASE WHEN event = 'invoke' THEN 1 ELSE 0 END) AS invokes,
            SUM(CASE WHEN event = 'error' OR ok = 0 THEN 1 ELSE 0 END) AS errors,
            COUNT(*) AS total
       FROM skill_usage_events
      WHERE ts_ms >= ?
      GROUP BY skill`,
  );
  const lifetimeStmt = store.prepare(
    `SELECT skill, MAX(ts_ms) AS last_ms, COUNT(*) AS total FROM skill_usage_events GROUP BY skill`,
  );

  /**
   * 窗口内计数 + 全生命周期最近活动时间；按 score 降序、invoke 次数降序、名字升序。
   * @param {{sinceDays?: number, now?: number|Date|string}} [opts]
   * @returns {Array<{skill:string, views:number, lists:number, invokes:number, errors:number, lastUsed:string|null, score:number, status:string, total:number}>}
   */
  function stats({ sinceDays = 30, now: nowArg } = {}) {
    const nowMs = toMs(nowArg, now());
    const days = Math.max(0, Number(sinceDays) || 0);
    const since = nowMs - days * DAY_MS;
    const window = new Map(windowStmt.all(since).map((r) => [String(r.skill), r]));
    const rows = [];
    for (const life of lifetimeStmt.all()) {
      const skill = String(life.skill);
      const w = window.get(skill) || { views: 0, lists: 0, invokes: 0, errors: 0, total: 0 };
      const lastMs = Number(life.last_ms);
      const counts = {
        views: Number(w.views || 0),
        lists: Number(w.lists || 0),
        invokes: Number(w.invokes || 0),
        errors: Number(w.errors || 0),
      };
      rows.push({
        skill,
        ...counts,
        lastUsed: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null,
        score: computeScore(counts, lastMs, nowMs),
        status: statusFor(lastMs, nowMs),
        total: Number(life.total || 0),
      });
    }
    rows.sort((a, b) => b.score - a.score || b.invokes - a.invokes || a.skill.localeCompare(b.skill));
    return rows;
  }

  const ofStmt = store.prepare(
    `SELECT
       SUM(CASE WHEN event = 'view'   THEN 1 ELSE 0 END) AS views,
       SUM(CASE WHEN event = 'list'   THEN 1 ELSE 0 END) AS lists,
       SUM(CASE WHEN event = 'invoke' THEN 1 ELSE 0 END) AS invokes,
       SUM(CASE WHEN event = 'error' OR ok = 0 THEN 1 ELSE 0 END) AS errors,
       MAX(ts_ms) AS last_ms,
       COUNT(*) AS total
     FROM skill_usage_events WHERE skill = ?`,
  );

  /**
   * 单个技能的全量计数（不受 sinceDays 窗口影响，供 curator 判断活跃度）。
   * @param {string} skill
   */
  function of(skill) {
    const name = String(skill || "").trim();
    const row = ofStmt.get(name) || {};
    const lastMs = row.last_ms === null || row.last_ms === undefined ? null : Number(row.last_ms);
    return {
      skill: name,
      views: Number(row.views || 0),
      lists: Number(row.lists || 0),
      invokes: Number(row.invokes || 0),
      errors: Number(row.errors || 0),
      total: Number(row.total || 0),
      lastUsed: lastMs === null ? null : new Date(lastMs).toISOString(),
      lastUsedMs: lastMs,
    };
  }

  /** 最近 N 条原始事件（排查用）。 */
  function recent({ limit = 50 } = {}) {
    return store
      .prepare("SELECT * FROM skill_usage_events ORDER BY id DESC LIMIT ?")
      .all(Math.max(1, Math.min(Number(limit) || 50, 500)))
      .map((r) => ({
        id: Number(r.id),
        skill: r.skill,
        event: r.event,
        roomId: r.room_id,
        botId: r.bot_id,
        ok: Number(r.ok) === 1,
        ms: Number(r.ms),
        detail: r.detail,
        ts: r.ts,
      }));
  }

  /** 全部事件行数（快速健康检查）。 */
  function count() {
    const row = store.prepare("SELECT COUNT(*) AS n FROM skill_usage_events").get();
    return Number(row?.n || 0);
  }

  /**
   * 清理过期事件（`list` 事件会随每次列技能增长，长期运行需要节流）。
   * @param {{olderThanDays?: number, now?: number|Date|string}} [opts]
   * @returns {{removed:number}}
   */
  function prune({ olderThanDays = 180, now: nowArg } = {}) {
    const cutoff = toMs(nowArg, now()) - Math.max(0, Number(olderThanDays) || 0) * DAY_MS;
    const info = store.prepare("DELETE FROM skill_usage_events WHERE ts_ms < ?").run(cutoff);
    return { removed: Number(info.changes || 0) };
  }

  log.debug("skill telemetry ready");
  return { record, stats, of, recent, count, prune };
}

export default createSkillTelemetry;
