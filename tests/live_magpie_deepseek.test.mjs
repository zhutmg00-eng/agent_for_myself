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

  test("2. Direct chat completion via Magpie gateway routes to DeepSeek", async (t) => {
    if (!gatewayOnline) {
      t.skip("Magpie gateway is not running on http://127.0.0.1:3425");
      return;
    }

    const targetModel = availableModels.includes(WORKBUDDY_MODEL) ? WORKBUDDY_MODEL : OPENCODE_MODEL;
    const body = {
      model: targetModel,
      messages: [{ role: "user", content: "Ping from automated live test. Reply with: PONG_MAGPIE" }],
      max_tokens: 60,
    };

    const res = await fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal(res.status, 200, `Expected HTTP 200 from Magpie chat completions, got ${res.status}`);
    const data = await res.json();
    assert.ok(data.choices && data.choices.length > 0, "Expected at least one completion choice");
    const reply = data.choices[0].message?.content || "";
    assert.ok(reply.length > 0, "Completion message content should not be empty");
    assert.ok(data.usage?.total_tokens > 0, "Usage total_tokens should be recorded");
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
  });

  test("4. Room multi-agent orchestrates a live round routed via Magpie + DeepSeek", async (t) => {
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
  });
});
