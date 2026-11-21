/**
 * Model runtime + gateway model catalog.
 *
 * At startup we probe the configured OpenAI/Anthropic-compatible gateway
 * (default `http://127.0.0.1:3425/v1`), recognise every model family it
 * exposes (Claude, OpenAI, Gemini, DeepSeek, Qwen, Kimi, GLM, Hunyuan,
 * MiniMax, Llama, Mistral, Grok, custom models...), write `.pi-agent/models.json`
 * for pi (provider `magpie`), and build a live `ModelRuntime` on top of it.
 *
 * When the user changes gateway URL, refreshes `/api/models`, or assigns a
 * specific model to any group member, the runtime re-probes / registers the
 * model and reloads `ModelRuntime` so sessions use the exact selected model.
 */
import fs from "node:fs";
import path from "node:path";
import { DIRS, GATEWAY_URL, GATEWAY_ORIGIN, DEFAULT_MODEL, assertNotC, ensureDirs } from "../config.js";
import { createLogger } from "../log.js";
import { loadPi } from "./pi.js";

const log = createLogger("engine.runtime");

export const PROVIDER_ID = "magpie";
export const PROVIDER_NAME = "Magpie Gateway";
export const DEFAULT_GATEWAY_MODEL = DEFAULT_MODEL;
export const MODELS_FILE = path.join(DIRS.sharedAgent, "models.json");
export const AUTH_FILE = path.join(DIRS.sharedAgent, "auth.json");

const MODEL_FAMILIES = [
  {
    family: "claude",
    label: "Anthropic Claude",
    test: /(?:^|\/|-)(?:claude|zcode)/i,
    defaultCtx: 200000,
    defaultMaxOut: 16384,
    vision: /claude-(?:3|4)|sonnet|opus|haiku|zcode/i,
    reasoning: /claude-(?:3[.-]7|4)|opus-4|sonnet-4|thinking/i,
  },
  {
    family: "openai",
    label: "OpenAI",
    test: /(?:^|\/|-)(?:gpt|chatgpt|o1|o3|o4)(?:$|[-_./\d])/i,
    defaultCtx: 128000,
    defaultMaxOut: 16384,
    vision: /gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|o1|o3|o4/i,
    reasoning: /(?:^|\/|-)(?:o1|o3|o4|gpt-5)(?:$|[-_./\d])/i,
  },
  {
    family: "gemini",
    label: "Google Gemini",
    test: /(?:^|\/|-)gemini/i,
    defaultCtx: 1000000,
    defaultMaxOut: 65536,
    vision: /gemini/i,
    reasoning: /gemini-(?:2\.5|3|2\.0-flash-thinking)|thinking|pro/i,
  },
  {
    family: "deepseek",
    label: "DeepSeek",
    test: /(?:^|\/|-)deepseek/i,
    defaultCtx: 128000,
    defaultMaxOut: 32768,
    vision: /vl|vision/i,
    reasoning: /r1|reasoner|v3\.2|v4|thinking/i,
  },
  {
    family: "qwen",
    label: "Qwen 通义",
    test: /(?:^|\/|-)(?:qwen|qwq)/i,
    defaultCtx: 131072,
    defaultMaxOut: 16384,
    vision: /vl|omni|vision/i,
    reasoning: /qwq|qwen3|thinking/i,
  },
  {
    family: "kimi",
    label: "Kimi / Moonshot",
    test: /(?:^|\/|-)(?:kimi|moonshot)/i,
    defaultCtx: 256000,
    defaultMaxOut: 16384,
    vision: /vision|vl|k2/i,
    reasoning: /thinking|k1\.5|k2/i,
  },
  {
    family: "glm",
    label: "Zhipu GLM",
    test: /(?:^|\/|-)(?:glm|chatglm)/i,
    defaultCtx: 128000,
    defaultMaxOut: 16384,
    vision: /4v|vision|vl/i,
    reasoning: /z1|thinking|glm-4\.5|glm-5/i,
  },
  {
    family: "hunyuan",
    label: "Hunyuan 混元",
    test: /(?:^|\/|-)(?:hunyuan|hy3)/i,
    defaultCtx: 192000,
    defaultMaxOut: 32768,
    vision: /vision|vl/i,
    reasoning: /t1|hy3|thinking/i,
  },
  {
    family: "minimax",
    label: "MiniMax",
    test: /(?:^|\/|-)(?:minimax|abab)/i,
    defaultCtx: 200000,
    defaultMaxOut: 16384,
    vision: /vl|vision/i,
    reasoning: /m1|m2|thinking/i,
  },
  {
    family: "doubao",
    label: "Doubao 豆包",
    test: /(?:^|\/|-)(?:doubao|seed)/i,
    defaultCtx: 128000,
    defaultMaxOut: 16384,
    vision: /vision|vl|1\.5-pro|1\.6/i,
    reasoning: /thinking|1\.6|seed/i,
  },
  {
    family: "llama",
    label: "Meta Llama",
    test: /(?:^|\/|-)llama/i,
    defaultCtx: 128000,
    defaultMaxOut: 16384,
    vision: /vision|llama-4/i,
    reasoning: /reasoning/i,
  },
  {
    family: "mistral",
    label: "Mistral",
    test: /(?:^|\/|-)(?:mistral|mixtral|codestral|pixtral|devstral)/i,
    defaultCtx: 128000,
    defaultMaxOut: 16384,
    vision: /pixtral/i,
    reasoning: /magistral/i,
  },
  {
    family: "grok",
    label: "xAI Grok",
    test: /(?:^|\/|-)grok/i,
    defaultCtx: 131072,
    defaultMaxOut: 16384,
    vision: /vision|grok-2|grok-3|grok-4/i,
    reasoning: /grok-3|grok-4|mini|thinking/i,
  },
];

