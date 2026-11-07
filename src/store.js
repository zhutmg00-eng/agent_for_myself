/**
 * SQLite persistence for AgentFusion (node:sqlite, no third-party deps).
 *
 * Tables follow docs/FUSION_SPEC.md §4; the method surface follows §3 plus a few
 * helpers used by the room engine and the HTTP layer.
 *
 * Everything lives under DATA_ROOT (default D:\AgentFusion) — see config.js.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DIRS, assertNotC } from "./config.js";
import { createLogger } from "./log.js";

const log = createLogger("store");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms(
  room_id TEXT PRIMARY KEY,
  title TEXT,
  owner_id TEXT,
  parent_room_id TEXT,
  topic TEXT DEFAULT '',
  context_policy TEXT DEFAULT 'shared',
  status TEXT DEFAULT 'active',
  settings_json TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS room_members(
  room_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  permissions_json TEXT,
  PRIMARY KEY(room_id, bot_id)
);
CREATE TABLE IF NOT EXISTS room_messages(
  room_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  speaker TEXT,
  content TEXT,
  kind TEXT DEFAULT 'message',
  ts TEXT,
  PRIMARY KEY(room_id, seq)
);
CREATE TABLE IF NOT EXISTS room_files(
  room_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  path TEXT,
  description TEXT,
  tags_json TEXT,
  updated_at TEXT,
  PRIMARY KEY(room_id, file_id)
);
CREATE TABLE IF NOT EXISTS pending_notices(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_room_id TEXT,
  child_room_id TEXT,
  kind TEXT,
  text TEXT,
  created_at TEXT,
  drained_at TEXT
);
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL,
  topic TEXT,
  sender TEXT,
  payload TEXT,
  thread_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id, seq);
CREATE TABLE IF NOT EXISTS bots(id TEXT PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS usage(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT, room_id TEXT, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, ms INTEGER, ts TEXT,
  ttft_ms INTEGER NOT NULL DEFAULT 0,
  tps REAL NOT NULL DEFAULT 0.0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_room ON usage(room_id);
CREATE INDEX IF NOT EXISTS idx_usage_bot ON usage(bot_id);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
`;

function nowIso() {
  return new Date().toISOString();
}

export function makeId(bytes = 6) {
  return crypto.randomBytes(bytes).toString("hex");
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function json(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

/** Default permission object for a room member (matches the vision + old harness). */
export function defaultPermissions(overrides = {}) {
  return {
    can_speak: true,
    context_access: "full",
    can_create_subgroup: false,
    allowed_tool_overrides: null,
    ...overrides,
  };
}

export class Store {
  /** @param {string} [dbPath] */
  constructor(dbPath = DIRS.dbFile) {
    this.dbPath = assertNotC(dbPath, "sqlite db");
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec(SCHEMA);
    this._migrate();
    this._stmts = new Map();
    log.info("database ready at", this.dbPath);
  }

