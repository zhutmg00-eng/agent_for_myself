/**
 * tests/challenger_m5_watchdog_edge.test.mjs
 * Milestone 5 Challenger Edge-Case Empirical Verification Suite
 *
 * Covers:
 * 1. Watchdog Hard Cutoff vs Cooperative Abort:
 *    - Uncooperative async loop ignoring AbortSignal completely
 *    - Hard cutoff race resolution and turn_timeout emission within timeoutMs + graceMs
 *    - Queue deadlock prevention: 3 immediately enqueued subsequent turns execute with 100% success
 * 2. Mid-Turn Abort via abortRound():
 *    - Multi-member in-flight abort via _roundAbortController
 *    - Transition to paused status and immediate execution short-circuit of downstream members
 *    - Clean state reset and subsequent room reactivation via room.say()
 * 3. Repetitive Structured Text Loop Interception:
 *    - Substantive Markdown headers, code blocks and markers >= 150 characters
 *    - Turn fingerprint deduplication demoting duplicate structured text to Tier 0 chatter
 *    - Circuit breaker tripping (chatter_limit_tripped) when threshold is met
 *    - Semantic oscillation detection via detectInfiniteLoop
 */
import { TEST_DATA_ROOT, onCleanup } from "./_helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Store, defaultPermissions } from "../src/store.js";
import { EventBus } from "../src/events.js";
import { Room, evalForwardProgress, detectInfiniteLoop } from "../src/rooms/room.js";

async function makeEdgeRoom({
  name = "edge",
  members = ["boss", "worker_1", "worker_2"],
  owner = "boss",
  permissions = {},
  roomSettings = {},
} = {}) {
  const dbPath = path.join(
    TEST_DATA_ROOT,
    "data",
    `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`,
  );
  const store = new Store(dbPath);
  onCleanup(() => store.close());
  const events = new EventBus(store);
  const seen = [];
  const off = events.subscribe((evt) => seen.push(evt));
  onCleanup(off);

  const roomId = `room_${name}`;
  const record = {
    room_id: roomId,
    title: `Challenger Edge Room - ${name}`,
    owner_id: owner,
    context_policy: "shared",
    status: "active",
    settings: roomSettings,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  store.upsertRoom(record);
  store.setRoomMembers(
    roomId,
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
  });
  await room.loadMembers();
  return { room, store, events, seen, roomId };
}

