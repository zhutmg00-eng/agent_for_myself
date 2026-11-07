/* App shell: sidebar, routing, inspector, shortcuts. */

import {
  state, boot, subscribe, emit, openRoom, openChief, openBot, createRoom,
  roomLastPreview, roomTitle, profileOf, refreshRooms, refreshBots, refreshContext,
  sortedRooms, refreshHealth, pendingApprovalCount, applyTheme,
} from "./store.js";
import { avatar, groupAvatar, profileFor, escapeHtml } from "./avatars.js";
import {
  ICONS, $, $$, toast, openModal, closeModal, formatTokens, escapeAttr, debounce,
} from "./ui.js";
import { ChiefView } from "./views/chief.js";
import { GroupView, groupInspectorHTML, bindGroupInspector, openFilePreview } from "./views/group.js";
import { BotView } from "./views/bot.js";
import { openSettings } from "./views/settings.js";
import { chiefInspectorHTML } from "./views/chief.js";
import { setMentionColorizer } from "./markdown.js";

let currentView = null;
let currentKey = "";
let inspectorKey = "";
let inspectorSig = "";

const SIDEBAR_STORAGE_KEY = "agent_fusion:sidebar_mode";

const els = {};

function cacheEls() {
  els.app = $("#app");
  els.sidebar = $("#sidebar");
  els.btnToggleSidebar = $("#btn-toggle-sidebar");
  els.sideConnBadge = $("#side-conn-badge");
  els.sideConnDot = $("#side-conn-dot");
  els.sideConnText = $("#side-conn-text");
  els.btnThemeToggle = $("#btn-theme-toggle");
  els.roomList = $("#room-list");
  els.botList = $("#bot-list");
  els.roomEmpty = $("#room-empty");
  els.chiefCard = $("#chief-card");
  els.chiefOrb = $("#chief-orb");
  els.view = $("#view");
  els.inspector = $("#inspector");
  els.tbTitle = $("#tb-title");
  els.connPill = $("#conn-pill");
  els.connText = $("#conn-text");
  els.footUsage = $("#foot-usage");
  els.footModel = $("#foot-model");
  els.approvalBadge = $("#approval-badge");
}

function initSidebarMode() {
  let mode = "expanded";
  try {
    mode = localStorage.getItem(SIDEBAR_STORAGE_KEY) || (window.innerWidth < 900 ? "rail" : "expanded");
  } catch (_) {}
  setSidebarMode(mode, false);
}

function setSidebarMode(mode, persist = true) {
  const isRail = mode === "rail";
  els.sidebar?.classList.toggle("is-rail", isRail);
  if (els.sidebar) els.sidebar.dataset.mode = mode;
  if (els.btnToggleSidebar) {
    els.btnToggleSidebar.setAttribute("aria-expanded", isRail ? "false" : "true");
    els.btnToggleSidebar.title = isRail ? "展开侧边栏（Ctrl+B）" : "折叠侧边栏（Ctrl+B）";
  }
  if (persist) {
    try { localStorage.setItem(SIDEBAR_STORAGE_KEY, mode); } catch (_) {}
  }
}

function toggleSidebar() {
  const isRail = els.sidebar?.classList.contains("is-rail");
  setSidebarMode(isRail ? "expanded" : "rail");
}

