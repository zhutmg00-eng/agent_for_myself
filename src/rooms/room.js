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
import { DIRS, DEFAULT_TURN_TIMEOUT_MS } from "../config.js";
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

export { DEFAULT_TURN_TIMEOUT_MS };

/**
 * 5-tier precedence hierarchy for turn timeout:
 * 1. Explicit turnOptions: turnTimeoutMs or timeoutMs
 * 2. Member permissions: turn_timeout_seconds * 1000 or turn_timeout_ms
 * 3. Room settings: watchdog_timeout_ms or watchdog_timeout * 1000 or turn_timeout_seconds * 1000
 * 4. Environment: FUSION_WATCHDOG_TIMEOUT_MS or FUSION_WATCHDOG_TIMEOUT * 1000
 * 5. Default fallback: DEFAULT_TURN_TIMEOUT_MS (30,000ms)
 */
export function resolveTurnTimeoutMs(room, botId = null, turnOptions = {}) {
  if (Number.isFinite(turnOptions?.turnTimeoutMs) && turnOptions.turnTimeoutMs > 0) {
    return Number(turnOptions.turnTimeoutMs);
  }
  if (Number.isFinite(turnOptions?.timeoutMs) && turnOptions.timeoutMs > 0) {
    return Number(turnOptions.timeoutMs);
  }
  const perms = (botId && typeof room?.permissionsOf === "function"
    ? room.permissionsOf(botId)
    : (room?.member_permissions?.[botId] || room?._memberPermissions?.get?.(botId))) || null;
  if (Number.isFinite(perms?.turn_timeout_ms) && perms.turn_timeout_ms > 0) {
    return Number(perms.turn_timeout_ms);
  }
  if (Number.isFinite(perms?.turn_timeout_seconds) && perms.turn_timeout_seconds > 0) {
    return perms.turn_timeout_seconds * 1000;
  }
  const s = room?.settings || {};
  if (Number.isFinite(s.turn_timeout_ms) && s.turn_timeout_ms > 0) {
    return Number(s.turn_timeout_ms);
  }
  if (Number.isFinite(s.watchdog_timeout_ms) && s.watchdog_timeout_ms > 0) {
    return Number(s.watchdog_timeout_ms);
  }
  if (Number.isFinite(s.watchdog_timeout) && s.watchdog_timeout > 0) {
    return Number(s.watchdog_timeout) * 1000;
  }
  if (Number.isFinite(s.turn_timeout_seconds) && s.turn_timeout_seconds > 0) {
    return Number(s.turn_timeout_seconds) * 1000;
  }
  if (process.env.AGENT_TURN_TIMEOUT_MS) {
    const envMs = Number(process.env.AGENT_TURN_TIMEOUT_MS);
    if (Number.isFinite(envMs) && envMs > 0) return envMs;
  }
  if (process.env.FUSION_WATCHDOG_TIMEOUT_MS) {
    const envMs = Number(process.env.FUSION_WATCHDOG_TIMEOUT_MS);
    if (Number.isFinite(envMs) && envMs > 0) return envMs;
  }
  if (process.env.FUSION_WATCHDOG_TIMEOUT) {
    const envSec = Number(process.env.FUSION_WATCHDOG_TIMEOUT);
    if (Number.isFinite(envSec) && envSec > 0) return envSec * 1000;
  }
  return DEFAULT_TURN_TIMEOUT_MS;
}

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

/**
 * Evaluates whether an assistant turn made substantive forward progress.
 * @param {object} result
 * @param {object} [ctx]
 * @returns {{isProgress:boolean, grant:number, resetStagnant:boolean, tier:number, tierName:string, reason:string}}
 */