// =============================================================================
// Edge Test 1: Watchdog Hard Cutoff vs Cooperative Abort & 3-Turn Queue Recovery
// =============================================================================
test("Challenger Edge 1: Watchdog Hard Cutoff vs Cooperative Abort & 3-Turn Queue Recovery", async () => {
  const timeoutMs = 80;
  const graceMs = Math.min(2000, Math.max(200, Math.floor(timeoutMs * 0.2))); // 200ms
  const expectedCutoffCeiling = timeoutMs + graceMs + 600; // 880ms ceiling accounting for Windows timer granularity

  const { room, seen, roomId } = await makeEdgeRoom({
    name: "edge_uncooperative_cutoff",
    members: ["stubborn_bot"],
    permissions: {
      stubborn_bot: { turn_timeout_ms: timeoutMs },
    },
  });

  let softSignalAborted = false;
  let uncooperativeStarted = false;
  let uncooperativeMode = true;

  room.runnerFor = (botId) => {
    return {
      run: async ({ signal, prompt }) => {
        if (uncooperativeMode) {
          uncooperativeStarted = true;
          signal?.addEventListener("abort", () => {
            softSignalAborted = true;
          });
          // Totally uncooperative async loop that completely ignores AbortSignal
          const loopStart = Date.now();
          while (Date.now() - loopStart < 4000) {
            await new Promise((r) => setTimeout(r, 20));
          }
          return { text: "Should never be reached due to hard cutoff", ms: 4000 };
        }
        return {
          text: `Normal success response for: ${prompt}`,
          toolsUsed: ["read_file"],
          toolResults: [{ name: "read_file", ok: true }],
          ms: 10,
          usage: { input_tokens: 15, output_tokens: 10 },
        };
      },
    };
  };

  const startT = Date.now();
  await room.say({
    sender: "user",
    content: "execute uncooperative loop",
    speaker: "user",
  });
  await room._queue;
  const elapsedMs = Date.now() - startT;

  // 1. Verify uncooperative runner started and soft signal fired
  assert.equal(uncooperativeStarted, true, "Uncooperative runner must have been invoked");
  assert.equal(softSignalAborted, true, "Soft AbortSignal must have triggered at timeoutMs");

  // 2. Verify hard cutoff resolved within timeoutMs + graceMs
  assert.ok(
    elapsedMs < expectedCutoffCeiling,
    `Hard cutoff race must break hung turn promptly (< ${expectedCutoffCeiling}ms), actual: ${elapsedMs}ms`,
  );

  // 3. Verify turn_timeout event emitted with accurate payload
  const timeoutEvts = seen.filter((e) => e.topic === `room.${roomId}.turn_timeout`).map((e) => e.payload);
  assert.equal(timeoutEvts.length, 1, "Exactly one turn_timeout event must be emitted");
  assert.equal(timeoutEvts[0].bot_id, "stubborn_bot");
  assert.equal(timeoutEvts[0].timeout_ms, timeoutMs);
  assert.ok(timeoutEvts[0].ms >= timeoutMs, `Reported ms must be >= timeoutMs, got ${timeoutEvts[0].ms}`);

  // 4. Verify member_error recorded with timed_out: true
  const errorEvts = seen.filter((e) => e.topic === `room.${roomId}.member_error`).map((e) => e.payload);
  assert.ok(errorEvts.some((e) => e.bot_id === "stubborn_bot" && e.timed_out === true));

  // 5. Verify queue does not hang: immediately enqueue 3 subsequent normal turns
  uncooperativeMode = false;
  const normalTurnExecutions = [];
  room.runnerFor = (botId) => ({
    run: async ({ prompt }) => {
      normalTurnExecutions.push({ botId, prompt, ts: Date.now() });
      return {
        text: `Normal success response for ${botId}`,
        toolsUsed: ["read_file"],
        toolResults: [{ name: "read_file", ok: true }],
        ms: 10,
        usage: { input_tokens: 15, output_tokens: 10 },
      };
    },
  });

  const p1 = room.say({ sender: "user", content: "Subsequent task 1", speaker: "user" });
  const p2 = room.say({ sender: "user", content: "Subsequent task 2", speaker: "user" });
  const p3 = room.say({ sender: "user", content: "Subsequent task 3", speaker: "user" });
  await Promise.all([p1, p2, p3]);
  await room._queue;

  // Verify all 3 normal turns executed with 100% success rate
  assert.equal(
    normalTurnExecutions.length,
    3,
    "All 3 subsequent queued rounds must execute to completion without hanging",
  );
  // Verify room message log contains all 3 user messages and 3 assistant responses
  const recentMessages = room.message_log.slice(-6);
  assert.equal(recentMessages.filter((m) => m.speaker === "user").length, 3);
  assert.equal(recentMessages.filter((m) => m.kind === "assistant").length, 3);
});

