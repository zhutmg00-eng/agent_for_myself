#!/usr/bin/env node
/**
 * End-to-end acceptance: boot the fusion server, create a room, send one real
 * task, watch the SSE stream, then verify messages + group-file space.
 *
 * Usage:
 *   node tests/e2e_room.mjs               # full run (real LLM, ~2-5 min)
 *   node tests/e2e_room.mjs --keep        # keep the server running afterwards
 *   node tests/e2e_room.mjs --port 8791
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NODE = process.execPath;

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const portArg = args.indexOf("--port");
const PORT = Number(portArg >= 0 ? args[portArg + 1] : 8791);
const BASE = `http://127.0.0.1:${PORT}`;
const TASK =
  "请群主分派：让 coder 写一份 100 字以内的 AgentFusion 产品简介，librarian 保存为 intro.md 并回传 file_id，reviewer 按 file_id 核验，最后群主汇总结论。";

const timeline = [];
const log = (...a) => {
  const line = a.join(" ");
  timeline.push(line);
  console.log(line);
};

async function waitHealth(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not become healthy");
}

function startServer() {
  const child = spawn(NODE, [path.join(ROOT, "src", "main.js"), "--port", String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, FUSION_DATA_ROOT: process.env.FUSION_DATA_ROOT || "D:\\AgentFusion" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  child.stdout.on("data", (d) => out.push(d.toString()));
  child.stderr.on("data", (d) => out.push(d.toString()));
  child.__out = out;
  return child;
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
  return data;
}

/** Collect SSE events with a deadline. */
function collectEvents(deadlineMs, onEvent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const done = new Promise((resolve) => {
    (async () => {
      try {
        const res = await fetch(`${BASE}/api/events`, { signal: controller.signal });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done: finished } = await reader.read();
          if (finished) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() || "";
          for (const frame of frames) {
            const m = frame.match(/^data:\s*(.*)$/m);
            if (!m) continue;
            try {
              const evt = JSON.parse(m[1]);
              onEvent(evt);
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* aborted */
      } finally {
        clearTimeout(timer);
        resolve();
      }
    })();
  });
  return { done, stop: () => controller.abort() };
}

async function main() {
  log("== AgentFusion E2E ==");
  log("root:", ROOT, "port:", PORT);
  const server = startServer();
  const cleanup = async () => {
    if (keep) return;
    try {
      server.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };

  try {
    const health = await waitHealth();
    log("health ok:", JSON.stringify(health).slice(0, 300));

    const bots = await api("GET", "/api/bots");
    const botList = bots.bots || bots;
    log("bots:", Array.isArray(botList) ? botList.map((b) => b.id || b.name).join(",") : "?");

    const room = await api("POST", "/api/rooms", {
      title: "E2E 验收群",
      owner_id: "boss",
      members: ["boss", "coder", "librarian", "reviewer"],
      context_policy: "shared",
    });
    const roomId = room.room_id || room.roomId || room.id;
    log("room created:", roomId);

    const seen = new Map();
    const started = Date.now();
    let finished = false;
    const ROUND_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 480000);
    const collector = collectEvents(ROUND_TIMEOUT_MS, (evt) => {
      const key = evt.topic;
      seen.set(key, (seen.get(key) || 0) + 1);
      if (key.includes("round_completed") || key === "round_completed") finished = true;
      if (process.env.E2E_VERBOSE === "1") log("  evt:", key, JSON.stringify(evt.payload || {}).slice(0, 160));
    });

    await api("POST", `/api/rooms/${roomId}/say`, { content: TASK });
    log("task sent, waiting for round_completed ...");

    while (!finished && Date.now() - started < ROUND_TIMEOUT_MS) await new Promise((r) => setTimeout(r, 1000));
    collector.stop();
    await collector.done;
    log(`round finished=${finished} in ${Math.round((Date.now() - started) / 1000)}s`);

    const msgs = await api("GET", `/api/rooms/${roomId}/messages`);
    const messageList = msgs.messages || [];
    log(`messages: ${messageList.length}`);
    for (const m of messageList.slice(-12)) log(`  [${m.speaker}] ${String(m.content).replace(/\s+/g, " ").slice(0, 120)}`);

    const files = await api("GET", `/api/rooms/${roomId}/files`);
    const fileList = files.files || [];
    log(`files: ${fileList.length}`);
    for (const f of fileList) log(`  ${f.file_id} ${f.path} — ${f.description || ""}`);

    const replay = await api("GET", `/api/thread/${encodeURIComponent(`room:${roomId}`)}/events?after_seq=0&limit=5000`);
    log(`replay events: ${(replay.events || []).length}`);
    log("event topics:", [...seen.keys()].sort().join(", "));

    const ok =
      finished &&
      messageList.length >= 3 &&
      messageList.some((m) => m.speaker === "coder") &&
      messageList.some((m) => m.speaker === "librarian");
    log(ok ? "RESULT: PASS" : "RESULT: FAIL (see above)");
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    log("ERROR:", err && err.stack ? err.stack : String(err));
    log("server output tail:", server.__out.join("").slice(-2000));
    process.exitCode = 1;
  } finally {
    await cleanup();
    if (process.env.E2E_DUMP) {
      fs.writeFileSync(path.join(ROOT, "tests", "e2e_last_run.log"), timeline.join("\n"), "utf8");
    }
  }
}

main();
