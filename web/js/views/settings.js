/* Settings — single modal, five sections, DS-Bot-like density. */

import { api } from "../api.js";
import {
  state, updateSettings, refreshBots, reloadHooks, refreshContext, applyTheme,
  uploadAvatar, resetAvatar, refreshHealth, refreshModels, refreshApprovals, pendingApprovalCount,
  refreshSkillProposals, reviewSkillProposal, adoptSkillProposal,
} from "../store.js";
import { avatar, userAvatar, profileFor, escapeHtml } from "../avatars.js";
import {
  ICONS, $, $$, toast, formatTokens, escapeAttr, pickAvatarFile, fileToAvatarDataUrl, relTime, formatTime,
} from "../ui.js";

const NAV = [
  { id: "general", label: "通用", icon: ICONS.settings },
  { id: "bots", label: "机器人", icon: ICONS.users },
  { id: "capabilities", label: "能力", icon: ICONS.tool },
  { id: "proposals", label: "提案", icon: ICONS.spark },
  { id: "approvals", label: "审批", icon: ICONS.bell },
  { id: "usage", label: "用量", icon: ICONS.chart },
  { id: "about", label: "关于", icon: ICONS.info },
];

/* 审批档位：顺序与后端 APPROVAL_MODES 一致（宽松 → 严格）。说明文案取自
 * src/approval.js 的 decideByMode，避免界面承诺后端没有的行为。 */
const APPROVAL_MODES = [
  { id: "yolo", label: "yolo", desc: "全部放行，只有硬地板（如 rm -rf /）仍会被拒绝" },
  { id: "smart", label: "smart", desc: "只读、工作区内写入、构建测试自动放行；写/删/网络/系统命令问审批" },
  { id: "ask", label: "ask", desc: "只有被动只读工具自动放行，其余一律问审批" },
];
const APPROVAL_SCOPES = [
  { id: "once", label: "一次" },
  { id: "session", label: "本会话" },
  { id: "always", label: "永久" },
];
const SCOPE_LABEL = { once: "一次", session: "本会话", always: "永久", floor: "硬地板", breaker: "拒绝熔断", timeout: "超时" };
const DECISION_LABEL = { allow: "批准", deny: "拒绝" };

/* 技能提案（E27 学习闭环）：review 只接受 adopt/reject/defer，状态由后端推导
 * （approved/rejected/deferred/adopted），前端只做展示映射，不自己猜状态。 */
const PROPOSAL_STATUS = {
  proposed: { label: "待评审", cls: "proposed" },
  approved: { label: "已通过", cls: "approved" },
  rejected: { label: "已拒绝", cls: "rejected" },
  deferred: { label: "已延后", cls: "deferred" },
  adopted: { label: "已采纳", cls: "adopted" },
};
const PROPOSAL_FILTERS = [
  { id: "", label: "全部", key: "proposals" },
  { id: "proposed", label: "待评审", key: "proposed" },
  { id: "approved", label: "已通过", key: "approved" },
  { id: "rejected", label: "已拒绝", key: "rejected" },
];

let escHandler = null;

