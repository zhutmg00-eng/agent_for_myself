/**
 * Model runtime + gateway model catalog.
 *
 * At startup we probe the local Magpie gateway (`http://127.0.0.1:3425/v1`),
 * turn its `/v1/models` answer into `.pi-agent/models.json` for pi (provider
 * `magpie`), and build a `ModelRuntime` on top of it. When the gateway is down we
 * keep working from the previously written `models.json`.
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

/** Gateway model ids that speak the Anthropic messages protocol. */
function isAnthropicModel(id) {
  return String(id || "").startsWith("zcode/");
}

/** api + baseUrl a gateway model must use inside pi's models.json. */
export function providerTransportFor(id) {
  const gw = String(GATEWAY_ORIGIN || "http://127.0.0.1:3425").replace(/\/+$/, "");
  if (isAnthropicModel(id)) return { api: "anthropic-messages", baseUrl: gw };
  return { api: "openai-completions", baseUrl: String(GATEWAY_URL || `${gw}/v1`).replace(/\/+$/, "") };
}

/**
 * Normalise one gateway `/v1/models` entry into the object the rest of the app
 * uses. Keeps the gateway's own fields (display_name/owned_by/context_length...)
 * so `/api/models` can pass it through unchanged.
 * @param {object} raw
 * @param {number} index
 */
export function normalizeModel(raw, index = 0) {
  const id = String(raw?.id || "").trim();
  if (!id) return null;
  const transport = providerTransportFor(id);
  const modalities = raw?.modalities?.input || raw?.input;
  const input = Array.isArray(modalities) && modalities.length ? modalities.map(String) : ["text"];
  const contextWindow = Number(raw?.context_window || raw?.context_length || raw?.contextWindow || 128000);
  const maxTokens = Number(raw?.max_output_tokens || raw?.max_tokens || raw?.maxTokens || 16384);
  const name = String(raw?.display_name || raw?.name || id);
  return {
    ...raw,
    id,
    name,
    display_name: name,
    owned_by: String(raw?.owned_by || id.split("/")[0] || PROVIDER_ID),
    provider: PROVIDER_ID,
    api: transport.api,
    baseUrl: transport.baseUrl,
    reasoning: Boolean(raw?.reasoning),
    input,
    contextWindow,
    context_length: contextWindow,
    maxTokens,
    max_output_tokens: maxTokens,
    tool_call: raw?.tool_call === undefined ? true : Boolean(raw.tool_call),
    index,
  };
}

/** Build the pi `models.json` document for a normalised model list. */
export function buildModelsJson(models) {
  const entries = (models || [])
    .filter((m) => m && m.id)
    .map((m) => {
      const transport = providerTransportFor(m.id);
      const entry = {
        id: m.id,
        name: m.name || m.id,
        input: Array.isArray(m.input) && m.input.length ? m.input : ["text"],
        reasoning: Boolean(m.reasoning),
        contextWindow: Number(m.contextWindow || m.context_length || 128000),
        maxTokens: Number(m.maxTokens || m.max_output_tokens || 16384),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      // Provider-level api/baseUrl cover the OpenAI-compatible majority; only the
      // Anthropic-speaking family needs per-model overrides (see spec §2).
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
        baseUrl: String(GATEWAY_URL || `${GATEWAY_ORIGIN}/v1`).replace(/\/+$/, ""),
        api: "openai-completions",
        apiKey: "magpie-local",
        compat: { sendSessionAffinityHeaders: true },
        models: entries,
      },
    },
  };
}

/** Write `.pi-agent/models.json` (D: only). Returns the absolute path. */
export function writeModelsJson(models) {
  const file = assertNotC(MODELS_FILE, "models.json");
  ensureDirs();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doc = buildModelsJson(models);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
  fs.renameSync(tmp, file);
  log.info(`wrote ${doc.providers[PROVIDER_ID].models.length} models to ${file}`);
  return file;
}

