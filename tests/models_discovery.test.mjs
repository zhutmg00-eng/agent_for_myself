import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  inferModelMeta,
  fetchGatewayModels,
  normalizeModel,
} from "../src/engine/runtime.js";
import { RoomManager } from "../src/rooms/manager.js";
import {
  parseModelInfo,
  formatModelShort,
  groupModels,
  buildModelSelectOptionsHTML,
  CUSTOM_MODEL_VALUE,
} from "../web/js/models.js";

test("backend inferModelMeta recognizes diverse gateway model families and capabilities", () => {
  const cases = [
    ["claude-3.7-sonnet", "claude", "Anthropic Claude", true, true],
    ["openai/gpt-4o", "openai", "OpenAI", false, true],
    ["o3-mini", "openai", "OpenAI", true, true],
    ["gemini-2.5-pro", "gemini", "Google Gemini", true, true],
    ["deepseek-v4.1-flash", "deepseek", "DeepSeek", true, false],
    ["deepseek-r1", "deepseek", "DeepSeek", true, false],
    ["qwen2.5-coder-32b", "qwen", "Qwen 通义", false, false],
    ["kimi-k2", "kimi", "Kimi / Moonshot", true, true],
    ["glm-4.5", "glm", "Zhipu GLM", true, false],
    ["llama-3.3-70b", "llama", "Meta Llama", false, false],
    ["codestral-latest", "mistral", "Mistral", false, false],
    ["grok-3", "grok", "xAI Grok", true, true],
    ["my-internal-llm-v2", "other", "网关模型", false, false],
  ];

  for (const [id, family, familyLabel, reasoning, vision] of cases) {
    const meta = inferModelMeta(id);
    assert.equal(meta.family, family, `family mismatch for ${id}`);
    assert.equal(meta.family_label, familyLabel, `label mismatch for ${id}`);
    assert.equal(meta.reasoning, reasoning, `reasoning mismatch for ${id}`);
    assert.equal(meta.input.includes("image"), vision, `vision mismatch for ${id}`);
    assert.ok(meta.display_name.length > 0, `display_name missing for ${id}`);
  }
});

test("backend fetchGatewayModels parses OpenAI data[], Ollama models[], bare arrays, and string IDs", async () => {
  const openAiPayload = {
    data: [
      { id: "claude-sonnet-4", owned_by: "anthropic", context_length: 200000 },
      { id: "gpt-4o", owned_by: "openai", context_length: 128000 },
      { id: "gemini-2.5-pro", owned_by: "google", context_length: 1000000 },
      { id: "deepseek-v4.1-flash", owned_by: "deepseek", context_length: 128000 },
      { id: "gpt-4o", owned_by: "openai" }, // duplicate should be deduped
    ],
  };

  const r1 = await fetchGatewayModels({
    url: "http://mock-gw.local/v1",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => openAiPayload,
    }),
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.models.length, 4);
  assert.deepEqual(
    r1.models.map((m) => [m.id, m.family]),
    [
      ["claude-sonnet-4", "claude"],
      ["gpt-4o", "openai"],
      ["gemini-2.5-pro", "gemini"],
      ["deepseek-v4.1-flash", "deepseek"],
    ],
  );

  // Ollama / LiteLLM style { models: [...] } + bare string entries
  const r2 = await fetchGatewayModels({
    url: "http://mock-ollama.local/v1",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { name: "qwen2.5-coder:32b" },
          "kimi-k2-0711-preview",
        ],
      }),
    }),
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.models.length, 2);
  assert.equal(r2.models[0].family, "qwen");
  assert.equal(r2.models[1].family, "kimi");

  // normalizeModel preserves dynamic gatewayUrl (mapped onto baseUrl for pi)
  const norm = normalizeModel({ id: "claude-sonnet-4" }, 0, "http://custom-gw:8080/v1");
  assert.equal(norm.baseUrl, "http://custom-gw:8080/v1");
  assert.equal(norm.family, "claude");
  const normOpenAi = normalizeModel({ id: "gpt-4o" }, 0, "http://custom-gw:8080/v1");
  assert.equal(normOpenAi.baseUrl, "http://custom-gw:8080/v1");
  assert.equal(normOpenAi.family, "openai");
});

test("frontend models.js groups multi-vendor models, formats short labels, and builds grouped select options without emojis", () => {
  const catalog = [
    { id: "deepseek-v4.1-flash", display_name: "DeepSeek V4.1 Flash", owned_by: "deepseek", context_length: 128000, family: "deepseek", family_label: "DeepSeek" },
    { id: "claude-sonnet-4", display_name: "Claude Sonnet 4", owned_by: "anthropic", context_length: 200000, family: "claude", family_label: "Anthropic Claude", reasoning: true, input: ["text", "image"] },
    { id: "gpt-4o", display_name: "GPT-4o", owned_by: "openai", context_length: 128000, family: "openai", family_label: "OpenAI", input: ["text", "image"] },
    { id: "gemini-2.5-pro", display_name: "Gemini 2.5 Pro", owned_by: "google", context_length: 1000000, family: "gemini", family_label: "Google Gemini", reasoning: true, input: ["text", "image"] },
    { id: "qwen-max", display_name: "Qwen Max", owned_by: "alibaba", context_length: 128000, family: "qwen", family_label: "Qwen 通义" },
  ];

  assert.equal(formatModelShort("claude-sonnet-4", catalog), "Claude Sonnet 4");
  assert.equal(formatModelShort("openai/o3-mini", catalog), "o3 Mini");
  assert.equal(parseModelInfo(catalog[1]).hasVision, true);
  assert.equal(parseModelInfo(catalog[1]).reasoning, true);

  const groups = groupModels(catalog, ["custom/my-coder-v1"]);
  assert.equal(groups.length, 6);
  assert.equal(groups[0].family, "claude");
  assert.equal(groups[1].family, "openai");
  assert.equal(groups[2].family, "gemini");
  assert.equal(groups[3].family, "deepseek");
  assert.equal(groups[4].family, "qwen");

  const html = buildModelSelectOptionsHTML(catalog, {
    selected: "claude-sonnet-4",
    defaultModel: "deepseek-v4.1-flash",
    allowInherit: true,
    allowCustom: true,
  });
  assert.ok(html.includes(`<option value="">跟随全局默认（DeepSeek V4.1 Flash）</option>`));
  assert.ok(html.includes(`<optgroup label="Anthropic Claude">`));
  assert.ok(html.includes(`<optgroup label="OpenAI">`));
  assert.ok(html.includes(`<optgroup label="Google Gemini">`));
  assert.ok(html.includes(`value="claude-sonnet-4" selected`));
  assert.ok(html.includes(`value="${CUSTOM_MODEL_VALUE}"`));
  assert.equal(/\p{Extended_Pictographic}/u.test(html), false, "options HTML must contain zero emojis");
});

test("RoomManager.syncBotModel hot-swaps active room runners across rooms", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-sync-model-"));
  try {
    const rm = new RoomManager({ dataDir: tmpDir });
    const swaps = [];
    const fakeRoom = {
      room_id: "room-1",
      _runners: new Map([
        ["coder", { async setModel(id) { swaps.push(["coder", id]); } }],
        ["reviewer", { async setModel(id) { swaps.push(["reviewer", id]); } }],
      ]),
    };
    rm.rooms.set("room-1", fakeRoom);

    const updated = await rm.syncBotModel("coder", "claude-sonnet-4");
    assert.equal(updated, 1);
    assert.deepEqual(swaps, [["coder", "claude-sonnet-4"]]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
