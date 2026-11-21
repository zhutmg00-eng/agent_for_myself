/* App shell: sidebar, rail tooltips, routing, inspector, command search, shortcuts. */

import {
  state, boot, subscribe, openRoom, openChief, openBot, createRoom,
  roomLastPreview, roomTitle, profileOf,
  sortedRooms, refreshHealth, pendingApprovalCount, applyTheme,
  activeProject, dmLastPreview, toggleInspector,
} from "./store.js";
import { avatar, groupAvatar, profileFor, escapeHtml, brandMarkSvg } from "./avatars.js";
import {
  ICONS, $, $$, toast, openModal, closeModal, formatTokens, escapeAttr, debounce, roomSkeletonHTML,
} from "./ui.js";
import { ChiefView, chiefInspectorHTML } from "./views/chief.js";
import { GroupView, groupInspectorHTML, bindGroupInspector } from "./views/group.js";
import { BotView } from "./views/bot.js";
import { openSettings } from "./views/settings.js";
import { openProjectModal, projectInspectorHTML, bindProjectInspector } from "./views/projects.js";
import { setMentionColorizer } from "./markdown.js";
import { formatModelShort } from "./models.js";

let currentView = null;
let currentKey = "";
let inspectorKey = "";
let inspectorSig = "";
let railTooltipEl = null;
let roomsWereSkeleton = false;

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
  els.btnProjectSwitch = $("#btn-project-switch");
  els.btnProjectFiles = $("#btn-project-files");
  els.projSwName = $("#proj-sw-name");
  els.projSwPath = $("#proj-sw-path");
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
  hideRailTooltip();
  if (persist) {
    try { localStorage.setItem(SIDEBAR_STORAGE_KEY, mode); } catch (_) {}
  }
}

function toggleSidebar() {
  const isRail = els.sidebar?.classList.contains("is-rail");
  setSidebarMode(isRail ? "expanded" : "rail");
}

function showRailTooltip(target) {
  if (!els.sidebar?.classList.contains("is-rail")) return;
  const text = target?.getAttribute("data-tooltip") || target?.getAttribute("title");
  if (!text) return;
  if (!railTooltipEl) {
    railTooltipEl = document.createElement("div");
    railTooltipEl.className = "rail-tooltip";
    document.body.appendChild(railTooltipEl);
  }
  const rect = target.getBoundingClientRect();
  railTooltipEl.textContent = text;
  railTooltipEl.style.left = `${rect.right + 10}px`;
  railTooltipEl.style.top = `${rect.top + rect.height / 2}px`;
  railTooltipEl.style.transform = "translateY(-50%)";
  railTooltipEl.classList.add("is-visible");
}

function hideRailTooltip() {
  if (railTooltipEl) railTooltipEl.classList.remove("is-visible");
}

function bindRailTooltips() {
  if (!els.sidebar) return;
  els.sidebar.addEventListener("pointerenter", (ev) => {
    const target = ev.target.closest?.("[data-tooltip]");
    if (target) showRailTooltip(target);
  }, true);
  els.sidebar.addEventListener("pointerleave", (ev) => {
    if (ev.target.closest?.("[data-tooltip]")) hideRailTooltip();
  }, true);
  els.sidebar.addEventListener("scroll", hideRailTooltip, true);
}