function bindShell() {
  initSidebarMode();
  els.btnToggleSidebar?.addEventListener("click", toggleSidebar);
  els.chiefCard.addEventListener("click", () => openChief());
  $("#btn-new").addEventListener("click", openNewGroup);
  $("#btn-new-room").addEventListener("click", openNewGroup);
  $("#btn-settings").addEventListener("click", () => openSettings());
  $("#btn-usage").addEventListener("click", () => openSettings({ tab: "usage" }));
  $("#btn-search").addEventListener("click", openSearch);
  els.btnThemeToggle?.addEventListener("click", () => {
    const next = state.theme === "dark" ? "light" : "dark";
    applyTheme(next);
  });

  els.roomList.addEventListener("click", (ev) => {
    const row = ev.target.closest("[data-room-id]");
    if (row) openRoom(row.dataset.roomId);
  });
  els.botList.addEventListener("click", (ev) => {
    const row = ev.target.closest("[data-bot-id]");
    if (row) openBot(row.dataset.botId);
  });

  document.addEventListener("ah:inspector", () => renderInspector(true));
  document.addEventListener("ah:settings", (ev) => openSettings(ev.detail || {}));

  document.addEventListener("keydown", (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === "k") { ev.preventDefault(); openSearch(); }
    if (mod && ev.key.toLowerCase() === "n") { ev.preventDefault(); openNewGroup(); }
    if (mod && ev.key.toLowerCase() === "b") { ev.preventDefault(); toggleSidebar(); }
    if (mod && ev.key === ",") { ev.preventDefault(); openSettings(); }
    if (ev.key === "Escape" && state.inspector && !document.querySelector(".modal-backdrop")) {
      state.inspector = null;
      renderInspector(true);
      document.dispatchEvent(new CustomEvent("ah:inspector", { detail: null }));
    }
  });

  const hw = window.harnessWindow;
  if (hw?.isElectron) {
    $("#win-btns").hidden = false;
    $("#win-min").addEventListener("click", () => hw.minimize());
    $("#win-max").addEventListener("click", () => hw.maximizeToggle());
    $("#win-close").addEventListener("click", () => hw.close());
  }
}

function renderSidebar() {
  const chief = profileFor("ChiefRouter", state.botsById.ChiefRouter);
  els.chiefOrb.innerHTML = avatar("ChiefRouter", 46);
  els.chiefCard.classList.toggle("is-active", state.view.type === "chief");
  els.chiefCard.querySelector(".chief-name").textContent = chief.name;
  els.chiefCard.querySelector(".chief-role").textContent = chief.role;

  const rooms = sortedRooms();
  els.roomEmpty.style.display = rooms.length ? "none" : "block";
  els.roomList.innerHTML = rooms.map((room) => {
    const active = state.view.type === "group" && state.view.id === room.room_id;
    const preview = roomLastPreview(room.room_id);
    const owner = profileOf(room.owner_id);
    const unread = state.unread[room.room_id] || 0;
    const sub = (room.parent_room_id ? "小群 · " : "") + (preview || `${(room.members || []).length} 位成员 · 群主 ${owner.name}`);
    return `<button class="room-row${active ? " is-active" : ""}" data-room-id="${escapeAttr(room.room_id)}" data-tooltip="${escapeAttr(roomTitle(room))}" title="${escapeAttr(roomTitle(room))}">
      ${groupAvatar(room, 34, state.botsById)}
      <span class="room-copy"><span class="room-name">${escapeHtml(roomTitle(room))}</span><span class="room-sub">${escapeHtml(sub)}</span></span>
      ${unread ? `<span class="room-unread">${unread > 99 ? "99+" : unread}</span>` : ""}
    </button>`;
  }).join("");

  const bots = state.bots.filter((b) => b.id !== "ChiefRouter");
  els.botList.innerHTML = bots.map((bot) => {
    const p = profileFor(bot.id, bot);
    const active = state.view.type === "bot" && state.view.id === bot.id;
    const sub = p.tagline && p.tagline.startsWith(p.role) ? p.tagline : `${p.role} · ${p.tagline}`;
    return `<button class="bot-row${active ? " is-active" : ""}" data-bot-id="${escapeAttr(bot.id)}" data-tooltip="${escapeAttr(p.name)} · ${escapeAttr(p.role)}" title="${escapeAttr(p.name)}">
      ${avatar(bot.id, 28)}
      <span class="bot-copy"><span class="bot-name">${escapeHtml(p.name)}</span><span class="bot-sub">${escapeHtml(sub)}</span></span>
      <span class="bot-state${bot.state === "working" ? " working" : ""}"></span>
    </button>`;
  }).join("");

  const ctx = state.context || {};
  els.footUsage.textContent = formatTokens(ctx.active_tokens);
  els.footModel.textContent = modelLabel();

  // 待裁决审批的入口徽标：0 条时整个元素隐藏（CSS 里也兜一层 [hidden]）。
  const pending = pendingApprovalCount();
  if (els.approvalBadge) {
    els.approvalBadge.hidden = pending <= 0;
    els.approvalBadge.textContent = pending > 99 ? "99+" : String(pending);
    els.approvalBadge.title = `${pending} 条审批待裁决`;
  }

  const connState = state.connected ? "connected" : state.connecting ? "syncing" : "offline";
  els.connPill.dataset.state = connState;
  els.connPill.classList.toggle("ok", state.connected);
  els.connPill.classList.toggle("syncing", state.connecting);
  els.connPill.classList.toggle("bad", !state.connected && !state.connecting);
  els.connText.textContent = state.connected ? "已连接" : state.connecting ? "重连中" : "离线";

  if (els.sideConnBadge) {
    els.sideConnBadge.classList.toggle("ok", state.connected);
    els.sideConnBadge.classList.toggle("bad", !state.connected && !state.connecting);
    els.sideConnBadge.classList.toggle("syncing", state.connecting);
  }
  if (els.sideConnText) {
    els.sideConnText.textContent = state.connected ? "已连接" : state.connecting ? "重连中" : "离线";
  }
}

