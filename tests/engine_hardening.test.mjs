/**
 * Milestone 4 Engine Hardening Tests (node:test)
 *
 * Verifies Features 17, 18, 19, and 20:
 * 1. Watchdog Timeout & AbortSignal (two-layer defense, precedence hierarchy, manual abort)
 * 2. Dynamic Relay Limit & Forward Progress Guard (progress tiers, loop detection, chatter cap, multi-stage re-entry)
 * 3. Tool Output Clamp (head/tail preservation, spillover file on non-C drive, newline alignment)
 * 4. Telemetry Metrics & Aggregation (TTFT, TPS, E2E TPS, SQLite persistence and summary)
 */
import { TEST_DATA_ROOT, onCleanup } from "./_helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store, defaultPermissions } from "../src/store.js";
import { EventBus } from "../src/events.js";
import {
  Room,
  DEFAULT_TURN_TIMEOUT_MS,
  resolveTurnTimeoutMs,
  evalForwardProgress,
  detectInfiniteLoop,
} from "../src/rooms/room.js";
import { clampToolOutput } from "../src/engine/clamp.js";
import { computeTurnTelemetry } from "../src/engine/telemetry.js";
import { DIRS, assertNotC } from "../src/config.js";

const ROOM_ID = "m4_test_room";

function nowIso() {
  return new Date().toISOString();
}

