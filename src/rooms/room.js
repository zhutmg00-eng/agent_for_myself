/**
 * Group-chat room orchestration — the product vision layered on pi.
 *
 * Behavioral contract: docs/CONTRACT_ROOM.md (reverse-engineered from the previous
 * Python implementation) with the dispatch-orchestrator plumbing simplified:
 * our boss simply speaks first and uses `room_assign_task`, after which only the
 * assigned members speak.
 *
 * Vision mapping
 *   a. boss grants permissions / assigns tasks / decides context sharing  → owner + permissions + context_policy
 *   b. group file space with a librarian, real-time path sync             → FileSpace + file_moved notice
 *   c. each member has a distinctive identity                             → archetype emoji/color/badge
 *   d. members can pull a sub-group for a specific question               → createSubgroup + subgroup_report
 */
import path from "node:path";
import { DIRS } from "../config.js";
import { createLogger } from "../log.js";
import { FileSpace } from "./files.js";
import { createRoomTools } from "./tools.js";
import { createRoomContext } from "./context.js";
import { createEvidence } from "./evidence.js";
import { planTasks } from "./fanout.js";
import { createExecutionPlan, nextReady, markResult, isComplete, summarize as summarizePlan } from "./executor.js";
import { evaluateLearningGate, buildSkillDraft } from "../skills/learn.js";
import { judgeReviewer } from "../skills/judge.js";
import { defaultPermissions } from "../store.js";
import { BotRunner } from "../engine/bot.js";

const log = createLogger("room");

const TRANSCRIPT_CHAR_BUDGET = 12_000;
const TRANSCRIPT_SUMMARY_BUDGET = 6_000;
const MAX_TURNS_FACTOR = 4;
const RELAY_LIMIT_FACTOR = 3;
const MENTION_RE = /@([a-zA-Z0-9_-]+)/g;

function nowIso() {
  return new Date().toISOString();
}

/** 把 judgeReviewer 的结果压成可放进事件/日志的小对象。 */
function verdictSummary(judgement) {
  if (!judgement || typeof judgement !== "object") return null;
  return {
    verdict: judgement.verdict ?? null,
    reviewer: judgement.reviewer ?? null,
    matched: judgement.matched ?? null,
  };
}

function truncate(text, max) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

export class Room {
  /**
   * @param {{record:object, store:object, events:object, engine:object, hooks?:object,
   *          skills?:object, archetypes?:object, manager?:object}} options
   */
  constructor({ record, store, events, engine, hooks, skills, archetypes, manager, approval, memory, telemetry } = {}) {
    if (!record || !record.room_id) throw new Error("Room requires a record with room_id");
    this.store = store;
    this.events = events;
    this.engine = engine;
    this.hooks = hooks;
    this.skills = skills;
    this.archetypes = archetypes;
    this.manager = manager;
    // 审批 / 记忆 / 技能遥测：整进程单例，由 createApp 注入（见 docs/hermes/*.md 的接入清单）。
    this.approval = approval || manager?.approval || null;
    this.memory = memory || manager?.memory || null;
    this.telemetry = telemetry || manager?.telemetry || null;

    this.room_id = String(record.room_id);
    this.title = record.title || "";
    this.owner_id = record.owner_id || null;
    this.parent_room_id = record.parent_room_id || null;
    this.topic = record.topic || "";
    this.context_policy = ["shared", "summary", "isolated"].includes(record.context_policy)
      ? record.context_policy
      : "shared";
    this.status = record.status || "active";
    // 房间级设置（Hermes 式工具面裁剪等）；旧库没有该列时为空对象。
    this.settings = record.settings && typeof record.settings === "object" ? { ...record.settings } : {};
    this.created_at = record.created_at || nowIso();
    this.updated_at = record.updated_at || this.created_at;

    /** @type {string[]} member ids; order is the default speaking order */
    this.members = [];
    /** @type {Record<string, object>} */
    this.member_permissions = {};
    /** @type {Array<{speaker:string,content:string,kind:string,timestamp:string}>} */
    this.message_log = [];
    /** @type {string[]} */
    this.speaking_slots = [];
    /** @type {Record<string,string[]>} bot_id → tasks */
    this.pending_assignments = {};
    /** @type {string[]} */
    this.system_notices = [];
    /** @type {string[]} 活跃小群 id */
    this.child_rooms = [];
    /** @type {Array<{id:string, bot_id:string, write_scope:string[], depends_on:string[]}>} 本轮任务单元（fanout 契约） */
    this.task_plan = [];
    /** @type {string[]} 已回收的小群 id（最近 50 个，持久化到 kv，便于追溯） */
    this.subgroup_history = this._loadSubgroupHistory();
    this.relays = 0;
    this.relay_limit = RELAY_LIMIT_FACTOR * Math.max(1, this.members.length);
    this.round_running = 0;
    this.pending_rounds = 0;
    this.last_round_id = null;
    this._runners = new Map(); // botId → BotRunner
    this._fileSpace = null;
    this._context = null;
    this._evidence = null;
    this._speaking = false;
    this._queue = Promise.resolve();
  }

  /* --------------------------------------------------------------- wiring */

  get threadId() {
    return `room:${this.room_id}`;
  }

  get fileSpace() {
    if (!this._fileSpace) {
      this._fileSpace = new FileSpace({
        roomId: this.room_id,
        root: path.join(DIRS.rooms, this.room_id, "files"),
        store: this.store,
        events: this.events,
      });
    }
    return this._fileSpace;
  }

  /**
   * 房间上下文装配器（水位 + 确定性摘要 + 预算裁剪，见 src/rooms/context.js）。
   * 懒创建：没有 store 的测试房间不构造，退化为旧 renderTranscript。
   */
  get roomContext() {
    if (!this._context) {
      try {
        this._context = createRoomContext({ store: this.store, roomId: this.room_id });
      } catch (err) {
        log.warn("room context unavailable; falling back to transcript", err?.message || err);
        this._context = null;
      }
    }
    return this._context;
  }