export function openSettings(opts = {}) {
  closeSettings();
  let tab = opts.tab || "general";
  let selectedBot = opts.botId || "ChiefRouter";

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="settings-modal" role="dialog" aria-modal="true"></div>`;
  document.querySelector("#modal-root").appendChild(backdrop);
  const shell = backdrop.querySelector(".settings-modal");

  const close = () => {
    state.skillProposals.open = false;
    if (escHandler) document.removeEventListener("keydown", escHandler);
    escHandler = null;
    backdrop.style.animation = "fade-in .12s reverse";
    setTimeout(() => backdrop.remove(), 120);
  };
  escHandler = (ev) => { if (ev.key === "Escape") close(); };
  document.addEventListener("keydown", escHandler);
  backdrop.addEventListener("mousedown", (ev) => { if (ev.target === backdrop) close(); });

  /* 审批数据不订阅 SSE 重渲染（弹窗自己管节奏），所以进入/回到「审批」分区时
   * 主动补一次；3 秒内刚拉过就跳过，避免 refresh → rerender → refresh 自激。 */
  const ensureApprovals = () => {
    const at = Date.parse(state.approvals?.at || "") || 0;
    if (Date.now() - at < 3000) return;
    refreshApprovals().then(() => render()).catch(() => render());
  };

  /* 技能提案同理：进入分区时补一次，3 秒内刚拉过就跳过（避免自激）。 */
  const ensureProposals = () => {
    const at = Date.parse(state.skillProposals?.at || "") || 0;
    if (Date.now() - at < 3000) return;
    refreshSkillProposals().then(() => render()).catch(() => render());
  };

  const render = () => {
    state.skillProposals.open = tab === "proposals";
    const content = contentFor(tab, selectedBot, { close, rerender: render, setTab: (t) => { tab = t; render(); }, setBot: (id) => { selectedBot = id; render(); } });
    const pending = pendingApprovalCount();
    const proposed = Number(state.skillProposals?.report?.proposed || 0);
    const badgeFor = (n) => {
      if (n.id === "approvals" && pending) return `<span class="nav-count">${pending > 99 ? "99+" : pending}</span>`;
      if (n.id === "proposals" && proposed) return `<span class="nav-count">${proposed > 99 ? "99+" : proposed}</span>`;
      return "";
    };
    shell.innerHTML = `
      <aside class="settings-nav">
        <h2>设置</h2>
        ${NAV.map((n) => `<button class="${tab === n.id ? "is-on" : ""}" data-tab="${n.id}">${n.icon}<span>${n.label}</span>${badgeFor(n)}</button>`).join("")}
        <div class="nav-foot">AgentFusion ${escapeHtml(state.health?.version || "0.1.0")}<br>pi 内核 · 本地运行 · 数据不出机器</div>
      </aside>
      <section class="settings-main">
        ${content}
      </section>`;
    $$("[data-tab]", shell).forEach((btn) => btn.addEventListener("click", () => { tab = btn.dataset.tab; render(); }));
    $("[data-settings-close]", shell)?.addEventListener("click", close);
    bindContent(shell, { close, rerender: render, tab, selectedBot, setBot: (id) => { selectedBot = id; render(); } });
    if (tab === "approvals") ensureApprovals();
    if (tab === "proposals") ensureProposals();
  };
  render();
  return { close };
}

function closeSettings() {
  document.querySelectorAll(".modal-backdrop").forEach((el) => {
    if (el.querySelector(".settings-modal")) el.remove();
  });
  if (escHandler) document.removeEventListener("keydown", escHandler);
  escHandler = null;
}

function header(title, sub) {
  return `<div class="settings-head"><div style="min-width:0"><h2>${escapeHtml(title)}</h2>${sub ? `<div class="set-desc">${escapeHtml(sub)}</div>` : ""}</div><span style="flex:1"></span><button class="modal-close" data-settings-close>${ICONS.close}</button></div>`;
}

function contentFor(tab, selectedBot, ctx) {
  if (tab === "general") return generalTab();
  if (tab === "bots") return botsTab(selectedBot, ctx);
  if (tab === "capabilities") return capabilitiesTab();
  if (tab === "proposals") return proposalsTab();
  if (tab === "approvals") return approvalsTab();
  if (tab === "usage") return usageTab();
  return aboutTab();
}

/* Engine panel — the pi kernel, gateway, data roots and the live model
 * catalogue (/api/models → {object,data,current_model,gateway_url}). */
function engineSection() {
  const s = state.settings || {};
  const h = state.health || {};
  const kernelName = s.kernel || h.kernel || "pi";
  const kernelVersion = s.kernel_version || h.kernel_version || "1.3.0";
  const kernelLabel = String(kernelName).includes(kernelVersion) ? String(kernelName) : `${kernelName} ${kernelVersion}`;
  const gatewayUrl = s.gateway_url || h.gateway_url || "";
  const gatewayOk = typeof h.gateway_ok === "boolean" ? h.gateway_ok : null;
  const dataRoot = s.data_root || h.data_root || "";
  const workspace = s.workspace_root || h.workspace_root || "";
  const models = state.models || [];
  const statusText = gatewayOk === null
    ? "未探测（点击刷新）"
    : gatewayOk
      ? `在线 · ${h.gateway_models || models.length} 个模型`
      : "离线 · 使用本地缓存模型表";
  const dotClass = gatewayOk === null ? "" : gatewayOk ? "ok" : "bad";
  return `
      <div class="settings-section">
        <h3>引擎</h3>
        <div class="set-card">
          <div class="engine-grid">
            <div class="engine-kv"><div class="k">内核</div><div class="v is-text">${escapeHtml(kernelLabel)}</div></div>
            <div class="engine-kv"><div class="k">会话模型</div><div class="v is-text">pi AgentSession · 每成员一个</div></div>
            <div class="engine-kv"><div class="k">网关状态</div><div class="v is-text"><span class="engine-dot ${dotClass}"></span>${escapeHtml(statusText)}</div></div>
            <div class="engine-kv"><div class="k">网关地址</div><div class="v" title="${escapeAttr(gatewayUrl)}">${escapeHtml(gatewayUrl || "未配置")}</div></div>
            <div class="engine-kv"><div class="k">数据目录</div><div class="v" title="${escapeAttr(dataRoot)}">${escapeHtml(dataRoot || "未配置")}</div></div>
            <div class="engine-kv"><div class="k">工作区</div><div class="v" title="${escapeAttr(workspace)}">${escapeHtml(workspace || "未配置")}</div></div>
            <div class="engine-kv"><div class="k">房间 / 成员 / 连接</div><div class="v is-text">${Number(h.rooms || 0)} 群 · ${Number(h.bots || 0)} 成员 · ${Number(h.sse_clients || 0)} 连接</div></div>
            <div class="engine-kv"><div class="k">服务版本</div><div class="v is-text">${escapeHtml(h.version || s.version || "-")}</div></div>
          </div>
          <div class="set-row" style="border-top:1px solid var(--line)">
            <div class="set-copy"><div class="set-name">模型目录</div><div class="set-desc">来自 /api/models；网关不可用时回退本地 models.json</div></div>
            <button class="btn sm" id="engine-refresh">${ICONS.refresh} 刷新引擎信息</button>
          </div>
          <div class="model-list" style="padding:2px 12px 10px">
            ${models.map((m) => `<div class="model-row">
              <span class="model-id">${escapeHtml(m.id)}</span>
              <span class="spacer"></span>
              ${m.context_length ? `<span class="tag">${formatTokens(m.context_length)} ctx</span>` : ""}
              ${m.owned_by ? `<span class="tag">${escapeHtml(m.owned_by)}</span>` : ""}
              ${m.id === (s.model || h.model) ? `<span class="tag accent">当前</span>` : ""}
            </div>`).join("") || `<div class="empty-mini">还没有模型目录（网关不可用时会用本地缓存）。</div>`}
          </div>
        </div>
      </div>`;
}

function generalTab() {
  const s = state.settings || {};
  const models = state.models || [];
  const current = s.model || "";
  const opts = models.map((m) => `<option value="${escapeAttr(m.id)}" ${m.id === current ? "selected" : ""}>${escapeHtml(m.display_name || m.id)} · ${escapeHtml(m.owned_by || "")}</option>`).join("");
  return `
    ${header("通用", "pi 内核、模型与界面")}
    <div class="settings-body">
      ${engineSection()}
      <div class="settings-section">
        <h3>模型</h3>
        <div class="set-card">
          <div class="set-row">
            <div class="set-copy"><div class="set-name">默认模型</div><div class="set-desc">所有成员与 Chief 共用；可在机器人页单独覆盖</div></div>
            <select class="select" id="set-model">${opts || `<option>${escapeHtml(current)}</option>`}</select>
          </div>
          <div class="set-row">
            <div class="set-copy"><div class="set-name">Magpie 网关</div><div class="set-desc">本机模型服务地址，修改后立即生效</div></div>
            <input class="input" id="set-gateway" value="${escapeAttr(s.gateway_url || "http://127.0.0.1:3425/v1")}" spellcheck="false">
          </div>
          <div class="set-row">
            <div class="set-copy"><div class="set-name">工作区</div><div class="set-desc">工具读写、群文件空间的根目录</div></div>
            <div class="set-value" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.workspace_root || "")}</div>
          </div>
          ${window.harnessWindow?.isElectron ? `<div class="set-row">
            <div class="set-copy"><div class="set-name">本地数据</div><div class="set-desc">程序数据、日志与群文件都在 D 盘，不写入系统盘</div></div>
            <div style="display:flex;gap:6px">
              <button class="btn sm" id="open-data">打开数据目录</button>
              <button class="btn sm" id="open-log">查看日志</button>
            </div>
          </div>` : ""}
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn primary sm" id="set-save">保存</button></div>
      </div>

      <div class="settings-section">
        <h3>个人</h3>
        <div class="set-card">
          <div class="set-row">
            <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
              <span id="me-avatar-preview">${userAvatar(40)}</span>
              <div class="set-copy"><div class="set-name">我的头像</div><div class="set-desc">仅本地保存，用于界面里的“你”</div></div>
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn sm" id="me-avatar">更换头像</button>
              <button class="btn sm ghost" id="me-avatar-reset">恢复默认</button>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>界面</h3>
        <div class="set-card">
          <div class="set-row">
            <div class="set-copy"><div class="set-name">外观</div><div class="set-desc">跟随你的使用环境，深浅两套表面</div></div>
            <div class="seg" style="width:180px" id="set-theme">
              <button data-theme-val="light" class="${state.theme === "light" ? "is-on" : ""}">浅色</button>
              <button data-theme-val="dark" class="${state.theme === "dark" ? "is-on" : ""}">深色</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-copy"><div class="set-name">群聊默认上下文</div><div class="set-desc">新建群聊时的默认共享策略</div></div>
            <div class="set-value">共享全文</div>
          </div>
        </div>
      </div>
    </div>`;
}

function botsTab(selectedBot, ctx) {
  const bots = state.bots || [];
  const bot = bots.find((b) => b.id === selectedBot) || bots[0] || { id: "ChiefRouter" };
  const p = profileFor(bot.id, bot);
  const models = state.models || [];
  const modelOpts = models.map((m) => `<option value="${escapeAttr(m.id)}" ${m.id === bot.model ? "selected" : ""}>${escapeHtml(m.display_name || m.id)}</option>`).join("");
  return `
    ${header("机器人", "身份、模型与工具权限")}
    <div class="settings-body">
      <div class="bot-layout">
        <div class="bot-side">
          ${bots.map((b) => {
            const bp = profileFor(b.id, b);
            return `<button class="bot-side-row${b.id === bot.id ? " is-on" : ""}" data-bot-id="${escapeAttr(b.id)}">
              ${avatar(b.id, 28)}
              <span class="bot-side-copy"><span class="bot-name">${escapeHtml(bp.name)}</span><span class="bot-sub">${escapeHtml(bp.role)}</span></span>
            </button>`;
          }).join("")}
        </div>
        <div class="bot-edit">
          <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
            ${avatar(bot.id, 56)}
            <div style="min-width:0;flex:1">
              <div style="font-size:16px;font-weight:600">${escapeHtml(p.name)}</div>
              <div class="set-desc">${escapeHtml(p.tagline && p.tagline.startsWith(p.role) ? p.tagline : `${p.role} · ${p.tagline}`)}</div>
              <div style="display:flex;gap:6px;margin-top:8px">
                <button class="btn sm" id="b-avatar">更换头像</button>
                <button class="btn sm ghost" id="b-avatar-reset">恢复默认</button>
              </div>
            </div>
          </div>
          <div class="field"><label>显示名称</label><input class="input" id="b-name" value="${escapeAttr(p.name)}"></div>
          <div class="field"><label>身份签名</label><input class="input" id="b-tagline" value="${escapeAttr(p.tagline)}" placeholder="用一句话说明它负责什么"></div>
          <div class="field"><label>模型</label><select class="select" id="b-model">${modelOpts || `<option>${escapeHtml(bot.model || "")}</option>`}</select></div>
          <div class="field"><label>思考强度</label><select class="select" id="b-thinking">${["off", "low", "medium", "high"].map((lv) => `<option value="${lv}"${(bot.thinking_level || "off") === lv ? " selected" : ""}>${({ off: "关闭（最快）", low: "低", medium: "中", high: "高（最稳）" })[lv]}</option>`).join("")}</select></div>
          <div class="field"><label>系统提示词</label><textarea class="textarea" id="b-prompt" rows="5">${escapeHtml(bot.system_prompt || "")}</textarea></div>
          <div class="field"><label>已挂载工具</label><div style="display:flex;flex-wrap:wrap;gap:5px">${(bot.allowed_tools || []).map((t) => `<span class="tag" style="height:22px;font-family:var(--mono);font-size:10.5px">${escapeHtml(t)}</span>`).join("") || `<span class="set-desc">无</span>`}</div></div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
            <button class="btn primary sm" id="b-save">保存机器人设置</button>
          </div>
        </div>
      </div>
    </div>`;
}

function capabilitiesTab() {
  const skills = state.skills || [];
  const hooks = state.hooks || {};
  const pre = hooks.PreToolUse || [];
  const post = hooks.PostToolUse || [];
  return `
    ${header("能力", "Skills 与 Hooks")}
    <div class="settings-body">
      <div class="settings-section">
        <h3>Skills 技能库 · ${skills.length}</h3>
        <div class="set-card">
          ${skills.map((s) => `<div class="skill-card">
            <div class="skill-top"><span class="skill-name">${escapeHtml(s.name)}</span><span class="tag ${s.source === "workspace" ? "accent" : ""}">${s.source === "workspace" ? "工作区" : "内置"}</span></div>
            <div class="skill-desc">${escapeHtml(s.description || "")}</div>
            <div class="skill-when">${escapeHtml(s.when_to_use || "")}</div>
          </div>`).join("") || `<div class="empty-mini">还没有技能。把 SKILL.md 放到工作区 .agentharness/skills/ 下即可。</div>`}
        </div>
      </div>
      <div class="settings-section">
        <h3>Hooks 治理</h3>
        <div class="set-card">
          ${[...pre.map((h) => ({ ...h, kind: "PreToolUse" })), ...post.map((h) => ({ ...h, kind: "PostToolUse" }))].map((h) => `<div class="hook-row">
            <span class="hook-kind">${h.kind}</span>
            <div class="hook-body"><div class="hook-name">${escapeHtml(h.matcher || "*")} → ${escapeHtml(h.action || "")}</div><div class="hook-detail">${escapeHtml(h.reason || "无备注")}</div></div>
          </div>`).join("") || `<div class="empty-mini">没有配置 Hook。</div>`}
          <div class="set-row">
            <div class="set-copy"><div class="set-name">配置来源</div><div class="set-desc">${escapeHtml(hooks.config_path || "")}</div></div>
            <button class="btn sm" id="hooks-reload">${ICONS.refresh} 重新加载</button>
          </div>
        </div>
      </div>
    </div>`;
}

/* 审批 — 模式、待裁决列表与最近审计（端点见 src/api/server.js E26）。
 * scope 语义：once 用掉即失效、session 在本 (roomId,botId) 内按 patternKey 放行、
 * always 写进 appr_cache 且跨重启生效；拒绝会累计熔断计数（默认连续 3 次）。 */
function approvalsTab() {
  const a = state.approvals || {};
  const mode = APPROVAL_MODES.some((m) => m.id === a.mode) ? a.mode : "yolo";
  const modeDesc = APPROVAL_MODES.find((m) => m.id === mode)?.desc || "";
  const pending = Array.isArray(a.approvals) ? a.approvals : [];
  const audit = Array.isArray(a.audit) ? a.audit : [];
  const stats = a.stats || {};
  const updated = a.at ? `上次刷新 ${relTime(a.at)}` : "尚未刷新";
  const expired = Number(stats.expired || 0);
  return `
    ${header("审批", "工具调用的裁决、模式与来源留痕")}
    <div class="settings-body">
      ${a.error ? `<div class="appr-error">审批端点不可用：${escapeHtml(a.error)}</div>` : ""}
      <div class="settings-section">
        <h3>审批模式</h3>
        <div class="set-card">
          <div class="set-row">
            <div class="set-copy">
              <div class="set-name">工具调用档位</div>
              <div class="set-desc">${escapeHtml(modeDesc)}</div>
            </div>
            <div class="seg appr-mode" id="appr-mode">
              ${APPROVAL_MODES.map((m) => `<button type="button" data-mode="${m.id}" class="${m.id === mode ? "is-on" : ""}" title="${escapeAttr(m.desc)}">${m.label}</button>`).join("")}
            </div>
          </div>
          <div class="set-row">
            <div class="set-copy">
              <div class="set-name">请求统计</div>
              <div class="set-desc">全局口径，含已过期与已撤回的请求</div>
            </div>
            <div class="set-value">${Number(stats.pending || 0)} 待裁决 · ${Number(stats.approved || 0)} 已批准 · ${Number(stats.denied || 0)} 已拒绝${expired ? ` · ${expired} 已过期` : ""}</div>
          </div>
          <div class="set-row">
            <div class="set-copy"><div class="set-name">刷新</div><div class="set-desc">${escapeHtml(updated)}；裁决后自动刷新</div></div>
            <button class="btn sm" id="appr-refresh">${ICONS.refresh} 刷新</button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>待裁决 · ${pending.length}</h3>
        <div class="set-card" id="appr-pending">
          ${pending.length ? pending.map(approvalRowHTML).join("") : `<div class="appr-empty">当前没有待裁决请求</div>`}
        </div>
      </div>

      <div class="settings-section">
        <h3>最近裁决 · ${audit.length}</h3>
        <div class="set-card">
          ${audit.length ? audit.map(auditRowHTML).join("") : `<div class="appr-empty">还没有裁决记录。批准或拒绝一次后，这里会留下范围、裁决人与时间。</div>`}
        </div>
      </div>
    </div>`;
}

function approvalRowHTML(a) {
  const room = a.room_id ? (state.roomById[a.room_id]?.title || a.room_id) : "未绑定群聊";
  const meta = [
    `群聊 · ${room}`,
    a.bot_id ? `成员 ${a.bot_id}` : "未知成员",
    relTime(a.created_at) || formatTime(a.created_at),
    expiryText(a.expires_at),
  ].filter(Boolean).join(" · ");
  const inputText = summariseApprovalInput(a.input);
  return `<div class="set-row appr-row" data-appr-id="${escapeAttr(a.id)}" data-approval-scope="once">
    <div class="set-copy">
      <div class="set-name appr-tool">${escapeHtml(a.tool || "未知工具")}</div>
      <div class="set-desc">${escapeHtml(a.reason || "未说明原因")}</div>
      ${inputText ? `<div class="appr-input" title="${escapeAttr(inputText)}">${escapeHtml(inputText)}</div>` : ""}
      <div class="appr-meta">${escapeHtml(meta)}</div>
    </div>
    <div class="appr-actions">
      <div class="seg appr-scope">
        ${APPROVAL_SCOPES.map((s) => `<button type="button" data-scope="${s.id}" class="${s.id === "once" ? "is-on" : ""}">${s.label}</button>`).join("")}
      </div>
      <button class="btn sm primary" data-act="allow">批准</button>
      <button class="btn sm danger" data-act="deny">拒绝</button>
    </div>
  </div>`;
}

function summariseApprovalInput(input) {
  if (!input || typeof input !== "object") return "";
  let text = "";
  try { text = Object.keys(input).length ? JSON.stringify(input) : ""; } catch { text = ""; }
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

function expiryText(expiresAt) {
  if (!expiresAt) return "";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "已过期";
  const minutes = Math.round(ms / 60000);
  if (minutes >= 1) return `${minutes} 分钟后过期`;
  return `${Math.max(1, Math.round(ms / 1000))} 秒后过期`;
}

function auditRowHTML(r) {
  const decision = DECISION_LABEL[r.decision] || r.decision || "—";
  const scope = SCOPE_LABEL[r.scope] || r.scope || "—";
  const when = relTime(r.ts) || formatTime(r.ts) || "";
  return `<div class="set-row appr-audit-row">
    <span class="tag ${r.decision === "allow" ? "green" : "red"}">${escapeHtml(decision)}</span>
    <div class="set-copy">
      <div class="set-name">${escapeHtml(r.tool || "—")} <span class="appr-audit-scope">${escapeHtml(scope)}</span></div>
      <div class="set-desc">${escapeHtml(r.reason || "无备注")}</div>
    </div>
    <div class="appr-audit-meta">${escapeHtml([r.by || "user", r.mode ? `${r.mode} 模式` : "", when].filter(Boolean).join(" · "))}</div>
  </div>`;
}

/* 技能提案（E27 学习闭环）：真实回合里由 curator 自动 propose，人工 review 后
 * adopt 落盘。两段式采纳见 adoptSkillProposal（review(adopt) → adopt），
 * guard 只会在 adopt 阶段拦，界面必须把拒绝原因原样展示。 */
function proposalsTab() {
  const s = state.skillProposals || {};
  const proposals = Array.isArray(s.proposals) ? s.proposals : [];
  const report = s.report || {};
  const status = s.status || "";
  const updated = s.at ? `上次刷新 ${relTime(s.at)}` : "尚未刷新";
  const counts = {};
  for (const filter of PROPOSAL_FILTERS) counts[filter.id] = Number(report[filter.key] || 0);
  return `
    ${header("技能提案", "学习闭环：把真实回合里总结出的 playbook 变成可复用技能")}
    <div class="settings-body">
      ${s.error ? `<div class="appr-error">技能提案端点不可用：${escapeHtml(s.error)}</div>` : ""}
      <div class="settings-section">
        <h3>筛选与刷新</h3>
        <div class="set-card">
          <div class="set-row">
            <div class="set-copy">
              <div class="set-name">状态</div>
              <div class="set-desc">共 ${Number(report.proposals || 0)} 条提案 · 已采纳 ${Number(report.adopted || 0)} 条 · 由真实回合自动沉淀，采纳后写入技能目录</div>
            </div>
            <div class="seg prop-filter" id="prop-filter">
              ${PROPOSAL_FILTERS.map((f) => `<button type="button" data-prop-status="${f.id}" class="${status === f.id ? "is-on" : ""}">${f.label}${counts[f.id] ? ` ${counts[f.id]}` : ""}</button>`).join("")}
            </div>
          </div>
          <div class="set-row">
            <div class="set-copy"><div class="set-name">刷新</div><div class="set-desc">${escapeHtml(updated)}；房间产生新提案时（SSE）本面板打开会自动刷新</div></div>
            <button class="btn sm" id="prop-refresh">${ICONS.refresh} 刷新</button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>提案 · ${proposals.length}</h3>
        <div class="set-card prop-list" id="prop-list">
          ${proposals.length ? proposals.map(proposalCardHTML).join("") : `<div class="appr-empty">${escapeHtml(emptyProposalText(status))}</div>`}
        </div>
      </div>
    </div>`;
}

function emptyProposalText(status) {
  if (status === "proposed") return "当前没有待评审的提案。成员在真实回合里总结出可复用流程时，这里会自动出现。";
  if (status === "approved") return "没有已通过但尚未落盘的提案。";
  if (status === "rejected") return "没有已拒绝的提案。";
  return "还没有任何技能提案。等一轮真实协作结束，学习闭环会把经验沉淀到这里。";
}

function proposalCardHTML(p) {
  const meta = PROPOSAL_STATUS[p.status] || { label: p.status || "未知", cls: "proposed" };
  const roomLabel = p.roomId ? (state.roomById[p.roomId]?.title || p.roomId) : "未绑定群聊";
  const botName = p.botId ? profileFor(p.botId, state.botsById?.[p.botId]).name : "";
  const tags = (p.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
  const fileIds = [...new Set((p.evidence || []).flatMap((e) => e.file_ids || []))];
  const fileChips = fileIds.slice(0, 6).map((id) => `<span class="prop-file" title="${escapeAttr(id)}">#${escapeHtml(String(id).slice(0, 8))}</span>`).join("");
  const moreFiles = fileIds.length > 6 ? `<span class="prop-file-more">+${fileIds.length - 6}</span>` : "";
  const rounds = (p.evidence || []).filter((e) => e.round_id).length;
  const canAct = p.status !== "adopted";
  const adoptedLine = p.status === "adopted" && p.skill
    ? `<div class="prop-adopted">${ICONS.checkCircle}<span>已安装技能 <code>${escapeHtml(p.skill)}</code></span>${p.adoptedAt ? `<span class="prop-adopted-time">${escapeHtml(relTime(p.adoptedAt))}</span>` : ""}</div>`
    : "";
  const guardLine = p.guardVerdict && p.guardVerdict !== "allow" && p.status !== "adopted"
    ? `<div class="prop-guard">${ICONS.info}<span>上次落盘被 guard 判定为「${escapeHtml(p.guardVerdict)}」${p.reason ? `：${escapeHtml(p.reason)}` : ""}</span></div>`
    : "";
  // 人工评审意见（reject/defer/approve 时写入）；guard 阻断也复用 reason，已在上面单独展示。
  const reviewLine = p.reason && ["rejected", "deferred", "approved"].includes(p.status)
    ? `<div class="prop-review"><span class="prop-review-label">评审意见</span>${escapeHtml(p.reason)}${p.reviewedBy ? `<span class="prop-review-by">· ${escapeHtml(p.reviewedBy)}</span>` : ""}</div>`
    : "";
  return `<div class="prop-card" data-proposal-id="${escapeAttr(p.id)}">
    <div class="prop-head">
      <span class="prop-status is-${meta.cls}">${escapeHtml(meta.label)}</span>
      <span class="prop-title" title="${escapeAttr(p.title || "")}">${escapeHtml(p.title || "（无标题）")}</span>
      <span class="spacer"></span>
      <span class="prop-time">${escapeHtml(relTime(p.createdAt) || formatTime(p.createdAt))}</span>
    </div>
    <div class="prop-meta">
      <span>来源 ${escapeHtml(roomLabel)}</span>
      ${botName ? `<span>· 提出者 ${escapeHtml(botName)}</span>` : ""}
      ${rounds ? `<span>· 基于 ${rounds} 个回合</span>` : ""}
      ${tags ? `<span class="prop-tags">${tags}</span>` : ""}
    </div>
    <div class="prop-body" data-prop-body>${escapeHtml(p.body || "")}</div>
    <button class="prop-more" type="button" data-prop-act="toggle">${ICONS.chevron} 展开全文</button>
    ${fileChips ? `<div class="prop-evidence"><span class="prop-ev-label">证据</span>${fileChips}${moreFiles}</div>` : ""}
    ${reviewLine}
    ${adoptedLine}
    ${guardLine}
    ${canAct ? `<div class="prop-actions">
      <input class="input prop-reason" data-prop-reason placeholder="拒绝/延后原因（可选）" maxlength="120">
      <button class="btn sm primary" data-prop-act="adopt">采纳</button>
      <button class="btn sm" data-prop-act="reject">拒绝</button>
      <button class="btn sm ghost" data-prop-act="defer">延后</button>
    </div>` : ""}
  </div>`;
}

