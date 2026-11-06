/**
 * Chief (单聊总控) — the free-form "one human ↔ one agent" surface.
 *
 * A single shared pi session (not per room) that owns the chief workspace, has the
 * full tool set (read/write/edit/bash/grep/find/ls) and streams its answer back as
 * `router.*` events so the web UI can render a live typewriter:
 *
 *   router.goal_received     {prompt, ticket_id, thread_id}
 *   router.synthesis_delta   {delta}            (batched tokens)
 *   router.synthesis_completed {summary, usage, ms, thread_id}
 *   worker.chief.tool_invoked / turn_started / turn_completed
 *   harness.task.completed | harness.task.failed
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DIRS, assertNotC, ensureDirs } from "../config.js";
import { createLogger } from "../log.js";
import { loadPi } from "./pi.js";
import { createHooksExtension } from "../hooks.js";

const log = createLogger("engine.chief");

export const CHIEF_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

const CHIEF_PERSONA = `你是 AgentFusion 的总控（Chief），也是这个工作台上唯一直接和用户对话的智能体。
- 你为一个由多个专职智能体组成的团队服务；用户在单聊窗口提出目标时，由你负责理解、澄清、给出可执行的方案与结论。
- 直接回答用户，中文优先，结论先行，简洁具体；需要展示细节时用短列表或小标题，不要长篇铺陈。
- 你可以使用工作区里的文件与命令工具（read/write/edit/bash/grep/find/ls）真实地读文件、跑命令、写产物；工作区就是当前目录。
- 不要编造工具输出或执行结果。不确定就说不确定，并给出验证方式。
- 如果用户的目标需要在群聊里由团队协作完成，明确说明建议的成员与分工，但不要假装已经完成。
- 不要输出元信息（如「好的，我这就开始」），直接给内容。`;

function newThreadId() {
  return `chief:${crypto.randomBytes(6).toString("hex")}`;
}

function assistantText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b) => b && (b.type === "text" || typeof b.text === "string"))
      .map((b) => String(b.text ?? ""))
      .join("");
  }
  return "";
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
  const input = Number(usage.input || 0);
  const output = Number(usage.output || 0);
  const cacheRead = Number(usage.cacheRead || 0);
  const cacheWrite = Number(usage.cacheWrite || 0);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: Number(usage.totalTokens || input + output + cacheRead + cacheWrite),
    cost: Number(usage.cost?.total ?? usage.cost ?? 0) || 0,
  };
}

function summariseArgs(args) {
  try {
    const text = JSON.stringify(args ?? {});
    return text.length > 800 ? `${text.slice(0, 800)}…` : text;
  } catch {
    return "";
  }
}

export class ChiefRunner {
  /**
   * @param {{engine:object, events?:object, store?:object, hooks?:object[]|null, skills?:object, bot?:object}} opts
   */
  constructor(opts = {}) {
    this.engine = opts.engine || null;
    this.events = opts.events || null;
    this.store = opts.store || null;
    this.hooks = opts.hooks ?? null;
    this.skills = opts.skills || null;
    this.bot = opts.bot || { id: "chief", name: "总控", emoji: "🧠", color: "#7c8cff", badge: "chief" };
    this.session = null;
    this.sessionPath = null;
    this._creating = null;
    this._runPromise = null;
    this.turnCount = 0;
  }

  get cwd() {
    return assertNotC(path.join(DIRS.workspace, "chief"), "chief workspace");
  }

  get agentDir() {
    return DIRS.sharedAgent;
  }

  get isReady() {
    return Boolean(this.session);
  }

  async ensureSession() {
    if (this.session) return this.session;
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
    const model = this.engine?.defaultModel || this.engine?.getModel?.(null);
    if (!model) throw new Error("no model available for chief session");
    const settingsManager = pi.SettingsManager.create(cwd, this.agentDir);
    const loader = new pi.DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
      noContextFiles: true,
      additionalSkillPaths: [DIRS.skills],
      systemPromptOverride: (base) => `${CHIEF_PERSONA}\n\n${base || ""}`.trim(),
      appendSystemPrompt: [
        "# 当前环境\n- 工作区：你的当前目录（cwd），可用 read/write/edit/bash/grep/find/ls 操作。\n- 群聊房间的工作区在 <DATA>/workspace/rooms/<room_id>/<bot_id>，可以读取但不要代替成员执行他们的任务。",
      ],
      extensionFactories: [createHooksExtension(this.hooks)],
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
      tools: CHIEF_TOOLS,
      thinkingLevel: "off",
    });
    this.session = session;
    try {
      this.sessionPath = sessionManager.getSessionFile?.() || null;
    } catch {
      this.sessionPath = null;
    }
    log.info(`chief session ready model=${model.provider}/${model.id}`);
    return session;
  }

  async _publish(topic, payload, threadId = null) {
    if (!this.events?.publish) return;
    try {
      await this.events.publish({ topic, sender: this.bot.id || "chief", payload, thread_id: threadId });
    } catch (err) {
      log.warn("chief failed to publish", topic, err?.message || err);
    }
  }

  /**
   * Run one chief turn.
   * @param {{
   *   prompt:string,
   *   thread_id?:string,
   *   ticket_id?:string,
   *   onEvent?:Function,
   *   signal?:AbortSignal,
   *   publishTaskEvents?:boolean,
   * }} input
   * @returns {Promise<{text:string, thread_id:string, ticket_id:string|null, usage:object, ms:number, toolsUsed:string[], error?:string}>}
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

  async _runTurn(input) {
    const startedAt = Date.now();
    const promptText = String(input.prompt ?? "");
    const threadId = String(input.thread_id || newThreadId());
    const ticketId = input.ticket_id || null;
    const publishTaskEvents = input.publishTaskEvents !== false;
    const toolsUsed = [];
    const deltas = [];
    let authoritative = "";
    let usage = normalizeUsage(null);
    let error = null;
    const emit = (event) => {
      try {
        input.onEvent?.(event);
      } catch {
        /* ignore */
      }
    };

    // --- streaming batches: one event per ~160 chars or 120ms -----------------
    let pendingDelta = "";
    let flushTimer = null;
    const flush = () => {
      if (!pendingDelta) return;
      const delta = pendingDelta;
      pendingDelta = "";
      void this._publish("router.synthesis_delta", { delta, thread_id: threadId }, threadId);
    };
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, 120);
    };
    const pushDelta = (delta) => {
      if (!delta) return;
      deltas.push(delta);
      pendingDelta += delta;
      emit({ type: "delta", delta });
      if (pendingDelta.length >= 160) {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        flush();
      } else {
        scheduleFlush();
      }
    };
    const finishFlush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush();
    };

    this.turnCount += 1;
    await this._publish("router.goal_received", { prompt: promptText, ticket_id: ticketId, thread_id: threadId }, threadId);
    await this._publish("worker.chief.turn_started", { member: "chief", turn: this.turnCount }, threadId);

    let unsubscribe = null;
    let session = null;
    try {
      session = await this.ensureSession();
      unsubscribe = session.subscribe((event) => {
        try {
          const type = event?.type;
          if (type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
            pushDelta(String(event.assistantMessageEvent.delta || ""));
            return;
          }
          if (type === "message_end" && event.message?.role === "assistant") {
            const text = assistantText(event.message);
            if (text) authoritative = text;
            if (event.message.usage) usage = normalizeUsage(event.message.usage);
            return;
          }
          if (type === "tool_execution_start") {
            const name = String(event.toolName || "");
            toolsUsed.push(name);
            emit({ type: "tool", tool: name, args: event.args, toolCallId: event.toolCallId });
            void this._publish(
              "worker.chief.tool_invoked",
              { member: "chief", tool: name, args: summariseArgs(event.args) },
              threadId,
            );
            return;
          }
          if (type === "tool_execution_end") {
            emit({ type: "tool_result", tool: event.toolName, toolCallId: event.toolCallId, error: Boolean(event.isError) });
            return;
          }
          if (type === "agent_end") {
            const messages = Array.isArray(event.messages) ? event.messages : [];
            const lastAssistant = [...messages].reverse().find((m) => m?.role === "assistant");
            if (lastAssistant) {
              const text = assistantText(lastAssistant);
              if (text) authoritative = text;
              if (lastAssistant.usage) usage = normalizeUsage(lastAssistant.usage);
            }
          }
        } catch (err) {
          log.warn("chief event handler failed", err?.message || err);
        }
      });

      const onAbort = () => {
        try {
          void session.abort();
        } catch {
          /* ignore */
        }
      };
      if (input.signal) input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const pending = session.prompt(promptText);
        if (pending && typeof pending.then === "function") await pending;
      } finally {
        if (input.signal) input.signal.removeEventListener("abort", onAbort);
      }
      if (!authoritative) authoritative = deltas.join("") || String(session.getLastAssistantText?.() || "");
    } catch (err) {
      error = String(err?.message || err);
      log.error(`chief turn failed: ${error}`);
    } finally {
      finishFlush();
      try {
        unsubscribe?.();
      } catch {
        /* ignore */
      }
    }

    const ms = Date.now() - startedAt;
    const summary = String(authoritative || deltas.join("") || "").trim();

    await this._publish(
      "router.synthesis_completed",
      { summary, text: summary, usage, ms, thread_id: threadId, ticket_id: ticketId, ...(error ? { error } : {}) },
      threadId,
    );
    await this._publish(
      "worker.chief.turn_completed",
      { member: "chief", text: summary, usage, ms, tools_used: toolsUsed, ...(error ? { error } : {}) },
      threadId,
    );

    if (publishTaskEvents) {
      if (error) {
        await this._publish(
          "harness.task.failed",
          { ticket_id: ticketId, thread_id: threadId, error, ms },
          threadId,
        );
      } else {
        await this._publish(
          "harness.task.completed",
          { ticket_id: ticketId, thread_id: threadId, summary, ms, usage },
          threadId,
        );
      }
    }

    if (this.store?.addUsage && (usage.input || usage.output)) {
      try {
        this.store.addUsage({
          bot_id: this.bot.id || "chief",
          room_id: null,
          model: `${this.engine?.defaultModel?.provider || "magpie"}/${this.engine?.defaultModel?.id || ""}`,
          input_tokens: usage.input,
          output_tokens: usage.output,
          ms,
        });
      } catch (err) {
        log.debug("chief addUsage failed", err?.message || err);
      }
    }

    return { text: summary, thread_id: threadId, ticket_id: ticketId, usage, ms, toolsUsed, ...(error ? { error } : {}) };
  }

  dispose() {
    try {
      this.session?.dispose?.();
    } catch (err) {
      log.warn("chief dispose failed", err?.message || err);
    }
    this.session = null;
  }
}

/** Single module-level chief session (bound to the engine that created it). */
let chiefRunner = null;

/** Get/create the shared chief runner for an engine. */
export function getChief(opts = {}) {
  if (chiefRunner && opts.engine && chiefRunner.engine !== opts.engine) {
    chiefRunner.dispose();
    chiefRunner = null;
  }
  if (!chiefRunner) chiefRunner = new ChiefRunner(opts);
  if (opts.events) chiefRunner.events = opts.events;
  if (opts.store) chiefRunner.store = opts.store;
  return chiefRunner;
}

/**
 * Convenience entry used by the API layer.
 * @returns {Promise<{text:string, thread_id:string, ticket_id:string|null, usage:object, ms:number, toolsUsed:string[], error?:string}>}
 */
export async function runChief(input = {}) {
  const runner = getChief(input);
  return runner.run(input);
}

/** Dispose the shared chief session (shutdown / tests). */
export function disposeChief() {
  if (chiefRunner) {
    chiefRunner.dispose();
    chiefRunner = null;
  }
}

export default runChief;