  /** 证据阶梯记录器（observed / prepared / mismatch，见 src/rooms/evidence.js）。 */
  get evidenceStore() {
    if (!this._evidence) {
      try {
        this._evidence = createEvidence({ store: this.store });
      } catch (err) {
        log.warn("evidence store unavailable", err?.message || err);
        this._evidence = null;
      }
    }
    return this._evidence;
  }

  isOwner(botId) {
    return Boolean(this.owner_id) && String(botId) === String(this.owner_id);
  }

  botArchetype(botId) {
    const bot = this.botRecord(botId);
    return bot?.archetype || bot?.id || "general";
  }

  botRecord(botId) {
    try {
      const stored = this.store?.getBot?.(botId);
      if (stored) return stored;
    } catch {
      /* ignore */
    }
    const build = this.archetypes?.buildBot;
    if (typeof build === "function") {
      try {
        return build(botId);
      } catch {
        /* ignore */
      }
    }
    return { id: botId, name: botId, archetype: botId };
  }

  permissionsOf(botId) {
    return this.member_permissions[String(botId)] || defaultPermissions();
  }

  listMembers() {
    return this.members.map((bot_id) => ({
      bot_id,
      permissions: this.permissionsOf(bot_id),
      is_owner: this.isOwner(bot_id),
    }));
  }

  async loadMembers() {
    const rows = this.store?.listRoomMembers?.(this.room_id) || [];
    this.members = rows.map((r) => r.bot_id);
    this.member_permissions = {};
    for (const row of rows) {
      this.member_permissions[row.bot_id] = { ...defaultPermissions(), ...(row.permissions || {}) };
    }
    if (this.isOwner(this.owner_id) && this.member_permissions[this.owner_id]) {
      // The owner keeps an explicit sub-group capability by default (vision: boss can split work).
      this.member_permissions[this.owner_id].can_create_subgroup = true;
    }
    this.speaking_slots = [...this.members];
    this.relay_limit = RELAY_LIMIT_FACTOR * Math.max(1, this.members.length);
    return this;
  }

  /** Restore the transcript tail from SQLite (fresh process). */
  async loadHistory(limit = 1000) {
    const rows = this.store?.listRoomMessages?.(this.room_id, limit) || [];
    this.message_log = rows.map((m) => ({
      speaker: m.speaker,
      content: m.content,
      kind: m.kind || (m.speaker === "user" ? "user" : "assistant"),
      timestamp: m.ts || nowIso(),
    }));
    return this;
  }

  /* ------------------------------------------------------------- snapshot */

  snapshot() {
    return {
      room_id: this.room_id,
      title: this.title,
      members: [...this.members],
      owner_id: this.owner_id,
      parent_room_id: this.parent_room_id,
      topic: this.topic,
      context_policy: this.context_policy,
      settings: { ...this.settings },
      orchestrator_mode: this.owner_id ? "dispatch" : "legacy",
      status: this.status,
      relays: this.relays,
      child_rooms: [...(this.child_rooms || [])],
      subgroup_history: [...(this.subgroup_history || [])],
      message_count: this.message_log.length,
      file_count: this.store?.listRoomFiles?.(this.room_id)?.length || 0,
      updated_at: this.updated_at,
      created_at: this.created_at,
      member_permissions: Object.fromEntries(
        this.members.map((m) => [m, { ...this.permissionsOf(m) }]),
      ),
    };
  }

  async emit(kind, payload = {}, sender = "group_room") {
    try {
      return await this.events?.publish?.({
        topic: `room.${this.room_id}.${kind}`,
        sender,
        payload,
        thread_id: this.threadId,
      });
    } catch (err) {
      log.warn("emit failed", kind, err?.message || err);
      return null;
    }
  }

  async touch() {
    this.updated_at = nowIso();
    try {
      this.store?.touchRoom?.(this.room_id);
    } catch {
      /* ignore */
    }
    await this.emit("updated", this.snapshot(), "server");
  }

  /* --------------------------------------------------------- mutations API */

  /**
   * 分派任务（带 fanout 契约：任务单元 id / 写域 / 依赖）。
   *
   * 为什么要校验：两个成员同时写同一片区域是群聊里最贵的错误（互相覆盖、结论不可复现）。
   * Hermes/omh 的纪律是「写域重叠且无依赖 → 硬报错」；这里在**分派时**就拒绝，让群主在
   * 工具结果里看到原因并改成分步（给 later 任务加 depends_on），而不是等冲突发生。
   */
  async assignTask(botId, task, { id = null, writeScope = [], dependsOn = [] } = {}) {
    const member = String(botId);
    if (!this.members.includes(member)) throw new Error(`成员不在群里：${member}`);
    const unit = {
      id: String(id || `t${(this.task_plan?.length || 0) + 1}`),
      bot_id: member,
      write_scope: (Array.isArray(writeScope) ? writeScope : [writeScope]).map(String).filter(Boolean),
      depends_on: (Array.isArray(dependsOn) ? dependsOn : [dependsOn]).map(String).filter(Boolean),
    };
    const nextPlan = [...(this.task_plan || []), unit];
    const plan = planTasks({ tasks: nextPlan, members: this.members });
    if (!plan.ok) {
      const detail = plan.errors.map((e) => e.message || e.code).join("；");
      const err = new Error(`分派被拒绝（任务单元契约）：${detail}`);
      err.code = "fanout_invalid";
      err.errors = plan.errors;
      throw err;
    }
    this.task_plan = nextPlan;
    if (!this.pending_assignments[member]) this.pending_assignments[member] = [];
    this.pending_assignments[member].push(String(task));
    await this.emit("task_assigned", {
      member,
      task: truncate(String(task), 400),
      task_id: unit.id,
      write_scope: [...unit.write_scope],
      depends_on: [...unit.depends_on],
    });
    return { status: "assigned", room_id: this.room_id, member, task: String(task), task_id: unit.id };
  }

