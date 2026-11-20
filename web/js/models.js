/* Pure multi-model recognition, formatting, grouping & select-option helpers. */

import { escapeHtml } from "./avatars.js";
import { escapeAttr, formatTokens, openModal, closeModal, $, ICONS } from "./ui.js";

export const CUSTOM_MODEL_VALUE = "__custom__";

const FAMILY_SPECS = [
  { family: "claude", label: "Anthropic Claude", tone: "amber", test: /(?:^|\/|-)(?:claude|zcode)/i },
  { family: "openai", label: "OpenAI", tone: "emerald", test: /(?:^|\/|-)(?:gpt|chatgpt|o1|o3|o4)(?:$|[-_./\d])/i },
  { family: "gemini", label: "Google Gemini", tone: "blue", test: /(?:^|\/|-)gemini/i },
  { family: "deepseek", label: "DeepSeek", tone: "indigo", test: /(?:^|\/|-)deepseek/i },
  { family: "qwen", label: "Qwen 通义", tone: "violet", test: /(?:^|\/|-)(?:qwen|qwq)/i },
  { family: "kimi", label: "Kimi / Moonshot", tone: "sky", test: /(?:^|\/|-)(?:kimi|moonshot)/i },
  { family: "glm", label: "Zhipu GLM", tone: "cyan", test: /(?:^|\/|-)(?:glm|chatglm)/i },
  { family: "hunyuan", label: "Hunyuan 混元", tone: "teal", test: /(?:^|\/|-)(?:hunyuan|hy3)/i },
  { family: "minimax", label: "MiniMax", tone: "rose", test: /(?:^|\/|-)(?:minimax|abab)/i },
  { family: "doubao", label: "Doubao 豆包", tone: "sky", test: /(?:^|\/|-)(?:doubao|seed)/i },
  { family: "llama", label: "Meta Llama", tone: "blue", test: /(?:^|\/|-)llama/i },
  { family: "mistral", label: "Mistral", tone: "amber", test: /(?:^|\/|-)(?:mistral|mixtral|codestral|pixtral|devstral)/i },
  { family: "grok", label: "xAI Grok", tone: "slate", test: /(?:^|\/|-)grok/i },
];

const FAMILY_ORDER = FAMILY_SPECS.map((s) => s.family);

function prettifyId(id) {
  const raw = String(id || "").trim();
  if (!raw) return "";
  const bare = raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw;
  const formatted = bare
    .replace(/^deepseek[-_]?/i, "DeepSeek ")
    .replace(/^claude[-_]?/i, "Claude ")
    .replace(/^gpt[-_]?/i, "GPT-")
    .replace(/^gemini[-_]?/i, "Gemini ")
    .replace(/^qwen[-_]?/i, "Qwen ")
    .replace(/^qwq[-_]?/i, "QwQ ")
    .replace(/^kimi[-_]?/i, "Kimi ")
    .replace(/^moonshot[-_]?/i, "Moonshot ")
    .replace(/^glm[-_]?/i, "GLM-")
    .replace(/^hunyuan[-_]?/i, "Hunyuan ")
    .replace(/^hy3$/i, "Hunyuan 3")
    .replace(/^minimax[-_]?/i, "MiniMax ")
    .replace(/^doubao[-_]?/i, "Doubao ")
    .replace(/^llama[-_]?/i, "Llama ")
    .replace(/^grok[-_]?/i, "Grok ")
    .replace(/^mistral[-_]?/i, "Mistral ")
    .replace(/^codestral[-_]?/i, "Codestral ");
  return formatted
    .replace(/[-_]+/g, " ")
    .replace(/\b(flash|pro|max|mini|nano|turbo|plus|lite|air|sonnet|opus|haiku|coder|reasoner|chat|preview|thinking|instruct)\b/gi, (m) => m[0].toUpperCase() + m.slice(1).toLowerCase())
    .replace(/\s+/g, " ")
    .trim() || raw;
}

/**
 * Recognise a model's family, display label, capabilities & tone from either a
 * full catalog entry or a bare model id string.
 */
export function parseModelInfo(modelOrId) {
  const obj = typeof modelOrId === "string"
    ? { id: modelOrId }
    : (modelOrId && typeof modelOrId === "object" ? modelOrId : {});
  const id = String(obj.id || "").trim();
  const ownedBy = String(obj.owned_by || "").trim();
  const hay = `${id} ${obj.display_name || obj.name || ""} ${ownedBy}`;
  const spec = FAMILY_SPECS.find((s) => s.test.test(hay));
  const prefix = id.includes("/") ? id.split("/")[0] : "";

  const family = obj.family && obj.family !== "other"
    ? String(obj.family)
    : (spec?.family || (prefix && !["auto", "default", "magpie", "local"].includes(prefix.toLowerCase()) ? prefix.toLowerCase() : "other"));
  const familyLabel = obj.family_label && obj.family_label !== "网关模型"
    ? String(obj.family_label)
    : (spec?.label || (ownedBy && !["magpie", "auto", "local"].includes(ownedBy.toLowerCase()) ? ownedBy : "其他网关模型"));
  const tone = spec?.tone || "slate";

  const rawDisplay = String(obj.display_name || obj.name || "").trim();
  const displayName = rawDisplay && rawDisplay !== id ? rawDisplay : prettifyId(id);

  const input = Array.isArray(obj.input)
    ? obj.input.map(String)
    : (Array.isArray(obj.modalities?.input) ? obj.modalities.input.map(String) : ["text"]);
  const hasVision = input.some((m) => /image|vision/i.test(m));
  const reasoning = obj.reasoning !== undefined
    ? Boolean(obj.reasoning)
    : /(?:^|\/|-)(?:r1|reasoner|o1|o3|o4|qwq|thinking|claude-3\.7|claude-4|sonnet-4|opus-4|gemini-2\.5)/i.test(id);
  const contextLength = Number(obj.context_length || obj.contextWindow || 0) || null;

  return {
    id,
    displayName: displayName || id,
    family,
    familyLabel,
    tone,
    ownedBy: ownedBy || prefix || "",
    reasoning,
    hasVision,
    contextLength,
    toolCall: obj.tool_call === undefined ? true : Boolean(obj.tool_call),
  };
}