// =============================================================================
// Edge Test 2: Mid-Turn Abort via abortRound() Halts Execution & Cleans Up State
// =============================================================================
test("Challenger Edge 2: Mid-Turn Abort via abortRound() Halts Execution and Cleans Up State for Reactivation", async () => {
  const { room, seen, roomId } = await makeEdgeRoom({
    name: "edge_midturn_abort",
    members: ["member_lead", "member_long", "member_trailing"],
  });

  let longTurnStarted = false;
  let longTurnAborted = false;
  let trailingTurnExecuted = false;

  room.runnerFor = (botId) => {
    if (botId === "member_lead") {
      return {
        run: async () => ({
          text: "Lead step completed.",
          toolsUsed: ["room_file_list"],
          toolResults: [{ name: "room_file_list", ok: true }],
          ms: 10,
        }),
      };
    }
    if (botId === "member_long") {
      return {
        run: async ({ signal }) => {
          longTurnStarted = true;
          return new Promise((resolve, reject) => {
            signal?.addEventListener("abort", () => {
              longTurnAborted = true;
              const err = new Error(signal.reason || "aborted_mid_turn");
              err.name = "AbortError";
              reject(err);
            });
          });
        },
      };
    }
    if (botId === "member_trailing") {
      return {
        run: async () => {
          trailingTurnExecuted = true;
          return { text: "Trailing step completed." };
        },
      };
    }
    return { run: async () => ({ text: "default" }) };
  };

  // Launch round that visits lead -> long -> trailing
  const roundPromise = room.runRound({ instruction: "Execute 3-phase workflow" });

  // Wait until member_long is in flight
  while (!longTurnStarted) {
    await new Promise((r) => setTimeout(r, 10));
  }

  // Preconditions before abort
  assert.ok(room._roundAbortController !== null, "_roundAbortController must be instantiated during round");
  assert.equal(room._roundAbortController.signal.aborted, false, "_roundAbortController must not be aborted yet");
  assert.ok(room._activeTurnController !== null, "_activeTurnController must be active for in-flight turn");

  // Call abortRound mid-turn
  const abortSuccess = room.abortRound("emergency operator intervention");
  assert.equal(abortSuccess, true, "abortRound must return true when active round/turn exists");

  await roundPromise;

  // 1. Verify in-flight turn was stopped
  assert.equal(longTurnAborted, true, "In-flight runner AbortSignal must have triggered");

  // 2. Verify status set to 'paused'
  assert.equal(room.status, "paused", "Room status must be transitioned to paused");

  // 3. Verify subsequent member did not execute
  assert.equal(trailingTurnExecuted, false, "Subsequent member (member_trailing) must NOT execute");

  // 4. Verify round_completed emitted with paused: true
  const completedEvts = seen.filter((e) => e.topic === `room.${roomId}.round_completed`).map((e) => e.payload);
  assert.ok(completedEvts.length >= 1);
  assert.equal(completedEvts[completedEvts.length - 1].paused, true);

  // 5. Clean state cleanup: controllers cleared in finally block
  assert.equal(room._roundAbortController, null, "_roundAbortController must be reset to null");
  assert.equal(room._activeTurnController, null, "_activeTurnController must be reset to null");
  assert.equal(room.round_running, 0, "round_running must return to 0");

  // 6. Resume room via room.say(...) and verify clean reactivation
  let resumedTurnRan = false;
  room.runnerFor = () => ({
    run: async () => {
      resumedTurnRan = true;
      return {
        text: "Resumed successfully after abort.",
        toolsUsed: ["edit_file"],
        toolResults: [{ name: "edit_file", ok: true }],
        ms: 15,
      };
    },
  });

  await room.say({
    sender: "user",
    content: "Resume operations now",
    speaker: "user",
  });
  await room._queue;

  assert.equal(room.status, "active", "Room status must reactivate to 'active' after say()");
  assert.equal(resumedTurnRan, true, "Resumed round must successfully execute assistant turn");
  assert.equal(room.round_running, 0, "round_running must cleanly return to 0 after resumed round");
});