  /** 按 fanout 拓扑序给出「本轮该先跑哪些成员」；没有计划时返回空数组（回落到分派顺序）。 */
  taskPlanBotOrder() {
    if (!this.task_plan?.length) return [];
    try {
      const plan = planTasks({ tasks: this.task_plan, members: this.members });
      if (!plan.ok) return [];
      const byId = new Map(plan.units.map((u) => [u.id, String(u.bot_id)]));
      const bots = [];
      for (const unitId of plan.order) {
        const bot = byId.get(unitId);
        if (bot && !bots.includes(bot)) bots.push(bot);
      }
      return bots;
    } catch {
      return [];
    }
  }

  async grantPermission(botId, patch = {}) {
    const id = String(botId);
    const current = this.permissionsOf(id);
    const next = { ...current };
    if (patch.can_speak !== undefined) next.can_speak = Boolean(patch.can_speak);
    if (patch.context_access !== undefined) {
      const value = String(patch.context_access);
      if (["full", "summary", "none"].includes(value)) next.context_access = value;
    }
    if (patch.can_create_subgroup !== undefined) next.can_create_subgroup = Boolean(patch.can_create_subgroup);
    if (Array.isArray(patch.allowed_tool_overrides)) next.allowed_tool_overrides = patch.allowed_tool_overrides.map(String);
    this.member_permissions[id] = next;
    try {
      this.store?.setMemberPermissions?.(this.room_id, id, next);
    } catch (err) {
      log.warn("persist permission failed", err?.message || err);
    }
    await this.emit("permission_changed", { member: id, permissions: next });
    this.refreshRunnerTools(id);
    return next;
  }

  async revokePermission(botId, key) {
    const id = String(botId);
    const next = { ...this.permissionsOf(id) };
    if (key === "can_speak") next.can_speak = false;
    else if (key === "can_create_subgroup") next.can_create_subgroup = false;
    else if (key === "context_access") next.context_access = "none";
    else if (key === "allowed_tool_overrides") next.allowed_tool_overrides = null;
    else throw new Error(`未知权限：${key}`);
    this.member_permissions[id] = next;
    try {
      this.store?.setMemberPermissions?.(this.room_id, id, next);
    } catch {
      /* ignore */
    }
    await this.emit("permission_changed", { member: id, permissions: next });
    this.refreshRunnerTools(id);
    return next;
  }

  async setContextPolicy(policy) {
    const value = String(policy || "");
    if (!["shared", "summary", "isolated"].includes(value)) throw new Error(`非法上下文策略：${policy}`);
    this.context_policy = value;
    try {
      this.store?.upsertRoom?.({ ...this.snapshot(), context_policy: value });
    } catch {
      /* ignore */
    }
    await this.emit("context_policy_changed", { policy: value });
    return value;
  }

  async setTopic(topic) {
    this.topic = truncate(String(topic || ""), 200);
    try {
      this.store?.upsertRoom?.({ ...this.snapshot(), topic: this.topic });
    } catch {
      /* ignore */
    }
    await this.touch();
    return this.topic;
  }

  async setTitle(title) {
    this.title = truncate(String(title || ""), 80);
    try {
      this.store?.upsertRoom?.({ ...this.snapshot(), title: this.title });
    } catch {
      /* ignore */
    }
    await this.touch();
    return this.title;
  }

  /**
   * 合并房间级设置（`disabled_toolsets`、上下文预算等）并热更新每个成员的 pi 会话工具面。
   *
   * 为什么热更新：pi 的 `setActiveToolsByName` 是唯一能在会话中途改工具面的入口；
   * 重建会话会丢历史。工具面变窄只会让调用被拒，不会让模型"忘记"已有上下文。
   */
  async setSettings(patch = {}) {
    const next = { ...this.settings, ...(patch && typeof patch === "object" ? patch : {}) };
    if (Array.isArray(next.disabled_toolsets)) {
      next.disabled_toolsets = next.disabled_toolsets.map(String).filter(Boolean);
    }
    this.settings = next;
    try {
      this.store?.upsertRoom?.({ ...this.snapshot(), settings: next });
    } catch (err) {
      log.warn("persist room settings failed", err?.message || err);
    }
    for (const id of this.members) {
      const runner = this._runners.get(String(id));
      if (runner) {
        runner.disabledToolsets = Array.isArray(next.disabled_toolsets) ? [...next.disabled_toolsets] : [];
        try {
          runner.setActiveTools?.(runner.activeToolNames());
        } catch (err) {
          log.warn("apply room settings to runner failed", id, err?.message || err);
        }
      }
    }
    await this.touch();
    return next;
  }

  async addMember(botId, permissions) {
    const id = String(botId);
    if (this.members.includes(id)) return this.permissionsOf(id);
    this.members.push(id);
    this.speaking_slots.push(id);
    this.member_permissions[id] = defaultPermissions(permissions || {});
    try {
      this.store?.setMemberPermissions?.(this.room_id, id, this.member_permissions[id]);
    } catch {
      /* ignore */
    }
    await this.touch();
    return this.member_permissions[id];
  }

  /* --------------------------------------------------------------- runner */

  runnerFor(botId) {
    const id = String(botId);
    let runner = this._runners.get(id);
    if (runner) return runner;
    const bot = this.botRecord(id);
    const permissions = this.permissionsOf(id);
    const archetype = this.botArchetype(id);
    const customTools = createRoomTools({
      room: this,
      botId: id,
      permissions: { ...permissions, archetype },
      fileSpace: this.fileSpace,
      skills: this.skills,
      memory: this.memory,
      telemetry: this.telemetry,
    });
    runner = new BotRunner({
      bot,
      engine: this.engine,
      store: this.store,
      events: this.events,
      hooks: this.hooks,
      skills: this.skills,
      approval: this.approval,
      disabledToolsets: Array.isArray(this.settings?.disabled_toolsets) ? this.settings.disabled_toolsets : undefined,
      roomContext: { roomId: this.room_id },
      customTools,
      tools: bot?.tools,
    });
    this._runners.set(id, runner);
    return runner;
  }