function usageTab() {
  const ctx = state.context || {};
  const stats = state.stats || {};
  const tokens = stats.tokens || ctx.tokens_total || {};
  const counts = stats.counts || {};
  const totalPrompt = tokens.prompt || 0;
  const totalCompletion = tokens.completion || 0;
  const cacheRate = Math.round((tokens.cache_read || 0) / Math.max(1, (tokens.prompt || 0) + (tokens.cache_read || 0)) * 100);
  const dist = ctx.distribution || {};
  const distTotal = Math.max(1, (dist.system || 0) + (dist.user || 0) + (dist.assistant || 0) + (dist.tool || 0));
  const msgCount = (state.rooms || []).reduce((sum, room) => sum + (room.message_count || 0), 0);
  const botRows = (ctx.bots || []).slice().sort((a, b) => (b.tokens || 0) - (a.tokens || 0));
  const maxBotTokens = Math.max(1, ...botRows.map((b) => b.tokens || 0));
  return `
    ${header("用量", "Token、缓存与成员消耗")}
    <div class="settings-body">
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-label">本次运行输入</div><div class="stat-value">${formatTokens(totalPrompt)}<small>tok</small></div><div class="stat-sub">含缓存读取</div></div>
        <div class="stat-card"><div class="stat-label">本次运行输出</div><div class="stat-value">${formatTokens(totalCompletion)}<small>tok</small></div><div class="stat-sub">全部成员</div></div>
        <div class="stat-card"><div class="stat-label">缓存命中</div><div class="stat-value">${cacheRate}<small>%</small></div><div class="stat-sub">${formatTokens(tokens.cache_read)} tok</div></div>
        <div class="stat-card"><div class="stat-label">群聊与消息</div><div class="stat-value">${counts.rooms || (state.rooms || []).length}<small>群</small></div><div class="stat-sub">${msgCount} 条群消息</div></div>
      </div>

      <div class="settings-section">
        <h3>当前上下文构成</h3>
        <div class="set-card"><div class="bar-list">
          ${[["系统", dist.system, "var(--text-3)"], ["用户", dist.user, "var(--accent)"], ["助手", dist.assistant, "var(--green)"], ["工具", dist.tool, "var(--amber)"]].map(([name, val, color]) => `<div class="bar-row">
            <span class="bar-name">${name}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${Math.round((val || 0) / distTotal * 100)}%;background:${color}"></span></span>
            <span class="bar-value">${formatTokens(val)}</span>
          </div>`).join("")}
        </div></div>
      </div>

      <div class="settings-section">
        <h3>成员上下文占用</h3>
        <div class="set-card"><div class="bar-list">
          ${botRows.map((b) => {
            const p = profileFor(b.bot_id, state.botsById[b.bot_id]);
            return `<div class="bar-row">
              ${avatar(b.bot_id, 22)}
              <span class="bar-name">${escapeHtml(p.name)}</span>
              <span class="bar-track"><span class="bar-fill" style="width:${Math.round((b.tokens || 0) / maxBotTokens * 100)}%"></span></span>
              <span class="bar-value">${formatTokens(b.tokens)} tok</span>
            </div>`;
          }).join("") || `<div class="empty-mini">还没有成员上下文记录</div>`}
        </div></div>
      </div>
    </div>`;
}

