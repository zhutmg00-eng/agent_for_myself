/**
 * Tiny file+console logger. Never writes outside DATA_ROOT (see config.assertNotC).
 */
import fs from "node:fs";
import path from "node:path";
import { DIRS, assertNotC } from "./config.js";

const MAX_BYTES = 8 * 1024 * 1024;
let stream = null;

function ensureStream() {
  if (stream) return stream;
  const file = assertNotC(DIRS.logFile, "log file");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    /* file may not exist yet */
  }
  stream = fs.createWriteStream(file, { flags: "a" });
  return stream;
}

function line(level, scope, args) {
  const ts = new Date().toISOString();
  const text = args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  return `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${text}`;
}

function emit(level, scope, args) {
  const out = line(level, scope, args);
  try {
    ensureStream().write(out + "\n");
  } catch {
    /* logging must never crash the app */
  }
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else if (process.env.FUSION_VERBOSE === "1" || level === "info") console.log(out);
}

export function createLogger(scope = "app") {
  return {
    debug: (...a) => emit("debug", scope, a),
    info: (...a) => emit("info", scope, a),
    warn: (...a) => emit("warn", scope, a),
    error: (...a) => emit("error", scope, a),
  };
}

/** Last N lines of the log file (diagnostics / context inspector). */
export function readTail(n = 120) {
  try {
    const text = fs.readFileSync(DIRS.logFile, "utf8");
    const lines = text.trimEnd().split("\n");
    return lines.slice(-Math.max(1, n));
  } catch {
    return [];
  }
}
