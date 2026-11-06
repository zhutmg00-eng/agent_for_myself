/**
 * RoomManager — owns the live Room instances, creates rooms and restores them
 * from SQLite on startup.
 *
 * Contract: docs/CONTRACT_ROOM.md §2; HTTP-facing shape: docs/CONTRACT_API.md.
 */
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { DIRS } from "../config.js";
import { createLogger } from "../log.js";
import { Room } from "./room.js";
import { defaultPermissions } from "../store.js";

const log = createLogger("rooms");

const MAX_TITLE = 80;
const MAX_TOPIC = 200;

function truncate(text, max) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

function newRoomId(taken) {
  for (let i = 0; i < 20; i += 1) {
    const id = crypto.randomBytes(3).toString("hex"); // 6 hex chars, like the old harness
    if (!taken.has(id)) return id;
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export class RoomManager {
  /**
   * @param {{store:object, events:object, engine:object, hooks?:object, skills?:object,
   *          archetypes?:object, approval?:object, memory?:object, telemetry?:object,
   *          curator?:object}} deps
   */
  constructor({ store, events, engine, hooks, skills, archetypes, approval = null, memory = null, telemetry = null, curator = null } = {}) {
    this.store = store;
    this.events = events;
    this.engine = engine;
    this.hooks = hooks;
    this.skills = skills;
    this.archetypes = archetypes;
    /** 审批层（src/approval.js）：注入到每个 bot 的 tool_call 钩子。 */
    this.approval = approval;
    /** 持久记忆（src/memory.js）：注入回合上下文 + memory 群工具。 */
    this.memory = memory;
    /** 技能用量遥测（src/skills/telemetry.js）。 */
    this.telemetry = telemetry;
    /** 技能策展（src/skills/curator.js）。 */
    this.curator = curator;
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  /* -------------------------------------------------------------- restore */

  async restore() {
    let rows = [];
    try {
      rows = this.store?.listRooms?.() || [];
    } catch (err) {
      log.error("listRooms failed", err?.message || err);
      return this;
    }
    for (const row of rows) {
      try {
        const room = new Room({
          record: row,
          store: this.store,
          events: this.events,
          engine: this.engine,
          hooks: this.hooks,
          skills: this.skills,
          archetypes: this.archetypes,
          approval: this.approval,
          memory: this.memory,
          telemetry: this.telemetry,
          manager: this,
        });
        await room.loadMembers();
        await room.loadHistory(1000);
        this.rooms.set(row.room_id, room);
      } catch (err) {
        log.error("restore room failed", row?.room_id, err?.message || err);
      }
    }
    log.info(`restored ${this.rooms.size} room(s)`);
    return this;
  }

  /* --------------------------------------------------------------- create */

  /**
   * Create (and persist) a room.
   * @param {{title?:string, owner_id?:string, members?:string[], context_policy?:string,
   *          topic?:string, include_roles?:boolean, include_librarian?:boolean,
   *          parent_room_id?:string|null, is_subgroup?:boolean, member_permissions?:object}} input
   * @returns {Promise<{room_id:string, members:string[], owner_id?:string, title?:string, context_policy?:string}>}
   */
  async create(input = {}) {
    const requested = Array.isArray(input.members) ? input.members.map(String).filter(Boolean) : [];
    const includeRoles = Boolean(input.include_roles || input.include_librarian);
    let members = [...requested];

    if (includeRoles) {
      if (!members.includes("boss")) members.unshift("boss");
      if (!members.includes("librarian")) members.push("librarian");
    }
    // De-duplicate while keeping order.
    members = [...new Set(members)];

    const effectiveOwner = input.owner_id
      ? String(input.owner_id).trim()
      : includeRoles
        ? "boss"
        : null;

    if (effectiveOwner && !members.includes(effectiveOwner)) members.push(effectiveOwner);
    if (members.length < 2) {
      throw new Error(`A room needs at least 2 members, got ${members.length}.`);
    }

    const contextPolicy = ["shared", "summary", "isolated"].includes(input.context_policy)
      ? input.context_policy
      : "shared";

    const roomId = newRoomId(new Set(this.rooms.keys()));
    const record = {
      room_id: roomId,
      title: truncate(input.title || "", MAX_TITLE),
      owner_id: effectiveOwner,
      parent_room_id: input.parent_room_id ? String(input.parent_room_id) : null,
      topic: truncate(input.topic || "", MAX_TOPIC),
      context_policy: contextPolicy,
      status: "active",
      // 房间级设置：工具面裁剪等（Hermes toolset 语义的房间维度）。
      settings: input.settings && typeof input.settings === "object" ? { ...input.settings } : {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Materialize any archetype that is not in the bot table yet.
    for (const id of members) this.ensureBot(id);

    const room = new Room({
      record,
      store: this.store,
      events: this.events,
      engine: this.engine,
      hooks: this.hooks,
      skills: this.skills,
      archetypes: this.archetypes,
      approval: this.approval,
      memory: this.memory,
      telemetry: this.telemetry,
      manager: this,
    });
    room.members = [...members];
    room.speaking_slots = [...members];
    room.relay_limit = 3 * Math.max(1, members.length);
    room.member_permissions = {};
    for (const id of members) {
      const custom = input.member_permissions?.[id] || {};
      const isOwner = effectiveOwner === id;
      room.member_permissions[id] = defaultPermissions({
        can_create_subgroup: isOwner ? true : false,
        ...custom,
      });
    }

    // Persist room + members + file directory.
    try {
      this.store.upsertRoom(record);
      this.store.setRoomMembers(
        roomId,
        members.map((id) => ({ bot_id: id, permissions: room.member_permissions[id] })),
      );
    } catch (err) {
      log.error("persist room failed", err?.message || err);
    }
    try {
      fs.mkdirSync(path.join(DIRS.rooms, roomId, "files"), { recursive: true });
    } catch (err) {
      log.warn("create room files dir failed", err?.message || err);
    }

    this.rooms.set(roomId, room);

    await this.events?.publish?.({
      topic: "harness.room.created",
      sender: "runtime",
      payload: {
        room_id: roomId,
        members: [...members],
        owner_id: effectiveOwner,
        title: record.title,
        parent_room_id: record.parent_room_id,
      },
      thread_id: null,
    });

    const response = { room_id: roomId, members: [...members] };
    if (includeRoles || record.title || input.owner_id || contextPolicy !== "shared") {
      response.owner_id = effectiveOwner;
      response.title = record.title;
      response.context_policy = contextPolicy;
    }
    return response;
  }

  ensureBot(botId) {
    try {
      if (this.store?.getBot?.(botId)) return this.store.getBot(botId);
      const build = this.archetypes?.buildBot;
      if (typeof build !== "function") return null;
      const bot = build(botId);
      if (bot) this.store?.upsertBot?.(bot);
      return bot;
    } catch (err) {
      log.warn("ensureBot failed", botId, err?.message || err);
      return null;
    }
  }

  /* ----------------------------------------------------------------- read */

  get(roomId) {
    return this.rooms.get(String(roomId)) || null;
  }

  list() {
    return [...this.rooms.values()]
      .map((room) => room.snapshot())
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  snapshotAll() {
    return this.list();
  }

  delete(roomId) {
    const id = String(roomId);
    // 先递归删除子房（小群）：父房被删后子房就是孤儿，保留会泄漏 session 与数据。
    let children = [];
    try {
      children = (this.store?.listRooms?.() || []).filter((row) => String(row.parent_room_id || "") === id);
    } catch (err) {
      log.warn("listRooms for cascade failed", err?.message || err);
    }
    for (const child of children) {
      try {
        this.delete(child.room_id);
      } catch (err) {
        log.warn("cascade delete child failed", child?.room_id, err?.message || err);
      }
    }
    const room = this.get(id);
    if (!room) return false;
    try {
      room.dispose?.();
      this.store?.deleteRoom?.(id);
      // 房间删除后它的 room 作用域记忆就成了孤儿：一并清理（逐条留审计，见 src/memory.js clear）。
      this.memory?.clear?.({ scope: "room", roomId: id, source: "system", reason: "房间已删除" });
    } catch (err) {
      log.warn("delete room failed", err?.message || err);
    }
    return this.rooms.delete(String(id));
  }

  dispose() {
    for (const room of this.rooms.values()) {
      try {
        room.dispose?.();
      } catch {
        /* ignore */
      }
    }
    this.rooms.clear();
  }
}

export function createRoomManager(deps) {
  return new RoomManager(deps);
}

export default RoomManager;
