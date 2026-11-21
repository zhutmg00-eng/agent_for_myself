/**
 * DirectChatManager — high-efficiency 1-on-1 Private Chat with any agent.
 *
 * Unlike group rooms (which route through Boss and coordinate multiple agents),
 * a Direct Message talks straight to a single bot's persistent pi session,
 * bound directly to the active or per-DM Project directory (`cwd`), with full
 * tool execution, streaming deltas, telemetry (TPS/TTFT), and manual Browser
 * Use / Computer Use permissions.
 */
import { createLogger } from "../log.js";
import { BotRunner } from "../engine/bot.js";
import { createBrowserTools } from "../automation/browser.js";
import { createComputerTools } from "../automation/computer.js";
import { detectGitBranch } from "../projects.js";

const log = createLogger("dm");

function nowIso() {
  return new Date().toISOString();
}

export class DirectChatManager {
  /**
   * @param {{
   *   store: object,
   *   events: object,
   *   engine: object,
   *   hooks?: object,
   *   skills?: object,
   *   archetypes?: object,
   *   approval?: object,
   *   memory?: object,
   *   automation?: object,
   *   perfMonitor?: object,
   *   runnerFactory?: (opts: object) => object,
   * }} deps
   */
  constructor(deps = {}) {
    this.store = deps.store || null;
    this.events = deps.events || null;
    this.engine = deps.engine || null;
    this.hooks = deps.hooks || null;
    this.skills = deps.skills || null;
    this.archetypes = deps.archetypes || null;
    this.approval = deps.approval || null;
    this.memory = deps.memory || null;
    this.automation = deps.automation || null;
    this.perfMonitor = deps.perfMonitor || null;
    this._runnerFactory = typeof deps.runnerFactory === "function" ? deps.runnerFactory : (opts) => new BotRunner(opts);

    /** @type {Map<string, BotRunner>} */
    this._runners = new Map();
    /** @type {Map<string, Promise<any>>} */
    this._queues = new Map();
    /** @type {Map<string, AbortController>} */
    this._activeControllers = new Map();
    /** @type {Set<string>} */
    this._busy = new Set();
    /** @type {Map<string, string>} last injected project+branch signature per DM session (`dsh` delta-facts) */
    this._lastProjectSig = new Map();
  }

  _botRecord(botId) {
    const id = String(botId || "").trim();
    const stored = this.store?.getBot?.(id);
    if (stored) return { ...stored, id };
    const built = this.archetypes?.buildBot?.(id);
    if (built) return { ...built, id };
    return { id, name: id, archetype: id };
  }

  /** Resolve effective Project object for a DM (explicit override -> per-DM saved -> global active). */
  resolveProject(botId, explicitProjectId = undefined) {
    const id = String(botId || "").trim();
    const candidateId = explicitProjectId !== undefined
      ? explicitProjectId
      : (this.store?.getDmProjectId?.(id) || this.store?.getActiveProjectId?.() || null);
    if (!candidateId) return null;
    return this.store?.getProject?.(candidateId) || null;
  }

  _buildCustomTools(bot) {
    const tools = [];
    const sessionKey = `dm-${bot.id}`;
    if (bot.can_use_browser && this.automation?.browser) {
      tools.push(...createBrowserTools({
        manager: this.automation.browser,
        sessionKey,
        canUse: () => Boolean(this._botRecord(bot.id)?.can_use_browser),
        botId: bot.id,
      }));
    }
    if (bot.can_use_computer && this.automation?.computer) {
      tools.push(...createComputerTools({
        driver: this.automation.computer,
        canUse: () => Boolean(this._botRecord(bot.id)?.can_use_computer),
        botId: bot.id,
      }));
    }
    return tools;
  }

