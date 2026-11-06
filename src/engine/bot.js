/**
 * BotRunner — one long-lived pi `AgentSession` per (room, bot).
 *
 * A bot is a persistent identity: its own workspace directory, its own pi session
 * file (context survives turns), its persona injected as a system-prompt
 * override, and its own tool allow-list. Sessions are created lazily on the first
 * turn and reused afterwards; `dispose()` releases them.
 *
 * Everything run() does is defensive: a failing model call, a blocked tool or a
 * broken hook must never take the room round down — errors are captured, logged,
 * published as `worker.<botId>.turn_completed` with an `error` field, and returned
 * to the caller.
 */
import fs from "node:fs";
import path from "node:path";
import { DIRS, assertNotC, ensureDirs, piProjectSettings } from "../config.js";
import { createLogger } from "../log.js";
import { loadPi } from "./pi.js";
import { archetypeOf, personaFor, roomContextBlock, ROOM_TOOL_NAMES, toolsetFor } from "./archetypes.js";
import { createHooksExtension } from "../hooks.js";
import { CORE_TOOLS, toolsForRole, resolveToolsets } from "../toolsets.js";

const log = createLogger("engine.bot");

/** Tools that mutate state — banned for read-only archetypes. */
const MUTATING_TOOLS = ["write", "edit", "bash", "powershell"];

/** Tools a pi session can have (names match the bundle's built-in tools). */
export const ALL_TOOL_NAMES = ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"];

/** Extract plain text from a pi assistant message (content blocks). */
export function assistantText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block && (block.type === "text" || typeof block.text === "string"))
      .map((block) => String(block.text ?? ""))
      .join("");
  }
  return "";
}

/** Normalise pi's Usage into the flat shape the UI/store expect. */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
  const input = Number(usage.input || 0);
  const output = Number(usage.output || 0);
  const cacheRead = Number(usage.cacheRead || 0);
  const cacheWrite = Number(usage.cacheWrite || 0);
  const cost = Number(usage.cost?.total ?? usage.cost ?? 0) || 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: Number(usage.totalTokens || input + output + cacheRead + cacheWrite),
    cost,
  };
}

/** Serialise tool args for events (bounded). */
/** 把一次工具结果压成短文本，供证据阶梯判断 observed / prepared（**不是**给模型看的）。 */
function summariseResult(result) {
  try {
    if (result === undefined || result === null) return "";
    const raw = typeof result === "string" ? result : result?.content ?? result;
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    return String(text || "").slice(0, 240);
  } catch {
    return "";
  }
}

function summariseArgs(args) {
  try {
    const text = JSON.stringify(args ?? {});
    return text.length > 800 ? `${text.slice(0, 800)}…` : text;
  } catch {
    return "";
  }
}

function toolInputOf(args) {
  return args && typeof args === "object" && !Array.isArray(args) ? args : {};
}

