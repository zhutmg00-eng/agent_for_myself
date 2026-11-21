/* Settings — modern multi-tab modal (Milestone 2 Architecture). */

import { api } from "../api.js";
import {
  state, updateSettings, refreshBots, refreshRooms, reloadHooks, refreshContext, applyTheme,
  uploadAvatar, resetAvatar, refreshHealth, refreshModels, refreshApprovals, pendingApprovalCount,
  refreshSkillProposals, reviewSkillProposal, adoptSkillProposal,
  refreshAutomation, setAutomationKill,
} from "../store.js";
import { avatar, userAvatar, profileFor, escapeHtml, brandMarkSvg } from "../avatars.js";
import {
  ICONS, $, $$, toast, formatTokens, escapeAttr, pickAvatarFile, fileToAvatarDataUrl, relTime, formatTime, debounce,
} from "../ui.js";
import {
  groupModels, formatModelShort, buildModelSelectOptionsHTML, promptCustomModel, CUSTOM_MODEL_VALUE,
} from "../models.js";

export const NAV = [
  { id: "general", label: "通用", icon: ICONS.settings },
  { id: "perf", label: "性能监控", icon: ICONS.activity },
  { id: "approvals", label: "审批", icon: ICONS.bell },
  { id: "skills", label: "技能与提案", icon: ICONS.tool },
  { id: "memory", label: "记忆", icon: ICONS.spark },
  { id: "usage", label: "用量与遥测", icon: ICONS.chart },
  { id: "bots", label: "机器人", icon: ICONS.users },
  { id: "about", label: "关于", icon: ICONS.info },
];

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
let modelFilterQuery = "";
let memoryViewState = { loaded: false, loading: false, query: "", entries: [], stats: null, results: null, error: "" };

let perfPollTimer = null;
let perfChartsModPromise = null;
let perfChartsMod = null;
let perfMountEl = null;
let perfState = {
  paused: false,
  loading: false,
  error: "",
  data: null,
};

function stopPerfMonitor() {
  if (perfPollTimer) {
    clearInterval(perfPollTimer);
    perfPollTimer = null;
  }
  if (perfMountEl && perfChartsMod?.unmountPerfCharts) {
    perfChartsMod.unmountPerfCharts(perfMountEl);
  }
  perfMountEl = null;
}

function loadPerfChartsModule() {
  if (perfChartsMod) return Promise.resolve(perfChartsMod);
  if (!perfChartsModPromise) {
    perfChartsModPromise = import("/static/js/perf_charts.bundle.js").then((mod) => {
      perfChartsMod = mod;
      return mod;
    });
  }
  return perfChartsModPromise;
}