  refreshRunnerTools(botId) {
    const runner = this._runners.get(String(botId));
    if (!runner) return;
    try {
      const customTools = createRoomTools({
        room: this,
        botId: String(botId),
        permissions: { ...this.permissionsOf(botId), archetype: this.botArchetype(botId) },
        fileSpace: this.fileSpace,
        skills: this.skills,
        memory: this.memory,
        telemetry: this.telemetry,
      });
      runner.setCustomTools?.(customTools);
      const names = (customTools || []).map((t) => t.name);
      runner.setActiveTools?.(names);
    } catch (err) {
      log.warn("refreshRunnerTools failed", err?.message || err);
    }
  }

  dispose() {
    for (const runner of this._runners.values()) {
      try {
        runner.dispose?.();
      } catch {
        /* ignore */
      }
    }
    this._runners.clear();
  }

  /* ------------------------------------------------------ context assembly */

  effectiveContextLevel(botId) {
    if (this.context_policy === "isolated") return "none";
    const access = this.permissionsOf(botId).context_access || "full";
    if (access === "none") return "none";
    if (this.context_policy === "summary" || access === "summary") return "summary";
    return "full";
  }

  renderTranscript(botId) {
    const level = this.effectiveContextLevel(botId);
    if (level === "none") return "";
    const records = this.message_log;
    if (!records.length) return "";
    if (level === "summary") {
      const chosen = records.length <= 6 ? [...records] : [...records.slice(0, 2), ...records.slice(-4)];
      const omitted = records.length <= 6 ? 0 : records.length - 6;
      const lines = [];
      if (omitted) lines.push(`……（早前 ${omitted} 条发言已省略）……`);
      let used = lines.reduce((n, l) => n + l.length, 0);
      for (const record of chosen) {
        const line = `[${record.speaker || "?"}] ${truncate(record.content, 300)}`;
        lines.push(line);
        used += line.length;
        if (used > TRANSCRIPT_SUMMARY_BUDGET) break;
      }
      return lines.join("\n");
    }
    // full
    const lines = [];
    let used = 0;
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const record = records[i];
      const line = `[${record.speaker || "?"}] ${record.content ?? ""}`;
      if (used + line.length > TRANSCRIPT_CHAR_BUDGET && lines.length) break;
      lines.push(line);
      used += line.length;
    }
    return lines.reverse().join("\n");
  }

  fileIndexText() {
    const files = this.store?.listRoomFiles?.(this.room_id) || [];
    if (!files.length) return "";
    return files
      .map((f) => `- ${f.file_id}: ${f.path}${f.description ? `（${f.description}）` : ""}`)
      .join("\n");
  }

  /**
   * 注入持久记忆块（对齐 Hermes memory_manager 的注入语义：置顶优先、按预算截断）。
   *
   * 为什么每轮现取而不是塞进 system prompt：群聊是多人共享会话，记忆会随回合变化；
   * 塞进 system prompt 会让 pi 的 prompt 前缀缓存失效（Hermes 第一条不变量）。
   * 三级 scope 依次拼接：房间事实 → 本成员记忆 → 全局。任一取用失败都不阻断回合。
   */
  memoryBlock(botId) {
    const memory = this.memory;
    if (!memory?.contextBlock) return "";
    const parts = [];
    const take = (label, options) => {
      try {
        const block = String(memory.contextBlock(options) || "").trim();
        if (block) parts.push(`${label}\n${block}`);
      } catch (err) {
        log.warn("memory contextBlock failed", err?.message || err);
      }
    };
    take("=== 本群记忆（room scope） ===", { scope: "room", roomId: this.room_id, budgetChars: 1400 });
    take("=== 你的长期记忆（bot scope） ===", { scope: "bot", botId, budgetChars: 800 });
    take("=== 全局记忆（global scope） ===", { scope: "global", budgetChars: 600 });
    if (!parts.length) return "";
    return `${parts.join("\n\n")}\n（以上是持久记忆，不是本轮发言；与本轮任务无关时可忽略。）`;
  }

  /**
   * 组装一次注入的共享上下文（Hermes 水位/摘要/预算语义，实现见 src/rooms/context.js）。
   * 返回 `throughSeq` 供调用方在注入后推进水位；任何异常都退化为旧 renderTranscript。
   */
  composeContext(botId, roundMessage = "") {
    const level = this.effectiveContextLevel(botId);
    if (level === "none") return { text: "", throughSeq: 0 };
    const ctx = this.roomContext;
    if (ctx) {
      try {
        const budget = Math.max(600, Number(this.settings?.context_budget) || 6000);
        const out = ctx.compose(botId, { level, roundMessage, budget }) || {};
        return { text: String(out.text || ""), throughSeq: Number(out.stats?.throughSeq) || 0 };
      } catch (err) {
        log.warn("context compose failed; falling back to transcript", err?.message || err);
      }
    }
    return { text: this.renderTranscript(botId), throughSeq: 0 };
  }

  /** Build one member's turn instruction (CONTRACT_ROOM §4.3 templates). */
  buildInstruction(botId, { task = null, roundMessage = "", contextText = null } = {}) {
    const sections = [];
    const transcript = contextText === null ? this.renderTranscript(botId) : String(contextText);
    const titleSuffix = this.title ? `：${this.title}` : "";
    if (transcript) sections.push(`=== 群聊共享上下文（房间 ${this.room_id}${titleSuffix}） ===\n${transcript}`);
    const memoryText = this.memoryBlock(botId);
    if (memoryText) sections.push(memoryText);
    if (this.owner_id && botId !== this.owner_id) {
      sections.push(`当前群主（老板）：${this.owner_id}。它负责分派任务与授权；按其分派执行。`);
    }
    if (this.system_notices.length) {
      sections.push(`=== 系统通知 ===\n${this.system_notices.map((n) => `- ${n}`).join("\n")}`);
    }
    const assignments = this.pending_assignments[botId] || [];
    const deliveredAssignments = task ? [task] : assignments.splice(0, assignments.length);
    if (deliveredAssignments.length) {
      sections.push(`=== 群主分派给你的任务 ===\n${deliveredAssignments.map((a) => `- ${a}`).join("\n")}`);
    }
    const index = this.fileIndexText();
    if (index) {
      sections.push(
        `=== 群文件空间（按 file_id 引用，路径可能被文件管家调整，永远以本清单为准） ===\n${index}`,
      );
    }
    if (this.topic) sections.push(`=== 群主题 ===\n${this.topic}`);
    sections.push(`=== 本轮消息 ===\n${roundMessage}`);
    if (this.isOwner(botId)) {
      sections.push(
        [
          "你是本群的群主（老板）。你的职责是拆解目标、用 room_assign_task 给成员分派具体任务、必要时用 room_grant_permission 调整权限/room_set_context_policy 调整上下文共享、需要时用 room_create_subgroup 拉小群。",
          "本轮请先用一两句话说明你的判断与分派（谁做什么、验收标准），然后调用工具完成分派。不要亲自写文件或跑命令。",
        ].join("\n"),
      );
    } else {
      sections.push("请以群成员身份回应本轮消息：直接给出结论/产出，简洁专业，必要时 @提及相关成员。");
    }
    return sections.join("\n\n");
  }

  /* ------------------------------------------------------------------ say */

  /** Append a user message and schedule a round (does not block on the round). */
  async say({ speaker = "user", content } = {}) {
    const text = String(content ?? "").trim();
    if (!text) throw new Error("content is required");
    const record = {
      speaker,
      content: text,
      kind: speaker === "user" ? "user" : "assistant",
      timestamp: nowIso(),
    };
    this.message_log.push(record);
    try {
      this.store?.appendRoomMessage?.(this.room_id, { speaker, content: text, kind: record.kind, ts: record.timestamp });
    } catch (err) {
      log.warn("persist user message failed", err?.message || err);
    }
    this.relays = 0;
    this.status = "active";
    this.updated_at = record.timestamp;
    this.mentionMembers(text, speaker);
    await this.emit("turn_completed", { ...record });
    await this.emit("circuit_breaker_reset", { reset_by: speaker });
    this.pending_rounds += 1;
    this.enqueueRound(text);
    return { status: "accepted", room_id: this.room_id };
  }

  enqueueRound(instruction) {
    this._queue = this._queue
      .then(() => this.runRound({ instruction }))
      .catch((err) => log.error("round failed", err?.stack || err));
    return this._queue;
  }

  mentionMembers(text, speaker) {
    const found = new Set();
    for (const match of String(text).matchAll(MENTION_RE)) {
      const mentioned = match[1];
      if (mentioned === speaker) continue;
      if (!this.members.includes(mentioned)) continue;
      found.add(mentioned);
      if (!this.speaking_slots.includes(mentioned)) continue;
      this.speaking_slots.splice(this.speaking_slots.indexOf(mentioned), 1);
      this.speaking_slots.unshift(mentioned);
      this.emit("member_mentioned", { speaker, mentioned });
    }
    return [...found];
  }

  /* ----------------------------------------------------------------- round */

  async runRound({ instruction } = {}) {
    const roundId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.last_round_id = roundId;
    this.round_running += 1;
    this.pending_rounds = Math.max(0, this.pending_rounds - 1);
    this.system_notices = [];
    // Load undrained notices for this round (file moves, sub-group reports, ...).
    try {
      const notices = this.store?.drainNotices?.(this.room_id) || [];
      for (const n of notices) if (n.text) this.system_notices.push(n.text);
    } catch (err) {
      log.warn("drainNotices failed", err?.message || err);
    }

    const startedAt = Date.now();
    const roundMessage = String(instruction || "");
    const mentionList = [...String(roundMessage).matchAll(MENTION_RE)].map((m) => m[1]);
    await this.emit("round_started", {
      round_id: roundId,
      instruction: truncate(roundMessage, 500),
      members: [...this.members],
      context_policy: this.context_policy,
      settings: { ...this.settings },
      orchestrator_mode: this.owner_id ? "dispatch" : "legacy",
    });

    const spoken = [];
    const seen = new Set();
    const assignmentOrder = [];
    // 每轮重新声明任务单元（群主在本轮 assign / depends_on 里定义）。
    this.task_plan = [];
    // 执行短路状态机（src/rooms/executor.js）：失败会沿依赖边跳过下游。
    this._executionPlan = null;
    // 本轮回合（供学习闭环判断质量）与证据状态。
    this._round_turns = [];
    let assignedMode = false;
    let paused = false;
    let guard = 0;
    const maxTurns = Math.max(1, this.speaking_slots.length * MAX_TURNS_FACTOR);

    // Owner first when the message carries no explicit @mention.
    if (this.owner_id && this.speaking_slots.includes(this.owner_id) && !mentionList.length) {
      this.speaking_slots = [this.owner_id, ...this.speaking_slots.filter((m) => m !== this.owner_id)];
    }

    try {
      while (guard < maxTurns) {
        guard += 1;
        // fanout 拓扑序优先（写域/依赖决定先后），未纳入计划的成员回落到分派顺序。
        for (const planned of this.taskPlanBotOrder()) {
          if ((this.pending_assignments[planned] || []).length && !assignmentOrder.includes(planned)) {
            assignmentOrder.push(planned);
          }
        }
        for (const candidate of Object.keys(this.pending_assignments)) {
          if (!assignmentOrder.includes(candidate)) assignmentOrder.push(candidate);
        }
        const pendingNext = assignmentOrder.find(
          (b) => (this.pending_assignments[b] || []).length > 0 && !seen.has(b),
        );
        if (Object.values(this.pending_assignments).some((list) => list.length)) assignedMode = true;

        // 执行短路：声明了任务单元时，只跑「依赖已全部成功」的单元对应成员；被上游失败跳过的成员不跑。
        this._refreshExecutionPlan();
        let nextId = null;
        if (this.task_plan.length && this._executionPlan) nextId = this._readyBot(seen);
        if (!nextId) {
          nextId = assignedMode ? pendingNext : this.speaking_slots.find((b) => !seen.has(b));
        }
        if (!nextId) break;
        seen.add(nextId);

        if (!this.members.includes(nextId)) continue;
        if (this.permissionsOf(nextId).can_speak === false) continue;
        if (this.status === "paused") {
          paused = true;
          break;
        }

        const runner = this.runnerFor(nextId);
        const ctxPack = this.composeContext(nextId, roundMessage);
        const memberInstruction = this.buildInstruction(nextId, { roundMessage, contextText: ctxPack.text });
        // 指令已交给成员即推进水位：被 budget 裁掉的消息不会被误标已读（throughSeq 由 context.js 给出）。
        if (ctxPack.throughSeq > 0) {
          try {
            this.roomContext?.markInjected(nextId, ctxPack.throughSeq);
          } catch (err) {
            log.warn("markInjected failed", err?.message || err);
          }
        }
        await this.emit("member_started", { member: nextId, round_id: roundId });

        let result = { text: "", error: null, ms: 0, usage: null };
        try {
          result = await runner.run({ prompt: memberInstruction, onToolEvent: () => {} });
        } catch (err) {
          result = { text: "", error: err?.message || String(err), ms: 0, usage: null };
        }
        await this.emit("member_finished", { member: nextId, round_id: roundId, ms: result?.ms || 0 });

        const text = String(result?.text || "").trim();
        if (result?.error) {
          this.system_notices.push(`成员 ${nextId} 本轮执行失败：${truncate(result.error, 300)}`);
          log.warn("member failed", nextId, result.error);
        }
        // 先把这一步的成败写进执行计划：失败会立刻把下游标成 skipped（兄弟分支不受影响）。
        this._markTaskResult(seen, nextId, {
          ok: Boolean(text) && !result?.error,
          reason: result?.error || (text ? null : "没有产出文本"),
        });
        if (!text) {
          if (!result?.error) this.system_notices.push(`成员 ${nextId} 本轮没有产出文本。`);
          continue;
        }

        this.relays += 1;
        if (this.relays >= this.relay_limit) {
          this.status = "paused";
          paused = true;
          await this.emit("circuit_breaker_tripped", { relays: this.relays, limit: this.relay_limit });
          break;
        }

        const record = { speaker: nextId, content: text, kind: "assistant", timestamp: nowIso() };
        this.message_log.push(record);
        this.updated_at = record.timestamp;
        let messageSeq = null;
        try {
          const saved = this.store?.appendRoomMessage?.(this.room_id, {
            speaker: nextId,
            content: text,
            kind: "assistant",
            ts: record.timestamp,
          });
          messageSeq = Number(saved?.seq) || null;
        } catch (err) {
          log.warn("persist member message failed", err?.message || err);
        }
        // 证据阶梯：用真实的工具结局（BotRunner.toolResults）判定 observed / prepared / mismatch。
        let evidenceStatus = null;
        if (messageSeq) {
          try {
            const verdict = this.evidenceStore?.record({
              roomId: this.room_id,
              botId: nextId,
              messageSeq,
              text,
              toolCalls: Array.isArray(result?.toolResults) ? result.toolResults : [],
            });
            evidenceStatus = verdict?.status || null;
          } catch (err) {
            log.warn("evidence record failed", err?.message || err);
          }
        }
        this.mentionMembers(text, nextId);
        spoken.push(nextId);
        this._round_turns.push({
          bot_id: nextId,
          text,
          evidence: evidenceStatus,
          ms: Number(result?.ms) || 0,
        });
        await this.emit("turn_completed", { ...record, ...(messageSeq ? { seq: messageSeq } : {}), ...(evidenceStatus ? { evidence: evidenceStatus } : {}) });
      }
    } catch (err) {
      log.error("round loop failed", err?.stack || err);
    } finally {
      this.round_running = Math.max(0, this.round_running - 1);
      await this.emit("round_completed", {
        round_id: roundId,
        speakers: spoken,
        paused: paused || this.status !== "active",
        spawned_children: [...this.child_rooms],
        ms: Date.now() - startedAt,
      });
    }

    // 学习闭环：回合质量达标时把这次经验沉淀成一条技能提案（不自动 adopt）。
    try {
      const learned = await this.proposeLearningSkill({ instruction: roundMessage, roundId });
      if (learned?.ok) log.info(`learning proposal created: ${learned?.proposal?.id || "?"}`);
    } catch (err) {
      log.warn("learning proposal failed", err?.message || err);
    }
    return spoken;
  }

  /* --------------------------------------------------------- executor / learn */

  /** 用当前 task_plan 重建执行计划（每轮/每次分派后变化）。 */
  _refreshExecutionPlan() {
    const tasks = Array.isArray(this.task_plan) ? this.task_plan : [];
    if (!tasks.length) {
      this._executionPlan = null;
      return null;
    }
    try {
      this._executionPlan = createExecutionPlan({
        units: tasks.map((t) => ({ id: t.id, bot_id: t.bot_id, depends_on: t.depends_on })),
        order: tasks.map((t) => t.id),
      });
    } catch (err) {
      log.warn("createExecutionPlan failed", err?.message || err);
      this._executionPlan = null;
    }
    return this._executionPlan;
  }

  /** 下一个可执行单元对应的成员（依赖全部成功、本人未跑过、且有分派）。 */
  _readyBot(seen) {
    const plan = this._executionPlan;
    if (!plan) return null;
    try {
      for (const unitId of nextReady(plan)) {
        const bot = String(plan.units?.[unitId]?.bot_id || "");
        if (!bot || seen.has(bot)) continue;
        if (!(this.pending_assignments[bot] || []).length) continue;
        return bot;
      }
    } catch (err) {
      log.warn("nextReady failed", err?.message || err);
    }
    return null;
  }

  /** 把一次成员回合的结果写进执行计划，并把新跳过的下游写进系统通知。 */
  _markTaskResult(seen, botId, { ok, reason = null } = {}) {
    const plan = this._executionPlan;
    if (!plan) return [];
    const ownUnits = (this.task_plan || []).filter((t) => String(t.bot_id) === String(botId)).map((t) => t.id);
    let current = plan;
    const skipped = [];
    for (const unitId of ownUnits) {
      if (!current.units?.[unitId]) continue;
      try {
        const res = markResult(current, unitId, { ok, reason });
        current = res.plan;
        skipped.push(...(res.skipped || []));
      } catch (err) {
        log.warn("markResult failed", unitId, err?.message || err);
      }
    }
    this._executionPlan = current;
    for (const unitId of [...new Set(skipped)]) {
      const bot = String(current.units?.[unitId]?.bot_id || "");
      if (!bot || seen.has(bot)) continue;
      seen.add(bot);
      const why = current.skippedReason?.[unitId] || "上游失败";
      this.system_notices.push(`任务 ${unitId}（${bot}）被跳过：${truncate(why, 120)}`);
      void this.emit("task_skipped", { task_id: unitId, member: bot, reason: truncate(why, 200) });
    }
    return skipped;
  }

  /** 本回合的证据统计（只统计本轮 turns，避免历史 mismatch 永久阻塞学习）。 */
  _roundEvidenceSummary(turns = []) {
    const summary = { observed: 0, prepared: 0, mismatch: 0, total: 0 };
    for (const turn of turns) {
      if (!["observed", "prepared", "mismatch"].includes(turn?.evidence)) continue;
      summary[turn.evidence] += 1;
      summary.total += 1;
    }
    return summary;
  }

  /** 最近一轮的成员回合（手动 /learn 与自动提案共用）。 */
  recentTurns({ max = 12 } = {}) {
    let rows = [];
    try {
      rows = this.store?.listRoomMessages?.(this.room_id, 300) || [];
    } catch (err) {
      log.warn("recentTurns list failed", err?.message || err);
      return [];
    }
    let start = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (String(rows[i].speaker) === "user") {
        start = i + 1;
        break;
      }
    }
    const evidenceBySeq = new Map();
    try {
      for (const rec of this.evidenceStore?.list?.({ roomId: this.room_id, limit: 500 }) || []) {
        evidenceBySeq.set(Number(rec.message_seq), rec.status);
      }
    } catch {
      /* evidence 不可用时按 null 处理 */
    }
    return rows
      .slice(start)
      .filter((row) => row.kind === "assistant")
      .slice(-max)
      .map((row) => ({
        bot_id: String(row.speaker),
        text: String(row.content || ""),
        evidence: evidenceBySeq.get(Number(row.seq)) ?? null,
        ms: 0,
      }));
  }

  /**
   * reviewer 的裁决（纯函数 `src/skills/judge.js`）。
   *
   * 相比旧的文本启发式，这里能区分三种状态：通过 / 不通过 / **未表态（null）**；
   * 未表态不会被当成通过（学习闸门会另外看 `reviewerPresent` 决定是否拦截）。
   */
  judgeReviewerTurn(turns = []) {
    const reviewerIds = (this.members || []).filter((id) => {
      const bot = String(id || "");
      return /review/i.test(bot) || /review/i.test(String(this.botArchetype?.(id) || ""));
    });
    try {
      return judgeReviewer({ turns, reviewerId: reviewerIds.length ? reviewerIds : null });
    } catch (err) {
      log.warn("judgeReviewer failed", err?.message || err);
      return { verdict: null, reviewer: null, matched: null, reasons: [] };
    }
  }

  /** 兼容旧调用：只要 verdict。 */
  _reviewerVerdict(turns = []) {
    return this.judgeReviewerTurn(turns).verdict;
  }

  /**
   * 学习闭环：质量达标 → 生成技能草稿 → curator.propose（人工 review 后才 adopt）。
   * @param {{instruction?:string, roundId?:string|null, turns?:object[], force?:boolean}} [opts]
   */
  async proposeLearningSkill({ instruction = "", roundId = null, turns = null, force = false } = {}) {
    const settings = this.settings || {};
    const mode = String(settings.auto_propose_skills || "observed");
    if (!force && mode === "off") return { ok: false, reason: "auto_propose_skills=off" };
    const curator = this.manager?.curator;
    if (!curator || typeof curator.propose !== "function") return { ok: false, reason: "curator 不可用" };

    const turnList = Array.isArray(turns) && turns.length ? turns : this._round_turns || [];
    const evidenceSummary = this._roundEvidenceSummary(turnList);
    const judgement = this.judgeReviewerTurn(turnList);
    const reviewerVerdict = judgement.verdict;
    const reviewerPresent = Boolean(judgement.reviewer);
    this._last_reviewer_judgement = judgement;
    // force（人工 /learn）只绕过「自动提案策略开关」，不绕过证据质量闸门：
    // 房间把自动提案关掉，不代表人不能手动沉淀；但「没有 observed / 有 mismatch」仍然拒绝学习。
    const gateSettings = force
      ? { ...settings, auto_propose_skills: mode === "off" ? "observed" : mode }
      : settings;
    const gate = evaluateLearningGate({
      turns: turnList,
      evidenceSummary,
      reviewerVerdict,
      reviewerPresent,
      settings: gateSettings,
    });
    if (!gate?.ok) {
      log.debug(`learning skipped: ${gate?.reason || "unknown"} (reviewer=${reviewerVerdict})`);
      return { ok: false, reason: gate?.reason || "学习闸门未通过", reviewer: verdictSummary(judgement) };
    }

    let files = [];
    try {
      files = this.store?.listRoomFiles?.(this.room_id) || [];
    } catch {
      files = [];
    }
    const draft = buildSkillDraft({
      instruction,
      roomId: this.room_id,
      roomTitle: this.title,
      topic: this.topic,
      members: this.members,
      turns: turnList,
      files,
      evidenceSummary,
      reviewerVerdict,
      // tags 是「提案元数据」，不参与 playbook 正文（否则正文会出现「关键词：auto」的噪声，且污染 signature）。
      tags: [],
    });
    if (!draft) return { ok: false, reason: "草稿为空" };

    const dedupeKey = `learn:sig:${this.room_id}:${draft.signature}`;
    try {
      if (this.store?.getKV?.(dedupeKey)) {
        return { ok: false, reason: "重复经验（signature 已存在）", duplicate: true, signature: draft.signature };
      }
    } catch {
      /* kv 不可用时继续提案 */
    }

    const proposal = curator.propose({
      title: draft.title,
      body: draft.body,
      evidence: [{ room_id: this.room_id, round_id: roundId, file_ids: files.map((f) => f.file_id) }],
      roomId: this.room_id,
      tags: [...draft.tags, this.topic || "", "auto"].filter(Boolean),
    });
    try {
      this.store?.setKV?.(dedupeKey, JSON.stringify({ proposal_id: proposal.id, ts: nowIso() }));
    } catch {
      /* ignore */
    }
    await this.emit("skill_proposed", {
      proposal_id: proposal.id,
      title: draft.title,
      signature: draft.signature,
      source: force ? "manual" : "round",
      reviewer: verdictSummary(judgement),
    });
    return { ok: true, proposal, draft, evidenceSummary, reviewerVerdict, reviewer: verdictSummary(judgement) };
  }

  /* ------------------------------------------------------------ sub-groups */

  /**
   * Create a sub-group, run one round in it, and report the conclusion back to
   * this room (vision point d).
   */
  async createSubgroup({ members = [], topic = "", question = "", actor = null } = {}) {
    const roomManager = this.manager;
    if (!roomManager || typeof roomManager.create !== "function") {
      throw new Error("小群能力不可用（RoomManager 未注入）");
    }
    const candidate = [...new Set(members.map(String))].filter((m) => this.members.includes(m) && m !== actor);
    const picked = candidate.length ? candidate : this.members.filter((m) => m !== actor);
    if (picked.length < 2) throw new Error("小群至少需要 2 名成员");

    const created = await roomManager.create({
      title: `小群 · ${truncate(topic || question || "讨论", 24)}`,
      owner_id: picked[0],
      members: picked,
      context_policy: "shared",
      topic: String(topic || ""),
      parent_room_id: this.room_id,
      is_subgroup: true,
    });
    const subId = created.room_id || created.roomId;
    const subRoom = roomManager.get(subId);
    this.child_rooms.push(subId);
    await this.emit("child_spawned", { child_room_id: subId, topic: String(topic || "") });

    const prompt = [
      `【小群讨论】主题：${topic || "（未命名）"}`,
      question ? `【要回答的问题】${question}` : "",
      this.topic ? `【父群主题】${this.topic}` : "",
      "请在座成员先各自给出观点，再由最后一位发言者汇总成一份可直接回传父群的结论（结论要包含：建议方案 / 关键取舍 / 待确认事项）。",
    ]
      .filter(Boolean)
      .join("\n");

    let report = "";
    try {
      if (subRoom?.say) {
        await subRoom.say({ speaker: "user", content: prompt });
        // `say` only schedules the round; wait for the room's round queue to settle.
        if (subRoom._queue) await subRoom._queue;
        const rows = subRoom.message_log.filter((r) => r.speaker !== "user");
        report = rows.map((r) => `${r.speaker}: ${r.content}`).join("\n\n");
      }
    } catch (err) {
      report = `（小群讨论失败：${err?.message || err}）`;
    }
    report = truncate(report || "（小群没有产出结论）", 2000);

    // Persist the conclusion into this room's transcript and notify everyone.
    const record = {
      speaker: `subgroup:${subId}`,
      content: `【小群结论 · ${topic || subId}】\n${report}`,
      kind: "result",
      timestamp: nowIso(),
    };
    this.message_log.push(record);
    try {
      this.store?.appendRoomMessage?.(this.room_id, {
        speaker: record.speaker,
        content: record.content,
        kind: "result",
        ts: record.timestamp,
      });
      this.store?.addNotice?.({
        parent_room_id: this.room_id,
        child_room_id: subId,
        kind: "subgroup_report",
        text: `小群 ${subId}（${topic || "讨论"}）已有结论，见群聊记录。`,
      });
    } catch (err) {
      log.warn("persist subgroup report failed", err?.message || err);
    }
    await this.emit("subgroup_report", { sub_room_id: subId, topic: topic || "", report });
    await this.emit("turn_completed", { ...record });

    // 小群默认是「一次性会议室」：结论已经回传父群，子房的常驻 session 与房间记录没有继续存在的必要。
    // 不回收会积累孤儿房间 + 每成员一个常驻 pi session（omh 分析在本项目里发现的真实泄漏）。
    // 想保留讨论记录可把房间设置 subgroup_lifecycle 设为 "keep"。
    const lifecycle = String(this.settings?.subgroup_lifecycle || "dispose");
    let retired = null;
    if (lifecycle === "dispose") {
      try {
        retired = this.retireSubgroup(subId);
      } catch (err) {
        log.warn("retire subgroup failed", subId, err?.message || err);
      }
    }
    return { room_id: subId, report, retired };
  }

  /**
   * 回收一个小群：释放它的常驻 pi 会话、删除房间记录，并把 id 记进 `subgroup_history`。
   * @param {string} subId
   * @returns {{room_id:string, disposed:boolean, deleted:boolean}}
   */
  retireSubgroup(subId) {
    const id = String(subId);
    const sub = this.manager?.get?.(id) || null;
    try {
      sub?.dispose?.();
    } catch (err) {
      log.warn("subgroup dispose failed", id, err?.message || err);
    }
    let deleted = false;
    try {
      deleted = Boolean(this.manager?.delete?.(id));
    } catch (err) {
      log.warn("subgroup delete failed", id, err?.message || err);
    }
    this.child_rooms = (this.child_rooms || []).filter((x) => String(x) !== id);
    this.subgroup_history = [...new Set([...(this.subgroup_history || []), id])].slice(-50);
    try {
      this.store?.setKV?.(`subgroup:history:${this.room_id}`, JSON.stringify(this.subgroup_history));
    } catch (err) {
      log.warn("persist subgroup history failed", err?.message || err);
    }
    return { room_id: id, disposed: true, deleted };
  }

  /** 从 kv 读回已回收小群列表（重启后仍可追溯）。 */
  _loadSubgroupHistory() {
    try {
      const raw = this.store?.getKV?.(`subgroup:history:${this.room_id}`);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.map(String).slice(-50) : [];
    } catch {
      return [];
    }
  }

  /* --------------------------------------------------------------- files */

  async recordFileEvent(kind, payload, sender = "librarian") {
    return this.emit(kind, payload, sender);
  }
}

export default Room;
