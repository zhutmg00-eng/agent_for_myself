import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PerfMonitor } from "../src/perf_monitor.js";
import {
  validateProjectDir,
  browseDirectory,
  listProjectTree,
  readProjectFilePreview,
  resolveInsideProject,
  detectGitBranch,
} from "../src/projects.js";
import { Store } from "../src/store.js";
import { DirectChatManager } from "../src/dm/manager.js";
import { isInsideWorkspace, setExtraWorkspaceRoots, createApproval } from "../src/approval.js";
import { startServer } from "../src/api/server.js";

describe("PerfMonitor — Real-time Memory & Token Speed Telemetry", () => {
  it("samples system memory %, RSS, heap, and caps history ring buffer", () => {
    let clock = 1_700_000_000_000;
    const monitor = new PerfMonitor({
      intervalMs: 1000,
      maxHistory: 10,
      now: () => clock,
      readSystem: () => ({
        totalMem: 16 * 1024 ** 3,
        freeMem: 4 * 1024 ** 3,
        rss: 128 * 1024 ** 2,
        heapUsed: 40 * 1024 ** 2,
        heapTotal: 80 * 1024 ** 2,
        load1m: 1.25,
        cpuCount: 8,
      }),
    });

    assert.equal(monitor.history.length, 1);
    assert.equal(monitor.history[0].mem_pct, 75);
    assert.equal(monitor.history[0].proc_rss_mb, 128);
    assert.equal(monitor.history[0].heap_pct, 50);

    for (let i = 0; i < 15; i += 1) {
      clock += 2000;
      monitor.sampleNow();
    }
    assert.equal(monitor.history.length, 10);

    const snap = monitor.snapshot({ uptimeMs: 12345 });
    assert.equal(snap.history.length, 10);
    assert.equal(snap.current.mem_pct, 75);
    assert.equal(snap.system.cpu_count, 8);
    assert.equal(snap.system.uptime_ms, 12345);
  });

  it("tracks streaming token speed (TPS) and completed turn telemetry", () => {
    let clock = 1_700_000_000_000;
    const monitor = new PerfMonitor({
      intervalMs: 2000,
      now: () => clock,
      readSystem: () => ({
        totalMem: 8 * 1024 ** 3,
        freeMem: 4 * 1024 ** 3,
        rss: 64 * 1024 ** 2,
        heapUsed: 20 * 1024 ** 2,
        heapTotal: 40 * 1024 ** 2,
        load1m: 0.5,
        cpuCount: 4,
      }),
    });

    monitor.beginTurn();
    monitor.recordStreamTokens(40);
    clock += 2000;
    monitor.recordStreamTokens(60);
    const liveTps = monitor.currentTps();
    assert.ok(liveTps >= 45 && liveTps <= 55, `Expected ~50 tok/s, got ${liveTps}`);

    monitor.recordTurnTelemetry({
      tps: 64.5,
      ttft_ms: 420,
      input_tokens: 300,
      output_tokens: 129,
      bot_id: "coder",
    });
    monitor.endTurn();

    clock += 11_000; // stream buckets expire, falls back to 15s hold of lastTurnTps
    const heldTps = monitor.currentTps();
    assert.equal(heldTps, 64.5);

    const snap = monitor.snapshot();
    assert.equal(snap.summary.avg_tps, 64.5);
    assert.equal(snap.summary.peak_tps, 64.5);
    assert.equal(snap.summary.avg_ttft_ms, 420);
    assert.equal(snap.summary.total_tokens, 429);
    assert.equal(snap.summary.total_turns, 1);
    assert.equal(snap.summary.active_turns, 0);
  });
});