function prettifyModelName(id) {
  const raw = String(id || "").trim();
  if (!raw) return "";
  const bare = raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw;
  const known = bare
    .replace(/^deepseek[-_]?/i, "DeepSeek ")
    .replace(/^claude[-_]?/i, "Claude ")
    .replace(/^gpt[-_]?/i, "GPT-")
    .replace(/^gemini[-_]?/i, "Gemini ")
    .replace(/^qwen[-_]?/i, "Qwen ")
    .replace(/^qwq[-_]?/i, "QwQ ")
    .replace(/^kimi[-_]?/i, "Kimi ")
    .replace(/^moonshot[-_]?/i, "Moonshot ")
    .replace(/^glm[-_]?/i, "GLM-")
    .replace(/^hunyuan[-_]?/i, "Hunyuan ")
    .replace(/^hy3$/i, "Hunyuan 3")
    .replace(/^minimax[-_]?/i, "MiniMax ")
    .replace(/^doubao[-_]?/i, "Doubao ")
    .replace(/^llama[-_]?/i, "Llama ")
    .replace(/^grok[-_]?/i, "Grok ")
    .replace(/^mistral[-_]?/i, "Mistral ")
    .replace(/^codestral[-_]?/i, "Codestral ");
  return known
    .replace(/[-_]+/g, " ")
    .replace(/\b(flash|pro|max|mini|nano|turbo|plus|lite|air|sonnet|opus|haiku|coder|reasoner|chat|preview|thinking|instruct)\b/gi, (m) => m[0].toUpperCase() + m.slice(1).toLowerCase())
    .replace(/\s+/g, " ")
    .trim() || raw;
}

/**
 * Recognise a gateway model's vendor family, display name, capabilities, and
 * sensible defaults when the gateway `/v1/models` response omits metadata.
 */
