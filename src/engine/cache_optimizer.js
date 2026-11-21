/**
 * Prompt Cache Optimizer — inspired by DeepSeek Harness (`dsh`) "Three Assembly Lines"
 * and OpenCode's rolling prompt-cache breakpoint strategy.
 *
 * Core invariants for 95%–99%+ KV prefix cache hit rates:
 *   1. Byte-stable System Prompt Prefix:
 *      Static persona + immutable room/role rules only. Never inject timestamps,
 *      volatile file listings, dynamic memory, or mutable topics into the system
 *      prompt (those travel as per-turn user context / delta runtime facts).
 *   2. Canonical, Immutable Tool Schemas:
 *      Tool declarations are deterministically sorted by tool name and every JSON
 *      Schema object has recursively sorted keys, eliminating spurious cache busts
 *      from non-deterministic property ordering across turns or restarts.
 *   3. Protocol-Aware Cache Anchors:
 *      - OpenAI / DeepSeek / Magpie gateways: inject deterministic `prompt_cache_key`
 *        bound to (sessionKey, modelId, prefixHash) for sticky KV prefix routing.
 *      - Anthropic Messages protocol: place rolling `cache_control` breakpoints on
 *        (a) last system block, (b) last tool definition, and (c) the last 2 stable
 *        conversation checkpoints (strictly <= 4 breakpoints total, stripping stale
 *        markers on older turns).
 *   4. Runtime Prefix Stability Detection:
 *      Hashes canonicalized (system + tools) on every provider request and reports
 *      prefix stability vs. mid-session cache busts to PerfMonitor / telemetry.
 */
import crypto from "node:crypto";
import { createLogger } from "../log.js";

const log = createLogger("engine.cache");

const MAX_ANTHROPIC_BREAKPOINTS = 4;

/**
 * Recursively sort plain object keys for deterministic, byte-identical JSON
 * serialization (arrays preserve their order; undefined values are omitted).
 */
export function sortKeysDeep(value) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sortKeysDeep(item));
  const out = {};
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    const v = value[key];
    if (v === undefined) continue;
    out[key] = sortKeysDeep(v);
  }
  return out;
}

/** Deterministic JSON stringification with recursively sorted object keys. */
export function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

/** Canonicalize a single JSON Schema object (deterministic key order). */
export function canonicalizeSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  return sortKeysDeep(schema);
}

/** Extract canonical tool name from OpenAI, Anthropic, or pi tool definitions. */
export function toolNameOf(tool) {
  if (!tool || typeof tool !== "object") return "";
  return String(tool.name || tool.function?.name || "").trim();
}

/**
 * Canonicalize a wire `tools` array:
 * - Deterministic alphabetical order by tool name (preserving tie order)
 * - Recursively sorted JSON Schema keys on `parameters` / `input_schema` / `function.parameters`
 * - Preserves provider-specific metadata (e.g. `type`, `strict`, `cache_control`)
 */
export function canonicalizeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  const normalized = tools.map((tool, index) => {
    if (!tool || typeof tool !== "object") return { name: "", index, value: tool };
    const name = toolNameOf(tool);
    let cloned;
    if (tool.type === "function" && tool.function && typeof tool.function === "object") {
      cloned = {
        ...tool,
        function: {
          ...tool.function,
          ...(tool.function.parameters ? { parameters: canonicalizeSchema(tool.function.parameters) } : {}),
        },
      };
    } else {
      cloned = { ...tool };
      if (cloned.input_schema && typeof cloned.input_schema === "object") {
        cloned.input_schema = canonicalizeSchema(cloned.input_schema);
      }
      if (cloned.parameters && typeof cloned.parameters === "object") {
        cloned.parameters = canonicalizeSchema(cloned.parameters);
      }
    }
    return { name, index, value: cloned };
  });

  normalized.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return a.index - b.index;
  });
  return normalized.map((entry) => entry.value);
}

/** Extract static system text from either Anthropic (`payload.system`) or OpenAI (`messages[0].role === system|developer`). */
function extractSystemFingerprint(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.system === "string") return payload.system;
  if (Array.isArray(payload.system)) {
    return payload.system
      .map((blk) => (typeof blk === "string" ? blk : String(blk?.text ?? "")))
      .join("\n---\n");
  }
  if (typeof payload.instructions === "string") return payload.instructions;
  if (Array.isArray(payload.messages)) {
    const sys = payload.messages.filter((m) => m && (m.role === "system" || m.role === "developer"));
    if (sys.length) {
      return sys
        .map((m) => {
          if (typeof m.content === "string") return m.content;
          if (Array.isArray(m.content)) {
            return m.content.map((c) => (typeof c === "string" ? c : String(c?.text ?? ""))).join("\n");
          }
          return "";
        })
        .join("\n---\n");
    }
  }
  return "";
}