function bindShell() {
  initSidebarMode();
  bindRailTooltips();
  els.btnToggleSidebar?.addEventListener("click", toggleSidebar);
  els.chiefCard.addEventListener("click", () => openChief());
  $("#btn-new").addEventListener("click", openNewGroup);
  $("#btn-new-room").addEventListener("click", openNewGroup);
  $("#btn-settings").addEventListener("click", () => openSettings());
  $("#btn-usage").addEventListener("click", () => openSettings({ tab: "usage" }));
  $("#btn-search").addEventListener("click", openSearch);
  els.btnProjectSwitch?.addEventListener("click", () => openProjectModal());
  els.btnProjectFiles?.addEventListener("click", () => {
    const proj = activeProject();
    if (!proj) {
      openProjectModal();
      return;
    }
    toggleInspector("project", proj.id);
    renderInspector(true);
  });
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

function renderRoomList() {
  if (!els.roomList) return;
  const rooms = sortedRooms();
  const isLoading = Boolean(state.roomsLoading) && rooms.length === 0;
  if (isLoading) {
    els.roomList.setAttribute("aria-busy", "true");
    els.roomList.classList.add("is-loading");
    if (els.roomEmpty) els.roomEmpty.style.display = "none";
    if (!roomsWereSkeleton || !els.roomList.querySelector(".room-skeleton-row")) {
      els.roomList.innerHTML = roomSkeletonHTML(4);
    }
    roomsWereSkeleton = true;
    return;
  }

  const animateIn = roomsWereSkeleton;
  roomsWereSkeleton = false;
  els.roomList.removeAttribute("aria-busy");
  els.roomList.classList.remove("is-loading");
  if (els.roomEmpty) els.roomEmpty.style.display = rooms.length ? "none" : "block";
  els.roomList.innerHTML = rooms.map((room, idx) => {
    const active = state.view.type === "group" && state.view.id === room.room_id;
    const preview = roomLastPreview(room.room_id);
    const owner = profileOf(room.owner_id);
    const unread = state.unread[room.room_id] || 0;
    const sub = (room.parent_room_id ? "小群 · " : "") + (preview || `${(room.members || []).length} 位成员 · 群主 ${owner.name}`);
    const enterCls = animateIn ? " is-entering" : "";
    const enterStyle = animateIn ? ` style="--row-i:${Math.min(idx, 6)}"` : "";
    return `<button class="room-row${active ? " is-active" : ""}${enterCls}"${enterStyle} data-room-id="${escapeAttr(room.room_id)}" data-tooltip="${escapeAttr(roomTitle(room))}" title="${escapeAttr(roomTitle(room))}">
      ${groupAvatar(room, 32, state.botsById)}
      <span class="room-copy"><span class="room-name">${escapeHtml(roomTitle(room))}</span><span class="room-sub">${escapeHtml(sub)}</span></span>
      ${unread ? `<span class="room-unread">${unread > 99 ? "99+" : unread}</span>` : ""}
    </button>`;
  }).join("");
}

function renderSidebar() {
  const chief = profileFor("ChiefRouter", state.botsById.ChiefRouter);
  els.chiefOrb.innerHTML = avatar("ChiefRouter", 34);
  els.chiefCard.classList.toggle("is-active", state.view.type === "chief");
  els.chiefCard.querySelector(".chief-name").textContent = chief.name;
  els.chiefCard.querySelector(".chief-role").textContent = chief.role;

  const curProj = activeProject();
  if (els.projSwName) {
    els.projSwName.textContent = curProj?.name || "默认工作区";
  }
  if (els.projSwPath) {
    const pathText = curProj?.root_path || state.health?.workspace_root || "点击绑定本地目录";
    els.projSwPath.textContent = curProj?.git_branch ? `${curProj.git_branch} · ${pathText}` : pathText;
  }
  if (els.btnProjectSwitch && curProj) {
    els.btnProjectSwitch.setAttribute("data-tooltip", `当前项目：${curProj.name} (${curProj.root_path})`);
    els.btnProjectSwitch.title = `${curProj.name} · ${curProj.root_path}`;
  }
  if (els.btnProjectFiles) {
    const filesOpen = state.inspector?.type === "project";
    els.btnProjectFiles.classList.toggle("is-active", filesOpen);
  }

  renderRoomList();

  const bots = state.bots.filter((b) => b.id !== "ChiefRouter");
  els.botList.innerHTML = bots.map((bot) => {
    const p = profileFor(bot.id, bot);
    const active = state.view.type === "bot" && state.view.id === bot.id;
    const dmPrev = dmLastPreview(bot.id);
    const rawTag = String(p.tagline || "").trim();
    const cleanedTag = p.role && rawTag.startsWith(`${p.role} · `) ? rawTag.slice(p.role.length + 3) : rawTag;
    const roleLine = p.role && p.role !== p.name
      ? (cleanedTag ? `${p.role} · ${cleanedTag}` : p.role)
      : (cleanedTag || p.role || "");
    const sub = dmPrev || roleLine;
    return `<button class="bot-row${active ? " is-active" : ""}" data-bot-id="${escapeAttr(bot.id)}" data-tooltip="${escapeAttr(p.name)} · 私聊 (${escapeAttr(p.role)})" title="${escapeAttr(p.name)}">
      ${avatar(bot.id, 28)}
      <span class="bot-copy"><span class="bot-name">${escapeHtml(p.name)}</span><span class="bot-sub">${escapeHtml(sub)}</span></span>
      <span class="bot-state${bot.state === "working" ? " working" : ""}"></span>
    </button>`;
  }).join("");

  const ctx = state.context || {};
  els.footUsage.textContent = formatTokens(ctx.active_tokens);
  els.footModel.textContent = modelLabel();

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

function modelLabel() {
  const raw = state.settings?.model || state.health?.model || "";
  if (!raw) return "pi 内核";
  return formatModelShort(raw, state.models);
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
      project_id: room.project_id || null,
      projectsSig: (state.projects || []).map((p) => `${p.id}:${p.name}`).join(","),
      perms: room.member_permissions,
      selectedMember: insp.member || null,
      defaultModel: state.settings?.model || state.health?.model || "",
      modelsSig: (state.models || []).map((m) => m.id).join(","),
      botModels: (room.members || []).map((id) => `${id}:${state.botsById[id]?.model_override || ""}:${state.botsById[id]?.model || ""}`),
      files: (state.files[insp.id] || []).map((f) => [f.file_id, f.path, f.description]),
      subs: state.rooms.filter((r) => r.parent_room_id === insp.id).map((r) => r.room_id),
      evidence: state.evidence?.[insp.id]?.summary || null,
      evidenceMismatch: (state.evidence?.[insp.id]?.records || []).filter((r) => r.status === "mismatch").length,
    });
  } else if (insp.type === "chief") {
    sig = JSON.stringify({ key, ctx: state.context, stats: state.stats });
  } else if (insp.type === "project") {
    sig = JSON.stringify({ key, active: state.activeProjectId, projects: (state.projects || []).map((p) => p.id) });
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
  } else if (insp.type === "project") {
    els.inspector.innerHTML = projectInspectorHTML(insp.id);
    bindProjectInspector(els.inspector, insp.id, () => renderInspector(true));
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
    <div class="modal modal-md" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div><h2>新建群聊</h2><p>Boss 会自动作为群主，Librarian 负责群文件空间。</p></div>
        <span class="spacer"></span>
        <button class="modal-close" data-close aria-label="关闭">${ICONS.close}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label for="ng-title">群名称</label>
          <input class="input" id="ng-title" placeholder="例如：产品发布准备" maxlength="40" autofocus>
        </div>
        <div class="field">
          <label>选择协作成员</label>
          <div class="member-pick" id="ng-members">${renderPicker()}</div>
          <div class="field-hint">群主 Boss 与文件管家 Librarian 已固定加入，无需手动勾选。</div>
        </div>
        <div class="field">
          <label for="ng-project">绑定项目目录</label>
          <select class="select" id="ng-project">
            <option value="">跟随当前全局项目（${escapeHtml(activeProject()?.name || "默认工作区")}）</option>
            ${(state.projects || []).map((pr) => `<option value="${escapeAttr(pr.id)}"${pr.id === state.activeProjectId ? " selected" : ""}>${escapeHtml(pr.name)} · ${escapeHtml(pr.root_path)}</option>`).join("")}
          </select>
          <div class="field-hint">群内成员的文件读写与终端命令将默认在绑定目录中执行。</div>
        </div>
        <div class="field">
          <label>上下文共享策略</label>
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
      const submitCreate = async () => {
        const title = $("#ng-title", root).value.trim() || "新群聊";
        const projectId = $("#ng-project", root)?.value || null;
        const btn = $("#ng-create", root);
        btn.disabled = true;
        try {
          const roster = ["boss", "librarian", ...Array.from(selected).filter((id) => id !== "boss" && id !== "librarian")];
          const roomId = await createRoom({
            members: roster,
            owner_id: "boss",
            title,
            context_policy: policy,
            ...(projectId ? { project_id: projectId } : {}),
          });
          if (!roomId) throw new Error("后端没有返回房间号");
          closeModal();
          await openRoom(roomId);
          toast("群聊已创建 · Boss 已作为群主就位", "success");
        } catch (err) {
          btn.disabled = false;
          toast(`创建失败：${err.message}`, "error");
        }
      };
      $("#ng-create", root).addEventListener("click", submitCreate);
      $("#ng-title", root).addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); submitCreate(); }
      });
      setTimeout(() => $("#ng-title", root)?.focus(), 30);
    },
  });
}

