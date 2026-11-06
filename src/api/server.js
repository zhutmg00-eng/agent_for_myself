/**
 * AgentFusion HTTP API — REST + SSE + static hosting, built on node:http only.
 *
 * Authoritative contract: docs/CONTRACT_API.md (reverse-engineered from
 * agentharness/cli/commands/server.py — the Python server the bundled web UI was
 * written against). Where FUSION_SPEC and CONTRACT_API disagree, the contract wins.
 *
 *   E01 GET  /api/health              E16 POST /api/hooks/reload
 *   E02 GET  /api/stats               E17 GET  /api/rooms
 *   E03 GET  /api/context             E18 POST /api/rooms
 *   E04 GET  /api/settings            E19 GET  /api/rooms/{id}
 *   E05 PUT  /api/settings            E20 PUT  /api/rooms/{id}
 *   E06 GET  /api/models              E21 GET  /api/rooms/{id}/messages
 *   E07 GET  /api/bots                E22 GET  /api/rooms/{id}/files
 *   E08 GET  /api/bots/{id}           E23 GET  /api/rooms/{id}/files/{file_id}
 *   E09 PUT  /api/bots/{id}           E24 POST /api/rooms/{id}/say
 *   E10 GET  /api/avatars             E25 GET  /api/thread/{thread_id}/events
 *   E11 GET  /api/avatars/{k}/{id}    E26 GET  /api/events          (SSE)
 *   E12 POST /api/avatars/{k}/{id}    E27 GET  /api/tickets
 *   E13 DEL  /api/avatars/{k}/{id}    E28 GET  /api/threads
 *   E14 GET  /api/skills              E29 POST /api/task
 *   E15 GET  /api/hooks
 *   S1 GET /  S2 GET /static/*  S3 GET /favicon.ico   + global OPTIONS 204
 *
 * No third-party dependencies: node:http, node:fs, node:path, node:crypto only.
 *
 * SSE frames are exactly `data: {"topic","sender","payload"}\n\n` with a
 * `: keepalive\n\n` comment every 15 s (CONTRACT_API §9.1). Persisted replay
 * (E25) is where seq/ts/thread_id live.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  ROOT,
  DIRS,
  DATA_ROOT,
  GATEWAY_URL,
  PORT_DEFAULT,
  HOST,
  DEFAULT_MODEL,
  ensureDirs,
  assertNotC,
  piPackageCandidates,
} from "../config.js";
import { createLogger, readTail } from "../log.js";
import { EventBus } from "../events.js";

const log = createLogger("api");

const WEB_ROOT = path.join(ROOT, "web");
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_FILE_PREVIEW_BYTES = 200_000;
const SSE_HEARTBEAT_MS = 15_000;
const MAX_PORT_RETRIES = 10;
const COMPACT_THRESHOLD_RATIO = 0.75;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

/** CONTRACT_API §E23 — exactly the Python text-extension set. */
const TEXT_FILE_EXTS = new Set([
  ".md", ".txt", ".json", ".py", ".js", ".mjs", ".ts", ".tsx", ".jsx",
  ".html", ".css", ".yml", ".yaml", ".csv", ".log", ".sh", ".ps1",
  ".toml", ".ini", ".cfg", ".xml", ".svg",
]);

const CHIEF_ID = "ChiefRouter";
const CHIEF_ALIASES = new Set(["chiefrouter", "chief", "router"]);

/* ------------------------------------------------------------------ basics */

function readJsonQuiet(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const PKG = readJsonQuiet(path.join(ROOT, "package.json")) || {};
const APP_VERSION = String(PKG.version || "0.1.0");

let kernelVersionCache;
function kernelVersion() {
  if (kernelVersionCache !== undefined) return kernelVersionCache;
  kernelVersionCache = null;
  try {
    const pkgDir = piPackageCandidates?.()[0];
    if (pkgDir) {
      const doc = readJsonQuiet(path.join(pkgDir, "package.json"));
      if (doc?.version) kernelVersionCache = String(doc.version);
    }
  } catch {
    /* pi not installed */
  }
  return kernelVersionCache;
}

function kernelLabel() {
  const version = kernelVersion();
  return version ? `pi ${version}` : "pi";
}

function isoNow() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeDecode(value) {
  const raw = String(value ?? "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function safeJsonParse(text, fallback) {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toInt(value, fallback = 0) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toFloat(value, fallback = 0) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** quiet `?int=` reader with clamping (CONTRACT_API §E21/E25 semantics). */
function qInt(url, name, fallback) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function errorMessage(err) {
  if (!err) return "internal error";
  if (typeof err === "string") return err;
  return String(err.message || err);
}

function statusForError(err, fallback = 500) {
  const explicit = Number(err?.status || err?.statusCode);
  if (explicit >= 400 && explicit < 600) return explicit;
  const message = errorMessage(err);
  if (
    /unknown|not found|invalid|must |required|duplicate|already exists|at least|outside/i.test(message)
  ) {
    return 400;
  }
  return fallback;
}

function jsonReplacer(_key, value) {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Error) return errorMessage(value);
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value === "function" || typeof value === "undefined") return undefined;
  return value;
}

function isEmptyObject(value) {
  return Boolean(value) && typeof value === "object" && Object.keys(value).length === 0;
}

/* --------------------------------------------------------------- responses */

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
}

function sendJson(res, status, data) {
  if (res.writableEnded || res.headersSent) return;
  let body;
  try {
    body = Buffer.from(JSON.stringify(data, jsonReplacer), "utf8");
  } catch (err) {
    status = 500;
    body = Buffer.from(JSON.stringify({ error: `serialization failed: ${errorMessage(err)}` }), "utf8");
  }
  try {
    applyCors(res);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    if (res.req?.method === "HEAD") res.end();
    else res.end(body);
  } catch {
    try {
      res.destroy();
    } catch {
      /* already gone */
    }
  }
}

function sendBuffer(res, status, payload, { contentType = "application/octet-stream", cacheControl = "no-cache" } = {}) {
  if (res.writableEnded || res.headersSent) return;
  try {
    applyCors(res);
    res.writeHead(status, {
      "Content-Type": contentType,
      "Content-Length": payload.length,
      "Cache-Control": cacheControl,
    });
    res.end(payload);
  } catch {
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  }
}

function sendOptions(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Length": 0,
  });
  res.end();
}

function notFound(res, message = "not found") {
  return sendJson(res, 404, { error: message });
}

/* ------------------------------------------------------------- body input */

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error("request body too large");
        err.status = 413;
        finish(err);
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(null, Buffer.concat(chunks)));
    req.on("error", (err) => finish(err));
    req.on("aborted", () => finish(Object.assign(new Error("request aborted"), { status: 400 })));
  });
}

/**
 * Parsed JSON body. Returns {} for an empty body. Throws 400 for malformed or
 * non-object payloads (CONTRACT_API §11.2 lets the Node port be explicit).
 */
async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  const text = buf.toString("utf8").trim();
  if (!text) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const err = new Error("payload must be valid JSON");
    err.status = 400;
    throw err;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const err = new Error("payload must be a JSON object");
    err.status = 400;
    throw err;
  }
  return value;
}

/* -------------------------------------------------------------- app wiring */

async function tryImportModule(specifier, label, app) {
  try {
    const mod = await import(specifier);
    app.wiring[label] = "ok";
    return mod;
  } catch (err) {
    app.wiring[label] = `unavailable: ${errorMessage(err)}`;
    app.errors[label] = errorMessage(err);
    log.warn(`optional module ${specifier} unavailable:`, errorMessage(err));
    return null;
  }
}

function pickFunction(mod, names) {
  if (!mod) return null;
  for (const name of names) {
    if (typeof mod[name] === "function") return mod[name].bind(mod);
  }
  if (typeof mod === "function") return mod;
  return null;
}

/**
 * Build the app: store → event bus → engine → skills → hooks → archetypes →
 * rooms → chief. Every module is optional at startup: a failure is recorded in
 * `app.errors` and the HTTP server still boots (static UI + /api/health).
 */
export async function createApp(options = {}) {
  ensureDirs();
  const app = {
    startedAt: Date.now(),
    version: APP_VERSION,
    host: options.host || HOST,
    port: null,
    store: null,
    events: null,
    engine: null,
    rooms: null,
    skills: null,
    hooksModule: null,
    archetypesModule: null,
    chiefModule: null,
    runChief: null,
    defaultBots: [],
    wiring: {},
    errors: {},
    ownsStore: false,
    stats: { requests: 0 },
    sse: new Set(),
    closing: false,
  };

  /* store */
  app.store = options.store || null;
  if (!app.store) {
    const storeMod = await tryImportModule("../store.js", "store", app);
    const StoreClass = storeMod?.Store || storeMod?.default?.Store || storeMod?.default;
    if (typeof StoreClass === "function") {
      try {
        app.store = new StoreClass(DIRS.dbFile);
        app.ownsStore = true;
      } catch (err) {
        app.errors.store = errorMessage(err);
        app.wiring.store = `failed: ${errorMessage(err)}`;
        log.error("store init failed:", errorMessage(err));
      }
    }
  } else {
    app.wiring.store = "injected";
  }

  /* event bus */
  app.events = options.events || new EventBus(app.store || null);
  app.wiring.events = options.events ? "injected" : "ok";

  /* engine (pi model runtime + gateway catalogue) */
  app.engine = options.engine || null;
  if (!app.engine) {
    const runtimeMod = await tryImportModule("../engine/runtime.js", "engine", app);
    const createEngine = pickFunction(runtimeMod, ["createEngine"]);
    if (createEngine) {
      try {
        app.engine = await createEngine({ store: app.store, events: app.events });
        app.wiring.engine = "ok";
      } catch (err) {
        app.errors.engine = errorMessage(err);
        app.wiring.engine = `failed: ${errorMessage(err)}`;
        log.error("engine init failed:", errorMessage(err));
      }
    }
  } else {
    app.wiring.engine = "injected";
  }

  /* skills */
  app.skills = options.skills || null;
  {
    const skillsMod = await tryImportModule("../skills.js", "skills", app);
    app.skillsModule = skillsMod;
    if (!app.skills) {
      const createSkills = pickFunction(skillsMod, ["createSkills", "loadSkills"]);
      if (createSkills) {
        try {
          app.skills = await createSkills();
          app.wiring.skills = "ok";
        } catch (err) {
          app.errors.skills = errorMessage(err);
          app.wiring.skills = `failed: ${errorMessage(err)}`;
          log.warn("skills init failed:", errorMessage(err));
        }
      }
    } else {
      app.wiring.skills = "injected";
    }
  }

  /* hooks */
  app.hooksModule = options.hooks || null;
  if (!app.hooksModule) {
    const hooksMod = await tryImportModule("../hooks.js", "hooks", app);
    app.hooksModule = hooksMod;
    if (hooksMod) {
      const loadHooks = pickFunction(hooksMod, ["loadHooks"]);
      if (loadHooks) {
        try {
          await loadHooks();
        } catch (err) {
          app.errors.hooks = errorMessage(err);
          log.warn("hooks load failed:", errorMessage(err));
        }
      }
    }
  } else {
    app.wiring.hooks = "injected";
  }

  /* archetypes (default bot roster) */
  {
    const archeMod = options.archetypes || (await tryImportModule("../engine/archetypes.js", "archetypes", app));
    app.archetypesModule = archeMod;
    const buildDefaultBots = pickFunction(archeMod, ["buildDefaultBots"]);
    if (buildDefaultBots) {
      try {
        const bots = await buildDefaultBots();
        if (Array.isArray(bots)) app.defaultBots = bots;
      } catch (err) {
        log.warn("buildDefaultBots failed:", errorMessage(err));
      }
    } else {
      const buildBot = pickFunction(archeMod, ["buildBot"]);
      const ids = Array.isArray(archeMod?.DEFAULT_BOT_IDS) ? archeMod.DEFAULT_BOT_IDS : [];
      if (buildBot) {
        for (const id of ids) {
          try {
            const bot = await buildBot(id);
            if (bot && typeof bot === "object") app.defaultBots.push(bot);
          } catch (err) {
            log.warn("buildBot failed for", id, errorMessage(err));
          }
        }
      }
    }
  }

  /* Hermes 吸收层：审批 / 技能遥测 / 技能策展 / 持久记忆（整进程单例，见 docs/hermes/） */
  app.approval = options.approval || null;
  if (!app.approval) {
    const approvalMod = await tryImportModule("../approval.js", "approval", app);
    const createApproval = pickFunction(approvalMod, ["createApproval"]);
    if (createApproval && app.store) {
      try {
        app.approval = createApproval({ store: app.store });
        app.wiring.approval = "ok";
      } catch (err) {
        app.errors.approval = errorMessage(err);
        app.wiring.approval = `failed: ${errorMessage(err)}`;
        log.warn("approval init failed:", errorMessage(err));
      }
    }
  } else {
    app.wiring.approval = "injected";
  }

  app.telemetry = options.telemetry || null;
  if (!app.telemetry && app.store) {
    const telemetryMod = await tryImportModule("../skills/telemetry.js", "telemetry", app);
    const createSkillTelemetry = pickFunction(telemetryMod, ["createSkillTelemetry"]);
    if (createSkillTelemetry) {
      try {
        app.telemetry = createSkillTelemetry({ store: app.store });
        app.wiring.telemetry = "ok";
      } catch (err) {
        app.errors.telemetry = errorMessage(err);
        app.wiring.telemetry = `failed: ${errorMessage(err)}`;
      }
    }
  } else if (app.telemetry) {
    app.wiring.telemetry = "injected";
  }

  app.curator = options.curator || null;
  if (!app.curator && app.store) {
    const curatorMod = await tryImportModule("../skills/curator.js", "curator", app);
    const createCurator = pickFunction(curatorMod, ["createCurator"]);
    if (createCurator) {
      try {
        app.curator = createCurator({ store: app.store, telemetry: app.telemetry, skillsDir: DIRS.skills });
        app.wiring.curator = "ok";
      } catch (err) {
        app.errors.curator = errorMessage(err);
        app.wiring.curator = `failed: ${errorMessage(err)}`;
      }
    }
  } else if (app.curator) {
    app.wiring.curator = "injected";
  }

  app.memory = options.memory || null;
  if (!app.memory && app.store) {
    const memoryMod = await tryImportModule("../memory.js", "memory", app);
    const createMemory = pickFunction(memoryMod, ["createMemory"]);
    if (createMemory) {
      try {
        app.memory = createMemory({ store: app.store });
        app.wiring.memory = "ok";
      } catch (err) {
        app.errors.memory = errorMessage(err);
        app.wiring.memory = `failed: ${errorMessage(err)}`;
      }
    }
  } else if (app.memory) {
    app.wiring.memory = "injected";
  }

  /* rooms */
  app.rooms = options.rooms || null;
  if (!app.rooms) {
    const managerMod = await tryImportModule("../rooms/manager.js", "rooms", app);
    const RoomManager = managerMod?.RoomManager || managerMod?.default?.RoomManager || managerMod?.default;
    if (typeof RoomManager === "function") {
      try {
        app.rooms = new RoomManager({
          store: app.store,
          events: app.events,
          engine: app.engine,
          hooks: app.hooksModule,
          skills: app.skills,
          archetypes: app.archetypesModule,
          bots: app.defaultBots,
          approval: app.approval,
          memory: app.memory,
          telemetry: app.telemetry,
          curator: app.curator,
        });
        app.wiring.rooms = "ok";
        if (typeof app.rooms.restore === "function") await app.rooms.restore();
      } catch (err) {
        app.rooms = null;
        app.errors.rooms = errorMessage(err);
        app.wiring.rooms = `failed: ${errorMessage(err)}`;
        log.error("room manager init failed:", errorMessage(err));
      }
    }
  } else {
    app.wiring.rooms = "injected";
  }

  /* chief runner (single-agent session) */
  {
    const chiefMod = options.chief || (await tryImportModule("../engine/chief.js", "chief", app));
    app.chiefModule = chiefMod;
    app.runChief = pickFunction(chiefMod, ["runChief"]) || null;
    app.chiefTools = Array.isArray(chiefMod?.CHIEF_TOOLS) ? chiefMod.CHIEF_TOOLS : [];
    app.disposeChief = pickFunction(chiefMod, ["disposeChief"]);
  }

  /* seed the default roster when the database has no bots yet */
  await seedDefaultBots(app);

  return app;
}