/** Strip transient `cache_control` markers before hashing so rolling checkpoints don't look like busts. */
function stripCacheControl(value) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stripCacheControl(item));
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "cache_control" || value[key] === undefined) continue;
    out[key] = stripCacheControl(value[key]);
  }
  return out;
}

/**
 * Compute a deterministic 16-char SHA-256 fingerprint of the static prefix
 * (`system` prompt + canonical wire `tools`).
 */
export function computePrefixHash({ system, tools }) {
  const material = stableStringify({
    system: String(system ?? ""),
    tools: Array.isArray(tools) ? tools.map((t) => stripCacheControl(t)) : [],
  });
  return crypto.createHash("sha256").update(material, "utf8").digest("hex").slice(0, 16);
}

/**
 * Build a provider-safe, deterministic `prompt_cache_key` (<= 64 chars)
 * for OpenAI / DeepSeek / Magpie gateway sticky prefix cache routing.
 */
export function buildStablePromptCacheKey({ sessionKey = "default", modelId = "", prefixHash = "" } = {}) {
  const cleanSession = String(sessionKey || "default")
    .replace(/[^a-zA-Z0-9_:-]/g, "_")
    .slice(0, 28);
  const cleanModel = String(modelId || "")
    .split("/")
    .pop()
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 16);
  const cleanHash = String(prefixHash || "").replace(/[^a-fA-F0-9]/g, "").slice(0, 12);
  const parts = ["af", cleanSession, cleanModel, cleanHash].filter(Boolean);
  return parts.join(":").slice(0, 64);
}

/** Detect whether a wire payload speaks the Anthropic Messages protocol. */
export function isAnthropicPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if ("system" in payload && !("instructions" in payload)) return true;
  if (Array.isArray(payload.tools) && payload.tools.some((t) => t && "input_schema" in t)) return true;
  return false;
}

/**
 * Apply rolling ephemeral `cache_control` breakpoints to an Anthropic Messages
 * payload (OpenCode / Claude Code 4-breakpoint strategy):
 *   1. Last system text block
 *   2. Last tool declaration
 *   3. Last 2 message turns (penultimate + latest user/tool_result turn),
 *      stripping stale markers from older messages so we never exceed 4 blocks.
 */
export function applyAnthropicCacheBreakpoints(payload, { retention = "short", supportsLongTtl = false } = {}) {
  if (!payload || typeof payload !== "object" || retention === "none") return payload;

  const marker = {
    type: "ephemeral",
    ...(retention === "long" && supportsLongTtl ? { ttl: "1h" } : {}),
  };
  let used = 0;
  const next = { ...payload };

  // 1. System prompt breakpoint
  if (typeof next.system === "string" && next.system.trim()) {
    next.system = [{ type: "text", text: next.system, cache_control: { ...marker } }];
    used += 1;
  } else if (Array.isArray(next.system) && next.system.length > 0) {
    next.system = next.system.map((block, idx) => {
      if (!block || typeof block !== "object") return block;
      const clean = { ...block };
      delete clean.cache_control;
      if (idx === next.system.length - 1 && used < MAX_ANTHROPIC_BREAKPOINTS) {
        clean.cache_control = { ...marker };
        used += 1;
      }
      return clean;
    });
  }

  // 2. Tool schema breakpoint (on the last canonicalized tool)
  if (Array.isArray(next.tools) && next.tools.length > 0) {
    next.tools = next.tools.map((tool, idx) => {
      if (!tool || typeof tool !== "object") return tool;
      const clean = { ...tool };
      delete clean.cache_control;
      if (idx === next.tools.length - 1 && used < MAX_ANTHROPIC_BREAKPOINTS) {
        clean.cache_control = { ...marker };
        used += 1;
      }
      return clean;
    });
  }

  // 3. Rolling message checkpoints (at most remaining budget, up to 2 recent turns)
  if (Array.isArray(next.messages) && next.messages.length > 0) {
    const remaining = Math.min(2, Math.max(0, MAX_ANTHROPIC_BREAKPOINTS - used));
    // First strip any stale cache_control markers on all messages
    const cleaned = next.messages.map((msg) => {
      if (!msg || typeof msg !== "object") return msg;
      if (!Array.isArray(msg.content)) return { ...msg };
      return {
        ...msg,
        content: msg.content.map((blk) => {
          if (!blk || typeof blk !== "object") return blk;
          if (!("cache_control" in blk)) return blk;
          const copy = { ...blk };
          delete copy.cache_control;
          return copy;
        }),
      };
    });

    if (remaining > 0) {
      // Prefer placing checkpoints on the latest 2 user messages (stable turn tails)
      const candidateIndexes = [];
      for (let i = cleaned.length - 1; i >= 0 && candidateIndexes.length < remaining; i -= 1) {
        if (cleaned[i]?.role === "user") candidateIndexes.push(i);
      }
      for (const idx of candidateIndexes) {
        const msg = cleaned[idx];
        if (typeof msg.content === "string" && msg.content.length > 0) {
          msg.content = [{ type: "text", text: msg.content, cache_control: { ...marker } }];
          used += 1;
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
          // Attach to the last cacheable block (text / tool_result / image)
          for (let j = msg.content.length - 1; j >= 0; j -= 1) {
            const blk = msg.content[j];
            if (blk && typeof blk === "object" && (blk.type === "text" || blk.type === "tool_result" || blk.type === "image")) {
              msg.content[j] = { ...blk, cache_control: { ...marker } };
              used += 1;
              break;
            }
          }
        }
      }
    }
    next.messages = cleaned;
  }

  return next;
}