  runnerFor(botId) {
    const id = String(botId || "").trim();
    const bot = this._botRecord(id);
    const project = this.resolveProject(id);
    const targetCwd = project?.root_path || null;

    let runner = this._runners.get(id);
    if (runner) {
      if (targetCwd && runner._cwdOverride !== targetCwd) {
        runner.setCwd?.(targetCwd);
      } else if (!targetCwd && runner._cwdOverride) {
        runner.setCwd?.(null);
      }
      return runner;
    }

    const customTools = this._buildCustomTools(bot);
    runner = this._runnerFactory({
      bot,
      engine: this.engine,
      store: this.store,
      events: this.events,
      hooks: this.hooks,
      skills: this.skills,
      approval: this.approval,
      cwd: targetCwd,
      roomContext: {
        roomId: null,
        roomTitle: `私聊 · ${bot.name || id}`,
        topic: project ? `项目目录：${project.name} (${project.root_path})` : "1v1 高效直连会话",
      },
      customTools,
      tools: bot?.tools || bot?.allowed_tools,
    });
    this._runners.set(id, runner);
    return runner;
  }

  isBusy(botId) {
    return this._busy.has(String(botId || "").trim());
  }

  /** Return summary list of all DMs with message count, preview, project binding, and busy state. */
  listConversations() {
    const summaries = this.store?.listDmSummaries?.() || [];
    const byBot = new Map(summaries.map((s) => [s.bot_id, s]));
    const bots = this.store?.listBots?.() || [];
    const out = [];
    const seen = new Set();

    for (const bot of bots) {
      const id = String(bot.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const s = byBot.get(id);
      const projectId = this.store?.getDmProjectId?.(id) || null;
      out.push({
        bot_id: id,
        message_count: Number(s?.message_count || 0),
        last_content: s?.last_content || "",
        last_speaker: s?.last_speaker || "",
        last_ts: s?.last_ts || null,
        project_id: projectId,
        busy: this.isBusy(id),
      });
    }
    return out;
  }

  getMessages(botId, limit = 200) {
    const id = String(botId || "").trim();
    return this.store?.listDmMessages?.(id, limit) || [];
  }

  setProject(botId, projectId) {
    const id = String(botId || "").trim();
    const clean = projectId ? String(projectId).trim() : null;
    if (clean && !this.store?.getProject?.(clean)) {
      const err = new Error(`项目不存在：${clean}`);
      err.status = 404;
      throw err;
    }
    this.store?.setDmProjectId?.(id, clean);
    this._lastProjectSig.delete(id);
    const runner = this._runners.get(id);
    if (runner) {
      const proj = this.resolveProject(id);
      runner.setCwd?.(proj?.root_path || null);
    }
    void this._emit(id, "updated", {
      bot_id: id,
      project_id: clean,
      effective_project: this.resolveProject(id),
    });
    return { bot_id: id, project_id: clean, effective_project: this.resolveProject(id) };
  }

  /** Sync bot profile updates (model, Browser Use / Computer Use capabilities) into live DM runner. */
  async syncBot(botId) {
    const id = String(botId || "").trim();
    const runner = this._runners.get(id);
    if (!runner) return false;
    const bot = this._botRecord(id);
    runner.bot = { ...runner.bot, ...bot };
    if (bot.model) {
      await runner.setModel?.(bot.model).catch(() => {});
    }
    const prevSig = (runner.customTools || []).map((t) => t?.name || "").sort().join(",");
    const nextTools = this._buildCustomTools(bot);
    runner.setCustomTools?.(nextTools);
    const nextSig = nextTools.map((t) => t?.name || "").sort().join(",");
    if (prevSig !== nextSig && runner.session) {
      runner.resetSession?.();
    }
    return true;
  }

  /** Clear DM history and drop the underlying pi session for a fresh start. */
  clear(botId) {
    const id = String(botId || "").trim();
    this.abort(id, "会话已清空");
    const runner = this._runners.get(id);
    if (runner) {
      try {
        runner.dispose?.();
      } catch {
        /* ignore */
      }
      this._runners.delete(id);
    }
    this._lastProjectSig.delete(id);
    this.store?.clearDmMessages?.(id);
    void this._emit(id, "cleared", { bot_id: id });
    return { ok: true, bot_id: id };
  }

  abort(botId, reason = "已手动停止生成") {
    const id = String(botId || "").trim();
    const ctrl = this._activeControllers.get(id);
    if (ctrl && !ctrl.signal.aborted) {
      ctrl.abort(new Error(reason));
      return true;
    }
    return false;
  }

  /** Send a 1v1 user message; persists immediately and executes assistant turn asynchronously or awaited. */
  say(botId, content, { projectId = undefined, wait = false } = {}) {
    const id = String(botId || "").trim();
    const text = String(content ?? "").trim();
    if (!id) throw Object.assign(new Error("bot_id is required"), { status: 400 });
    if (!text) throw Object.assign(new Error("content is required"), { status: 400 });

    if (projectId !== undefined) {
      this.setProject(id, projectId || null);
    }

    const project = this.resolveProject(id);
    const userMsg = this.store?.appendDmMessage?.(id, {
      speaker: "user",
      content: text,
      project_id: project?.id || null,
      ts: nowIso(),
    }) || { id: Date.now(), bot_id: id, speaker: "user", content: text, ts: nowIso() };

    void this._emit(id, "user_message", { ...userMsg, bot_id: id });

    const prev = this._queues.get(id) || Promise.resolve();
    const job = prev
      .catch(() => {})
      .then(() => this._executeTurn(id, text, project))
      .catch((err) => {
        log.error(`dm turn crashed for ${id}:`, err?.message || err);
        return null;
      });
    this._queues.set(id, job);

    if (wait) return job;
    return { status: "accepted", bot_id: id, message: userMsg, project_id: project?.id || null };
  }

  _buildPrompt(botId, userText, project) {
    const parts = [];
    const runner = this._runners.get(botId);
    const sessionFresh = !runner?.isReady;

    // `dsh` Assembly Line 3 — Delta Runtime Facts: only emit project/branch block
    // on Turn 1 or when the bound project/branch actually changes, avoiding redundant turn bloat.
    if (project?.root_path) {
      const branch = detectGitBranch(project.root_path) || "";
      const sig = `${project.id || ""}|${project.root_path}|${branch}`;
      if (sessionFresh || this._lastProjectSig.get(botId) !== sig) {
        this._lastProjectSig.set(botId, sig);
        parts.push(
          `=== 当前绑定的项目工作目录 ===\n名称：${project.name}\n路径：${project.root_path}${branch ? `\nGit 分支：${branch}` : ""}\n提示：所有文件读写与终端命令均默认在此项目目录内执行。`,
        );
      }
    } else if (this._lastProjectSig.has(botId)) {
      this._lastProjectSig.delete(botId);
    }

    // Include short recent history only when session is freshly created
    if (sessionFresh && this.store?.listDmMessages) {
      const recent = this.store.listDmMessages(botId, 12);
      // Exclude the just-appended latest user message
      const prior = recent.length > 1 ? recent.slice(0, -1) : [];
      if (prior.length) {
        const lines = prior.map((m) => `[${m.speaker === "user" ? "用户" : botId}] ${String(m.content || "").slice(0, 800)}`);
        parts.push(`=== 近期私聊记录 ===\n${lines.join("\n")}`);
      }
    }
    parts.push(`=== 用户直连消息（1v1 高效模式） ===\n${userText}`);
    return parts.join("\n\n");
  }

  async _executeTurn(botId, userText, project) {
    const runner = this.runnerFor(botId);
    const controller = new AbortController();
    this._activeControllers.set(botId, controller);
    this._busy.add(botId);
    this.perfMonitor?.beginTurn?.();

    const toolsLog = [];
    await this._emit(botId, "turn_started", {
      bot_id: botId,
      project_id: project?.id || null,
      project_path: project?.root_path || null,
    });

    let result = null;
    try {
      const prompt = this._buildPrompt(botId, userText, project);
      result = await runner.run({
        prompt,
        signal: controller.signal,
        onToolEvent: (evt) => {
          if (!evt) return;
          if (evt.type === "delta" && evt.delta) {
            // Rough estimate: ~3.5 chars per token for live streaming TPS chart
            this.perfMonitor?.recordStreamTokens?.(Math.max(1, evt.delta.length / 3.5));
            void this._emit(botId, "delta", { bot_id: botId, delta: evt.delta });
          } else if (evt.type === "tool") {
            const entry = {
              id: evt.toolCallId || `tc_${Date.now().toString(36)}`,
              tool: evt.tool,
              name: evt.tool,
              args: evt.args || {},
              status: "running",
              ts: Date.now(),
            };
            toolsLog.push(entry);
            void this._emit(botId, "tool_invoked", {
              bot_id: botId,
              call_id: entry.id,
              tool: evt.tool,
              args: evt.args || {},
            });
          } else if (evt.type === "tool_result") {
            const match = [...toolsLog].reverse().find(
              (t) => (evt.toolCallId ? t.id === evt.toolCallId : t.tool === evt.tool) && t.status === "running",
            );
            if (match) {
              match.status = evt.error ? "error" : "ok";
              match.ok = !evt.error;
              match.ms = evt.ms ?? null;
            }
            void this._emit(botId, "tool_result", {
              bot_id: botId,
              call_id: evt.toolCallId || match?.id || null,
              tool: evt.tool,
              ok: !evt.error,
              ms: evt.ms ?? null,
            });
          }
        },
      });
    } finally {
      this._activeControllers.delete(botId);
      this._busy.delete(botId);
      this.perfMonitor?.endTurn?.();
    }

    // Attach tool result summaries from runner.toolResults if available
    if (Array.isArray(result?.toolResults) && result.toolResults.length) {
      result.toolResults.forEach((tr, idx) => {
        if (toolsLog[idx] && !toolsLog[idx].output && tr.summary) {
          toolsLog[idx].output = tr.summary;
        }
      });
    }

    const telemetry = result?.telemetry || null;
    if (telemetry) {
      this.perfMonitor?.recordTurnTelemetry?.({
        tps: telemetry.tps,
        ttft_ms: telemetry.ttft_ms,
        input_tokens: result?.usage?.input || 0,
        output_tokens: result?.usage?.output || 0,
        cache_read_tokens: result?.usage?.cacheRead || telemetry.cache_read_tokens || 0,
        cache_write_tokens: result?.usage?.cacheWrite || telemetry.cache_write_tokens || 0,
        bot_id: botId,
      });
    }

    const assistantContent = result?.text
      ? String(result.text)
      : result?.error
        ? `（执行中断：${result.error}）`
        : "（已完成操作，无附加文本回复）";

    const bot = this._botRecord(botId);
    const saved = this.store?.appendDmMessage?.(botId, {
      speaker: botId,
      content: assistantContent,
      tools: toolsLog,
      telemetry,
      model: bot.model || this.engine?.defaultModelId || "",
      project_id: project?.id || null,
      ts: nowIso(),
    }) || {
      id: Date.now(),
      bot_id: botId,
      speaker: botId,
      content: assistantContent,
      tools: toolsLog,
      telemetry,
      ts: nowIso(),
    };

    await this._emit(botId, "turn_completed", {
      ...saved,
      bot_id: botId,
      error: result?.error || null,
    });
    return saved;
  }

  async _emit(botId, kind, payload) {
    if (!this.events?.publish) return;
    try {
      await this.events.publish({
        topic: `dm.${botId}.${kind}`,
        sender: botId,
        payload,
        thread_id: `dm:${botId}`,
      });
    } catch (err) {
      log.warn("dm emit failed", botId, kind, err?.message || err);
    }
  }

  dispose() {
    for (const [id, ctrl] of this._activeControllers.entries()) {
      try {
        ctrl.abort(new Error("server closing"));
      } catch {
        /* ignore */
      }
      this._activeControllers.delete(id);
    }
    for (const runner of this._runners.values()) {
      try {
        runner.dispose?.();
      } catch {
        /* ignore */
      }
    }
    this._runners.clear();
    this._busy.clear();
  }
}

export function createDirectChatManager(deps) {
  return new DirectChatManager(deps);
}

export default DirectChatManager;
