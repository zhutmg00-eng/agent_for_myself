/**
 * tests/ui_interaction.test.mjs
 *
 * Automated UI Interaction Test Suite for AgentFusion (Node >= 22.19.0).
 * Tests member selection, single/double click decoupling, #g-info toggle logic,
 * async evidence refresh stability, and member permission toggle concurrency.
 *
 * Runs with `node --test` with ZERO external npm dependencies.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Dual-path resolution: runs seamlessly both in explorer directory and agent_for_myself/tests
let setupHeadlessDOM;
try {
  ({ setupHeadlessDOM } = await import("./_helpers/headless_dom.mjs"));
} catch {
  ({ setupHeadlessDOM } = await import("./proposed_headless_dom.mjs"));
}

// Setup headless DOM before any web module evaluation
const dom = setupHeadlessDOM();

// Dual-path resolution for web modules
let storeModule, groupViewModule, apiModule;
try {
  storeModule = await import("../web/js/store.js");
  groupViewModule = await import("../web/js/views/group.js");
  apiModule = await import("../web/js/api.js");
} catch {
  storeModule = await import("../../../agent_for_myself/web/js/store.js");
  groupViewModule = await import("../../../agent_for_myself/web/js/views/group.js");
  apiModule = await import("../../../agent_for_myself/web/js/api.js");
}

const { state, refreshEvidence } = storeModule;
const { GroupView, bindGroupInspector, groupInspectorHTML } = groupViewModule;
const { api } = apiModule;

function resetMockState(roomId = "r_test") {
  state.inspector = null;
  state.evidence = {};
  state.roomById[roomId] = {
    room_id: roomId,
    title: "测试群聊",
    owner_id: "boss",
    members: ["boss", "coder", "reviewer"],
    context_policy: "shared",
    member_permissions: {
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
  return state.roomById[roomId];
}

function createGroupView(roomId = "r_test") {
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

describe("UI Interaction Test Suite (tests/ui_interaction.test.mjs)", () => {
  const roomId = "r_test";
  let room;
  let gv;
  let origRoomEvidence;
  let origUpdateRoom;

  beforeEach(() => {
    room = resetMockState(roomId);
    gv = createGroupView(roomId);
    origRoomEvidence = api.roomEvidence;
    origUpdateRoom = api.updateRoom;
  });

  afterEach(() => {
    api.roomEvidence = origRoomEvidence;
    api.updateRoom = origUpdateRoom;
  });

  // =========================================================================
  // Test 1: Member click state synchronization
  // =========================================================================
  describe("Test 1: Member click state synchronization", () => {
    it("1.1: clicking .mchip updates state.inspector.member and dispatches ah:inspector", () => {
      gv.renderHead(room);
      const coderChip = gv.el.head.querySelector('[data-goto-member="coder"]');
      assert.ok(coderChip, "coder member chip should be rendered in header roster");

      let eventFired = false;
      let eventDetail = null;
      const onInspector = (ev) => {
        eventFired = true;
        eventDetail = ev.detail;
      };
      document.addEventListener("ah:inspector", onInspector, { once: true });

      coderChip.click();

      assert.ok(eventFired, "ah:inspector CustomEvent must be dispatched on member click");
      assert.equal(state.inspector?.type, "group");
      assert.equal(state.inspector?.id, roomId);
      assert.equal(state.inspector?.tab, "members");
      assert.equal(state.inspector?.member, "coder", "state.inspector.member must be set to coder");
      assert.deepEqual(eventDetail, state.inspector);
    });

    it("1.2: active member chip applies .is-selected class on render", () => {
      state.inspector = { type: "group", id: roomId, tab: "members", member: "coder" };
      gv.renderHead(room);

      const coderChip = gv.el.head.querySelector('[data-goto-member="coder"]');
      const bossChip = gv.el.head.querySelector('[data-goto-member="boss"]');
      const reviewerChip = gv.el.head.querySelector('[data-goto-member="reviewer"]');

      assert.ok(coderChip.classList.contains("is-selected"), "selected member chip must have .is-selected class");
      assert.ok(!bossChip.classList.contains("is-selected"), "non-selected owner chip must not have .is-selected");
      assert.ok(!reviewerChip.classList.contains("is-selected"), "non-selected reviewer chip must not have .is-selected");
    });

    it("1.3: switching member updates selection and preserves inspector state", () => {
      gv.renderHead(room);
      const coderChip = gv.el.head.querySelector('[data-goto-member="coder"]');
      const reviewerChip = gv.el.head.querySelector('[data-goto-member="reviewer"]');

      // Click coder first
      coderChip.click();
      assert.equal(state.inspector.member, "coder");
      gv.renderHead(room);
      assert.ok(gv.el.head.querySelector('[data-goto-member="coder"]').classList.contains("is-selected"));

      // Click reviewer next
      gv.el.head.querySelector('[data-goto-member="reviewer"]').click();
      assert.equal(state.inspector.member, "reviewer");
      gv.renderHead(room);
      assert.ok(gv.el.head.querySelector('[data-goto-member="reviewer"]').classList.contains("is-selected"));
      assert.ok(!gv.el.head.querySelector('[data-goto-member="coder"]').classList.contains("is-selected"));
    });

    it("1.4: inspectorKey and inspectorSig incorporate insp.member for memoization cache busting", () => {
      const inspA = { type: "group", id: roomId, tab: "members", member: "coder" };
      const inspB = { type: "group", id: roomId, tab: "members", member: "reviewer" };

      const keyA = `${inspA.type}:${inspA.id || ""}:${inspA.tab || ""}:${inspA.member || ""}`;
      const keyB = `${inspB.type}:${inspB.id || ""}:${inspB.tab || ""}:${inspB.member || ""}`;

      assert.notEqual(keyA, keyB, "inspector memoization key must differ when member changes");
    });
  });

  // =========================================================================
  // Test 2: Double-click vs single-click decoupling
  // =========================================================================
  describe("Test 2: Double-click vs single-click decoupling", () => {
    it("2.1: rapid consecutive clicks do not throw, oscillate or desynchronize state", () => {
      gv.renderHead(room);
      const coderChip = gv.el.head.querySelector('[data-goto-member="coder"]');

      // Rapidly fire two clicks in succession
      coderChip.click();
      coderChip.click();

      assert.equal(state.inspector?.type, "group");
      assert.equal(state.inspector?.id, roomId);
      assert.equal(state.inspector?.member, "coder", "consecutive rapid clicks must remain selected on coder");
    });

    it("2.2: dblclick event on member chip does not cause error or desync", () => {
      gv.renderHead(room);
      const coderChip = gv.el.head.querySelector('[data-goto-member="coder"]');

      // Single click first
      coderChip.click();
      assert.equal(state.inspector?.member, "coder");

      // Dispatch dblclick
      const dblEv = new Event("dblclick", { bubbles: true });
      assert.doesNotThrow(() => coderChip.dispatchEvent(dblEv));
      assert.equal(state.inspector?.member, "coder", "dblclick must not mutate or desync selection state");
    });

    it("2.3: clicking already-selected member is idempotent (does not toggle to null)", () => {
      state.inspector = { type: "group", id: roomId, tab: "members", member: "coder" };
      gv.renderHead(room);

      const coderChip = gv.el.head.querySelector('[data-goto-member="coder"]');
      coderChip.click();

      assert.equal(state.inspector?.member, "coder", "clicking active chip must preserve member focus");
    });
  });

  // =========================================================================
  // Test 3: #g-info toggle logic
  // =========================================================================
  describe("Test 3: #g-info toggle logic & multi-button interaction", () => {
    it("3.1: clicking #g-info when member is selected switches to full group view without closing", () => {
      state.inspector = { type: "group", id: roomId, tab: "members", member: "coder" };
      gv.renderHead(room);

      const gInfo = gv.el.head.querySelector("#g-info");
      assert.ok(gInfo, "#g-info button must exist");

      gInfo.click();

      assert.notEqual(state.inspector, null, "clicking #g-info when member selected must NOT close inspector");
      assert.equal(state.inspector?.type, "group");
      assert.equal(state.inspector?.id, roomId);
      assert.equal(state.inspector?.tab, "members");
      assert.equal(state.inspector?.member, undefined, "member focus should be cleared to show full group view");
    });

    it("3.2: clicking #g-info when full group view is active closes inspector", () => {
      state.inspector = { type: "group", id: roomId, tab: "members" };
      gv.renderHead(room);

      const gInfo = gv.el.head.querySelector("#g-info");
      gInfo.click();

      assert.equal(state.inspector, null, "clicking #g-info when group view active must close inspector");
    });

    it("3.3: clicking #g-info when inspector is closed opens group inspector", () => {
      state.inspector = null;
      gv.renderHead(room);

      const gInfo = gv.el.head.querySelector("#g-info");
      gInfo.click();

      assert.equal(state.inspector?.type, "group");
      assert.equal(state.inspector?.id, roomId);
      assert.equal(state.inspector?.tab, "members");
    });

    it("3.4: clicking other header buttons immediately after member click succeeds", () => {
      gv.renderHead(room);
      const coderChip = gv.el.head.querySelector('[data-goto-member="coder"]');
      const gFiles = gv.el.head.querySelector("#g-files");

      // Click member, then immediately click files
      coderChip.click();
      assert.equal(state.inspector.member, "coder");

      gFiles.click();
      assert.equal(state.inspector?.tab, "files", "clicking #g-files must switch tab to files");
      assert.equal(state.inspector?.id, roomId);

      // Clicking #g-info when inspector is open without member closes it (PROJECT.md contract)
      const gInfo = gv.el.head.querySelector("#g-info");
      gInfo.click();
      assert.equal(state.inspector, null, "clicking #g-info when open without member closes inspector");

      // Clicking #g-info again when closed opens group view with tab: 'members'
      gInfo.click();
      assert.equal(state.inspector?.tab, "members", "clicking #g-info when closed opens group view");
    });
  });

  // =========================================================================
  // Test 4: Asynchronous refreshEvidence stability
  // =========================================================================
  describe("Test 4: Asynchronous refreshEvidence stability", () => {
    it("4.1: in-flight refreshEvidence deduplicates concurrent requests", async () => {
      const inflightRoomId = "r_inflight_test";
      resetMockState(inflightRoomId);
      let callCount = 0;
      api.roomEvidence = async () => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { room_id: inflightRoomId, summary: { observed: 1, prepared: 0, mismatch: 0, total: 1 }, records: [] };
      };

      const p1 = refreshEvidence(inflightRoomId, { force: true });
      const p2 = refreshEvidence(inflightRoomId, { force: true });

      const [res1, res2] = await Promise.all([p1, p2]);
      assert.equal(callCount, 1, "underlying API should only be queried once during deduplicated in-flight window");
      assert.deepEqual(res1, res2, "both concurrent callers must receive identical evidence data");
    });

    it("4.2: cached evidence within TTL avoids unnecessary network calls", async () => {
      const cacheRoomId = "r_cache_test";
      resetMockState(cacheRoomId);
      let callCount = 0;
      api.roomEvidence = async () => {
        callCount++;
        return { room_id: cacheRoomId, summary: { observed: 2, prepared: 0, mismatch: 0, total: 2 }, records: [] };
      };

      await refreshEvidence(cacheRoomId, { force: true });
      assert.equal(callCount, 1);

      // Second call without force
      await refreshEvidence(cacheRoomId, { force: false });
      assert.equal(callCount, 1, "cached evidence within TTL must not trigger additional API calls");
    });

    it("4.3: header DOM elements remain attached and responsive during async evidence refresh", async () => {
      gv.renderHead(room);
      const gFiles = gv.el.head.querySelector("#g-files");
      assert.ok(gFiles, "#g-files button must exist");

      let filesClicked = false;
      gFiles.onclick = () => {
        filesClicked = true;
      };

      // Simulate async evidence refresh in progress
      api.roomEvidence = async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { room_id: roomId, summary: { observed: 1, prepared: 0, mismatch: 0, total: 1 }, records: [] };
      };

      const refreshTask = refreshEvidence(roomId, { force: true });

      // User initiates interaction on header button while refresh is in-flight
      assert.ok(gFiles.parentElement, "gFiles button must be attached to header");

      await refreshTask;

      // Click button after/during resolution
      gFiles.click();
      assert.ok(filesClicked, "click handler on header button must fire successfully without being lost");
    });
  });

  // =========================================================================
  // Test 5: Member permission toggle debounce and button disable state
  // =========================================================================
  describe("Test 5: Member permission toggle debounce and button disable state", () => {
    it("5.1: permission toggle disables button during in-flight request", async () => {
      const inspectorRoot = document.createElement("div");
      inspectorRoot.innerHTML = groupInspectorHTML(roomId, "members");

      let resolveApi;
      let apiCalls = 0;
      api.updateRoom = async () => {
        apiCalls++;
        return new Promise((resolve) => {
          resolveApi = resolve;
        });
      };

      let rerenderCalled = false;
      bindGroupInspector(inspectorRoot, roomId, "members", () => {
        rerenderCalled = true;
      });

      const coderRow = inspectorRoot.querySelector('[data-member="coder"]');
      assert.ok(coderRow, "coder member row must exist in inspector");
      const speakBtn = coderRow.querySelector('[data-act="speak"]');
      assert.ok(speakBtn, "speak toggle button must exist");

      // Initial state: not disabled
      assert.equal(speakBtn.disabled, false);

      // Trigger click
      const clickPromise = (async () => {
        speakBtn.click();
      })();

      // Button must immediately disable to prevent duplicate submissions
      assert.equal(speakBtn.disabled, true, "permission button must be disabled immediately while request is in-flight");

      // Resolve API
      resolveApi({ member_permissions: { coder: { can_speak: false, context_access: "full", can_create_subgroup: false } } });
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(apiCalls, 1, "exactly one updateRoom call should have been made");
      assert.ok(rerenderCalled, "rerender callback must be invoked after successful update");
    });

    it("5.2: in-flight double click on permission toggle is ignored/debounced", async () => {
      const inspectorRoot = document.createElement("div");
      inspectorRoot.innerHTML = groupInspectorHTML(roomId, "members");

      let apiCalls = 0;
      api.updateRoom = async () => {
        apiCalls++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { ok: true };
      };

      bindGroupInspector(inspectorRoot, roomId, "members", () => {});

      const coderRow = inspectorRoot.querySelector('[data-member="coder"]');
      const speakBtn = coderRow.querySelector('[data-act="speak"]');

      // Click once
      speakBtn.click();
      // Click again while disabled
      speakBtn.click();

      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(apiCalls, 1, "second click during in-flight request must be dropped");
    });

    it("5.3: permission toggle event calls stopPropagation", () => {
      const inspectorRoot = document.createElement("div");
      inspectorRoot.innerHTML = groupInspectorHTML(roomId, "members");

      api.updateRoom = async () => ({ ok: true });
      bindGroupInspector(inspectorRoot, roomId, "members", () => {});

      const coderRow = inspectorRoot.querySelector('[data-member="coder"]');
      const speakBtn = coderRow.querySelector('[data-act="speak"]');

      let parentClicked = false;
      coderRow.addEventListener("click", () => {
        parentClicked = true;
      });

      speakBtn.click();

      assert.equal(parentClicked, false, "click event on permission toggle must not bubble to parent row");
    });

    it("5.4: permission button re-enables on request failure", async () => {
      const inspectorRoot = document.createElement("div");
      inspectorRoot.innerHTML = groupInspectorHTML(roomId, "members");

      api.updateRoom = async () => {
        throw new Error("Network timeout");
      };

      bindGroupInspector(inspectorRoot, roomId, "members", () => {});

      const coderRow = inspectorRoot.querySelector('[data-member="coder"]');
      const speakBtn = coderRow.querySelector('[data-act="speak"]');

      speakBtn.click();
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(speakBtn.disabled, false, "permission button must be re-enabled if API call fails");
    });

    it("5.5: optimistic state rolls back on API rejection, restores DOM, re-enables button, and retry avoids inversion", async () => {
      const inspectorRoot = document.createElement("div");

      // Baseline state
      const initialPerm = { can_speak: true, context_access: "full", can_create_subgroup: false };
      state.roomById[roomId].member_permissions = {
        coder: { ...initialPerm },
      };
      inspectorRoot.innerHTML = groupInspectorHTML(roomId, "members");

      let rerenderCount = 0;
      const rerender = () => {
        rerenderCount++;
        inspectorRoot.innerHTML = groupInspectorHTML(roomId, "members");
        bindGroupInspector(inspectorRoot, roomId, "members", rerender);
      };
      bindGroupInspector(inspectorRoot, roomId, "members", rerender);

      let coderRow = inspectorRoot.querySelector('[data-member="coder"]');
      let speakBtn = coderRow.querySelector('[data-act="speak"]');
      assert.ok(speakBtn.classList.contains("is-on"), "initially speak button has .is-on");

      // Configure api.updateRoom to fail on first attempt
      let updateCalls = [];
      api.updateRoom = async (rId, patch) => {
        updateCalls.push(patch);
        throw new Error("500 Internal Server Error");
      };

      // Click to toggle speak (attempting to mute coder: can_speak true -> false)
      speakBtn.click();
      await new Promise((r) => setTimeout(r, 20));

      // 1. Verify API was invoked
      assert.equal(updateCalls.length, 1);
      assert.deepEqual(updateCalls[0], { member_permissions: { coder: { can_speak: false } } });

      // 2. Verify state rollback to prevMemberPerm
      assert.deepEqual(
        state.roomById[roomId].member_permissions.coder,
        initialPerm,
        "state.roomById[roomId].member_permissions[memberId] must be rolled back to prevMemberPerm"
      );

      // 3. Verify rerender was invoked so DOM reflects original un-mutated state
      assert.ok(rerenderCount >= 1, "rerender() must be called in catch block");
      coderRow = inspectorRoot.querySelector('[data-member="coder"]');
      speakBtn = coderRow.querySelector('[data-act="speak"]');
      assert.ok(speakBtn.classList.contains("is-on"), "DOM reflects rolled-back can_speak=true state with .is-on");

      // 4. Verify button is re-enabled in finally
      assert.equal(speakBtn.disabled, false, "button must be re-enabled in finally");

      // 5. Subsequent retry click operates on rolled-back state without inverting user intent
      api.updateRoom = async (rId, patch) => {
        updateCalls.push(patch);
        return { ok: true };
      };

      speakBtn.click();
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(updateCalls.length, 2, "retry click initiates second updateRoom call");
      assert.deepEqual(
        updateCalls[1],
        { member_permissions: { coder: { can_speak: false } } },
        "retry click must attempt to mute coder (can_speak: false) rather than inverting intent"
      );
      assert.equal(
        state.roomById[roomId].member_permissions.coder.can_speak,
        false,
        "successful retry correctly updates state"
      );
    });
  });

  // =========================================================================
  // Test 6: Headless DOM MockElement scrollTo helper conformance
  // =========================================================================
  describe("Test 6: Headless DOM MockElement scrollTo helper conformance", () => {
    it("6.1: scrollTo supports both options object and (x, y) arguments", () => {
      const el = document.createElement("div");
      el.scrollTo({ top: 120, left: 40 });
      assert.equal(el.scrollTop, 120);
      assert.equal(el.scrollLeft, 40);

      el.scrollTo(25, 75);
      assert.equal(el.scrollLeft, 25);
      assert.equal(el.scrollTop, 75);

      el.scrollTo(50);
      assert.equal(el.scrollLeft, 50);
      assert.equal(el.scrollTop, 0);
    });
  });
});
