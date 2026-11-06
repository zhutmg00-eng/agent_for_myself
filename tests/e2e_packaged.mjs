#!/usr/bin/env node
/**
 * Acceptance: drive a REAL group-chat round through the PACKAGED desktop app.
 *
 *   node tests/e2e_packaged.mjs [--port 8811] [--data-root D:\能力测试\temp\pkgdata]
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const EXE = path.join(ROOT, "dist", "AgentFusion-win64", "AgentFusion.exe");
const args = process.argv.slice(2);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : d;
};
const PORT = Number(val("--port", 8811));
const DATA_ROOT = val("--data-root", "D:\\能力测试\\temp\\pkgdata");
const BASE = `http://127.0.0.1:${PORT}`;

function log(...a) {
  console.log("[e2e-packaged]", ...a);
}

if (!fs.existsSync(EXE)) {
  console.error("missing exe:", EXE);
  process.exit(2);
}
fs.mkdirSync(DATA_ROOT, { recursive: true });

const env = { ...process.env, FUSION_DATA_ROOT: DATA_ROOT, FUSION_SINGLE_INSTANCE: "0", FUSION_PORT: String(PORT) };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(EXE, ["--port", String(PORT)], { env, detached: false, stdio: ["ignore", "pipe", "pipe"] });
const out = [];
child.stdout.on("data", (d) => out.push(d.toString()));
child.stderr.on("data", (d) => out.push(d.toString()));

async function waitHealth(timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("packaged app did not become healthy\n" + out.join("").slice(-2000));
}

const api = async (m, p, body) => {
  const res = await fetch(BASE + p, {
    method: m,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${m} ${p} -> ${res.status} ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

function killTree() {
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {}
}

try {
  const t0 = Date.now();
  const health = await waitHealth();
  log("health ok in", Date.now() - t0, "ms:", JSON.stringify(health).slice(0, 160));
  log("kernel:", health.kernel, "model:", health.model);

  const created = await api("POST", "/api/rooms", {
    title: "打包版验收群",
    owner_id: "boss",
    members: ["boss", "coder", "librarian", "reviewer"],
    context_policy: "shared",
  });
  const roomId = created.room_id;
  log("room:", roomId, created.members.join(","));

  const events = [];
  let done = false;
  (async () => {
    try {
      const res = await fetch(`${BASE}/api/events`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done: fin } = await reader.read();
        if (fin) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() || "";
        for (const f of frames) {
          const m = f.match(/^data:\s*(.*)$/m);
          if (!m) continue;
          try {
            const e = JSON.parse(m[1]);
            events.push(e);
            if (e.topic === `room.${roomId}.round_completed`) done = true;
          } catch {}
        }
      }
    } catch {}
  })();

  const task =
    "请群主分派：让 coder 写一句话介绍打包版 AgentFusion（30 字内），librarian 存为 note.md 并回传 file_id，reviewer 按 file_id 核验后由群主汇总。";
  await api("POST", `/api/rooms/${roomId}/say`, { content: task });
  log("task sent; waiting for round_completed ...");

  const waitStart = Date.now();
  const ROUND_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 480000);
  while (!done && Date.now() - waitStart < ROUND_TIMEOUT_MS) await new Promise((r) => setTimeout(r, 1000));
  log("round_completed:", done, "elapsed", Math.round((Date.now() - waitStart) / 1000) + "s");

  const msgs = await api("GET", `/api/rooms/${roomId}/messages`);
  const files = await api("GET", `/api/rooms/${roomId}/files`);
  const list = msgs.messages || [];
  log("messages:", list.length);
  for (const m of list) log(`  [${m.speaker}]`, String(m.content).replace(/\s+/g, " ").slice(0, 120));
  log("files:", JSON.stringify((files.files || []).map((f) => ({ id: f.file_id, path: f.path }))));

  const ok =
    done &&
    list.some((m) => m.speaker === "boss") &&
    list.some((m) => m.speaker === "coder") &&
    list.some((m) => m.speaker === "librarian")
  log(ok ? "RESULT: PASS" : "RESULT: FAIL");
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  log("ERROR:", err?.stack || err);
  process.exitCode = 1;
} finally {
  killTree();
  await new Promise((r) => setTimeout(r, 1200));
}