async function seedDefaultBots(app) {
  if (!app.store || !app.defaultBots?.length) return;
  let current = [];
  try {
    current = app.store.listBots?.() || [];
  } catch (err) {
    log.warn("listBots failed:", errorMessage(err));
    return;
  }
  if (current.length) return;
  for (const bot of app.defaultBots) {
    if (!bot?.id) continue;
    try {
      app.store.upsertBot({ ...bot, state: bot.state || "idle" });
    } catch (err) {
      log.warn("seed bot failed:", bot.id, errorMessage(err));
    }
  }
  log.info(`seeded ${app.defaultBots.length} default bots`);
}

async function disposeApp(app) {
  try {
    app.rooms?.disposeAll?.();
    app.rooms?.dispose?.();
  } catch (err) {
    log.debug("rooms.dispose failed:", errorMessage(err));
  }
  try {
    app.disposeChief?.();
  } catch (err) {
    log.debug("disposeChief failed:", errorMessage(err));
  }
  try {
    await app.engine?.dispose?.();
  } catch (err) {
    log.debug("engine.dispose failed:", errorMessage(err));
  }
  if (app.ownsStore) {
    try {
      app.store?.close?.();
    } catch (err) {
      log.debug("store.close failed:", errorMessage(err));
    }
  }
}

/* ------------------------------------------------------------------ models */

function currentModel(app) {
  const engine = app.engine;
  if (engine?.defaultModelId) return String(engine.defaultModelId);
  const fromEngine = engine?.defaultModel;
  if (typeof fromEngine === "string" && fromEngine.trim()) return fromEngine.trim();
  if (fromEngine && typeof fromEngine === "object" && fromEngine.id) return String(fromEngine.id);
  const stored = readStoredSettings(app);
  if (stored?.model) return String(stored.model);
  return DEFAULT_MODEL;
}

function modelCatalog(app) {
  const models = app.engine?.models;
  if (Array.isArray(models) && models.length) {
    const gatewayOk = Boolean(app.engine?.gatewayStatus?.ok);
    return { models, isFallback: !gatewayOk };
  }
  const modelsJson = readJsonQuiet(path.join(DIRS.sharedAgent, "models.json"));
  const providers = modelsJson?.providers;
  if (providers && typeof providers === "object") {
    const out = [];
    for (const [providerId, provider] of Object.entries(providers)) {
      const list = Array.isArray(provider?.models) ? provider.models : [];
      for (const model of list) {
        out.push({
          id: String(model?.id || ""),
          display_name: String(model?.name || model?.id || ""),
          owned_by: providerId,
          context_length: toInt(model?.contextWindow ?? model?.context_length, 0) || null,
          max_output_tokens: toInt(model?.maxTokens ?? model?.max_output_tokens, 0) || null,
          tool_call: true,
          reasoning: Boolean(model?.reasoning),
        });
      }
    }
    if (out.length) return { models: out, isFallback: true };
  }
  return {
    models: [
      {
        id: DEFAULT_MODEL,
        display_name: "DeepSeek V4.1 Flash",
        owned_by: "magpie",
        context_length: 1000000,
        max_output_tokens: 128000,
        tool_call: true,
        reasoning: true,
      },
      {
        id: "auto/hy3",
        display_name: "Hy3",
        owned_by: "magpie",
        context_length: 192000,
        max_output_tokens: 64000,
        tool_call: true,
        reasoning: true,
      },
    ],
    isFallback: true,
  };
}

function modelCapacity(app, modelId) {
  const { models } = modelCatalog(app);
  const hit = models.find((m) => m.id === modelId) || models[0];
  return {
    context: toInt(hit?.context_length ?? hit?.contextWindow, 0) || 1_000_000,
    output: toInt(hit?.max_output_tokens ?? hit?.maxTokens, 0) || null,
  };
}

/* ------------------------------------------------------------------- bots */

function chiefConfig(app) {
  const stored = readKV(app, "chief_config", {}) || {};
  const base = {
    id: CHIEF_ID,
    name: "Chief Router",
    role: "router",
    archetype: "router",
    label: "Chief",
    badge: "🧭",
    tagline: "总调度 · 任务拓扑分解",
    state: "idle",
    model: currentModel(app),
    temperature: 0,
    system_prompt: "You are the Chief Router orchestrating autonomous subagents.",
    allowed_tools: app.chiefTools?.length
      ? [...app.chiefTools]
      : ["read", "write", "edit", "bash", "grep", "find", "ls"],
    read_only: true,
    max_subtasks: 8,
    max_parallel: 2,
  };
  const merged = { ...base, ...(stored && typeof stored === "object" ? stored : {}) };
  merged.id = CHIEF_ID;
  merged.role = "router";
  merged.archetype = "router";
  merged.model = merged.model || currentModel(app);
  merged.tools = merged.allowed_tools;
  return merged;
}

/** Normalise a stored bot record into the polymorphic contract shape. */
function botConfigView(app, bot) {
  const record = bot && typeof bot === "object" ? bot : {};
  const id = String(record.id || record.bot_id || "");
  const readOnly = Boolean(record.read_only ?? record.readOnly ?? false);
  const tools = Array.isArray(record.allowed_tools)
    ? record.allowed_tools
    : Array.isArray(record.tools)
      ? record.tools
      : [];
  const name = String(record.name || id);
  return {
    ...record,
    id,
    name,
    role: String(record.role || "worker"),
    archetype: String(record.archetype || id),
    label: String(record.label || name || id),
    badge: String(record.badge || record.emoji || "🤖"),
    tagline: String(record.tagline || ""),
    state: String(record.state || "idle"),
    model: String(record.model || currentModel(app)),
    temperature: toFloat(record.temperature, 0),
    system_prompt: String(record.system_prompt || record.systemPrompt || ""),
    allowed_tools: tools,
    tools,
    read_only: readOnly,
    // Hermes 式工具面（src/toolsets.js）：null 表示该 bot 仍走 allowed_tools 白名单。
    toolsets: Array.isArray(record.toolsets) ? record.toolsets : null,
    toolset_role: record.toolset_role ? String(record.toolset_role) : null,
    disabled_toolsets: Array.isArray(record.disabled_toolsets) ? record.disabled_toolsets : [],
    max_iterations: toInt(record.max_iterations, readOnly ? 15 : 30),
    timeout_seconds: toFloat(record.timeout_seconds, 120),
  };
}

function storedBotRows(app) {
  try {
    const rows = app.store?.listBots?.() || [];
    return Array.isArray(rows) ? rows.filter(Boolean) : [];
  } catch (err) {
    log.warn("listBots failed:", errorMessage(err));
    return [];
  }
}

function botRoster(app) {
  const bots = [chiefConfig(app)];
  const rows = storedBotRows(app);
  const source = rows.length ? rows : app.defaultBots || [];
  const seen = new Set([CHIEF_ID.toLowerCase()]);
  for (const row of source) {
    const view = botConfigView(app, row);
    if (!view.id || seen.has(view.id.toLowerCase())) continue;
    if (CHIEF_ALIASES.has(view.id.toLowerCase())) continue;
    seen.add(view.id.toLowerCase());
    bots.push(view);
  }
  return bots;
}

function knownWorkerIds(app) {
  const ids = new Set();
  for (const row of storedBotRows(app)) ids.add(String(row.id || "").toLowerCase());
  for (const row of app.defaultBots || []) ids.add(String(row.id || "").toLowerCase());
  return ids;
}

/** Strict roster lookup — FUSION_SPEC's archetypeOf() falls back to `general`,
 *  so it must not be used to decide whether a member id exists. */
function isKnownWorker(app, botId) {
  const key = String(botId || "").trim().toLowerCase();
  if (!key) return false;
  if (CHIEF_ALIASES.has(key)) return true;
  return knownWorkerIds(app).has(key);
}

function findBot(app, botId) {
  const raw = String(botId || "").trim();
  if (!raw) return null;
  if (CHIEF_ALIASES.has(raw.toLowerCase())) return chiefConfig(app);
  const exact = storedBotRows(app).find((row) => String(row.id) === raw);
  if (exact) return botConfigView(app, exact);
  const lower = raw.toLowerCase();
  const ci = storedBotRows(app).find((row) => String(row.id).toLowerCase() === lower);
  if (ci) return botConfigView(app, ci);
  const fromDefaults = (app.defaultBots || []).find((row) => String(row.id).toLowerCase() === lower);
  if (fromDefaults) return botConfigView(app, fromDefaults);
  // documented alias: general → general-purpose
  if (lower === "general") {
    const general = (app.defaultBots || []).find((row) => String(row.id).toLowerCase() === "general-purpose");
    if (general) return botConfigView(app, general);
  }
  return null;
}