describe("Projects — Directory Binding, Tree, Preview & Workspace Approval", () => {
  let tmpRoot;
  let projDir;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "af-proj-test-"));
    projDir = path.join(tmpRoot, "demo-app");
    fs.mkdirSync(path.join(projDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(projDir, "node_modules", "ignored-pkg"), { recursive: true });
    fs.mkdirSync(path.join(projDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(projDir, ".git", "HEAD"), "ref: refs/heads/feat/agent-harness\n");
    fs.writeFileSync(path.join(projDir, "README.md"), "# Demo App\nHello AgentFusion.\n");
    fs.writeFileSync(path.join(projDir, "src", "index.js"), "export const ok = true;\n");
  });

  after(() => {
    setExtraWorkspaceRoots([]);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("validates, creates missing directories, detects git branch, and lists/previews files safely", () => {
    const newDir = path.join(tmpRoot, "auto-created");
    const validated = validateProjectDir(newDir, { createIfMissing: true });
    assert.equal(validated.root_path, path.resolve(newDir));
    assert.equal(fs.existsSync(newDir), true);

    assert.equal(detectGitBranch(projDir), "feat/agent-harness");

    const browsed = browseDirectory(tmpRoot);
    assert.ok(browsed.entries.some((d) => d.name === "demo-app" && d.is_dir === true));

    const tree = listProjectTree(projDir);
    assert.equal(tree.git_branch, "feat/agent-harness");
    const names = tree.entries.map((e) => e.name);
    assert.ok(names.includes("src"));
    assert.ok(names.includes("README.md"));
    assert.ok(!names.includes("node_modules"), "node_modules should be filtered out");
    assert.ok(!names.includes(".git"), ".git should be filtered out");

    const preview = readProjectFilePreview(projDir, "src/index.js");
    assert.equal(preview.binary, false);
    assert.match(preview.content, /export const ok = true/);

    assert.throws(
      () => resolveInsideProject(projDir, "../../etc/passwd"),
      (err) => err.status === 403,
    );
  });

  it("persists projects in SQLite store and integrates registered roots into approval.js", () => {
    const dbPath = path.join(tmpRoot, "store.sqlite");
    const store = new Store(dbPath);
    try {
      const p1 = store.createProject({ name: "Demo App", root_path: projDir, description: "test repo" });
      const p2 = store.createProject({ name: "Second", root_path: tmpRoot });
      assert.equal(store.listProjects().length, 2);

      store.setActiveProjectId(p1.id);
      assert.equal(store.getActiveProjectId(), p1.id);

      setExtraWorkspaceRoots([p1.root_path]);
      assert.equal(isInsideWorkspace(path.join(projDir, "src", "index.js")), true);

      const approval = createApproval({ store });
      approval.setMode("smart");
      const smartAllow = approval.evaluate({ tool: "write", input: { path: path.join(projDir, "src", "new.js") } });
      assert.equal(smartAllow.decision, "allow");

      const cDriveDeny = approval.evaluate({ tool: "write", input: { path: "C:\\Windows\\System32\\bad.txt" } });
      assert.equal(cDriveDeny.decision, "deny");

      store.deleteProject(p1.id);
      assert.equal(store.getActiveProjectId(), p2.id);
    } finally {
      store.close();
    }
  });
});