export function evalForwardProgress(result, ctx = {}) {
  if (result?.error && !result?.text) {
    return { isProgress: false, grant: 0, resetStagnant: false, tier: 0, tierName: "error", reason: "turn_error" };
  }

  const toolResults = Array.isArray(result?.toolResults) ? result.toolResults : [];
  const toolsUsed = Array.isArray(result?.toolsUsed) ? result.toolsUsed : [];
  const failedResults = toolResults.filter((t) => t && (t.ok === false || t.ok === 0 || t.error));
  const successfulTools = toolResults.filter((t) => t && (t.ok === true || t.ok === 1));

  // If there are only failed tool results, treat as failure (Tier 0)
  if (toolResults.length > 0 && failedResults.length === toolResults.length) {
    return { isProgress: false, grant: 0, resetStagnant: false, tier: 0, tierName: "tool_failure", reason: "all_tools_failed" };
  }

  // Tier 1: Mutating / execution tools
  const mutatingTools = [
    "write", "write_file", "edit", "edit_file", "bash", "powershell",
    "room_file_save", "room_file_move", "room_assign_task", "room_create_subgroup",
    "room_grant_permission", "room_revoke_permission", "room_set_context_policy"
  ];
  const hasMutating = successfulTools.some((t) => mutatingTools.includes(t.name)) ||
    toolsUsed.some((name) => mutatingTools.includes(name) && !result?.error);
  if (hasMutating) {
    return { isProgress: true, grant: 2, resetStagnant: true, tier: 1, tierName: "mutating_tool", reason: "executed_mutating_tool" };
  }

  // Tier 2: Observational / information retrieval tools
  const observationalTools = [
    "read", "read_file", "grep", "grep_search", "find", "find_by_name", "ls", "list_dir",
    "room_file_read", "room_file_list", "room_evidence_status", "skill_invoke", "memory"
  ];
  const hasObservational = successfulTools.some((t) => observationalTools.includes(t.name)) ||
    toolsUsed.some((name) => observationalTools.includes(name) && !result?.error);
  if (hasObservational) {
    return { isProgress: true, grant: 1, resetStagnant: true, tier: 2, tierName: "observational_tool", reason: "executed_observational_tool" };
  }

  // Tier 3: Substantive structured output without tools
  const text = String(result?.text || "").trim();
  const hasStructure = text.length >= 150 && (
    text.includes("```") ||
    text.includes("###") ||
    text.includes("【") ||
    (text.match(/^[-*]\s+/m) !== null) ||
    (text.match(/^\d+\.\s+/m) !== null)
  );
  const fp = text.toLowerCase().replace(/[\s\p{P}]+/gu, "");
  const fingerprints = ctx._round_turn_fingerprints || ctx.room?._round_turn_fingerprints || [];
  const isDuplicate = fingerprints.some((f) => f.hash === fp);
  if (hasStructure && !isDuplicate) {
    return { isProgress: true, grant: 1, resetStagnant: true, tier: 3, tierName: "structured_output", reason: "substantive_structured_text" };
  }

  // Tier 0: Chatter / trivial text
  return { isProgress: false, grant: 0, resetStagnant: false, tier: 0, tierName: "chatter", reason: "no_progress_chatter" };
}

/**
 * Detects semantic oscillation, ping-pong chatter, or tool call duplication loops.
 * @param {object} turn
 * @param {object} [ctx]
 * @returns {{isLoop:boolean, detected:boolean, type?:string, reason?:string}}
 */