function updateChiefConfig(app, patch) {
  const current = chiefConfig(app);
  const next = { ...current };
  if (typeof patch.name === "string") next.name = patch.name.trim() || next.name;
  if (typeof patch.badge === "string") next.badge = patch.badge.trim().slice(0, 8) || next.badge;
  if (typeof patch.tagline === "string") next.tagline = patch.tagline.trim().slice(0, 80);
  if (typeof patch.model === "string" && patch.model.trim()) next.model = patch.model.trim();
  if (patch.temperature !== undefined) next.temperature = clamp(toFloat(patch.temperature, 0), 0, 2);
  if (typeof patch.system_prompt === "string") next.system_prompt = patch.system_prompt.trim();
  if (patch.max_subtasks !== undefined) next.max_subtasks = Math.max(1, toInt(patch.max_subtasks, next.max_subtasks));
  if (patch.max_parallel !== undefined) next.max_parallel = Math.max(1, toInt(patch.max_parallel, next.max_parallel));
  if (Array.isArray(patch.allowed_tools)) next.allowed_tools = patch.allowed_tools.map(String);
  next.tools = next.allowed_tools;
  next.id = CHIEF_ID;
  next.role = "router";
  next.archetype = "router";
  writeKV(app, "chief_config", next);
  return next;
}

function updateStoredBot(app, botId, patch) {
  const row = storedBotRows(app).find((b) => String(b.id) === String(botId));
  if (!row) return null;
  const next = { ...row, id: String(botId) };
  if (typeof patch.name === "string") next.name = patch.name.trim() || next.name;
  if (typeof patch.badge === "string") next.badge = patch.badge.trim().slice(0, 8);
  if (typeof patch.tagline === "string") next.tagline = patch.tagline.trim().slice(0, 80);
  if (typeof patch.model === "string" && patch.model.trim()) next.model = patch.model.trim();
  if (patch.temperature !== undefined) next.temperature = clamp(toFloat(patch.temperature, 0), 0, 2);
  if (typeof patch.system_prompt === "string") next.system_prompt = patch.system_prompt.trim();
  if (patch.max_iterations !== undefined) next.max_iterations = Math.max(1, toInt(patch.max_iterations, 30));
  if (patch.timeout_seconds !== undefined) next.timeout_seconds = Math.max(1, toFloat(patch.timeout_seconds, 120));
  if (Array.isArray(patch.allowed_tools)) {
    const existing = Array.isArray(row.allowed_tools) ? row.allowed_tools : row.tools || [];
    // narrowing only, mirroring the Python mandate semantics
    const narrowed = patch.allowed_tools.map(String).filter((tool) => existing.includes(tool));
    next.allowed_tools = narrowed;
    next.tools = narrowed;
    // 显式改白名单意味着「回到手写工具列表」：清掉工具面字段，否则 bot.js 会忽略上面这份列表。
    next.toolsets = null;
    next.toolset_role = null;
  }
  if (Array.isArray(patch.toolsets)) next.toolsets = patch.toolsets.map(String).filter(Boolean);
  if (Array.isArray(patch.disabled_toolsets)) next.disabled_toolsets = patch.disabled_toolsets.map(String).filter(Boolean);
  if (typeof patch.toolset_role === "string" && patch.toolset_role.trim()) next.toolset_role = patch.toolset_role.trim();
  if (typeof patch.label === "string" && patch.label.trim()) next.label = patch.label.trim();
  try {
    app.store?.upsertBot?.(next);
  } catch (err) {
    const e = new Error(`failed to persist bot: ${errorMessage(err)}`);
    e.status = 500;
    throw e;
  }
  return botConfigView(app, next);
}

/* ------------------------------------------------------------------- rooms */

function storeRoomRow(app, roomId) {
  try {
    return app.store?.getRoom?.(roomId) || null;
  } catch (err) {
    log.warn("getRoom failed:", roomId, errorMessage(err));
    return null;
  }
}