export class BotRunner {
  /**
   * @param {{
   *   bot: object,
   *   engine: object,
   *   store?: object,
   *   events?: object,
   *   hooks?: object[]|null,
   *   skills?: object,
   *   roomContext?: {roomId?:string, roomTitle?:string, topic?:string, members?:object[], files?:object[]},
   *   customTools?: object[],
   *   tools?: string[],
   *   readOnly?: boolean,
   * }} options
   */
  constructor(options = {}) {
    this.bot = options.bot || {};
    this.engine = options.engine || null;
    this.store = options.store || null;
    this.events = options.events || null;
    this.hooks = options.hooks ?? null;
    this.approval = options.approval || null;
    this.approvalTimeoutMs = Number(options.approvalTimeoutMs) || undefined;
    this.onApprovalRequested = typeof options.onApprovalRequested === "function" ? options.onApprovalRequested : null;
    this.onApprovalResolved = typeof options.onApprovalResolved === "function" ? options.onApprovalResolved : null;
    this.skills = options.skills || null;
    this.roomContext = options.roomContext || {};
    this.customTools = Array.isArray(options.customTools) ? [...options.customTools] : [];
    this.roomTools = Array.isArray(this.bot.room_tools) ? [...this.bot.room_tools] : [];
    this.readOnly = options.readOnly !== undefined ? Boolean(options.readOnly) : Boolean(this.bot.read_only);
    this.tools = Array.isArray(options.tools)
      ? [...options.tools]
      : Array.isArray(this.bot.tools) && this.bot.tools.length
        ? [...this.bot.tools]
        : ["read", "grep", "find", "ls"];
    if (this.readOnly) this.tools = this.tools.filter((name) => !MUTATING_TOOLS.includes(name));

    // Hermes 式工具面（src/toolsets.js）：身份角色 + 命名工具集 + 末端减除。
    // 不配 toolsets 时完全沿用上面的旧白名单，保证既有 bot 记录行为不变。
    const toolsetDef = toolsetFor(this.bot.archetype || this.bot.id);
    this.toolset_role = options.toolset_role || this.bot.toolset_role || toolsetDef.role;
    this.toolsets = Array.isArray(options.toolsets)
      ? [...options.toolsets]
      : Array.isArray(this.bot.toolsets)
        ? [...this.bot.toolsets]
        : [];
    this.disabledToolsets = Array.isArray(options.disabledToolsets)
      ? [...options.disabledToolsets]
      : Array.isArray(this.bot.disabled_toolsets)
        ? [...this.bot.disabled_toolsets]
        : [];
    this.toolsetsExtra = Array.isArray(this.bot.toolsets_extra) ? [...this.bot.toolsets_extra] : [...(toolsetDef.extra || [])];
    // 仅当记录里**显式**带 toolsets 字段（buildBot / API 写入）时才走工具集路径；
    // 旧库里没有这个字段的 bot 记录继续吃 `tools` 白名单，行为不变。
    this.hasToolsetPlan = Array.isArray(options.toolsets) || Array.isArray(this.bot.toolsets);
    this.session = null;
    this.loader = null;
    this.sessionPath = null;
    this.turnCount = 0;
    this._creating = null;
    this._runPromise = null;
    this._disposed = false;
    this._unsubscribe = null;
    this._extensions = null;
  }

  get botId() {
    return String(this.bot.id || "bot");
  }

  get roomId() {
    return this.roomContext?.roomId ? String(this.roomContext.roomId) : null;
  }

  /** Thread id used for event replay (`/api/thread/<id>/events`). */
  get threadId() {
    return this.roomId ? `room:${this.roomId}` : `bot:${this.botId}`;
  }

  /** Workspace directory for this bot in this room. */
  get cwd() {
    const base = this.roomId ? path.join(DIRS.workspace, "rooms", this.roomId) : path.join(DIRS.workspace, "solo");
    return assertNotC(path.join(base, this.botId), "bot workspace");
  }

  /** Absolute path of the bot's pi agent dir (shared, D: only). */
  get agentDir() {
    return DIRS.sharedAgent;
  }

  get isRunning() {
    return Boolean(this._runPromise);
  }

  get isReady() {
    return Boolean(this.session);
  }

  /** Persona + room context injected as the system prompt override. */
  buildPersona() {
    const archetype = archetypeOf(this.bot.archetype || this.bot.id);
    const persona =
      this.bot.system_prompt && String(this.bot.system_prompt).trim()
        ? String(this.bot.system_prompt)
        : personaFor(archetype, this.bot);
    return persona;
  }

  /** Append-only system prompt block with the current room facts. */
  buildRoomBlock() {
    const block = roomContextBlock({
      roomId: this.roomId,
      roomTitle: this.roomContext.roomTitle,
      topic: this.roomContext.topic,
      members: this.roomContext.members,
      files: this.roomContext.files,
    });
    const allowed = this.readOnly ? "\n- 你是只读成员：不要尝试写文件或执行命令。" : "";
    return `${block}${allowed}`;
  }

  /** Names of the tools this bot should have active. */
  activeToolNames() {
    const customNames = [];
    for (const tool of this.customTools) {
      const name = String(tool?.name || "");
      if (name) customNames.push(name);
    }

    let names;
    if (this.hasToolsetPlan) {
      // 工具集展开只决定「内置工具」；群工具是否可用由 rooms/tools.js 按权限挂载决定，
      // 所以这里只保留「确实是内置工具」或「确实挂载了」的名字（避免把未挂载的
      // room_file_move 之类名字塞进 pi 的白名单）。
      const builtin = new Set(CORE_TOOLS);
      const resolved = toolsForRole({
        role: this.toolset_role,
        toolsets: this.toolsets,
        extraTools: [...this.toolsetsExtra, ...customNames],
      });
      names = resolved.filter((name) => builtin.has(name) || customNames.includes(name));
    } else {
      names = [...this.tools];
    }

    for (const name of customNames) {
      if (!names.includes(name)) names.push(name);
    }

    // 末端严格减除：disabled 里写工具名或工具集名都生效（Hermes disabled_toolsets 语义）。
    const enabled = resolveToolsets([], { disabled: this.disabledToolsets, extra: names });
    return enabled.filter((name) => {
      if (!this.readOnly) return true;
      return !MUTATING_TOOLS.includes(name);
    });
  }

