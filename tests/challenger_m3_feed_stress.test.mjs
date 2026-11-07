/**
 * agent_for_myself/tests/challenger_m3_feed_stress.test.mjs
 *
 * Empirical Challenger Stress Harness for Milestone 3 (Feed & Tools):
 * - High-frequency scroll thrashing: alternating scrolls inside and outside 64px latching zone
 * - Message append burst: rapidly pushing 100+ messages into the store while detached
 * - Re-latch trigger stress: #btn-scroll-bottom click, user message submit, manual scroll
 * - Tool card accordion stress: 50x chevron toggling, 40x output clamp cycling, clipboard copy
 * - Evidence badge click routing: multi-message tool card isolation, state.inspector routing
 * - Resilience & teardown: malformed tool data, rapid mount/destroy cycles
 *
 * Environment: Node >= 22.19.0, pure ESM, ZERO external npm dependencies.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Setup headless DOM
const { setupHeadlessDOM } = await import("./_helpers/headless_dom.mjs");
const domHarness = setupHeadlessDOM();

// Clipboard mock tracking
let lastCopiedText = null;
let clipboardWriteCount = 0;
try {
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (text) => {
        lastCopiedText = String(text);
        clipboardWriteCount++;
      },
    },
    configurable: true,
  });
} catch {
  // Ignore if navigator is frozen
}

// Import application modules under test
const apiModule = await import("../web/js/api.js");
const storeModule = await import("../web/js/store.js");
const groupViewModule = await import("../web/js/views/group.js");

const { api } = apiModule;

const {
  state,
  applyEvent,
  newActivity,
  sendRoomMessage,
} = storeModule;

const {
  GroupView,
  toolCardHTML,
  toolsClusterHTML,
  formatDuration,
  formatToolParams,
  formatToolOutput,
  evidenceBadgeHTML,
} = groupViewModule;

describe("Challenger M3 Feed & Tools Empirical Stress Suite", () => {
  let root;
  let view;
  const testRoomId = "room_challenger_m3";

  function resetRoom(roomId = testRoomId) {
    state.inspector = null;
    state.evidence = {};
    state.files = {};
    state.messages = {};
    state.activity = {};
    state.roomById[roomId] = {
      room_id: roomId,
      title: "M3 极限压力测试群",
      topic: "Feed & Tools Challenger Harness",
      context_policy: "shared",
      owner_id: "boss",
      members: ["boss", "coder", "reviewer", "analyst"],
    };
    state.rooms = [state.roomById[roomId]];
    state.messages[roomId] = [];
    state.activity[roomId] = newActivity(roomId);
  }

  beforeEach(() => {
    lastCopiedText = null;
    clipboardWriteCount = 0;
    api.say = async () => ({ ok: true });
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById("app");
    resetRoom();
    view = new GroupView(root);
    view.mount(testRoomId);

    // Default container dimensions: height 400px, content 1000px, scrolled to bottom (scrollTop 600)
    view.el.scroll.scrollHeight = 1000;
    view.el.scroll.clientHeight = 400;
    view.el.scroll.scrollTop = 600; // dist = 1000 - 600 - 400 = 0 (latched)
  });

  afterEach(() => {
    if (view && typeof view.destroy === "function") {
      view.destroy();
    }
  });

  // =========================================================================
  // Suite 1: High-Frequency Scroll Thrashing & Boundary Stress
  // =========================================================================
  describe("Suite 1: High-Frequency Scroll Thrashing & Boundary Stress", () => {
    it("1.1: Exact 64px latch boundary step verification (63px, 64px, 65px)", () => {
      // scrollHeight = 1000, clientHeight = 400
      // dist = 1000 - scrollTop - 400 = 600 - scrollTop

      // Case A: dist = 64px exactly -> scrollTop = 536
      view.el.scroll.scrollTop = 536;
      view.el.scroll.dispatchEvent(new Event("scroll"));
      assert.equal(view.isLatched, true, "dist == 64px must latch");
      assert.equal(view.el.scrollBottomBtn.hidden, true, "bottom button must be hidden at 64px");

      // Case B: dist = 65px (just 1px outside boundary) -> scrollTop = 535
      view.el.scroll.scrollTop = 535;
      view.el.scroll.dispatchEvent(new Event("scroll"));
      assert.equal(view.isLatched, false, "dist == 65px must detach");
      assert.equal(view.el.scrollBottomBtn.hidden, false, "bottom button must be shown at 65px");

      // Case C: dist = 63px (just 1px inside boundary) -> scrollTop = 537
      view.el.scroll.scrollTop = 537;
      view.el.scroll.dispatchEvent(new Event("scroll"));
      assert.equal(view.isLatched, true, "dist == 63px must latch");
      assert.equal(view.el.scrollBottomBtn.hidden, true, "bottom button must be hidden at 63px");

      // Case D: negative distance (overscroll simulation, dist = -20px) -> scrollTop = 620
      view.el.scroll.scrollTop = 620;
      view.el.scroll.dispatchEvent(new Event("scroll"));
      assert.equal(view.isLatched, true, "negative distance (overscroll) must remain latched");
      assert.equal(view.el.scrollBottomBtn.hidden, true);
    });

    it("1.2: 100-cycle high-frequency scroll thrash across latch boundary", () => {
      // Alternate 100 times between detached (dist = 300, scrollTop = 300)
      // and latched (dist = 20, scrollTop = 580)
      for (let i = 0; i < 100; i++) {
        const isOdd = i % 2 === 1;
        if (isOdd) {
          // Detach
          view.el.scroll.scrollTop = 300;
          view.el.scroll.dispatchEvent(new Event("scroll"));
          assert.equal(view.isLatched, false, `Cycle ${i}: Expected detached at dist=300`);
          assert.equal(view.el.scrollBottomBtn.hidden, false, `Cycle ${i}: Button visible when detached`);
        } else {
          // Latch
          view.el.scroll.scrollTop = 580;
          view.el.scroll.dispatchEvent(new Event("scroll"));
          assert.equal(view.isLatched, true, `Cycle ${i}: Expected latched at dist=20`);
          assert.equal(view.el.scrollBottomBtn.hidden, true, `Cycle ${i}: Button hidden when latched`);
          assert.equal(view.unreadCount, 0, `Cycle ${i}: Unread count reset to 0 upon latching`);
        }
      }
    });

    it("1.3: Micro-jitter within detached zone preserves unread count integrity", () => {
      // Detach
      view.el.scroll.scrollTop = 300;
      view.el.scroll.dispatchEvent(new Event("scroll"));
      assert.equal(view.isLatched, false);

      // Simulate 5 unread messages
      view.unreadCount = 5;
      view.updateScrollBottomButton();
      assert.equal(view.el.scrollUnreadBadge.textContent, "5");
      assert.equal(view.el.scrollUnreadBadge.hidden, false);

      // Jitter scroll around detached area (scrollTop 280 -> 320 -> 290 -> 310)
      const jitters = [280, 320, 290, 310, 270, 305];
      for (const st of jitters) {
        view.el.scroll.scrollTop = st;
        view.el.scroll.dispatchEvent(new Event("scroll"));
        assert.equal(view.isLatched, false, "Must stay detached during micro-jitter");
        assert.equal(view.unreadCount, 5, "Unread count must NOT be corrupted by jitter");
        assert.equal(view.el.scrollUnreadBadge.textContent, "5");
        assert.equal(view.el.scrollUnreadBadge.hidden, false);
      }
    });

    it("1.4: Programmatic scroll guard ignores automated scroll events", () => {
      view.isProgrammaticScroll = true;
      // Scroll to detached offset while programmatic flag is on
      view.el.scroll.scrollTop = 100;
      view.el.scroll.dispatchEvent(new Event("scroll"));

      // Event should be swallowed by isProgrammaticScroll
      assert.equal(view.isProgrammaticScroll, false, "Programmatic flag consumed");
      assert.equal(view.isLatched, true, "isLatched unchanged because scroll event was programmatic");
    });
  });

  // =========================================================================
  // Suite 2: Message Append Burst Under Detached State
  // =========================================================================
  describe("Suite 2: Message Append Burst Under Detached State", () => {
    it("2.1: Massive single burst of 150 messages while detached maintains unread count and anti-jump", () => {
      // User scrolls up to read history: scrollTop = 250, dist = 350
      view.el.scroll.scrollTop = 250;
      view.el.scroll.dispatchEvent(new Event("scroll"));
      assert.equal(view.isLatched, false);

      const burstSize = 150;
      const initialScrollTop = view.el.scroll.scrollTop;
      const messages = [];
      for (let i = 1; i <= burstSize; i++) {
        messages.push({
          id: `msg_burst_${i}`,
          seq: i,
          type: "msg",
          speaker: i % 2 === 0 ? "coder" : "reviewer",
          content: `Burst message ${i}: stress test payload line`,
          ts: Date.now() + i * 10,
        });
      }

      state.messages[testRoomId] = messages;
      view.renderTimeline(state.roomById[testRoomId]);

      // Assertions
      assert.equal(view.isLatched, false, "Latching remains detached");
      assert.equal(view.unreadCount, burstSize, `Unread count must accurately equal ${burstSize}`);
      assert.equal(view.el.scrollBottomBtn.hidden, false, "Bottom button must be visible");
      assert.equal(view.el.scrollUnreadBadge.hidden, false, "Unread badge must be visible");
      assert.equal(view.el.scrollUnreadBadge.textContent, String(burstSize), `Badge must display '${burstSize}'`);
      assert.equal(view.el.scroll.scrollTop, initialScrollTop, "Viewport anti-jump: scrollTop strictly preserved");

      // Verify DOM row count
      const rows = view.el.inner.querySelectorAll(".msg-row");
      assert.equal(rows.length, burstSize, `Inner feed contains ${burstSize} rendered rows`);
    });

    it("2.2: Multi-step streaming bursts (10 batches of 15 messages = 150 total) increment counter monotonically", () => {
      view.el.scroll.scrollTop = 200;
      view.el.scroll.dispatchEvent(new Event("scroll"));
      assert.equal(view.isLatched, false);

      const batchCount = 10;
      const batchSize = 15;
      let totalMessages = [];

      for (let b = 1; b <= batchCount; b++) {
        for (let i = 1; i <= batchSize; i++) {
          const idx = (b - 1) * batchSize + i;
          totalMessages.push({
            id: `msg_stream_${idx}`,
            seq: idx,
            type: "msg",
            speaker: "coder",
            content: `Batch ${b} item ${i}`,
            ts: Date.now() + idx,
          });
        }
        state.messages[testRoomId] = [...totalMessages];
        view.renderTimeline(state.roomById[testRoomId]);

        const expectedCount = b * batchSize;
        assert.equal(view.unreadCount, expectedCount, `Batch ${b}: expected unreadCount=${expectedCount}`);
        assert.equal(view.el.scrollUnreadBadge.textContent, String(expectedCount));
        assert.equal(view.el.scrollUnreadBadge.hidden, false);
      }
      assert.equal(view.unreadCount, 150);
    });

    it("2.3: Mixed-role burst stress (120 messages) renders user, assistant, system, and tool rows", () => {
      view.el.scroll.scrollTop = 200;
      view.el.scroll.dispatchEvent(new Event("scroll"));

      const mixed = [];
      for (let i = 1; i <= 120; i++) {
        const mod = i % 4;
        if (mod === 0) {
          mixed.push({ id: `m_${i}`, seq: i, type: "msg", speaker: "user", content: `User query ${i}` });
        } else if (mod === 1) {
          mixed.push({
            id: `m_${i}`,
            seq: i,
            type: "msg",
            speaker: "coder",
            content: `Assistant response ${i}`,
            tools: [{ id: `tc_${i}`, tool: "exec_cmd", status: "ok", duration: 12, output: "done" }],
          });
        } else if (mod === 2) {
          mixed.push({ id: `m_${i}`, seq: i, type: "msg", role: "system", content: `System checkpoint ${i}` });
        } else {
          mixed.push({ id: `m_${i}`, seq: i, type: "msg", role: "tool", tool_name: "fs_read", content: `Tool content ${i}` });
        }
      }

      state.messages[testRoomId] = mixed;
      view.renderTimeline(state.roomById[testRoomId]);

      assert.equal(view.unreadCount, 120);
      assert.equal(view.el.scrollUnreadBadge.textContent, "120");

      const userRows = view.el.inner.querySelectorAll(".msg-row.is-user");
      const botRows = view.el.inner.querySelectorAll(".msg-row.is-assistant");
      const sysRows = view.el.inner.querySelectorAll(".msg-row.is-system");
      const toolRows = view.el.inner.querySelectorAll(".msg-row.is-tool");

      assert.equal(userRows.length, 30, "30 user rows");
      assert.equal(botRows.length, 30, "30 assistant rows");
      assert.equal(sysRows.length, 30, "30 system rows");
      assert.equal(toolRows.length, 30, "30 tool rows");
    });
  });

  // =========================================================================
  // Suite 3: Re-Latch Trigger Stress & Invariant Checking
  // =========================================================================
  describe("Suite 3: Re-Latch Trigger Stress & Invariant Checking", () => {
    it("3.1: Trigger A (#btn-scroll-bottom click) resets unread to 0 and restores latching after 100 messages", () => {
      view.el.scroll.scrollTop = 200;
      view.el.scroll.dispatchEvent(new Event("scroll"));
      view.unreadCount = 100;
      view.updateScrollBottomButton();

      assert.equal(view.el.scrollBottomBtn.hidden, false);
      assert.equal(view.el.scrollUnreadBadge.textContent, "100");

      // Click button
      view.el.scrollBottomBtn.click();

      assert.equal(view.isLatched, true, "Must re-latch");
      assert.equal(view.unreadCount, 0, "Unread count must zero");
      assert.equal(view.el.scrollBottomBtn.hidden, true, "Button must hide");
      assert.equal(view.el.scrollUnreadBadge.hidden, true, "Badge must hide");
      assert.equal(view.el.scrollUnreadBadge.textContent, "0", "Badge reset to '0'");

      // Verify subsequent message while latched doesn't increment unread
      state.messages[testRoomId] = [
        { id: "new_1", seq: 101, type: "msg", speaker: "coder", content: "Post-latch msg" },
      ];
      view.renderTimeline(state.roomById[testRoomId]);
      assert.equal(view.unreadCount, 0, "Unread count stays 0 when message arrives while latched");
      assert.equal(view.el.scrollBottomBtn.hidden, true);
    });

    it("3.2: Trigger B (User message submit) resets unread to 0, clears input, and re-latches viewport", async () => {
      view.el.scroll.scrollTop = 200;
      view.el.scroll.dispatchEvent(new Event("scroll"));
      view.unreadCount = 42;
      view.updateScrollBottomButton();

      assert.equal(view.isLatched, false);
      assert.equal(view.unreadCount, 42);

      // User types and submits message (api.say resolves successfully)
      api.say = async () => ({ ok: true });
      view.el.input.value = "用户输入紧急指令";
      view.syncSendButtonState();
      await view.submit();

      assert.equal(view.isLatched, true, "User submit must re-latch");
      assert.equal(view.unreadCount, 0, "User submit zeroes unread counter");
      assert.equal(view.el.scrollBottomBtn.hidden, true, "Button hidden");
      assert.equal(view.el.scrollUnreadBadge.hidden, true, "Badge hidden");
      assert.equal(view.el.input.value, "", "Input cleared upon successful send");
      assert.equal(view.el.input.style.height, "40px", "Textarea reset to 40px");

      // Now verify failure recovery: network error restores input value
      try {
        api.say = async () => { throw new Error("Network simulated down"); };
        view.isLatched = false;
        view.el.input.value = "待重试的内容";
        view.syncSendButtonState();
        await view.submit();

        assert.equal(view.isLatched, true, "Latch engaged during submission attempt");
        assert.equal(view.el.input.value, "待重试的内容", "Content preserved upon failure for retry");
      } finally {
        api.say = async () => ({ ok: true });
      }
    });

    it("3.3: Trigger C (Manual scroll to bottom <= 64px) resets unread and re-latches", () => {
      view.el.scroll.scrollTop = 200;
      view.el.scroll.dispatchEvent(new Event("scroll"));
      view.unreadCount = 68;
      view.updateScrollBottomButton();

      assert.equal(view.isLatched, false);
      assert.equal(view.unreadCount, 68);

      // User scrolls to dist = 30 (scrollTop = 570)
      view.el.scroll.scrollTop = 570;
      view.el.scroll.dispatchEvent(new Event("scroll"));

      assert.equal(view.isLatched, true, "Re-latched when dist <= 64");
      assert.equal(view.unreadCount, 0, "Unread count cleared on manual scroll to bottom");
      assert.equal(view.el.scrollBottomBtn.hidden, true);
      assert.equal(view.el.scrollUnreadBadge.hidden, true);
    });

    it("3.4: Rapid sequential trigger transitions without counter corruption", async () => {
      // 9 cycles of detach -> burst -> trigger
      for (let i = 0; i < 9; i++) {
        // Clear any leftover programmatic scroll guard before user manual scroll
        view.isProgrammaticScroll = false;

        // Detach
        view.el.scroll.scrollTop = 200;
        view.el.scroll.dispatchEvent(new Event("scroll"));
        view.unreadCount = 10;
        view.updateScrollBottomButton();
        assert.equal(view.isLatched, false, `Cycle ${i}: Expected detached at scrollTop=200`);

        if (i % 3 === 0) {
          // Trigger A
          view.el.scrollBottomBtn.click();
        } else if (i % 3 === 1) {
          // Trigger B
          view.el.input.value = `Test submit ${i}`;
          await view.submit();
        } else {
          // Trigger C
          view.el.scroll.scrollTop = 590;
          view.el.scroll.dispatchEvent(new Event("scroll"));
        }

        assert.equal(view.isLatched, true, `Cycle ${i}: Must be latched after trigger`);
        assert.equal(view.unreadCount, 0, `Cycle ${i}: Unread must be 0`);
        assert.equal(view.el.scrollBottomBtn.hidden, true, `Cycle ${i}: Button hidden`);
      }
    });
  });

  // =========================================================================
  // Suite 4: Tool Card Accordion Stress & Output Clamp Cycling
  // =========================================================================
  describe("Suite 4: Tool Card Accordion Stress & Output Clamp Cycling", () => {
    it("4.1: Rapid accordion toggling 50x strictly alternates expanded and collapsed states", () => {
      const toolData = {
        id: "tc_stress_50",
        tool: "bash_exec",
        status: "ok",
        duration: 45,
        params: { cmd: "ls -la" },
        output: "total 40\ndrwxr-xr-x 5 user 160 Nov 7\n-rw-r--r-- 1 user 1024 Nov 7",
      };

      const wrap = document.createElement("div");
      wrap.innerHTML = toolCardHTML(toolData);
      view.el.inner.appendChild(wrap);
      view.bindMessageActions();

      const card = wrap.querySelector(".tool-card");
      const head = wrap.querySelector(".tool-card-head");
      const body = wrap.querySelector(".tool-card-body");

      assert.ok(card && head && body);
      // Successful tool starts collapsed
      assert.equal(body.hidden, true, "Initial state: collapsed");
      assert.equal(card.classList.contains("is-expanded"), false);

      // Perform 50 clicks
      for (let c = 1; c <= 50; c++) {
        head.onclick(new Event("click"));
        const shouldBeExpanded = c % 2 === 1;

        assert.equal(
          !body.hidden,
          shouldBeExpanded,
          `Click ${c}: body.hidden mismatch (expected hidden=${!shouldBeExpanded})`
        );
        assert.equal(
          card.classList.contains("is-expanded"),
          shouldBeExpanded,
          `Click ${c}: is-expanded class mismatch`
        );
      }

      // After 50 clicks (even), must be back to collapsed
      assert.equal(body.hidden, true);
      assert.equal(card.classList.contains("is-expanded"), false);
    });

    it("4.2: Nested button clicks inside tool-card-head do not trigger accordion toggle", () => {
      const wrap = document.createElement("div");
      wrap.innerHTML = `
        <div class="tool-card is-ok" data-tool-card="nested_test">
          <div class="tool-card-head" role="button">
            <span class="tool-name">test_tool</span>
            <button class="nested-action-btn" type="button">Action</button>
          </div>
          <div class="tool-card-body" hidden>
            <div class="tool-section">Body content</div>
          </div>
        </div>`;
      view.el.inner.appendChild(wrap);
      view.bindMessageActions();

      const card = wrap.querySelector(".tool-card");
      const head = wrap.querySelector(".tool-card-head");
      const nestedBtn = wrap.querySelector(".nested-action-btn");
      const body = wrap.querySelector(".tool-card-body");

      assert.equal(body.hidden, true);

      // Clicking nested button
      const ev = new Event("click");
      Object.defineProperty(ev, "target", { value: nestedBtn });
      head.onclick(ev);

      assert.equal(body.hidden, true, "Accordion must NOT expand when clicking a nested button");
      assert.equal(card.classList.contains("is-expanded"), false);
    });

    it("4.3: 40-cycle output clamp expand/collapse stress toggles .is-clamped and label", () => {
      const longOutput = Array.from({ length: 15 }, (_, i) => `Line ${i + 1}: detailed output diagnostics log data`).join("\n");
      const wrap = document.createElement("div");
      wrap.innerHTML = toolCardHTML({
        id: "tc_clamp_stress",
        tool: "build_analyzer",
        status: "ok",
        duration: 120,
        params: {},
        output: longOutput,
      });
      view.el.inner.appendChild(wrap);
      view.bindMessageActions();

      const clampBtn = wrap.querySelector("[data-clamp-toggle]");
      const outputBox = wrap.querySelector(".tool-output-box");

      assert.ok(clampBtn, "Clamp button must exist for >6 line output");
      assert.ok(outputBox, "Output box must exist");
      assert.equal(outputBox.classList.contains("is-clamped"), true, "Initial state: clamped");

      for (let c = 1; c <= 40; c++) {
        clampBtn.onclick(new Event("click"));
        const shouldBeExpanded = c % 2 === 1;

        if (shouldBeExpanded) {
          assert.equal(outputBox.classList.contains("is-clamped"), false, `Cycle ${c}: .is-clamped must be removed`);
          assert.equal(clampBtn.textContent, "收起输出", `Cycle ${c}: text should be '收起输出'`);
        } else {
          assert.equal(outputBox.classList.contains("is-clamped"), true, `Cycle ${c}: .is-clamped must be restored`);
          assert.ok(clampBtn.textContent.includes("展开完整输出"), `Cycle ${c}: text should include '展开完整输出'`);
        }
      }
    });

    it("4.4: 30-cycle alternating parameter and output clipboard copy stress", async () => {
      const paramsObj = { project: "agent_for_myself", mode: "challenger_stress", retries: 5 };
      const outputStr = "SUCCESS: All 35 tests verified without anomaly.";
      const wrap = document.createElement("div");
      wrap.innerHTML = toolCardHTML({
        id: "tc_copy_stress",
        tool: "verify_runner",
        status: "ok",
        duration: 88,
        params: paramsObj,
        output: outputStr,
      });
      view.el.inner.appendChild(wrap);
      view.bindMessageActions();

      const paramsBtn = wrap.querySelector('[data-copy-target="params"]');
      const outputBtn = wrap.querySelector('[data-copy-target="output"]');

      assert.ok(paramsBtn && outputBtn);

      for (let c = 1; c <= 30; c++) {
        if (c % 2 === 1) {
          await paramsBtn.onclick(new Event("click"));
          assert.ok(lastCopiedText.includes("challenger_stress"), `Copy cycle ${c}: params text copied`);
          assert.equal(paramsBtn.textContent, "已复制");
        } else {
          await outputBtn.onclick(new Event("click"));
          assert.equal(lastCopiedText, outputStr, `Copy cycle ${c}: output text copied`);
          assert.equal(outputBtn.textContent, "已复制");
        }
      }
      assert.equal(clipboardWriteCount, 30, "30 clipboard operations completed successfully");
    });
  });

  // =========================================================================
  // Suite 5: Evidence Badge Click Routing & Isolation
  // =========================================================================
  describe("Suite 5: Evidence Badge Click Routing & Isolation", () => {
    it("5.1: Clicking evidence badge targets ONLY the tool cards in its own message row", () => {
      // 3 messages: msg 1 (user), msg 2 (2 tools), msg 3 (1 tool)
      const msg1 = { id: "m1", seq: 101, type: "msg", speaker: "user", content: "Query" };
      const msg2 = {
        id: "m2",
        seq: 102,
        type: "msg",
        speaker: "coder",
        evidence: "observed",
        content: "Assistant with 2 tools",
        tools: [
          { id: "t2_1", tool: "tool_alpha", status: "ok", duration: 10, output: "alpha ok" },
          { id: "t2_2", tool: "tool_beta", status: "ok", duration: 20, output: "beta ok" },
        ],
      };
      const msg3 = {
        id: "m3",
        seq: 103,
        type: "msg",
        speaker: "reviewer",
        evidence: "mismatch",
        content: "Assistant with 1 tool",
        tools: [
          { id: "t3_1", tool: "tool_gamma", status: "ok", duration: 15, output: "gamma ok" },
        ],
      };

      state.messages[testRoomId] = [msg1, msg2, msg3];
      view.renderTimeline(state.roomById[testRoomId]);

      const rows = view.el.inner.querySelectorAll(".msg-row");
      assert.equal(rows.length, 3);

      const row2 = rows[1];
      const row3 = rows[2];

      const badge2 = row2.querySelector("[data-ev-badge]");
      const badge3 = row3.querySelector("[data-ev-badge]");

      const toolsInRow2 = row2.querySelectorAll(".tool-card");
      const toolsInRow3 = row3.querySelectorAll(".tool-card");

      assert.equal(toolsInRow2.length, 2);
      assert.equal(toolsInRow3.length, 1);

      // Initially all tool cards are collapsed
      toolsInRow2.forEach((tc) => assert.equal(tc.querySelector(".tool-card-body").hidden, true));
      toolsInRow3.forEach((tc) => assert.equal(tc.querySelector(".tool-card-body").hidden, true));

      // Click badge in row 2
      badge2.click();

      // Tool cards in row 2 must be expanded and highlighted
      toolsInRow2.forEach((tc) => {
        assert.equal(tc.querySelector(".tool-card-body").hidden, false, "Row 2 tool card expanded");
        assert.equal(tc.classList.contains("is-expanded"), true);
        assert.equal(tc.classList.contains("is-highlighted"), true);
      });

      // Tool cards in row 3 must remain untouched (collapsed and not highlighted)
      toolsInRow3.forEach((tc) => {
        assert.equal(tc.querySelector(".tool-card-body").hidden, true, "Row 3 tool card remains collapsed");
        assert.equal(tc.classList.contains("is-expanded"), false);
        assert.equal(tc.classList.contains("is-highlighted"), false);
      });
    });

    it("5.2: Sequential rapid evidence badge clicks route state.inspector and dispatch ah:inspector", () => {
      const msgObs = {
        id: "m_obs",
        seq: 201,
        type: "msg",
        speaker: "coder",
        evidence: "observed",
        content: "Observed",
        tools: [{ id: "t_obs", tool: "run_build", status: "ok", duration: 50, output: "ok" }],
      };
      const msgMis = {
        id: "m_mis",
        seq: 202,
        type: "msg",
        speaker: "coder",
        evidence: "mismatch",
        content: "Mismatch",
        tools: [{ id: "t_mis", tool: "room_file_read", status: "error", duration: 10, output: "fail" }],
      };

      state.messages[testRoomId] = [msgObs, msgMis];
      view.renderTimeline(state.roomById[testRoomId]);

      const badges = view.el.inner.querySelectorAll("[data-ev-badge]");
      assert.equal(badges.length, 2);

      const eventsReceived = [];
      const listener = (ev) => eventsReceived.push(ev.detail);
      document.addEventListener("ah:inspector", listener);

      try {
        // Click 1: seq 201
        badges[0].click();
        assert.equal(state.inspector?.type, "group");
        assert.equal(state.inspector?.id, testRoomId);
        assert.equal(state.inspector?.tab, "evidence");
        assert.equal(state.inspector?.seq, 201);

        // Click 2: seq 202
        badges[1].click();
        assert.equal(state.inspector?.type, "group");
        assert.equal(state.inspector?.id, testRoomId);
        assert.equal(state.inspector?.tab, "evidence");
        assert.equal(state.inspector?.seq, 202);

        // Verify events
        assert.equal(eventsReceived.length, 2);
        assert.equal(eventsReceived[0].seq, 201);
        assert.equal(eventsReceived[1].seq, 202);
      } finally {
        document.removeEventListener("ah:inspector", listener);
      }
    });

    it("5.3: Evidence badge click on message with zero tool cards routes safely without error", () => {
      const msgStated = {
        id: "m_no_tools",
        seq: 301,
        type: "msg",
        speaker: "reviewer",
        evidence: "prepared",
        content: "This is purely stated without tool calls",
        tools: [],
      };

      state.messages[testRoomId] = [msgStated];
      view.renderTimeline(state.roomById[testRoomId]);

      const badge = view.el.inner.querySelector("[data-ev-badge]");
      assert.ok(badge);

      assert.doesNotThrow(() => {
        badge.click();
      });

      assert.equal(state.inspector?.type, "group");
      assert.equal(state.inspector?.id, testRoomId);
      assert.equal(state.inspector?.tab, "evidence");
      assert.equal(state.inspector?.seq, 301);
    });
  });

  // =========================================================================
  // Suite 6: Resilience, Format Helpers & Lifecycle Teardown
  // =========================================================================
  describe("Suite 6: Resilience, Format Helpers & Lifecycle Teardown", () => {
    it("6.1: Format helpers survive malformed and extreme tool data inputs", () => {
      // formatDuration
      assert.equal(formatDuration(null), "");
      assert.equal(formatDuration(undefined), "");
      assert.equal(formatDuration("invalid"), "");
      assert.equal(formatDuration(-50), "");
      assert.equal(formatDuration(0), "");
      assert.equal(formatDuration(450), "450ms");
      assert.equal(formatDuration(1500), "1.5s");

      // formatToolParams
      assert.ok(formatToolParams(null).includes("无参数"));
      assert.ok(formatToolParams({}).includes("无参数"));
      assert.ok(formatToolParams('{"valid": "json"}').includes("valid"));
      assert.ok(formatToolParams("not a valid json {[[[<").includes("not a valid json"));

      // formatToolOutput
      const emptyOut = formatToolOutput(null);
      assert.equal(emptyOut.isClamped, false);
      assert.ok(emptyOut.html.includes("无返回内容"));

      const longObj = { nested: { array: Array.from({ length: 20 }, (_, i) => `item_${i}`) } };
      const objOut = formatToolOutput(longObj);
      assert.equal(objOut.isClamped, true);
      assert.ok(objOut.lineCount > 6);

      // toolCardHTML with empty/null tool
      const emptyCard = toolCardHTML({});
      assert.ok(emptyCard.includes("tool-card"));
      assert.ok(emptyCard.includes("tool"));
    });

    it("6.2: Rapid 20-cycle mount and destroy lifecycle maintains stability without leaks", () => {
      for (let i = 0; i < 20; i++) {
        const testContainer = document.createElement("div");
        document.body.appendChild(testContainer);
        const tempView = new GroupView(testContainer);
        tempView.mount(`room_lifecycle_${i}`);

        // Add some messages
        state.messages[`room_lifecycle_${i}`] = [
          { id: `lc_${i}`, seq: 1, type: "msg", speaker: "coder", content: `Cycle ${i}` },
        ];
        tempView.renderTimeline({ room_id: `room_lifecycle_${i}`, members: ["coder"] });

        assert.equal(tempView.el.inner.querySelectorAll(".msg-row").length, 1);
        tempView.destroy();
        testContainer.remove();
      }
    });
  });
});