function storeRoomMembers(app, roomId) {
  try {
    const rows = app.store?.listRoomMembers?.(roomId) || [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function storeRoomFiles(app, roomId) {
  try {
    const rows = app.store?.listRoomFiles?.(roomId) || [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function getRoomObject(app, roomId) {
  const rooms = app.rooms;
  if (rooms && typeof rooms.get === "function") {
    try {
      return rooms.get(roomId) || null;
    } catch {
      return null;
    }
  }
  return null;
}

function roomFallbackSnapshot(app, roomId) {
  const row = storeRoomRow(app, roomId);
  if (!row) return null;
  const members = storeRoomMembers(app, roomId);
  const permissions = {};
  const memberIds = [];
  for (const member of members) {
    const id = member.bot_id || member.botId;
    if (!id) continue;
    memberIds.push(String(id));
    const raw = member.permissions ?? member.permissions_json ?? member.permissionsJson ?? {};
    permissions[String(id)] = typeof raw === "string" ? safeJsonParse(raw, {}) : raw;
  }
  return {
    room_id: row.room_id || roomId,
    title: row.title || "",
    members: memberIds,
    owner_id: row.owner_id ?? null,
    parent_room_id: row.parent_room_id ?? null,
    topic: row.topic || "",
    context_policy: row.context_policy || "shared",
    orchestrator_mode: row.owner_id === "boss" ? "dispatch" : "legacy",
    status: row.status || "active",
    relays: 0,
    message_count: 0,
    file_count: storeRoomFiles(app, roomId).length,
    updated_at: row.updated_at || row.created_at || isoNow(),
    member_permissions: permissions,
  };
}

/** Room → the 14-key contract object (extra keys are tolerated by the UI). */
function roomSnapshot(app, roomId) {
  const room = getRoomObject(app, roomId);
  if (room) {
    let snap = null;
    try {
      if (typeof room.snapshot === "function") snap = room.snapshot();
      else if (typeof room.toDict === "function") snap = room.toDict();
      else if (typeof room.toJSON === "function") snap = room.toJSON();
    } catch (err) {
      log.warn("room.snapshot failed:", roomId, errorMessage(err));
    }
    if (!snap || typeof snap !== "object") {
      const fallback = roomFallbackSnapshot(app, roomId) || {};
      snap = {
        ...fallback,
        room_id: roomId,
        title: room.title ?? fallback.title ?? "",
        members: Array.isArray(room.members) ? [...room.members] : fallback.members || [],
        owner_id: room.owner_id ?? fallback.owner_id ?? null,
        topic: room.topic ?? fallback.topic ?? "",
        context_policy: room.context_policy ?? fallback.context_policy ?? "shared",
        status: room.status ?? fallback.status ?? "active",
        member_permissions: (() => {
          const out = {};
          for (const [id, perm] of Object.entries(room.member_permissions || {})) {
            out[id] = typeof perm?.toDict === "function" ? perm.toDict() : perm;
          }
          return Object.keys(out).length ? out : fallback.member_permissions || {};
        })(),
      };
    }
    const merged = { ...snap, room_id: snap.room_id || roomId };
    if (Array.isArray(merged.members)) merged.members = merged.members.map(String);
    const permissions = merged.member_permissions || {};
    for (const [id, perm] of Object.entries(permissions)) {
      if (perm && typeof perm.toDict === "function") permissions[id] = perm.toDict();
    }
    merged.member_permissions = permissions;
    if (merged.title === undefined) merged.title = "";
    if (merged.topic === undefined) merged.topic = "";
    if (merged.status === undefined) merged.status = "active";
    if (merged.parent_room_id === undefined) merged.parent_room_id = null;
    if (merged.orchestrator_mode === undefined) {
      merged.orchestrator_mode = merged.owner_id === "boss" ? "dispatch" : "legacy";
    }
    if (merged.relays === undefined) merged.relays = 0;
    if (merged.message_count === undefined) merged.message_count = 0;
    if (merged.file_count === undefined) merged.file_count = storeRoomFiles(app, roomId).length;
    if (!merged.updated_at) merged.updated_at = isoNow();
    return merged;
  }
  return roomFallbackSnapshot(app, roomId);
}

function allRooms(app) {
  if (app.rooms) {
    try {
      if (typeof app.rooms.snapshotAll === "function") {
        const list = app.rooms.snapshotAll();
        if (Array.isArray(list)) return list.filter(Boolean).map((room) => ({
          ...room,
          room_id: room.room_id || room.id,
        }));
      }
      if (typeof app.rooms.list === "function") {
        const rooms = app.rooms.list() || [];
        const out = [];
        for (const room of rooms) {
          const id = typeof room === "string" ? room : room?.room_id || room?.id;
          if (!id) continue;
          const snap = roomSnapshot(app, id);
          if (snap) out.push(snap);
        }
        return out;
      }
    } catch (err) {
      log.warn("room listing failed:", errorMessage(err));
    }
  }
  let rows = [];
  try {
    rows = app.store?.listRooms?.() || [];
  } catch (err) {
    log.warn("listRooms failed:", errorMessage(err));
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => roomFallbackSnapshot(app, row.room_id || row.roomId || row.id)).filter(Boolean);
}

function roomExists(app, roomId) {
  if (getRoomObject(app, roomId)) return true;
  return Boolean(storeRoomRow(app, roomId));
}

/* --------------------------------------------------- room messages / files */

function normalizeMessage(row) {
  if (!row || typeof row !== "object") return row;
  return {
    seq: toInt(row.seq, 0),
    speaker: String(row.speaker ?? ""),
    content: String(row.content ?? ""),
    kind: String(row.kind || "message"),
    ts: row.ts ?? null,
  };
}

/**
 * E21. The store exposes `listRoomMessages(roomId, limit)`, so fetch all and
 * apply CONTRACT after_seq/limit slicing in memory (per-room seq is monotonic).
 */
function listRoomMessages(app, roomId, { afterSeq = 0, limit = 500 } = {}) {
  const fn = app.store?.listRoomMessages;
  if (typeof fn !== "function") return [];
  let rows = null;
  try {
    rows = fn.call(app.store, roomId, 0);
  } catch {
    try {
      rows = fn.call(app.store, roomId, { after_seq: afterSeq, limit });
    } catch (err) {
      log.warn("listRoomMessages failed:", roomId, errorMessage(err));
      return [];
    }
  }
  if (!Array.isArray(rows)) rows = Array.isArray(rows?.messages) ? rows.messages : [];
  let mapped = rows.map(normalizeMessage);
  if (afterSeq > 0) mapped = mapped.filter((m) => toInt(m.seq, 0) > afterSeq);
  if (limit >= 0) mapped = mapped.slice(0, limit);
  return mapped;
}

function roomFileEntries(app, roomId) {
  const rows = storeRoomFiles(app, roomId);
  return rows.map((row) => ({
    file_id: String(row.file_id || ""),
    path: String(row.path || ""),
    description: String(row.description || ""),
    tags: Array.isArray(row.tags) ? row.tags : safeJsonParse(row.tags_json, []),
    updated_at: row.updated_at ?? null,
  }));
}

function roomFileRoot(roomId) {
  return path.resolve(DIRS.rooms, String(roomId), "files");
}

/** Resolve a stored relative-posix path inside the room file space (E23). */
function resolveRoomFilePath(roomId, relPath) {
  const root = assertNotC(roomFileRoot(roomId), "room files root");
  const raw = String(relPath ?? "");
  if (!raw) return null;
  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw);
    const insideRoot = abs === root || abs.startsWith(root + path.sep);
    const insideWorkspace = abs.startsWith(path.resolve(DIRS.workspace) + path.sep);
    return insideRoot || insideWorkspace ? abs : null;
  }
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((part) => part === "..")) return null;
  const abs = path.resolve(root, ...parts);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** E23 file preview. Returns {status, body} for the route. */
function filePreview(app, roomId, fileId) {
  const entry = roomFileEntries(app, roomId).find((f) => f.file_id === fileId);
  if (!entry) return { status: 404, body: { error: "file not found" } };
  const abs = resolveRoomFilePath(roomId, entry.path);
  if (!abs) return { status: 404, body: { error: "file is outside the workspace or missing" } };
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { status: 404, body: { error: "file is outside the workspace or missing" } };
  }
  if (!stat.isFile()) return { status: 404, body: { error: "file is outside the workspace or missing" } };
  const ext = path.extname(abs).toLowerCase();
  const isBinary = !TEXT_FILE_EXTS.has(ext);
  let content = "";
  let truncated = false;
  if (!isBinary) {
    try {
      const fd = fs.openSync(abs, "r");
      try {
        const length = Math.min(stat.size, MAX_FILE_PREVIEW_BYTES);
        const buf = Buffer.alloc(length);
        if (length > 0) fs.readSync(fd, buf, 0, length, 0);
        content = buf.toString("utf8");
        truncated = stat.size > MAX_FILE_PREVIEW_BYTES;
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return { status: 500, body: { error: `read failed: ${errorMessage(err)}` } };
    }
  }
  return {
    status: 200,
    body: {
      room_id: roomId,
      file_id: entry.file_id,
      path: entry.path,
      description: entry.description,
      tags: entry.tags,
      updated_at: entry.updated_at,
      size: stat.size,
      binary: isBinary,
      truncated,
      content,
    },
  };
}

/* ------------------------------------------------------------------ settings */

function readKV(app, key, fallback = null) {
  try {
    return app.store?.getKV?.(key, fallback) ?? fallback;
  } catch (err) {
    log.debug(`getKV(${key}) failed:`, errorMessage(err));
    return fallback;
  }
}

function writeKV(app, key, value) {
  try {
    app.store?.setKV?.(key, value);
  } catch (err) {
    const e = new Error(`failed to persist ${key}: ${errorMessage(err)}`);
    e.status = 500;
    throw e;
  }
  return value;
}

function readStoredSettings(app) {
  const raw = readKV(app, "settings", null);
  const parsed = typeof raw === "string" ? safeJsonParse(raw, {}) : raw;
  return parsed && typeof parsed === "object" ? parsed : {};
}

const SETTINGS_NUMERIC = {
  max_parallel: { kind: "int", min: 1, fallback: 2 },
  max_subtasks: { kind: "int", min: 1, fallback: 8 },
  max_iterations: { kind: "int", min: 1, fallback: 30 },
  timeout_seconds: { kind: "float", min: 1, fallback: 120 },
  watchdog_timeout: { kind: "float", min: 1, fallback: 60 },
};

/** E04 — contract keys with AgentFusion defaults. */
function settingsView(app) {
  const stored = readStoredSettings(app);
  const out = {
    model: currentModel(app),
    gateway_url: GATEWAY_URL,
    workspace_root: DIRS.workspace,
    data_root: DATA_ROOT,
    max_parallel: 2,
    max_subtasks: 8,
    max_iterations: 30,
    timeout_seconds: 120,
    watchdog_timeout: 60,
    archetype_model_overrides: {},
    kernel: kernelLabel(),
    kernel_version: kernelVersion(),
    version: APP_VERSION,
    theme: "light",
  };
  for (const [key, value] of Object.entries(stored)) {
    if (value !== undefined) out[key] = value;
  }
  out.model = out.model || currentModel(app);
  out.gateway_url = out.gateway_url || GATEWAY_URL;
  out.workspace_root = DIRS.workspace;
  out.data_root = DATA_ROOT;
  out.kernel = kernelLabel();
  out.version = APP_VERSION;
  return out;
}

/** E05 — accept only documented fields; ints/floats coerced like Python. */
function updateSettings(app, body) {
  const stored = readStoredSettings(app);
  const next = { ...stored };
  const applyNumeric = (key) => {
    if (body[key] === undefined || body[key] === null) return;
    const spec = SETTINGS_NUMERIC[key];
    const raw = body[key];
    const value = spec.kind === "int" ? Number(raw) : Number(raw);
    if (!Number.isFinite(value)) {
      const err = new Error(
        spec.kind === "int" ? `invalid literal for int() with base 10: '${raw}'` : `could not convert string to float: '${raw}'`,
      );
      err.status = 400;
      throw err;
    }
    next[key] = spec.kind === "int" ? Math.max(spec.min, Math.trunc(value)) : Math.max(spec.min, value);
  };
  if (typeof body.model === "string" && body.model.trim()) next.model = body.model.trim();
  if (typeof body.gateway_url === "string" && body.gateway_url.trim()) next.gateway_url = body.gateway_url.trim();
  if (typeof body.theme === "string" && body.theme.trim()) next.theme = body.theme.trim();
  for (const key of Object.keys(SETTINGS_NUMERIC)) applyNumeric(key);
  if (body.archetype_model_overrides && typeof body.archetype_model_overrides === "object") {
    const overrides = {};
    for (const [key, value] of Object.entries(body.archetype_model_overrides)) {
      if (typeof value === "string") overrides[String(key)] = value;
    }
    next.archetype_model_overrides = { ...(stored.archetype_model_overrides || {}), ...overrides };
  }
  writeKV(app, "settings", next);
  return settingsView(app);
}

/* ----------------------------------------------------------------- skills */

function normalizeSkill(app, skill) {
  if (!skill || typeof skill !== "object") {
    return { name: String(skill || ""), description: "", when_to_use: "", source: "builtin" };
  }
  const name = String(skill.name || skill.id || "");
  const rawSource = String(skill.source || "");
  let source;
  if (skill.builtin === true) source = "builtin";
  else if (rawSource === "builtin" || rawSource === "workspace") source = rawSource;
  else {
    // skills.js reports the discovery directory; the seeded samples are the
    // built-in catalogue, everything else the user dropped in is workspace.
    const samples =
      app?.skillsModule?.SAMPLE_SKILLS && typeof app.skillsModule.SAMPLE_SKILLS === "object"
        ? Object.keys(app.skillsModule.SAMPLE_SKILLS)
        : [];
    source = samples.includes(name) ? "builtin" : "workspace";
  }
  return {
    ...skill,
    name,
    description: String(skill.description || ""),
    when_to_use: String(skill.when_to_use || skill.whenToUse || skill.when || ""),
    source,
    source_path: rawSource || null,
  };
}

function skillList(app) {
  const registry = app.skills;
  let raw = null;
  if (registry && typeof registry.list === "function") {
    try {
      raw = registry.list();
    } catch (err) {
      log.warn("skills.list failed:", errorMessage(err));
    }
  } else if (Array.isArray(registry)) {
    raw = registry;
  } else if (app.skillsModule && typeof app.skillsModule.list === "function") {
    try {
      raw = app.skillsModule.list();
    } catch (err) {
      log.debug("skills module list failed:", errorMessage(err));
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((skill) => normalizeSkill(app, skill)).filter((skill) => skill.name);
}

/* ------------------------------------------------------------------ hooks */

function hookRulesPrePost(doc) {
  const pre = [];
  const post = [];
  const push = (rule) => {
    if (!rule || typeof rule !== "object") return;
    const event = String(rule.event || rule.hook || rule.kind || "").toLowerCase();
    const isPost = event.includes("post");
    const mapped = {
      matcher: String(rule.match || rule.matcher || rule.pattern || rule.tool || "*"),
      action: String(rule.action || ""),
      reason: String(rule.reason || ""),
    };
    (isPost ? post : pre).push(mapped);
  };
  if (Array.isArray(doc)) doc.forEach(push);
  else if (Array.isArray(doc?.rules)) doc.rules.forEach(push);
  else if (Array.isArray(doc?.hooks)) doc.hooks.forEach(push);
  if (Array.isArray(doc?.postToolUse)) {
    for (const rule of doc.postToolUse) {
      post.push({
        matcher: String(rule?.match || rule?.matcher || "*"),
        action: String(rule?.action || ""),
        reason: String(rule?.reason || ""),
      });
    }
  }
  return { pre, post };
}

/** E15 — {config_path, exists, last_error, PreToolUse, PostToolUse}. */
function hooksView(app) {
  const mod = app.hooksModule;
  let doc = null;
  if (mod) {
    const documentFn = pickFunction(mod, ["hooksDocument"]);
    if (documentFn) {
      try {
        doc = documentFn();
      } catch (err) {
        log.debug("hooksDocument failed:", errorMessage(err));
      }
    }
    if (!doc) {
      const listFn = pickFunction(mod, ["listHooks"]);
      if (listFn) {
        try {
          doc = listFn();
        } catch (err) {
          log.debug("listHooks failed:", errorMessage(err));
        }
      }
    }
  }
  const configPath = String(doc?.file || doc?.config_path || DIRS.hooksFile);
  const { pre, post } = hookRulesPrePost(doc);
  let exists = false;
  try {
    exists = fs.existsSync(configPath);
  } catch {
    exists = false;
  }
  return {
    config_path: configPath,
    exists,
    last_error: doc?.lastError || doc?.last_error || null,
    PreToolUse: pre,
    PostToolUse: post,
    // extra diagnostics used by the AgentFusion settings page
    enabled: doc?.enabled ?? true,
    count: pre.length + post.length || toInt(doc?.count, 0),
  };
}

/* ---------------------------------------------------------------- avatars */

const AVATAR_KINDS = new Set(["bot", "room", "user"]);
const AVATAR_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const AVATAR_MAX_BYTES = 3 * 1024 * 1024;
const AVATAR_EXTS = ["jpg", "png", "webp", "gif"];

function sniffImage(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: "png", mime: "image/png" };
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return { ext: "gif", mime: "image/gif" };
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}

function avatarExtMime(ext) {
  switch (String(ext || "").toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function avatarDir() {
  const dir = assertNotC(DIRS.avatars, "avatar dir");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** E10 — {"<kind>:<id>": {url, version, mime}}. */
function listAvatars() {
  const dir = avatarDir();
  const out = {};
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase().replace(/^\./, "");
    const stem = entry.name.slice(0, entry.name.length - (ext.length ? ext.length + 1 : 0));
    const sep = stem.indexOf("-");
    if (sep < 0) continue;
    const kind = stem.slice(0, sep);
    const id = stem.slice(sep + 1);
    if (!AVATAR_KINDS.has(kind) || !AVATAR_ID_RE.test(id)) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(dir, entry.name));
    } catch {
      continue;
    }
    const version = Math.floor(stat.mtimeMs);
    out[`${kind}:${id}`] = {
      url: `/api/avatars/${kind}/${id}?v=${version}`,
      version,
      mime: avatarExtMime(ext),
    };
  }
  return out;
}

function findAvatarFile(kind, id) {
  if (!AVATAR_KINDS.has(kind) || !AVATAR_ID_RE.test(id)) return null;
  const dir = avatarDir();
  for (const ext of AVATAR_EXTS) {
    const candidate = path.join(dir, `${kind}-${id}.${ext}`);
    try {
      if (fs.statSync(candidate).isFile()) return { file: candidate, mime: avatarExtMime(ext) };
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function saveAvatar(kind, id, dataB64) {
  const bad = (message) => {
    const err = new Error(message);
    err.status = 400;
    return err;
  };
  if (!AVATAR_KINDS.has(kind)) throw bad("unknown avatar kind");
  if (!AVATAR_ID_RE.test(id)) throw bad("invalid avatar id");
  if (typeof dataB64 !== "string" || !dataB64.trim()) throw bad("image data is required");
  const payload = dataB64.includes(",") ? dataB64.slice(dataB64.indexOf(",") + 1) : dataB64;
  let raw;
  try {
    raw = Buffer.from(payload, "base64");
  } catch {
    throw bad("image data is not valid base64");
  }
  if (!raw || !raw.length) throw bad("image data is not valid base64");
  if (raw.length > AVATAR_MAX_BYTES) throw bad("image is too large (max 3 MiB)");
  const sniffed = sniffImage(raw);
  if (!sniffed) throw bad("unsupported image format (jpeg/png/webp/gif only)");
  const dir = avatarDir();
  for (const ext of [...AVATAR_EXTS, "jpeg"]) {
    try {
      fs.unlinkSync(path.join(dir, `${kind}-${id}.${ext}`));
    } catch {
      /* not present */
    }
  }
  const target = path.join(dir, `${kind}-${id}.${sniffed.ext}`);
  const temp = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, raw);
  fs.renameSync(temp, target);
  const stat = fs.statSync(target);
  const version = Math.floor(stat.mtimeMs);
  return {
    kind,
    id,
    url: `/api/avatars/${kind}/${id}?v=${version}`,
    version,
    mime: sniffed.mime,
    updated_at: isoNow(),
  };
}

function deleteAvatar(kind, id) {
  if (!AVATAR_KINDS.has(kind) || !AVATAR_ID_RE.test(id)) return false;
  const dir = avatarDir();
  let removed = false;
  for (const ext of [...AVATAR_EXTS, "jpeg"]) {
    try {
      fs.unlinkSync(path.join(dir, `${kind}-${id}.${ext}`));
      removed = true;
    } catch {
      /* not present */
    }
  }
  return removed;
}

/* --------------------------------------------------------- events / stats */

function normalizeEvent(row) {
  if (!row || typeof row !== "object") return row;
  let payload = row.payload;
  if (typeof payload === "string") payload = safeJsonParse(payload, {});
  if (payload === null || typeof payload !== "object") payload = { value: payload };
  return {
    seq: toInt(row.seq, 0),
    ts: typeof row.ts === "string" ? toFloat(row.ts, 0) : toFloat(row.ts, 0),
    topic: String(row.topic || ""),
    sender: String(row.sender || "system"),
    payload,
    thread_id: row.thread_id ?? null,
  };
}

function listEvents(app, { threadId, afterSeq = 0, limit = 500 } = {}) {
  const store = app.store;
  if (!store || typeof store.listEvents !== "function") return [];
  const call = (args) => {
    try {
      const value = store.listEvents(args);
      if (Array.isArray(value)) return value;
      if (Array.isArray(value?.events)) return value.events;
      return [];
    } catch {
      return null;
    }
  };
  let rows = call({ thread_id: threadId ?? null, after_seq: afterSeq, limit });
  if (rows === null) {
    try {
      const value = store.listEvents(threadId ?? null, afterSeq, limit);
      rows = Array.isArray(value) ? value : [];
    } catch (err) {
      log.warn("listEvents failed:", errorMessage(err));
      return [];
    }
  }
  return rows.map(normalizeEvent);
}

function usageTotals(app) {
  let summary = null;
  try {
    summary = app.store?.usageSummary?.() ?? null;
  } catch (err) {
    log.debug("usageSummary failed:", errorMessage(err));
  }
  const rows = Array.isArray(summary) ? summary : Array.isArray(summary?.by_bot) ? summary.by_bot : [];
  const pick = (...keys) => {
    for (const key of keys) {
      const value = summary?.[key];
      if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
    }
    return 0;
  };
  let prompt = pick("prompt", "prompt_tokens", "input_tokens", "input");
  let completion = pick("completion", "completion_tokens", "output_tokens", "output");
  if (!prompt && !completion && rows.length) {
    for (const row of rows) {
      prompt += toInt(row.input_tokens ?? row.prompt_tokens, 0);
      completion += toInt(row.output_tokens ?? row.completion_tokens, 0);
    }
  }
  return {
    prompt,
    completion,
    cache_read: pick("cache_read", "cache_read_tokens"),
    cache_write: pick("cache_write", "cache_write_tokens"),
    rows,
  };
}

function estimateDistribution(messages) {
  const distribution = { system: 0, user: 0, assistant: 0, tool: 0 };
  for (const message of messages) {
    const tokens = Math.round(String(message.content || "").length / 3);
    if (message.speaker === "user") distribution.user += tokens;
    else distribution.assistant += tokens;
    if (message.kind === "tool") distribution.tool += tokens;
  }
  return distribution;
}

function contextPayload(app, threadId = null) {
  const model = currentModel(app);
  const capacity = modelCapacity(app, model);
  const usage = usageTotals(app);
  const maxContext = capacity.context || 1_000_000;
  const compactThreshold = Math.round(maxContext * COMPACT_THRESHOLD_RATIO);

  let messages = [];
  if (threadId && String(threadId).startsWith("room:")) {
    messages = listRoomMessages(app, String(threadId).slice(5), { limit: 1000 });
  } else if (!threadId) {
    for (const room of allRooms(app)) {
      if (!room?.room_id) continue;
      messages = messages.concat(listRoomMessages(app, room.room_id, { limit: 300 }));
      if (messages.length > 1500) break;
    }
  }
  const distribution = estimateDistribution(messages);
  const activeTokens = distribution.system + distribution.user + distribution.assistant + distribution.tool;
  const cacheHitRate =
    usage.cache_read + usage.prompt > 0
      ? Number((usage.cache_read / (usage.prompt + usage.cache_read)).toFixed(4))
      : 0;
  const bots = (usage.rows || [])
    .map((row) => ({
      bot_id: String(row.bot_id || row.botId || ""),
      tokens: toInt(row.input_tokens ?? row.prompt_tokens, 0) + toInt(row.output_tokens ?? row.completion_tokens, 0),
      messages_count: toInt(row.calls ?? row.messages_count, 0),
    }))
    .filter((row) => row.bot_id);
  return {
    thread_id: threadId,
    model,
    max_context_tokens: maxContext,
    compact_threshold_tokens: compactThreshold,
    active_tokens: activeTokens,
    usage_percentage: maxContext > 0 ? Number(((activeTokens / maxContext) * 100).toFixed(4)) : 0,
    distribution,
    tokens_total: {
      prompt: usage.prompt,
      completion: usage.completion,
      cache_read: usage.cache_read,
      cache_write: usage.cache_write,
      cache_hit_rate: cacheHitRate,
    },
    cache_hit_rate: cacheHitRate,
    compaction: { count: 0, needed: activeTokens >= compactThreshold },
    bots,
    estimated: true,
    messages: messages.length,
  };
}

function ticketView(ticket) {
  if (!ticket || typeof ticket !== "object") return null;
  const state = ticket.state || ticket.status || "queued";
  const outcome =
    ticket.outcome == null
      ? null
      : typeof ticket.outcome === "string"
        ? ticket.outcome
        : ticket.outcome.summary ?? null;
  return {
    ...ticket,
    id: String(ticket.id || ""),
    state: typeof state === "string" ? state : String(state?.value ?? state),
    title: String(ticket.title || ticket.prompt || ""),
    thread_id: ticket.thread_id ?? null,
    outcome,
    created_at: ticket.created_at ?? ticket.createdAt ?? null,
  };
}

function listTickets(app, limit = 50) {
  const fn = app.store?.listTickets;
  if (typeof fn !== "function") return [];
  let rows = [];
  try {
    rows = fn.call(app.store, limit);
  } catch (err) {
    try {
      rows = fn.call(app.store, { limit });
    } catch {
      log.warn("listTickets failed:", errorMessage(err));
      return [];
    }
  }
  if (!Array.isArray(rows)) rows = Array.isArray(rows?.tickets) ? rows.tickets : [];
  return rows.map(ticketView).filter(Boolean);
}

function statsPayload(app) {
  const usage = usageTotals(app);
  const tickets = listTickets(app, 200);
  const ticketsByState = {};
  for (const ticket of tickets) {
    const state = String(ticket.state || "unknown");
    ticketsByState[state] = (ticketsByState[state] || 0) + 1;
  }
  const rooms = allRooms(app);
  const threadIds = new Set(tickets.map((ticket) => ticket.thread_id).filter(Boolean));
  return {
    tokens: {
      prompt: usage.prompt,
      completion: usage.completion,
      cache_read: usage.cache_read,
      cache_write: usage.cache_write,
    },
    counts: {
      threads: threadIds.size,
      tickets: tickets.length,
      tickets_by_state: ticketsByState,
      rooms: rooms.length,
    },
    context: contextPayload(app, null),
  };
}

/* ------------------------------------------------------------------ static */

function resolveWebPath(relPath) {
  try {
    const cleaned = safeDecode(String(relPath))
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    if (!cleaned || cleaned.includes("\0")) return null;
    const base = path.resolve(WEB_ROOT);
    const full = path.resolve(base, cleaned);
    if (full !== base && !full.startsWith(base + path.sep)) return null;
    return full;
  } catch {
    return null;
  }
}

function statFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function sendFile(res, file, stat) {
  const ext = path.extname(file).toLowerCase();
  applyCors(res);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  const stream = fs.createReadStream(file);
  stream.on("error", (err) => {
    log.warn("static stream failed:", file, errorMessage(err));
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  });
  stream.pipe(res);
}

/** S1/S2/S3 only — CONTRACT_API §1.7 / §12.6: no other path serves a file. */
function serveStatic(req, res, pathname) {
  const method = req.method || "GET";
  if (method !== "GET") return notFound(res, "not found");
  let rel = null;
  if (pathname === "/") rel = "index.html";
  else if (pathname === "/favicon.ico") {
    rel = statFile(path.join(WEB_ROOT, "favicon.svg")) ? "favicon.svg" : "favicon.ico";
  } else if (pathname.startsWith("/static/")) rel = pathname.slice("/static/".length);
  if (!rel) return notFound(res, "not found");
  const file = resolveWebPath(rel);
  const stat = file ? statFile(file) : null;
  if (!file || !stat) return notFound(res, "not found");
  return sendFile(res, file, stat);
}

/* --------------------------------------------------------------------- SSE */

function handleSse(app, req, res, url) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  try {
    res.socket?.setNoDelay?.(true);
    res.socket?.setKeepAlive?.(true);
  } catch {
    /* best effort */
  }

  const requested = qInt(url, "after_seq", 0);
  let lastSeq = Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : 0;

  const client = {
    res,
    end() {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    },
  };
  app.sse.add(client);

  // Optional backfill (extra capability; the UI never asks for it). Frames stay
  // 3-key per CONTRACT_API §9.1.
  if (lastSeq > 0) {
    for (const event of listEvents(app, { afterSeq: lastSeq, limit: 2000 })) {
      if (event.seq <= lastSeq) continue;
      lastSeq = event.seq;
      try {
        res.write(`data: ${JSON.stringify({ topic: event.topic, sender: event.sender, payload: event.payload })}\n\n`);
      } catch {
        /* client vanished */
      }
    }
  }

  let closed = false;
  let heartbeat = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    app.sse.delete(client);
    try {
      res.end();
    } catch {
      /* ignore */
    }
  };
  const unsubscribe = app.events.subscribe((event) => {
    if (closed) return;
    if (typeof event.seq === "number" && event.seq <= lastSeq) return;
    if (typeof event.seq === "number") lastSeq = event.seq;
    try {
      res.write(`data: ${JSON.stringify({ topic: event.topic, sender: event.sender, payload: event.payload })}\n\n`);
    } catch {
      cleanup();
    }
  });
  heartbeat = setInterval(() => {
    if (closed) return;
    try {
      res.write(": keepalive\n\n");
    } catch {
      cleanup();
    }
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

/* ------------------------------------------------------------- room actions */

function normalizeMemberPermissions(app, room, patch) {
  const next = {};
  for (const key of ["can_speak", "context_access", "can_create_subgroup", "allowed_tool_overrides"]) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (next.context_access !== undefined && !["full", "summary", "none"].includes(next.context_access)) {
    delete next.context_access;
  }
  return next;
}

function persistRoomRow(app, roomId, patch) {
  const row = storeRoomRow(app, roomId);
  if (!row) return;
  try {
    app.store.upsertRoom({ ...row, ...patch, room_id: roomId });
  } catch (err) {
    log.warn("persist room failed:", roomId, errorMessage(err));
  }
}

async function createRoom(app, body) {
  const membersRaw = body.members;
  const members = Array.isArray(membersRaw) ? membersRaw.map((m) => String(m).trim()).filter(Boolean) : [];
  if (!Array.isArray(membersRaw) || members.length < 2) {
    return { status: 400, body: { error: "members must be a list with at least 2 bot ids" } };
  }
  if (!app.rooms || typeof app.rooms.create !== "function") {
    return { status: 503, body: { error: "room manager unavailable" } };
  }
  const includeRoles = Boolean(body.include_roles ?? body.include_librarian);
  const title = typeof body.title === "string" ? body.title : "";
  const topic = typeof body.topic === "string" ? body.topic : "";
  const contextPolicy = typeof body.context_policy === "string" && body.context_policy ? body.context_policy : "shared";
  const ownerId = body.owner_id ? String(body.owner_id) : null;

  // CONTRACT §E18: unknown member ids → 400 (the room manager itself may be lax).
  const unknown = [...new Set(members.filter((id) => !isKnownWorker(app, id)))];
  if (unknown.length) {
    return { status: 400, body: { error: `Unknown worker(s) for room: [${unknown.map((id) => `'${id}'`).join(", ")}]` } };
  }
  // CONTRACT §E18: the owner must be one of the final members.
  const effectiveMembers = new Set(members);
  if (includeRoles) {
    effectiveMembers.add("boss");
    effectiveMembers.add("librarian");
  }
  const effectiveOwner = ownerId || (includeRoles ? "boss" : null);
  if (effectiveOwner && !effectiveMembers.has(effectiveOwner)) {
    return { status: 400, body: { error: `Owner '${effectiveOwner}' must be one of the room members.` } };
  }

  let created;
  try {
    created = await app.rooms.create({
      title,
      owner_id: ownerId,
      members,
      context_policy: contextPolicy,
      topic,
      include_librarian: includeRoles,
      include_roles: includeRoles,
    });
  } catch (err) {
    return { status: statusForError(err, 400), body: { error: errorMessage(err) } };
  }
  const roomId =
    typeof created === "string" ? created : created?.room_id || created?.roomId || created?.id || created?.room?.room_id;
  if (!roomId) return { status: 500, body: { error: "room manager did not return a room id" } };

  const snapshot = roomSnapshot(app, roomId);
  const resultingMembers = Array.isArray(snapshot?.members) && snapshot.members.length ? snapshot.members : members;
  const out = { room_id: roomId, members: resultingMembers };
  if (includeRoles || title || ownerId || contextPolicy !== "shared") {
    out.owner_id = snapshot?.owner_id ?? (ownerId || (includeRoles ? "boss" : null));
    out.title = title;
    out.context_policy = contextPolicy;
  }
  return { status: 201, body: out };
}

async function roomSay(app, roomId, content) {
  // CONTRACT §E24: content is validated *before* the room lookup.
  if (typeof content !== "string" || !content.trim()) {
    return { status: 400, body: { error: "content is required" } };
  }
  const room = getRoomObject(app, roomId);
  if (!room) {
    if (!storeRoomRow(app, roomId)) return { status: 404, body: { error: `Unknown room '${roomId}'.` } };
    return { status: 503, body: { error: "room runtime unavailable" } };
  }
  if (typeof room.say !== "function") return { status: 503, body: { error: "room runtime unavailable" } };
  // Fire-and-forget: the round runs in the background and is observable via SSE.
  Promise.resolve()
    .then(() => room.say({ speaker: "user", content }))
    .catch((err) => log.error("room.say failed:", roomId, errorMessage(err)));
  return { status: 200, body: { status: "accepted", room_id: roomId } };
}

async function updateRoom(app, roomId, body) {
  const room = getRoomObject(app, roomId);
  const row = storeRoomRow(app, roomId);
  if (!room && !row) return { status: 404, body: { error: "room not found" } };

  const applied = {};
  const before = roomSnapshot(app, roomId) || {};

  // 1) title
  if (typeof body.title === "string") {
    const title = body.title.trim().slice(0, 80);
    if (room) {
      try {
        if (typeof room.setTitle === "function") await room.setTitle(title);
        else room.title = title;
      } catch (err) {
        return { status: statusForError(err, 400), body: { error: errorMessage(err) } };
      }
    }
    persistRoomRow(app, roomId, { title });
    applied.title = title;
  }

  // 2) topic
  if (typeof body.topic === "string") {
    const topic = body.topic.trim().slice(0, 200);
    if (room) {
      try {
        if (typeof room.setTopic === "function") await room.setTopic(topic);
        else room.topic = topic;
      } catch (err) {
        return { status: statusForError(err, 400), body: { error: errorMessage(err) } };
      }
    }
    persistRoomRow(app, roomId, { topic });
    applied.topic = topic;
  }

  // 3) member_permissions (existing members only)
  if (body.member_permissions && typeof body.member_permissions === "object" && !Array.isArray(body.member_permissions)) {
    const memberIds = new Set(
      (Array.isArray(before.members) ? before.members : storeRoomMembers(app, roomId).map((m) => m.bot_id)).map(String),
    );
    for (const [memberId, fields] of Object.entries(body.member_permissions)) {
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) continue;
      if (!memberIds.has(String(memberId))) continue;
      const patch = normalizeMemberPermissions(app, room, fields);
      if (!Object.keys(patch).length) continue;
      if (room && typeof room.grantPermission === "function") {
        try {
          await room.grantPermission(String(memberId), patch);
        } catch (err) {
          return { status: statusForError(err, 400), body: { error: errorMessage(err) } };
        }
      }
      try {
        app.store?.setMemberPermissions?.(roomId, String(memberId), patch);
      } catch (err) {
        log.warn("member permission persist failed:", roomId, memberId, errorMessage(err));
      }
      try {
        await app.events?.publish?.({
          topic: `room.${roomId}.permission_changed`,
          sender: "server",
          payload: { member: String(memberId), permissions: { ...(before.member_permissions?.[memberId] || {}), ...patch } },
          thread_id: `room:${roomId}`,
        });
      } catch (err) {
        log.debug("permission_changed publish failed:", errorMessage(err));
      }
    }
    applied.member_permissions = true;
  }

  // 4) add_members
  if (Array.isArray(body.add_members) && body.add_members.length) {
    const existing = new Set(
      (Array.isArray(before.members) ? before.members : storeRoomMembers(app, roomId).map((m) => m.bot_id)).map(String),
    );
    const added = [];
    for (const rawId of body.add_members) {
      const id = String(rawId ?? "").trim();
      if (!id || existing.has(id) || added.includes(id)) continue;
      if (!isKnownWorker(app, id)) return { status: 400, body: { error: `Unknown worker '${id}'` } };
      if (room) {
        const add =
          (typeof room.addMember === "function" && room.addMember.bind(room)) ||
          (typeof room.registerMember === "function" && room.registerMember.bind(room)) ||
          null;
        if (add) {
          try {
            await add(id);
          } catch (err) {
            return { status: statusForError(err, 400), body: { error: errorMessage(err) } };
          }
        } else if (Array.isArray(room.members) && !room.members.includes(id)) {
          room.members.push(id);
        }
      }
      existing.add(id);
      added.push(id);
    }
    if (added.length) {
      try {
        const rows = storeRoomMembers(app, roomId).map((m) => ({
          bot_id: m.bot_id,
          permissions: m.permissions || {},
        }));
        for (const id of added) rows.push({ bot_id: id, permissions: {} });
        app.store?.setRoomMembers?.(roomId, rows);
      } catch (err) {
        log.warn("add_members persist failed:", roomId, errorMessage(err));
      }
      applied.add_members = added;
    }
  }

  // 5) context_policy
  if (body.context_policy !== undefined) {
    const policy = String(body.context_policy);
    if (!["shared", "summary", "isolated"].includes(policy)) {
      return {
        status: 400,
        body: { error: `Invalid context policy '${policy}'. Valid: ('shared', 'summary', 'isolated')` },
      };
    }
    if (room) {
      try {
        if (typeof room.setContextPolicy === "function") await room.setContextPolicy(policy);
        else room.context_policy = policy;
      } catch (err) {
        return { status: statusForError(err, 400), body: { error: errorMessage(err) } };
      }
    }
    persistRoomRow(app, roomId, { context_policy: policy });
    applied.context_policy = policy;
  }

  // 6) settings（房间级工具面裁剪等；也接受顶层 disabled_toolsets 简写）
  const settingsPatch = {};
  if (body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)) {
    Object.assign(settingsPatch, body.settings);
  }
  if (body.disabled_toolsets !== undefined) settingsPatch.disabled_toolsets = body.disabled_toolsets;
  if (Object.keys(settingsPatch).length) {
    if (settingsPatch.subgroup_lifecycle !== undefined && !["dispose", "keep"].includes(String(settingsPatch.subgroup_lifecycle))) {
      return { status: 400, body: { error: "Invalid subgroup_lifecycle. Valid: ('dispose', 'keep')" } };
    }
    if (settingsPatch.auto_propose_skills !== undefined && !["off", "observed", "always"].includes(String(settingsPatch.auto_propose_skills))) {
      return { status: 400, body: { error: "Invalid auto_propose_skills. Valid: ('off', 'observed', 'always')" } };
    }
    if (room && typeof room.setSettings === "function") {
      try {
        applied.settings = await room.setSettings(settingsPatch);
      } catch (err) {
        return { status: statusForError(err, 400), body: { error: errorMessage(err) } };
      }
    } else {
      const current = row?.settings && typeof row.settings === "object" ? row.settings : {};
      const next = { ...current, ...settingsPatch };
      persistRoomRow(app, roomId, { settings: next });
      applied.settings = next;
    }
  }

  if (applied.title || applied.topic || applied.context_policy) {
    persistRoomRow(app, roomId, {
      ...(applied.title !== undefined ? { title: applied.title } : {}),
      ...(applied.topic !== undefined ? { topic: applied.topic } : {}),
      ...(applied.context_policy !== undefined ? { context_policy: applied.context_policy } : {}),
    });
  }

  let snapshot = roomSnapshot(app, roomId) || { ...before, room_id: roomId };
  if (applied.title !== undefined) snapshot.title = applied.title;
  if (applied.topic !== undefined) snapshot.topic = applied.topic;
  if (applied.context_policy !== undefined) snapshot.context_policy = applied.context_policy;
  try {
    await app.events?.publish?.({
      topic: `room.${roomId}.updated`,
      sender: "server",
      payload: snapshot,
      thread_id: `room:${roomId}`,
    });
  } catch (err) {
    log.debug("room.updated publish failed:", errorMessage(err));
  }
  return { status: 200, body: snapshot };
}

/* ------------------------------------------------------------------- chief */

async function markTicketFailure(app, ticket, message) {
  try {
    app.store?.updateTicket?.(ticket.id, { ...ticket, state: "failed", error: message, updated_at: isoNow() });
  } catch (err) {
    log.warn("updateTicket failed:", ticket.id, errorMessage(err));
  }
  try {
    await app.events?.publish?.({
      topic: "harness.task.failed",
      sender: "server",
      payload: { ticket_id: ticket.id, thread_id: ticket.thread_id, error: message },
      thread_id: ticket.thread_id,
    });
  } catch {
    /* ignore */
  }
}

async function runChiefForTicket(app, ticket, prompt) {
  if (typeof app.runChief !== "function") {
    await markTicketFailure(app, ticket, "chief runtime unavailable");
    return;
  }
  try {
    app.store?.updateTicket?.(ticket.id, { ...ticket, state: "working", updated_at: isoNow() });
    const result = await app.runChief({
      prompt,
      engine: app.engine,
      events: app.events,
      store: app.store,
      thread_id: ticket.thread_id,
      ticket_id: ticket.id,
      publishTaskEvents: false,
    });
    const text = typeof result === "string" ? result : result?.text || result?.summary || "";
    const threadId = (typeof result === "object" && result?.thread_id) || ticket.thread_id;
    app.store?.updateTicket?.(ticket.id, {
      ...ticket,
      state: "ready",
      outcome: text,
      thread_id: threadId,
      updated_at: isoNow(),
    });
    try {
      await app.events?.publish?.({
        topic: "harness.task.completed",
        sender: "server",
        payload: { ticket_id: ticket.id, thread_id: threadId, outcome: text },
        thread_id: threadId,
      });
    } catch (err) {
      log.debug("task.completed publish failed:", errorMessage(err));
    }
  } catch (err) {
    const message = errorMessage(err);
    log.error("runChief failed:", message);
    await markTicketFailure(app, ticket, message);
  }
}

function submitTask(app, prompt) {
  const ticketId = `tk_${crypto.randomBytes(6).toString("hex")}`;
  const threadId = `chief:${crypto.randomBytes(6).toString("hex")}`;
  const now = isoNow();
  const ticket = {
    id: ticketId,
    state: "queued",
    title: prompt.slice(0, 60),
    prompt,
    thread_id: threadId,
    created_at: now,
    updated_at: now,
  };
  try {
    app.store?.createTicket?.(ticket);
  } catch (err) {
    log.warn("createTicket failed:", errorMessage(err));
  }
  Promise.resolve()
    .then(() =>
      app.events?.publish?.({
        topic: "harness.task.submitted",
        sender: "runtime",
        payload: { ticket_id: ticketId, thread_id: threadId, prompt },
        thread_id: threadId,
      }),
    )
    .catch((err) => log.debug("task.submitted publish failed:", errorMessage(err)));
  setImmediate(() => {
    runChiefForTicket(app, ticket, prompt).catch((err) => log.error("chief task crashed:", errorMessage(err)));
  });
  return { ticket_id: ticketId, thread_id: threadId };
}

/* --------------------------------------------------------------- dispatcher */

const ROUTES = {
  bot: /^\/api\/bots\/([^/]+)$/,
  avatar: /^\/api\/avatars\/([^/]+)\/([^/]+)$/,
  roomMessages: /^\/api\/rooms\/([^/]+)\/messages$/,
  roomFiles: /^\/api\/rooms\/([^/]+)\/files$/,
  roomEvidence: /^\/api\/rooms\/([^/]+)\/evidence$/,
  roomLearn: /^\/api\/rooms\/([^/]+)\/learn$/,
  roomFile: /^\/api\/rooms\/([^/]+)\/files\/([^/]+)$/,
  roomSay: /^\/api\/rooms\/([^/]+)\/say$/,
  room: /^\/api\/rooms\/([^/]+)$/,
  threadEvents: /^\/api\/thread\/([^/]+)\/events$/,
  // Hermes 吸收层（docs/hermes/）：审批单 / 技能提案 / 记忆条目
  approvalResolve: /^\/api\/approvals\/([^/]+)$/,
  skillProposalReview: /^\/api\/skills\/proposals\/([^/]+)\/review$/,
  skillProposalAdopt: /^\/api\/skills\/proposals\/([^/]+)\/adopt$/,
  memoryEntry: /^\/api\/memory\/([^/]+)$/,
};

function badPathId(decoded) {
  return !decoded || decoded.includes("/");
}

async function handleApi(app, req, res, url) {
  const method = req.method || "GET";
  const pathname = url.pathname;

  /* E01 health */
  if (method === "GET" && pathname === "/api/health") {
    const catalog = modelCatalog(app);
    const gatewayStatus = app.engine?.gatewayStatus || {};
    const rooms = allRooms(app);
    return sendJson(res, 200, {
      status: "ok",
      model: currentModel(app),
      workspace_root: DIRS.workspace,
      gateway_url: GATEWAY_URL,
      service: "AgentFusion",
      version: APP_VERSION,
      kernel: kernelLabel(),
      kernel_version: kernelVersion(),
      default_model: app.engine?.defaultModelId || currentModel(app),
      data_root: DATA_ROOT,
      gateway: {
        ok: Boolean(gatewayStatus.ok),
        url: gatewayStatus.url || GATEWAY_URL,
        models: catalog.models.length,
        error: gatewayStatus.error || null,
      },
      rooms: rooms.length,
      bots: botRoster(app).length,
      sse_clients: app.sse.size,
      requests: app.stats.requests,
      uptime_ms: Date.now() - app.startedAt,
      wiring: app.wiring,
      errors: isEmptyObject(app.errors) ? undefined : app.errors,
    });
  }

  /* E02 stats */
  if (method === "GET" && pathname === "/api/stats") {
    return sendJson(res, 200, statsPayload(app));
  }

  /* E03 context */
  if (method === "GET" && pathname === "/api/context") {
    const threadId = url.searchParams.get("thread_id") || null;
    return sendJson(res, 200, contextPayload(app, threadId));
  }

  /* E04 / E05 settings */
  if (pathname === "/api/settings" && method === "GET") {
    return sendJson(res, 200, settingsView(app));
  }
  if (pathname === "/api/settings" && method === "PUT") {
    const body = await readJson(req);
    let updated;
    try {
      updated = updateSettings(app, body);
    } catch (err) {
      return sendJson(res, statusForError(err, 500), { error: errorMessage(err) });
    }
    try {
      await app.events?.publish?.({ topic: "harness.settings.updated", sender: "server", payload: updated });
    } catch (err) {
      log.debug("settings.updated publish failed:", errorMessage(err));
    }
    return sendJson(res, 200, updated);
  }

  /* E06 models */
  if (method === "GET" && pathname === "/api/models") {
    const catalog = modelCatalog(app);
    return sendJson(res, 200, {
      object: "list",
      data: catalog.models,
      current_model: currentModel(app),
      gateway_url: app.engine?.gatewayStatus?.url || GATEWAY_URL,
      is_fallback: catalog.isFallback,
    });
  }

  /* E07 bots */
  if (method === "GET" && pathname === "/api/bots") {
    return sendJson(res, 200, { bots: botRoster(app) });
  }

  /* E08 / E09 one bot */
  const botMatch = pathname.match(ROUTES.bot);
  if (botMatch) {
    const botId = safeDecode(botMatch[1]);
    if (badPathId(botId)) return notFound(res, "not found");
    if (method === "GET") {
      const bot = findBot(app, botId);
      if (!bot) return notFound(res, `Bot '${botId}' not found`);
      return sendJson(res, 200, bot);
    }
    if (method === "PUT") {
      const body = await readJson(req);
      const isChief = CHIEF_ALIASES.has(botId.toLowerCase());
      try {
        let updated = null;
        if (isChief) updated = updateChiefConfig(app, body);
        else {
          const existing = findBot(app, botId);
          if (!existing) return notFound(res, `Bot '${botId}' not found`);
          updated = updateStoredBot(app, botId, body);
          if (!updated) {
            // archetype-only bot: only `model` has an effect
            updated = { ...existing };
            if (typeof body.model === "string" && body.model.trim()) updated.model = body.model.trim();
            const overrides = { ...(readStoredSettings(app).archetype_model_overrides || {}) };
            overrides[updated.archetype || botId] = updated.model;
            writeKV(app, "settings", { ...readStoredSettings(app), archetype_model_overrides: overrides });
          }
        }
        try {
          await app.events?.publish?.({ topic: `bot.${botId}.updated`, sender: "server", payload: updated });
        } catch (err) {
          log.debug("bot.updated publish failed:", errorMessage(err));
        }
        return sendJson(res, 200, updated);
      } catch (err) {
        return sendJson(res, statusForError(err, 500), { error: errorMessage(err) });
      }
    }
    return sendJson(res, 405, { error: "method not allowed" });
  }

  /* E10 avatars index */
  if (method === "GET" && pathname === "/api/avatars") {
    return sendJson(res, 200, { avatars: listAvatars() });
  }

  /* E11–E13 one avatar */
  const avatarMatch = pathname.match(ROUTES.avatar);
  if (avatarMatch) {
    const kind = safeDecode(avatarMatch[1]);
    const id = safeDecode(avatarMatch[2]);
    if (method === "GET") {
      const hit = findAvatarFile(kind, id);
      if (!hit) return notFound(res, "avatar not found");
      let payload;
      try {
        payload = fs.readFileSync(hit.file);
      } catch {
        return notFound(res, "avatar not found");
      }
      return sendBuffer(res, 200, payload, { contentType: hit.mime, cacheControl: "public, max-age=3600" });
    }
    if (method === "POST") {
      const body = await readJson(req);
      try {
        return sendJson(res, 201, saveAvatar(kind, id, body.data));
      } catch (err) {
        return sendJson(res, statusForError(err, 400), { error: errorMessage(err) });
      }
    }
    if (method === "DELETE") {
      return sendJson(res, 200, { removed: Boolean(deleteAvatar(kind, id)) });
    }
    return sendJson(res, 405, { error: "method not allowed" });
  }
  if (pathname.startsWith("/api/avatars/")) return notFound(res, "avatar not found");

  /* E14 skills */
  if (method === "GET" && pathname === "/api/skills") {
    return sendJson(res, 200, { skills: skillList(app) });
  }

  /* E15 / E16 hooks */
  if (method === "GET" && pathname === "/api/hooks") {
    return sendJson(res, 200, hooksView(app));
  }
  if (method === "POST" && pathname === "/api/hooks/reload") {
    const reload = pickFunction(app.hooksModule, ["reloadHooks"]);
    if (!reload) return sendJson(res, 404, { error: "hook engine not available" });
    try {
      await reload();
    } catch (err) {
      return sendJson(res, 500, { error: errorMessage(err) });
    }
    return sendJson(res, 200, hooksView(app));
  }

  /* ---------------------------------------------------------------- Hermes 吸收层 */
  /* 工具集清单：设置页展示「哪个身份拿到哪些面」，同时给调试用。 */
  if (method === "GET" && pathname === "/api/toolsets") {
    const mod = await tryImportModule("../toolsets.js", "toolsets", app);
    const listToolsets = pickFunction(mod, ["listToolsets"]);
    if (!listToolsets) return sendJson(res, 404, { error: "toolsets not available" });
    return sendJson(res, 200, { toolsets: listToolsets() });
  }

  /* E26 审批：挂起列表 / 审计 / 统计 / 模式 / 裁决 / 清理 */
  if (pathname.startsWith("/api/approval")) {
    const approval = app.approval;
    if (!approval) return sendJson(res, 404, { error: "approval layer not available" });
    const roomId = url.searchParams.get("room_id") || undefined;
    const botId = url.searchParams.get("bot_id") || undefined;

    if (method === "GET" && pathname === "/api/approvals") {
      const all = url.searchParams.get("status") === "all";
      const limit = clamp(qInt(url, "limit", 50), 1, 500);
      const approvals = all ? approval.list({ roomId, limit }) : approval.pending({ roomId, botId, limit });
      return sendJson(res, 200, {
        approvals,
        mode: approval.getMode(roomId || "global"),
        stats: approval.stats(),
      });
    }
    if (method === "GET" && pathname === "/api/approvals/audit") {
      return sendJson(res, 200, { audit: approval.audit({ roomId, limit: clamp(qInt(url, "limit", 100), 1, 1000) }) });
    }
    if (method === "GET" && pathname === "/api/approvals/stats") {
      return sendJson(res, 200, approval.stats());
    }
    if (pathname === "/api/approval/mode" && (method === "GET" || method === "PUT")) {
      if (method === "GET") return sendJson(res, 200, { mode: approval.getMode(roomId || "global") });
      const body = await readJson(req);
      const result = approval.setMode(body.mode, { scopeKey: body.room_id || roomId || "global", by: body.by || "user" });
      return sendJson(res, result.ok === false ? 400 : 200, result);
    }
    if (method === "POST" && pathname === "/api/approvals/clear") {
      const body = await readJson(req);
      return sendJson(res, 200, approval.clearSession({ roomId: body.room_id, botId: body.bot_id }));
    }
    const resolveMatch = pathname.match(ROUTES.approvalResolve);
    if (resolveMatch && method === "POST") {
      const body = await readJson(req);
      const result = approval.resolve(safeDecode(resolveMatch[1]), {
        decision: body.decision,
        scope: body.scope,
        by: body.by || "user",
        reason: body.reason || null,
      });
      return sendJson(res, result.ok ? 200 : 409, result);
    }
    return notFound(res, "approval endpoint not found");
  }

  /* E27 技能：用量遥测 / 守卫扫描 / 提案与策展 */
  if (pathname.startsWith("/api/skills/")) {
    const proposalReview = pathname.match(ROUTES.skillProposalReview);
    const proposalAdopt = pathname.match(ROUTES.skillProposalAdopt);
    const telemetry = app.telemetry;
    const curator = app.curator;

    if (method === "GET" && pathname === "/api/skills/usage") {
      if (!telemetry) return sendJson(res, 404, { error: "skill telemetry not available" });
      return sendJson(res, 200, { usage: telemetry.stats({ sinceDays: clamp(qInt(url, "days", 30), 1, 365) }) });
    }
    if (method === "POST" && pathname === "/api/skills/scan") {
      const mod = await tryImportModule("../skills/guard.js", "skills_guard", app);
      const scanSkillText = pickFunction(mod, ["scanSkillText"]);
      if (!scanSkillText) return sendJson(res, 404, { error: "skill guard not available" });
      const body = await readJson(req);
      const result = scanSkillText(String(body.text || ""), { name: body.name || "skill" });
      return sendJson(res, 200, result);
    }
    if (method === "GET" && pathname === "/api/skills/proposals") {
      if (!curator) return sendJson(res, 404, { error: "skill curator not available" });
      const status = url.searchParams.get("status") || null;
      return sendJson(res, 200, {
        proposals: curator.listProposals({ status, limit: clamp(qInt(url, "limit", 50), 1, 500) }),
        report: curator.report(),
      });
    }
    if (method === "POST" && pathname === "/api/skills/proposals") {
      if (!curator) return sendJson(res, 404, { error: "skill curator not available" });
      const body = await readJson(req);
      try {
        const result = curator.propose({
          title: body.title,
          body: body.body,
          evidence: body.evidence || [],
          roomId: body.room_id || null,
          botId: body.bot_id || null,
          tags: body.tags || [],
        });
        return sendJson(res, 201, result);
      } catch (err) {
        return sendJson(res, 400, { error: errorMessage(err) });
      }
    }
    if (method === "POST" && pathname === "/api/skills/curator/transitions") {
      if (!curator) return sendJson(res, 404, { error: "skill curator not available" });
      const body = await readJson(req).catch(() => ({}));
      return sendJson(res, 200, curator.transitions({
        staleDays: body.stale_days,
        archiveDays: body.archive_days,
      }));
    }
    if (proposalReview && method === "POST") {
      if (!curator) return sendJson(res, 404, { error: "skill curator not available" });
      const body = await readJson(req);
      const result = curator.review(safeDecode(proposalReview[1]), {
        decision: body.decision,
        reason: body.reason || null,
        by: body.by || "user",
      });
      return sendJson(res, result.ok ? 200 : 409, result);
    }
    if (proposalAdopt && method === "POST") {
      if (!curator) return sendJson(res, 404, { error: "skill curator not available" });
      const body = await readJson(req).catch(() => ({}));
      const result = curator.adopt(safeDecode(proposalAdopt[1]), { by: body.by || "user" });
      if (result.ok) {
        try {
          app.skills?.reload?.();
        } catch (err) {
          log.warn("skills reload after adopt failed:", errorMessage(err));
        }
      }
      return sendJson(res, result.ok ? 200 : 409, result);
    }
    return notFound(res, "skills endpoint not found");
  }

  /* E28 持久记忆 */
  if (pathname === "/api/memory" && (method === "GET" || method === "POST")) {
    const memory = app.memory;
    if (!memory) return sendJson(res, 404, { error: "memory layer not available" });
    if (method === "GET") {
      return sendJson(res, 200, {
        entries: memory.list({
          scope: url.searchParams.get("scope") || undefined,
          roomId: url.searchParams.get("room_id") || undefined,
          botId: url.searchParams.get("bot_id") || undefined,
          target: url.searchParams.get("target") || undefined,
          limit: clamp(qInt(url, "limit", 100), 1, 500),
        }),
        stats: memory.stats(),
      });
    }
    const body = await readJson(req);
    try {
      const entry = memory.save({
        scope: body.scope,
        roomId: body.room_id,
        botId: body.bot_id,
        target: body.target,
        content: body.content,
        tags: body.tags,
        pinned: body.pinned,
        source: body.source || "user",
      });
      return sendJson(res, 201, { entry });
    } catch (err) {
      return sendJson(res, 400, { error: errorMessage(err) });
    }
  }
  if (method === "GET" && pathname === "/api/memory/search") {
    const memory = app.memory;
    if (!memory) return sendJson(res, 404, { error: "memory layer not available" });
    return sendJson(res, 200, {
      results: memory.search({
        query: url.searchParams.get("q") || "",
        scope: url.searchParams.get("scope") || undefined,
        roomId: url.searchParams.get("room_id") || undefined,
        botId: url.searchParams.get("bot_id") || undefined,
        target: url.searchParams.get("target") || undefined,
        limit: clamp(qInt(url, "limit", 10), 1, 100),
      }),
    });
  }
  if (method === "GET" && pathname === "/api/memory/audit") {
    const memory = app.memory;
    if (!memory) return sendJson(res, 404, { error: "memory layer not available" });
    return sendJson(res, 200, { audit: memory.audit({ limit: clamp(qInt(url, "limit", 50), 1, 500) }) });
  }
  const memoryMatch = pathname.match(ROUTES.memoryEntry);
  if (memoryMatch && (method === "DELETE" || method === "PATCH" || method === "PUT")) {
    const memory = app.memory;
    if (!memory) return sendJson(res, 404, { error: "memory layer not available" });
    const id = safeDecode(memoryMatch[1]);
    if (method === "DELETE") {
      return sendJson(res, 200, memory.remove(id, { source: "user", reason: "用户删除" }));
    }
    const body = await readJson(req);
    try {
      const entry = memory.replace(id, {
        content: body.content === undefined ? undefined : String(body.content),
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        pinned: body.pinned === undefined ? undefined : Boolean(body.pinned),
        source: body.source || "user",
      });
      return sendJson(res, 200, { entry });
    } catch (err) {
      return sendJson(res, 400, { error: errorMessage(err) });
    }
  }

  /* E17 / E18 rooms */
  if (method === "GET" && pathname === "/api/rooms") {
    return sendJson(res, 200, { rooms: allRooms(app) });
  }
  if (method === "POST" && pathname === "/api/rooms") {
    const body = await readJson(req);
    const result = await createRoom(app, body);
    return sendJson(res, result.status, result.body);
  }

  /* E21 messages */
  const messagesMatch = pathname.match(ROUTES.roomMessages);
  if (messagesMatch && method === "GET") {
    const roomId = safeDecode(messagesMatch[1]);
    if (badPathId(roomId) || !roomExists(app, roomId)) return notFound(res, "room not found");
    const afterSeq = Math.max(0, qInt(url, "after_seq", 0));
    const limit = clamp(qInt(url, "limit", 500), 0, 5000);
    const messages = listRoomMessages(app, roomId, { afterSeq, limit });
    // E21 附带证据阶梯状态（observed/prepared/mismatch；没有记录 = null，表示"没判定"而非"仅声明"）。
    let evidenceBySeq = new Map();
    try {
      const evidence = getRoomObject(app, roomId)?.evidenceStore;
      if (evidence) {
        for (const rec of evidence.list({ roomId, limit: 1000 })) {
          evidenceBySeq.set(Number(rec.message_seq), rec.status);
        }
      }
    } catch (err) {
      log.warn("evidence lookup for messages failed:", roomId, errorMessage(err));
    }
    return sendJson(res, 200, {
      room_id: roomId,
      messages: messages.map((m) => ({ ...m, evidence: evidenceBySeq.get(Number(m.seq)) ?? null })),
    });
  }

  /* E29 evidence：房间内每个成员回合的证据判定（observed / prepared / mismatch） */
  const evidenceMatch = pathname.match(ROUTES.roomEvidence);
  if (evidenceMatch && method === "GET") {
    const roomId = safeDecode(evidenceMatch[1]);
    if (badPathId(roomId) || !roomExists(app, roomId)) return notFound(res, "room not found");
    const room = getRoomObject(app, roomId);
    let evidence = null;
    try {
      evidence = room?.evidenceStore || null;
    } catch (err) {
      log.warn("evidence store unavailable:", roomId, errorMessage(err));
    }
    if (!evidence) return sendJson(res, 404, { error: "evidence layer not available" });
    return sendJson(res, 200, {
      room_id: roomId,
      summary: evidence.summary({ roomId }),
      records: evidence.list({ roomId, limit: clamp(qInt(url, "limit", 50), 1, 500) }),
    });
  }

  /* E30 learn：手动把最近一轮经验沉淀成技能提案（对应 Hermes 的「the workflow we just went through」） */
  const learnMatch = pathname.match(ROUTES.roomLearn);
  if (learnMatch && method === "POST") {
    const roomId = safeDecode(learnMatch[1]);
    if (badPathId(roomId) || !roomExists(app, roomId)) return notFound(res, "room not found");
    const room = getRoomObject(app, roomId);
    if (!room || typeof room.proposeLearningSkill !== "function") {
      return sendJson(res, 503, { error: "learning loop not available" });
    }
    const body = await readJson(req).catch(() => ({}));
    let turns = null;
    try {
      turns = typeof room.recentTurns === "function" ? room.recentTurns({ max: 12 }) : null;
    } catch (err) {
      log.warn("recentTurns failed:", roomId, errorMessage(err));
    }
    try {
      const result = await room.proposeLearningSkill({
        instruction: body.instruction || "",
        turns,
        force: body.force !== false,
      });
      return sendJson(res, result.ok ? 201 : 200, result);
    } catch (err) {
      return sendJson(res, 500, { error: errorMessage(err) });
    }
  }

  /* E22 files */
  const filesMatch = pathname.match(ROUTES.roomFiles);
  if (filesMatch && method === "GET") {
    const roomId = safeDecode(filesMatch[1]);
    if (badPathId(roomId) || !roomExists(app, roomId)) return notFound(res, "room not found");
    return sendJson(res, 200, { room_id: roomId, files: roomFileEntries(app, roomId) });
  }

  /* E23 one file */
  const fileMatch = pathname.match(ROUTES.roomFile);
  if (fileMatch && method === "GET") {
    const roomId = safeDecode(fileMatch[1]);
    const fileId = safeDecode(fileMatch[2]);
    if (badPathId(roomId) || badPathId(fileId) || !roomExists(app, roomId)) {
      return notFound(res, "room or file not found");
    }
    const result = filePreview(app, roomId, fileId);
    return sendJson(res, result.status, result.body);
  }

  /* E24 say */
  const sayMatch = pathname.match(ROUTES.roomSay);
  if (sayMatch && method === "POST") {
    const roomId = safeDecode(sayMatch[1]);
    if (badPathId(roomId)) return notFound(res, "room not found");
    const body = await readJson(req);
    const result = await roomSay(app, roomId, body.content);
    return sendJson(res, result.status, result.body);
  }

  /* E19 / E20 single room */
  const roomMatch = pathname.match(ROUTES.room);
  if (roomMatch && (method === "GET" || method === "PUT")) {
    const roomId = safeDecode(roomMatch[1]);
    if (badPathId(roomId)) return notFound(res, "room not found");
    if (method === "GET") {
      const snapshot = roomSnapshot(app, roomId);
      if (!snapshot) return notFound(res, "room not found");
      return sendJson(res, 200, snapshot);
    }
    const body = await readJson(req);
    const result = await updateRoom(app, roomId, body);
    return sendJson(res, result.status, result.body);
  }

  /* E25 persisted event replay */
  const threadMatch = pathname.match(ROUTES.threadEvents);
  if (threadMatch && method === "GET") {
    const threadId = safeDecode(threadMatch[1]);
    if (!threadId || threadId.includes("/")) return notFound(res, "not found");
    const afterSeq = Math.max(0, qInt(url, "after_seq", 0));
    const limit = clamp(qInt(url, "limit", 500), 0, 5000);
    let events = listEvents(app, { threadId, afterSeq, limit });
    if (!events.length && threadId.startsWith("room:")) {
      // tolerate a backend that persisted the bare room id as thread_id
      events = listEvents(app, { threadId: threadId.slice(5), afterSeq, limit });
    }
    if (!events.length && threadId.startsWith("chief:")) {
      const ticketId = threadId.slice(6);
      const recent = listEvents(app, { afterSeq, limit: clamp(limit * 4, limit, 5000) });
      events = recent.filter(
        (event) =>
          event.thread_id === threadId ||
          event.payload?.thread_id === threadId ||
          event.payload?.ticket_id === ticketId,
      );
    }
    return sendJson(res, 200, { thread_id: threadId, events });
  }

  /* E26 SSE */
  if (method === "GET" && pathname === "/api/events") {
    return handleSse(app, req, res, url);
  }

  /* E27 tickets */
  if (method === "GET" && pathname === "/api/tickets") {
    return sendJson(res, 200, listTickets(app, 50));
  }

  /* E28 threads */
  if (method === "GET" && pathname === "/api/threads") {
    const threads = listTickets(app, 50)
      .filter((ticket) => ticket.thread_id)
      .map((ticket) => ({
        id: ticket.thread_id,
        source_id: "cli",
        status: ["working", "queued"].includes(String(ticket.state)) ? "active" : "idle",
        subscriptions: [ticket.id],
      }));
    return sendJson(res, 200, threads);
  }

  /* E29 task */
  if (method === "POST" && pathname === "/api/task") {
    const body = await readJson(req);
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt.trim()) return sendJson(res, 400, { error: "prompt is required" });
    return sendJson(res, 202, submitTask(app, prompt));
  }

  /* diagnostics (extra, AgentFusion-only) */
  if (method === "GET" && pathname === "/api/diagnostics") {
    return sendJson(res, 200, {
      wiring: app.wiring,
      errors: app.errors,
      uptime_ms: Date.now() - app.startedAt,
      requests: app.stats.requests,
      sse_clients: app.sse.size,
      data_root: DATA_ROOT,
      kernel: kernelLabel(),
      version: APP_VERSION,
      log_tail: readTail(80),
    });
  }

  return notFound(res, "not found");
}

/* -------------------------------------------------------------- http layer */

function createHandler(app) {
  return (req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", `http://${req.headers?.host || "127.0.0.1"}`);
    } catch {
      url = new URL("http://127.0.0.1/");
    }
    app.stats.requests += 1;
    const method = req.method || "GET";

    if (method === "OPTIONS") {
      sendOptions(res);
      return;
    }

    const started = Date.now();
    const finish = (err) => {
      const ms = Date.now() - started;
      if (err) log.error(`http ${method} ${url.pathname} failed in ${ms}ms:`, errorMessage(err));
      else log.debug(`http ${method} ${url.pathname} ${res.statusCode} ${ms}ms`);
    };

    if (url.pathname.startsWith("/api/")) {
      handleApi(app, req, res, url)
        .then(() => finish(null))
        .catch((err) => {
          finish(err);
          if (!res.headersSent) sendJson(res, statusForError(err, 500), { error: errorMessage(err) });
          else {
            try {
              res.end();
            } catch {
              /* ignore */
            }
          }
        });
      return;
    }

    try {
      serveStatic(req, res, url.pathname);
      finish(null);
    } catch (err) {
      finish(err);
      if (!res.headersSent) sendJson(res, 500, { error: errorMessage(err) });
    }
  };
}

function listenOnce(handler, host, port) {
  const server = http.createServer(handler);
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  server.on("clientError", (err, socket) => {
    log.debug("client error:", errorMessage(err));
    try {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    } catch {
      /* ignore */
    }
  });
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (err) {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      reject(err);
    }
  }).catch((err) => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    throw err;
  });
}

async function shutdownServer(app, server) {
  app.closing = true;
  for (const client of Array.from(app.sse)) {
    try {
      client.end();
    } catch {
      /* ignore */
    }
  }
  app.sse.clear();
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        server.closeAllConnections?.();
      } catch {
        /* ignore */
      }
      finish();
    }, 1500);
    timer.unref?.();
    try {
      server.close(() => finish());
    } catch {
      finish();
    }
    try {
      server.closeIdleConnections?.();
    } catch {
      /* ignore */
    }
  });
  await disposeApp(app);
}