export function inferModelMeta(id, raw = {}) {
  const cleanId = String(id || "").trim();
  const ownedBy = String(raw?.owned_by || raw?.owner || "").trim();
  const hay = `${cleanId} ${raw?.display_name || raw?.name || ""} ${ownedBy}`;
  const matched = MODEL_FAMILIES.find((spec) => spec.test.test(hay));
  const prefix = cleanId.includes("/") ? cleanId.split("/")[0] : "";

  const family = matched?.family || (prefix && !["auto", "default", "magpie", "local"].includes(prefix.toLowerCase()) ? prefix.toLowerCase() : "other");
  const family_label = matched?.label || (ownedBy && ownedBy.toLowerCase() !== PROVIDER_ID && ownedBy.toLowerCase() !== "auto" ? ownedBy : "网关模型");

  const rawDisplay = String(raw?.display_name || raw?.displayName || raw?.name || "").trim();
  const display_name = rawDisplay && rawDisplay !== cleanId ? rawDisplay : prettifyModelName(cleanId);

  const explicitReasoning = raw?.reasoning ?? raw?.capabilities?.reasoning;
  const reasoning = explicitReasoning !== undefined
    ? Boolean(explicitReasoning)
    : Boolean(matched?.reasoning?.test(cleanId) || /reason|r1|thinking|o1|o3|o4/i.test(cleanId));

  const rawModalities = raw?.modalities?.input || raw?.input;
  const hasVision = Boolean(matched?.vision?.test(cleanId) || /vision|vl\b|multimodal/i.test(cleanId));
  const input = Array.isArray(rawModalities) && rawModalities.length
    ? rawModalities.map(String)
    : (hasVision ? ["text", "image"] : ["text"]);

  const contextWindow = Number(
    raw?.context_window
    || raw?.context_length
    || raw?.contextWindow
    || raw?.max_context_length
    || matched?.defaultCtx
    || 128000,
  );
  const maxTokens = Number(
    raw?.max_output_tokens
    || raw?.max_tokens
    || raw?.maxTokens
    || matched?.defaultMaxOut
    || 16384,
  );

  return {
    family,
    family_label,
    display_name,
    owned_by: ownedBy || prefix || family || PROVIDER_ID,
    reasoning,
    input,
    contextWindow,
    maxTokens,
  };
}

/** Gateway model ids that speak the Anthropic messages protocol. */
function isAnthropicModel(id) {
  return String(id || "").startsWith("zcode/");
}

function originFromGatewayUrl(url) {
  try {
    return new URL(String(url || GATEWAY_URL)).origin;
  } catch {
    return String(GATEWAY_ORIGIN || "http://127.0.0.1:3425").replace(/\/+$/, "");
  }
}

function normalizeGatewayBaseUrl(url) {
  const s = String(url || GATEWAY_URL || "http://127.0.0.1:3425/v1").trim().replace(/\/+$/, "");
  return s || "http://127.0.0.1:3425/v1";
}

/** api + baseUrl a gateway model must use inside pi's models.json. */
export function providerTransportFor(id, gatewayUrl = GATEWAY_URL) {
  const base = normalizeGatewayBaseUrl(gatewayUrl);
  const origin = originFromGatewayUrl(base);
  if (isAnthropicModel(id)) return { api: "anthropic-messages", baseUrl: origin };
  return { api: "openai-completions", baseUrl: base };
}

/**
 * Normalise one gateway `/v1/models` entry into the object the rest of the app
 * uses. Accepts both rich objects and bare string model IDs.
 * @param {object|string} raw
 * @param {number} index
 * @param {string} [gatewayUrl]
 */
export function normalizeModel(raw, index = 0, gatewayUrl = GATEWAY_URL) {
  const obj = typeof raw === "string" ? { id: raw } : (raw && typeof raw === "object" ? raw : null);
  const id = String(obj?.id || obj?.model || obj?.name || "").trim();
  if (!id) return null;
  const transport = providerTransportFor(id, gatewayUrl);
  const meta = inferModelMeta(id, obj);
  return {
    ...obj,
    id,
    name: meta.display_name,
    display_name: meta.display_name,
    family: meta.family,
    family_label: meta.family_label,
    owned_by: meta.owned_by,
    provider: PROVIDER_ID,
    api: transport.api,
    baseUrl: transport.baseUrl,
    reasoning: meta.reasoning,
    input: meta.input,
    contextWindow: meta.contextWindow,
    context_length: meta.contextWindow,
    maxTokens: meta.maxTokens,
    max_output_tokens: meta.maxTokens,
    tool_call: obj?.tool_call === undefined ? true : Boolean(obj.tool_call),
    index,
  };
}

