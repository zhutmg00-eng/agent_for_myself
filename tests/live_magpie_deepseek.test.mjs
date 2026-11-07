/**
 * tests/live_magpie_deepseek.test.mjs
 * Live End-to-End Test Suite connecting directly to the local Magpie Gateway (http://127.0.0.1:3425/v1)
 * and executing real model routing through DeepSeek (prioritizing workbuddy/deepseek-v4.1-flash,
 * falling back to opencode-go/deepseek-v4.1-flash).
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { TEST_DATA_ROOT, onCleanup } from "./_helpers/env.mjs";
import { GATEWAY_URL, GATEWAY_ORIGIN, assertNotC } from "../src/config.js";
import { createEngine, fetchGatewayModels } from "../src/engine/runtime.js";
import { createBotRunner } from "../src/engine/bot.js";
import { Room } from "../src/rooms/room.js";
import { Store, defaultPermissions } from "../src/store.js";
import { EventBus } from "../src/events.js";
import { createApproval } from "../src/approval.js";

const WORKBUDDY_MODEL = "workbuddy/deepseek-v4.1-flash";
const OPENCODE_MODEL = "opencode-go/deepseek-v4.1-flash";

describe("Live Magpie Gateway & DeepSeek Integration", () => {
  let gatewayOnline = false;
  let availableModels = [];

  before(async () => {
    process.env.FUSION_PI_ONLINE = "1";
    try {
      const probe = await fetchGatewayModels({ url: GATEWAY_URL, timeoutMs: 3000 });
      if (probe.ok && probe.models.length > 0) {
        gatewayOnline = true;
        availableModels = probe.models.map((m) => m.id);
      }
    } catch {
      gatewayOnline = false;
    }
  });

  test("1. Magpie gateway responds on port 3425 and discovers DeepSeek models", async (t) => {
    if (!gatewayOnline) {
      t.skip("Magpie gateway is not running on http://127.0.0.1:3425");
      return;
    }

    assert.ok(availableModels.length > 0, "Gateway should return at least one model");
    const hasWorkbuddy = availableModels.includes(WORKBUDDY_MODEL);
    const hasOpencode = availableModels.includes(OPENCODE_MODEL);
    assert.ok(
      hasWorkbuddy || hasOpencode,
      `Expected either ${WORKBUDDY_MODEL} or ${OPENCODE_MODEL} in catalog. Got: ${availableModels.join(", ")}`,
    );
  });

  test("2. Direct streaming chat completion via Magpie gateway routes to DeepSeek", async (t) => {
    if (!gatewayOnline) {
      t.skip("Magpie gateway is not running on http://127.0.0.1:3425");
      return;
    }

    const targetModel = availableModels.includes(WORKBUDDY_MODEL) ? WORKBUDDY_MODEL : OPENCODE_MODEL;
    const body = {
      model: targetModel,
      messages: [{ role: "user", content: "Ping from automated live test. Reply with: PONG_MAGPIE" }],
      stream: true,
      stream_options: { include_usage: true },
    };

    const t0 = Date.now();
    let ttft = 0;
    let tokens = 0;
    let fullText = "";
    let usage = null;

    const res = await fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal(res.status, 200, `Expected HTTP 200 from Magpie chat completions, got ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let pos;
      while ((pos = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, pos).trim();
        buffer = buffer.slice(pos + 1);
        if (!line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") continue;
        try {
          const json = JSON.parse(dataStr);
          if (json.usage) usage = json.usage;
          const delta = json.choices?.[0]?.delta?.content || "";
          if (delta) {
            if (!ttft) ttft = Date.now() - t0;
            fullText += delta;
            tokens++;
          }
        } catch {
          // ignore parse errors for partial lines
        }
      }
    }

    const totalMs = Date.now() - t0;
    const genMs = Math.max(1, totalMs - ttft);
    const completionTokens = usage?.completion_tokens || tokens;
    const tps = genMs > 0 ? (completionTokens / (genMs / 1000)) : 0;

    console.log(`[Magpie Live] Model: ${targetModel} | TTFT: ${ttft}ms | Gen Duration: ${genMs}ms | TPS: ${tps.toFixed(1)} tok/s | Tokens: ${completionTokens}`);

    assert.ok(fullText.length > 0, "Completion message content should not be empty");
    assert.ok(ttft > 0, "TTFT should be measured");
    assert.ok(completionTokens > 0, "Completion tokens should be > 0");
  });

  test("3. AgentFusion BotRunner executes a real turn through Magpie + DeepSeek", async (t) => {
    if (!gatewayOnline) {
      t.skip("Magpie gateway is not running on http://127.0.0.1:3425");
      return;
    }

    const targetModel = availableModels.includes(WORKBUDDY_MODEL) ? WORKBUDDY_MODEL : OPENCODE_MODEL;
    process.env.FUSION_MODEL = targetModel;

    const dbPath = path.join(TEST_DATA_ROOT, "data", `live_bot_${Date.now()}.db`);
    assertNotC(dbPath, "test db");
    const store = new Store(dbPath);
    onCleanup(() => store.close());

    const engine = await createEngine({ store, gatewayUrl: GATEWAY_URL });
    const bot = createBotRunner({
      engine,
      store,
      bot: { id: "live_test_agent", persona: "You are a concise test agent. Reply in under 10 words." },
    });

    const result = await bot.run({ prompt: "Status check: Confirm you are live via Magpie." });
    assert.ok(!result.error, `Turn error should be undefined, got: ${result.error}`);
    assert.ok(result.text && result.text.length > 0, "Turn should produce non-empty response text");
    assert.ok(result.usage && result.usage.total > 0, "Turn should record non-zero token usage");
    console.log(`[Magpie Live] BotRunner Turn completed: "${result.text.trim()}" (${result.usage.total} tokens, ${result.telemetry?.durationMs || "n/a"}ms)`);
  });

  test("4. AgentFusion BotRunner maintains multi-turn context with DeepSeek", async (t) => {
    if (!gatewayOnline) {
      t.skip("Magpie gateway is not running on http://127.0.0.1:3425");
      return;
    }

    const targetModel = availableModels.includes(WORKBUDDY_MODEL) ? WORKBUDDY_MODEL : OPENCODE_MODEL;
    process.env.FUSION_MODEL = targetModel;

    const dbPath = path.join(TEST_DATA_ROOT, "data", `live_mt_${Date.now()}.db`);
    assertNotC(dbPath, "test db");
    const store = new Store(dbPath);
    onCleanup(() => store.close());

    const engine = await createEngine({ store, gatewayUrl: GATEWAY_URL });
    const bot = createBotRunner({
      engine,
      store,
      bot: { id: "live_mt_agent", persona: "You are an accurate memory test agent." },
    });

    const res1 = await bot.run({ prompt: "The secret codeword is ATLAS-99. Acknowledge briefly." });
    assert.ok(!res1.error, `Turn 1 error: ${res1.error}`);
    assert.ok(res1.text.length > 0, "Turn 1 text expected");

    const res2 = await bot.run({ prompt: "What is the secret codeword? Answer with just the codeword." });
    assert.ok(!res2.error, `Turn 2 error: ${res2.error}`);
    assert.match(res2.text, /ATLAS-99/, "Expected model to recall the codeword from prior turn");
    console.log(`[Magpie Live] Multi-turn recall confirmed: "${res2.text.trim()}" (Turn 1: ${res1.usage?.total} tokens, Turn 2: ${res2.usage?.total} tokens)`);
  });

  test("5. Room multi-agent orchestrates a live round routed via Magpie + DeepSeek", async (t) => {
    if (!gatewayOnline) {
      t.skip("Magpie gateway is not running on http://127.0.0.1:3425");
      return;
    }

    const targetModel = availableModels.includes(WORKBUDDY_MODEL) ? WORKBUDDY_MODEL : OPENCODE_MODEL;
    process.env.FUSION_MODEL = targetModel;

    const dbPath = path.join(TEST_DATA_ROOT, "data", `live_room_${Date.now()}.db`);
    assertNotC(dbPath, "test db");
    const store = new Store(dbPath);
    onCleanup(() => store.close());

    const events = new EventBus(store);
    const approval = createApproval({ store, now: () => Date.now() });
    const engine = await createEngine({ store, gatewayUrl: GATEWAY_URL });

    const roomId = `room_live_${Date.now()}`;
    const record = {
      room_id: roomId,
      title: "Live Room Test with Magpie",
      owner_id: "boss",
      context_policy: "shared",
      status: "active",
      settings: { relay_mode: "handover" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.upsertRoom(record);
    store.setRoomMembers(roomId, [
      { bot_id: "boss", permissions: defaultPermissions({ can_create_subgroup: true }) },
    ]);

    const room = new Room({ record, store, events, approval, engine });
    await room.loadMembers();

    let roundStarted = false;
    let roundCompleted = false;
    events.subscribe((e) => {
      if (e.topic === `room.${roomId}.round_started`) roundStarted = true;
      if (e.topic === `room.${roomId}.round_completed`) roundCompleted = true;
    });

    await room.runRound({ instruction: "Please respond with exactly: READY_LIVE_OK", turnTimeoutMs: 90_000 });
    assert.ok(roundStarted, "round_started event should be triggered");
    assert.ok(roundCompleted, "round_completed event should be triggered");
    assert.ok(room._round_turns.length >= 1, "Expected at least 1 member turn executed");
    assert.ok(room._round_turns[0].text.length > 0, "Turn should produce response from DeepSeek");
    console.log(`[Magpie Live] Room round completed with ${room._round_turns.length} turns, turn 1 response: "${room._round_turns[0].text.trim()}"`);
  });
});