function aboutTab() {
  const h = state.health || {};
  const s = state.settings || {};
  const kernelName = s.kernel || h.kernel || "pi";
  const kernelVersion = s.kernel_version || h.kernel_version || "1.3.0";
  const kernelLabel = String(kernelName).includes(kernelVersion) ? String(kernelName) : `${kernelName} ${kernelVersion}`;
  const dataRoot = s.data_root || h.data_root || "";
  const gateway = s.gateway_url || h.gateway_url || "";
  return `
    ${header("关于", "群聊智能体工作台 · pi 内核")}
    <div class="settings-body">
      <div style="display:flex;align-items:center;gap:16px;padding:10px 0 20px">
        <span class="avatar has-emoji" style="width:56px;height:56px;background:var(--accent-soft);font-size:26px" aria-hidden="true">🧠</span>
        <div>
          <div style="font-size:18px;font-weight:600">AgentFusion</div>
          <div class="set-desc">群聊智能体工作台 · pi 内核</div>
        </div>
      </div>
      <div class="set-card">
        <div class="set-row"><div class="set-copy"><div class="set-name">内核</div><div class="set-desc">${escapeHtml(kernelLabel)}（@earendil-works/pi-coding-agent）：工具循环、会话分支、上下文压缩、技能与扩展</div></div><div class="set-value">${escapeHtml(kernelVersion)}</div></div>
        <div class="set-row"><div class="set-copy"><div class="set-name">运行方式</div><div class="set-desc">Electron 桌面壳 + 本地 Node 服务；前端纯静态（ES module、无构建、无外网资源）</div></div></div>
        <div class="set-row"><div class="set-copy"><div class="set-name">数据目录</div><div class="set-desc">${escapeHtml(dataRoot || "D:\\AgentFusion")}</div></div></div>
        <div class="set-row"><div class="set-copy"><div class="set-name">模型网关</div><div class="set-desc">${escapeHtml(gateway || "http://127.0.0.1:3425/v1")}</div></div></div>
        <div class="set-row"><div class="set-copy"><div class="set-name">群聊构想</div><div class="set-desc">群主赋权与分派 · 上下文共享策略 · 群文件空间按 file_id 同步 · 小群结论回报</div></div></div>
        <div class="set-row"><div class="set-copy"><div class="set-name">致谢</div><div class="set-desc">群聊协作模型参考 DS-Bot 的公开设计；头像与界面素材为本项目原创</div></div></div>
      </div>
    </div>`;
}