/* Footer model label — backend model ids look like "magpie/xxx" or
 * "deepseek-v4.1-flash"; show the readable tail. */
function modelLabel() {
  const raw = state.settings?.model || state.health?.model || "";
  if (!raw) return "pi 内核";
  return String(raw)
    .replace(/^(auto|magpie|workbuddy|openai|anthropic)\//i, "")
    .replace(/^deepseek-/, "DeepSeek ");
}

function renderTitle() {
  let title = "";
  if (state.view.type === "chief") title = "Chief";
  else if (state.view.type === "group") title = roomTitle(state.roomById[state.view.id]);
  else if (state.view.type === "bot") title = profileOf(state.view.id).name;
  els.tbTitle.textContent = title;
  document.title = title ? `${title} · AgentFusion` : "AgentFusion";
}

function renderView() {
  const { type, id } = state.view;
  const key = `${type}:${id || ""}`;
  if (key !== currentKey) {
    if (currentView && currentView.destroy) currentView.destroy();
    currentView = null;
    currentKey = key;
    els.view.innerHTML = "";
    if (type === "chief") {
      currentView = new ChiefView(els.view);
      currentView.mount();
    } else if (type === "group") {
      currentView = new GroupView(els.view);
      currentView.mount(id);
    } else if (type === "bot") {
      currentView = new BotView(els.view, id);
      currentView.mount();
    }
  }
}

function renderInspector(force = false) {
  const insp = state.inspector;
  if (!insp) {
    els.inspector.hidden = true;
    els.inspector.innerHTML = "";
    inspectorKey = "";
    inspectorSig = "";
    return;
  }
  const key = `${insp.type}:${insp.id || ""}:${insp.tab || ""}:${insp.member || ""}`;
  let sig = key;
  if (insp.type === "group") {
    const room = state.roomById[insp.id];
    if (!room) { els.inspector.hidden = true; return; }
    sig = JSON.stringify({
      key,
      title: room.title,
      policy: room.context_policy,
      perms: room.member_permissions,
      selectedMember: insp.member || null,
      files: (state.files[insp.id] || []).map((f) => [f.file_id, f.path, f.description]),
      subs: state.rooms.filter((r) => r.parent_room_id === insp.id).map((r) => r.room_id),
      // 证据阶梯汇总后到：签入 sig 才能在汇总到达后重绘检查器。
      evidence: state.evidence?.[insp.id]?.summary || null,
      evidenceMismatch: (state.evidence?.[insp.id]?.records || []).filter((r) => r.status === "mismatch").length,
    });
  } else if (insp.type === "chief") {
    sig = JSON.stringify({ key, ctx: state.context, stats: state.stats });
  }
  if (!force && sig === inspectorSig && key === inspectorKey) return;

  inspectorKey = key;
  inspectorSig = sig;
  els.inspector.hidden = false;
  els.inspector.classList.add("inspector-drawer");
  if (insp.type === "group") {
    els.inspector.innerHTML = groupInspectorHTML(insp.id, insp.tab || "members", insp.member);
    bindGroupInspector(els.inspector, insp.id, insp.tab, () => renderInspector(true), insp.member);
  } else if (insp.type === "chief") {
    els.inspector.innerHTML = chiefInspectorHTML();
    bindInspectorCommon();
  }
}

function bindInspectorCommon() {
  $("[data-insp-close]", els.inspector)?.addEventListener("click", () => {
    state.inspector = null;
    renderInspector(true);
    document.dispatchEvent(new CustomEvent("ah:inspector", { detail: null }));
  });
}

function render() {
  if (!state.ready) return;
  renderSidebar();
  renderTitle();
  renderView();
  renderInspector();
}

/* --------------------------------------------------------------- modals */

function openNewGroup() {
  const memberBots = state.bots.filter((b) => !["ChiefRouter", "chief", "boss", "librarian"].includes(b.id));
  let selected = new Set(["coder", "reviewer"].filter((id) => memberBots.some((b) => b.id === id)));
  let policy = "shared";

  const renderPicker = () => memberBots.map((b) => {
    const p = profileFor(b.id, b);
    return `<button class="pick-card${selected.has(b.id) ? " is-on" : ""}" data-pick="${escapeAttr(b.id)}" type="button">
      ${avatar(b.id, 28)}
      <span class="pick-copy"><span class="pick-name">${escapeHtml(p.name)}</span><span class="pick-role">${escapeHtml(p.role)}</span></span>
      <span class="pick-check">${ICONS.check}</span>
    </button>`;
  }).join("");

  openModal(`
    <div class="modal" role="dialog" aria-modal="true" style="width:min(560px,100%)">
      <div class="modal-head">
        <div><h2>新建群聊</h2><p>Boss 会自动作为群主，Librarian 负责群文件空间。</p></div>
        <span class="spacer"></span>
        <button class="modal-close" data-close>${ICONS.close}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>群名称</label>
          <input class="input" id="ng-title" placeholder="例如：产品发布准备" maxlength="40" autofocus>
        </div>
        <div class="field">
          <label>成员</label>
          <div class="member-pick" id="ng-members">${renderPicker()}</div>
          <div class="field-hint">群主 Boss 与文件管家 Librarian 已固定加入，不需要手动选择。</div>
        </div>
        <div class="field">
          <label>上下文共享</label>
          <div class="seg" id="ng-policy">
            <button type="button" data-policy="shared" class="is-on">共享全文</button>
            <button type="button" data-policy="summary">仅摘要</button>
            <button type="button" data-policy="isolated">各自独立</button>
          </div>
          <div class="field-hint" id="ng-policy-hint">所有成员都能看到完整群聊记录，适合大多数协作。</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn primary" id="ng-create">创建群聊</button>
      </div>
    </div>`, {
    onMount(root) {
      $$("[data-close]", root).forEach((b) => b.addEventListener("click", closeModal));
      $("#ng-members", root).addEventListener("click", (ev) => {
        const card = ev.target.closest("[data-pick]");
        if (!card) return;
        const id = card.dataset.pick;
        if (selected.has(id)) selected.delete(id); else selected.add(id);
        card.classList.toggle("is-on", selected.has(id));
      });
      $("#ng-policy", root).addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-policy]");
        if (!btn) return;
        policy = btn.dataset.policy;
        $$("[data-policy]", root).forEach((b) => b.classList.toggle("is-on", b === btn));
        const hints = {
          shared: "所有成员都能看到完整群聊记录，适合大多数协作。",
          summary: "成员只看到最近几条与摘要，节省上下文。",
          isolated: "成员互相看不到发言，只接收群主分派，适合敏感任务。",
        };
        $("#ng-policy-hint", root).textContent = hints[policy];
      });
      $("#ng-create", root).addEventListener("click", async () => {
        const title = $("#ng-title", root).value.trim() || "新群聊";
        const btn = $("#ng-create", root);
        btn.disabled = true;
        try {
          // Owner + file librarian are fixed roles; send the full roster so the
          // backend does not have to guess the owner from members[0].
          const roster = ["boss", "librarian", ...Array.from(selected).filter((id) => id !== "boss" && id !== "librarian")];
          const roomId = await createRoom({
            members: roster,
            owner_id: "boss",
            title,
            context_policy: policy,
          });
          if (!roomId) throw new Error("后端没有返回房间号");
          closeModal();
          await openRoom(roomId);
          toast("群聊已创建 · Boss 已作为群主就位", "success");
        } catch (err) {
          btn.disabled = false;
          toast(`创建失败：${err.message}`, "error");
        }
      });
    },
  });
}