/**
 * Pure request-payload optimizer invoked from pi's `before_provider_request`.
 *
 * @param {object} payload
 * @param {{
 *   sessionKey?: string,
 *   modelId?: string,
 *   retention?: "none"|"short"|"long",
 *   supportsLongTtl?: boolean,
 *   prevPrefixHash?: string|null,
 *   prevSystemHash?: string|null,
 *   prevToolsHash?: string|null,
 * }} [opts]
 */
export function optimizeProviderPayload(payload, opts = {}) {
  if (!payload || typeof payload !== "object") {
    return {
      payload,
      prefixHash: null,
      systemHash: null,
      toolsHash: null,
      prefixStable: true,
      cacheBustReason: null,
      protocol: "unknown",
    };
  }

  const retention = opts.retention || process.env.FUSION_CACHE_RETENTION || process.env.PI_CACHE_RETENTION || "long";
  let next = { ...payload };

  // Assembly Line 2: Canonicalize wire tool declarations for byte-stable prefix
  if (Array.isArray(next.tools) && next.tools.length > 0) {
    next.tools = canonicalizeTools(next.tools);
  }

  const systemText = extractSystemFingerprint(next);
  const systemHash = computePrefixHash({ system: systemText, tools: [] });
  const toolsHash = computePrefixHash({ system: "", tools: next.tools || [] });
  const prefixHash = computePrefixHash({ system: systemText, tools: next.tools || [] });

  let prefixStable = true;
  let cacheBustReason = null;
  if (opts.prevPrefixHash && opts.prevPrefixHash !== prefixHash) {
    prefixStable = false;
    const reasons = [];
    if (opts.prevSystemHash && opts.prevSystemHash !== systemHash) reasons.push("system_prompt_changed");
    if (opts.prevToolsHash && opts.prevToolsHash !== toolsHash) reasons.push("tool_schema_changed");
    cacheBustReason = reasons.length ? reasons.join("+") : "prefix_changed";
  }

  const anthropic = isAnthropicPayload(next);
  const protocol = anthropic ? "anthropic" : "openai";

  if (retention !== "none") {
    if (anthropic) {
      next = applyAnthropicCacheBreakpoints(next, {
        retention,
        supportsLongTtl: Boolean(opts.supportsLongTtl),
      });
    } else if (!next.prompt_cache_key && Array.isArray(next.messages)) {
      // OpenAI / DeepSeek / Magpie Chat Completions sticky cache key
      const modelId = String(opts.modelId || next.model || "");
      next.prompt_cache_key = buildStablePromptCacheKey({
        sessionKey: opts.sessionKey || "default",
        modelId,
        prefixHash,
      });
    }
  }

  return {
    payload: next,
    prefixHash,
    systemHash,
    toolsHash,
    prefixStable,
    cacheBustReason,
    protocol,
  };
}