  /** Lazily create the underlying pi AgentSession. */
  async ensureSession() {
    if (this.session) return this.session;
    if (this._disposed) throw new Error(`BotRunner(${this.botId}) is disposed`);
    if (this._creating) return this._creating;
    this._creating = this._createSession();
    try {
      return await this._creating;
    } finally {
      this._creating = null;
    }
  }

  async _createSession() {
    const pi = await loadPi();
    ensureDirs();
    const cwd = this.cwd;
    fs.mkdirSync(cwd, { recursive: true });
    // 把压缩策略写进项目级 `.pi/settings.json`（pi 会与全局 settings 合并）。
    // 为什么在会话创建前写：pi 在 createAgentSession 时读取 settings；中途改不会生效。
    try {
      const settingsDir = assertNotC(path.join(cwd, ".pi"), "bot pi settings");
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(path.join(settingsDir, "settings.json"), `${JSON.stringify(piProjectSettings(), null, 2)}\n`, "utf8");
    } catch (err) {
      log.warn("write project pi settings failed", err?.message || err);
    }

    const model = this.engine?.getModel?.(this.bot.model) || this.engine?.defaultModel;
    if (!model) throw new Error("no model available: engine has no resolvable default model");

    const settingsManager = pi.SettingsManager.create(cwd, this.agentDir);
    // 审批上下文必须**按 (roomId, botId) 传**：session 缓存与拒绝熔断都按这个键隔离。
    const hooksExtension = createHooksExtension(this.hooks, {
      approval: this.approval,
      approvalContext: { roomId: this.roomId, botId: this.botId },
      approvalTimeoutMs: this.approvalTimeoutMs,
      onViolation: (info) => this._publish("tool_blocked", info),
      onApprovalRequested: (request, detail) => {
        this._publish("approval_requested", {
          id: request?.id,
          status: request?.status,
          tool: detail?.tool,
          reason: detail?.verdict?.reason || detail?.reason || null,
          room_id: this.roomId,
          bot_id: this.botId,
        });
        try {
          this.onApprovalRequested?.(request, detail);
        } catch {
          /* listener errors must not break the gate */
        }
      },
      onApprovalResolved: (info) => {
        this._publish("approval_resolved", { ...info, room_id: this.roomId, bot_id: this.botId });
        try {
          this.onApprovalResolved?.(info);
        } catch {
          /* ignore */
        }
      },
    });
    const extensions = [hooksExtension, this._createGuardExtension(), this._createToolEventExtension()];

    const persona = this.buildPersona();
    const loader = new pi.DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true, // no on-disk extension discovery; only our inline factories
      noContextFiles: true, // personas come from the override, not AGENTS.md
      additionalSkillPaths: [DIRS.skills],
      systemPromptOverride: (base) => `${persona}\n\n${base || ""}`.trim(),
      appendSystemPrompt: [this.buildRoomBlock()],
      extensionFactories: extensions,
    });
    await loader.reload();

    const sessionManager = pi.SessionManager.create(cwd, DIRS.sessions);
    const { session } = await pi.createAgentSession({
      cwd,
      agentDir: this.agentDir,
      modelRuntime: this.engine.modelRuntime,
      model,
      settingsManager,
      sessionManager,
      resourceLoader: loader,
      tools: this.activeToolNames(),
      customTools: this.customTools,
      thinkingLevel: this.bot.thinking_level || "off",
    });

    this.session = session;
    this.loader = loader;
    this._extensions = extensions;
    try {
      this.sessionPath = sessionManager.getSessionFile?.() || null;
    } catch {
      this.sessionPath = null;
    }
    log.info(
      `session ready for ${this.botId}${this.roomId ? `@${this.roomId}` : ""} model=${model.provider}/${model.id} tools=${this.activeToolNames().join(",")}`,
    );
    return session;
  }

  /** Read-only archetypes get a hard block at the extension layer. */
  _createGuardExtension() {
    const readOnly = this.readOnly;
    const botId = this.botId;
    return (pi) => {
      if (!readOnly) return;
      pi.on("tool_call", async (event) => {
        const name = String(event?.toolName || "");
        if (MUTATING_TOOLS.includes(name)) {
          log.warn(`${botId} (read-only) attempted ${name}; blocked`);
          return { block: true, reason: `只读成员（${botId}）不能使用 ${name} 修改文件或执行命令。` };
        }
        return undefined;
      });
    };
  }

  /** Diagnostics/telemetry extension: logs tool lifecycle at debug level. */
  _createToolEventExtension() {
    const botId = this.botId;
    return (pi) => {
      pi.on("tool_execution_start", async (event) => {
        log.debug(`[${botId}] tool start ${event.toolName} ${summariseArgs(event.args)}`);
        return undefined;
      });
      pi.on("tool_execution_end", async (event) => {
        log.debug(`[${botId}] tool end ${event.toolName} error=${Boolean(event.isError)} ${event.durationMs ?? "?"}ms`);
        return undefined;
      });
    };
  }

  async _publish(kind, payload) {
    if (!this.events?.publish) return;
    try {
      await this.events.publish({
        topic: `worker.${this.botId}.${kind}`,
        sender: this.botId,
        payload,
        thread_id: this.threadId,
      });
    } catch (err) {
      log.warn("failed to publish event", kind, err?.message || err);
    }
  }

  /**
   * Run one turn for this bot.
   * @param {{prompt:string, signal?:AbortSignal, onToolEvent?:Function}} input
   * @returns {Promise<{text:string, usage:object, ms:number, toolsUsed:string[], error?:string, aborted?:boolean}>}
   */
  async run(input = {}) {
    const previous = this._runPromise || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this._runPromise = current;
    try {
      await previous.catch(() => {});
      return await this._runTurn(input);
    } finally {
      release();
      if (this._runPromise === current) this._runPromise = null;
    }
  }

  async _runTurn({ prompt, signal, onToolEvent } = {}) {
    const startedAt = Date.now();
    const promptText = String(prompt ?? "");
    const toolsUsed = [];
    /** 每个工具调用的结局（名称/成功与否/结果摘要）——群聊层用它判断 observed vs prepared。 */
    const toolResults = [];
    const deltas = [];
    let authoritativeText = "";
    let usage = normalizeUsage(null);
    let error = null;
    let aborted = false;
    const emit = (event) => {
      if (!onToolEvent) return;
      try {
        onToolEvent(event);
      } catch (err) {
        log.debug("onToolEvent listener failed", err?.message || err);
      }
    };

    if (signal?.aborted) {
      return { text: "", usage, ms: 0, toolsUsed, aborted: true };
    }

    let session;
    try {
      this.turnCount += 1;
      session = await this.ensureSession();
      await this._publish("turn_started", { member: this.botId, room_id: this.roomId, turn: this.turnCount });
      emit({ type: "start", member: this.botId });

      const unsubscribe = session.subscribe((event) => {
        try {
          const type = event?.type;
          if (type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
            const delta = String(event.assistantMessageEvent.delta || "");
            if (delta) {
              deltas.push(delta);
              emit({ type: "delta", delta });
            }
            return;
          }
          if (type === "message_end" && event.message?.role === "assistant") {
            const text = assistantText(event.message);
            if (text) authoritativeText = text;
            if (event.message.usage) usage = normalizeUsage(event.message.usage);
            return;
          }
          if (type === "tool_execution_start") {
            const name = String(event.toolName || "");
            toolsUsed.push(name);
            emit({ type: "tool", tool: name, args: toolInputOf(event.args), toolCallId: event.toolCallId });
            void this._publish("tool_invoked", { member: this.botId, tool: name, args: summariseArgs(event.args) });
            return;
          }
          if (type === "tool_execution_update") {
            emit({ type: "tool_update", tool: event.toolName, toolCallId: event.toolCallId });
            return;
          }
          if (type === "tool_execution_end") {
            toolResults.push({
              name: String(event.toolName || ""),
              ok: !event.isError,
              summary: summariseResult(event.result),
            });
            emit({
              type: "tool_result",
              tool: String(event.toolName || ""),
              toolCallId: event.toolCallId,
              error: Boolean(event.isError),
              ms: event.durationMs,
            });
            void this._publish("tool_result", {
              member: this.botId,
              tool: String(event.toolName || ""),
              ok: !event.isError,
              ms: event.durationMs ?? null,
            });
            return;
          }
          if (type === "auto_retry_start") {
            log.warn(`${this.botId} retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`);
            return;
          }
          if (type === "agent_end") {
            const messages = Array.isArray(event.messages) ? event.messages : [];
            const lastAssistant = [...messages].reverse().find((m) => m?.role === "assistant");
            if (lastAssistant) {
              const text = assistantText(lastAssistant);
              if (text) authoritativeText = text;
              if (lastAssistant.usage) usage = normalizeUsage(lastAssistant.usage);
            }
          }
        } catch (err) {
          log.warn("session event handler failed", err?.message || err);
        }
      });

      const onAbort = () => {
        aborted = true;
        try {
          void session.abort();
        } catch (err) {
          log.warn("abort failed", err?.message || err);
        }
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      try {
        const pending = session.prompt(promptText);
        if (pending && typeof pending.then === "function") await pending;
      } finally {
        if (signal) signal.removeEventListener("abort", onAbort);
        try {
          unsubscribe();
        } catch {
          /* ignore */
        }
      }

      // Final safety net: if no deltas were observed (e.g. resumed session), ask the session.
      if (!authoritativeText && deltas.length) authoritativeText = deltas.join("");
      if (!authoritativeText) {
        const fallback = session.getLastAssistantText?.();
        if (fallback) authoritativeText = String(fallback);
      }
    } catch (err) {
      error = String(err?.message || err);
      if (signal?.aborted || aborted) {
        aborted = true;
      }
      log.error(`${this.botId} turn failed: ${error}`);
    }

    const ms = Date.now() - startedAt;
    const text = String(authoritativeText || "").trim();
    const result = { text, usage, ms, toolsUsed, toolResults, error: error || undefined, aborted: aborted || undefined };

    await this._publish("turn_completed", {
      member: this.botId,
      room_id: this.roomId,
      text,
      usage,
      ms,
      tools_used: toolsUsed,
      ...(error ? { error } : {}),
    });

    if (this.store?.addUsage && (usage.input || usage.output)) {
      try {
        this.store.addUsage({
          bot_id: this.botId,
          room_id: this.roomId,
          model: `${this.engine?.defaultModel?.provider || "magpie"}/${this.bot.model || this.engine?.defaultModelId || ""}`,
          input_tokens: usage.input,
          output_tokens: usage.output,
          ms,
        });
      } catch (err) {
        log.debug("addUsage failed", err?.message || err);
      }
    }

    return result;
  }

  /** Hot permission change: swap the active tool set without recreating the session. */
  setActiveTools(names) {
    if (!Array.isArray(names)) return this.activeToolNames();
    this.tools = names.filter((name) => typeof name === "string");
    if (this.readOnly) this.tools = this.tools.filter((name) => !MUTATING_TOOLS.includes(name));
    const next = this.activeToolNames();
    if (this.session) {
      try {
        this.session.setActiveToolsByName(next);
      } catch (err) {
        log.warn("setActiveToolsByName failed", err?.message || err);
      }
    }
    return next;
  }

  /** Inject room tools after construction (Room builds them per member). */
  setCustomTools(customTools) {
    this.customTools = Array.isArray(customTools) ? [...customTools] : [];
    return this;
  }

  /** Switch model without losing the transcript when a session already exists. */
  async setModel(modelId) {
    this.bot.model = modelId;
    const model = this.engine?.getModel?.(modelId);
    if (!model || !this.session) return false;
    try {
      await this.session.setModel(model);
      return true;
    } catch (err) {
      log.warn("setModel failed", err?.message || err);
      return false;
    }
  }

  /** Release the pi session (idempotent). */
  dispose() {
    this._disposed = true;
    // 会话销毁时撤回本成员的挂起审批，别让 tool_call 钩子干等到超时（对齐 Hermes clear_session）。
    try {
      this.approval?.clearSession?.({ roomId: this.roomId, botId: this.botId });
    } catch (err) {
      log.warn("approval clearSession failed", err?.message || err);
    }
    try {
      this.session?.dispose?.();
    } catch (err) {
      log.warn("session dispose failed", err?.message || err);
    }
    this.session = null;
    this.loader = null;
    this._unsubscribe = null;
  }
}

/** Build a BotRunner for one bot record (convenience for callers). */
export function createBotRunner(options) {
  return new BotRunner(options);
}

export { ROOM_TOOL_NAMES };
export default BotRunner;
