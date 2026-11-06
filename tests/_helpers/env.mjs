/**
 * Test isolation helper: redirect the whole data root to a throw-away directory
 * on D: *before* any `src/` module is evaluated.
 *
 * Why a side-effecting module: `src/config.js` resolves DATA_ROOT at module
 * evaluation time, and ESM evaluates static imports in source order. Every test
 * file therefore imports THIS module first, then the modules under test:
 *
 *   import { TEST_DATA_ROOT } from "./_helpers/env.mjs";   // evaluated first
 *   import { Store } from "../src/store.js";               // sees the override
 *
 * Guarantees:
 *  - never writes outside `D:\能力测试\temp\fusion-tests\...` (asserted below),
 *  - registers one file-level `after()` hook that closes every registered
 *    resource and then deletes the temporary data root,
 *  - keeps TEMP/TMP inside that root so nothing lands on C:.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

/**
 * 测试数据根：优先 D 盘（本机约定），但允许在别的机器上退化到临时目录。
 * 顺序：FUSION_TEST_ROOT → D:\能力测试\temp\fusion-tests → 系统临时目录/fusion-tests。
 * 任何 C 盘路径都会被下面的断言拒绝。
 */
function pickTestBase() {
  const candidates = [
    process.env.FUSION_TEST_ROOT,
    "D:\\能力测试\\temp\\fusion-tests",
    path.join(os.tmpdir(), "fusion-tests"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (/^[a-z]:\\/i.test(resolved) && /^c:/i.test(resolved)) continue;
    try {
      fs.mkdirSync(path.join(resolved, "probe"), { recursive: true });
      fs.rmSync(path.join(resolved, "probe"), { recursive: true, force: true });
      return resolved;
    } catch {
      /* try next */
    }
  }
  throw new Error("没有可用且非 C 盘的测试数据根（可用 FUSION_TEST_ROOT 指定）");
}

const TEST_BASE = pickTestBase();

function safeLabel() {
  const entry = process.argv[1] || "test";
  return path.basename(entry).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/\.mjs$/, "") || "test";
}

const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export const TEST_DATA_ROOT = path.join(TEST_BASE, `${safeLabel()}-${process.pid}-${unique}`);
export const TEST_DB_DIR = path.join(TEST_DATA_ROOT, "data");
export const TEST_TEMP_DIR = path.join(TEST_DATA_ROOT, "temp");

if (/^c:/i.test(TEST_DATA_ROOT)) {
  throw new Error(`refusing to run tests with a C: data root: ${TEST_DATA_ROOT}`);
}
fs.mkdirSync(TEST_DB_DIR, { recursive: true });
fs.mkdirSync(TEST_TEMP_DIR, { recursive: true });

// Must happen before any src/*.js module is loaded.
process.env.FUSION_DATA_ROOT = TEST_DATA_ROOT;
process.env.TEMP = TEST_TEMP_DIR;
process.env.TMP = TEST_TEMP_DIR;
process.env.TMPDIR = TEST_TEMP_DIR;
// Keep the logger from drowning TAP output.
process.env.FUSION_VERBOSE = "0";

const closers = [];
let teardownStarted = false;

/** Register a teardown callback (synchronous). Runs in reverse order before rm. */
export function onCleanup(fn) {
  if (typeof fn === "function") closers.push(fn);
}

/** Absolute path inside the throw-away data root. */
export function testPath(...parts) {
  return path.join(TEST_DATA_ROOT, ...parts);
}

/**
 * src/log.js keeps one lazily-opened append stream for the whole process; if we
 * delete the data root while a write is still queued the stream emits ENOENT
 * *after* the last test, which node:test reports as a failure. Swallow exactly
 * that teardown race (and nothing else) so real errors still fail the run.
 */
function isTeardownLogRace(err) {
  const code = String(err?.code || "");
  const msg = String(err?.message || err);
  return teardownStarted && (code === "ENOENT" || code === "EBADF") && /app\.log/.test(msg);
}

process.on("uncaughtException", (err) => {
  if (isTeardownLogRace(err)) return;
  console.error("[tests] uncaught exception:", err);
  process.exitCode = 1;
});
process.on("unhandledRejection", (err) => {
  if (isTeardownLogRace(err)) return;
  console.error("[tests] unhandled rejection:", err);
  process.exitCode = 1;
});

const flush = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

after(async () => {
  teardownStarted = true;
  for (const fn of closers.reverse()) {
    try {
      fn();
    } catch {
      /* teardown must never fail the run */
    }
  }
  // Let the logger's queued writes land before the directory disappears.
  await flush();
  try {
    fs.rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may keep WAL handles briefly; a leftover temp dir is harmless */
  }
});
