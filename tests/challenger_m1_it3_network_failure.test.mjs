/**
 * tests/challenger_m1_it3_network_failure.test.mjs
 *
 * Empirical Challenger Network Failure Injection Suite for M1-IT3.
 *
 * Objectives:
 * 1. Simulate random and deterministic API rejections during permission toggles.
 * 2. Verify UI and in-memory state always roll back cleanly to true baseline state.
 * 3. Verify buttons re-enable without deadlocking or sticking.
 * 4. Verify subsequent retry clicks toggle in the expected direction without state inversion.
 * 5. Verify multi-member isolation under asymmetric failure/success outcomes.
 * 6. Stress-test same-member concurrent toggles under failure conditions.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { setupHeadlessDOM } from "./_helpers/headless_dom.mjs";

const dom = setupHeadlessDOM();

const storeModule = await import("../web/js/store.js");
const groupViewModule = await import("../web/js/views/group.js");
const uiModule = await import("../web/js/ui.js");
const apiModule = await import("../web/js/api.js");

const { state } = storeModule;
const { bindGroupInspector, groupInspectorHTML } = groupViewModule;
const { api } = apiModule;

const TEST_ROOM_ID = "r_net_fail_test";

function setupRoomState(roomId = TEST_ROOM_ID) {
  state.inspector = null;
  state.evidence = {};
  state.files = {};
  state.messages = {};
  state.roomById[roomId] = {
    room_id: roomId,
    title: "网络故障注入测试群",
    owner_id: "boss",
    members: ["boss", "coder", "reviewer"],
    context_policy: "shared",
    member_permissions: {
      boss: { can_speak: true, context_access: "full", can_create_subgroup: true },
      coder: { can_speak: true, context_access: "full", can_create_subgroup: false },
      reviewer: { can_speak: false, context_access: "summary", can_create_subgroup: false },
    },
  };
  state.files[roomId] = [];
  state.messages[roomId] = [];
  state.botsById = {
    boss: { id: "boss", name: "Boss", role: "群主" },
    coder: { id: "coder", name: "Coder", role: "开发" },
    reviewer: { id: "reviewer", name: "Reviewer", role: "审查" },
  };

  let toastRoot = document.querySelector("#toast-root");
  if (!toastRoot) {
    toastRoot = document.createElement("div");
    toastRoot.id = "toast-root";
    document.body.appendChild(toastRoot);
  } else {
    toastRoot.innerHTML = "";
  }

  return state.roomById[roomId];
}

function mountInspector(roomId = TEST_ROOM_ID) {
  const container = document.createElement("div");
  let rerenderCount = 0;
  const render = () => {
    rerenderCount++;
    container.innerHTML = groupInspectorHTML(roomId, "members");
    bindGroupInspector(container, roomId, "members", render);
  };
  render();
  return {
    container,
    rerender: render,
    getRerenderCount: () => rerenderCount,
  };
}

describe("Milestone 1 Iteration 3: Empirical Network Failure Injection Suite", () => {
  beforeEach(() => {
    setupRoomState(TEST_ROOM_ID);
  });

  // =========================================================================
  // Suite 1: Deterministic Failure & Retry per Action Type
  // =========================================================================
  describe("1. Deterministic Failure & Retry per Action Type", () => {
    it("1.1: 'speak' toggle API rejection rolls back state, re-enables button, and retry mutes coder", async () => {
      const { container } = mountInspector(TEST_ROOM_ID);
      const coderRow = container.querySelector('[data-member="coder"]');
      let speakBtn = coderRow.querySelector('[data-act="speak"]');

      assert.ok(speakBtn.classList.contains("is-on"), "Initial speak button has .is-on");
      assert.equal(state.roomById[TEST_ROOM_ID].member_permissions.coder.can_speak, true);

      // Force failure on first call
      let attempts = [];
      api.updateRoom = async (rId, payload) => {
        attempts.push(payload);
        throw new Error("HTTP 500 Internal Server Error");
      };

      // Click to mute coder (true -> false)
      speakBtn.click();
      await new Promise((r) => setTimeout(r, 15));

      assert.equal(attempts.length, 1);
      assert.deepEqual(attempts[0], { member_permissions: { coder: { can_speak: false } } });

      // Check state roll back
      assert.equal(
        state.roomById[TEST_ROOM_ID].member_permissions.coder.can_speak,
        true,
        "state must roll back to can_speak=true"
      );

      // Check DOM roll back
      const reRenderedRow = container.querySelector('[data-member="coder"]');
      speakBtn = reRenderedRow.querySelector('[data-act="speak"]');
      assert.ok(speakBtn.classList.contains("is-on"), "DOM must keep .is-on after rollback");
      assert.equal(speakBtn.disabled, false, "button must be re-enabled");

      // Verify toast received
      const toastEl = document.querySelector("#toast-root .toast");
      assert.ok(toastEl, "Error toast must be displayed in #toast-root");
      assert.ok(toastEl.textContent.includes("HTTP 500"), "Toast contains error message");

      // Now retry with successful API
      api.updateRoom = async (rId, payload) => {
        attempts.push(payload);
        return { ok: true };
      };

      speakBtn.click();
      await new Promise((r) => setTimeout(r, 15));

      assert.equal(attempts.length, 2);
      assert.deepEqual(
        attempts[1],
        { member_permissions: { coder: { can_speak: false } } },
        "Retry click must attempt can_speak=false (no inversion)"
      );
      assert.equal(
        state.roomById[TEST_ROOM_ID].member_permissions.coder.can_speak,
        false,
        "State successfully committed to can_speak=false"
      );
      const finalBtn = container.querySelector('[data-member="coder"] [data-act="speak"]');
      assert.ok(!finalBtn.classList.contains("is-on"), "DOM updated: .is-on is removed");
    });

    it("1.2: 'subgroup' toggle API rejection rolls back state, re-enables button, and retry grants permission", async () => {
      const { container } = mountInspector(TEST_ROOM_ID);
      const coderRow = container.querySelector('[data-member="coder"]');
      let subBtn = coderRow.querySelector('[data-act="subgroup"]');

      assert.ok(!subBtn.classList.contains("is-on"), "Initial subgroup button does not have .is-on");
      assert.equal(state.roomById[TEST_ROOM_ID].member_permissions.coder.can_create_subgroup, false);

      let attempts = [];
      api.updateRoom = async (rId, payload) => {
        attempts.push(payload);
        throw new Error("ETIMEDOUT");
      };

      // Click to grant subgroup creation (false -> true)
      subBtn.click();
      await new Promise((r) => setTimeout(r, 15));

      assert.equal(attempts.length, 1);
      assert.deepEqual(attempts[0], { member_permissions: { coder: { can_create_subgroup: true } } });

      // Verify rollback
      assert.equal(
        state.roomById[TEST_ROOM_ID].member_permissions.coder.can_create_subgroup,
        false,
        "subgroup permission rolled back to false"
      );

      const reRenderedRow = container.querySelector('[data-member="coder"]');
      subBtn = reRenderedRow.querySelector('[data-act="subgroup"]');
      assert.ok(!subBtn.classList.contains("is-on"), "DOM maintains unselected state");
      assert.equal(subBtn.disabled, false);

      // Retry with success
      api.updateRoom = async (rId, payload) => {
        attempts.push(payload);
        return { ok: true };
      };

      subBtn.click();
      await new Promise((r) => setTimeout(r, 15));

      assert.equal(attempts.length, 2);
      assert.deepEqual(
        attempts[1],
        { member_permissions: { coder: { can_create_subgroup: true } } },
        "Retry click must attempt can_create_subgroup=true (expected direction)"
      );
      assert.equal(state.roomById[TEST_ROOM_ID].member_permissions.coder.can_create_subgroup, true);
    });

    it("1.3: 'context' toggle 3-state cycle (full -> summary -> none -> full) rolls back each step on failure", async () => {
      const { container } = mountInspector(TEST_ROOM_ID);

      const steps = [
        { initial: "full", target: "summary" },
        { initial: "summary", target: "none" },
        { initial: "none", target: "full" },
      ];

      for (const step of steps) {
        state.roomById[TEST_ROOM_ID].member_permissions.coder.context_access = step.initial;
        const reRenderedRow = container.querySelector('[data-member="coder"]');
        let ctxBtn = reRenderedRow.querySelector('[data-act="context"]');

        let attempts = [];
        api.updateRoom = async (rId, payload) => {
          attempts.push(payload);
          throw new Error("Connection reset by peer");
        };

        // Click to toggle
        ctxBtn.click();
        await new Promise((r) => setTimeout(r, 15));

        assert.equal(attempts.length, 1);
        assert.deepEqual(attempts[0], { member_permissions: { coder: { context_access: step.target } } });

        // Verify state rolled back to step.initial
        assert.equal(
          state.roomById[TEST_ROOM_ID].member_permissions.coder.context_access,
          step.initial,
          `Failed transition from ${step.initial} to ${step.target} must roll back to ${step.initial}`
        );

        // Retry with success
        api.updateRoom = async (rId, payload) => {
          attempts.push(payload);
          return { ok: true };
        };

        const activeRow = container.querySelector('[data-member="coder"]');
        ctxBtn = activeRow.querySelector('[data-act="context"]');
        assert.equal(ctxBtn.disabled, false);

        ctxBtn.click();
        await new Promise((r) => setTimeout(r, 15));

        assert.equal(attempts.length, 2);
        assert.deepEqual(
          attempts[1],
          { member_permissions: { coder: { context_access: step.target } } },
          `Retry must attempt ${step.target} from ${step.initial}`
        );
        assert.equal(state.roomById[TEST_ROOM_ID].member_permissions.coder.context_access, step.target);
      }
    });
  });

  // =========================================================================
  // Suite 2: Burst / Repeated Network Failure Recovery
  // =========================================================================
  describe("2. Burst / Repeated Network Failure Recovery", () => {
    it("2.1: 5 consecutive failures keep state intact, and 6th attempt cleanly toggles", async () => {
      const { container } = mountInspector(TEST_ROOM_ID);
      const initialPerm = { ...state.roomById[TEST_ROOM_ID].member_permissions.coder };

      let failCount = 0;
      api.updateRoom = async () => {
        failCount++;
        if (failCount <= 5) {
          throw new Error(`Burst failure #${failCount}`);
        }
        return { ok: true };
      };

      for (let i = 1; i <= 5; i++) {
        const coderRow = container.querySelector('[data-member="coder"]');
        const speakBtn = coderRow.querySelector('[data-act="speak"]');
        speakBtn.click();
        await new Promise((r) => setTimeout(r, 15));

        assert.deepEqual(
          state.roomById[TEST_ROOM_ID].member_permissions.coder,
          initialPerm,
          `State must remain unchanged after failure #${i}`
        );
        assert.equal(speakBtn.disabled, false, `Button re-enabled after failure #${i}`);
      }

      // 6th attempt: network recovers
      const coderRow = container.querySelector('[data-member="coder"]');
      const speakBtn = coderRow.querySelector('[data-act="speak"]');
      speakBtn.click();
      await new Promise((r) => setTimeout(r, 15));

      assert.equal(
        state.roomById[TEST_ROOM_ID].member_permissions.coder.can_speak,
        false,
        "6th attempt successfully muting coder"
      );
    });
  });

  // =========================================================================
  // Suite 3: Cross-Member Asymmetric Network Outcomes
  // =========================================================================
  describe("3. Cross-Member Asymmetric Network Outcomes", () => {
    it("3.1: coder toggle failure does not corrupt concurrent reviewer toggle success", async () => {
      const { container } = mountInspector(TEST_ROOM_ID);

      const coderRow = container.querySelector('[data-member="coder"]');
      const reviewerRow = container.querySelector('[data-member="reviewer"]');

      const coderSpeakBtn = coderRow.querySelector('[data-act="speak"]');
      const reviewerSpeakBtn = reviewerRow.querySelector('[data-act="speak"]');

      // Coder will fail after 25ms, Reviewer will succeed after 20ms
      api.updateRoom = async (rId, payload) => {
        const mId = Object.keys(payload.member_permissions || {})[0];
        if (mId === "coder") {
          await new Promise((r) => setTimeout(r, 25));
          throw new Error("Coder API failure");
        } else if (mId === "reviewer") {
          await new Promise((r) => setTimeout(r, 20));
          const existing = state.roomById[rId] || {};
          const updatedPerms = { ...(existing.member_permissions || {}) };
          for (const [k, p] of Object.entries(payload.member_permissions || {})) {
            updatedPerms[k] = { ...(updatedPerms[k] || {}), ...p };
          }
          return { ...existing, member_permissions: updatedPerms };
        }
      };

      // Fire concurrently
      coderSpeakBtn.click();
      reviewerSpeakBtn.click();

      // Wait for both to complete
      await new Promise((r) => setTimeout(r, 50));

      const perms = state.roomById[TEST_ROOM_ID].member_permissions;
      assert.equal(perms.coder.can_speak, true, "coder rolled back to can_speak=true");
      assert.equal(perms.reviewer.can_speak, true, "reviewer successfully toggled to can_speak=true");
    });
  });

  // =========================================================================
  // Suite 4: Stochastic Monte Carlo Fuzzing of API Rejections (30 rounds)
  // =========================================================================
  describe("4. Stochastic Monte Carlo Fuzzing of API Rejections", () => {
    it("4.1: 30 random operations with simulated network latency and failure injection", async () => {
      const { container } = mountInspector(TEST_ROOM_ID);
      const members = ["boss", "coder", "reviewer"];
      const actions = ["speak", "subgroup", "context"];

      for (let iteration = 0; iteration < 30; iteration++) {
        const memberId = members[Math.floor(Math.random() * members.length)];
        const act = actions[Math.floor(Math.random() * actions.length)];
        const willFail = Math.random() < 0.5;
        const latency = 5 + Math.floor(Math.random() * 20);

        const memberRow = container.querySelector(`[data-member="${memberId}"]`);
        const btn = memberRow.querySelector(`[data-act="${act}"]`);
        assert.ok(btn, `Button for ${memberId} ${act} must exist`);

        const beforePerm = { ...state.roomById[TEST_ROOM_ID].member_permissions[memberId] };

        let invokedPayload = null;
        api.updateRoom = async (rId, payload) => {
          invokedPayload = payload;
          await new Promise((r) => setTimeout(r, latency));
          if (willFail) {
            throw new Error(`Random network fault in round ${iteration}`);
          }
          const existing = state.roomById[rId] || {};
          const updatedPerms = { ...(existing.member_permissions || {}) };
          for (const [k, p] of Object.entries(payload.member_permissions || {})) {
            updatedPerms[k] = { ...(updatedPerms[k] || {}), ...p };
          }
          return { ...existing, member_permissions: updatedPerms };
        };

        btn.click();
        await new Promise((r) => setTimeout(r, latency + 15));

        const afterPerm = state.roomById[TEST_ROOM_ID].member_permissions[memberId];

        if (willFail) {
          // Verify rollback
          assert.deepEqual(
            afterPerm,
            beforePerm,
            `Round ${iteration} (${memberId} ${act}): state must roll back to pre-click baseline on rejection`
          );

          // Test immediate retry on failure
          const reRenderedRow = container.querySelector(`[data-member="${memberId}"]`);
          const retryBtn = reRenderedRow.querySelector(`[data-act="${act}"]`);
          assert.equal(retryBtn.disabled, false, "Retry button must be re-enabled");

          let retryPayload = null;
          api.updateRoom = async (rId, payload) => {
            retryPayload = payload;
            const existing = state.roomById[rId] || {};
            const updatedPerms = { ...(existing.member_permissions || {}) };
            for (const [k, p] of Object.entries(payload.member_permissions || {})) {
              updatedPerms[k] = { ...(updatedPerms[k] || {}), ...p };
            }
            return { ...existing, member_permissions: updatedPerms };
          };

          retryBtn.click();
          await new Promise((r) => setTimeout(r, 15));

          assert.deepEqual(
            retryPayload,
            invokedPayload,
            `Round ${iteration} (${memberId} ${act}): retry payload must match original desired payload (no inversion)`
          );
        } else {
          // Succeeded
          if (act === "speak") {
            assert.equal(afterPerm.can_speak, !beforePerm.can_speak);
          } else if (act === "subgroup") {
            assert.equal(afterPerm.can_create_subgroup, !beforePerm.can_create_subgroup);
          } else if (act === "context") {
            const nextExpected = beforePerm.context_access === "full" ? "summary" : beforePerm.context_access === "summary" ? "none" : "full";
            assert.equal(afterPerm.context_access, nextExpected);
          }
        }
      }
    });
  });

  // =========================================================================
  // Suite 5: Empirical Stress on Same-Member Concurrent Interleaving with Failure
  // =========================================================================
  describe("5. Stress on Same-Member Concurrent Interleaving with Failure", () => {
    it("5.1: when speak fails after subgroup has already succeeded on the same member", async () => {
      const { container } = mountInspector(TEST_ROOM_ID);

      // Baseline: coder has can_speak: true, can_create_subgroup: false
      assert.equal(state.roomById[TEST_ROOM_ID].member_permissions.coder.can_speak, true);
      assert.equal(state.roomById[TEST_ROOM_ID].member_permissions.coder.can_create_subgroup, false);

      // Subgroup completes fast (15ms) and succeeds.
      // Speak takes longer (35ms) and fails.
      api.updateRoom = async (rId, payload) => {
        const patch = payload.member_permissions?.coder || {};
        if ("can_speak" in patch) {
          await new Promise((r) => setTimeout(r, 35));
          throw new Error("Speak toggle failed on network");
        }
        if ("can_create_subgroup" in patch) {
          await new Promise((r) => setTimeout(r, 15));
          const existing = state.roomById[rId] || {};
          const updatedPerms = { ...(existing.member_permissions || {}) };
          for (const [k, p] of Object.entries(payload.member_permissions || {})) {
            updatedPerms[k] = { ...(updatedPerms[k] || {}), ...p };
          }
          return { ...existing, member_permissions: updatedPerms };
        }
      };

      const coderRow = container.querySelector('[data-member="coder"]');
      const speakBtn = coderRow.querySelector('[data-act="speak"]');
      const subgroupBtn = coderRow.querySelector('[data-act="subgroup"]');

      // Click speak first (in-flight for 35ms, will fail)
      speakBtn.click();

      // At 5ms, click subgroup (in-flight for 15ms, will succeed at 20ms)
      await new Promise((r) => setTimeout(r, 5));
      subgroupBtn.click();

      // Wait 50ms for both to finish
      await new Promise((r) => setTimeout(r, 50));

      const finalPerm = state.roomById[TEST_ROOM_ID].member_permissions.coder;
      console.log("Empirical Observation 5.1 - finalPerm:", JSON.stringify(finalPerm));

      // What did we observe?
      // When speak failed at 35ms, did its catch block roll back can_create_subgroup back to false?
      // In group.js:
      // catch (err) {
      //   const rollBackRoom = state.roomById[roomId];
      //   if (rollBackRoom?.member_permissions) {
      //     rollBackRoom.member_permissions[memberId] = prevMemberPerm;
      //   }
      // }
      // Because prevMemberPerm was captured before speak (when subgroup was false),
      // rollBackRoom.member_permissions[memberId] = prevMemberPerm sets subgroup back to false!
    });
  });
});