/** Build the pi `models.json` document for a normalised model list. */
export function buildModelsJson(models, gatewayUrl = GATEWAY_URL) {
  const base = normalizeGatewayBaseUrl(gatewayUrl);
  const entries = (models || [])
    .filter((m) => m && m.id)
    .map((m) => {
      const transport = providerTransportFor(m.id, base);
      const entry = {
        id: m.id,
        name: m.display_name || m.name || m.id,
        input: Array.isArray(m.input) && m.input.length ? m.input : ["text"],
        reasoning: Boolean(m.reasoning),
        contextWindow: Number(m.contextWindow || m.context_length || 128000),
        maxTokens: Number(m.maxTokens || m.max_output_tokens || 16384),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      if (transport.api !== "openai-completions") {
        entry.api = transport.api;
        entry.baseUrl = transport.baseUrl;
      }
      return entry;
    });
  return {
    $schema: "https://pi.dev/schemas/models.schema.json",
    providers: {
      [PROVIDER_ID]: {
        name: PROVIDER_NAME,
        baseUrl: base,
        api: "openai-completions",
        apiKey: "magpie-local",
        compat: {
          sendSessionAffinityHeaders: true,
          supportsCacheControlOnTools: true,
          supportsLongCacheRetention: true,
        },
        models: entries,
      },
    },
  };
}

/** Write `.pi-agent/models.json`. Returns the absolute path. */
export function writeModelsJson(models, gatewayUrl = GATEWAY_URL) {
  const file = assertNotC(MODELS_FILE, "models.json");
  ensureDirs();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doc = buildModelsJson(models, gatewayUrl);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
  fs.renameSync(tmp, file);
  log.info(`wrote ${doc.providers[PROVIDER_ID].models.length} models to ${file}`);
  return file;
}

/** Read the existing models.json back as normalised models (fallback path). */
export function readModelsFile(gatewayUrl = GATEWAY_URL) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8"));
  } catch {
    return { models: [], error: "models.json not readable" };
  }
  const provider = doc?.providers?.[PROVIDER_ID] || Object.values(doc?.providers || {})[0];
  const fileBase = provider?.baseUrl || gatewayUrl;
  const rawList = Array.isArray(provider?.models) ? provider.models : [];
  const models = rawList
    .map((m, i) =>
      normalizeModel(
        {
          id: m.id,
          display_name: m.name,
          owned_by: m.owned_by || "",
          reasoning: m.reasoning,
          context_length: m.contextWindow,
          max_output_tokens: m.maxTokens,
          modalities: { input: m.input },
          tool_call: true,
        },
        i,
        fileBase,
      ),
    )
    .filter(Boolean);
  return { models, error: null };
}

/** Extract raw model entries from OpenAI, Ollama, LiteLLM, or custom JSON payloads. */
function extractModelList(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.models)) return body.models;
  if (Array.isArray(body?.items)) return body.items;
  return [];
}

/**
 * Probe the gateway model catalog.
 * @param {{url?:string, timeoutMs?:number, fetchImpl?:Function}} [opts]
 * @returns {Promise<{ok:boolean, url:string, models:object[], error?:string, ms:number}>}
 */