export function detectInfiniteLoop(turn, ctx = {}) {
  const text = String(turn?.text || "").trim();
  const botId = String(turn?.botId || turn?.bot_id || turn?.member || turn?.bot || "");
  const normalizedText = text.toLowerCase().replace(/[\s\p{P}]+/gu, "");
  const textLen = text.length;
  const toolHistory = ctx._round_tool_history || ctx.round_tool_history || [];
  const fingerprints = ctx._round_turn_fingerprints || ctx.round_turn_fingerprints || [];

  // 1. Tool Call Duplication Check
  const toolResults = Array.isArray(turn?.toolResults) ? [...turn.toolResults] : [];
  if (turn?.tool && turn?.ok === false) {
    toolResults.push({ name: turn.tool, ok: false, args: turn.args });
  }
  for (const tr of toolResults) {
    if (!tr.ok && tr.name) {
      const matchingRecent = toolHistory.filter(
        (h) => (h.botId === botId || h.bot === botId) &&
               (h.tool === tr.name || h.name === tr.name) &&
               !h.ok &&
               (!turn.args || !h.args || h.args === turn.args)
      );
      if (matchingRecent.length >= 2) {
        return { isLoop: true, detected: true, type: "tool_failure_loop", reason: `工具 ${tr.name} 连续多次失败` };
      }
    }
  }

  // 2. Repetitive Content / Semantic Oscillation Check
  if (normalizedText.length > 10) {
    const identicalCount = fingerprints.filter(
      (fp) => (fp.botId === botId || fp.bot === botId) &&
             (fp.hash === normalizedText || fp.fp === normalizedText)
    ).length;
    if (identicalCount >= 2) {
      return { isLoop: true, detected: true, type: "semantic_oscillation", reason: `成员 ${botId} 重复输出相同内容` };
    }
  }

  // 3. Ping-Pong Chatter Check (3 consecutive short non-tool turns alternating between bots)
  if (fingerprints.length >= 2) {
    const last1 = fingerprints[fingerprints.length - 1];
    const last2 = fingerprints[fingerprints.length - 2];
    const last1Bot = last1.botId || last1.bot;
    const last2Bot = last2.botId || last2.bot;
    const last1Len = last1.textLen ?? (last1.fp ? last1.fp.length : 0);
    const hasTools = turn.hasTools || (Array.isArray(turn.toolResults) && turn.toolResults.length > 0);
    if (
      last2Bot === botId &&
      last1Bot !== botId &&
      textLen < 120 &&
      last1Len < 120 &&
      !hasTools
    ) {
      return { isLoop: true, detected: true, type: "ping_pong_chatter", reason: `成员 ${botId} 与 ${last1Bot} 陷入无进展闲聊` };
    }
  }

  return { isLoop: false, detected: false };
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
    this._activeTurnController = null;
    this._roundAbortController = null;
    this.base_relay_limit = Math.max(6, RELAY_LIMIT_FACTOR * Math.max(1, this.members.length));
    this.max_relay_ceiling = Number(this.settings?.max_relay_ceiling) || 25;
    this.max_chatter_relays = Number(this.settings?.max_chatter_relays) || 4;
    this.relays = 0;
    this.relay_limit = Number(this.settings?.base_relay_limit) || this.base_relay_limit;
    this.consecutive_stagnant_turns = 0;
    this._round_tool_history = [];
    this._round_turn_fingerprints = [];
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
    this.base_relay_limit = Math.max(6, RELAY_LIMIT_FACTOR * Math.max(1, this.members.length));
    this.max_relay_ceiling = Number(this.settings?.max_relay_ceiling) || 25;
    this.max_chatter_relays = Number(this.settings?.max_chatter_relays) || 4;
    this.relay_limit = Number(this.settings?.base_relay_limit) || this.base_relay_limit;
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
    const deliveredAssignments = task ? [task] : (assignments.length > 0 ? [assignments.shift()] : []);
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
    if (!this.round_running) {
      this.relays = 0;
      this.consecutive_stagnant_turns = 0;
      this._round_tool_history = [];
      this._round_turn_fingerprints = [];
    }
    this.status = "active";
    this.updated_at = record.timestamp;
    this.mentionMembers(text, speaker);
    await this.emit("turn_completed", { ...record });
    await this.emit("circuit_breaker_reset", { reset_by: speaker });
    this.pending_rounds += 1;
    this.enqueueRound(text);
    return { status: "accepted", room_id: this.room_id };
  }

  /**
   * Cancel or abort the currently active round and assistant turn in this room.
   * @param {string} [reason]
   * @returns {boolean}
   */
  abortRound(reason = "Round aborted") {
    this.status = "paused";
    let aborted = false;
    if (this._roundAbortController && !this._roundAbortController.signal.aborted) {
      this._roundAbortController.abort(new Error(reason));
      aborted = true;
    }
    if (this._activeTurnController) {
      this._activeTurnController.abort(new Error(reason));
      this._activeTurnController = null;
      aborted = true;
    }
    return aborted;
  }

  cancelActiveTurn(reason = "Turn cancelled") {
    return this.abortRound(reason);
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

  evalForwardProgress(result, ctx = {}) {
    return evalForwardProgress(result, { ...ctx, room: this, _round_turn_fingerprints: this._round_turn_fingerprints });
  }

  detectInfiniteLoop(turn) {
    return detectInfiniteLoop(turn, this);
  }

  async extendRelayLimit(grant, reason) {
    if (grant <= 0) return 0;
    const oldLimit = this.relay_limit;
    const ceiling = this.max_relay_ceiling || 25;
    const newLimit = Math.min(ceiling, oldLimit + grant);
    const actualGrant = newLimit - oldLimit;
    if (actualGrant > 0) {
      this.relay_limit = newLimit;
      await this.emit("relay_extended", {
        relays: this.relays,
        old_limit: oldLimit,
        new_limit: newLimit,
        ceiling,
        grant: actualGrant,
        reason,
      });
    }
    return actualGrant;
  }

  /* ----------------------------------------------------------------- round */

  async runRound({ instruction, turnTimeoutMs } = {}) {
    const roundId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.last_round_id = roundId;
    this.round_running += 1;
    this.pending_rounds = Math.max(0, this.pending_rounds - 1);
    this.relays = 0;
    if (this.settings?.base_relay_limit) {
      this.relay_limit = Number(this.settings.base_relay_limit);
    } else if (this.relay_limit == null) {
      this.relay_limit = this.base_relay_limit;
    }
    this.consecutive_stagnant_turns = 0;
    this.system_notices = [];
    this._round_tool_history = [];
    this._round_turn_fingerprints = [];
    this._roundAbortController = new AbortController();
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
    const executedUnits = new Set();
    const assignmentOrder = [];
    // 每轮重新声明任务单元（群主在本轮 assign / depends_on 里定义；若已预分派则保留）。
    if (!Array.isArray(this.task_plan) || !this.task_plan.length) {
      this.task_plan = [];
      this._executionPlan = null;
    }
    // 本轮回合（供学习闭环判断质量）与证据状态。
    this._round_turns = [];
    let assignedMode = false;
    let paused = false;
    let guard = 0;
    const maxTurns = Math.max(this.max_relay_ceiling * 2, this.speaking_slots.length * MAX_TURNS_FACTOR);

    // Owner first when the message carries no explicit @mention.
    if (this.owner_id && this.speaking_slots.includes(this.owner_id) && !mentionList.length) {
      this.speaking_slots = [this.owner_id, ...this.speaking_slots.filter((m) => m !== this.owner_id)];
    }

    try {
      while (guard < maxTurns) {
        guard += 1;
        if (this._roundAbortController?.signal.aborted || this.status === "paused") {
          paused = true;
          break;
        }
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
        let activeUnitId = null;
        if (this.task_plan.length && this._executionPlan) {
          const ready = this._readyBotUnit(executedUnits);
          if (ready) {
            nextId = ready.botId;
            activeUnitId = ready.unitId;
          }
        }
        if (!nextId) {
          nextId = assignedMode ? pendingNext : this.speaking_slots.find((b) => !seen.has(b));
        }
        if (!nextId) break;
        seen.add(nextId);
        if (activeUnitId) executedUnits.add(activeUnitId);

        if (!this.members.includes(nextId)) continue;
        if (this.permissionsOf(nextId).can_speak === false) continue;
        if (this._roundAbortController?.signal.aborted || this.status === "paused") {
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

        // --- Watchdog Timeout & AbortSignal (Feature 17) ---
        const timeoutMs = resolveTurnTimeoutMs(this, nextId, { turnTimeoutMs });
        const controller = new AbortController();
        this._activeTurnController = controller;
        let timedOut = false;
        let timer = null;

        if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort(new Error(`Watchdog timeout after ${timeoutMs}ms`));
          }, timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
        }

        const turnStartMs = Date.now();
        const graceMs = Math.min(2000, Math.max(200, Math.floor(timeoutMs * 0.2)));
        let hardTimer = null;
        const hardCutoffPromise = new Promise((resolve) => {
          hardTimer = setTimeout(() => {
            timedOut = true;
            controller.abort(new Error(`Watchdog timeout after ${timeoutMs}ms (forced cutoff)`));
            resolve({
              __hardCutoff: true,
              text: "",
              error: `Watchdog timeout after ${timeoutMs}ms`,
              ms: Date.now() - turnStartMs,
              usage: null,
              aborted: true,
              timedOut: true,
            });
          }, timeoutMs + graceMs);
          if (typeof hardTimer.unref === "function") hardTimer.unref();
        });

        let result = { text: "", error: null, ms: 0, usage: null };
        try {
          result = await Promise.race([
            runner.run({
              prompt: memberInstruction,
              signal: controller.signal,
              onToolEvent: () => {},
            }),
            hardCutoffPromise,
          ]);
        } catch (err) {
          result = {
            text: "",
            error: err?.message || String(err),
            ms: Date.now() - turnStartMs,
            usage: null,
            aborted: controller.signal.aborted,
            timedOut,
          };
        } finally {
          if (timer) clearTimeout(timer);
          if (hardTimer) clearTimeout(hardTimer);
          if (this._activeTurnController === controller) {
            this._activeTurnController = null;
          }
        }

        const turnDurationMs = result?.ms || (Date.now() - turnStartMs);
        const isTimeout = Boolean(
          timedOut ||
          result?.timedOut ||
          (result?.error && String(result.error).toLowerCase().includes("timed out"))
        );
        const isAborted = Boolean(controller.signal.aborted || result?.aborted || isTimeout);
        const hasError = Boolean(result?.error || isAborted);

        if (hasError) {
          const errorMsg = result?.error || (isTimeout ? `Watchdog timeout after ${timeoutMs}ms` : "turn aborted");
          if (isTimeout) {
            await this.emit("turn_timeout", {
              bot_id: nextId,
              member: nextId,
              round_id: roundId,
              timeout_ms: timeoutMs,
              ms: turnDurationMs,
              error: errorMsg,
            });
          }
          await this.emit("member_error", {
            bot_id: nextId,
            member: nextId,
            round_id: roundId,
            error: errorMsg,
            timed_out: isTimeout,
            ms: turnDurationMs,
          });
          if (isTimeout) {
            this.system_notices.push(`成员 ${nextId} 本轮执行超时（>${timeoutMs}ms），已中止。`);
            log.warn("member turn timeout", nextId, `${timeoutMs}ms`);
          } else {
            this.system_notices.push(`成员 ${nextId} 本轮执行失败：${truncate(errorMsg, 300)}`);
            log.warn("member failed", nextId, errorMsg);
          }
        }

        await this.emit("member_finished", { member: nextId, round_id: roundId, ms: turnDurationMs });

        const text = String(result?.text || "").trim();
        this._markTaskResult(seen, nextId, {
          ok: Boolean(text) && !hasError,
          reason: hasError ? (result?.error || (isTimeout ? `超时（${timeoutMs}ms）` : "执行中止")) : (text ? null : "没有产出文本"),
        }, activeUnitId);

        if (!text || hasError) {
          if (!hasError && !result?.error) this.system_notices.push(`成员 ${nextId} 本轮没有产出文本。`);
          continue;
        }

        // --- Loop & Chatter Detection (Feature 18) ---
        const loopCheck = this.detectInfiniteLoop({ botId: nextId, text, toolResults: result?.toolResults });
        if (loopCheck.isLoop) {
          log.warn(`infinite loop detected in room ${this.room_id}: ${loopCheck.reason}`);
          this.system_notices.push(`检测到循环停滞：${loopCheck.reason}，本轮提前结束。`);
          await this.emit("loop_detected", { ...loopCheck, member: nextId, round_id: roundId });
          break;
        }

        // Update history fingerprints and tool history
        this._round_turn_fingerprints.push({
          botId: nextId,
          hash: text.toLowerCase().replace(/[\s\p{P}]+/gu, ""),
          textLen: text.length,
        });
        if (Array.isArray(result?.toolResults)) {
          for (const tr of result.toolResults) {
            this._round_tool_history.push({ botId: nextId, tool: tr.name, ok: Boolean(tr.ok), ts: Date.now() });
          }
        }

        // --- Forward Progress Evaluation & Dynamic Extension (Feature 18) ---
        const progress = this.evalForwardProgress(result, { botId: nextId });
        if (progress.isProgress) {
          this.consecutive_stagnant_turns = 0;
          await this.extendRelayLimit(progress.grant, progress.reason);
        } else {
          this.consecutive_stagnant_turns += 1;
          if (this.consecutive_stagnant_turns >= this.max_chatter_relays) {
            log.info(`stagnant chatter limit reached in room ${this.room_id}`);
            this.system_notices.push(`无实质进展的闲聊达到上限（${this.max_chatter_relays} 轮），本轮提前结束。`);
            await this.emit("chatter_limit_tripped", {
              relays: this.relays,
              consecutive_stagnant: this.consecutive_stagnant_turns,
              stagnant_turns: this.consecutive_stagnant_turns,
            });
            break;
          }
        }

        this.relays += 1;
        if (this.relays >= this.relay_limit) {
          this.status = "paused";
          paused = true;
          await this.emit("circuit_breaker_tripped", { relays: this.relays, limit: this.relay_limit });
          if (text) {
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
              ms: Number(turnDurationMs) || 0,
            });
            await this.emit("turn_completed", {
              ...record,
              bot_id: nextId,
              member: nextId,
              ...(messageSeq ? { seq: messageSeq } : {}),
              ...(evidenceStatus ? { evidence: evidenceStatus } : {}),
              telemetry: result?.telemetry,
              ms: turnDurationMs,
            });
          }
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
          ms: Number(turnDurationMs) || 0,
        });
        await this.emit("turn_completed", {
          ...record,
          bot_id: nextId,
          member: nextId,
          ...(messageSeq ? { seq: messageSeq } : {}),
          ...(evidenceStatus ? { evidence: evidenceStatus } : {}),
          telemetry: result?.telemetry,
          ms: turnDurationMs,
        });
      }
    } catch (err) {
      log.error("round loop failed", err?.stack || err);
    } finally {
      this.round_running = Math.max(0, this.round_running - 1);
      this._activeTurnController = null;
      this._roundAbortController = null;
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
    if (this._executionPlan) {
      const existingUnits = Object.keys(this._executionPlan.units || {});
      const allPresent = tasks.every((t) => existingUnits.includes(t.id));
      if (allPresent && existingUnits.length === tasks.length) {
        return this._executionPlan;
      }
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

  /** 下一个可执行单元对应的成员与单元 id。 */
  _readyBotUnit(executedUnits = new Set()) {
    const plan = this._executionPlan;
    if (!plan) return null;
    try {
      for (const unitId of nextReady(plan)) {
        if (executedUnits.has(unitId)) continue;
        const bot = String(plan.units?.[unitId]?.bot_id || "");
        if (!bot) continue;
        return { botId: bot, unitId };
      }
    } catch (err) {
      log.warn("nextReady failed", err?.message || err);
    }
    return null;
  }

  /** 下一个可执行单元对应的成员（依赖全部成功、本人未跑过、且有分派）。 */
  _readyBot(seen) {
    const ready = this._readyBotUnit(seen);
    return ready ? ready.botId : null;
  }

  /** 把一次成员回合的结果写进执行计划，并把新跳过的下游写进系统通知。 */
  _markTaskResult(seen, botId, { ok, reason = null } = {}, targetUnitId = null) {
    const plan = this._executionPlan;
    if (!plan) return [];
    let unitsToMark = [];
    if (targetUnitId && plan.units?.[targetUnitId]) {
      unitsToMark = [targetUnitId];
    } else {
      unitsToMark = (this.task_plan || [])
        .filter((t) => String(t.bot_id) === String(botId) && !["done", "failed", "skipped"].includes(plan.states?.[t.id]))
        .map((t) => t.id)
        .slice(0, 1);
      if (!unitsToMark.length) {
        unitsToMark = (this.task_plan || []).filter((t) => String(t.bot_id) === String(botId)).map((t) => t.id);
      }
    }

    let current = plan;
    const skipped = [];
    for (const unitId of unitsToMark) {
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
      if (!bot) continue;
      if (seen && typeof seen.add === "function") seen.add(bot);
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