/** Compact human-readable short model label for chips, footers, and message tags. */
export function formatModelShort(modelOrId, catalog = []) {
  const id = typeof modelOrId === "string" ? modelOrId.trim() : String(modelOrId?.id || "").trim();
  if (!id) return "pi 内核";
  const fromCatalog = Array.isArray(catalog) ? catalog.find((m) => m && m.id === id) : null;
  return parseModelInfo(fromCatalog || modelOrId).displayName || id;
}

/**
 * Merge gateway models with any explicit custom model IDs currently assigned to
 * bots/settings, deduplicate by id, and group by vendor family.
 */
export function groupModels(models = [], extraIds = []) {
  const byId = new Map();
  for (const raw of (models || [])) {
    if (!raw) continue;
    const info = parseModelInfo(raw);
    if (!info.id || byId.has(info.id)) continue;
    byId.set(info.id, { ...raw, ...info });
  }
  for (const extra of (extraIds || [])) {
    const id = String(extra || "").trim();
    if (!id || byId.has(id)) continue;
    const info = parseModelInfo(id);
    byId.set(info.id, { ...info, isCustom: true });
  }

  const groupsMap = new Map();
  for (const item of byId.values()) {
    const key = item.family || "other";
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        family: key,
        label: item.familyLabel || "其他网关模型",
        tone: item.tone || "slate",
        items: [],
      });
    }
    groupsMap.get(key).items.push(item);
  }

  const groups = Array.from(groupsMap.values());
  groups.sort((a, b) => {
    const ia = FAMILY_ORDER.indexOf(a.family);
    const ib = FAMILY_ORDER.indexOf(b.family);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.label.localeCompare(b.label);
  });
  return groups;
}

/**
 * Build grouped `<option>` / `<optgroup>` markup for model selectors across
 * Group Inspector, Bot Dossier, and Settings.
 */
export function buildModelSelectOptionsHTML(models = [], {
  selected = "",
  defaultModel = "",
  allowInherit = true,
  allowCustom = true,
  compact = false,
  extraIds = [],
} = {}) {
  const cleanSelected = String(selected || "").trim();
  const cleanDefault = String(defaultModel || "").trim();
  const groups = groupModels(models, [cleanSelected, cleanDefault, ...extraIds].filter(Boolean));
  const parts = [];

  if (allowInherit) {
    const defLabel = cleanDefault ? formatModelShort(cleanDefault, models) : "默认模型";
    parts.push(
      `<option value=""${cleanSelected === "" ? " selected" : ""}>跟随全局默认（${escapeHtml(defLabel)}）</option>`,
    );
  }

  for (const group of groups) {
    const opts = group.items.map((m) => {
      const ctx = m.contextLength ? ` · ${formatTokens(m.contextLength)}` : "";
      const tag = m.isCustom ? " [自定义]" : "";
      const idSuffix = !compact && m.displayName !== m.id ? ` (${m.id})` : "";
      const label = `${m.displayName}${idSuffix}${ctx}${tag}`;
      return `<option value="${escapeAttr(m.id)}"${m.id === cleanSelected ? " selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
    parts.push(`<optgroup label="${escapeAttr(group.label)}">${opts}</optgroup>`);
  }

  if (allowCustom) {
    parts.push(`<option value="${CUSTOM_MODEL_VALUE}">+ 输入自定义模型 ID…</option>`);
  }

  return parts.join("");
}

/**
 * Open a clean modal to enter an explicit gateway model ID (no window.prompt).
 * Returns Promise<string | null>.
 */
export function promptCustomModel({ title = "指定网关模型 ID", current = "" } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(val);
    };
    openModal(`
      <div class="modal modal-sm" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div><h2>${escapeHtml(title)}</h2><p>输入网关支持的具体模型标识（如 claude-sonnet-4、gpt-4o、gemini-2.5-pro、qwen-max）</p></div>
          <span class="spacer"></span>
          <button class="modal-close" data-close aria-label="关闭">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label for="cm-id">模型 ID</label>
            <input class="input is-mono" id="cm-id" value="${escapeAttr(current)}" placeholder="例如：claude-sonnet-4 或 openai/gpt-4o" spellcheck="false" autocomplete="off">
            <div class="field-hint">将自动注册到 pi 模型运行时；留空则保持原设置。</div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" data-close>取消</button>
          <button class="btn primary" type="button" id="cm-confirm">应用模型</button>
        </div>
      </div>`, {
      onMount(root) {
        const input = $("#cm-id", root);
        const submit = () => {
          const v = input?.value?.trim() || "";
          done(v || null);
        };
        $("#cm-confirm", root)?.addEventListener("click", submit);
        input?.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); submit(); }
        });
        root.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => done(null)));
        setTimeout(() => { input?.focus(); input?.select?.(); }, 25);
      },
      onClose() {
        if (!settled) { settled = true; resolve(null); }
      },
    });
  });
}