async function makeRoom({
  name = "m4_hardening",
  members = ["boss", "coder", "reviewer"],
  owner = "boss",
  policy = "shared",
  permissions = {},
  roomSettings = {},
} = {}) {
  const dbPath = path.join(TEST_DATA_ROOT, "data", `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`);
  const store = new Store(dbPath);
  onCleanup(() => store.close());
  const events = new EventBus(store);
  const seen = [];
  const off = events.subscribe((evt) => seen.push(evt));
  onCleanup(off);

  const record = {
    room_id: ROOM_ID,
    title: "M4 Hardening Test Room",
    owner_id: owner,
    parent_room_id: null,
    topic: "Engine hardening",
    context_policy: policy,
    status: "active",
    settings: roomSettings,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  store.upsertRoom(record);
  store.setRoomMembers(
    ROOM_ID,
    members.map((id) => ({
      bot_id: id,
      permissions: defaultPermissions({
        can_create_subgroup: id === owner,
        ...(permissions[id] || {}),
      }),
    })),
  );

  const room = new Room({
    record,
    store,
    events,
    engine: null,
    hooks: null,
    skills: null,
    archetypes: null,
    manager: null,
  });
  await room.loadMembers();
  return { room, store, events, seen };
}

function eventsOf(seen, kind) {
  return seen.filter((e) => e.topic === `room.${ROOM_ID}.${kind}`);
}

function payloads(seen, kind) {
  return eventsOf(seen, kind).map((e) => e.payload);
}

// ---------------------------------------------------------------------------
// 1. Feature 17: Watchdog Timeout & AbortSignal Tests
// ---------------------------------------------------------------------------

test("Feature 17: resolveTurnTimeoutMs respects 5-tier precedence hierarchy", () => {
  const dummyRoom = {
    settings: { turn_timeout_ms: 15_000 },
    _memberPermissions: new Map([
      ["fast_bot", { turn_timeout_ms: 8_000 }],
      ["normal_bot", {}],
    ]),
  };

  // Tier 1: explicit turnOptions.timeoutMs
  const t1 = resolveTurnTimeoutMs(dummyRoom, "fast_bot", { timeoutMs: 2_500 });
  assert.equal(t1, 2_500, "Tier 1: turnOptions.timeoutMs overrides everything");

  // Tier 2: member permission turn_timeout_ms
  const t2 = resolveTurnTimeoutMs(dummyRoom, "fast_bot", {});
  assert.equal(t2, 8_000, "Tier 2: member permission overrides room settings and defaults");

  // Tier 3: room settings turn_timeout_ms
  const t3 = resolveTurnTimeoutMs(dummyRoom, "normal_bot", {});
  assert.equal(t3, 15_000, "Tier 3: room settings overrides env and defaults");

  // Tier 4: process.env.AGENT_TURN_TIMEOUT_MS when room settings not set
  const origEnv = process.env.AGENT_TURN_TIMEOUT_MS;
  try {
    process.env.AGENT_TURN_TIMEOUT_MS = "12000";
    const roomWithoutSettings = {
      settings: {},
      _memberPermissions: new Map([["bot", {}]]),
    };
    const t4 = resolveTurnTimeoutMs(roomWithoutSettings, "bot", {});
    assert.equal(t4, 12_000, "Tier 4: AGENT_TURN_TIMEOUT_MS applies when room settings absent");
  } finally {
    if (origEnv !== undefined) {
      process.env.AGENT_TURN_TIMEOUT_MS = origEnv;
    } else {
      delete process.env.AGENT_TURN_TIMEOUT_MS;
    }
  }

  // Tier 5: default DEFAULT_TURN_TIMEOUT_MS (30,000ms)
  const roomEmpty = { settings: {}, _memberPermissions: new Map() };
  const t5 = resolveTurnTimeoutMs(roomEmpty, "bot", {});
  assert.equal(t5, DEFAULT_TURN_TIMEOUT_MS, "Tier 5: fallback to DEFAULT_TURN_TIMEOUT_MS");
  assert.equal(DEFAULT_TURN_TIMEOUT_MS, 30_000);
});

test("Feature 17: Watchdog timeout triggers AbortSignal and breaks hung runner within deadline without deadlocking queue", async () => {
  const { room, seen } = await makeRoom({
    name: "watchdog_timeout",
    members: ["boss", "slow_coder"],
    permissions: {
      slow_coder: { turn_timeout_ms: 60 }, // 60ms timeout
    },
  });

  let signalReceivedAbort = false;
  let abortReason = null;

  room.runnerFor = (botId) => {
    return {
      run: async ({ signal } = {}) => {
        if (botId === "slow_coder") {
          return new Promise((resolve, reject) => {
            if (signal) {
              signal.addEventListener("abort", () => {
                signalReceivedAbort = true;
                abortReason = signal.reason;
                const err = new Error(signal.reason || "aborted");
                err.name = "AbortError";
                reject(err);
              });
            }
            // Intentionally don't resolve to simulate hang
          });
        }
        return { text: "boss ready", usage: { input_tokens: 5, output_tokens: 5 }, ms: 5, toolsUsed: [] };
      },
      dispose() {},
    };
  };

  const start = Date.now();
  // Call say which triggers round
  await room.say({
    sender: "boss",
    content: "@slow_coder please work on this",
    speaker: "boss",
  });
  await room._queue;
  const elapsed = Date.now() - start;

  assert.ok(signalReceivedAbort, "AbortSignal should have fired");
  assert.match(String(abortReason), /Watchdog timeout after 60ms/);
  // Should complete swiftly, around timeoutMs + graceMs (< 500ms), not hanging forever
  assert.ok(elapsed < 2000, `Expected round to finish promptly, took ${elapsed}ms`);

  // Verify events emitted
  const timeoutEvents = payloads(seen, "turn_timeout");
  assert.equal(timeoutEvents.length, 1, "turn_timeout event should be emitted");
  assert.equal(timeoutEvents[0].bot_id, "slow_coder");
  assert.equal(timeoutEvents[0].timeout_ms, 60);

  const errorEvents = payloads(seen, "member_error");
  assert.ok(errorEvents.length >= 1, "member_error event should be emitted");
  assert.equal(errorEvents[0].bot_id, "slow_coder");

  // Verify queue is NOT deadlocked: next turn can execute normally
  let secondTurnExecuted = false;
  room.runnerFor = () => ({
    run: async () => {
      secondTurnExecuted = true;
      return { text: "recovered nicely", usage: { input_tokens: 5, output_tokens: 5 }, ms: 5, toolsUsed: [] };
    },
    dispose() {},
  });

  await room.say({
    sender: "boss",
    content: "are you alive?",
    speaker: "boss",
  });
  await room._queue;
  assert.ok(secondTurnExecuted, "Queue must remain operational after watchdog timeout");
});

test("Feature 17: Watchdog hard cutoff breaks runner that ignores AbortSignal", async () => {
  const { room, seen } = await makeRoom({
    name: "watchdog_hard_cutoff",
    members: ["boss", "stubborn_bot"],
    permissions: {
      stubborn_bot: { turn_timeout_ms: 50 },
    },
  });

  room.runnerFor = (botId) => {
    return {
      run: async () => {
        if (botId === "stubborn_bot") {
          // Completely ignore signal, simulate uncooperative hang
          return new Promise(() => {});
        }
        return { text: "boss ready", usage: { input_tokens: 5, output_tokens: 5 }, ms: 5, toolsUsed: [] };
      },
      dispose() {},
    };
  };

  const start = Date.now();
  await room.say({
    sender: "boss",
    content: "@stubborn_bot run uncooperative task",
    speaker: "boss",
  });
  await room._queue;
  const elapsed = Date.now() - start;

  // The 2-layer defense Promise.race hard cutoff triggers after timeoutMs + 100ms
  assert.ok(elapsed < 1500, `Expected hard cutoff race to resolve under 1500ms, took ${elapsed}ms`);
  const timeouts = payloads(seen, "turn_timeout");
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].bot_id, "stubborn_bot");
});