function openSearch() {
  openModal(`
    <div class="modal modal-search" role="dialog" aria-modal="true">
      <div class="search-modal-head">
        <span class="search-modal-icon" aria-hidden="true">${ICONS.search}</span>
        <input id="search-input" class="search-modal-input" placeholder="搜索群聊、成员或快速跳转…" autofocus>
        <kbd class="shortcut-hint">ESC</kbd>
        <button class="modal-close" data-close aria-label="关闭">${ICONS.close}</button>
      </div>
      <div class="modal-body search-modal-body" id="search-results"></div>
    </div>`, {
    onMount(root) {
      const input = $("#search-input", root);
      const results = $("#search-results", root);
      let activeIdx = 0;

      const highlight = () => {
        const rows = $$(".search-item", results);
        if (!rows.length) return;
        activeIdx = ((activeIdx % rows.length) + rows.length) % rows.length;
        rows.forEach((r, idx) => r.classList.toggle("is-active", idx === activeIdx));
      };

      const draw = () => {
        const q = input.value.trim().toLowerCase();
        const rooms = state.rooms.filter((r) => !q || roomTitle(r).toLowerCase().includes(q));
        const bots = state.bots.filter((b) => b.id !== "ChiefRouter" && (!q || profileFor(b.id, b).name.toLowerCase().includes(q) || b.id.toLowerCase().includes(q) || profileFor(b.id, b).role.toLowerCase().includes(q)));
        activeIdx = 0;
        results.innerHTML = `
          ${rooms.length ? `<div class="section-label is-first">群聊</div>` + rooms.map((r) => `<button class="bot-row search-item" data-go-room="${escapeAttr(r.room_id)}">
            ${groupAvatar(r, 28, state.botsById)}<span class="bot-copy"><span class="bot-name">${escapeHtml(roomTitle(r))}</span><span class="bot-sub">${(r.members || []).length} 位成员</span></span>
          </button>`).join("") : ""}
          ${bots.length ? `<div class="section-label${rooms.length ? "" : " is-first"}">团队成员</div>` + bots.map((b) => {
            const p = profileFor(b.id, b);
            return `<button class="bot-row search-item" data-go-bot="${escapeAttr(b.id)}">
              ${avatar(b.id, 28)}<span class="bot-copy"><span class="bot-name">${escapeHtml(p.name)}</span><span class="bot-sub">${escapeHtml(p.role)} · ${escapeHtml(p.tagline)}</span></span>
            </button>`;
          }).join("") : ""}
          ${!rooms.length && !bots.length ? `<div class="empty-mini">没有找到匹配项</div>` : ""}`;
        $$("[data-go-room]", results).forEach((el) => el.addEventListener("click", () => { closeModal(); openRoom(el.dataset.goRoom); }));
        $$("[data-go-bot]", results).forEach((el) => el.addEventListener("click", () => { closeModal(); openBot(el.dataset.goBot); }));
        highlight();
      };

      input.addEventListener("input", debounce(draw, 80));
      input.addEventListener("keydown", (ev) => {
        const rows = $$(".search-item", results);
        if (!rows.length) return;
        if (ev.key === "ArrowDown") { ev.preventDefault(); activeIdx += 1; highlight(); }
        else if (ev.key === "ArrowUp") { ev.preventDefault(); activeIdx -= 1; highlight(); }
        else if (ev.key === "Enter") { ev.preventDefault(); rows[activeIdx]?.click(); }
      });
      $$("[data-close]", root).forEach((b) => b.addEventListener("click", closeModal));
      draw();
      setTimeout(() => input.focus(), 30);
    },
  });
}

/* ---------------------------------------------------------------- start */

function renderLoading() {
  renderRoomList();
  els.view.innerHTML = `
    <div class="chat-body"><div class="chat-inner is-empty">
      <div class="welcome">
        <div class="welcome-brand-badge">${brandMarkSvg(34)}</div>
        <h1>AgentFusion</h1>
        <p>群聊智能体工作台 · pi 内核</p>
        <p class="welcome-status">${state.error ? `本地服务连接失败：${escapeHtml(state.error)}` : "正在连接本地运行时…"}</p>
        ${state.error ? `<div class="welcome-actions"><button class="btn primary" id="retry-boot">重试连接</button></div>` : ""}
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
  refreshHealth();
  setInterval(() => { if (!document.hidden) refreshHealth(); }, 30000);
}

start();
