import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  stableStringify,
  canonicalizeTools,
  computePrefixHash,
  buildStablePromptCacheKey,
  applyAnthropicCacheBreakpoints,
  optimizeProviderPayload,
  buildStableRoomAppendix,
  computeCacheHitRate,
} from "../src/engine/cache_optimizer.js";

import {
  resolveToolName,
  repairToolArguments,
  smartEditReplace,
  applySmartEdits,
  FileReadTracker,
  ToolLoopGuard,
  enrichToolError,
  enhanceSessionToolAccuracy,
} from "../src/engine/tool_accuracy.js";

import { PerfMonitor } from "../src/perf_monitor.js";
import { computeTurnTelemetry } from "../src/engine/telemetry.js";
import { createEngine } from "../src/engine/runtime.js";
import { BotRunner } from "../src/engine/bot.js";
import { buildBot } from "../src/engine/archetypes.js";
import { DirectChatManager } from "../src/dm/manager.js";

describe("Prompt Cache Optimizer (dsh Three Assembly Lines & OpenCode Breakpoints)", () => {
  it("canonicalizes tool order and nested JSON Schema keys for byte-identical prefix hashes", () => {
    const toolsA = [
      {
        type: "function",
        function: {
          name: "write",
          parameters: {
            type: "object",
            required: ["path", "content"],
            properties: {
              content: { type: "string", description: "Body" },
              path: { type: "string", description: "Path" },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "read",
          parameters: {
            properties: {
              limit: { type: "number" },
              path: { type: "string" },
            },
            type: "object",
          },
        },
      },
    ];

    const toolsB = [
      {
        type: "function",
        function: {
          name: "read",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              limit: { type: "number" },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "write",
          parameters: {
            properties: {
              path: { description: "Path", type: "string" },
              content: { description: "Body", type: "string" },
            },
            required: ["path", "content"],
            type: "object",
          },
        },
      },
    ];

    const canonA = canonicalizeTools(toolsA);
    const canonB = canonicalizeTools(toolsB);
    assert.deepEqual(canonA.map((t) => t.function.name), ["read", "write"]);
    assert.equal(stableStringify(canonA), stableStringify(canonB));

    const hashA = computePrefixHash({ system: "You are Coder.", tools: canonA });
    const hashB = computePrefixHash({ system: "You are Coder.", tools: canonB });
    assert.equal(hashA, hashB);
    assert.equal(hashA.length, 16);
  });

  it("injects deterministic prompt_cache_key on OpenAI payloads and detects mid-session cache busts", () => {
    const basePayload = {
      model: "auto/deepseek-v4.1-flash",
      messages: [
        { role: "system", content: "Static system prompt" },
        { role: "user", content: "Turn 1" },
      ],
      tools: [
        { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
        { type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } },
      ],
    };

    const r1 = optimizeProviderPayload(basePayload, {
      sessionKey: "dm:coder",
      modelId: "auto/deepseek-v4.1-flash",
    });
    assert.equal(r1.protocol, "openai");
    assert.equal(r1.prefixStable, true);
    assert.ok(r1.payload.prompt_cache_key.startsWith("af:dm:coder:"));
    assert.ok(r1.payload.prompt_cache_key.length <= 64);
    assert.deepEqual(r1.payload.tools.map((t) => t.function.name), ["bash", "read"]);

    // Turn 2 adds user message with same system & tools (in reversed order) -> MUST remain stable!
    const turn2Payload = {
      ...basePayload,
      messages: [
        ...basePayload.messages,
        { role: "assistant", content: "Done." },
        { role: "user", content: "Turn 2" },
      ],
      tools: [...basePayload.tools].reverse(),
    };
    const r2 = optimizeProviderPayload(turn2Payload, {
      sessionKey: "dm:coder",
      modelId: "auto/deepseek-v4.1-flash",
      prevPrefixHash: r1.prefixHash,
      prevSystemHash: r1.systemHash,
      prevToolsHash: r1.toolsHash,
    });
    assert.equal(r2.prefixStable, true);
    assert.equal(r2.prefixHash, r1.prefixHash);
    assert.equal(r2.payload.prompt_cache_key, r1.payload.prompt_cache_key);

    // Turn 3 mutates system prompt -> MUST detect cache bust with exact reason!
    const turn3Payload = {
      ...turn2Payload,
      messages: [
        { role: "system", content: "Static system prompt + volatile timestamp 12:34:56" },
        ...turn2Payload.messages.slice(1),
      ],
    };
    const r3 = optimizeProviderPayload(turn3Payload, {
      sessionKey: "dm:coder",
      modelId: "auto/deepseek-v4.1-flash",
      prevPrefixHash: r2.prefixHash,
      prevSystemHash: r2.systemHash,
      prevToolsHash: r2.toolsHash,
    });
    assert.equal(r3.prefixStable, false);
    assert.equal(r3.cacheBustReason, "system_prompt_changed");
  });

  it("places <= 4 rolling ephemeral cache_control breakpoints on Anthropic payloads and strips stale ones", () => {
    const payload = {
      model: "zcode/claude-sonnet-4",
      system: "Static persona",
      tools: [
        { name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
        { name: "edit", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "Turn 1", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "text", text: "Reply 1" }] },
        { role: "user", content: [{ type: "text", text: "Turn 2", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "text", text: "Reply 2" }] },
        { role: "user", content: "Turn 3" },
      ],
    };

    const opt = applyAnthropicCacheBreakpoints(payload, { retention: "long", supportsLongTtl: true });
    // Count total cache_control markers across system + tools + messages
    let count = 0;
    for (const blk of opt.system) if (blk.cache_control) count += 1;
    for (const tool of opt.tools) if (tool.cache_control) count += 1;
    for (const msg of opt.messages) {
      if (Array.isArray(msg.content)) {
        for (const blk of msg.content) if (blk.cache_control) count += 1;
      }
    }
    assert.equal(count, 4);
    // Stale marker on Turn 1 must be stripped; Turn 2 and Turn 3 must have markers
    assert.equal(opt.messages[0].content[0].cache_control, undefined);
    assert.deepEqual(opt.messages[2].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
    assert.deepEqual(opt.messages[4].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
    // System and last tool have markers
    assert.deepEqual(opt.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
    assert.equal(opt.tools[0].cache_control, undefined);
    assert.deepEqual(opt.tools[1].cache_control, { type: "ephemeral", ttl: "1h" });
  });

  it("produces static room appendix and accurate cache hit rate calculations", () => {
    const a1 = buildStableRoomAppendix({ roomId: "r1", roomTitle: "研发群", readOnly: false });
    const a2 = buildStableRoomAppendix({ roomId: "r1", roomTitle: "研发群", readOnly: false });
    assert.equal(a1, a2);
    assert.ok(a1.includes("r1"));
    assert.ok(!a1.includes("2026-"));

    const hit = computeCacheHitRate({ input: 200, cacheRead: 9800, cacheWrite: 0 });
    assert.equal(hit.hitRatePct, 98);
    assert.equal(hit.totalPromptTokens, 10000);

    const key = buildStablePromptCacheKey({ sessionKey: "room:r-1:coder", modelId: "auto/deepseek-v4.1-flash", prefixHash: "abcdef0123456789" });
    assert.ok(key.length <= 64);
    assert.match(key, /^[a-zA-Z0-9_:.-]+$/);
  });
});

describe("Tool Calling Accuracy — Name & Argument Repair (OpenCode)", () => {
  const active = ["read", "write", "edit", "bash", "grep", "find", "ls", "browser_open"];

  it("resolves cross-harness tool name aliases, namespaces, delimiters, and typos safely", () => {
    assert.deepEqual(resolveToolName("read", active), { name: "read", repaired: false, originalName: "read", strategy: null });
    assert.equal(resolveToolName("read_file", active).name, "read");
    assert.equal(resolveToolName("edit_file", active).name, "edit");
    assert.equal(resolveToolName("str_replace_editor", active).name, "edit");
    assert.equal(resolveToolName("run_command", active).name, "bash");
    assert.equal(resolveToolName("grep_search", active).name, "grep");
    assert.equal(resolveToolName("list_dir", active).name, "ls");
    assert.equal(resolveToolName("functions.read", active).name, "read");
    assert.equal(resolveToolName("Browser.Open", active).name, "browser_open");
    assert.equal(resolveToolName("baah", active).name, "bash");
    // Unregistered tool must not be blindly repaired to an unrelated tool
    const unknown = resolveToolName("completely_unknown_xyz", active);
    assert.equal(unknown.repaired, false);
    assert.equal(unknown.name, "completely_unknown_xyz");
  });

  it("repairs parameter aliases, legacy edit shape, JSON string args, and schema type drift", () => {
    // 1. Legacy single-edit + file_path + old_string/new_string
    const rEdit = repairToolArguments("edit", {
      file_path: "  src/app.js  ",
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });
    assert.equal(rEdit.repaired, true);
    assert.equal(rEdit.args.path, "src/app.js");
    assert.deepEqual(rEdit.args.edits, [{ oldText: "const a = 1;", newText: "const a = 2;" }]);

    // 2. JSON-stringified arguments + stringified integer offset/limit
    const readSchema = {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" },
        recursive: { type: "boolean" },
      },
    };
    const rRead = repairToolArguments(
      "read",
      JSON.stringify({ filePath: "README.md", start_line: "15", max_lines: "40", recursive: "true", extraNull: null }),
      readSchema,
    );
    assert.equal(rRead.repaired, true);
    assert.equal(rRead.args.path, "README.md");
    assert.equal(rRead.args.offset, 15);
    assert.equal(rRead.args.limit, 40);
    assert.equal(rRead.args.recursive, true);

    // 3. Bash cmd alias & ms-to-sec timeout normalization
    const rBash = repairToolArguments("bash", { cmd: "npm test", timeout_ms: 30000 });
    assert.equal(rBash.repaired, true);
    assert.equal(rBash.args.command, "npm test");
    assert.equal(rBash.args.timeout, 30);
  });
});

describe("OpenCode 6-Strategy Multi-Pass Fuzzy Edit Engine", () => {
  it("handles exact, line-trimmed, indentation-flexible, block-anchor, whitespace-normalized, and escape-normalized edits", () => {
    const sample = [
      "export function greet(name) {",
      "    const msg = `Hello, ${name}!`;",
      "    if (!name) {",
      "        return 'anonymous';",
      "    }",
      "    return msg;",
      "}",
    ].join("\n");

    // 1. Exact
    const r1 = smartEditReplace(sample, "return 'anonymous';", "return 'guest';");
    assert.equal(r1.ok, true);
    assert.equal(r1.strategy, "exact");
    assert.equal(r1.usedFuzzy, false);
    assert.ok(r1.content.includes("return 'guest';"));

    // 2. Indentation drift (model gives 2-space indent instead of 4-space) -> preserves file's 4-space indent!
    const r2 = smartEditReplace(
      sample,
      "  if (!name) {\n    return 'anonymous';\n  }",
      "  if (!name) {\n    return 'unknown';\n  }",
    );
    assert.equal(r2.ok, true);
    assert.equal(r2.usedFuzzy, true);
    assert.ok(r2.content.includes("    if (!name) {\n        return 'unknown';\n    }"));

    // 3. Block-anchor match (first + last line match, minor middle difference)
    const r3 = smartEditReplace(
      sample,
      "export function greet(name) {\n    const msg = `Hello, ${name}`;\n    if (!name) {\n        return 'anonymous';\n    }\n    return msg;\n}",
      "export function greet(name) {\n    return `Hi, ${name || 'guest'}!`;\n}",
    );
    assert.equal(r3.ok, true);
    assert.equal(r3.strategy, "block_anchor");
    assert.ok(r3.content.includes("Hi, ${name || 'guest'}!"));

    // 4. Whitespace-normalized match (extra internal spaces)
    const spaced = "const   total   =   a  +  b;\n";
    const r4 = smartEditReplace(spaced, "const total = a + b;", "const total = a * b;");
    assert.equal(r4.ok, true);
    assert.equal(r4.strategy, "whitespace_normalized");
    assert.equal(r4.content, "const total = a * b;\n");

    // 5. Escape-normalized match (over-escaped \\n)
    const r5 = smartEditReplace("line1\nline2\nline3\n", "line1\\nline2", "lineA\\nlineB");
    assert.equal(r5.ok, true);
    assert.equal(r5.strategy, "escape_normalized");
    assert.equal(r5.content, "lineA\nlineB\nline3\n");

    // 6. Preserves CRLF endings
    const crlf = "alpha\r\nbeta\r\ngamma\r\n";
    const r6 = smartEditReplace(crlf, "beta", "BETA");
    assert.equal(r6.ok, true);
    assert.equal(r6.content, "alpha\r\nBETA\r\ngamma\r\n");
  });

  it("refuses ambiguous multiple matches and provides actionable near-miss diagnostics on failure", () => {
    const dup = "const x = 1;\nfoo();\nconst x = 1;\nbar();\n";
    const multi = smartEditReplace(dup, "const x = 1;", "const x = 2;");
    assert.equal(multi.ok, false);
    assert.equal(multi.errorCode, "MULTIPLE_MATCHES");
    assert.deepEqual(multi.matchLines, [1, 3]);

    const fileText = [
      "function computeScore(items) {",
      "  let sum = 0;",
      "  for (const item of items) {",
      "    sum += item.weight * item.value;",
      "  }",
      "  return sum;",
      "}",
    ].join("\n");
    const miss = smartEditReplace(fileText, "function computeScore(items) {\n  return items.reduce((a, b) => a + b, 0);\n}", "x");
    assert.equal(miss.ok, false);
    assert.equal(miss.errorCode, "NOT_FOUND");
    assert.ok(Array.isArray(miss.nearMisses) && miss.nearMisses.length >= 1);
    assert.ok(miss.message.includes("L1-L"));
  });

  it("applies transactional multi-edits cleanly", () => {
    const src = "const a = 1;\nconst b = 2;\n";
    const batch = applySmartEdits(src, [
      { oldText: "const a = 1;", newText: "const a = 10;" },
      { oldText: "  const b = 2;", newText: "  const b = 20;" },
    ]);
    assert.equal(batch.ok, true);
    assert.equal(batch.fuzzyCount, 1);
    assert.equal(batch.content, "const a = 10;\nconst b = 20;\n");
  });
});

describe("Staleness Tracker, Doom-Loop Guard, Error Enricher & Live BotRunner + PerfMonitor", () => {
  it("detects external file modifications, blocks doom loops, and enriches ENOENT errors", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-acc-"));
    try {
      const f = path.join(tmpDir, "config.json");
      fs.writeFileSync(f, '{"v":1}\n', "utf8");

      const tracker = new FileReadTracker();
      tracker.record(f);
      assert.equal(tracker.checkBeforeEdit(f).stale, false);

      // External edit changes size
      fs.writeFileSync(f, '{"v":2,"extra":true}\n', "utf8");
      const stale = tracker.checkBeforeEdit(f);
      assert.equal(stale.stale, true);
      assert.ok(stale.reason.includes("config.json"));

      // Doom loop guard blocks 3rd consecutive identical call
      const guard = new ToolLoopGuard({ maxConsecutive: 3, maxRepeatedFailures: 2 });
      assert.equal(guard.check("read", { path: "a.js" }).blocked, false);
      guard.recordOutcome("read", { path: "a.js" }, true);
      assert.equal(guard.check("read", { path: "a.js" }).blocked, false);
      guard.recordOutcome("read", { path: "a.js" }, true);
      const third = guard.check("read", { path: "a.js" });
      assert.equal(third.blocked, true);
      assert.ok(third.reason.includes("<tool_recovery_hint>"));

      // Error enricher lists sibling files on ENOENT
      const enriched = enrichToolError({
        toolName: "read",
        args: { path: "confg.json" },
        errorText: "ENOENT: no such file or directory",
        cwd: tmpDir,
        activeTools: ["read", "edit"],
        fileTracker: tracker,
      });
      assert.ok(enriched.includes("config.json"));
      assert.ok(enriched.includes("<tool_recovery_hint>"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("enhances live BotRunner session edit tool with arg repair + fuzzy fallback and tracks optimization metrics in PerfMonitor", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "af-bot-acc-"));
    const prevDataRoot = process.env.FUSION_DATA_ROOT;
    try {
      const engine = await createEngine({ skipGateway: true });
      const bot = buildBot("coder");
      const runner = new BotRunner({ bot, engine, cwd: tmpRoot, roomContext: { roomId: "r-opt", roomTitle: "优化室" } });
      const session = await runner.ensureSession();

      // Verify static room appendix (no mutable files/timestamps)
      assert.ok(session.systemPrompt.includes("r-opt"));

      // Verify edit tool has wrapped prepareArguments & fuzzy execute recovery
      const targetFile = path.join(tmpRoot, "demo.js");
      fs.writeFileSync(targetFile, "function run() {\n    const mode = 'slow';\n    return mode;\n}\n", "utf8");

      const editTool = session.agent.state.tools.find((t) => t.name === "edit");
      assert.ok(editTool, "edit tool should exist");

      const repaired = editTool.prepareArguments({
        file_path: "demo.js",
        old_string: "  const mode = 'slow';\n  return mode;",
        new_string: "  const mode = 'fast';\n  return mode;",
      });
      assert.equal(repaired.path, "demo.js");
      assert.ok(Array.isArray(repaired.edits));

      const execRes = await editTool.execute("tc-1", repaired, undefined, undefined, {});
      assert.ok(execRes?.content?.[0]?.text);
      const after = fs.readFileSync(targetFile, "utf8");
      assert.ok(after.includes("    const mode = 'fast';"));

      runner.dispose();
    } finally {
      if (prevDataRoot !== undefined) process.env.FUSION_DATA_ROOT = prevDataRoot;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    // Verify PerfMonitor optimization snapshot + computeTurnTelemetry cache_hit_rate
    const tel = computeTurnTelemetry({
      startedAt: 1000,
      firstTokenAt: 1200,
      endedAt: 2200,
      usage: { input: 500, output: 100, cacheRead: 9500, cacheWrite: 0 },
    });
    assert.equal(tel.cache_hit_rate, 95);

    const pm = new PerfMonitor({ intervalMs: 2000 });
    pm.recordTurnTelemetry({ tps: 50, ttft_ms: 180, input_tokens: 500, output_tokens: 100, cache_read_tokens: 9500, cache_write_tokens: 0 });
    pm.recordCacheCheck({ prefixStable: true });
    pm.recordCacheCheck({ prefixStable: true });
    pm.recordToolMetric({ type: "arg_repaired" });
    pm.recordToolMetric({ type: "fuzzy_edit", fuzzyCount: 1 });
    pm.recordToolMetric({ type: "loop_prevented" });
    pm.recordToolMetric({ type: "tool_result", ok: true });
    pm.recordToolMetric({ type: "tool_result", ok: true });
    pm.recordToolMetric({ type: "tool_result", ok: false });

    const snap = pm.snapshot();
    assert.equal(snap.optimization.cache_hit_rate_pct, 95);
    assert.equal(snap.optimization.prefix_stability_pct, 100);
    assert.equal(snap.optimization.prefix_requests, 2);
    assert.equal(snap.optimization.tool_accuracy_pct, 66.7);
    assert.equal(snap.optimization.tool_calls_repaired, 1);
    assert.equal(snap.optimization.edit_fuzzy_hits, 1);
    assert.equal(snap.optimization.doom_loops_prevented, 1);
    pm.dispose();
  });

  it("emits DM project header only on first turn or project change (dsh delta runtime facts)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-dm-delta-"));
    try {
      const dm = new DirectChatManager({});
      const proj = { id: "p1", name: "MyApp", root_path: tmpDir };
      // Simulate ready runner on turn 2
      dm._runners.set("coder", { isReady: true });

      const p1 = dm._buildPrompt("coder", "First message", proj);
      assert.ok(p1.includes("当前绑定的项目工作目录"));

      const p2 = dm._buildPrompt("coder", "Second message", proj);
      assert.ok(!p2.includes("当前绑定的项目工作目录"), "second turn with unchanged project should omit redundant header");
      assert.ok(p2.includes("Second message"));

      const proj2 = { id: "p2", name: "OtherApp", root_path: tmpDir };
      const p3 = dm._buildPrompt("coder", "Third message", proj2);
      assert.ok(p3.includes("OtherApp"), "project switch should re-emit updated delta header");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