/** Read the existing models.json back as normalised models (fallback path). */
export function readModelsFile() {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8"));
  } catch {
    return { models: [], error: "models.json not readable" };
  }
  const provider = doc?.providers?.[PROVIDER_ID] || Object.values(doc?.providers || {})[0];
  const rawList = Array.isArray(provider?.models) ? provider.models : [];
  const models = rawList
    .map((m, i) =>
      normalizeModel(
        {
          id: m.id,
          display_name: m.name,
          owned_by: PROVIDER_ID,
          reasoning: m.reasoning,
          context_length: m.contextWindow,
          max_output_tokens: m.maxTokens,
          modalities: { input: m.input },
          tool_call: true,
        },
        i,
      ),
    )
    .filter(Boolean);
  return { models, error: null };
}

/**
 * Probe the gateway model catalog.
 * @param {{url?:string, timeoutMs?:number, fetchImpl?:Function}} [opts]
 * @returns {Promise<{ok:boolean, url:string, models:object[], error?:string, ms:number}>}
 */
export async function fetchGatewayModels(opts = {}) {
  const url = String(opts.url || GATEWAY_URL || "").replace(/\/+$/, "");
  const endpoint = `${url}/models`;
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
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    const models = list.map((m, i) => normalizeModel(m, i)).filter(Boolean);
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
function seedMinimalModels() {
  return [
    normalizeModel(
      {
        id: DEFAULT_MODEL,
        display_name: DEFAULT_MODEL,
        owned_by: DEFAULT_MODEL.split("/")[0],
        reasoning: true,
        context_length: 1000000,
        max_output_tokens: 32768,
        modalities: { input: ["text"] },
        tool_call: true,
      },
      0,
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
 * @param {{store?:object, gatewayUrl?:string, skipGateway?:boolean}} [opts]
 */
export async function createEngine(opts = {}) {
  ensureDirs();
  const { ModelRuntime } = await loadPi();

  let gatewayStatus;
  let models = [];
  if (!opts.skipGateway) {
    const probe = await fetchGatewayModels({ url: opts.gatewayUrl });
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
        writeModelsJson(models);
      } catch (err) {
        log.error("failed to write models.json", err?.message || err);
      }
    } else {
      log.warn(`gateway unavailable (${probe.error}); falling back to ${MODELS_FILE}`);
    }
  } else {
    gatewayStatus = {
      ok: false,
      url: `${String(GATEWAY_URL).replace(/\/+$/, "")}/models`,
      models: 0,
      error: "gateway probe skipped",
    };
  }

  if (!models.length) {
    const fromFile = readModelsFile();
    models = fromFile.models;
    if (!models.length) {
      models = seedMinimalModels();
      try {
        writeModelsJson(models);
      } catch (err) {
        log.error("failed to seed models.json", err?.message || err);
      }
    }
  }

  const modelRuntime = await ModelRuntime.create({
    authPath: assertNotC(AUTH_FILE, "auth.json"),
    modelsPath: assertNotC(MODELS_FILE, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: true,
  });

  function defaultModelRef() {
    const pref = modelRuntime.getModel(PROVIDER_ID, stripProvider(DEFAULT_MODEL));
    if (pref) return pref;
    const first = models.find((m) => modelRuntime.getModel(PROVIDER_ID, m.id));
    return first ? modelRuntime.getModel(PROVIDER_ID, first.id) : undefined;
  }

  /** Resolve a model id (full gateway id, `magpie/<id>` or bare suffix). */
  function getModel(id) {
    const wanted = stripProvider(id);
    if (!wanted) return defaultModelRef();
    const direct = modelRuntime.getModel(PROVIDER_ID, wanted);
    if (direct) return direct;
    // tolerate a bare short name such as `deepseek-v4.1-flash`
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

  const defaultModel = defaultModelRef();
  if (!defaultModel) log.error(`no model could be resolved from ${MODELS_FILE}`);

  const engine = {
    pi: await loadPi(),
    modelRuntime,
    models,
    getModel,
    defaultModel,
    defaultModelId: defaultModel?.id || DEFAULT_MODEL,
    gatewayStatus,
    modelsFile: MODELS_FILE,
    provider: PROVIDER_ID,
    /** Re-probe the gateway and rewrite models.json (used by /api/models). */
    async reloadModels() {
      const probe = await fetchGatewayModels({ url: opts.gatewayUrl });
      if (probe.ok) {
        models = probe.models;
        engine.models = models;
        try {
          writeModelsJson(models);
        } catch (err) {
          log.warn("reloadModels: write failed", err?.message || err);
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
