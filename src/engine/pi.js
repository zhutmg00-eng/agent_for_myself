/**
 * pi kernel bootstrap.
 *
 * The pi package is loaded through its **bundle** entry (`dist/bundle/index.js`)
 * so the app needs no transpiler, no TypeScript build step and no external
 * runtime dependencies. `config.bootstrapEnv()` MUST run before the dynamic
 * import, because pi reads several `PI_*` environment variables when its module
 * graph is initialised (agent dir, session dir, temp redirect, telemetry...).
 *
 * This module is the only place that knows the entry point resolution order; all
 * other engine modules import their pi symbols from here.
 */
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { bootstrapEnv, piEntryFile, piPackageCandidates } from "../config.js";
import { createLogger } from "../log.js";

const log = createLogger("engine.pi");

/** @type {any|null} */
let cached = null;
/** @type {Promise<any>|null} */
let loading = null;

/** Absolute path of the pi entry that will be imported (or null). */
export function piEntry() {
  return piEntryFile();
}

/** Root directory of the installed pi package (for `package.json` version display). */
export function piPackageDir() {
  return piPackageCandidates()[0] || null;
}

/**
 * Load (and cache) the pi bundle namespace.
 * Calls `bootstrapEnv()` first, which is mandatory before the import.
 * @returns {Promise<any>} the pi module namespace
 */
export async function loadPi() {
  if (cached) return cached;
  if (loading) return loading;
  bootstrapEnv();
  const entry = piEntryFile();
  if (!entry) {
    throw new Error(
      "pi bundle entry not found. Expected node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js " +
        "(or set FUSION_PI_ENTRY).",
    );
  }
  loading = (async () => {
    const startedAt = Date.now();
    const mod = await import(pathToFileURL(entry).href);
    const ms = Date.now() - startedAt;
    log.info(`pi kernel loaded in ${ms}ms from ${entry} (v${mod.VERSION || "unknown"})`);
    cached = mod;
    return mod;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/** Synchronous accessor for an already-loaded namespace (throws otherwise). */
export function piOrThrow() {
  if (!cached) throw new Error("pi is not loaded yet — await loadPi() first");
  return cached;
}

/** Version string of the loaded pi kernel (e.g. "1.3.0"). */
export function piVersion() {
  if (cached?.VERSION) return String(cached.VERSION);
  try {
    const dir = piPackageDir();
    if (dir) {
      const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, "utf8"));
      return String(pkg.version || "");
    }
  } catch {
    /* ignore */
  }
  return "";
}

// Redirect env + load the kernel once, eagerly: every engine consumer needs it
// and failing here (instead of mid-turn) keeps errors obvious.
bootstrapEnv();
const ns = await loadPi();

/** pi kernel namespace (all exports of the bundle entry). */
export const pi = ns;
export const {
  createAgentSession,
  ModelRuntime,
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  defineTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  createCodingTools,
  createReadOnlyTools,
  withFileMutationQueue,
  getLastAssistantUsage,
  getAgentDir,
  VERSION,
} = ns;

export default ns;