// =============================================================================
// Edge Test 3: Repetitive Structured Text Loop Interception & Circuit Breaker Tripping
// =============================================================================
test("Challenger Edge 3: Repetitive Structured Text Loop Interception & Circuit Breaker Tripping", async () => {
  const { room, seen, roomId } = await makeEdgeRoom({
    name: "edge_repetitive_structured",
    members: ["bot_alpha", "bot_beta", "bot_gamma"],
    roomSettings: {
      base_relay_limit: 10,
      max_chatter_relays: 2, // Breaker trips after 2 consecutive chatter turns
    },
  });

  // Generate structured markdown text with headers, lists, code block, and length >= 150
  const structuredRepeatedOutput = [
    "### 核心业务逻辑执行报告",
    "- 步骤 1: 检验系统全局约束并确认 D 盘绝对隔离",
    "- 步骤 2: 装载遥测性能统计组件与内存索引缓存",
    "```typescript",
    "export function executePipeline(config: PipelineConfig): Result {",
    "  const telemetry = recordPipelineTelemetry(config);",
    "  return { success: true, elapsedMs: telemetry.durationMs };",
    "}",
    "```",
    "【交付结论】系统架构符合企业级高可用规范，所有回归断言均保持 100% 绿灯通过。",
  ].join("\n");

  assert.ok(structuredRepeatedOutput.length >= 150, "Structured text must be >= 150 chars");
  assert.ok(structuredRepeatedOutput.includes("###"), "Must include Markdown header");
  assert.ok(structuredRepeatedOutput.includes("```"), "Must include code block");
  assert.ok(structuredRepeatedOutput.includes("【"), "Must include marker");

  // Step 1: Unit verification of turn fingerprint deduplication logic
  const normalizedHash = structuredRepeatedOutput.toLowerCase().replace(/[\s\p{P}]+/gu, "");

  // Fresh evaluation with empty fingerprint history -> Tier 3 Progress
  const freshProgress = evalForwardProgress(
    { text: structuredRepeatedOutput },
    { _round_turn_fingerprints: [] },
  );
  assert.equal(freshProgress.tier, 3, "Fresh structured text must be Tier 3 structured_output");
  assert.equal(freshProgress.isProgress, true);
  assert.equal(freshProgress.grant, 1);

  // Re-evaluation with identical fingerprint in history -> Tier 0 Chatter Demotion
  const duplicateHistory = [
    { botId: "bot_prior", hash: normalizedHash, textLen: structuredRepeatedOutput.length },
  ];
  const duplicateProgress = evalForwardProgress(
    { text: structuredRepeatedOutput },
    { _round_turn_fingerprints: duplicateHistory },
  );
  assert.equal(duplicateProgress.tier, 0, "Duplicate structured markdown must be demoted to Tier 0");
  assert.equal(duplicateProgress.isProgress, false);
  assert.equal(duplicateProgress.grant, 0);
  assert.equal(duplicateProgress.tierName, "chatter");
  assert.equal(duplicateProgress.reason, "no_progress_chatter");

  // Step 2: Multi-member repetitive loop execution in Room
  let gammaExecuted = false;
  room.runnerFor = (botId) => {
    if (botId === "bot_gamma") {
      gammaExecuted = true;
    }
    return {
      run: async () => ({
        text: structuredRepeatedOutput, // Both bot_alpha and bot_beta return identical structured text
        toolsUsed: [],
        toolResults: [],
        ms: 10,
      }),
    };
  };

  // Run round visiting bot_alpha, bot_beta, bot_gamma
  await room.runRound({ instruction: "Generate implementation report" });

  // 1. Verify chatter limit tripped event emitted
  const chatterTrippedEvts = seen
    .filter((e) => e.topic === `room.${roomId}.chatter_limit_tripped`)
    .map((e) => e.payload);
  assert.equal(chatterTrippedEvts.length, 1, "chatter_limit_tripped event must be emitted");
  assert.equal(
    chatterTrippedEvts[0].consecutive_stagnant,
    2,
    "consecutive_stagnant must reach max_chatter_relays threshold (2)",
  );

  // 2. Verify breaker halted round: bot_gamma never executed
  assert.equal(
    gammaExecuted,
    false,
    "Circuit breaker must halt round immediately, preventing bot_gamma from executing",
  );

  // 3. Verify system notices logged chatter breaker
  assert.ok(
    room.system_notices.some((n) => n.includes("无实质进展的闲聊达到上限") && n.includes("提前结束")),
    "System notices must record chatter limit termination",
  );

  // Step 3: Semantic oscillation detection via detectInfiniteLoop
  const oscHistory = [
    { botId: "bot_loop", hash: normalizedHash, textLen: structuredRepeatedOutput.length },
    { botId: "bot_loop", hash: normalizedHash, textLen: structuredRepeatedOutput.length },
  ];
  const loopDetection = detectInfiniteLoop(
    { botId: "bot_loop", text: structuredRepeatedOutput },
    { _round_turn_fingerprints: oscHistory },
  );
  assert.equal(loopDetection.isLoop, true);
  assert.equal(loopDetection.type, "semantic_oscillation");
  assert.ok(loopDetection.reason.includes("重复输出相同内容"));
});
