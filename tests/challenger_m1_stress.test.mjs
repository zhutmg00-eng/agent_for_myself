/**
 * tests/challenger_m1_stress.test.mjs
 *
 * Empirical Challenger Stress Harness for Milestone 1 (M1).
 * Tests edge cases:
 * 1. Double-click vs single-click behavior:
 *    - Rapid double-click / bursts on member chips (.mchip)
 *    - Rapid double-click / triple-click on #g-info
 *    - Double-click on single permission toggle (in-flight ignore)
 * 2. Rapid concurrent clicks on permission toggles with simulated network latency:
 *    - Same-member concurrent clicks across distinct toggles (speak & subgroup)
 *    - Cross-member concurrent clicks (coder & reviewer)
 *    - In-flight error recovery and re-enable
 * 3. Modal opening/closing & pointer-events:
 *    - Settings modal immediate pointer-events: none on close
 *    - Modal exit animation non-blocking of underlying UI clicks
 *    - Rapid open/close cycling idempotency
 * 4. Dead button / click drop prevention:
 *    - Rapid transitions between member chips and header buttons
 *    - Member chip clicks during asynchronous refreshEvidence resolution
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupHeadlessDOM } from "./_helpers/headless_dom.mjs";

const dom = setupHeadlessDOM();

// Import web modules
const storeModule = await import("../web/js/store.js");
const groupViewModule = await import("../web/js/views/group.js");
const settingsModule = await import("../web/js/views/settings.js");
const uiModule = await import("../web/js/ui.js");
const apiModule = await import("../web/js/api.js");

const { state, refreshEvidence, updateRoomMeta } = storeModule;
const { GroupView, bindGroupInspector, groupInspectorHTML } = groupViewModule;
const { openSettings } = settingsModule;
const { closeModal, openModal } = uiModule;
const { api } = apiModule;

function resetRoomState(roomId = "r_stress") {
  state.inspector = null;
  state.evidence = {};
  state.files = {};
  state.messages = {};
  state.roomById[roomId] = {
    room_id: roomId,
    title: "压力测试群聊",
    owner_id: "boss",
    members: ["boss", "coder", "reviewer"],
    context_policy: "shared",
    member_permissions: {
      boss: { can_speak: true, context_access: "full", can_create_subgroup: true },
      coder: { can_speak: true, context_access: "full", can_create_subgroup: false },
      reviewer: { can_speak: true, context_access: "full", can_create_subgroup: false },
    },
  };
  state.files[roomId] = [];
  state.messages[roomId] = [];
  state.botsById = {
    boss: { id: "boss", name: "Boss", role: "群主" },
    coder: { id: "coder", name: "Coder", role: "开发" },
    reviewer: { id: "reviewer", name: "Reviewer", role: "审查" },
  };
  state.skillProposals = { report: { proposed: 0 } };
  state.approvals = { pending: [] };
  state.health = { version: "0.1.0" };

  // Ensure modal root exists in document
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

function createGroupView(roomId = "r_stress") {
  const container = document.createElement("div");
  const gv = new GroupView(container);
  gv.roomId = roomId;
  gv.el = {
    head: document.createElement("div"),
    inner: document.createElement("div"),
    scroll: document.createElement("div"),
  };
  container.appendChild(gv.el.head);
  container.appendChild(gv.el.scroll);
  container.appendChild(gv.el.inner);
  return gv;
}

describe("Milestone 1 Empirical Stress Test Suite", () => {
  const roomId = "r_stress";
  let room;
  let gv;
  let origApiUpdateRoom;
  let origApiRoomEvidence;

  beforeEach(() => {
    room = resetRoomState(roomId);
    gv = createGroupView(roomId);
    origApiUpdateRoom = api.updateRoom;
    origApiRoomEvidence = api.roomEvidence;
  });

  afterEach(() => {
    api.updateRoom = origApiUpdateRoom;
    api.roomEvidence = origApiRoomEvidence;
  });

  // =========================================================================
  // Dimension 1: Double-click vs single-click behavior
  // =========================================================================
  describe("1. Double-click vs single-click behavior", () => {
    it("1.1: rapid double-click on member chip preserves selection without state toggling or nullification", () => {
      gv.renderHead(room);
      const coderChip = gv.el.head.querySelector('[data-goto-member="coder"]');
      assert.ok(coderChip, "coder chip exists");

      let eventCount = 0;
      document.addEventListener("ah:inspector", () => eventCount++);

      // Fire rapid double-click
      coderChip.click();
      coderChip.click();

      assert.equal(state.inspector?.type, "group");
      assert.equal(state.inspector?.id, roomId);
      assert.equal(state.inspector?.member, "coder", "member remains coder on double-click");
      assert.ok(coderChip.classList.contains("is-selected"), "coder chip remains .is-selected");
      assert.equal(eventCount, 2, "ah:inspector dispatched for both clicks");
    });

    it("1.2: high-frequency 10-click burst on member chip remains stable and idempotent", () => {
      gv.renderHead(room);
      const coderChip = gv.el.head.querySelector('[data-goto-member="coder"]');

      for (let i = 0; i < 10; i++) {
        coderChip.click();
      }

      assert.equal(state.inspector?.member, "coder");
      assert.ok(coderChip.classList.contains("is-selected"));
      const bossChip = gv.el.head.querySelector('[data-goto-member="boss"]');
      assert.ok(!bossChip.classList.contains("is-selected"));
    });

    it("1.3: rapid alternating clicks between member chips switch focus cleanly without lingering classes", () => {
      gv.renderHead(room);
      const coderChip = gv.el.head.querySelector('[data-goto-member="coder"]');
      const reviewerChip = gv.el.head.querySelector('[data-goto-member="reviewer"]');

      // Rapidly alternate 6 times
      for (let i = 0; i < 3; i++) {
        coderChip.click();
        assert.equal(state.inspector.member, "coder");
        assert.ok(coderChip.classList.contains("is-selected"));
        assert.ok(!reviewerChip.classList.contains("is-selected"));

        reviewerChip.click();
        assert.equal(state.inspector.member, "reviewer");
        assert.ok(!coderChip.classList.contains("is-selected"));
        assert.ok(reviewerChip.classList.contains("is-selected"));
      }
    });

    it("1.4: #g-info double-click from closed state opens then closes inspector (state machine consistency)", () => {
      state.inspector = null;
      gv.renderHead(room);
      const gInfo = gv.el.head.querySelector("#g-info");

      // Click 1: opens inspector on general group view
      gInfo.click();
      assert.equal(state.inspector?.type, "group");
      assert.equal(state.inspector?.tab, "members");
      assert.equal(state.inspector?.member, undefined);
      assert.ok(gInfo.classList.contains("is-on"));

      // Click 2: closes inspector
      gInfo.click();
      assert.equal(state.inspector, null);
      assert.ok(!gInfo.classList.contains("is-on"));
    });

    it("1.5: #g-info double-click from member-selected state: click 1 clears member, click 2 closes", () => {
      state.inspector = { type: "group", id: roomId, tab: "members", member: "coder" };
      gv.renderHead(room);
      const gInfo = gv.el.head.querySelector("#g-info");
      const coderChip = gv.el.head.querySelector('[data-goto-member="coder"]');

      assert.ok(coderChip.classList.contains("is-selected"));
      assert.ok(gInfo.classList.contains("is-on"));

      // Click 1: clears member selection, stays on general group view
      gInfo.click();
      assert.notEqual(state.inspector, null, "inspector must remain open on general group view");
      assert.equal(state.inspector.member, undefined, "member must be cleared");
      assert.ok(!coderChip.classList.contains("is-selected"), "chip is no longer selected");
      assert.ok(gInfo.classList.contains("is-on"), "#g-info remains on");

      // Click 2: collapses inspector
      gInfo.click();
      assert.equal(state.inspector, null, "inspector must collapse on second click");
      assert.ok(!gInfo.classList.contains("is-on"), "#g-info is now off");
    });

    it("1.6: permission toggle double-click drops the second click while in-flight", async () => {
      const inspectorRoot = document.createElement("div");
      inspectorRoot.innerHTML = groupInspectorHTML(roomId, "members");

      let apiCalls = 0;
      api.updateRoom = async () => {
        apiCalls++;
        await new Promise((r) => setTimeout(r, 25));
        return { ok: true };
      };

      bindGroupInspector(inspectorRoot, roomId, "members", () => {});
      const coderRow = inspectorRoot.querySelector('[data-member="coder"]');
      const speakBtn = coderRow.querySelector('[data-act="speak"]');

      // Click twice rapidly
      speakBtn.click();
      speakBtn.click();

      assert.equal(speakBtn.disabled, true, "button is disabled during flight");
      await new Promise((r) => setTimeout(r, 35));

      assert.equal(apiCalls, 1, "second click during in-flight was ignored");
      assert.equal(speakBtn.disabled, false, "button is re-enabled after completion");
    });
  });

  // =========================================================================
  // Dimension 2: Rapid concurrent clicks on permission toggles with network latency
  // =========================================================================
  describe("2. Concurrent clicks on permission toggles with simulated network latency", () => {
    it("2.1: cross-member concurrent permission toggles execute without clobbering", async () => {
      const inspectorRoot = document.createElement("div");
      inspectorRoot.innerHTML = groupInspectorHTML(roomId, "members");

      const inFlightRequests = [];
      api.updateRoom = async (rId, payload) => {
        await new Promise((r) => setTimeout(r, 20));
        // Return updated backend representation
        const existing = state.roomById[rId] || {};
        const updatedPerms = { ...(existing.member_permissions || {}) };
        for (const [mId, p] of Object.entries(payload.member_permissions || {})) {
          updatedPerms[mId] = { ...(updatedPerms[mId] || {}), ...p };
        }
        return { ...existing, member_permissions: updatedPerms };
      };

      bindGroupInspector(inspectorRoot, roomId, "members", () => {});

      const coderRow = inspectorRoot.querySelector('[data-member="coder"]');
      const reviewerRow = inspectorRoot.querySelector('[data-member="reviewer"]');

      const coderSpeakBtn = coderRow.querySelector('[data-act="speak"]');
      const reviewerSpeakBtn = reviewerRow.querySelector('[data-act="speak"]');

      // Fire concurrent clicks for coder and reviewer
      coderSpeakBtn.click();
      reviewerSpeakBtn.click();

      // Both buttons should be disabled while their requests are in flight
      assert.equal(coderSpeakBtn.disabled, true);
      assert.equal(reviewerSpeakBtn.disabled, true);

      await new Promise((r) => setTimeout(r, 40));

      // Both requests finished: check results
      assert.equal(coderSpeakBtn.disabled, false);
      assert.equal(reviewerSpeakBtn.disabled, false);

      const coderPerm = state.roomById[roomId].member_permissions.coder;
      const reviewerPerm = state.roomById[roomId].member_permissions.reviewer;

      assert.equal(coderPerm.can_speak, false, "coder can_speak should have toggled to false");
      assert.equal(reviewerPerm.can_speak, false, "reviewer can_speak should have toggled to false");
    });

    it("2.2: sequential toggle after completion updates permissions accurately", async () => {
      const inspectorRoot = document.createElement("div");
      inspectorRoot.innerHTML = groupInspectorHTML(roomId, "members");

      api.updateRoom = async (rId, payload) => {
        await new Promise((r) => setTimeout(r, 15));
        const existing = state.roomById[rId] || {};
        const updatedPerms = { ...(existing.member_permissions || {}) };
        for (const [mId, p] of Object.entries(payload.member_permissions || {})) {
          updatedPerms[mId] = { ...(updatedPerms[mId] || {}), ...p };
        }
        return { ...existing, member_permissions: updatedPerms };
      };

      const render = () => {
        inspectorRoot.innerHTML = groupInspectorHTML(roomId, "members");
        bindGroupInspector(inspectorRoot, roomId, "members", render);
      };
      render();

      // Click speak
      let coderRow = inspectorRoot.querySelector('[data-member="coder"]');
      let speakBtn = coderRow.querySelector('[data-act="speak"]');
      speakBtn.click();
      await new Promise((r) => setTimeout(r, 25));

      assert.equal(state.roomById[roomId].member_permissions.coder.can_speak, false);

      // Now click subgroup after speak has completed
      coderRow = inspectorRoot.querySelector('[data-member="coder"]');
      let subgroupBtn = coderRow.querySelector('[data-act="subgroup"]');
      subgroupBtn.click();
      await new Promise((r) => setTimeout(r, 25));

      const finalPerm = state.roomById[roomId].member_permissions.coder;
      assert.equal(finalPerm.can_speak, false, "can_speak must remain false");
      assert.equal(finalPerm.can_create_subgroup, true, "can_create_subgroup must be true");
    });

    it("2.3: same-member concurrent clicks across distinct toggles during in-flight latency", async () => {
      const inspectorRoot = document.createElement("div");
      inspectorRoot.innerHTML = groupInspectorHTML(roomId, "members");

      let apiCalls = [];
      api.updateRoom = async (rId, payload) => {
        apiCalls.push(JSON.parse(JSON.stringify(payload)));
        await new Promise((r) => setTimeout(r, 30));
        const existing = state.roomById[rId] || {};
        const updatedPerms = { ...(existing.member_permissions || {}) };
        for (const [mId, p] of Object.entries(payload.member_permissions || {})) {
          updatedPerms[mId] = { ...(updatedPerms[mId] || {}), ...p };
        }
        return { ...existing, member_permissions: updatedPerms };
      };

      bindGroupInspector(inspectorRoot, roomId, "members", () => {});

      const coderRow = inspectorRoot.querySelector('[data-member="coder"]');
      const speakBtn = coderRow.querySelector('[data-act="speak"]');
      const subgroupBtn = coderRow.querySelector('[data-act="subgroup"]');

      // Click speak (latency 30ms)
      speakBtn.click();
      // At 5ms (while speak is still in-flight), click subgroup
      await new Promise((r) => setTimeout(r, 5));
      subgroupBtn.click();

      // Wait for both to settle
      await new Promise((r) => setTimeout(r, 50));

      const finalPerm = state.roomById[roomId].member_permissions.coder;
      console.log("apiCalls in 2.3:", JSON.stringify(apiCalls));
      console.log("finalPerm in 2.3:", JSON.stringify(finalPerm));
      assert.equal(finalPerm.can_speak, false, "can_speak should remain false (not clobbered by subgroup click)");
      assert.equal(finalPerm.can_create_subgroup, true, "can_create_subgroup should be true");
    });
  });

  // =========================================================================
  // Dimension 3: Modal opening/closing & pointer-events
  // =========================================================================
  describe("3. Modal opening/closing & pointer-events non-blocking", () => {
    it("3.1: closing settings modal immediately applies pointer-events: none to backdrop", () => {
      const { close } = openSettings();
      const backdrop = document.querySelector(".modal-backdrop");
      assert.ok(backdrop, "modal backdrop should be mounted");
      assert.notEqual(backdrop.style.pointerEvents, "none");

      // Trigger close
      close();

      // pointerEvents must IMMEDIATELY become "none" so clicks pass through during the 120ms fade-out
      assert.equal(backdrop.style.pointerEvents, "none", "pointerEvents must be set to 'none' immediately on close");
    });

    it("3.2: rapid clicks immediately after closing modal are registered on underlying buttons", async () => {
      // Setup an underlying button in DOM
      const underlyingBtn = document.createElement("button");
      underlyingBtn.id = "underlying-action";
      let clicked = false;
      underlyingBtn.onclick = () => { clicked = true; };
      document.body.appendChild(underlyingBtn);

      const { close } = openSettings();
      const backdrop = document.querySelector(".modal-backdrop");
      assert.ok(backdrop);

      // Close modal
      close();

      // Verify backdrop does not intercept clicks
      assert.equal(backdrop.style.pointerEvents, "none");

      // Underlying button is immediately clicked
      underlyingBtn.click();
      assert.ok(clicked, "underlying button click must register immediately without waiting for 120ms animation");

      // After 130ms, backdrop must be removed from DOM
      await new Promise((r) => setTimeout(r, 130));
      assert.equal(document.querySelector(".modal-backdrop"), null, "backdrop removed from DOM");
      underlyingBtn.remove();
    });

    it("3.3: rapid open -> close -> open cycling does not create orphaned backdrops or stuck state", async () => {
      for (let i = 0; i < 5; i++) {
        const { close } = openSettings();
        const backdrop = document.querySelector(".modal-backdrop");
        assert.ok(backdrop, `backdrop exists on cycle ${i}`);
        close();
        assert.equal(backdrop.style.pointerEvents, "none");
      }
      // Wait for removal timeouts
      await new Promise((r) => setTimeout(r, 140));
      const remainingBackdrops = document.querySelectorAll(".modal-backdrop");
      assert.equal(remainingBackdrops.length, 0, "all backdrops cleanly removed");
    });

    it("3.4: closeModal() in ui.js immediately applies pointerEvents: none", () => {
      openModal(`<div class="modal"><p>测试弹窗</p></div>`);
      const backdrop = document.querySelector(".modal-backdrop");
      assert.ok(backdrop);

      closeModal();
      assert.equal(backdrop.style.pointerEvents, "none", "ui.js closeModal must set pointerEvents = none");
    });
  });

  // =========================================================================
  // Dimension 4: Dead buttons and click drops prevention
  // =========================================================================
  describe("4. Dead buttons and click drops prevention", () => {
    it("4.1: clicks on header buttons (#g-files, #g-info) immediately after member chip click succeed", () => {
      gv.renderHead(room);
      const coderChip = gv.el.head.querySelector('[data-goto-member="coder"]');
      const gFiles = gv.el.head.querySelector("#g-files");
      const gInfo = gv.el.head.querySelector("#g-info");

      // Member click
      coderChip.click();
      assert.equal(state.inspector?.member, "coder");

      // Immediate files click
      gFiles.click();
      assert.equal(state.inspector?.tab, "files");

      // Immediate info click -> closes inspector (PROJECT.md contract: info on group without member closes)
      gInfo.click();
      assert.equal(state.inspector, null);

      // Immediate info click again -> opens inspector
      gInfo.click();
      assert.equal(state.inspector?.tab, "members");
      assert.equal(state.inspector?.member, undefined);
    });

    it("4.2: member chip click during asynchronous refreshEvidence is not dropped", async () => {
      gv.renderHead(room);
      const coderChip = gv.el.head.querySelector('[data-goto-member="coder"]');

      api.roomEvidence = async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { room_id: roomId, summary: { observed: 3, prepared: 0, mismatch: 0, total: 3 }, records: [] };
      };

      const refreshTask = refreshEvidence(roomId, { force: true });

      // Click while in flight
      coderChip.click();

      await refreshTask;

      assert.equal(state.inspector?.member, "coder", "member selection is preserved after evidence refresh completes");
      assert.ok(coderChip.classList.contains("is-selected"), "coder chip remains .is-selected");
    });
  });
});