test("Feature 17: abortRound() and cancelActiveTurn() cancels active turn immediately", async () => {
  const { room, seen } = await makeRoom({
    name: "manual_abort",
    members: ["boss", "worker"],
  });

  let aborted = false;
  room.runnerFor = (botId) => ({
    run: async ({ signal } = {}) => {
      if (botId === "worker") {
        return new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            const err = new Error(signal.reason || "user_aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      return { text: "boss ready", usage: { input_tokens: 5, output_tokens: 5 }, ms: 5, toolsUsed: [] };
    },
    dispose() {},
  });

  const sayPromise = room.say({
    sender: "boss",
    content: "@worker start long job",
    speaker: "boss",
  });

  // Give runner a brief tick to start
  await new Promise((r) => setTimeout(r, 20));

  // Cancel via room.abortRound
  assert.ok(room._activeTurnController !== null, "Active turn controller should exist");
  room.abortRound("user_canceled");

  await sayPromise;
  await room._queue;
  assert.ok(aborted, "Runner AbortSignal must have triggered on manual abortRound");
  assert.equal(room._activeTurnController, null, "Active turn controller should be cleared");
});

// ---------------------------------------------------------------------------
// 2. Feature 18: Dynamic Relay Limit & Forward Progress Guard Tests
// ---------------------------------------------------------------------------

test("Feature 18: evalForwardProgress classifies tiers correctly", () => {
  // Tier 1: Mutating tools -> grant: 2, resetStagnant: true
  const tier1Mutating = evalForwardProgress({
    text: "Updated file",
    toolsUsed: ["write_file", "read_file"],
  });
  assert.equal(tier1Mutating.tier, 1);
  assert.equal(tier1Mutating.grant, 2);
  assert.equal(tier1Mutating.resetStagnant, true);

  // Tier 2: Observational tools -> grant: 1, resetStagnant: true
  const tier2Observational = evalForwardProgress({
    text: "Found items",
    toolsUsed: ["grep_search"],
  });
  assert.equal(tier2Observational.tier, 2);
  assert.equal(tier2Observational.grant, 1);
  assert.equal(tier2Observational.resetStagnant, true);

  // Tier 3: Substantial structured text (>= 150 chars with headers/lists) -> grant: 1, resetStagnant: true
  const substantialText = `### Task Analysis & Architecture Plan
1. First, we need to inspect the existing execution engine.
2. Next, we verify that the watchdog abort signals are propagated.
3. Finally, we run the comprehensive test suite to confirm zero regressions.`;
  assert.ok(substantialText.length >= 150);
  const tier3Text = evalForwardProgress({
    text: substantialText,
    toolsUsed: [],
  });
  assert.equal(tier3Text.tier, 3);
  assert.equal(tier3Text.grant, 1);
  assert.equal(tier3Text.resetStagnant, true);

  // Tier 0: Chatter / trivial text (< 120 chars) -> grant: 0, resetStagnant: false
  const chatter1 = evalForwardProgress({
    text: "好的，我看一下这个任务，马上处理。",
    toolsUsed: [],
  });
  assert.equal(chatter1.tier, 0);
  assert.equal(chatter1.grant, 0);
  assert.equal(chatter1.resetStagnant, false);

  // Tier 0: Tool failure -> grant: 0, resetStagnant: false
  const toolFailure = evalForwardProgress({
    text: "Tool failure: file not found",
    toolsUsed: ["read_file"],
    toolResults: [{ error: "not found" }],
  });
  assert.equal(toolFailure.tier, 0);
  assert.equal(toolFailure.grant, 0);
  assert.equal(toolFailure.resetStagnant, false);
});

test("Feature 18: extendRelayLimit grants additional turns up to max_relay_ceiling", async () => {
  const { room, seen } = await makeRoom({
    name: "relay_extend",
    members: ["boss", "worker"],
  });

  room.base_relay_limit = 4;
  room.relay_limit = 4;
  room.max_relay_ceiling = 8;

  // Extend by 2
  const granted1 = await room.extendRelayLimit(2, "mutating_tools:write_file");
  assert.equal(granted1, 2);
  assert.equal(room.relay_limit, 6);

  // Extend by 3 (should be clamped to ceiling 8)
  const granted2 = await room.extendRelayLimit(3, "substantial_output");
  assert.equal(granted2, 2, "Should only grant up to ceiling 8");
  assert.equal(room.relay_limit, 8);

  // Further extensions should grant 0
  const granted3 = await room.extendRelayLimit(2, "more_work");
  assert.equal(granted3, 0);
  assert.equal(room.relay_limit, 8);

  const extensions = payloads(seen, "relay_extended");
  assert.equal(extensions.length, 2);
  assert.equal(extensions[0].old_limit, 4);
  assert.equal(extensions[0].new_limit, 6);
  assert.equal(extensions[1].old_limit, 6);
  assert.equal(extensions[1].new_limit, 8);
});

test("Feature 18: Stagnant chatter trips chatter cap without extending relay limit", async () => {
  const { room, seen } = await makeRoom({
    name: "chatter_limit",
    members: ["boss", "bot1", "bot2"],
  });

  room.max_chatter_relays = 3;
  let turnsRun = 0;

  // Runners produce short non-productive chatter
  room.runnerFor = (botId) => ({
    run: async () => {
      turnsRun++;
      const msgs = [
        "好的，我收到了",
        "收到，请指示下一步",
        "我也明白了，随时待命",
        "继续等待命令",
      ];
      return {
        text: msgs[turnsRun % msgs.length],
        usage: { input_tokens: 5, output_tokens: 5 },
        ms: 5,
        toolsUsed: [],
      };
    },
    dispose() {},
  });

  await room.say({
    sender: "boss",
    content: "@bot1 @bot2 start discussing",
    speaker: "boss",
  });
  await room._queue;

  // Should have tripped after max_chatter_relays stagnant turns
  const trippedEvents = payloads(seen, "chatter_limit_tripped");
  assert.equal(trippedEvents.length, 1, "chatter_limit_tripped should be emitted");
  assert.equal(trippedEvents[0].stagnant_turns, 3);
  assert.equal(room.relay_limit, room.base_relay_limit, "Relay limit should not have been extended");
});

test("Feature 18: detectInfiniteLoop catches tool failure loops and ping-pong chatter", async () => {
  const dummyCtx = {
    _round_tool_history: [
      { bot: "bot1", tool: "read_file", args: '{"path":"foo.txt"}', ok: false },
      { bot: "bot1", tool: "read_file", args: '{"path":"foo.txt"}', ok: false },
    ],
    _round_turn_fingerprints: [],
  };

  // Tool failure loop detected
  const loop1 = detectInfiniteLoop(
    { bot: "bot1", tool: "read_file", args: '{"path":"foo.txt"}', ok: false },
    dummyCtx
  );
  assert.ok(loop1.detected);
  assert.equal(loop1.type, "tool_failure_loop");

  // Ping-pong chatter loop detected
  const pingPongCtx = {
    _round_tool_history: [],
    _round_turn_fingerprints: [
      { bot: "bot1", fp: "ok1", hasTools: false },
      { bot: "bot2", fp: "ok2", hasTools: false },
      { bot: "bot1", fp: "ok1", hasTools: false },
    ],
  };
  const loop2 = detectInfiniteLoop(
    { bot: "bot2", fp: "ok2", hasTools: false },
    pingPongCtx
  );
  assert.ok(loop2.detected);
  assert.equal(loop2.type, "ping_pong_chatter");
});

test("Feature 18: Multi-stage task-unit re-entry allows bot to be called for dependent tasks in same round", async () => {
  const { room } = await makeRoom({
    name: "multi_stage_reentry",
    members: ["boss", "coder", "reviewer"],
  });

  // Assign a 3-step DAG plan:
  // step1: coder
  // step2: reviewer (depends on step1)
  // step3: coder (depends on step2) -- coder must re-enter in the same round!
  await room.assignTask("coder", "Write code", { id: "step1" });
  await room.assignTask("reviewer", "Review code", { id: "step2", dependsOn: ["step1"] });
  await room.assignTask("coder", "Fix review issues", { id: "step3", dependsOn: ["step2"] });

  const executionLog = [];
  room.runnerFor = (botId) => ({
    run: async ({ prompt }) => {
      executionLog.push({ botId, prompt: prompt.slice(0, 30) });
      return {
        text: `### Finished task for ${botId}\n- Completed successfully with real progress.`,
        usage: { input_tokens: 10, output_tokens: 20 },
        ms: 10,
        toolsUsed: ["write_file"],
      };
    },
    dispose() {},
  });

  await room.runRound({ instruction: "Start plan execution now" });

  // Coder should run step1, reviewer run step2, coder run step3 in order
  assert.deepEqual(
    executionLog.map((e) => e.botId),
    ["coder", "reviewer", "coder"],
    "Coder should execute step1, reviewer step2, and coder re-enter for step3"
  );
});

test("Feature 18: Tripping turn preserves assistant message and emits turn_completed", async () => {
  const { room, seen } = await makeRoom({
    name: "tripping_turn",
    members: ["boss", "worker"],
  });

  room.base_relay_limit = 1;
  room.relay_limit = 1;

  room.runnerFor = () => ({
    run: async () => ({
      text: "Final substantive conclusion before limit reached",
      usage: { input_tokens: 10, output_tokens: 15 },
      ms: 10,
      toolsUsed: [],
    }),
    dispose() {},
  });

  await room.say({
    sender: "boss",
    content: "@worker one question",
    speaker: "boss",
  });
  await room._queue;

  // Assistant turn_completed must be emitted
  const completedEvents = payloads(seen, "turn_completed");
  const assistantTurn = completedEvents.find((e) => e.bot_id === "worker" || (e.speaker === "worker" && e.bot_id));
  assert.ok(assistantTurn, "Assistant turn_completed should be emitted for tripping turn");
  assert.equal(assistantTurn.bot_id, "worker");

  // Message log must contain worker's response
  const messages = room.message_log;
  const workerMsg = messages.find((m) => m.speaker === "worker");
  assert.ok(workerMsg, "Worker message should be preserved in message log");
  assert.equal(workerMsg.content, "Final substantive conclusion before limit reached");
});

// ---------------------------------------------------------------------------
// 3. Feature 19: Tool Output Clamp Tests
// ---------------------------------------------------------------------------

test("Feature 19: clampToolOutput leaves output <= maxChars untouched", () => {
  const shortText = "Normal short tool output\nLine 2\nLine 3";
  const result = clampToolOutput(shortText, { maxChars: 500 });
  assert.equal(result.clamped, false);
  assert.equal(result.text, shortText);
  assert.equal(result.spillPath, null);
});

test("Feature 19: clampToolOutput preserves head/tail, emits notice, writes spill file on non-C drive", () => {
  // Generate large text with known lines
  const lines = [];
  for (let i = 1; i <= 500; i++) {
    lines.push(`Line ${i.toString().padStart(4, "0")}: This is content payload padding text.`);
  }
  const fullText = lines.join("\n");
  assert.ok(fullText.length > 15000);

  const result = clampToolOutput(fullText, {
    maxChars: 4000,
    headChars: 1500,
    tailChars: 1000,
  });

  assert.equal(result.clamped, true);
  assert.ok(result.text.length < fullText.length);
  assert.match(result.text, /工具输出超出阈值/);
  assert.match(result.text, /完整原始输出已存入文件:/);

  // Extract spillover file path
  const spillPath = result.spillPath;
  assert.ok(spillPath, "Should contain file path to spillover output");

  // Verify non-C drive
  assertNotC(spillPath, "Spillover file must strictly be on non-C drive");
  assert.ok(fs.existsSync(spillPath), "Spillover file must exist on disk");

  // Verify contents of spillover file match raw text
  const savedContent = fs.readFileSync(spillPath, "utf8");
  assert.equal(savedContent, fullText, "Spill file must contain 100% of the raw output");

  // Verify head and tail preserved
  assert.ok(result.text.startsWith("Line 0001:"), "Head should start with first line");
  assert.ok(result.text.endsWith("Line 0500: This is content payload padding text."), "Tail should end with last line");
});

// ---------------------------------------------------------------------------
// 4. Feature 20: Telemetry Metrics & Store Aggregation Tests
// ---------------------------------------------------------------------------

test("Feature 20: computeTurnTelemetry calculates TTFT, TPS, and E2E TPS correctly", () => {
  const telemetry = computeTurnTelemetry({
    startedAt: 1000,
    firstTokenAt: 1200, // ttft = 200ms
    endedAt: 2000,      // total = 1000ms, gen = 800ms
    usage: {
      input_tokens: 100,
      output_tokens: 40,
      cache_read_tokens: 50,
      cache_write_tokens: 10,
    },
  });

  assert.equal(telemetry.ttft_ms, 200);
  assert.equal(telemetry.total_ms, 1000);
  assert.equal(telemetry.gen_ms, 800);
  // genSec = 0.8s, outputTokens = 40 => 40 / 0.8 = 50.0 tok/s
  assert.equal(telemetry.tps, 50);
  // totalSec = 1.0s, outputTokens = 40 => 40 / 1.0 = 40.0 tok/s
  assert.equal(telemetry.e2e_tps, 40);
  assert.equal(telemetry.cache_read_tokens, 50);
  assert.equal(telemetry.cache_write_tokens, 10);
});

test("Feature 20: computeTurnTelemetry handles zero tokens and missing firstTokenAt gracefully", () => {
  // Missing firstTokenAt: ttft_ms defaults to totalMs, gen_ms = 0
  const t1 = computeTurnTelemetry({
    startedAt: 1000,
    firstTokenAt: null,
    endedAt: 1500,
    usage: { input_tokens: 50, output_tokens: 0 },
  });
  assert.equal(t1.ttft_ms, 500);
  assert.equal(t1.gen_ms, 0);
  assert.equal(t1.tps, 0);
  assert.equal(t1.e2e_tps, 0);

  // Zero duration edge case
  const t2 = computeTurnTelemetry({
    startedAt: 1000,
    firstTokenAt: 1000,
    endedAt: 1000,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  assert.equal(t2.ttft_ms, 0);
  assert.equal(t2.tps, 0);
  assert.equal(t2.e2e_tps, 0);
  assert.ok(!Number.isNaN(t2.tps));
  assert.ok(!Number.isNaN(t2.e2e_tps));
});

test("Feature 20: Store persists telemetry and calculates average TTFT and TPS", () => {
  const dbPath = path.join(TEST_DATA_ROOT, "data", `store_telem_${Date.now()}.db`);
  const store = new Store(dbPath);
  onCleanup(() => store.close());

  // 1. Initial empty summary check (legacy compatibility)
  const emptySummary = store.usageSummary();
  assert.deepEqual(emptySummary, {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    ms: 0,
    by_bot: [],
  });

  // 2. Add two usage records with telemetry
  store.addUsage({
    bot_id: "coder",
    room_id: "r1",
    input_tokens: 100,
    output_tokens: 50,
    ms: 1000,
    ttft_ms: 200,
    tps: 60,
    cache_read_tokens: 40,
    cache_write_tokens: 10,
  });

  store.addUsage({
    bot_id: "coder",
    room_id: "r1",
    input_tokens: 200,
    output_tokens: 100,
    ms: 2000,
    ttft_ms: 400,
    tps: 40,
    cache_read_tokens: 80,
    cache_write_tokens: 20,
  });

  // 3. Check summary aggregation
  const summary = store.usageSummary();
  assert.equal(summary.calls, 2);
  assert.equal(summary.input_tokens, 300);
  assert.equal(summary.output_tokens, 150);
  assert.equal(summary.total_tokens, 450);
  assert.equal(summary.cache_read_tokens, 120);
  assert.equal(summary.cache_write_tokens, 30);
  // avg_ttft_ms: (200 + 400) / 2 = 300
  assert.equal(summary.avg_ttft_ms, 300);
  // avg_tps: (60 + 40) / 2 = 50
  assert.equal(summary.avg_tps, 50);

  // Check by_bot aggregation
  assert.equal(summary.by_bot.length, 1);
  const coderSummary = summary.by_bot[0];
  assert.equal(coderSummary.bot_id, "coder");
  assert.equal(coderSummary.calls, 2);
  assert.equal(coderSummary.avg_ttft_ms, 300);
  assert.equal(coderSummary.avg_tps, 50);
});