function bindContent(root, ctx) {
  if (ctx.tab === "general") {
    $("#open-data", root)?.addEventListener("click", () => window.harnessWindow?.openDataDir?.());
    $("#open-log", root)?.addEventListener("click", () => window.harnessWindow?.openLog?.());
    $("#me-avatar", root)?.addEventListener("click", async () => {
      const file = await pickAvatarFile();
      if (!file) return;
      try {
        const data = await fileToAvatarDataUrl(file);
        await uploadAvatar("user", "me", data);
        toast("头像已更新", "success");
        ctx.rerender();
      } catch (err) { toast(`头像更新失败：${err.message}`, "error"); }
    });
    $("#me-avatar-reset", root)?.addEventListener("click", async () => {
      try { await resetAvatar("user", "me"); toast("已恢复默认头像"); ctx.rerender(); }
      catch (err) { toast(`恢复失败：${err.message}`, "error"); }
    });
    $$("[data-theme-val]", root).forEach((btn) => {
      btn.addEventListener("click", () => {
        applyTheme(btn.dataset.themeVal);
        $$("[data-theme-val]", root).forEach((b) => b.classList.toggle("is-on", b === btn));
      });
    });
    $("#engine-refresh", root)?.addEventListener("click", async () => {
      await Promise.allSettled([refreshHealth(), refreshModels()]);
      toast("引擎信息已刷新", "success");
      ctx.rerender();
    });
    $("#set-save", root)?.addEventListener("click", async () => {
      const model = $("#set-model", root)?.value;
      const gateway_url = $("#set-gateway", root)?.value?.trim();
      try {
        await updateSettings({ ...(model ? { model } : {}), ...(gateway_url ? { gateway_url } : {}) });
        toast("设置已保存", "success");
        refreshContext();
      } catch (err) { toast(`保存失败：${err.message}`, "error"); }
    });
  }
  if (ctx.tab === "bots") {
    $$("[data-bot-id]", root).forEach((btn) => btn.addEventListener("click", () => ctx.setBot(btn.dataset.botId)));
    $("#b-avatar", root)?.addEventListener("click", async () => {
      const file = await pickAvatarFile();
      if (!file) return;
      try {
        const data = await fileToAvatarDataUrl(file);
        await uploadAvatar("bot", ctx.selectedBot, data);
        toast("头像已更新", "success");
        ctx.rerender();
      } catch (err) { toast(`头像更新失败：${err.message}`, "error"); }
    });
    $("#b-avatar-reset", root)?.addEventListener("click", async () => {
      try { await resetAvatar("bot", ctx.selectedBot); toast("已恢复默认头像"); ctx.rerender(); }
      catch (err) { toast(`恢复失败：${err.message}`, "error"); }
    });
    $("#b-save", root)?.addEventListener("click", async () => {
      const id = ctx.selectedBot;
      const payload = {
        name: $("#b-name", root).value.trim(),
        tagline: $("#b-tagline", root).value.trim(),
        model: $("#b-model", root).value,
        thinking_level: $("#b-thinking", root).value,
        system_prompt: $("#b-prompt", root).value,
      };
      try {
        await api.updateBot(id, payload);
        await refreshBots();
        toast("机器人设置已保存", "success");
        ctx.rerender();
      } catch (err) { toast(`保存失败：${err.message}`, "error"); }
    });
  }
  if (ctx.tab === "capabilities") {
    $("#hooks-reload", root)?.addEventListener("click", async () => {
      try { await reloadHooks(); toast("Hooks 已重新加载", "success"); ctx.rerender(); }
      catch (err) { toast(`重载失败：${err.message}`, "error"); }
    });
  }
  if (ctx.tab === "approvals") {
    const doRefresh = async (message, kind = "success") => {
      await refreshApprovals();
      if (message) toast(message, kind);
      ctx.rerender();
    };

    $("#appr-mode", root)?.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-mode]");
      if (!btn || btn.classList.contains("is-on")) return;
      const mode = btn.dataset.mode;
      $$("[data-mode]", root).forEach((b) => { b.disabled = true; });
      try {
        const res = await api.setApprovalMode(mode, "");
        if (res && res.ok === false) throw new Error(res.error || "切换失败");
        await doRefresh(`审批模式已切换为 ${mode}`);
      } catch (err) {
        $$("[data-mode]", root).forEach((b) => { b.disabled = false; });
        toast(`模式切换失败：${err.message}`, "error");
      }
    });

    $("#appr-refresh", root)?.addEventListener("click", async (ev) => {
      ev.currentTarget.disabled = true;
      await doRefresh("审批列表已刷新");
    });

    /* 事件委托：每行先选 scope（once/session/always），再点批准/拒绝。
     * 行的当前 scope 存在 data-approval-scope，避免和按钮的 data-scope 混淆
     * （否则 closest("[data-scope]") 会先命中整行，把批准点击吞掉）。 */
    $("#appr-pending", root)?.addEventListener("click", async (ev) => {
      const scopeBtn = ev.target.closest("button[data-scope]");
      if (scopeBtn) {
        const row = scopeBtn.closest("[data-appr-id]");
        if (!row) return;
        $$("[data-scope]", row).forEach((b) => b.classList.toggle("is-on", b === scopeBtn));
        row.dataset.approvalScope = scopeBtn.dataset.scope;
        return;
      }
      const actionBtn = ev.target.closest("[data-act]");
      if (!actionBtn) return;
      const row = actionBtn.closest("[data-appr-id]");
      const id = row?.dataset.apprId;
      if (!id) return;
      const decision = actionBtn.dataset.act;
      const scope = row.dataset.approvalScope || "once";
      $$("[data-act]", row).forEach((b) => { b.disabled = true; });
      try {
        const res = await api.resolveApproval(id, { decision, scope });
        if (res && res.ok === false) throw new Error(res.error || "裁决失败");
        const label = SCOPE_LABEL[scope] || scope;
        await doRefresh(decision === "allow" ? `已批准（${label}）` : `已拒绝（${label}）`);
      } catch (err) {
        const message = String(err?.message || err);
        if (message.includes("already_resolved")) {
          // 另一端已经裁决 / 已过期：不是错误，刷新后提示即可。
          await doRefresh("这条审批已经被处理过了", "info");
        } else {
          $$("[data-act]", row).forEach((b) => { b.disabled = false; });
          toast(`裁决失败：${message}`, "error");
        }
      }
    });
  }
  if (ctx.tab === "proposals") {
    const doRefresh = async (message, kind = "success") => {
      await refreshSkillProposals();
      if (message) toast(message, kind);
      ctx.rerender();
    };

    $("#prop-filter", root)?.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-prop-status]");
      if (!btn) return;
      const next = btn.dataset.propStatus || "";
      if (next === (state.skillProposals?.status || "")) return;
      $$("[data-prop-status]", root).forEach((b) => { b.disabled = true; });
      await refreshSkillProposals(next);
      ctx.rerender();
    });

    $("#prop-refresh", root)?.addEventListener("click", async (ev) => {
      ev.currentTarget.disabled = true;
      await doRefresh("技能提案已刷新");
    });

    /* 事件委托：展开正文 / 采纳（两段式）/ 拒绝 / 延后。 */
    $("#prop-list", root)?.addEventListener("click", async (ev) => {
      const toggle = ev.target.closest('[data-prop-act="toggle"]');
      if (toggle) {
        const card = toggle.closest("[data-proposal-id]");
        const expanded = card.classList.toggle("is-expanded");
        toggle.innerHTML = `${ICONS.chevron} ${expanded ? "收起" : "展开全文"}`;
        return;
      }
      const actionBtn = ev.target.closest("[data-prop-act]");
      if (!actionBtn) return;
      const card = actionBtn.closest("[data-proposal-id]");
      const id = card?.dataset.proposalId;
      if (!id) return;
      const action = actionBtn.dataset.propAct;
      const reason = $("[data-prop-reason]", card)?.value?.trim() || "";
      $$("button", card).forEach((b) => { b.disabled = true; });

      if (action === "adopt") {
        actionBtn.textContent = "采纳中…";
        const result = await adoptSkillProposal(id, { by: "user" });
        if (result.ok) {
          const slug = result.skill?.slug || result.skill?.name || "";
          toast(slug ? `已安装技能 ${slug}` : "技能已安装", "success");
        } else {
          const stage = result.stage === "review" ? "批准" : "落盘";
          toast(`${stage}失败：${result.error}`, "error");
        }
        await doRefresh(); // 无论成败都以后端状态为准（guard 阻断会把原因写回提案）
        return;
      }

      const decision = action === "reject" ? "reject" : "defer";
      try {
        await reviewSkillProposal(id, { decision, reason, by: "user" });
        await doRefresh(decision === "reject" ? "已拒绝该提案" : "已延后该提案", decision === "reject" ? "info" : "success");
      } catch (err) {
        $$("button", card).forEach((b) => { b.disabled = false; });
        toast(`${decision === "reject" ? "拒绝" : "延后"}失败：${err.message}`, "error");
      }
    });
  }
}