/**
 * Assembly Line 1: Strictly static room/role appendix for `appendSystemPrompt`.
 * Intentionally excludes volatile runtime facts (files list, mutable topic,
 * live member roster, timestamps) which belong in per-turn user messages so
 * the system prompt prefix never changes across turns.
 */
export function buildStableRoomAppendix({ roomId = null, roomTitle = "", readOnly = false } = {}) {
  const lines = [];
  if (roomId) {
    lines.push("# 当前群聊（静态标识）");
    lines.push(`- 房间：${roomTitle ? `${roomTitle}（room_id: ${roomId}）` : roomId}`);
    lines.push("- 群内动态事实（成员、议题、群文件清单、任务分派）均在每轮消息中增量提供，请以最新一轮为准。");
    lines.push("- 你的回复会作为一条群消息发给所有人，不要输出元信息（如「好的，我这就……」）。");
  } else {
    lines.push("# 当前会话（1v1 高效直连）");
    lines.push("- 这是 1v1 私聊直连工作台，跳过群聊调度，直接面向用户高效交付结果。");
    lines.push("- 项目目录与分支变更会在用户消息中增量提示；所有文件与终端操作默认在当前项目目录执行。");
  }
  if (readOnly) {
    lines.push("- 你是只读成员：不要尝试写文件或执行变更类命令。");
  }
  return lines.join("\n");
}

/**
 * Compute prompt cache hit rate (%) from normalized turn token usage.
 * Formula: cacheRead / (input + cacheRead + cacheWrite) * 100
 */
export function computeCacheHitRate(usage = {}) {
  const input = Math.max(0, Number(usage?.input ?? usage?.input_tokens ?? 0));
  const cacheRead = Math.max(0, Number(usage?.cacheRead ?? usage?.cache_read_tokens ?? usage?.cache_read ?? 0));
  const cacheWrite = Math.max(0, Number(usage?.cacheWrite ?? usage?.cache_write_tokens ?? usage?.cache_write ?? 0));
  const totalPromptTokens = input + cacheRead + cacheWrite;
  if (totalPromptTokens <= 0) {
    return { hitRatePct: 0, cachedTokens: 0, totalPromptTokens: 0 };
  }
  const hitRatePct = Math.round((cacheRead / totalPromptTokens) * 1000) / 10;
  return {
    hitRatePct,
    cachedTokens: cacheRead,
    totalPromptTokens,
  };
}

/**
 * Create the pi inline extension that enforces dsh + OpenCode cache discipline
 * on every outgoing provider request.
 *
 * @param {{
 *   sessionKey?: string,
 *   modelId?: string,
 *   retention?: "none"|"short"|"long",
 *   supportsLongTtl?: boolean,
 *   onMetrics?: (info: object) => void,
 * }} [options]
 */
export function createCacheOptimizerExtension(options = {}) {
  let prevPrefixHash = null;
  let prevSystemHash = null;
  let prevToolsHash = null;
  let requestCount = 0;
  let stableCount = 0;
  let bustCount = 0;

  return (pi) => {
    pi.on("before_provider_request", async (event) => {
      if (!event?.payload || typeof event.payload !== "object") return undefined;
      const result = optimizeProviderPayload(event.payload, {
        sessionKey: options.sessionKey,
        modelId: options.modelId,
        retention: options.retention,
        supportsLongTtl: options.supportsLongTtl,
        prevPrefixHash,
        prevSystemHash,
        prevToolsHash,
      });

      requestCount += 1;
      // First request establishes the baseline prefix; subsequent requests test stability
      const isSubsequent = prevPrefixHash !== null;
      if (!isSubsequent || result.prefixStable) {
        stableCount += 1;
      } else {
        bustCount += 1;
        log.warn(
          `[cache-bust] session=${options.sessionKey || "default"} reason=${result.cacheBustReason} prev=${prevPrefixHash} next=${result.prefixHash}`,
        );
      }

      prevPrefixHash = result.prefixHash;
      prevSystemHash = result.systemHash;
      prevToolsHash = result.toolsHash;

      try {
        options.onMetrics?.({
          sessionKey: options.sessionKey || "default",
          prefixHash: result.prefixHash,
          prefixStable: !isSubsequent || result.prefixStable,
          cacheBustReason: result.cacheBustReason,
          protocol: result.protocol,
          requestCount,
          stableCount,
          bustCount,
        });
      } catch {
        /* telemetry listener must never break model requests */
      }

      return result.payload;
    });
  };
}

export default createCacheOptimizerExtension;
