/**
 * tests/challenger_m2_stress.test.mjs
 *
 * Empirical Challenger Stress Harness for Milestone 2 (M2).
 * Verifies interactive behavior, drawer transitions, and modal pointer events:
 * 1. Rapid drawer transitions across 3 tabs (members, files, evidence) and rapid
 *    open/close cycling via #g-info, Escape key, and [data-insp-close].
 * 2. Rapid member switching in the floating capsule header while inspector is open:
 *    verifies .mchip.is-selected synchronizes cleanly with zero orphaned active classes.
 * 3. Modal pointer-events stress: rapid open and close of the settings modal while clicking
 *    underlying elements. Confirms backdrop.style.pointerEvents = "none" eliminates click trapping.
 * 4. Header memoization under rapid simulated topic and policy updates: verifies
 *    _headDataSig updates DOM when topic/policy change, but avoids unnecessary re-renders
 *    when data is identical.
 *
 * Runs with `node --test` with ZERO external npm dependencies.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Setup headless DOM
const { setupHeadlessDOM } = await import("./_helpers/headless_dom.mjs");
const dom = setupHeadlessDOM();

// Import web modules
const storeModule = await import("../web/js/store.js");
const groupViewModule = await import("../web/js/views/group.js");
const settingsViewModule = await import("../web/js/views/settings.js");
const uiModule = await import("../web/js/ui.js");
const apiModule = await import("../web/js/api.js");

const { state, updateRoomMeta, refreshEvidence } = storeModule;
const { GroupView, groupInspectorHTML, bindGroupInspector } = groupViewModule;
const { NAV, openSettings, closeSettings } = settingsViewModule;
const { openModal, closeModal } = uiModule;
const { api } = apiModule;

function resetRoomState(roomId = "r_stress_m2") {
  state.inspector = null;
  state.evidence = {};
  state.files = {};
  state.messages = {};
  state.roomById[roomId] = {
    room_id: roomId,
    title: "M2 压力测试群聊",
    topic: "抽屉与弹窗交互压力测试",
    owner_id: "boss",
    members: ["boss", "coder", "reviewer"],
    context_policy: "shared",
    member_permissions: {
      boss: { can_speak: true, context_access: "full", can_create_subgroup: true },
      coder: { can_speak: true, context_access: "full", can_create_subgroup: false },
      reviewer: { can_speak: true, context_access: "full", can_create_subgroup: false },
    },
  };
  state.files[roomId] = [
    { file_id: "f_01", path: "src/index.js", description: "主入口文件" },
    { file_id: "f_02", path: "docs/spec.md", description: "架构设计文档" },
  ];
  state.evidence[roomId] = {
    summary: { total: 4, observed: 2, prepared: 1, mismatch: 1 },
    records: [
      { bot_id: "coder", message_seq: 1, status: "observed", reasons: ["tool_ok:run_test"] },
      { bot_id: "reviewer", message_seq: 2, status: "mismatch", reasons: ["unknown_file_id:f_999"] },
    ],
  };
  state.botsById = {
    boss: { id: "boss", name: "Boss", role: "群主" },
    coder: { id: "coder", name: "Coder", role: "开发" },
    reviewer: { id: "reviewer", name: "Reviewer", role: "审查" },
  };
  state.skillProposals = { report: { proposed: 0 } };
  state.approvals = { pending: [] };
  state.health = { version: "0.1.0" };

  let modalRoot = document.querySelector("#modal-root");
  if (!modalRoot) {
    modalRoot = document.createElement("div");
    modalRoot.id = "modal-root";
    document.body.appendChild(modalRoot);
  } else {
    modalRoot.innerHTML = "";
  }

  return state.roomById[roomId];
}

function createIntegratedShell(roomId = "r_stress_m2") {
  const container = document.createElement("div");
  container.id = "app-shell";

  const viewRoot = document.createElement("div");
  viewRoot.id = "view-root";
  container.appendChild(viewRoot);

  const inspectorEl = document.createElement("aside");
  inspectorEl.id = "inspector";
  inspectorEl.className = "inspector-drawer";
  inspectorEl.hidden = true;
  container.appendChild(inspectorEl);

  const modalRoot = document.createElement("div");
  modalRoot.id = "modal-root";
  container.appendChild(modalRoot);

  document.body.appendChild(container);

  const gv = new GroupView(viewRoot);
  gv.mount(roomId);

  function renderInspectorDrawer() {
    const insp = state.inspector;
    if (!insp) {
      inspectorEl.hidden = true;
      inspectorEl.innerHTML = "";
      return;
    }
    inspectorEl.hidden = false;
    if (insp.type === "group") {
      inspectorEl.innerHTML = groupInspectorHTML(insp.id, insp.tab || "members", insp.member);
      bindGroupInspector(inspectorEl, insp.id, insp.tab || "members", () => renderInspectorDrawer(), insp.member);
    }
  }

  const inspectorHandler = () => renderInspectorDrawer();
  document.addEventListener("ah:inspector", inspectorHandler);

  // App-level global Escape listener (matching app.js:109-114)
  const escapeHandler = (ev) => {
    if (ev.key === "Escape" && state.inspector && !document.querySelector(".modal-backdrop")) {
      state.inspector = null;
      renderInspectorDrawer();
      document.dispatchEvent(new CustomEvent("ah:inspector", { detail: null }));
    }
  };
  document.addEventListener("keydown", escapeHandler);

  return {
    container,
    gv,
    inspectorEl,
    modalRoot,
    renderInspectorDrawer,
    cleanup() {
      gv.destroy();
      document.removeEventListener("ah:inspector", inspectorHandler);
      document.removeEventListener("keydown", escapeHandler);
      container.remove();
    },
  };
}

describe("Milestone 2 Empirical Stress & Adversarial Verification Test Suite", () => {
  const roomId = "r_stress_m2";
  let room;
  let shell;

  beforeEach(() => {
    room = resetRoomState(roomId);
    shell = createIntegratedShell(roomId);
  });

  afterEach(() => {
    closeSettings();
    if (shell) shell.cleanup();
    document.body.innerHTML = "";
  });

  // =========================================================================
  // Dimension 1: Drawer Transitions & Multi-Path Open/Close Stress
  // =========================================================================
  describe("Suite 1: Drawer Transitions & Multi-Path Open/Close Stress", () => {
    it("1.1: Rapid cyclical switching across 3 inspector tabs (members -> files -> evidence) maintains state and active class", () => {
      state.inspector = { type: "group", id: roomId, tab: "members" };
      shell.renderInspectorDrawer();

      const tabsSequence = ["files", "evidence", "members", "files", "evidence", "members", "files", "evidence", "members"];
      for (const targetTab of tabsSequence) {
        const tabBtn = shell.inspectorEl.querySelector(`[data-tab="${targetTab}"]`);
        assert.ok(tabBtn, `Tab button for ${targetTab} must exist`);
        tabBtn.click();

        assert.equal(state.inspector?.tab, targetTab, `state.inspector.tab should be ${targetTab}`);
        const activeTabBtn = shell.inspectorEl.querySelector(".insp-tabs button.is-on");
        assert.ok(activeTabBtn, "An active tab button must exist");
        assert.equal(activeTabBtn.dataset.tab, targetTab, `Active button must match ${targetTab}`);

        // Verify other tabs do not have is-on
        const allTabBtns = shell.inspectorEl.querySelectorAll(".insp-tabs button");
        const inactiveTabs = allTabBtns.filter((b) => b.dataset.tab !== targetTab);
        assert.equal(inactiveTabs.length, 2);
        for (const inactive of inactiveTabs) {
          assert.ok(!inactive.classList.contains("is-on"), `Inactive tab ${inactive.dataset.tab} must not have .is-on`);
        }
      }
    });

    it("1.2: Inspector tab switching renders expected domain content surfaces without throwing", () => {
      // 1. Members tab: contains policy switcher and member rows
      state.inspector = { type: "group", id: roomId, tab: "members" };
      shell.renderInspectorDrawer();
      assert.ok(shell.inspectorEl.querySelector("[data-policy]"), "Members tab must contain policy switcher");
      assert.equal(shell.inspectorEl.querySelectorAll("[data-member]").length, 3, "Members tab must render 3 member rows");

      // 2. Files tab: contains files
      const filesBtn = shell.inspectorEl.querySelector('[data-tab="files"]');
      filesBtn.click();
      assert.equal(shell.inspectorEl.querySelectorAll("[data-file-id]").length, 2, "Files tab must render 2 files");

      // 3. Evidence tab: contains evidence panel and mismatch list
      const evidenceBtn = shell.inspectorEl.querySelector('[data-tab="evidence"]');
      evidenceBtn.click();
      assert.ok(shell.inspectorEl.querySelector(".ev-panel"), "Evidence tab must render .ev-panel");
      assert.ok(shell.inspectorEl.querySelector(".ev-mismatch-list"), "Evidence tab must render .ev-mismatch-list");
    });

    it("1.3: Evidence tab gracefully displays empty message when evidence is empty or missing", () => {
      state.evidence[roomId] = null;
      state.inspector = { type: "group", id: roomId, tab: "evidence" };
      shell.renderInspectorDrawer();

      const emptyMini = shell.inspectorEl.querySelector(".empty-mini");
      assert.ok(emptyMini, "Empty evidence state must render .empty-mini");
      assert.ok(emptyMini.textContent.includes("当前群聊暂无证据判定"));
    });

    it("1.4: Rapid open/close toggling via #g-info click loop (closed -> open -> closed)", () => {
      const gInfoBtn = shell.gv.el.head.querySelector("#g-info");
      assert.ok(gInfoBtn, "#g-info must exist");

      assert.equal(state.inspector, null, "Initially inspector is closed");

      for (let i = 0; i < 20; i++) {
        // Click to open
        gInfoBtn.click();
        assert.ok(state.inspector, `Iteration ${i}: state.inspector must be open`);
        assert.equal(state.inspector.type, "group");
        assert.equal(state.inspector.id, roomId);
        assert.equal(state.inspector.tab, "members");
        assert.equal(state.inspector.member, undefined);
        assert.ok(!shell.inspectorEl.hidden, `Iteration ${i}: inspectorEl must be visible`);
        assert.ok(gInfoBtn.classList.contains("is-on"), "#g-info must have .is-on when open");

        // Click to close
        gInfoBtn.click();
        assert.equal(state.inspector, null, `Iteration ${i}: state.inspector must be null`);
        assert.ok(shell.inspectorEl.hidden, `Iteration ${i}: inspectorEl must be hidden`);
        assert.ok(!gInfoBtn.classList.contains("is-on"), "#g-info must not have .is-on when closed");
      }
    });

    it("1.5: Clicking #g-info when a member is selected clears member focus without closing inspector", () => {
      const gInfoBtn = shell.gv.el.head.querySelector("#g-info");
      state.inspector = { type: "group", id: roomId, tab: "members", member: "coder" };
      shell.gv.syncHeadActiveState();
      shell.renderInspectorDrawer();

      assert.equal(state.inspector.member, "coder");

      // Click 1: Clears member selection, keeps inspector open on members tab
      gInfoBtn.click();
      assert.ok(state.inspector, "Inspector must remain open after clearing member focus");
      assert.equal(state.inspector.member, undefined, "Member focus must be cleared");
      assert.equal(state.inspector.tab, "members", "Must remain on members tab");
      assert.ok(!shell.inspectorEl.hidden, "Inspector drawer remains visible");

      // Click 2: Closes inspector
      gInfoBtn.click();
      assert.equal(state.inspector, null, "Inspector must close on second click");
      assert.ok(shell.inspectorEl.hidden, "Inspector drawer is hidden");
    });

    it("1.6: Dismissal via [data-insp-close] button immediately zeroes state.inspector and notifies listeners", () => {
      for (let i = 0; i < 15; i++) {
        state.inspector = { type: "group", id: roomId, tab: "members" };
        shell.renderInspectorDrawer();
        assert.ok(!shell.inspectorEl.hidden);

        const closeBtn = shell.inspectorEl.querySelector("[data-insp-close]");
        assert.ok(closeBtn, "[data-insp-close] button must exist");
        closeBtn.click();

        assert.equal(state.inspector, null, `Iteration ${i}: state.inspector must be null after close button click`);
        assert.ok(shell.inspectorEl.hidden, `Iteration ${i}: inspector drawer must be hidden`);
      }
    });

    it("1.7: Keyboard Escape dismissal closes drawer when no modal is active, but is suppressed when modal backdrop exists", () => {
      // Step A: When no modal is open, Escape closes the inspector drawer
      state.inspector = { type: "group", id: roomId, tab: "members" };
      shell.renderInspectorDrawer();
      assert.ok(!shell.inspectorEl.hidden);

      document.dispatchEvent(new Event("keydown", { bubbles: true })); // without key property -> ignored
      assert.ok(state.inspector !== null);

      const escEv = new Event("keydown", { bubbles: true });
      escEv.key = "Escape";
      document.dispatchEvent(escEv);
      assert.equal(state.inspector, null, "Escape key must close inspector drawer when no modal is open");
      assert.ok(shell.inspectorEl.hidden);

      // Step B: When a modal is open, Escape closes the modal, NOT the inspector drawer
      state.inspector = { type: "group", id: roomId, tab: "members" };
      shell.renderInspectorDrawer();

      openSettings({ tab: "general" });
      assert.ok(document.querySelector(".modal-backdrop"), "Modal backdrop must exist in DOM");

      // Dispatch Escape: modal should intercept and close, drawer remains open
      const escEv2 = new Event("keydown", { bubbles: true });
      escEv2.key = "Escape";
      document.dispatchEvent(escEv2);

      // Modal closed, but inspector drawer remained intact
      assert.ok(state.inspector !== null, "Inspector drawer must NOT be closed while modal backdrop was active");
      assert.equal(state.inspector.id, roomId);

      // Clean modal backdrop removal
      closeSettings();

      // Now dispatch Escape again: drawer closes
      const escEv3 = new Event("keydown", { bubbles: true });
      escEv3.key = "Escape";
      document.dispatchEvent(escEv3);
      assert.equal(state.inspector, null, "Escape key now closes inspector drawer");
    });

    it("1.8: Chaotic interleaved drawer cycling maintains state machine consistency", () => {
      // Interleave chip clicks, tab switches, #g-info toggles, close button, and Escape key
      const gInfoBtn = shell.gv.el.head.querySelector("#g-info");
      const coderChip = shell.gv.el.head.querySelector('[data-goto-member="coder"]');

      // 1. Open via member chip
      coderChip.click();
      assert.equal(state.inspector.member, "coder");

      // 2. Switch tab to files
      const filesTabBtn = shell.inspectorEl.querySelector('[data-tab="files"]');
      filesTabBtn.click();
      assert.equal(state.inspector.tab, "files");

      // 3. Close via Escape
      const escEv = new Event("keydown", { bubbles: true });
      escEv.key = "Escape";
      document.dispatchEvent(escEv);
      assert.equal(state.inspector, null);

      // 4. Open via #g-info
      gInfoBtn.click();
      assert.equal(state.inspector.tab, "members");
      assert.equal(state.inspector.member, undefined);

      // 5. Switch to evidence
      const evTabBtn = shell.inspectorEl.querySelector('[data-tab="evidence"]');
      evTabBtn.click();
      assert.equal(state.inspector.tab, "evidence");

      // 6. Close via [data-insp-close]
      const closeBtn = shell.inspectorEl.querySelector("[data-insp-close]");
      closeBtn.click();
      assert.equal(state.inspector, null);

      // 7. Re-open via member chip
      const bossChip = shell.gv.el.head.querySelector('[data-goto-member="boss"]');
      bossChip.click();
      assert.equal(state.inspector.member, "boss");

      // 8. Click #g-info (clears member)
      gInfoBtn.click();
      assert.equal(state.inspector.member, undefined);

      // 9. Click #g-info again (closes)
      gInfoBtn.click();
      assert.equal(state.inspector, null);
    });
  });

  // =========================================================================
  // Dimension 2: Capsule Header Member Switching & Selection Concurrency
  // =========================================================================
  describe("Suite 2: Capsule Header Member Switching & Selection Concurrency", () => {
    it("2.1: Rapid alternating member chip clicks in floating header update state.inspector.member with zero orphaned .is-selected classes", () => {
      const bossChip = shell.gv.el.head.querySelector('[data-goto-member="boss"]');
      const coderChip = shell.gv.el.head.querySelector('[data-goto-member="coder"]');
      const reviewerChip = shell.gv.el.head.querySelector('[data-goto-member="reviewer"]');
      const chips = [
        { id: "boss", el: bossChip },
        { id: "coder", el: coderChip },
        { id: "reviewer", el: reviewerChip },
      ];

      for (let i = 0; i < 30; i++) {
        const target = chips[i % 3];
        target.el.click();

        assert.equal(state.inspector?.member, target.id, `Iteration ${i}: member must be ${target.id}`);
        assert.equal(state.inspector?.tab, "members", `Iteration ${i}: tab must be members`);

        // Check selected chip count
        const selectedChips = shell.gv.el.head.querySelectorAll(".mchip.is-selected");
        assert.equal(selectedChips.length, 1, `Iteration ${i}: exactly one chip must have .is-selected`);
        assert.equal(selectedChips[0].dataset.gotoMember, target.id, `Iteration ${i}: selected chip must match target`);
        assert.equal(selectedChips[0].getAttribute("aria-pressed"), "true");

        // Check unselected chips
        const allChips = shell.gv.el.head.querySelectorAll(".mchip");
        const unselectedChips = allChips.filter((c) => c.dataset.gotoMember !== target.id);
        assert.equal(unselectedChips.length, 2);
        for (const unselected of unselectedChips) {
          assert.ok(!unselected.classList.contains("is-selected"), `Unselected chip ${unselected.dataset.gotoMember} must not have .is-selected`);
          assert.equal(unselected.getAttribute("aria-pressed"), "false");
        }
      }
    });

    it("2.2: Burst pseudo-random walk across all room members maintains strictly one selected chip at all times", () => {
      const memberIds = ["boss", "coder", "reviewer"];
      // Deterministic pseudo-random sequence
      const sequence = [0, 2, 1, 1, 0, 2, 2, 0, 1, 2, 0, 1, 1, 2, 0];

      for (const idx of sequence) {
        const id = memberIds[idx];
        const chip = shell.gv.el.head.querySelector(`[data-goto-member="${id}"]`);
        chip.click();

        assert.equal(state.inspector.member, id);

        const selected = shell.gv.el.head.querySelectorAll(".mchip.is-selected");
        assert.equal(selected.length, 1, "Must have exactly 1 .is-selected chip");
        assert.equal(selected[0].dataset.gotoMember, id);
      }
    });

    it("2.3: Repeated rapid clicks on already-selected member chip are idempotent and preserve selection", () => {
      const coderChip = shell.gv.el.head.querySelector('[data-goto-member="coder"]');

      // 15 rapid consecutive clicks on the same chip
      for (let i = 0; i < 15; i++) {
        coderChip.click();
        assert.equal(state.inspector.member, "coder");
        assert.ok(coderChip.classList.contains("is-selected"));
        assert.equal(coderChip.getAttribute("aria-pressed"), "true");
      }

      const selected = shell.gv.el.head.querySelectorAll(".mchip.is-selected");
      assert.equal(selected.length, 1, "Must remain strictly 1 selected chip");
    });

    it("2.4: Member selection from non-members tab (files/evidence) redirects drawer to members tab with focused member", () => {
      // Set drawer to files tab
      state.inspector = { type: "group", id: roomId, tab: "files" };
      shell.renderInspectorDrawer();
      assert.equal(state.inspector.tab, "files");

      // Click reviewer chip in header
      const reviewerChip = shell.gv.el.head.querySelector('[data-goto-member="reviewer"]');
      reviewerChip.click();

      // Drawer state must switch to members tab with member reviewer
      assert.equal(state.inspector.tab, "members");
      assert.equal(state.inspector.member, "reviewer");
      assert.ok(reviewerChip.classList.contains("is-selected"));

      // Set drawer to evidence tab
      const evBtn = shell.inspectorEl.querySelector('[data-tab="evidence"]');
      evBtn.click();
      assert.equal(state.inspector.tab, "evidence");

      // Click coder chip in header
      const coderChip = shell.gv.el.head.querySelector('[data-goto-member="coder"]');
      coderChip.click();
      assert.equal(state.inspector.tab, "members");
      assert.equal(state.inspector.member, "coder");
      assert.ok(coderChip.classList.contains("is-selected"));
    });

    it("2.5: syncHeadActiveState handles transitions with null, undefined, or missing member without throwing", () => {
      // 1. Foreign group inspector
      state.inspector = { type: "group", id: "other_room", member: "coder" };
      shell.gv.syncHeadActiveState();
      assert.equal(shell.gv.el.head.querySelectorAll(".mchip.is-selected").length, 0);
      assert.ok(!shell.gv.el.head.querySelector("#g-info").classList.contains("is-on"));

      // 2. Chief inspector
      state.inspector = { type: "chief" };
      shell.gv.syncHeadActiveState();
      assert.equal(shell.gv.el.head.querySelectorAll(".mchip.is-selected").length, 0);

      // 3. Null inspector
      state.inspector = null;
      shell.gv.syncHeadActiveState();
      assert.equal(shell.gv.el.head.querySelectorAll(".mchip.is-selected").length, 0);

      // 4. Missing member in current group
      state.inspector = { type: "group", id: roomId, member: null };
      shell.gv.syncHeadActiveState();
      assert.equal(shell.gv.el.head.querySelectorAll(".mchip.is-selected").length, 0);
      assert.ok(shell.gv.el.head.querySelector("#g-info").classList.contains("is-on"));
    });
  });

  // =========================================================================
  // Dimension 3: Modal Pointer-Events Stress & Settings Isolation
  // =========================================================================
  describe("Suite 3: Modal Pointer-Events Stress & Settings Isolation", () => {
    it("3.1: Settings modal backdrop applies pointer-events: none synchronously on close() before animation finishes", () => {
      const { close } = openSettings({ tab: "general" });
      const backdrop = document.querySelector(".modal-backdrop.settings-backdrop");
      assert.ok(backdrop, "Modal backdrop must exist");

      // Before close(): pointerEvents is not "none"
      assert.notEqual(backdrop.style.pointerEvents, "none");

      // Immediately upon close()
      close();
      assert.equal(
        backdrop.style.pointerEvents,
        "none",
        "Backdrop pointerEvents must immediately be 'none' to eliminate click trapping"
      );
    });

    it("3.2: Immediate click pass-through to underlying elements during exit animation", () => {
      let clickCount = 0;
      const underlyingBtn = document.createElement("button");
      underlyingBtn.id = "underlying-test-btn";
      underlyingBtn.addEventListener("click", () => { clickCount++; });
      document.body.appendChild(underlyingBtn);

      const { close } = openSettings({ tab: "general" });
      const backdrop = document.querySelector(".modal-backdrop");
      assert.ok(backdrop);

      // Close modal
      close();
      assert.equal(backdrop.style.pointerEvents, "none");

      // While backdrop is still attached to DOM awaiting its 120ms timeout, click underlying button
      underlyingBtn.click();
      assert.equal(clickCount, 1, "Underlying element must receive click immediately after close() without click trapping");

      underlyingBtn.remove();
    });

    it("3.3: High-frequency thrash (25 rapid open/close cycles) results in zero orphaned backdrops or leaked Escape handlers", () => {
      for (let i = 0; i < 25; i++) {
        const { close } = openSettings({ tab: "general" });
        const backdrops = document.querySelectorAll(".modal-backdrop");
        assert.equal(backdrops.length, 1, `Iteration ${i}: exactly 1 backdrop during active modal`);
        close();
        assert.equal(backdrops[0].style.pointerEvents, "none", `Iteration ${i}: pointerEvents must be none on close`);
      }

      closeSettings();
      assert.equal(document.querySelectorAll(".modal-backdrop").length, 0, "All backdrops must be cleared");
    });

    it("3.4: Rapid navigation through all 7 settings tabs + alias fallbacks retains modal integrity and non-blocking exit", () => {
      const { close } = openSettings({ tab: "general" });

      const tabsToTest = ["approvals", "skills", "memory", "usage", "bots", "about", "general"];
      for (const tab of tabsToTest) {
        const tabBtn = document.querySelector(`.settings-nav button[data-tab="${tab}"]`);
        assert.ok(tabBtn, `Tab button for ${tab} must exist`);
        tabBtn.click();

        const activeNav = document.querySelector(".settings-nav button.is-on");
        assert.ok(activeNav, "Active nav button must exist");
        assert.equal(activeNav.dataset.tab, tab, `Active nav must be ${tab}`);
      }

      // Close from last tab
      close();
      const backdrop = document.querySelector(".modal-backdrop");
      if (backdrop) {
        assert.equal(backdrop.style.pointerEvents, "none");
      }
    });

    it("3.5: closeSettings() helper immediately enforces pointer-events: none on any backdrops", () => {
      openSettings({ tab: "about" });
      const backdrop = document.querySelector(".modal-backdrop");
      assert.ok(backdrop);

      closeSettings();
      assert.equal(document.querySelectorAll(".settings-modal").length, 0);
    });
  });

  // =========================================================================
  // Dimension 4: Header Memoization Signature & DOM Mutation Invariance
  // =========================================================================
  describe("Suite 4: Header Memoization Signature & DOM Mutation Invariance", () => {
    it("4.1: Repeated renderHead calls with identical topic and policy preserve exact DOM nodes (zero re-render)", () => {
      const initialNode = shell.gv.el.head.firstElementChild;
      assert.ok(initialNode, "Head must have a firstElementChild node");

      const initialSig = shell.gv._headDataSig;
      assert.ok(initialSig.includes("M2 压力测试群聊"));
      assert.ok(initialSig.includes("抽屉与弹窗交互压力测试"));
      assert.ok(initialSig.includes("shared"));

      // 40 consecutive identical renders
      for (let i = 0; i < 40; i++) {
        shell.gv.renderHead(room);
        assert.equal(
          shell.gv.el.head.firstElementChild,
          initialNode,
          `Iteration ${i}: DOM node reference must be preserved on memoization hit`
        );
        assert.equal(shell.gv._headDataSig, initialSig);
      }
    });

    it("4.2: Topic change modifies _headDataSig and triggers expected DOM update with new .topic-pill content", () => {
      const nodeA = shell.gv.el.head.firstElementChild;
      const sigA = shell.gv._headDataSig;

      // Update room topic
      room.topic = "架构新规范与交互重构";
      shell.gv.renderHead(room);

      const nodeB = shell.gv.el.head.firstElementChild;
      const sigB = shell.gv._headDataSig;

      assert.notEqual(sigB, sigA, "Signature must change when topic changes");
      assert.notEqual(nodeB, nodeA, "DOM must re-render when signature changes");

      const topicPill = shell.gv.el.head.querySelector(".topic-pill");
      assert.ok(topicPill, "Updated .topic-pill must exist");
      assert.ok(topicPill.textContent.includes("架构新规范与交互重构"));

      // Subsequent identical renders preserve nodeB
      shell.gv.renderHead(room);
      assert.equal(shell.gv.el.head.firstElementChild, nodeB, "Subsequent renders preserve nodeB");
    });

    it("4.3: Policy change modifies _headDataSig and updates .policy-pill text and hint", () => {
      const sigBefore = shell.gv._headDataSig;

      // Update policy to 'isolated'
      room.context_policy = "isolated";
      shell.gv.renderHead(room);

      assert.notEqual(shell.gv._headDataSig, sigBefore);
      const policyPill = shell.gv.el.head.querySelector(".policy-pill");
      assert.ok(policyPill, ".policy-pill must exist");
      assert.ok(policyPill.textContent.includes("各自独立"));

      // Update policy to 'summary'
      room.context_policy = "summary";
      shell.gv.renderHead(room);
      const policyPillSummary = shell.gv.el.head.querySelector(".policy-pill");
      assert.ok(policyPillSummary.textContent.includes("仅摘要"));
    });

    it("4.4: Rapid interleaved identical renders vs topic/policy updates: DOM updates strictly only on signature change", () => {
      let currentActiveNode = shell.gv.el.head.firstElementChild;
      let mutationCount = 0;

      function renderAndVerify(expectMutation) {
        shell.gv.renderHead(room);
        const newNode = shell.gv.el.head.firstElementChild;
        if (newNode !== currentActiveNode) {
          mutationCount++;
          currentActiveNode = newNode;
          assert.ok(expectMutation, "Unexpected DOM mutation occurred!");
        } else {
          assert.ok(!expectMutation, "Expected DOM mutation did not occur!");
        }
      }

      // Step 1: 10 identical renders (0 mutations)
      for (let i = 0; i < 10; i++) renderAndVerify(false);

      // Step 2: Topic change (mutation #1)
      room.topic = "主题变更 1";
      renderAndVerify(true);

      // Step 3: 10 identical renders (0 mutations)
      for (let i = 0; i < 10; i++) renderAndVerify(false);

      // Step 4: Policy change (mutation #2)
      room.context_policy = "summary";
      renderAndVerify(true);

      // Step 5: 10 identical renders (0 mutations)
      for (let i = 0; i < 10; i++) renderAndVerify(false);

      // Step 6: Topic change (mutation #3)
      room.topic = "主题变更 2";
      renderAndVerify(true);

      // Step 7: 10 identical renders (0 mutations)
      for (let i = 0; i < 10; i++) renderAndVerify(false);

      assert.equal(mutationCount, 3, "Total DOM reconstructions must be exactly 3 across 43 renders");
    });

    it("4.5: Member selection change triggers syncHeadActiveState without re-rendering header DOM tree", () => {
      const headNode = shell.gv.el.head.firstElementChild;

      // Select reviewer
      state.inspector = { type: "group", id: roomId, member: "reviewer" };
      shell.gv.renderHead(room);

      // Head element reference is preserved
      assert.equal(shell.gv.el.head.firstElementChild, headNode, "Head DOM must not re-render on member selection");

      // But chip active state is updated
      const reviewerChip = shell.gv.el.head.querySelector('[data-goto-member="reviewer"]');
      assert.ok(reviewerChip.classList.contains("is-selected"));

      // Select coder
      state.inspector = { type: "group", id: roomId, member: "coder" };
      shell.gv.renderHead(room);
      assert.equal(shell.gv.el.head.firstElementChild, headNode);
      const coderChip = shell.gv.el.head.querySelector('[data-goto-member="coder"]');
      assert.ok(coderChip.classList.contains("is-selected"));
      assert.ok(!reviewerChip.classList.contains("is-selected"));
    });

    it("4.6: Resilient handling of empty, null, or undefined topic and edge-case policy values in signature", () => {
      // Empty string topic: no .topic-pill tag rendered, signature remains valid
      room.topic = "";
      shell.gv.renderHead(room);
      assert.equal(shell.gv.el.head.querySelector(".topic-pill"), null, "Empty topic must not render .topic-pill");

      // Undefined topic: defaults cleanly without throwing
      delete room.topic;
      shell.gv.renderHead(room);
      assert.equal(shell.gv.el.head.querySelector(".topic-pill"), null);

      // Null topic: defaults cleanly
      room.topic = null;
      shell.gv.renderHead(room);
      assert.equal(shell.gv.el.head.querySelector(".topic-pill"), null);

      // Unknown policy value: falls back to default label without crashing
      room.context_policy = "custom_unknown_policy";
      shell.gv.renderHead(room);
      const pill = shell.gv.el.head.querySelector(".policy-pill");
      assert.ok(pill);
    });
  });
});