/**
 * Start the HTTP API (booting the rest of the app unless dependencies are injected).
 *
 * @param {{port?:number, host?:string, app?:object, store?:any, events?:any,
 *          engine?:any, rooms?:any, skills?:any, hooks?:any}} options
 * @returns {Promise<{url:string, port:number, host:string, close:()=>Promise<void>, app:object, server:object}>}
 */
export async function startServer(options = {}) {
  const requestedPort = Number(options.port ?? PORT_DEFAULT);
  const host = options.host || HOST;
  const app = options.app || (await createApp(options));
  app.host = host;
  const handler = createHandler(app);

  let server = null;
  let actualPort = requestedPort;
  let lastError = null;
  for (let attempt = 0; attempt < MAX_PORT_RETRIES; attempt += 1) {
    const candidate = requestedPort + attempt;
    try {
      server = await listenOnce(handler, host, candidate);
      actualPort = candidate;
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      const code = err?.code;
      if (code === "EADDRINUSE" || code === "EACCES" || code === "EADDRNOTAVAIL") {
        log.warn(`port ${candidate} unavailable (${code}); trying ${candidate + 1}`);
        continue;
      }
      throw err;
    }
  }
  if (!server) throw lastError || new Error("could not bind an HTTP port");

  app.port = actualPort;
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${displayHost}:${actualPort}`;
  app.url = url;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await shutdownServer(app, server);
    log.info(`server on ${url} closed`);
  };
  app.close = close;

  log.info(`listening on ${url}`);
  return { url, port: actualPort, host, close, app, server };
}

export default { startServer, createApp };
