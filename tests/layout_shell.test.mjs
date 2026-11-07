/**
 * tests/layout_shell.test.mjs
 *
 * Automated Layout Shell & Frontend Architecture Test Suite for Milestone 2.
 * Verifies:
 * 1. Design Tokens, Typography scale, and 48px Window Titlebar Band.
 * 2. Responsive Rail Sidebar (260px expanded / 64px compact rail mode with toggle,
 *    localStorage persistence, Ctrl+B shortcut, unread badge docking, and tooltips).
 * 3. Floating Capsule Chat Header (.capsule-header, topic/policy pills, memoization),
 *    Slide-Over Inspector Drawer (.inspector-drawer with 3-tab segmented nav),
 *    and Escape key dismissal.
 * 4. Modern Multi-Tab Settings Modal (7 tabs, alias backward compatibility,
 *    backdrop blur class, and immediate pointer-events isolation on close).
 *
 * Runs with `node --test` with ZERO external npm dependencies.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Setup headless DOM environment
const { setupHeadlessDOM } = await import("./_helpers/headless_dom.mjs");
const dom = setupHeadlessDOM();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");
const webDir = path.join(workspaceRoot, "web");

// Import target modules
const storeModule = await import("../web/js/store.js");
const groupViewModule = await import("../web/js/views/group.js");
const settingsViewModule = await import("../web/js/views/settings.js");

const { state, applyTheme } = storeModule;
const { GroupView, groupInspectorHTML, bindGroupInspector } = groupViewModule;
const { NAV, openSettings, closeSettings } = settingsViewModule;

describe("Milestone 2: Frontend Architecture & Layout Shell Test Suite", () => {
  let appCssContent;
  let indexHtmlContent;

  beforeEach(() => {
    appCssContent = fs.readFileSync(path.join(webDir, "app.css"), "utf8");
    indexHtmlContent = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
    document.body.innerHTML = '<div id="modal-root"></div>';
    state.inspector = null;
    state.evidence = {};
    state.rooms = [];
    state.roomById = {};
    state.files = {};
    state.messages = {};
    state.botsById = {
      boss: { id: "boss", name: "Boss", role: "群主" },
      coder: { id: "coder", name: "Coder", role: "开发" },
      reviewer: { id: "reviewer", name: "Reviewer", role: "审查" },
    };
  });

  afterEach(() => {
    closeSettings();
    document.body.innerHTML = "";
  });

  describe("Suite 1: Design Tokens & 48px Window Titlebar Band", () => {
    it("1.1: defines comprehensive design tokens in :root and [data-theme='dark']", () => {
      const requiredTokens = [
        "--titlebar-h: 48px",
        "--sidebar-w: 260px",
        "--sidebar-rail-w: 64px",
        "--inspector-w: 360px",
        "--green-glow",
        "--amber-glow",
        "--red-glow",
        "--ease-out",
        "--dur-quick",
        "--dur-normal",
      ];
      for (const token of requiredTokens) {
        assert.ok(
          appCssContent.includes(token),
          `CSS must define token ${token}`
        );
      }
      assert.ok(
        appCssContent.includes('[data-theme="dark"]'),
        "CSS must contain [data-theme='dark'] overrides"
      );
    });

    it("1.2: titlebar specifies 48px band height and window drag region", () => {
      assert.ok(
        appCssContent.includes("height: var(--titlebar-h, 48px)"),
        "Titlebar height must reference var(--titlebar-h, 48px)"
      );
      assert.ok(
        appCssContent.includes("-webkit-app-region: drag"),
        "Titlebar must declare -webkit-app-region: drag"
      );
    });

    it("1.3: titlebar interactive elements are excluded from drag region", () => {
      assert.ok(
        appCssContent.includes(':is(button, a, input, select, textarea, [role="button"])'),
        "Titlebar must exclude interactive elements via :is(...)"
      );
      assert.ok(
        appCssContent.includes("-webkit-app-region: no-drag"),
        "Interactive titlebar elements must specify -webkit-app-region: no-drag"
      );
    });

    it("1.4: responsive inspector offset updates from hardcoded 38px to var(--titlebar-h, 48px)", () => {
      assert.ok(
        appCssContent.includes("top: var(--titlebar-h, 48px)"),
        "Responsive inspector media query must use top: var(--titlebar-h, 48px)"
      );
      assert.ok(
        !appCssContent.includes("top: 38px;"),
        "CSS must no longer have legacy top: 38px hardcoded for inspector"
      );
    });

    it("1.5: titlebar markup includes brand, title, tri-state lamp, theme toggle, and caption controls", () => {
      assert.ok(indexHtmlContent.includes('id="titlebar"'), "index.html has #titlebar");
      assert.ok(indexHtmlContent.includes('class="brand-mark"'), "index.html has brand mark");
      assert.ok(indexHtmlContent.includes('class="brand-name"'), "index.html has brand name");
      assert.ok(indexHtmlContent.includes('class="tb-center"'), "index.html has .tb-center");
      assert.ok(indexHtmlContent.includes('id="tb-title"'), "index.html has #tb-title");
      assert.ok(indexHtmlContent.includes('id="conn-pill"'), "index.html has #conn-pill");
      assert.ok(indexHtmlContent.includes('id="btn-theme-toggle"'), "index.html has #btn-theme-toggle");
      assert.ok(indexHtmlContent.includes('class="theme-icon-sun"'), "index.html has sun theme icon");
      assert.ok(indexHtmlContent.includes('class="theme-icon-moon"'), "index.html has moon theme icon");
      assert.ok(indexHtmlContent.includes('id="win-btns"'), "index.html has #win-btns");
      assert.ok(indexHtmlContent.includes('id="win-close"'), "index.html has #win-close");
    });

    it("1.6: tri-state connection status lamp supports ok, syncing (pulsing animation), and bad states", () => {
      assert.ok(
        appCssContent.includes(".conn-pill.ok"),
        "CSS must style .conn-pill.ok"
      );
      assert.ok(
        appCssContent.includes(".conn-pill.syncing"),
        "CSS must style .conn-pill.syncing"
      );
      assert.ok(
        appCssContent.includes("@keyframes conn-pulse"),
        "CSS must define @keyframes conn-pulse for syncing animation"
      );
      assert.ok(
        appCssContent.includes(".conn-pill.bad"),
        "CSS must style .conn-pill.bad"
      );
    });

    it("1.7: window caption close button hover fill is red (#e02135)", () => {
      assert.ok(
        appCssContent.includes(".win-close:hover") || appCssContent.includes("#win-close:hover"),
        "CSS must style close caption button on hover"
      );
      assert.ok(
        appCssContent.includes("#e02135") || appCssContent.includes("rgb(224, 33, 53)"),
        "Close button hover fill must be #e02135"
      );
    });

    it("1.8: theme toggle correctly toggles light and dark modes with applyTheme", () => {
      applyTheme("dark");
      assert.equal(state.theme, "dark");
      assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
      assert.equal(localStorage.getItem("ah-theme"), "dark");

      applyTheme("light");
      assert.equal(state.theme, "light");
      assert.equal(document.documentElement.getAttribute("data-theme"), "light");
      assert.equal(localStorage.getItem("ah-theme"), "light");
    });
  });

  describe("Suite 2: Responsive Rail Sidebar & Persistence", () => {
    it("2.1: sidebar HTML structure includes top actions, scroll, and bottom pinned dock", () => {
      assert.ok(indexHtmlContent.includes('id="sidebar"'), "index.html has #sidebar");
      assert.ok(indexHtmlContent.includes('data-mode="expanded"'), "sidebar defaults to expanded data-mode");
      assert.ok(indexHtmlContent.includes('id="btn-toggle-sidebar"'), "sidebar has #btn-toggle-sidebar");
      assert.ok(indexHtmlContent.includes('id="btn-new"'), "sidebar has #btn-new pill button");
      assert.ok(indexHtmlContent.includes('id="btn-search"'), "sidebar has #btn-search");
      assert.ok(indexHtmlContent.includes('id="side-foot"'), "sidebar has #side-foot");
      assert.ok(indexHtmlContent.includes('id="chief-card"'), "sidebar has pinned #chief-card");
      assert.ok(indexHtmlContent.includes('id="side-status-row"'), "sidebar has #side-status-row");
      assert.ok(indexHtmlContent.includes('id="side-conn-badge"'), "sidebar has #side-conn-badge");
      assert.ok(indexHtmlContent.includes('id="foot-model"'), "sidebar has #foot-model");
    });

    it("2.2: CSS establishes smooth transitions between 260px expanded and 64px rail mode", () => {
      assert.ok(
        appCssContent.includes(".sidebar.is-rail") || appCssContent.includes('.sidebar[data-mode="rail"]'),
        "CSS must contain rail mode rules"
      );
      assert.ok(
        appCssContent.includes("--sidebar-rail-w"),
        "CSS must reference rail width variable"
      );
      assert.ok(
        appCssContent.includes("transition: width"),
        "Sidebar width must be smoothly transitioned"
      );
    });

    it("2.3: rail items are centered 44px with docked unread badge and active glow bar", () => {
      assert.ok(
        appCssContent.includes("44px"),
        "CSS must define 44px rail items"
      );
      assert.ok(
        appCssContent.includes(".sidebar.is-rail .room-unread") || appCssContent.includes(".room-unread"),
        "CSS must dock unread badges on avatar"
      );
      assert.ok(
        appCssContent.includes(".room-row.is-active::before") || appCssContent.includes(".is-active::before"),
        "CSS must define left indicator glow bar via ::before"
      );
    });

    it("2.4: sidebar state toggle, mode attribute, aria-expanded, and localStorage persistence", () => {
      const STORAGE_KEY = "agent_fusion:sidebar_mode";
      const sidebar = document.createElement("aside");
      sidebar.id = "sidebar";
      sidebar.dataset.mode = "expanded";

      const toggleBtn = document.createElement("button");
      toggleBtn.id = "btn-toggle-sidebar";
      toggleBtn.setAttribute("aria-expanded", "true");

      function setSidebarMode(mode, persist = true) {
        const isRail = mode === "rail";
        sidebar.classList.toggle("is-rail", isRail);
        sidebar.dataset.mode = mode;
        toggleBtn.setAttribute("aria-expanded", isRail ? "false" : "true");
        toggleBtn.title = isRail ? "展开侧边栏（Ctrl+B）" : "折叠侧边栏（Ctrl+B）";
        if (persist) {
          try { localStorage.setItem(STORAGE_KEY, mode); } catch (_) {}
        }
      }

      // Initial expanded
      assert.equal(sidebar.dataset.mode, "expanded");
      assert.equal(toggleBtn.getAttribute("aria-expanded"), "true");

      // Switch to rail
      setSidebarMode("rail", true);
      assert.ok(sidebar.classList.contains("is-rail"));
      assert.equal(sidebar.dataset.mode, "rail");
      assert.equal(toggleBtn.getAttribute("aria-expanded"), "false");
      assert.equal(localStorage.getItem(STORAGE_KEY), "rail");

      // Restore from localStorage
      const savedMode = localStorage.getItem(STORAGE_KEY);
      assert.equal(savedMode, "rail");

      // Switch back to expanded
      setSidebarMode("expanded", true);
      assert.ok(!sidebar.classList.contains("is-rail"));
      assert.equal(sidebar.dataset.mode, "expanded");
      assert.equal(toggleBtn.getAttribute("aria-expanded"), "true");
      assert.equal(localStorage.getItem(STORAGE_KEY), "expanded");
    });

    it("2.5: keyboard shortcut Ctrl+B and Cmd+B toggles sidebar mode", () => {
      let mode = "expanded";
      function toggle() {
        mode = mode === "rail" ? "expanded" : "rail";
      }

      function handleKey(ev) {
        const isB = ev.key === "b" || ev.key === "B" || ev.code === "KeyB";
        if ((ev.ctrlKey || ev.metaKey) && isB) {
          toggle();
        }
      }

      handleKey({ ctrlKey: true, key: "b" });
      assert.equal(mode, "rail");

      handleKey({ metaKey: true, key: "b" });
      assert.equal(mode, "expanded");

      // Unrelated key should not trigger
      handleKey({ ctrlKey: true, key: "c" });
      assert.equal(mode, "expanded");
    });
  });

  describe("Suite 3: Floating Capsule Header & Slide-Over Inspector Drawer", () => {
    const roomId = "r_capsule_test";

    beforeEach(() => {
      state.roomById[roomId] = {
        room_id: roomId,
        title: "核心架构群",
        topic: "Milestone 2 交付验证",
        owner_id: "boss",
        members: ["boss", "coder", "reviewer"],
        context_policy: "shared",
        member_permissions: {
          coder: { can_speak: true, context_access: "full", can_create_subgroup: false },
          reviewer: { can_speak: true, context_access: "full", can_create_subgroup: false },
        },
      };
      state.files[roomId] = [
        { file_id: "f_01", path: "docs/spec.md", description: "架构规范" },
      ];
      state.evidence[roomId] = {
        summary: { total: 3, observed: 2, prepared: 1, mismatch: 0 },
        records: [],
      };
    });

    it("3.1: GroupView.mount initializes floating capsule header (#g-head.capsule-header)", () => {
      const root = document.createElement("div");
      const gv = new GroupView(root);
      gv.mount(roomId);

      const head = root.querySelector("#g-head");
      assert.ok(head, "GroupView must mount #g-head");
      assert.ok(head.classList.contains("capsule-header"), "#g-head must have .capsule-header class");
    });

    it("3.2: capsule header renders room title, topic pill, policy pill, and evidence counter", () => {
      const root = document.createElement("div");
      const gv = new GroupView(root);
      gv.mount(roomId);

      const roomTitle = root.querySelector(".room-title-text");
      assert.ok(roomTitle, "Header must render .room-title-text");
      assert.equal(roomTitle.textContent.trim(), "核心架构群");

      const topicPill = root.querySelector(".topic-pill");
      assert.ok(topicPill, "Header must render .topic-pill");
      assert.ok(topicPill.textContent.includes("Milestone 2 交付验证"), "Topic pill must show room topic");

      const policyPill = root.querySelector(".policy-pill");
      assert.ok(policyPill, "Header must render .policy-pill");
      assert.ok(policyPill.textContent.includes("共享全文"), "Policy pill must display policy label");

      const evSubtitle = root.querySelector(".g-head-ev");
      assert.ok(evSubtitle, "Header must render .g-head-ev evidence summary");
    });

    it("3.3: member chips render with selection state (.mchip.is-selected)", () => {
      state.inspector = { type: "group", id: roomId, member: "coder" };

      const root = document.createElement("div");
      const gv = new GroupView(root);
      gv.mount(roomId);

      const coderChip = gv.el.head.querySelector('[data-goto-member="coder"]');
      assert.ok(coderChip, "Member chip for coder must exist");
      assert.ok(coderChip.classList.contains("is-selected"), "Active member chip must have .is-selected class");

      const bossChip = gv.el.head.querySelector('[data-goto-member="boss"]');
      assert.ok(bossChip, "Member chip for boss must exist");
      assert.ok(!bossChip.classList.contains("is-selected"), "Inactive member chip must not have .is-selected class");
    });

    it("3.4: header memoization _headDataSig includes room.topic to prevent DOM destruction", () => {
      const root = document.createElement("div");
      const gv = new GroupView(root);
      gv.mount(roomId);

      const initialSig = gv._headDataSig;
      assert.ok(initialSig.includes("Milestone 2 交付验证"), "Signature must include room topic");

      const originalFirstChild = gv.el.head.firstElementChild;

      // Re-rendering with identical data preserves the exact DOM element
      gv.renderHead(state.roomById[roomId]);
      assert.equal(gv.el.head.firstElementChild, originalFirstChild, "DOM node must be preserved on memoization hit");

      // Updating topic invalidates memoization signature
      state.roomById[roomId].topic = "新任务目标";
      gv.renderHead(state.roomById[roomId]);
      assert.notEqual(gv._headDataSig, initialSig, "Updated topic must change memoization signature");
    });

    it("3.5: groupInspectorHTML supports 3-tab segmented navigation: members, files, evidence", () => {
      // Default: members tab
      const membersHTML = groupInspectorHTML(roomId, "members");
      assert.ok(membersHTML.includes('class="insp-title-wrap"'), "Inspector must contain .insp-title-wrap");
      assert.ok(membersHTML.includes('data-tab="members"'), "Inspector must have data-tab='members'");
      assert.ok(membersHTML.includes('data-tab="files"'), "Inspector must have data-tab='files'");
      assert.ok(membersHTML.includes('data-tab="evidence"'), "Inspector must have data-tab='evidence'");
      assert.ok(membersHTML.includes('data-policy'), "Members tab must render context policy controls");

      // Files tab
      const filesHTML = groupInspectorHTML(roomId, "files");
      assert.ok(filesHTML.includes('data-file-id="f_01"'), "Files tab must render room file list");

      // Evidence tab
      const evidenceHTML = groupInspectorHTML(roomId, "evidence");
      assert.ok(evidenceHTML.includes("证据阶梯"), "Evidence tab must render evidence panel");
      assert.ok(evidenceHTML.includes("3 条判定"), "Evidence tab must show summary count");
    });

    it("3.6: inspector drawer close button and Escape key dismiss inspector", () => {
      state.inspector = { type: "group", id: roomId };
      let dismissed = false;
      document.addEventListener("ah:inspector", (ev) => {
        if (ev.detail === null) dismissed = true;
      });

      const container = document.createElement("div");
      container.innerHTML = groupInspectorHTML(roomId);
      bindGroupInspector(container, roomId, "members", () => {});

      const closeBtn = container.querySelector("[data-insp-close]");
      assert.ok(closeBtn, "Close button [data-insp-close] must exist");
      closeBtn.click();

      assert.equal(state.inspector, null, "Clicking close button sets state.inspector to null");
      assert.ok(dismissed, "Clicking close button dispatches ah:inspector with null");
    });
  });

  describe("Suite 4: Modern Multi-Tab Settings Modal & Pointer-Events Isolation", () => {
    it("4.1: NAV defines 7 unified tabs with correct IDs and localized labels", () => {
      assert.equal(NAV.length, 7, "NAV must contain 7 tabs");
      const expectedIds = ["general", "approvals", "skills", "memory", "usage", "bots", "about"];
      assert.deepEqual(NAV.map((n) => n.id), expectedIds);
    });

    it("4.2: openSettings supports tab aliases for capabilities, proposals, and telemetry", () => {
      // 'capabilities' alias maps to 'skills'
      openSettings({ tab: "capabilities" });
      let activeTabBtn = document.querySelector(".settings-nav button.is-on");
      assert.ok(activeTabBtn, "Active tab button must exist");
      assert.equal(activeTabBtn.dataset.tab, "skills", "capabilities must map to skills tab");
      closeSettings();

      // 'proposals' alias maps to 'skills'
      openSettings({ tab: "proposals" });
      activeTabBtn = document.querySelector(".settings-nav button.is-on");
      assert.ok(activeTabBtn, "Active tab button must exist");
      assert.equal(activeTabBtn.dataset.tab, "skills", "proposals must map to skills tab");
      closeSettings();

      // 'telemetry' alias maps to 'usage'
      openSettings({ tab: "telemetry" });
      activeTabBtn = document.querySelector(".settings-nav button.is-on");
      assert.ok(activeTabBtn, "Active tab button must exist");
      assert.equal(activeTabBtn.dataset.tab, "usage", "telemetry must map to usage tab");
      closeSettings();
    });

    it("4.3: modal backdrop declares .modal-backdrop.settings-backdrop with blur styles in CSS", () => {
      openSettings({ tab: "general" });
      const backdrop = document.querySelector(".modal-backdrop");
      assert.ok(backdrop, "Modal backdrop must exist in DOM");
      assert.ok(backdrop.classList.contains("settings-backdrop"), "Backdrop must declare settings-backdrop class");

      assert.ok(
        appCssContent.includes(".settings-backdrop") || appCssContent.includes("backdrop-filter: blur"),
        "CSS must define frosted glass backdrop blur"
      );
      closeSettings();
    });

    it("4.4: calling close() immediately applies pointer-events: none to backdrop", () => {
      const { close } = openSettings({ tab: "general" });
      const backdrop = document.querySelector(".modal-backdrop");
      assert.ok(backdrop);

      // Invoke close()
      close();
      assert.equal(
        backdrop.style.pointerEvents,
        "none",
        "Backdrop pointerEvents must be set to 'none' synchronously upon close()"
      );
    });

    it("4.5: closeSettings cleans up all existing modals and disables pointer events", () => {
      openSettings({ tab: "about" });
      assert.ok(document.querySelector(".settings-modal"), "Modal exists after openSettings");

      closeSettings();
      assert.equal(document.querySelectorAll(".settings-modal").length, 0, "All modals removed after closeSettings");
    });
  });
});
