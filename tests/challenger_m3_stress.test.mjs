/**
 * tests/challenger_m3_stress.test.mjs
 *
 * Empirical Adversarial Challenger Stress Harness for Milestone 3 (Features 12 to 16):
 * 1. Viewport latching edge cases:
 *    - Rapid scroll thrashes (50+ alternating scroll events between reading and bottom).
 *    - Content expanding while detached (large message volume, expanding tool cards).
 *    - Extreme boundary conditions: dist = 64px, 64.001px, 63.999px, negative dist (overscroll).
 *    - Enormous scrollHeight (10M px) stability.
 * 2. Tool cards edge cases:
 *    - Huge output (100,000 chars, 5,000 lines): clamp detection, line counting, copy completeness.
 *    - Missing / invalid duration (null, undefined, 0, -100, NaN, Infinity).
 *    - Missing / null output, empty parameters, malformed parameter inputs.
 *    - Concurrent tools running simultaneously for the same bot: out-of-order completion, call_id routing.
 * 3. Evidence badges edge cases:
 *    - Missing, null, undefined, or NaN sequence / claim links.
 *    - Mismatches and orphan badges (evidence badge in message without tool cards).
 *    - Interoperability with inspector state machine and event dispatching.
 *    - Invalid evidence status values.
 * 4. Composer dock edge cases:
 *    - Rapid input cycling (100 rapid changes between tall, empty, multiline).
 *    - Foreign language & script handling in mention matcher (Chinese, Japanese, Korean, Cyrillic, Emoji).
 *    - Empty attachments, adding/removing attachments, send button state synchronization.
 *    - Submitting while generating: stop button morphing and click interception vs Enter key.
 *
 * Runs with `node --test` with ZERO external npm dependencies.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Setup headless DOM
const { setupHeadlessDOM } = await import("./_helpers/headless_dom.mjs");
const domHarness = setupHeadlessDOM();

// Clipboard mock
let lastCopiedText = null;
try {
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (text) => {
        lastCopiedText = String(text);
      },
    },
    configurable: true,
  });
} catch {
  // fallback if clipboard already locked
}

// Import web modules
const storeModule = await import("../web/js/store.js");
const groupViewModule = await import("../web/js/views/group.js");

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

function setupMockRoom(roomId = "r_stress_m3") {
  state.inspector = null;
  state.messages = state.messages || {};
  state.messages[roomId] = [];
  state.activity = state.activity || {};
  state.activity[roomId] = newActivity();
  state.botsById = {
    boss: { id: "boss", name: "群主", role: "协调者", emoji: "👑" },
    coder: { id: "coder", name: "执行者", role: "代码专家", emoji: "💻" },
    reviewer: { id: "reviewer", name: "审查者", role: "评审员", emoji: "🔍" },
  };
  state.roomById = state.roomById || {};
  state.roomById[roomId] = {
    room_id: roomId,
    title: "M3 极限压力测试群",
    topic: "对抗性边界测试",
    owner_id: "boss",
    members: ["boss", "coder", "reviewer"],
    context_policy: "shared",
  };
  return roomId;
}

describe("Milestone 3 Adversarial Stress & Edge Cases Test Suite", () => {
  let roomId;
  let view;
  let container;

  beforeEach(() => {
    lastCopiedText = null;
    roomId = setupMockRoom();
    container = document.createElement("div");
    document.body.appendChild(container);
    view = new GroupView(container);
    view.mount(roomId);
  });

  // =========================================================================
  // 1. Viewport Latching Edge Cases
  // =========================================================================
  describe("1. Viewport Latching Edge Cases", () => {
    it("1.1: Rapid scroll thrash (50 alternating transitions) preserves latch state machine invariants", () => {
      const scrollEl = view.el.scroll;
      scrollEl.clientHeight = 600;
      scrollEl.scrollHeight = 2000;

      for (let i = 0; i < 50; i++) {
        if (i % 2 === 0) {
          // Detached mode: user reading 400px above bottom (dist = 400 > 64)
          scrollEl.scrollTop = 1000;
          view.onScroll();
          assert.strictEqual(view.isLatched, false, `Iteration ${i}: should be detached`);
          assert.strictEqual(view.el.btnScrollBottom.hidden, false, `Iteration ${i}: scroll button visible`);
        } else {
          // Latched mode: user scrolled near bottom (dist = 20 <= 64)
          scrollEl.scrollTop = 1380;
          view.onScroll();
          assert.strictEqual(view.isLatched, true, `Iteration ${i}: should be latched`);
          assert.strictEqual(view.el.btnScrollBottom.hidden, true, `Iteration ${i}: scroll button hidden`);
          assert.strictEqual(view.unreadCount, 0, `Iteration ${i}: unread count reset to 0`);
        }
      }
    });

    it("1.2: Content expanding while detached accumulates exact unread count without jump or premature latching", () => {
      const scrollEl = view.el.scroll;
      scrollEl.clientHeight = 600;
      scrollEl.scrollHeight = 1800;
      scrollEl.scrollTop = 800; // dist = 400 > 64 -> detached
      view.onScroll();
      assert.strictEqual(view.isLatched, false);

      // 20 messages stream in one by one while user is reading detached
      for (let m = 1; m <= 20; m++) {
        state.messages[roomId].push({
          id: `m_bulk_${m}`,
          type: "msg",
          speaker: "coder",
          content: `Bulk message chunk ${m}`,
          ts: Date.now(),
        });
        scrollEl.scrollHeight += 120; // content height grows continuously
        view.update();

        assert.strictEqual(view.isLatched, false, `Message ${m}: latch must remain detached`);
        assert.strictEqual(view.unreadCount, m, `Message ${m}: unread count must match exactly`);
        assert.strictEqual(view.el.scrollUnreadBadge.textContent, String(m));
        assert.strictEqual(view.el.scrollUnreadBadge.hidden, false);
      }

      // Clicking #btn-scroll-bottom immediately re-latches and resets unread count
      view.el.btnScrollBottom.dispatchEvent(new Event("click"));
      assert.strictEqual(view.isLatched, true);
      assert.strictEqual(view.unreadCount, 0);
      assert.strictEqual(view.el.btnScrollBottom.hidden, true);
    });

    it("1.3: Strict threshold boundary conditions (dist = 64, 64.01, 63.99, 0, and negative overscroll)", () => {
      const scrollEl = view.el.scroll;
      scrollEl.clientHeight = 500;
      scrollEl.scrollHeight = 2000;

      // dist = 64 -> exactly on boundary -> latched
      scrollEl.scrollTop = 2000 - 500 - 64; // 1436
      view.onScroll();
      assert.strictEqual(view.isLatched, true, "dist === 64 must be latched");

      // dist = 64.01 -> strictly above boundary -> detached
      scrollEl.scrollTop = 2000 - 500 - 64.01;
      view.onScroll();
      assert.strictEqual(view.isLatched, false, "dist === 64.01 must be detached");

      // dist = 63.99 -> strictly below boundary -> latched
      scrollEl.scrollTop = 2000 - 500 - 63.99;
      view.onScroll();
      assert.strictEqual(view.isLatched, true, "dist === 63.99 must be latched");

      // dist = 0 -> at absolute bottom -> latched
      scrollEl.scrollTop = 1500;
      view.onScroll();
      assert.strictEqual(view.isLatched, true, "dist === 0 must be latched");

      // dist = -25 -> iOS / trackpad elastic overscroll -> latched
      scrollEl.scrollTop = 1525;
      view.onScroll();
      assert.strictEqual(view.isLatched, true, "dist < 0 (overscroll) must remain latched");
    });

    it("1.4: Extreme scrollHeight (10,000,000px) calculation stability", () => {
      const scrollEl = view.el.scroll;
      scrollEl.clientHeight = 800;
      scrollEl.scrollHeight = 10000000;
      scrollEl.scrollTop = 9999150; // dist = 50 <= 64

      view.onScroll();
      assert.strictEqual(view.isLatched, true, "Gigantic scrollHeight handles latching cleanly");
      assert.strictEqual(view.el.btnScrollBottom.hidden, true);

      scrollEl.scrollTop = 5000000; // middle
      view.onScroll();
      assert.strictEqual(view.isLatched, false, "Midway scroll marks detached");
      assert.strictEqual(view.el.btnScrollBottom.hidden, false);
    });

    it("1.5: Content expanding while latched maintains latching and leaves unread count at zero", () => {
      const scrollEl = view.el.scroll;
      scrollEl.clientHeight = 600;
      scrollEl.scrollHeight = 1200;
      scrollEl.scrollTop = 600; // dist = 0 <= 64 -> latched
      view.onScroll();
      assert.strictEqual(view.isLatched, true);

      for (let i = 1; i <= 10; i++) {
        state.messages[roomId].push({
          id: `m_latched_${i}`,
          type: "msg",
          speaker: "coder",
          content: `Latched chunk ${i}`,
          ts: Date.now(),
        });
        scrollEl.scrollHeight += 100;
        view.update();

        assert.strictEqual(view.isLatched, true, `Step ${i}: must remain latched`);
        assert.strictEqual(view.unreadCount, 0, `Step ${i}: unread count must remain 0`);
        assert.strictEqual(view.el.btnScrollBottom.hidden, true, `Step ${i}: button stays hidden`);
      }
    });
  });

  // =========================================================================
  // 2. Tool Cards Edge Cases
  // =========================================================================
  describe("2. Tool Cards Edge Cases", () => {
    it("2.1: Tool with huge output (100,000 characters & 3,000 lines) clamps cleanly without memory leak", () => {
      const longOutput = Array.from({ length: 3000 }, (_, i) => `Line ${i + 1}: detailed diagnostic payload data`).join("\n");
      assert.ok(longOutput.length > 100000, `Output length is ${longOutput.length} chars (>100k)`);

      const out = formatToolOutput(longOutput);
      assert.strictEqual(out.isClamped, true, "Huge output must be marked clamped");
      assert.strictEqual(out.lineCount, 3000, "Line count must be accurate");
      assert.strictEqual(out.rawText, longOutput, "Raw text preserved for copy");

      const cardHtml = toolCardHTML({
        id: "tc_huge",
        tool: "bash",
        status: "ok",
        duration: 1250,
        output: longOutput,
      });

      assert.ok(cardHtml.includes("is-clamped"), "Card renders is-clamped box");
      assert.ok(cardHtml.includes("展开完整输出 (3000 行)"), "Toggle button reports correct line count");

      // Verify mounting in feed and toggling clamp state
      state.messages[roomId].push({
        id: "m_huge_tool",
        type: "msg",
        speaker: "coder",
        content: "Here is the long log",
        tools: [{
          id: "tc_huge",
          name: "bash",
          status: "ok",
          output: longOutput,
        }],
      });
      view.update();

      const clampBtn = view.el.inner.querySelector("[data-clamp-toggle]");
      assert.ok(clampBtn, "Clamp button mounted in DOM");
      const box = view.el.inner.querySelector(".tool-output-box");
      assert.ok(box.classList.contains("is-clamped"));

      // Expand output
      clampBtn.dispatchEvent(new Event("click"));
      assert.strictEqual(box.classList.contains("is-clamped"), false, "Box expanded");
      assert.strictEqual(clampBtn.textContent, "收起输出");

      // Re-collapse output
      clampBtn.dispatchEvent(new Event("click"));
      assert.strictEqual(box.classList.contains("is-clamped"), true, "Box re-clamped");
      assert.ok(clampBtn.textContent.includes("展开完整输出"));
    });

    it("2.2: Tool without duration or invalid duration (null, undefined, 0, -50, NaN, Infinity) returns empty string without crashing", () => {
      assert.strictEqual(formatDuration(null), "");
      assert.strictEqual(formatDuration(undefined), "");
      assert.strictEqual(formatDuration(0), "");
      assert.strictEqual(formatDuration(-50), "");
      assert.strictEqual(formatDuration(NaN), "");
      assert.strictEqual(formatDuration(Infinity), "");
      assert.strictEqual(formatDuration("invalid_string"), "");
      assert.strictEqual(formatDuration(""), "");

      // Valid values format cleanly
      assert.strictEqual(formatDuration(45), "45ms");
      assert.strictEqual(formatDuration(999), "999ms");
      assert.strictEqual(formatDuration(1000), "1.0s");
      assert.strictEqual(formatDuration(2450), "2.5s");

      // Tool card renders without duration pill when duration is missing or zero
      const cardWithoutDuration = toolCardHTML({
        id: "tc_no_dur",
        tool: "read_file",
        status: "ok",
        duration: null,
      });
      assert.strictEqual(cardWithoutDuration.includes("tool-duration-pill"), false);
    });

    it("2.3: Tool without output or empty params handles null, undefined, and non-scalar values safely", () => {
      // Empty / missing output
      const outNull = formatToolOutput(null);
      assert.strictEqual(outNull.isClamped, false);
      assert.ok(outNull.html.includes("无返回内容"));

      const outUndef = formatToolOutput(undefined);
      assert.strictEqual(outUndef.isClamped, false);

      const outEmpty = formatToolOutput("");
      assert.strictEqual(outEmpty.isClamped, false);

      // Empty / missing params
      assert.ok(formatToolParams(null).includes("无参数"));
      assert.ok(formatToolParams(undefined).includes("无参数"));
      assert.ok(formatToolParams({}).includes("无参数"));

      // JSON string parameter formatting
      const jsonParam = formatToolParams('{"query":"SELECT * FROM users","limit":10}');
      assert.ok(jsonParam.includes("query:") && jsonParam.includes("limit:"));

      // Malformed JSON string fallback
      const brokenJson = formatToolParams('{"broken: json');
      assert.ok(brokenJson.includes("tool-code-block"));
    });

    it("2.4: Concurrent tools running simultaneously for the same bot: out-of-order resolution by call_id", () => {
      const act = state.activity[roomId];

      // 1. Bot starts turn
      applyEvent({
        topic: "worker.coder.turn_started",
        thread_id: `room:${roomId}`,
        payload: {},
      });

      // 2. Invoke 3 tools concurrently
      applyEvent({
        topic: "worker.coder.tool_invoked",
        thread_id: `room:${roomId}`,
        payload: { call_id: "call_01", tool: "read_file", args: { path: "a.js" } },
      });
      applyEvent({
        topic: "worker.coder.tool_invoked",
        thread_id: `room:${roomId}`,
        payload: { call_id: "call_02", tool: "grep_search", args: { query: "export" } },
      });
      applyEvent({
        topic: "worker.coder.tool_invoked",
        thread_id: `room:${roomId}`,
        payload: { call_id: "call_03", tool: "bash", args: { cmd: "npm test" } },
      });

      const runningList = act.turnTools.get("coder");
      assert.strictEqual(runningList.length, 3, "All 3 tools registered in turnTools");

      // 3. Complete call_02 FIRST (out of order), then call_03, then call_01
      applyEvent({
        topic: "worker.coder.tool_result",
        thread_id: `room:${roomId}`,
        payload: { call_id: "call_02", tool: "grep_search", ok: true, ms: 140, summary: "Found 12 matches" },
      });
      applyEvent({
        topic: "worker.coder.tool_result",
        thread_id: `room:${roomId}`,
        payload: { call_id: "call_03", tool: "bash", ok: false, ms: 900, summary: "Test failed" },
      });
      applyEvent({
        topic: "worker.coder.tool_result",
        thread_id: `room:${roomId}`,
        payload: { call_id: "call_01", tool: "read_file", ok: true, ms: 35, summary: "File content 10 lines" },
      });

      // Verify each item resolved accurately by call_id
      const tool1 = runningList.find((t) => t.id === "call_01");
      const tool2 = runningList.find((t) => t.id === "call_02");
      const tool3 = runningList.find((t) => t.id === "call_03");

      assert.strictEqual(tool1.status, "ok");
      assert.strictEqual(tool1.output, "File content 10 lines");
      assert.strictEqual(tool2.status, "ok");
      assert.strictEqual(tool2.output, "Found 12 matches");
      assert.strictEqual(tool3.status, "error");
      assert.strictEqual(tool3.ok, false);
      assert.strictEqual(tool3.output, "Test failed");

      // 4. On turn completion message, all 3 tools are preserved on message
      applyEvent({
        topic: `room.${roomId}.turn_completed`,
        payload: {
          speaker: "coder",
          content: "Analysis completed.",
          seq: 42,
        },
      });

      const msgs = state.messages[roomId];
      const lastMsg = msgs[msgs.length - 1];
      assert.ok(lastMsg, "Message created on turn_completed");
      assert.strictEqual(lastMsg.tools.length, 3, "All 3 tools attached to message on turn completion");
      assert.strictEqual(lastMsg.tools[0].id, "call_01");
      assert.strictEqual(lastMsg.tools[1].id, "call_02");
      assert.strictEqual(lastMsg.tools[2].id, "call_03");
    });

    it("2.5: Failed or running tool defaults to auto-expanded, successful tool defaults to collapsed", () => {
      const okCard = toolCardHTML({
        id: "t_ok",
        tool: "read_file",
        status: "ok",
        output: "content",
      });
      assert.strictEqual(okCard.includes("is-expanded"), false, "Successful tool is collapsed by default");
      assert.ok(okCard.includes('hidden'), "Card body is hidden");

      const errCard = toolCardHTML({
        id: "t_err",
        tool: "bash",
        status: "error",
        output: "command failed",
      });
      assert.ok(errCard.includes("is-expanded"), "Error tool is expanded by default");
      assert.ok(errCard.includes("is-error"), "Error indicator rendered");

      const runningCard = toolCardHTML({
        id: "t_run",
        tool: "bash",
        status: "running",
      });
      assert.ok(runningCard.includes("is-expanded"), "Running tool is expanded by default");
      assert.ok(runningCard.includes("tool-spinner"), "Running tool displays spinner");
    });
  });

  // =========================================================================
  // 3. Evidence Badges Edge Cases
  // =========================================================================
  describe("3. Evidence Badges Edge Cases", () => {
    it("3.1: Missing or invalid sequence / claim links render safely without breaking DOM attributes", () => {
      // Null item
      const badge1 = evidenceBadgeHTML("observed", null, roomId);
      assert.ok(badge1.includes('data-seq=""'));

      // Empty item
      const badge2 = evidenceBadgeHTML("observed", {}, roomId);
      assert.ok(badge2.includes('data-seq=""'));

      // String seq
      const badge3 = evidenceBadgeHTML("observed", { messageSeq: "105" }, roomId);
      assert.ok(badge3.includes('data-seq="105"'));

      // Undefined or unknown status returns empty string
      assert.strictEqual(evidenceBadgeHTML("non_existent_status", { messageSeq: 1 }, roomId), "");
      assert.strictEqual(evidenceBadgeHTML(null, { messageSeq: 1 }, roomId), "");
      assert.strictEqual(evidenceBadgeHTML(undefined, { messageSeq: 1 }, roomId), "");
    });

    it("3.2: Mismatch badge clicked in a message without tool cards does not throw and opens inspector evidence tab", () => {
      let inspectorEventDetail = null;
      const onInspector = (ev) => {
        inspectorEventDetail = ev.detail;
      };
      document.addEventListener("ah:inspector", onInspector);

      state.messages[roomId].push({
        id: "m_mismatch_notool",
        type: "msg",
        speaker: "coder",
        content: "I claimed something ungrounded.",
        evidence: "mismatch",
        messageSeq: 99,
        tools: [], // No tools in this message
      });
      view.update();

      const mismatchBtn = view.el.inner.querySelector('[data-ev-badge="mismatch"]');
      assert.ok(mismatchBtn, "Mismatch badge rendered");

      // Clicking badge should safely navigate to inspector evidence tab without throwing
      assert.doesNotThrow(() => {
        mismatchBtn.dispatchEvent(new Event("click"));
      });

      assert.strictEqual(state.inspector?.type, "group");
      assert.strictEqual(state.inspector?.tab, "evidence");
      assert.strictEqual(state.inspector?.seq, 99);
      assert.strictEqual(inspectorEventDetail?.seq, 99);

      document.removeEventListener("ah:inspector", onInspector);
    });

    it("3.3: Interactive evidence badge expands and highlights multiple linked tool cards in the message", () => {
      state.messages[roomId].push({
        id: "m_evidence_tools",
        type: "msg",
        speaker: "coder",
        content: "Result with tools.",
        evidence: "observed",
        messageSeq: 101,
        tools: [
          { id: "t_ev_1", name: "tool_1", status: "ok" },
          { id: "t_ev_2", name: "tool_2", status: "ok" },
        ],
      });
      view.update();

      const badge = view.el.inner.querySelector('[data-ev-badge="observed"]');
      assert.ok(badge);

      const cards = view.el.inner.querySelectorAll(".tool-card");
      assert.strictEqual(cards.length, 2);

      // Initially collapsed
      assert.strictEqual(cards[0].classList.contains("is-expanded"), false);
      assert.strictEqual(cards[1].classList.contains("is-expanded"), false);

      // Click badge
      badge.dispatchEvent(new Event("click"));

      // Both tool cards should now be expanded and highlighted
      assert.strictEqual(cards[0].classList.contains("is-expanded"), true);
      assert.strictEqual(cards[0].classList.contains("is-highlighted"), true);
      assert.strictEqual(cards[1].classList.contains("is-expanded"), true);
      assert.strictEqual(cards[1].classList.contains("is-highlighted"), true);
    });

    it("3.4: Sequential clicks across different evidence badges update state.inspector.seq dynamically", () => {
      state.messages[roomId].push(
        { id: "m_seq_1", type: "msg", speaker: "coder", content: "Claim 1", evidence: "observed", messageSeq: 11 },
        { id: "m_seq_2", type: "msg", speaker: "reviewer", content: "Claim 2", evidence: "prepared", messageSeq: 22 },
        { id: "m_seq_3", type: "msg", speaker: "coder", content: "Claim 3", evidence: "mismatch", messageSeq: 33 }
      );
      view.update();

      const badges = view.el.inner.querySelectorAll(".ev-badge.is-interactive");
      assert.strictEqual(badges.length, 3);

      // Click badge 1
      badges[0].dispatchEvent(new Event("click"));
      assert.strictEqual(state.inspector?.tab, "evidence");
      assert.strictEqual(state.inspector?.seq, 11);

      // Click badge 2
      badges[1].dispatchEvent(new Event("click"));
      assert.strictEqual(state.inspector?.tab, "evidence");
      assert.strictEqual(state.inspector?.seq, 22);

      // Click badge 3
      badges[2].dispatchEvent(new Event("click"));
      assert.strictEqual(state.inspector?.tab, "evidence");
      assert.strictEqual(state.inspector?.seq, 33);
    });
  });

  // =========================================================================
  // 4. Composer Dock Edge Cases
  // =========================================================================
  describe("4. Composer Dock Edge Cases", () => {
    it("4.1: Rapid input cycling (100 transitions) keeps textarea height bounded within [40px, 160px]", () => {
      const input = view.el.input;

      for (let i = 0; i < 100; i++) {
        if (i % 3 === 0) {
          // Empty input
          input.value = "";
          input.scrollHeight = 20;
          view.autosize();
          assert.strictEqual(input.style.height, "40px", `Step ${i}: empty input floor must be 40px`);
          assert.strictEqual(view.el.send.disabled, true, `Step ${i}: empty input must disable send`);
        } else if (i % 3 === 1) {
          // Normal 2-line input
          input.value = "Hello world\nSecond line";
          input.scrollHeight = 68;
          view.autosize();
          assert.strictEqual(input.style.height, "68px", `Step ${i}: 2 lines must expand to scrollHeight`);
          assert.strictEqual(view.el.send.disabled, false, `Step ${i}: non-empty input enables send`);
        } else {
          // Massive 20-line input exceeding 160px ceiling
          input.value = Array.from({ length: 20 }, (_, idx) => `Long paragraph line ${idx}`).join("\n");
          input.scrollHeight = 320;
          view.autosize();
          assert.strictEqual(input.style.height, "160px", `Step ${i}: tall input ceiling must be clamped to 160px`);
          assert.strictEqual(input.style.overflowY, "auto", `Step ${i}: clamped input enables vertical scroll`);
          assert.strictEqual(view.el.send.disabled, false);
        }
      }
    });

    it("4.2: Mention matcher handling for Chinese, ASCII, and challenging non-CJK scripts", () => {
      const input = view.el.input;

      // 1. Chinese mention query: @群主
      input.value = "请 @群主";
      input.selectionStart = input.selectionEnd = input.value.length;
      view.updateMentions();
      assert.strictEqual(view.el.mentions.hidden, false, "Chinese mention query displays popover");
      assert.ok(view.mentionMatches.some((m) => m.id === "boss" || m.name === "群主"));

      // 2. ASCII ID query: @code
      input.value = "任务交由 @code";
      input.selectionStart = input.selectionEnd = input.value.length;
      view.updateMentions();
      assert.strictEqual(view.el.mentions.hidden, false, "ASCII mention query displays popover");
      assert.ok(view.mentionMatches.some((m) => m.id === "coder"));

      // 3. Unknown query: @unknown_non_existent
      input.value = "测试 @xyz999";
      input.selectionStart = input.selectionEnd = input.value.length;
      view.updateMentions();
      assert.strictEqual(view.el.mentions.hidden, true, "No matches hides popover");

      // 4. Trailing space cancels mention query: @boss 
      input.value = "测试 @boss ";
      input.selectionStart = input.selectionEnd = input.value.length;
      view.updateMentions();
      assert.strictEqual(view.el.mentions.hidden, true, "Trailing space does not open mentions popover");
    });

    it("4.3: Empty attachments and adding/removing attachment chips synchronizes send button", () => {
      const input = view.el.input;
      input.value = "";
      view.syncSendButtonState();
      assert.strictEqual(view.el.send.disabled, true, "Initial empty input disables send button");

      // Add 2 attachments
      view.pendingAttachments.push(
        { id: "att_1", name: "spec.pdf", size: 1024 },
        { id: "att_2", name: "arch.png", size: 2048 }
      );
      view.renderAttachments();
      view.syncSendButtonState();

      assert.strictEqual(view.el.attachments.hidden, false, "Attachments container visible");
      assert.strictEqual(view.pendingAttachments.length, 2);
      assert.strictEqual(view.el.send.disabled, false, "Attachments enable send button even when input text is empty");

      // Remove att_1
      const removeBtn1 = view.el.attachments.querySelector('[data-remove-id="att_1"]');
      assert.ok(removeBtn1);
      removeBtn1.dispatchEvent(new Event("click"));

      assert.strictEqual(view.pendingAttachments.length, 1);
      assert.strictEqual(view.pendingAttachments[0].id, "att_2");
      assert.strictEqual(view.el.send.disabled, false);

      // Remove att_2 (pending attachments becomes empty)
      const removeBtn2 = view.el.attachments.querySelector('[data-remove-id="att_2"]');
      assert.ok(removeBtn2);
      removeBtn2.dispatchEvent(new Event("click"));

      assert.strictEqual(view.pendingAttachments.length, 0);
      assert.strictEqual(view.el.attachments.hidden, true, "Container hides when empty");
      assert.strictEqual(view.el.send.disabled, true, "Send button disables again when both text and attachments are empty");
    });

    it("4.4: Submitting while generating: send button morphs to stop button, clicking it aborts round", () => {
      // 1. Simulate active generation round
      state.activity[roomId].round = true;
      state.activity[roomId].typing.add("coder");
      view.syncSendButtonState();

      assert.strictEqual(view.el.send.classList.contains("is-stop"), true, "Send button transforms to stop button");
      assert.strictEqual(view.el.send.title, "停止生成");
      assert.strictEqual(view.el.send.disabled, false, "Stop button is clickable");

      // 2. Clicking the button stops generation
      view.el.send.dispatchEvent(new Event("click"));

      assert.strictEqual(state.activity[roomId].round, false, "Round stopped");
      assert.strictEqual(state.activity[roomId].typing.size, 0, "Typing cleared");
      assert.strictEqual(view.el.send.classList.contains("is-stop"), false, "Reverts to standard send button");
    });

    it("4.5: Keyboard Enter submission vs Shift+Enter newline vs whitespace-only rejection", async () => {
      const input = view.el.input;

      // 1. Whitespace only + Enter does not submit
      input.value = "   \n\t   ";
      const initialCount = (state.messages[roomId] || []).length;
      input.dispatchEvent(new Event("keydown", { key: "Enter" }));
      assert.strictEqual((state.messages[roomId] || []).length, initialCount, "Whitespace-only input does not submit");

      // 2. Shift+Enter does not submit
      input.value = "First line";
      input.dispatchEvent(new Event("keydown", { key: "Enter", shiftKey: true }));
      assert.strictEqual((state.messages[roomId] || []).length, initialCount, "Shift+Enter does not submit");

      // 3. Normal Enter synchronously clears textarea, resets height to 40px, and prevents default
      input.value = "Valid user request";
      let prevented = false;
      const enterEvent = Object.assign(new Event("keydown"), {
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        preventDefault: () => { prevented = true; },
      });

      input.dispatchEvent(enterEvent);
      assert.strictEqual(prevented, true, "Enter calls preventDefault()");
      assert.strictEqual(input.value, "", "Textarea cleared synchronously on submit");
      assert.strictEqual(input.style.height, "40px", "Textarea height reset to 40px");
    });

    it("4.6: Adversarial linguistic boundary: non-CJK foreign scripts (Kana, Hangul, Cyrillic, Emoji) do not match mention regex", () => {
      const input = view.el.input;

      // Japanese Hiragana: @ひらがな
      input.value = "请教 @ひらがな";
      input.selectionStart = input.selectionEnd = input.value.length;
      view.updateMentions();
      assert.strictEqual(view.el.mentions.hidden, true, "Hiragana outside [\\u4e00-\\u9fa5] does not trigger popover");

      // Cyrillic: @разработчик
      input.value = "Привет @разработчик";
      input.selectionStart = input.selectionEnd = input.value.length;
      view.updateMentions();
      assert.strictEqual(view.el.mentions.hidden, true, "Cyrillic does not trigger popover");

      // Emoji: @🤖
      input.value = "召唤 @🤖";
      input.selectionStart = input.selectionEnd = input.value.length;
      view.updateMentions();
      assert.strictEqual(view.el.mentions.hidden, true, "Emoji does not trigger popover");
    });

    it("4.7: Adversarial concurrency: Enter key while generating triggers submit() branch", () => {
      // When round is generating:
      state.activity[roomId].round = true;
      view.syncSendButtonState();
      assert.strictEqual(view.el.send.classList.contains("is-stop"), true);

      // Verify that pressing Enter key triggers submit() and clears input
      view.el.input.value = "Interruptive prompt";
      let prevented = false;
      const enterEvent = Object.assign(new Event("keydown"), {
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        preventDefault: () => { prevented = true; },
      });

      view.el.input.dispatchEvent(enterEvent);
      assert.strictEqual(prevented, true);
      assert.strictEqual(view.el.input.value, "", "Enter cleared input");
    });
  });
});