describe("DirectChatManager — 1v1 Private Chat, Project CWD & Telemetry", () => {
  let tmpRoot;
  let projA;
  let projB;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "af-dm-test-"));
    projA = path.join(tmpRoot, "proj-a");
    projB = path.join(tmpRoot, "proj-b");
    fs.mkdirSync(projA, { recursive: true });
    fs.mkdirSync(projB, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("persists DM messages, switches runner cwd on project change, emits SSE events, and records PerfMonitor telemetry", async () => {
    const store = new Store(path.join(tmpRoot, "dm.sqlite"));
    const pA = store.createProject({ name: "Proj A", root_path: projA });
    const pB = store.createProject({ name: "Proj B", root_path: projB });
    store.setActiveProjectId(pA.id);

    const published = [];
    const events = {
      async publish(evt) {
        published.push(evt);
        return evt;
      },
    };
    const perfMonitor = new PerfMonitor({ intervalMs: 2000 });
    const createdRunners = [];

    const dm = new DirectChatManager({
      store,
      events,
      engine: { defaultModelId: "test-model" },
      perfMonitor,
      runnerFactory(opts) {
        const fake = {
          _cwdOverride: opts.cwd || null,
          isReady: false,
          disposed: false,
          setCwd(next) { this._cwdOverride = next; },
          async run({ prompt, onToolEvent }) {
            this.isReady = true;
            onToolEvent?.({ type: "delta", delta: "已完成分析 " });
            onToolEvent?.({ type: "tool", toolCallId: "c1", tool: "read", args: { path: "README.md" } });
            onToolEvent?.({ type: "tool_result", toolCallId: "c1", tool: "read", error: false, ms: 12 });
            return {
              text: `已检查目录 ${this._cwdOverride}`,
              toolResults: [{ tool: "read", summary: "ok" }],
              usage: { input: 120, output: 45 },
              telemetry: { tps: 52.4, ttft_ms: 310 },
            };
          },
          dispose() { this.disposed = true; },
        };
        createdRunners.push(fake);
        return fake;
      },
    });

    try {
      const reply = await dm.say("coder", "检查下目录", { wait: true });
      assert.match(reply.content, new RegExp(projA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(createdRunners.length, 1);
      assert.equal(createdRunners[0]._cwdOverride, projA);

      const msgs = dm.getMessages("coder");
      assert.equal(msgs.length, 2);
      assert.equal(msgs[0].speaker, "user");
      assert.equal(msgs[1].speaker, "coder");
      assert.equal(msgs[1].tools.length, 1);
      assert.equal(msgs[1].telemetry.tps, 52.4);

      const topics = published.map((e) => e.topic);
      assert.ok(topics.includes("dm.coder.user_message"));
      assert.ok(topics.includes("dm.coder.turn_started"));
      assert.ok(topics.includes("dm.coder.delta"));
      assert.ok(topics.includes("dm.coder.turn_completed"));

      assert.equal(perfMonitor.snapshot().summary.avg_tps, 52.4);

      dm.setProject("coder", pB.id);
      assert.equal(createdRunners[0]._cwdOverride, projB);

      dm.clear("coder");
      assert.equal(dm.getMessages("coder").length, 0);
      assert.equal(createdRunners[0].disposed, true);
    } finally {
      dm.dispose();
      perfMonitor.dispose();
      store.close();
    }
  });
});

describe("HTTP API — /api/perf, /api/projects, /api/fs/browse, /api/dms", () => {
  let srv;
  let baseUrl;
  let tmpProj;

  before(async () => {
    tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "af-http-proj-"));
    fs.writeFileSync(path.join(tmpProj, "hello.txt"), "hello world\n");
    srv = await startServer({ port: 0, host: "127.0.0.1" });
    const addr = srv.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : srv.port}`;
  });

  after(async () => {
    if (srv) await srv.close();
    fs.rmSync(tmpProj, { recursive: true, force: true });
  });

  it("serves real-time perf telemetry, project CRUD/tree/file, fs browse, and DM endpoints", async () => {
    const perfRes = await fetch(`${baseUrl}/api/perf`);
    assert.equal(perfRes.status, 200);
    const perf = await perfRes.json();
    assert.equal(typeof perf.current.mem_pct, "number");
    assert.ok(Array.isArray(perf.history) && perf.history.length >= 1);
    assert.equal(typeof perf.summary.avg_tps, "number");

    const browseRes = await fetch(`${baseUrl}/api/fs/browse?path=${encodeURIComponent(tmpProj)}`);
    assert.equal(browseRes.status, 200);
    const browse = await browseRes.json();
    assert.equal(browse.current, path.resolve(tmpProj));

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "HTTP Test Repo", root_path: tmpProj, activate: false }),
    });
    assert.equal(createRes.status, 201);
    const { project } = await createRes.json();
    assert.ok(project.id);

    const treeRes = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}/tree`);
    assert.equal(treeRes.status, 200);
    const tree = await treeRes.json();
    assert.ok(tree.entries.some((e) => e.name === "hello.txt"));

    const fileRes = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}/file?path=hello.txt`);
    assert.equal(fileRes.status, 200);
    const file = await fileRes.json();
    assert.match(file.content, /hello world/);

    const escRes = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}/file?path=../../etc/passwd`);
    assert.equal(escRes.status, 403);

    const dmListRes = await fetch(`${baseUrl}/api/dms`);
    assert.equal(dmListRes.status, 200);
    const dmList = await dmListRes.json();
    assert.ok(Array.isArray(dmList.dms));

    const dmSetRes = await fetch(`${baseUrl}/api/dm/coder`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: project.id }),
    });
    assert.equal(dmSetRes.status, 200);
    const dmSet = await dmSetRes.json();
    assert.equal(dmSet.project_id, project.id);

    // Clean up project & DM binding
    await fetch(`${baseUrl}/api/dm/coder`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: null }),
    });
    const delRes = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
  });
});
