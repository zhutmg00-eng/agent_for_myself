/**
 * Paths, ports, environment bootstrap and the "never write to C:" guard.
 *
 * IMPORTANT: bootstrapEnv() must run BEFORE anything imports pi, because pi reads
 * several PI_* variables at module load time.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(SRC_DIR, "..");

/** Absolute default data root. Overridable with FUSION_DATA_ROOT. */
export const DATA_ROOT = path.resolve(process.env.FUSION_DATA_ROOT || "D:\\AgentFusion");

export const DIRS = {
  data: path.join(DATA_ROOT, "data"),
  workspace: path.join(DATA_ROOT, "workspace"),
  rooms: path.join(DATA_ROOT, "rooms"),
  agents: path.join(DATA_ROOT, "agents"),
  sessions: path.join(DATA_ROOT, "sessions"),
  logs: path.join(DATA_ROOT, "logs"),
  cache: path.join(DATA_ROOT, "cache"),
  temp: path.join(DATA_ROOT, "temp"),
  fusion: path.join(DATA_ROOT, ".fusion"),
  avatars: path.join(DATA_ROOT, ".fusion", "avatars"),
  skills: path.join(DATA_ROOT, ".fusion", "skills"),
  sharedAgent: path.join(DATA_ROOT, "agents", "_shared"),
  dbFile: path.join(DATA_ROOT, "data", "fusion.db"),
  settingsFile: path.join(DATA_ROOT, ".fusion", "settings.json"),
  hooksFile: path.join(DATA_ROOT, ".fusion", "hooks.json"),
  logFile: path.join(DATA_ROOT, "logs", "app.log"),
};

export const PORT_DEFAULT = Number(process.env.FUSION_PORT || 8720);
export const HOST = process.env.FUSION_HOST || "127.0.0.1";
export const GATEWAY_URL = process.env.FUSION_GATEWAY || "http://127.0.0.1:3425/v1";
export const GATEWAY_ORIGIN = (() => {
  try {
    const u = new URL(GATEWAY_URL);
    return u.origin;
  } catch {
    return "http://127.0.0.1:3425";
  }
})();

/** Electron dist used for the portable build (checked in this order). */
export function electronDist() {
  const candidates = [
    process.env.FUSION_ELECTRON_DIST,
    path.join(ROOT, "node_modules", "electron", "dist"),
    path.resolve(ROOT, "..", "agentharness", "desktop", "node_modules", "electron", "dist"),
    "D:\\tools\\pi\\node_modules\\electron\\dist",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, executableName()))) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function executableName() {
  return process.platform === "win32" ? "electron.exe" : "electron";
}

/** Resolve the pi package root (bundle entry lives at <pkg>/dist/bundle/index.js). */
export function piPackageCandidates() {
  return [
    process.env.FUSION_PI_PACKAGE,
    path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent"),
    "D:\\tools\\pi\\node_modules\\@earendil-works\\pi-coding-agent",
    path.join(process.resourcesPath || "", "app", "node_modules", "@earendil-works", "pi-coding-agent"),
  ].filter((p) => {
    try {
      return Boolean(p) && fs.existsSync(path.join(p, "package.json"));
    } catch {
      return false;
    }
  });
}

export function piEntryFile() {
  const pkg = piPackageCandidates()[0];
  if (!pkg) return null;
  const bundled = path.join(pkg, "dist", "bundle", "index.js");
  if (fs.existsSync(bundled)) return bundled;
  const plain = path.join(pkg, "dist", "index.js");
  return fs.existsSync(plain) ? plain : null;
}

export function assertNotC(target, label = "path") {
  const abs = path.resolve(String(target));
  if (/^[a-zA-Z]:[\\/]/.test(abs) && abs[0].toUpperCase() === "C") {
    throw new Error(`refusing to write to C: drive (${label}): ${abs}`);
  }
  return abs;
}

export function dataPath(...parts) {
  return path.join(DATA_ROOT, ...parts);
}

let envDone = false;
/** Must be called before importing pi. Idempotent. */
export function bootstrapEnv() {
  if (envDone) return;
  envDone = true;
  ensureDirs();
  const set = (k, v) => {
    if (v !== undefined && v !== null) process.env[k] = String(v);
  };
  // pi configuration/state — everything points at D:.
  set("PI_CODING_AGENT_DIR", DIRS.sharedAgent);
  set("PI_CODING_AGENT_SESSION_DIR", DIRS.sessions);
  set("PI_OFFLINE", process.env.FUSION_PI_ONLINE === "1" ? undefined : "1");
  set("PI_SKIP_VERSION_CHECK", "1");
  set("PI_TELEMETRY", "0");
  // Process temp / caches must not land on C:.
  set("TEMP", DIRS.temp);
  set("TMP", DIRS.temp);
  set("TMPDIR", DIRS.temp);
  set("XDG_CACHE_HOME", DIRS.cache);
  set("XDG_DATA_HOME", DIRS.data);
}

export function ensureDirs() {
  for (const dir of Object.values(DIRS)) {
    if (path.extname(dir) === ".db" || path.extname(dir) === ".json" || path.extname(dir) === ".log") continue;
    assertNotC(dir, "data dir");
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Default model id used when nothing is configured. */
export const DEFAULT_MODEL = process.env.FUSION_MODEL || "auto/deepseek-v4.1-flash";

/**
 * pi 的压缩策略（写入每个 bot 工作区的 `.pi/settings.json`，见 src/engine/bot.js）。
 *
 * 为什么要在项目级覆盖：默认 reserveTokens=16384 / keepRecentTokens=20000 是给「一个人长聊」
 * 设计的；群聊里每轮都会注入房间摘要 + 增量转录（约 2k tokens/轮），压缩触发得太晚会导致
 * 单个成员会话在 8–10 轮后就吃满窗口。把保留区抬到 12000、保留最近 16000，让压缩更早发生、
 * 同时仍留下足够近因上下文。可用 FUSION_RESERVE_TOKENS / FUSION_KEEP_RECENT_TOKENS 覆盖。
 */
export const COMPACTION = {
  reserveTokens: Math.max(2000, Number(process.env.FUSION_RESERVE_TOKENS) || 12000),
  keepRecentTokens: Math.max(2000, Number(process.env.FUSION_KEEP_RECENT_TOKENS) || 16000),
};

/** 项目级 pi settings（当前只覆盖 compaction；pi 会与全局 settings 合并）。 */
export function piProjectSettings() {
  return {
    compaction: {
      enabled: true,
      reserveTokens: COMPACTION.reserveTokens,
      keepRecentTokens: COMPACTION.keepRecentTokens,
    },
  };
}

/** 默认回合看门狗超时时间（30 秒，符合 PROJECT.md 契约）。 */
export const DEFAULT_TURN_TIMEOUT_MS = 30_000;

/** 工具输出截断配置（防止巨量输出撑爆 LLM 上下文与首字延迟）。 */
export const TOOL_OUTPUT_CLAMP = {
  enabled: process.env.FUSION_TOOL_OUTPUT_CLAMP !== "0",
  maxChars: Math.max(1000, Number(process.env.FUSION_TOOL_OUTPUT_CLAMP_CHARS) || 12000),
  headChars: Math.max(500, Number(process.env.FUSION_TOOL_OUTPUT_CLAMP_HEAD) || 6000),
  tailChars: Math.max(500, Number(process.env.FUSION_TOOL_OUTPUT_CLAMP_TAIL) || 4000),
};