  prepare(sql) {
    let stmt = this._stmts.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this._stmts.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * 轻量迁移：给已存在的旧库补列。
   *
   * 为什么不用版本号表：fusion 的库经常被就地升级（用户不会重装），
   * `ALTER TABLE … ADD COLUMN` 在 SQLite 里是幂等且便宜的，靠 PRAGMA 探测列名比维护
   * schema_version 更不容易漏。新增列时记得同时改上面的 CREATE TABLE（新库走快路径）。
   */
  _migrate() {
    const addColumn = (table, column, ddl) => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };
    // 房间级设置（disabled_toolsets / context budget …），JSON。
    addColumn("rooms", "settings_json", "settings_json TEXT");
    // 遥测指标与缓存 Token 统计
    addColumn("usage", "ttft_ms", "ttft_ms INTEGER NOT NULL DEFAULT 0");
    addColumn("usage", "tps", "tps REAL NOT NULL DEFAULT 0.0");
    addColumn("usage", "cache_read_tokens", "cache_read_tokens INTEGER NOT NULL DEFAULT 0");
    addColumn("usage", "cache_write_tokens", "cache_write_tokens INTEGER NOT NULL DEFAULT 0");
    // 索引加速长任务与历史遥测查询
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_room ON usage(room_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_bot ON usage(bot_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts)");
  }

  close() {
    try {
      this._stmts.clear();
      this.db.close();
    } catch (err) {
      log.warn("close failed", err?.message || err);
    }
  }

  tx(fn) {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /* ------------------------------------------------------------------ bots */

  listBots() {
    return this.prepare("SELECT data FROM bots ORDER BY rowid ASC")
      .all()
      .map((r) => parseJson(r.data, null))
      .filter(Boolean);
  }

  getBot(id) {
    const row = this.prepare("SELECT data FROM bots WHERE id = ?").get(String(id));
    return row ? parseJson(row.data, null) : null;
  }

  upsertBot(bot) {
    if (!bot || !bot.id) throw new Error("bot.id is required");
    this.prepare(
      "INSERT INTO bots(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
    ).run(String(bot.id), json(bot));
    return bot;
  }

  deleteBot(id) {
    this.prepare("DELETE FROM bots WHERE id = ?").run(String(id));
  }

  /* ----------------------------------------------------------------- rooms */

  _roomFromRow(row) {
    if (!row) return null;
    return {
      room_id: row.room_id,
      title: row.title || "",
      owner_id: row.owner_id || null,
      parent_room_id: row.parent_room_id || null,
      topic: row.topic || "",
      context_policy: row.context_policy || "shared",
      status: row.status || "active",
      settings: parseJson(row.settings_json, {}) || {},
      created_at: row.created_at || "",
      updated_at: row.updated_at || "",
    };
  }

  listRooms() {
    return this.prepare("SELECT * FROM rooms ORDER BY created_at DESC").all().map((r) => this._roomFromRow(r));
  }

  getRoom(roomId) {
    return this._roomFromRow(this.prepare("SELECT * FROM rooms WHERE room_id = ?").get(String(roomId)));
  }

  upsertRoom(room) {
    if (!room || !room.room_id) throw new Error("room.room_id is required");
    const ts = nowIso();
    const existing = this.getRoom(room.room_id);
    this.prepare(
      `INSERT INTO rooms(room_id,title,owner_id,parent_room_id,topic,context_policy,status,settings_json,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(room_id) DO UPDATE SET
         title = excluded.title, owner_id = excluded.owner_id,
         parent_room_id = excluded.parent_room_id, topic = excluded.topic,
         context_policy = excluded.context_policy, status = excluded.status,
         settings_json = excluded.settings_json,
         updated_at = excluded.updated_at`,
    ).run(
      String(room.room_id),
      String(room.title ?? ""),
      room.owner_id ? String(room.owner_id) : null,
      room.parent_room_id ? String(room.parent_room_id) : null,
      String(room.topic ?? ""),
      String(room.context_policy ?? "shared"),
      String(room.status ?? "active"),
      room.settings && typeof room.settings === "object" ? json(room.settings) : null,
      room.created_at || existing?.created_at || ts,
      room.updated_at || ts,
    );
    return this.getRoom(room.room_id);
  }

  setRoomStatus(roomId, status) {
    this.prepare("UPDATE rooms SET status = ?, updated_at = ? WHERE room_id = ?").run(
      String(status),
      nowIso(),
      String(roomId),
    );
    return this.getRoom(roomId);
  }

  /** Bump updated_at (turns / edits). */
  touchRoom(roomId) {
    this.prepare("UPDATE rooms SET updated_at = ? WHERE room_id = ?").run(nowIso(), String(roomId));
  }

  deleteRoom(roomId) {
    const id = String(roomId);
    this.tx(() => {
      this.prepare("DELETE FROM room_members WHERE room_id = ?").run(id);
      this.prepare("DELETE FROM room_messages WHERE room_id = ?").run(id);
      this.prepare("DELETE FROM room_files WHERE room_id = ?").run(id);
      this.prepare("DELETE FROM rooms WHERE room_id = ?").run(id);
      // 证据记录（src/rooms/evidence.js 懒建表）：表不存在时忽略，避免旧库删房失败。
      try {
        this.prepare("DELETE FROM ev_records WHERE room_id = ?").run(id);
      } catch {
        /* ev_records 尚未创建 */
      }
    });
  }

  /* --------------------------------------------------------- room members */

  listRoomMembers(roomId) {
    return this.prepare("SELECT room_id, bot_id, permissions_json FROM room_members WHERE room_id = ? ORDER BY rowid ASC")
      .all(String(roomId))
      .map((r) => ({
        room_id: r.room_id,
        bot_id: r.bot_id,
        permissions: parseJson(r.permissions_json, defaultPermissions()),
      }));
  }

  setRoomMembers(roomId, members = []) {
    const id = String(roomId);
    this.tx(() => {
      this.prepare("DELETE FROM room_members WHERE room_id = ?").run(id);
      const ins = this.prepare("INSERT INTO room_members(room_id, bot_id, permissions_json) VALUES(?,?,?)");
      for (const m of members) {
        const botId = typeof m === "string" ? m : m.bot_id || m.id;
        if (!botId) continue;
        const perms = (typeof m === "object" && m.permissions) || defaultPermissions();
        ins.run(id, String(botId), json(perms));
      }
    });
    return this.listRoomMembers(id);
  }

  setMemberPermissions(roomId, botId, permissions) {
    const row = this.prepare("SELECT permissions_json FROM room_members WHERE room_id = ? AND bot_id = ?").get(
      String(roomId),
      String(botId),
    );
    const next = { ...defaultPermissions(), ...(parseJson(row?.permissions_json, {}) || {}), ...(permissions || {}) };
    if (row) {
      this.prepare("UPDATE room_members SET permissions_json = ? WHERE room_id = ? AND bot_id = ?").run(
        json(next),
        String(roomId),
        String(botId),
      );
    } else {
      this.prepare("INSERT INTO room_members(room_id, bot_id, permissions_json) VALUES(?,?,?)").run(
        String(roomId),
        String(botId),
        json(next),
      );
    }
    return next;
  }

  removeRoomMember(roomId, botId) {
    this.prepare("DELETE FROM room_members WHERE room_id = ? AND bot_id = ?").run(String(roomId), String(botId));
  }

  /* -------------------------------------------------------- room messages */

  nextRoomSeq(roomId) {
    const row = this.prepare("SELECT COALESCE(MAX(seq),0) AS m FROM room_messages WHERE room_id = ?").get(String(roomId));
    return Number(row?.m || 0) + 1;
  }

  appendRoomMessage(roomId, { speaker, content, kind = "message", ts } = {}) {
    const id = String(roomId);
    const seq = this.nextRoomSeq(id);
    const stamp = ts || nowIso();
    this.prepare("INSERT INTO room_messages(room_id, seq, speaker, content, kind, ts) VALUES(?,?,?,?,?,?)").run(
      id,
      seq,
      String(speaker ?? "system"),
      String(content ?? ""),
      String(kind || "message"),
      stamp,
    );
    this.touchRoom(id);
    return { room_id: id, seq, speaker: speaker ?? "system", content: content ?? "", kind, ts: stamp };
  }

  listRoomMessages(roomId, limit = 500) {
    let rows;
    if (limit && Number(limit) > 0) {
      rows = this.prepare(`
        SELECT * FROM (
          SELECT * FROM room_messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?
        ) ORDER BY seq ASC
      `).all(String(roomId), Number(limit));
    } else {
      rows = this.prepare("SELECT * FROM room_messages WHERE room_id = ? ORDER BY seq ASC").all(String(roomId));
    }
    return rows.map((r) => ({
      room_id: r.room_id,
      seq: Number(r.seq),
      speaker: r.speaker,
      content: r.content,
      kind: r.kind,
      ts: r.ts,
    }));
  }

  /* ----------------------------------------------------------- room files */

  upsertRoomFile(roomId, file) {
    const id = String(roomId);
    const rec = {
      room_id: id,
      file_id: String(file.file_id),
      path: String(file.path ?? ""),
      description: String(file.description ?? ""),
      tags: Array.isArray(file.tags) ? file.tags : parseJson(file.tags_json, []),
      updated_at: file.updated_at || nowIso(),
    };
    this.prepare(
      `INSERT INTO room_files(room_id, file_id, path, description, tags_json, updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(room_id, file_id) DO UPDATE SET
         path = excluded.path, description = excluded.description,
         tags_json = excluded.tags_json, updated_at = excluded.updated_at`,
    ).run(id, rec.file_id, rec.path, rec.description, json(rec.tags), rec.updated_at);
    return rec;
  }

  getRoomFile(roomId, fileId) {
    const row = this.prepare("SELECT * FROM room_files WHERE room_id = ? AND file_id = ?").get(String(roomId), String(fileId));
    if (!row) return null;
    return {
      room_id: row.room_id,
      file_id: row.file_id,
      path: row.path,
      description: row.description || "",
      tags: parseJson(row.tags_json, []),
      updated_at: row.updated_at,
    };
  }

  listRoomFiles(roomId) {
    return this.prepare("SELECT * FROM room_files WHERE room_id = ? ORDER BY updated_at ASC")
      .all(String(roomId))
      .map((row) => ({
        room_id: row.room_id,
        file_id: row.file_id,
        path: row.path,
        description: row.description || "",
        tags: parseJson(row.tags_json, []),
        updated_at: row.updated_at,
      }));
  }

  deleteRoomFile(roomId, fileId) {
    this.prepare("DELETE FROM room_files WHERE room_id = ? AND file_id = ?").run(String(roomId), String(fileId));
  }

  /* -------------------------------------------------------- pending notices */

  addNotice({ parent_room_id, child_room_id = null, kind = "info", text = "" }) {
    const ts = nowIso();
    this.prepare(
      "INSERT INTO pending_notices(parent_room_id, child_room_id, kind, text, created_at, drained_at) VALUES(?,?,?,?,?,NULL)",
    ).run(String(parent_room_id), child_room_id ? String(child_room_id) : null, String(kind), String(text), ts);
    return { parent_room_id, child_room_id, kind, text, created_at: ts };
  }

  /** Returns undrained notices for a room and marks them drained. */
  drainNotices(roomId) {
    const id = String(roomId);
    const rows = this.prepare("SELECT * FROM pending_notices WHERE parent_room_id = ? AND drained_at IS NULL ORDER BY id ASC")
      .all(id);
    if (rows.length) {
      const stamp = nowIso();
      const upd = this.prepare("UPDATE pending_notices SET drained_at = ? WHERE id = ?");
      for (const r of rows) upd.run(stamp, r.id);
    }
    return rows.map((r) => ({
      id: r.id,
      parent_room_id: r.parent_room_id,
      child_room_id: r.child_room_id,
      kind: r.kind,
      text: r.text,
      created_at: r.created_at,
    }));
  }

  listNotices(roomId, { includeDrained = false } = {}) {
    const sql = includeDrained
      ? "SELECT * FROM pending_notices WHERE parent_room_id = ? ORDER BY id ASC"
      : "SELECT * FROM pending_notices WHERE parent_room_id = ? AND drained_at IS NULL ORDER BY id ASC";
    return this.prepare(sql).all(String(roomId));
  }

  /* -------------------------------------------------------------------- kv */

  getKV(key, fallback = null) {
    const row = this.prepare("SELECT v FROM kv WHERE k = ?").get(String(key));
    if (!row) return fallback;
    return parseJson(row.v, fallback);
  }

  setKV(key, value) {
    this.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(
      String(key),
      json(value),
    );
    return value;
  }

  /* ---------------------------------------------------------------- events */

  appendEvent(evt) {
    const info = this.prepare("INSERT INTO events(ts, topic, sender, payload, thread_id) VALUES(?,?,?,?,?)").run(
      Number(evt.ts ?? Date.now() / 1000),
      String(evt.topic ?? ""),
      String(evt.sender ?? "system"),
      json(evt.payload ?? {}),
      evt.thread_id === undefined || evt.thread_id === null ? null : String(evt.thread_id),
    );
    return Number(info.lastInsertRowid);
  }

  listEvents({ thread_id = undefined, after_seq = 0, limit = 2000 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 2000, 20000));
    const after = Number(after_seq) || 0;
    const rows =
      thread_id === undefined || thread_id === null
        ? this.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?").all(after, max)
        : this.prepare("SELECT * FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?").all(
            String(thread_id),
            after,
            max,
          );
    return rows.map((r) => ({
      seq: Number(r.seq),
      ts: Number(r.ts),
      topic: r.topic,
      sender: r.sender,
      payload: parseJson(r.payload, {}),
      thread_id: r.thread_id,
    }));
  }

  lastEventSeq() {
    const row = this.prepare("SELECT COALESCE(MAX(seq),0) AS m FROM events").get();
    return Number(row?.m || 0);
  }

  /* ---------------------------------------------------------------- usage */

  addUsage({
    bot_id = null,
    botId = null,
    room_id = null,
    roomId = null,
    model = null,
    input_tokens = 0,
    output_tokens = 0,
    cache_read_tokens = 0,
    cache_write_tokens = 0,
    ms = 0,
    ttft_ms = 0,
    tps = 0,
  } = {}) {
    const finalBotId = bot_id ?? botId;
    const finalRoomId = room_id ?? roomId;
    this.prepare(
      `INSERT INTO usage(bot_id, room_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ms, ttft_ms, tps, ts)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      finalBotId ? String(finalBotId) : null,
      finalRoomId ? String(finalRoomId) : null,
      model ? String(model) : null,
      Number(input_tokens) || 0,
      Number(output_tokens) || 0,
      Number(cache_read_tokens) || 0,
      Number(cache_write_tokens) || 0,
      Number(ms) || 0,
      Number(ttft_ms) || 0,
      Number(tps) || 0,
      nowIso(),
    );
  }

  usageSummary({ allFields = false, roomId = null } = {}) {
    const whereClause = roomId ? "WHERE room_id = ?" : "";
    const params = roomId ? [String(roomId)] : [];
    const totals = this.prepare(`
      SELECT COUNT(*) AS calls,
             COALESCE(SUM(input_tokens),0) AS input,
             COALESCE(SUM(output_tokens),0) AS output,
             COALESCE(SUM(cache_read_tokens),0) AS cache_read,
             COALESCE(SUM(cache_write_tokens),0) AS cache_write,
             COALESCE(SUM(ms),0) AS ms,
             COALESCE(AVG(CASE WHEN ttft_ms > 0 THEN ttft_ms ELSE NULL END), 0) AS avg_ttft_ms,
             COALESCE(AVG(CASE WHEN tps > 0 THEN tps ELSE NULL END), 0) AS avg_tps
        FROM usage
        ${whereClause}
    `).get(...params);

    const calls = Number(totals.calls || 0);
    if (calls === 0 && !allFields) {
      return {
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        ms: 0,
        by_bot: [],
      };
    }

    const byBot = this.prepare(`
      SELECT bot_id,
             COUNT(*) AS calls,
             COALESCE(SUM(input_tokens),0) AS input,
             COALESCE(SUM(output_tokens),0) AS output,
             COALESCE(SUM(cache_read_tokens),0) AS cache_read,
             COALESCE(SUM(cache_write_tokens),0) AS cache_write,
             COALESCE(SUM(ms),0) AS ms,
             COALESCE(AVG(CASE WHEN ttft_ms > 0 THEN ttft_ms ELSE NULL END), 0) AS avg_ttft_ms,
             COALESCE(AVG(CASE WHEN tps > 0 THEN tps ELSE NULL END), 0) AS avg_tps
        FROM usage
        ${whereClause}
       GROUP BY bot_id
       ORDER BY calls DESC
    `).all(...params);

    return {
      calls,
      input_tokens: Number(totals.input || 0),
      output_tokens: Number(totals.output || 0),
      cache_read: Number(totals.cache_read || 0),
      cache_read_tokens: Number(totals.cache_read || 0),
      cache_write: Number(totals.cache_write || 0),
      cache_write_tokens: Number(totals.cache_write || 0),
      total_tokens: Number(totals.input || 0) + Number(totals.output || 0),
      ms: Number(totals.ms || 0),
      avg_ttft_ms: Math.round(Number(totals.avg_ttft_ms || 0)),
      avg_tps: Number(Number(totals.avg_tps || 0).toFixed(1)),
      by_bot: byBot.map((r) => ({
        bot_id: r.bot_id,
        calls: Number(r.calls),
        input_tokens: Number(r.input),
        output_tokens: Number(r.output),
        cache_read: Number(r.cache_read || 0),
        cache_read_tokens: Number(r.cache_read || 0),
        cache_write: Number(r.cache_write || 0),
        cache_write_tokens: Number(r.cache_write || 0),
        ms: Number(r.ms),
        avg_ttft_ms: Math.round(Number(r.avg_ttft_ms || 0)),
        avg_tps: Number(Number(r.avg_tps || 0).toFixed(1)),
      })),
    };
  }

  /* -------------------------------------------------------------- tickets */

  createTicket(ticket) {
    const id = ticket.id || makeId(6);
    const rec = { id, created_at: nowIso(), ...ticket, id };
    this.prepare("INSERT INTO tickets(id, data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(
      String(id),
      json(rec),
    );
    return rec;
  }

  updateTicket(id, patch = {}) {
    const row = this.prepare("SELECT data FROM tickets WHERE id = ?").get(String(id));
    const rec = { ...(parseJson(row?.data, {}) || {}), ...patch, id: String(id) };
    this.prepare("INSERT INTO tickets(id, data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(
      String(id),
      json(rec),
    );
    return rec;
  }

  getTicket(id) {
    const row = this.prepare("SELECT data FROM tickets WHERE id = ?").get(String(id));
    return row ? parseJson(row.data, null) : null;
  }

  listTickets(limit = 50) {
    return this.prepare("SELECT data FROM tickets ORDER BY rowid DESC LIMIT ?")
      .all(Math.max(1, Number(limit) || 50))
      .map((r) => parseJson(r.data, null))
      .filter(Boolean);
  }
}

export { nowIso };