export function openSettings(opts = {}) {
  closeSettings();
  let rawTab = opts.tab || "general";
  if (rawTab === "capabilities" || rawTab === "proposals") rawTab = "skills";
  if (rawTab === "telemetry") rawTab = "usage";
  if (rawTab === "performance") rawTab = "perf";
  let tab = rawTab;
  let selectedBot = opts.botId || "ChiefRouter";

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop settings-backdrop";
  backdrop.innerHTML = `<div class="settings-modal" role="dialog" aria-modal="true"></div>`;
  const modalRoot = document.querySelector("#modal-root") || document.body;
  modalRoot.appendChild(backdrop);
  const shell = backdrop.querySelector(".settings-modal");

  const close = () => {
    stopPerfMonitor();
    state.skillProposals.open = false;
    if (escHandler) document.removeEventListener("keydown", escHandler);
    escHandler = null;
    backdrop.style.pointerEvents = "none";
    backdrop.style.animation = "fade-in .12s reverse";
    setTimeout(() => backdrop.remove(), 120);
  };
  escHandler = (ev) => {
    if (ev.key === "Escape") {
      if (document.querySelector(".modal-backdrop:not(.settings-backdrop)")) return;
      close();
    }
  };
  document.addEventListener("keydown", escHandler);
  backdrop.addEventListener("mousedown", (ev) => { if (ev.target === backdrop) close(); });

  const ensureApprovals = () => {
    const at = Date.parse(state.approvals?.at || "") || 0;
    if (Date.now() - at < 3000) return;
    refreshApprovals().then(() => render()).catch(() => render());
  };

  const ensureProposals = () => {
    const at = Date.parse(state.skillProposals?.at || "") || 0;
    if (Date.now() - at < 3000) return;
    refreshSkillProposals().then(() => render()).catch(() => render());
  };

  const ensureMemory = () => {
    if (memoryViewState.loading) return;
    if (memoryViewState.loaded && !memoryViewState.error) return;
    memoryViewState.loading = true;
    api.memory(50).then((res) => {
      memoryViewState.loaded = true;
      memoryViewState.loading = false;
      memoryViewState.entries = Array.isArray(res?.entries) ? res.entries : [];
      memoryViewState.stats = res?.stats || null;
      memoryViewState.error = "";
      if (tab === "memory") render();
    }).catch((err) => {
      memoryViewState.loaded = true;
      memoryViewState.loading = false;
      memoryViewState.error = err?.message || "记忆服务不可用";
      if (tab === "memory") render();
    });
  };

  const render = () => {
    stopPerfMonitor();
    state.skillProposals.open = tab === "skills";
    const content = contentFor(tab, selectedBot, { close, rerender: render, setTab: (t) => { tab = t; render(); }, setBot: (id) => { selectedBot = id; render(); } });
    const pending = pendingApprovalCount();
    const proposed = Number(state.skillProposals?.report?.proposed || 0);
    const badgeFor = (n) => {
      if (n.id === "approvals" && pending) return `<span class="nav-count">${pending > 99 ? "99+" : pending}</span>`;
      if (n.id === "skills" && proposed) return `<span class="nav-count">${proposed > 99 ? "99+" : proposed}</span>`;
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
    if (tab === "skills") ensureProposals();
    if (tab === "memory") ensureMemory();
  };
  render();
  return { close };
}

export function closeSettings() {
  stopPerfMonitor();
  document.querySelectorAll(".modal-backdrop").forEach((el) => {
    if (el.querySelector(".settings-modal")) {
      el.style.pointerEvents = "none";
      el.remove();
    }
  });
  if (escHandler) document.removeEventListener("keydown", escHandler);
  escHandler = null;
}

function header(title, sub) {
  return `<div class="settings-head"><div style="min-width:0"><h2>${escapeHtml(title)}</h2>${sub ? `<div class="set-desc">${escapeHtml(sub)}</div>` : ""}</div><span style="flex:1"></span><button class="modal-close" data-settings-close>${ICONS.close}</button></div>`;
}

function contentFor(tab, selectedBot, ctx) {
  if (tab === "general") return generalTab();
  if (tab === "perf") return perfTab();
  if (tab === "approvals") return approvalsTab();
  if (tab === "skills") return skillsTab();
  if (tab === "memory") return memoryTab();
  if (tab === "usage") return usageTab();
  if (tab === "bots") return botsTab(selectedBot, ctx);
  return aboutTab();
}

function renderModelCatalogHTML(models, currentModel, filterQuery = "") {
  const q = String(filterQuery || "").trim().toLowerCase();
  const botExtras = (state.bots || []).map((b) => b.model_override).filter(Boolean);
  const groups = groupModels(models, [currentModel, ...botExtras].filter(Boolean));
  const filteredGroups = groups
    .map((g) => ({
      ...g,
      items: g.items.filter((m) => !q || `${m.id} ${m.displayName} ${m.familyLabel} ${m.ownedBy}`.toLowerCase().includes(q)),
    }))
    .filter((g) => g.items.length > 0);

  if (!filteredGroups.length) {
    return `<div class="empty-mini">${q ? "没有匹配筛选条件的模型。" : "还没有模型目录（网关不可用时会用本地缓存）。"}</div>`;
  }

  return filteredGroups.map((g) => `
    <div class="model-group">
      <div class="model-group-head">
        <span class="model-group-name">${escapeHtml(g.label)}</span>
        <span class="model-group-count">${g.items.length}</span>
      </div>
      ${g.items.map((m) => {
        const isCurrent = m.id === currentModel;
        return `<div class="model-row${isCurrent ? " is-default" : ""}">
          <div class="model-row-copy">
            <span class="model-display">${escapeHtml(m.displayName)}</span>
            ${m.displayName !== m.id ? `<span class="model-id">${escapeHtml(m.id)}</span>` : ""}
          </div>
          <span class="spacer"></span>
          ${m.reasoning ? `<span class="tag">推理</span>` : ""}
          ${m.hasVision ? `<span class="tag">视觉</span>` : ""}
          ${m.contextLength ? `<span class="tag">${formatTokens(m.contextLength)} ctx</span>` : ""}
          ${isCurrent
            ? `<span class="tag accent">全局默认</span>`
            : `<button class="btn xs ghost" type="button" data-set-default-model="${escapeAttr(m.id)}">设为默认</button>`}
        </div>`;
      }).join("")}
    </div>`).join("");
}

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
  const currentModel = s.model || h.model || "";
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
            <div class="engine-kv"><div class="k">会话模型</div><div class="v is-text">pi AgentSession · 每成员独立</div></div>
            <div class="engine-kv"><div class="k">网关状态</div><div class="v is-text"><span class="engine-dot ${dotClass}"></span>${escapeHtml(statusText)}</div></div>
            <div class="engine-kv"><div class="k">网关地址</div><div class="v" title="${escapeAttr(gatewayUrl)}">${escapeHtml(gatewayUrl || "未配置")}</div></div>
            <div class="engine-kv"><div class="k">数据目录</div><div class="v" title="${escapeAttr(dataRoot)}">${escapeHtml(dataRoot || "未配置")}</div></div>
            <div class="engine-kv"><div class="k">工作区</div><div class="v" title="${escapeAttr(workspace)}">${escapeHtml(workspace || "未配置")}</div></div>
            <div class="engine-kv"><div class="k">房间 / 成员 / 连接</div><div class="v is-text">${Number(h.rooms || 0)} 群 · ${Number(h.bots || 0)} 成员 · ${Number(h.sse_clients || 0)} 连接</div></div>
            <div class="engine-kv"><div class="k">服务版本</div><div class="v is-text">${escapeHtml(h.version || s.version || "-")}</div></div>
          </div>
          <div class="set-row" style="border-top:1px solid var(--line)">
            <div class="set-copy"><div class="set-name">模型目录 <span class="tag is-xs">${models.length}</span></div><div class="set-desc">自动识别网关内全厂商模型（Claude / GPT / Gemini / DeepSeek / Qwen 等），可按群成员分别指定</div></div>
            <button class="btn sm" id="engine-refresh" type="button">${ICONS.refresh} 重新探测模型</button>
          </div>
          <div class="model-filter-row">
            <input class="input" id="model-filter-input" value="${escapeAttr(modelFilterQuery)}" placeholder="按模型名称或厂商筛选（如 claude、gpt、gemini、qwen、deepseek）…" spellcheck="false">
          </div>
          <div class="model-list" id="engine-model-list">
            ${renderModelCatalogHTML(models, currentModel, modelFilterQuery)}
          </div>
        </div>
      </div>`;
}

function automationSection() {
  const auto = state.automation || {};
  const br = auto.browser || {};
  const cp = auto.computer || {};
  const stopped = Boolean(auto.emergency_stopped);
  const brOk = br.available === true;
  const cpOk = cp.available === true;
  const brLabel = br.available === undefined
    ? "未探测"
    : brOk
      ? `可用 · ${br.driver || "playwright-cli"}`
      : `不可用 · ${br.reason || "未检测到 Playwright"}`;
  const cpLabel = cp.available === undefined
    ? "未探测"
    : cpOk
      ? `可用 · ${cp.driver || cp.platform || "desktop"}`
      : `待命 · ${cp.reason || "当前为无头环境（桌面端或配置 CUA 桥接后可用）"}`;
  const activeSessions = Number(br.activeSessions ?? (Array.isArray(br.active_sessions) ? br.active_sessions.length : 0)) || 0;

  return `
      <div class="settings-section">
        <h3>自动化操控引擎（Browser Use &amp; Computer Use）</h3>
        <div class="set-card">
          <div class="auto-status-grid">
            <div class="auto-engine-card">
              <div class="auto-engine-head">
                <span class="auto-engine-ico is-browser">${ICONS.globe}</span>
                <span class="auto-engine-title">Browser Use</span>
                <span class="tag is-xs ${brOk ? "green" : ""}">${brOk ? "就绪" : "未就绪"}</span>
              </div>
              <div class="auto-engine-desc">${escapeHtml(brLabel)}</div>
              <div class="auto-engine-meta">活跃浏览器会话：${activeSessions} 个 · 按房间成员隔离</div>
            </div>
            <div class="auto-engine-card">
              <div class="auto-engine-head">
                <span class="auto-engine-ico is-computer">${ICONS.monitor}</span>
                <span class="auto-engine-title">Computer Use</span>
                <span class="tag is-xs ${cpOk ? "green" : "amber"}">${cpOk ? "就绪" : "桌面可用"}</span>
              </div>
              <div class="auto-engine-desc">${escapeHtml(cpLabel)}</div>
              <div class="auto-engine-meta">平台：${escapeHtml(cp.platform || "linux")} · 支持 Windows / macOS / X11 / 远程桥接</div>
            </div>
          </div>
          <div class="set-row auto-kill-row${stopped ? " is-stopped" : ""}">
            <div class="set-copy">
              <div class="set-name">安全策略与紧急急停 ${stopped ? `<span class="tag is-xs red">已紧急中止</span>` : `<span class="tag is-xs green">正常待命</span>`}</div>
              <div class="set-desc">两项操控能力默认全部关闭，仅在你于「群信息 → 成员」或「机器人」页手动点击授权后生效；点击急停会立刻阻断所有浏览器与桌面操控并关闭会话</div>
            </div>
            <div class="auto-kill-actions">
              <button class="btn sm" id="auto-refresh-btn" type="button">${ICONS.refresh} 刷新探测</button>
              <button class="btn sm ${stopped ? "primary" : "danger"}" id="auto-kill-btn" type="button" data-stopped="${stopped ? "1" : "0"}">
                ${ICONS.shieldAlert} ${stopped ? "恢复操控" : "紧急中止"}
              </button>
            </div>
          </div>
        </div>
      </div>`;
}

function generalTab() {
  const s = state.settings || {};
  const models = state.models || [];
  const current = s.model || state.health?.model || "";
  const opts = buildModelSelectOptionsHTML(models, {
    selected: current,
    defaultModel: current,
    allowInherit: false,
    allowCustom: true,
    extraIds: current ? [current] : [],
  });
  return `
    ${header("通用", "pi 内核、模型、自动化引擎与界面")}
    <div class="settings-body">
      ${engineSection()}
      ${automationSection()}
      <div class="settings-section">
        <h3>模型与服务</h3>
        <div class="set-card">
          <div class="set-row">
            <div class="set-copy"><div class="set-name">全局默认模型</div><div class="set-desc">未单独指定模型的成员将默认使用此模型；可在「群信息 → 成员」或「机器人」页独立覆盖</div></div>
            <select class="select" id="set-model">${opts || `<option value="${escapeAttr(current)}">${escapeHtml(current)}</option>`}</select>
          </div>
          <div class="set-row">
            <div class="set-copy"><div class="set-name">模型网关地址</div><div class="set-desc">兼容 OpenAI / Magpie / LiteLLM / Ollama 的 /models 与对话端点，保存后自动重扫模型目录</div></div>
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
        <h3>个人身份</h3>
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
        <h3>外观与主题</h3>
        <div class="set-card">
          <div class="set-row">
            <div class="set-copy"><div class="set-name">主题模式</div><div class="set-desc">跟随你的使用环境，深浅两套表面</div></div>
            <div class="seg" style="width:180px" id="set-theme">
              <button data-theme-val="light" class="${state.theme === "light" ? "is-on" : ""}">浅色</button>
              <button data-theme-val="dark" class="${state.theme === "dark" ? "is-on" : ""}">深色</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function formatUptime(ms) {
  const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function perfTab() {
  const d = perfState.data || {};
  const cur = d.current || {};
  const sum = d.summary || {};
  const sys = d.system || {};
  const memPct = Number(cur.mem_pct || 0).toFixed(1);
  const memDetail = cur.mem_total_mb
    ? `${Math.round(cur.mem_used_mb || 0)} / ${Math.round(cur.mem_total_mb)} MB`
    : "正在采样…";
  const rssMb = Number(cur.proc_rss_mb || 0).toFixed(1);
  const heapDetail = cur.heap_total_mb
    ? `V8 堆 ${Number(cur.heap_used_mb || 0).toFixed(1)} / ${Number(cur.heap_total_mb).toFixed(0)} MB`
    : "Node 进程驻留内存";
  const tpsVal = Number(cur.tps || 0).toFixed(1);
  const tpsSub = `均值 ${Number(sum.avg_tps || 0).toFixed(1)} · 峰值 ${Number(sum.peak_tps || 0).toFixed(1)} tok/s`;
  const ttftVal = Math.round(sum.avg_ttft_ms || cur.ttft_ms || 0);

  return `
    ${header("性能监控", "实时系统内存消耗、Node 进程占用与 Token 处理速度（Recharts）")}
    <div class="settings-body">
      <div class="perf-toolbar">
        <div class="perf-live-badge${perfState.paused ? " is-paused" : ""}" id="perf-live-badge">
          <span class="perf-live-dot"></span>
          <span id="perf-live-text">${perfState.paused ? "已暂停采样" : "每 2 秒实时采样"}</span>
        </div>
        <span class="spacer"></span>
        <button class="btn sm" type="button" id="perf-pause-btn">${perfState.paused ? "恢复监控" : "暂停"}</button>
        <button class="btn sm" type="button" id="perf-refresh-btn">${ICONS.refresh} 立即采样</button>
      </div>

      ${perfState.error ? `<div class="appr-error" id="perf-error">性能采集失败：${escapeHtml(perfState.error)}</div>` : `<div class="appr-error" id="perf-error" hidden></div>`}

      <div class="stat-grid perf-kpi-grid">
        <div class="stat-card">
          <div class="stat-label">系统内存使用率</div>
          <div class="stat-value"><span id="perf-kpi-mem">${memPct}</span><small>%</small></div>
          <div class="stat-sub" id="perf-kpi-mem-sub">${escapeHtml(memDetail)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">进程驻留内存 (RSS)</div>
          <div class="stat-value"><span id="perf-kpi-rss">${rssMb}</span><small>MB</small></div>
          <div class="stat-sub" id="perf-kpi-rss-sub">${escapeHtml(heapDetail)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Token 处理速度</div>
          <div class="stat-value"><span id="perf-kpi-tps">${tpsVal}</span><small>tok/s</small></div>
          <div class="stat-sub" id="perf-kpi-tps-sub">${escapeHtml(tpsSub)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">平均首字延迟</div>
          <div class="stat-value"><span id="perf-kpi-ttft">${ttftVal}</span><small>ms</small></div>
          <div class="stat-sub" id="perf-kpi-turns-sub">${Number(sum.active_turns || 0)} 路活跃 · 累计 ${formatTokens(sum.total_tokens || 0)} tok</div>
        </div>
      </div>

      <div class="perf-charts-host" id="perf-charts-root">
        <div class="empty-mini">正在初始化 Recharts 实时图表…</div>
      </div>

      <div class="settings-section">
        <h3>运行环境</h3>
        <div class="set-card">
          <div class="engine-grid perf-sys-grid">
            <div class="engine-kv"><div class="k">运行平台</div><div class="v is-text" id="perf-sys-platform">${escapeHtml(sys.platform ? `${sys.platform} (${sys.arch || ""})` : "检测中…")}</div></div>
            <div class="engine-kv"><div class="k">Node 运行时</div><div class="v" id="perf-sys-node">${escapeHtml(sys.node_version || "-")}</div></div>
            <div class="engine-kv"><div class="k">CPU 核心 / 1m 负载</div><div class="v" id="perf-sys-cpu">${sys.cpu_count ? `${sys.cpu_count} 核 · ${Number(cur.cpu_load_1m || 0).toFixed(2)}` : "-"}</div></div>
            <div class="engine-kv"><div class="k">服务已运行</div><div class="v" id="perf-sys-uptime">${sys.uptime_ms ? formatUptime(sys.uptime_ms) : "-"}</div></div>
          </div>
        </div>
      </div>
    </div>`;
}

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

function skillsTab() {
  const skills = state.skills || [];
  const hooks = state.hooks || {};
  const pre = hooks.PreToolUse || [];
  const post = hooks.PostToolUse || [];
  const s = state.skillProposals || {};
  const proposals = Array.isArray(s.proposals) ? s.proposals : [];
  const report = s.report || {};
  const status = s.status || "";
  const counts = {};
  for (const filter of PROPOSAL_FILTERS) counts[filter.id] = Number(report[filter.key] || 0);

  return `
    ${header("技能与提案", "技能库、Hooks 治理与 E27 学习闭环")}
    <div class="settings-body">
      <div class="settings-section">
        <h3>技能提案 · ${proposals.length}</h3>
        <div class="set-card">
          <div class="set-row">
            <div class="set-copy"><div class="set-name">状态筛选</div><div class="set-desc">由真实回合自动沉淀，采纳后写入技能目录</div></div>
            <div class="seg prop-filter" id="prop-filter">
              ${PROPOSAL_FILTERS.map((f) => `<button type="button" data-prop-status="${f.id}" class="${status === f.id ? "is-on" : ""}">${f.label}${counts[f.id] ? ` ${counts[f.id]}` : ""}</button>`).join("")}
            </div>
          </div>
          <div class="prop-list" id="prop-list">
            ${proposals.length ? proposals.map(proposalCardHTML).join("") : `<div class="appr-empty">当前没有待处理的技能提案。</div>`}
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>已安装技能 · ${skills.length}</h3>
        <div class="set-card">
          ${skills.map((s) => `<div class="skill-card">
            <div class="skill-top"><span class="skill-name">${escapeHtml(s.name)}</span><span class="tag ${s.source === "workspace" ? "accent" : ""}">${s.source === "workspace" ? "工作区" : "内置"}</span></div>
            <div class="skill-desc">${escapeHtml(s.description || "")}</div>
            <div class="skill-when">${escapeHtml(s.when_to_use || "")}</div>
          </div>`).join("") || `<div class="empty-mini">还没有技能。</div>`}
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
  return `<div class="prop-card" data-proposal-id="${escapeAttr(p.id)}">
    <div class="prop-head">
      <span class="prop-status is-${meta.cls}">${escapeHtml(meta.label)}</span>
      <span class="prop-title">${escapeHtml(p.title || "（无标题）")}</span>
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
    ${fileChips ? `<div class="prop-evidence"><span class="prop-ev-label">证据</span>${fileChips}${moreFiles}</div>` : ""}
    ${canAct ? `<div class="prop-actions">
      <input class="input prop-reason" data-prop-reason placeholder="拒绝/延后原因（可选）" maxlength="120">
      <button class="btn sm primary" data-prop-act="adopt">采纳</button>
      <button class="btn sm" data-prop-act="reject">拒绝</button>
      <button class="btn sm ghost" data-prop-act="defer">延后</button>
    </div>` : ""}
  </div>`;
}

function memoryTab() {
  const m = memoryViewState;
  const st = m.stats || {};
  const totalCount = Number(st.total ?? st.count ?? m.entries.length ?? 0);
  const pinnedCount = Number(st.pinned ?? m.entries.filter((e) => e.pinned).length ?? 0);
  const activeList = m.query.trim() && Array.isArray(m.results) ? m.results : m.entries;
  return `
    ${header("记忆", "持久事实、用户画像与 FTS5 混合检索（Hermes E28）")}
    <div class="settings-body">
      ${m.error ? `<div class="appr-error">记忆服务不可用：${escapeHtml(m.error)}</div>` : ""}
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-label">已存记忆</div><div class="stat-value">${totalCount}<small>条</small></div><div class="stat-sub">SQLite + FTS5 全文索引</div></div>
        <div class="stat-card"><div class="stat-label">置顶条目</div><div class="stat-value">${pinnedCount}<small>条</small></div><div class="stat-sub">memory 与 user 维度</div></div>
        <div class="stat-card"><div class="stat-label">检索机制</div><div class="stat-value">混合<small>排序</small></div><div class="stat-sub">FTS5 unicode61 + 二元组 Dice</div></div>
        <div class="stat-card"><div class="stat-label">单轮预算</div><div class="stat-value">2000<small>字</small></div><div class="stat-sub">半衰期 30 天自然衰减</div></div>
      </div>

      <div class="settings-section">
        <h3>记忆检索与管理</h3>
        <div class="set-card">
          <div class="set-row">
            <div class="set-copy"><div class="set-name">实时检索</div><div class="set-desc">输入关键词即时测试 FTS5 与 CJK 二元组混合排序</div></div>
            <div class="mem-search-wrap">
              <input class="input mem-search-input" id="mem-search-input" value="${escapeAttr(m.query)}" placeholder="输入关键字检索跨会话记忆…">
              <button class="btn sm" id="mem-refresh" type="button">${ICONS.refresh} 刷新</button>
            </div>
          </div>
          <div class="mem-list" id="mem-list">
            ${activeList.length ? activeList.map((entry) => `
              <div class="mem-row" data-mem-id="${escapeAttr(entry.id || "")}">
                <div class="mem-row-main">
                  <div class="mem-row-meta">
                    <span class="tag ${entry.target === "user" ? "accent" : ""}">${escapeHtml(entry.target || "memory")}</span>
                    ${entry.scope ? `<span class="tag">${escapeHtml(entry.scope)}</span>` : ""}
                    ${entry.pinned ? `<span class="tag amber">置顶</span>` : ""}
                    ${entry.score !== undefined ? `<span class="mem-score">匹配度 ${Number(entry.score).toFixed(2)}</span>` : ""}
                  </div>
                  <div class="mem-row-content">${escapeHtml(entry.content || "")}</div>
                </div>
                ${entry.id ? `<button class="btn sm ghost danger" type="button" data-mem-del="${escapeAttr(entry.id)}" title="删除此条记忆" aria-label="删除">${ICONS.trash}</button>` : ""}
              </div>`).join("") : `<div class="empty-mini">${m.loading ? "正在加载记忆库…" : m.query.trim() ? "没有检索到匹配的记忆条目。" : "记忆库当前为空；各成员在对话中通过 memory 工具持久化事实后将展示在此。"}</div>`}
          </div>
        </div>
      </div>
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

  const avgTps = stats.avg_tps || ctx.avg_tps || 0;
  const avgTtft = stats.avg_ttft_ms || ctx.avg_ttft_ms || 0;

  return `
    ${header("用量与遥测", "Token 消耗、缓存吞吐率与物理测速")}
    <div class="settings-body">
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-label">本次运行输入</div><div class="stat-value">${formatTokens(totalPrompt)}<small>tok</small></div><div class="stat-sub">含缓存读取</div></div>
        <div class="stat-card"><div class="stat-label">本次运行输出</div><div class="stat-value">${formatTokens(totalCompletion)}<small>tok</small></div><div class="stat-sub">全部成员</div></div>
        <div class="stat-card"><div class="stat-label">平均生成速率</div><div class="stat-value">${avgTps}<small>tok/s</small></div><div class="stat-sub">物理生成吞吐</div></div>
        <div class="stat-card"><div class="stat-label">首字延迟 (TTFT)</div><div class="stat-value">${avgTtft}<small>ms</small></div><div class="stat-sub">网络与前缀检索</div></div>
        <div class="stat-card"><div class="stat-label">缓存命中率</div><div class="stat-value">${cacheRate}<small>%</small></div><div class="stat-sub">${formatTokens(tokens.cache_read)} tok 命中</div></div>
        <div class="stat-card"><div class="stat-label">群聊与消息</div><div class="stat-value">${counts.rooms || (state.rooms || []).length}<small>群</small></div><div class="stat-sub">${msgCount} 条群消息</div></div>
      </div>

      <div class="settings-section">
        <h3>成员测速榜单</h3>
        <div class="set-card data-table-card">
          <table class="data-table">
            <thead>
              <tr>
                <th>成员</th>
                <th>调用次数</th>
                <th>Token 总量</th>
                <th>平均 TTFT</th>
                <th>生成速率</th>
              </tr>
            </thead>
            <tbody>
              ${botRows.map((b) => {
                const p = profileFor(b.bot_id, state.botsById[b.bot_id]);
                const bCalls = b.messages_count ?? b.calls ?? 0;
                const bTokens = b.tokens ?? 0;
                const bTtft = b.avg_ttft_ms ? `${b.avg_ttft_ms}ms` : "—";
                const bTps = b.avg_tps ? `${b.avg_tps} tok/s` : "—";
                return `<tr>
                  <td><div class="table-member">${avatar(b.bot_id, 22)}<span>${escapeHtml(p.name)}</span></div></td>
                  <td class="is-num">${bCalls} 次</td>
                  <td class="is-num">${formatTokens(bTokens)} tok</td>
                  <td class="is-num">${bTtft}</td>
                  <td class="is-num is-highlight">${bTps}</td>
                </tr>`;
              }).join("") || `<tr><td colspan="5" class="table-empty">暂无测速记录</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>

      <div class="settings-section">
        <h3>上下文构成</h3>
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

function botsTab(selectedBot, ctx) {
  const bots = state.bots || [];
  const bot = bots.find((b) => b.id === selectedBot) || bots[0] || { id: "ChiefRouter" };
  const p = profileFor(bot.id, bot);
  const models = state.models || [];
  const defaultModel = state.settings?.model || state.health?.model || "";
  const overrideModel = String(bot.model_override || "").trim();
  const effectiveModel = overrideModel || bot.model || defaultModel;
  const modelOpts = buildModelSelectOptionsHTML(models, {
    selected: overrideModel,
    defaultModel,
    allowInherit: true,
    allowCustom: true,
    extraIds: effectiveModel ? [effectiveModel] : [],
  });
  return `
    ${header("机器人", "按成员身份独立分配模型、思考强度与提示词")}
    <div class="settings-body">
      <div class="bot-layout">
        <div class="bot-side">
          ${bots.map((b) => {
            const bp = profileFor(b.id, b);
            const bOverride = String(b.model_override || "").trim();
            const bModel = formatModelShort(bOverride || b.model || defaultModel, models);
            return `<button class="bot-side-row${b.id === bot.id ? " is-on" : ""}" data-bot-id="${escapeAttr(b.id)}">
              ${avatar(b.id, 28)}
              <span class="bot-side-copy">
                <span class="bot-name">${escapeHtml(bp.name)}</span>
                <span class="bot-sub">${escapeHtml(bp.role)}</span>
                <span class="bot-side-model${bOverride ? " is-override" : ""}" title="${escapeAttr(bOverride || b.model || defaultModel)}">${escapeHtml(bModel)}</span>
              </span>
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
          <div class="field">
            <label>专属模型 <span class="tag is-xs ${overrideModel ? "accent" : ""}">${overrideModel ? "独立指定" : "跟随全局默认"}</span></label>
            <div class="bot-model-field-row">
              <select class="select" id="b-model">${modelOpts}</select>
              <button class="btn sm" id="b-refresh-models" type="button" title="重新从网关探测模型">${ICONS.refresh} 刷新模型</button>
            </div>
            <div class="field-hint">选择「跟随全局默认」可随通用设置统一切换；也可任选网关内模型或输入自定义模型 ID，保存后立即热更新活跃群聊。</div>
          </div>
          <div class="field"><label>思考强度</label><select class="select" id="b-thinking">${["off", "low", "medium", "high"].map((lv) => `<option value="${lv}"${(bot.thinking_level || "off") === lv ? " selected" : ""}>${({ off: "关闭（最快）", low: "低", medium: "中", high: "高（最稳）" })[lv]}</option>`).join("")}</select></div>
          <div class="field">
            <label>操控能力授权（默认关闭，需手动授予）</label>
            <div class="bot-cap-actions">
              <button class="cap-grant-btn${bot.can_use_browser ? " is-granted" : ""}" id="b-browser-toggle" type="button" data-cap-val="${bot.can_use_browser ? "1" : "0"}" aria-pressed="${bot.can_use_browser ? "true" : "false"}">
                ${ICONS.globe}<span>Browser Use</span><em class="cap-grant-state">${bot.can_use_browser ? "已授权" : "授予"}</em>
              </button>
              <button class="cap-grant-btn is-computer${bot.can_use_computer ? " is-granted" : ""}" id="b-computer-toggle" type="button" data-cap-val="${bot.can_use_computer ? "1" : "0"}" aria-pressed="${bot.can_use_computer ? "true" : "false"}">
                ${ICONS.monitor}<span>Computer Use</span><em class="cap-grant-state">${bot.can_use_computer ? "已授权" : "授予"}</em>
              </button>
            </div>
            <div class="field-hint">保存后会同步更新该成员的默认授权与当前活跃群聊；成员和群主均无法通过提示词自行开启此权限。</div>
          </div>
          <div class="field"><label>系统提示词</label><textarea class="textarea" id="b-prompt" rows="5">${escapeHtml(bot.system_prompt || "")}</textarea></div>
          <div class="field"><label>已挂载工具</label><div style="display:flex;flex-wrap:wrap;gap:5px">${(bot.allowed_tools || []).map((t) => `<span class="tag" style="height:22px;font-family:var(--mono);font-size:10.5px">${escapeHtml(t)}</span>`).join("") || `<span class="set-desc">无</span>`}</div></div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
            <button class="btn primary sm" id="b-save">保存机器人设置</button>
          </div>
        </div>
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
      <div class="about-hero">
        <span class="about-brand-badge" aria-hidden="true">${brandMarkSvg(28)}</span>
        <div>
          <div class="about-brand-name">AgentFusion</div>
          <div class="set-desc">群聊智能体工作台 · pi 内核</div>
        </div>
      </div>
      <div class="set-card">
        <div class="set-row"><div class="set-copy"><div class="set-name">内核</div><div class="set-desc">${escapeHtml(kernelLabel)}（@earendil-works/pi-coding-agent）：工具循环、会话分支、上下文压缩、技能与扩展</div></div><div class="set-value is-mono">${escapeHtml(kernelVersion)}</div></div>
        <div class="set-row"><div class="set-copy"><div class="set-name">运行方式</div><div class="set-desc">Electron 桌面壳 + 本地 Node 服务；纯原生静态 ES Module 前端架构</div></div></div>
        <div class="set-row"><div class="set-copy"><div class="set-name">数据目录</div><div class="set-desc is-mono">${escapeHtml(dataRoot || "D:\\AgentFusion")}</div></div></div>
        <div class="set-row"><div class="set-copy"><div class="set-name">模型网关</div><div class="set-desc is-mono">${escapeHtml(gateway || "http://127.0.0.1:3425/v1")}</div></div></div>
        <div class="set-row"><div class="set-copy"><div class="set-name">致谢</div><div class="set-desc">群聊协作模型参考 DS-Bot 的公开设计；图标与界面体系为项目原创</div></div></div>
      </div>
    </div>`;
}

function bindContent(root, ctx) {
  if (ctx.tab === "perf") {
    const chartsHost = $("#perf-charts-root", root);
    perfMountEl = chartsHost;

    const patchDom = (data) => {
      if (!data || !root.isConnected) return;
      const cur = data.current || {};
      const sum = data.summary || {};
      const sys = data.system || {};
      const setTxt = (sel, val) => { const el = $(sel, root); if (el) el.textContent = String(val); };
      setTxt("#perf-kpi-mem", Number(cur.mem_pct || 0).toFixed(1));
      setTxt("#perf-kpi-mem-sub", cur.mem_total_mb ? `${Math.round(cur.mem_used_mb || 0)} / ${Math.round(cur.mem_total_mb)} MB` : "采样中…");
      setTxt("#perf-kpi-rss", Number(cur.proc_rss_mb || 0).toFixed(1));
      setTxt("#perf-kpi-rss-sub", cur.heap_total_mb ? `V8 堆 ${Number(cur.heap_used_mb || 0).toFixed(1)} / ${Number(cur.heap_total_mb).toFixed(0)} MB` : "Node 进程驻留内存");
      setTxt("#perf-kpi-tps", Number(cur.tps || 0).toFixed(1));
      setTxt("#perf-kpi-tps-sub", `均值 ${Number(sum.avg_tps || 0).toFixed(1)} · 峰值 ${Number(sum.peak_tps || 0).toFixed(1)} tok/s`);
      setTxt("#perf-kpi-ttft", Math.round(sum.avg_ttft_ms || cur.ttft_ms || 0));
      setTxt("#perf-kpi-turns-sub", `${Number(sum.active_turns || 0)} 路活跃 · 累计 ${formatTokens(sum.total_tokens || 0)} tok`);
      setTxt("#perf-sys-platform", `${sys.platform || ""} (${sys.arch || ""})`);
      setTxt("#perf-sys-node", sys.node_version || "-");
      setTxt("#perf-sys-cpu", `${sys.cpu_count || 1} 核 · ${Number(cur.cpu_load_1m || 0).toFixed(2)}`);
      setTxt("#perf-sys-uptime", formatUptime(sys.uptime_ms || 0));

      const errEl = $("#perf-error", root);
      if (errEl) {
        errEl.hidden = !perfState.error;
        if (perfState.error) errEl.textContent = `性能采集失败：${perfState.error}`;
      }

      if (chartsHost && chartsHost.isConnected && perfChartsMod?.mountPerfCharts) {
        perfChartsMod.mountPerfCharts(chartsHost, {
          history: data.history || [],
          current: cur,
          summary: sum,
          theme: document.documentElement.getAttribute("data-theme") || state.theme || "light",
        });
      }
    };

    const pollOnce = async () => {
      if (!root.isConnected) {
        stopPerfMonitor();
        return;
      }
      try {
        const [data] = await Promise.all([api.perf(), loadPerfChartsModule()]);
        perfState.data = data;
        perfState.error = "";
        patchDom(data);
      } catch (err) {
        perfState.error = err?.message || "无法获取性能数据";
        const errEl = $("#perf-error", root);
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = `性能采集失败：${perfState.error}`;
        }
      }
    };

    $("#perf-pause-btn", root)?.addEventListener("click", (ev) => {
      perfState.paused = !perfState.paused;
      ev.currentTarget.textContent = perfState.paused ? "恢复监控" : "暂停";
      const badge = $("#perf-live-badge", root);
      const txt = $("#perf-live-text", root);
      badge?.classList.toggle("is-paused", perfState.paused);
      if (txt) txt.textContent = perfState.paused ? "已暂停采样" : "每 2 秒实时采样";
      if (!perfState.paused) pollOnce();
    });

    $("#perf-refresh-btn", root)?.addEventListener("click", () => pollOnce());

    pollOnce();
    perfPollTimer = setInterval(() => {
      if (!perfState.paused && !document.hidden) pollOnce();
    }, 2000);
    return;
  }

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
    const bindSetDefaultButtons = () => {
      $$("[data-set-default-model]", root).forEach((btn) => {
        btn.addEventListener("click", async () => {
          const targetModel = btn.dataset.setDefaultModel;
          if (!targetModel) return;
          btn.disabled = true;
          try {
            await updateSettings({ model: targetModel });
            await refreshBots();
            toast(`全局默认模型已切换为 ${formatModelShort(targetModel, state.models)}`, "success");
            ctx.rerender();
          } catch (err) {
            btn.disabled = false;
            toast(`切换失败：${err.message}`, "error");
          }
        });
      });
    };
    bindSetDefaultButtons();

    const filterInput = $("#model-filter-input", root);
    if (filterInput) {
      filterInput.addEventListener("input", () => {
        modelFilterQuery = filterInput.value;
        const listEl = $("#engine-model-list", root);
        if (listEl) {
          listEl.innerHTML = renderModelCatalogHTML(
            state.models || [],
            state.settings?.model || state.health?.model || "",
            modelFilterQuery,
          );
          bindSetDefaultButtons();
        }
      });
    }

    const setModelEl = $("#set-model", root);
    if (setModelEl) {
      let prevDefault = setModelEl.value;
      setModelEl.addEventListener("change", async () => {
        if (setModelEl.value !== CUSTOM_MODEL_VALUE) {
          prevDefault = setModelEl.value;
          return;
        }
        const entered = await promptCustomModel({ title: "指定全局默认模型 ID", current: prevDefault });
        if (!entered) {
          setModelEl.value = prevDefault;
          return;
        }
        const opt = document.createElement("option");
        opt.value = entered;
        opt.textContent = `${formatModelShort(entered, state.models)} (${entered}) [自定义]`;
        setModelEl.insertBefore(opt, setModelEl.lastElementChild);
        setModelEl.value = entered;
        prevDefault = entered;
      });
    }

    $("#engine-refresh", root)?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const [, res] = await Promise.allSettled([refreshHealth(), refreshModels({ refresh: true })]);
        const payload = res.status === "fulfilled" ? res.value : null;
        const count = (payload?.models || state.models || []).length;
        toast(payload?.gateway_ok === false ? `网关离线，使用本地 ${count} 个缓存模型` : `已探测到 ${count} 个可用模型`, "success");
        ctx.rerender();
      } catch (err) {
        toast(`刷新失败：${err.message}`, "error");
        btn.disabled = false;
      }
    });

    $("#auto-refresh-btn", root)?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        await refreshAutomation({ refresh: true });
        toast("已重新探测 Browser Use 与 Computer Use 状态", "success");
        ctx.rerender();
      } catch (err) {
        toast(`探测失败：${err.message}`, "error");
        btn.disabled = false;
      }
    });

    $("#auto-kill-btn", root)?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      const isStopped = btn.dataset.stopped === "1";
      btn.disabled = true;
      try {
        await setAutomationKill(!isStopped);
        toast(!isStopped ? "已触发紧急中止：所有浏览器与桌面操控已阻断" : "已恢复自动化操控引擎", !isStopped ? "info" : "success");
        ctx.rerender();
      } catch (err) {
        toast(`操作失败：${err.message}`, "error");
        btn.disabled = false;
      }
    });

    $("#set-save", root)?.addEventListener("click", async () => {
      const model = $("#set-model", root)?.value;
      const gateway_url = $("#set-gateway", root)?.value?.trim();
      const prevGateway = state.settings?.gateway_url || "";
      try {
        await updateSettings({
          ...(model && model !== CUSTOM_MODEL_VALUE ? { model } : {}),
          ...(gateway_url ? { gateway_url } : {}),
        });
        if (gateway_url && gateway_url !== prevGateway) {
          await Promise.allSettled([refreshModels({ refresh: true }), refreshHealth(), refreshBots()]);
          toast(`网关已更新并重新扫描（${(state.models || []).length} 个模型）`, "success");
        } else {
          await Promise.allSettled([refreshBots(), refreshModels()]);
          toast("设置已保存", "success");
        }
        refreshContext();
        ctx.rerender();
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
    const bModelEl = $("#b-model", root);
    if (bModelEl) {
      let prevBotModel = bModelEl.value;
      bModelEl.addEventListener("change", async () => {
        if (bModelEl.value !== CUSTOM_MODEL_VALUE) {
          prevBotModel = bModelEl.value;
          return;
        }
        const entered = await promptCustomModel({
          title: `为 ${profileFor(ctx.selectedBot, state.botsById[ctx.selectedBot]).name} 指定模型 ID`,
          current: prevBotModel || state.botsById[ctx.selectedBot]?.model || "",
        });
        if (!entered) {
          bModelEl.value = prevBotModel;
          return;
        }
        const opt = document.createElement("option");
        opt.value = entered;
        opt.textContent = `${formatModelShort(entered, state.models)} (${entered}) [自定义]`;
        bModelEl.insertBefore(opt, bModelEl.lastElementChild);
        bModelEl.value = entered;
        prevBotModel = entered;
      });
    }
    $("#b-refresh-models", root)?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const res = await refreshModels({ refresh: true });
        const count = (res?.models || state.models || []).length;
        toast(res?.gateway_ok === false ? `网关离线，沿用本地 ${count} 个模型` : `已刷新 ${count} 个网关模型`, "success");
        ctx.rerender();
      } catch (err) {
        toast(`刷新失败：${err.message}`, "error");
        btn.disabled = false;
      }
    });
    const bindDraftCapBtn = (selector) => {
      const el = $(selector, root);
      if (!el) return;
      el.addEventListener("click", () => {
        const nextOn = el.dataset.capVal !== "1";
        el.dataset.capVal = nextOn ? "1" : "0";
        el.classList.toggle("is-granted", nextOn);
        el.setAttribute("aria-pressed", nextOn ? "true" : "false");
        const stateEl = $(".cap-grant-state", el);
        if (stateEl) stateEl.textContent = nextOn ? "已授权" : "授予";
      });
    };
    bindDraftCapBtn("#b-browser-toggle");
    bindDraftCapBtn("#b-computer-toggle");

    $("#b-save", root)?.addEventListener("click", async () => {
      const id = ctx.selectedBot;
      const selectedModel = $("#b-model", root).value;
      const browserBtn = $("#b-browser-toggle", root);
      const computerBtn = $("#b-computer-toggle", root);
      const payload = {
        name: $("#b-name", root).value.trim(),
        tagline: $("#b-tagline", root).value.trim(),
        model: selectedModel === CUSTOM_MODEL_VALUE ? "" : selectedModel,
        thinking_level: $("#b-thinking", root).value,
        system_prompt: $("#b-prompt", root).value,
        ...(browserBtn ? { can_use_browser: browserBtn.dataset.capVal === "1" } : {}),
        ...(computerBtn ? { can_use_computer: computerBtn.dataset.capVal === "1" } : {}),
      };
      try {
        await api.updateBot(id, payload);
        await Promise.allSettled([refreshBots(), refreshModels(), refreshRooms()]);
        toast("机器人设置已保存并立即生效", "success");
        ctx.rerender();
      } catch (err) { toast(`保存失败：${err.message}`, "error"); }
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
          await doRefresh("这条审批已经被处理过了", "info");
        } else {
          $$("[data-act]", row).forEach((b) => { b.disabled = false; });
          toast(`裁决失败：${message}`, "error");
        }
      }
    });
  }
  if (ctx.tab === "skills") {
    $("#hooks-reload", root)?.addEventListener("click", async () => {
      try { await reloadHooks(); toast("Hooks 已重新加载", "success"); ctx.rerender(); }
      catch (err) { toast(`重载失败：${err.message}`, "error"); }
    });

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

    $("#prop-list", root)?.addEventListener("click", async (ev) => {
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
        await doRefresh();
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
  if (ctx.tab === "memory") {
    const searchInput = $("#mem-search-input", root);
    const runSearch = debounce(async () => {
      const q = searchInput?.value?.trim() || "";
      memoryViewState.query = q;
      if (!q) {
        memoryViewState.results = null;
        ctx.rerender();
        return;
      }
      try {
        const res = await api.searchMemory(q, 20);
        memoryViewState.results = Array.isArray(res?.results) ? res.results : [];
        memoryViewState.error = "";
        ctx.rerender();
        const nextInput = $("#mem-search-input", document);
        if (nextInput) {
          nextInput.focus();
          nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
        }
      } catch (err) {
        memoryViewState.error = err.message;
        ctx.rerender();
      }
    }, 220);

    searchInput?.addEventListener("input", runSearch);
    $("#mem-refresh", root)?.addEventListener("click", async () => {
      memoryViewState.loaded = false;
      memoryViewState.query = "";
      memoryViewState.results = null;
      try {
        const res = await api.memory(50);
        memoryViewState.loaded = true;
        memoryViewState.entries = Array.isArray(res?.entries) ? res.entries : [];
        memoryViewState.stats = res?.stats || null;
        memoryViewState.error = "";
        toast("记忆库已刷新", "success");
        ctx.rerender();
      } catch (err) {
        toast(`刷新失败：${err.message}`, "error");
      }
    });
    $("#mem-list", root)?.addEventListener("click", async (ev) => {
      const delBtn = ev.target.closest("[data-mem-del]");
      if (!delBtn) return;
      const id = delBtn.dataset.memDel;
      delBtn.disabled = true;
      try {
        await api.deleteMemory(id);
        memoryViewState.entries = memoryViewState.entries.filter((e) => e.id !== id);
        if (Array.isArray(memoryViewState.results)) {
          memoryViewState.results = memoryViewState.results.filter((e) => e.id !== id);
        }
        toast("记忆条目已删除", "success");
        ctx.rerender();
      } catch (err) {
        delBtn.disabled = false;
        toast(`删除失败：${err.message}`, "error");
      }
    });
  }
}