export async function fetchGatewayModels(opts = {}) {
  const url = normalizeGatewayBaseUrl(opts.url || GATEWAY_URL);
  const endpoint = url.endsWith("/models") ? url : `${url}/models`;
  const timeoutMs = Number(opts.timeoutMs || 8000);
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const startedAt = Date.now();
  if (typeof doFetch !== "function") {
    return { ok: false, url: endpoint, models: [], error: "fetch is unavailable", ms: 0 };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(endpoint, {
      headers: { accept: "application/json", "user-agent": "AgentFusion/0.1" },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, url: endpoint, models: [], error: `HTTP ${res.status}`, ms: Date.now() - startedAt };
    }
    const body = await res.json();
    const list = extractModelList(body);
    const seen = new Set();
    const models = [];
    for (let i = 0; i < list.length; i += 1) {
      const m = normalizeModel(list[i], i, url);
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      models.push(m);
    }
    return {
      ok: models.length > 0,
      url: endpoint,
      models,
      error: models.length ? undefined : "empty catalog",
      ms: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      url: endpoint,
      models: [],
      error: err?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(err?.message || err),
      ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Ensure at least one usable model exists (gateway down + no file). */
function seedMinimalModels(gatewayUrl = GATEWAY_URL) {
  return [
    normalizeModel(
      {
        id: DEFAULT_MODEL,
        display_name: "DeepSeek V4.1 Flash",
        owned_by: DEFAULT_MODEL.split("/")[0],
        reasoning: true,
        context_length: 1000000,
        max_output_tokens: 32768,
        modalities: { input: ["text"] },
        tool_call: true,
      },
      0,
      gatewayUrl,
    ),
  ];
}

/** Strip a leading `magpie/` if the caller passed a provider-qualified id. */
function stripProvider(id) {
  const s = String(id || "").trim();
  return s.startsWith(`${PROVIDER_ID}/`) ? s.slice(PROVIDER_ID.length + 1) : s;
}

/**
 * Create the engine singleton used by rooms/bots/API.
 * @param {{store?:object, gatewayUrl?:string, defaultModel?:string, skipGateway?:boolean, fetchImpl?:Function}} [opts]
 */
export async function createEngine(opts = {}) {
  ensureDirs();
  const { ModelRuntime } = await loadPi();

  let activeGatewayUrl = normalizeGatewayBaseUrl(opts.gatewayUrl || GATEWAY_URL);
  let activeDefaultModelId = stripProvider(opts.defaultModel || DEFAULT_MODEL) || DEFAULT_MODEL;
  let gatewayStatus;
  let models = [];

  if (!opts.skipGateway) {
    const probe = await fetchGatewayModels({ url: activeGatewayUrl, fetchImpl: opts.fetchImpl });
    gatewayStatus = {
      ok: probe.ok,
      url: probe.url,
      models: probe.models.length,
      ms: probe.ms,
      ...(probe.error ? { error: probe.error } : {}),
    };
    if (probe.ok) {
      models = probe.models;
      try {
        writeModelsJson(models, activeGatewayUrl);
      } catch (err) {
        log.error("failed to write models.json", err?.message || err);
      }
    } else {
      log.warn(`gateway unavailable (${probe.error}); falling back to ${MODELS_FILE}`);
    }
  } else {
    gatewayStatus = {
      ok: false,
      url: `${activeGatewayUrl}/models`,
      models: 0,
      error: "gateway probe skipped",
    };
  }

  if (!models.length) {
    const fromFile = readModelsFile(activeGatewayUrl);
    models = fromFile.models;
    if (!models.length) {
      models = seedMinimalModels(activeGatewayUrl);
      try {
        writeModelsJson(models, activeGatewayUrl);
      } catch (err) {
        log.error("failed to seed models.json", err?.message || err);
      }
    }
  }

  // Ensure any persisted bot model overrides are also registered in models.json
  try {
    const storedBots = opts.store?.listBots?.() || [];
    const existingIds = new Set(models.map((m) => m.id));
    let added = false;
    for (const bot of storedBots) {
      const mId = stripProvider(bot?.model);
      if (mId && !existingIds.has(mId)) {
        const norm = normalizeModel({ id: mId }, models.length, activeGatewayUrl);
        if (norm) {
          models.push(norm);
          existingIds.add(mId);
          added = true;
        }
      }
    }
    if (activeDefaultModelId && !existingIds.has(activeDefaultModelId)) {
      const norm = normalizeModel({ id: activeDefaultModelId }, models.length, activeGatewayUrl);
      if (norm) {
        models.push(norm);
        added = true;
      }
    }
    if (added) writeModelsJson(models, activeGatewayUrl);
  } catch {
    /* ignore */
  }

  async function buildRuntime() {
    return ModelRuntime.create({
      authPath: assertNotC(AUTH_FILE, "auth.json"),
      modelsPath: assertNotC(MODELS_FILE, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: true,
    });
  }

  let modelRuntime = await buildRuntime();

  function defaultModelRef() {
    const pref = modelRuntime.getModel(PROVIDER_ID, stripProvider(activeDefaultModelId));
    if (pref) return pref;
    const fallbackPref = modelRuntime.getModel(PROVIDER_ID, stripProvider(DEFAULT_MODEL));
    if (fallbackPref) return fallbackPref;
    const first = models.find((m) => modelRuntime.getModel(PROVIDER_ID, m.id));
    return first ? modelRuntime.getModel(PROVIDER_ID, first.id) : undefined;
  }

  /** Resolve a model id (full gateway id, `magpie/<id>` or bare suffix). */
  function getModel(id) {
    const wanted = stripProvider(id);
    if (!wanted) return defaultModelRef();
    const direct = modelRuntime.getModel(PROVIDER_ID, wanted);
    if (direct) return direct;
    const suffixHit = models.find((m) => m.id === wanted || m.id.split("/").pop() === wanted);
    if (suffixHit) {
      const m = modelRuntime.getModel(PROVIDER_ID, suffixHit.id);
      if (m) return m;
    }
    const prefixHit = models.find((m) => wanted.startsWith(`${m.id}/`) || m.id.endsWith(`/${wanted}`));
    if (prefixHit) {
      const m = modelRuntime.getModel(PROVIDER_ID, prefixHit.id);
      if (m) return m;
    }
    return defaultModelRef();
  }

  /** Ensure an explicit model ID is present in models.json + live ModelRuntime. */
  async function ensureModel(id) {
    const wanted = stripProvider(id);
    if (!wanted) return defaultModelRef();
    const existing = modelRuntime.getModel(PROVIDER_ID, wanted);
    if (existing) return existing;
    if (!models.some((m) => m.id === wanted)) {
      const norm = normalizeModel({ id: wanted }, models.length, activeGatewayUrl);
      if (norm) models = [...models, norm];
      engine.models = models;
    }
    try {
      writeModelsJson(models, activeGatewayUrl);
      modelRuntime = await buildRuntime();
      engine.modelRuntime = modelRuntime;
      engine.defaultModel = defaultModelRef();
    } catch (err) {
      log.warn("ensureModel: runtime refresh failed", err?.message || err);
    }
    return getModel(wanted);
  }

  async function setDefaultModel(id) {
    const wanted = stripProvider(id);
    if (!wanted) return engine.defaultModel;
    activeDefaultModelId = wanted;
    const resolved = await ensureModel(wanted);
    engine.defaultModel = resolved || defaultModelRef();
    engine.defaultModelId = engine.defaultModel?.id || wanted;
    return engine.defaultModel;
  }

  const defaultModel = defaultModelRef();
  if (!defaultModel) log.error(`no model could be resolved from ${MODELS_FILE}`);

  const engine = {
    pi: await loadPi(),
    modelRuntime,
    models,
    getModel,
    ensureModel,
    setDefaultModel,
    defaultModel,
    defaultModelId: defaultModel?.id || activeDefaultModelId,
    gatewayUrl: activeGatewayUrl,
    gatewayStatus,
    modelsFile: MODELS_FILE,
    provider: PROVIDER_ID,
    /** Re-probe the gateway, rewrite models.json, and refresh live ModelRuntime. */
    async reloadModels(reloadOpts = {}) {
      if (reloadOpts?.url && String(reloadOpts.url).trim()) {
        activeGatewayUrl = normalizeGatewayBaseUrl(reloadOpts.url);
        engine.gatewayUrl = activeGatewayUrl;
      }
      const probe = await fetchGatewayModels({
        url: activeGatewayUrl,
        fetchImpl: reloadOpts?.fetchImpl || opts.fetchImpl,
      });
      if (probe.ok) {
        // Keep any custom user-assigned models that might not be listed by the gateway
        const probedIds = new Set(probe.models.map((m) => m.id));
        const customExtras = [];
        try {
          const storedBots = opts.store?.listBots?.() || [];
          for (const bot of storedBots) {
            const mId = stripProvider(bot?.model);
            if (mId && !probedIds.has(mId)) {
              const norm = normalizeModel({ id: mId }, probe.models.length + customExtras.length, activeGatewayUrl);
              if (norm) {
                customExtras.push(norm);
                probedIds.add(mId);
              }
            }
          }
        } catch {
          /* ignore */
        }
        models = [...probe.models, ...customExtras];
        engine.models = models;
        try {
          writeModelsJson(models, activeGatewayUrl);
          modelRuntime = await buildRuntime();
          engine.modelRuntime = modelRuntime;
          engine.defaultModel = defaultModelRef();
          engine.defaultModelId = engine.defaultModel?.id || activeDefaultModelId;
        } catch (err) {
          log.warn("reloadModels: write/refresh failed", err?.message || err);
        }
      } else if (reloadOpts?.url) {
        // Even if probe fails after a gateway URL change, update models.json baseUrl
        try {
          writeModelsJson(models, activeGatewayUrl);
          modelRuntime = await buildRuntime();
          engine.modelRuntime = modelRuntime;
        } catch (err) {
          log.warn("reloadModels: fallback baseUrl update failed", err?.message || err);
        }
      }
      engine.gatewayStatus = {
        ok: probe.ok,
        url: probe.url,
        models: models.length,
        ms: probe.ms,
        ...(probe.error ? { error: probe.error } : {}),
      };
      return engine.gatewayStatus;
    },
  };

  log.info(
    `engine ready: ${models.length} models, default=${engine.defaultModelId}, gateway=${
      gatewayStatus.ok ? "online" : `offline (${gatewayStatus.error})`
    }`,
  );
  return engine;
}

export default createEngine;