function openSearch() {
  openModal(`
    <div class="modal" role="dialog" aria-modal="true" style="width:min(560px,100%);align-self:start;margin-top:12vh">
      <div class="modal-head" style="padding-bottom:8px">
        <div style="width:100%;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--line);padding-bottom:10px">
          <span style="width:17px;height:17px;color:var(--text-3)">${ICONS.search}</span>
          <input id="search-input" class="input" style="border:0;box-shadow:none;height:28px;padding:0;font-size:14px;background:transparent" placeholder="搜索群聊或成员" autofocus>
          <button class="modal-close" data-close>${ICONS.close}</button>
        </div>
      </div>
      <div class="modal-body" id="search-results" style="padding-top:8px"></div>
    </div>`, {
    onMount(root) {
      const input = $("#search-input", root);
      const results = $("#search-results", root);
      const draw = () => {
        const q = input.value.trim().toLowerCase();
        const rooms = state.rooms.filter((r) => !q || roomTitle(r).toLowerCase().includes(q));
        const bots = state.bots.filter((b) => b.id !== "ChiefRouter" && (!q || profileFor(b.id, b).name.toLowerCase().includes(q) || b.id.toLowerCase().includes(q)));
        results.innerHTML = `
          ${rooms.length ? `<div class="section-label" style="margin-top:0">群聊</div>` + rooms.map((r) => `<button class="bot-row" data-go-room="${escapeAttr(r.room_id)}">
            ${groupAvatar(r, 28, state.botsById)}<span class="bot-copy"><span class="bot-name">${escapeHtml(roomTitle(r))}</span><span class="bot-sub">${(r.members || []).length} 位成员</span></span>
          </button>`).join("") : ""}
          ${bots.length ? `<div class="section-label">成员</div>` + bots.map((b) => {
            const p = profileFor(b.id, b);
            return `<button class="bot-row" data-go-bot="${escapeAttr(b.id)}">
              ${avatar(b.id, 28)}<span class="bot-copy"><span class="bot-name">${escapeHtml(p.name)}</span><span class="bot-sub">${escapeHtml(p.role)} · ${escapeHtml(p.tagline)}</span></span>
            </button>`;
          }).join("") : ""}
          ${!rooms.length && !bots.length ? `<div class="empty-mini">没有找到匹配项</div>` : ""}`;
        $$("[data-go-room]", results).forEach((el) => el.addEventListener("click", () => { closeModal(); openRoom(el.dataset.goRoom); }));
        $$("[data-go-bot]", results).forEach((el) => el.addEventListener("click", () => { closeModal(); openBot(el.dataset.goBot); }));
      };
      input.addEventListener("input", debounce(draw, 80));
      $$("[data-close]", root).forEach((b) => b.addEventListener("click", closeModal));
      draw();
      setTimeout(() => input.focus(), 30);
    },
  });
}

/* ---------------------------------------------------------------- start */

function renderLoading() {
  els.view.innerHTML = `
    <div class="chat-body"><div class="chat-inner is-empty">
      <div class="welcome">
        <div class="welcome-orb">${avatar("ChiefRouter", 76)}</div>
        <h1>AgentFusion</h1>
        <p>群聊智能体工作台 · pi 内核</p>
        <p>${state.error ? `本地服务连接失败：${escapeHtml(state.error)}` : "正在连接本地运行时…"}</p>
        ${state.error ? `<div style="margin-top:16px"><button class="btn" id="retry-boot">重试</button></div>` : ""}
      </div>
    </div></div>`;
  $("#retry-boot")?.addEventListener("click", () => window.location.reload());
}

async function start() {
  cacheEls();
  bindShell();
  setMentionColorizer((name) => profileFor(name).color);
  renderLoading();
  subscribe(() => {
    if (!state.ready) { renderLoading(); return; }
    render();
  });
  await boot();
  render();
  // Keep the engine panel (kernel / gateway / data root) honest without
  // hammering the server: one refresh on boot, then a slow poll.
  refreshHealth();
  setInterval(() => { if (!document.hidden) refreshHealth(); }, 30000);
}

start();
