/**
 * agent_for_myself/tests/challenger_m3_composer_stress.test.mjs
 *
 * Empirical Challenger Stress Harness for Milestone 3 (Composer & Tools):
 * - Dynamic auto-sizing textarea stress: rapid expansion and contraction across 1 to 20 lines,
 *   verifying strict clamp between 40px and 160px under randomized and boundary workloads.
 * - Mention engine stress: rapid typing with Unicode chars (@群主, @开发, @审查, mixed English/Chinese),
 *   verifying popover matches, arrow key cycling, Tab/Enter auto-completion, and Escape cancellation.
 * - Attachment lifecycle stress: rapid adding of multiple files (10 files), removing selective chips,
 *   verifying send button enablement even when text is empty.
 * - Stop generation cycle thrashing: rapidly toggling state.activity[roomId].round on and off,
 *   verifying .is-stop class synchronization, button title/icon transitions, and click-to-stop event handling.
 *
 * Environment: Node >= 22.19.0, pure ESM, ZERO external npm dependencies.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import events from "node:events";

// 1. Setup Headless DOM Harness
const { setupHeadlessDOM } = await import("./_helpers/headless_dom.mjs");
const domHarness = setupHeadlessDOM();

// Increase max listeners on document to avoid mock event emitter warnings during stress
try {
  events.setMaxListeners(100, document);
} catch {
  // Ignore if not supported
}

// 2. Import application modules under test
const storeModule = await import("../web/js/store.js");
const groupViewModule = await import("../web/js/views/group.js");
const apiModule = await import("../web/js/api.js");

const {
  state,
  newActivity,
  sendRoomMessage,
} = storeModule;

const {
  GroupView,
} = groupViewModule;

const { api } = apiModule;

describe("Challenger M3 Composer & Tool Invocations Stress Suite", () => {
  let root;
  let view;
  const testRoomId = "room_composer_stress_m3";
  let sentMessages = [];
  let originalApiSay;

  function resetRoomState(roomId = testRoomId) {
    state.inspector = null;
    state.evidence = {};
    state.files = {};
    state.messages = {};
    state.activity = {};

    state.roomById[roomId] = {
      room_id: roomId,
      title: "M3 极速输入坞压力测试群",
      topic: "Composer & Tool Invocations Stress",
      context_policy: "shared",
      owner_id: "boss",
      members: ["boss", "coder", "reviewer", "librarian"],
    };

    state.botsById = {
      boss: { id: "boss", name: "Boss", role: "群主", badge: "群主", emoji: "👑" },
      coder: { id: "coder", name: "Coder", role: "开发专家", badge: "开发", emoji: "💻" },
      reviewer: { id: "reviewer", name: "Reviewer", role: "代码审查", badge: "审查", emoji: "🔍" },
      librarian: { id: "librarian", name: "Librarian", role: "资料管家", badge: "资料", emoji: "📚" },
    };

    state.rooms = [state.roomById[roomId]];
    state.messages[roomId] = [];
    state.activity[roomId] = newActivity(roomId);
  }

  beforeEach(() => {
    sentMessages = [];
    originalApiSay = api.say;
    api.say = async (roomId, text) => {
      sentMessages.push({ roomId, text });
      return { status: "accepted", room_id: roomId };
    };

    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById("app");
    resetRoomState(testRoomId);

    view = new GroupView(root);
    view.mount(testRoomId);
  });

  afterEach(() => {
    api.say = originalApiSay;
    if (view && typeof view.destroy === "function") {
      view.destroy();
    }
  });

  // =========================================================================
  // Suite 1: Dynamic Auto-Sizing Textarea Stress Harness
  // =========================================================================
  describe("Suite 1: Dynamic Auto-Sizing Textarea Stress Harness", () => {
    it("1.1: Linear dynamic expansion from 1 line to 20 lines strictly clamps height within [40px, 160px]", () => {
      for (let lines = 1; lines <= 20; lines++) {
        const text = Array.from({ length: lines }, (_, i) => `Line ${i + 1}`).join("\n");
        view.el.input.value = text;
        const simulatedScrollHeight = 20 + lines * 20; // 40px at 1 line, up to 420px at 20 lines
        view.el.input.scrollHeight = simulatedScrollHeight;
        view.autosize();

        const currentHeight = parseInt(view.el.input.style.height, 10);
        assert.ok(
          currentHeight >= 40,
          `At ${lines} lines, height ${currentHeight}px must be >= 40px`
        );
        assert.ok(
          currentHeight <= 160,
          `At ${lines} lines, height ${currentHeight}px must be <= 160px`
        );

        if (simulatedScrollHeight > 160) {
          assert.equal(
            view.el.input.style.height,
            "160px",
            `At ${lines} lines (scrollHeight ${simulatedScrollHeight}px), height must clamp to 160px`
          );
          assert.equal(
            view.el.input.style.overflowY,
            "auto",
            `At ${lines} lines, overflowY must be 'auto'`
          );
        } else {
          assert.equal(
            view.el.input.style.height,
            `${simulatedScrollHeight}px`,
            `At ${lines} lines, height must match scrollHeight ${simulatedScrollHeight}px`
          );
          assert.equal(
            view.el.input.style.overflowY,
            "hidden",
            `At ${lines} lines, overflowY must be 'hidden'`
          );
        }
      }
    });

    it("1.2: Dynamic contraction from 20 lines down to 0 lines smoothly shrinks back to 40px", () => {
      for (let lines = 20; lines >= 0; lines--) {
        const text = lines === 0 ? "" : Array.from({ length: lines }, (_, i) => `Row ${i + 1}`).join("\n");
        view.el.input.value = text;
        const simulatedScrollHeight = lines === 0 ? 40 : 20 + lines * 20;
        view.el.input.scrollHeight = simulatedScrollHeight;
        view.autosize();

        const currentHeight = parseInt(view.el.input.style.height, 10);
        assert.ok(currentHeight >= 40 && currentHeight <= 160, `Height ${currentHeight}px out of bounds`);

        if (lines === 0 || lines === 1) {
          assert.equal(view.el.input.style.height, "40px", "Empty or 1 line must be 40px");
          assert.equal(view.el.input.style.overflowY, "hidden", "Empty or 1 line must hide overflow");
        }
      }
    });

    it("1.3: Boundary conditions: 0 lines, sub-min scrollHeight, exact 160px, 161px overflow, and massive input", () => {
      // Sub-minimum scrollHeight (< 40)
      view.el.input.value = "tiny";
      view.el.input.scrollHeight = 12;
      view.autosize();
      assert.equal(view.el.input.style.height, "40px", "Sub-min scrollHeight must clamp to 40px floor");
      assert.equal(view.el.input.style.overflowY, "hidden");

      // Exact clamp threshold: 160px
      view.el.input.value = "exact threshold\n".repeat(6);
      view.el.input.scrollHeight = 160;
      view.autosize();
      assert.equal(view.el.input.style.height, "160px", "Exact 160px scrollHeight must be 160px");
      assert.equal(view.el.input.style.overflowY, "hidden", "Exact 160px must keep overflowY hidden");

      // 1px above clamp threshold: 161px
      view.el.input.scrollHeight = 161;
      view.autosize();
      assert.equal(view.el.input.style.height, "160px", "161px scrollHeight must clamp to 160px");
      assert.equal(view.el.input.style.overflowY, "auto", "161px must switch overflowY to auto");

      // Massive input: 2000px scrollHeight
      view.el.input.value = "massive paragraph\n".repeat(100);
      view.el.input.scrollHeight = 2000;
      view.autosize();
      assert.equal(view.el.input.style.height, "160px", "2000px scrollHeight must clamp to 160px");
      assert.equal(view.el.input.style.overflowY, "auto");
    });

    it("1.4: Whitespace-only stress collapses height to 40px and disables send button", () => {
      const whitespaceSamples = [
        "   ",
        "\t\t\t",
        "\n\n\n\n\n",
        "  \t\n \r\n  ",
        " \u3000\u00A0 ",
      ];

      for (const sample of whitespaceSamples) {
        view.el.input.value = sample;
        view.el.input.scrollHeight = 300; // Simulated large scrollHeight
        view.autosize();

        assert.equal(view.el.input.style.height, "40px", `Whitespace sample should collapse to 40px: ${JSON.stringify(sample)}`);
        assert.equal(view.el.input.style.overflowY, "hidden");
        assert.equal(view.el.send.disabled, true, "Send button must remain disabled for whitespace-only");
      }
    });

    it("1.5: 200 random line count jumps stress harness verifies invariant clamp [40px, 160px]", () => {
      for (let i = 0; i < 200; i++) {
        const lineCount = Math.floor(Math.random() * 50); // 0 to 49 lines
        const text = lineCount === 0 ? "" : Array.from({ length: lineCount }, (_, idx) => `Text ${idx}`).join("\n");
        const simulatedScrollHeight = lineCount === 0 ? 0 : Math.floor(Math.random() * 500);

        view.el.input.value = text;
        view.el.input.scrollHeight = simulatedScrollHeight;
        view.autosize();

        const h = parseInt(view.el.input.style.height, 10);
        assert.ok(h >= 40, `Cycle ${i}: height ${h}px is less than 40px`);
        assert.ok(h <= 160, `Cycle ${i}: height ${h}px is greater than 160px`);

        if (!text.trim()) {
          assert.equal(view.el.input.style.height, "40px");
          assert.equal(view.el.input.style.overflowY, "hidden");
        } else if (simulatedScrollHeight > 160) {
          assert.equal(view.el.input.style.height, "160px");
          assert.equal(view.el.input.style.overflowY, "auto");
        } else {
          assert.equal(view.el.input.style.height, `${Math.max(40, simulatedScrollHeight)}px`);
          assert.equal(view.el.input.style.overflowY, "hidden");
        }
      }
    });

    it("1.6: Submitting multi-line text resets textarea height to 40px and overflowY to hidden", async () => {
      view.el.input.value = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8";
      view.el.input.scrollHeight = 220;
      view.autosize();

      assert.equal(view.el.input.style.height, "160px");
      assert.equal(view.el.input.style.overflowY, "auto");
      assert.equal(view.el.send.disabled, false);

      await view.submit();

      assert.equal(view.el.input.value, "", "Input value cleared after submit");
      assert.equal(view.el.input.style.height, "40px", "Height reset to 40px after submit");
      assert.equal(view.el.input.style.overflowY, "hidden", "Overflow reset to hidden after submit");
      assert.equal(sentMessages.length, 1, "Message sent via API");
    });
  });

  // =========================================================================
  // Suite 2: Unicode Mention Engine Stress & Navigation
  // =========================================================================
  describe("Suite 2: Unicode Mention Engine Stress & Navigation", () => {
    it("2.1: Typing '@' opens popover containing all members and candidate bots", () => {
      view.el.input.value = "@";
      view.el.input.selectionStart = 1;
      view.updateMentions();

      assert.equal(view.el.mentions.hidden, false, "Mentions popover displayed");
      const items = view.el.mentions.querySelectorAll(".mention-item");
      assert.equal(items.length, 4, "Should display all 4 available bots");
      assert.equal(items[0].classList.contains("is-active"), true, "First item active by default");
    });

    it("2.2: Unicode matching by role and badge: @群主, @开发, @审查, @资料", () => {
      const testCases = [
        { query: "@群主", expectedBot: "boss" },
        { query: "@开发", expectedBot: "coder" },
        { query: "@审查", expectedBot: "reviewer" },
        { query: "@资料", expectedBot: "librarian" },
        { query: "@管家", expectedBot: "librarian" },
      ];

      for (const tc of testCases) {
        view.el.input.value = tc.query;
        view.el.input.selectionStart = tc.query.length;
        view.updateMentions();

        assert.equal(view.el.mentions.hidden, false, `Popover should be visible for ${tc.query}`);
        const items = view.el.mentions.querySelectorAll(".mention-item");
        assert.ok(items.length >= 1, `Must find match for ${tc.query}`);
        assert.equal(
          items[0].dataset.mention,
          tc.expectedBot,
          `${tc.query} must match bot ${tc.expectedBot}`
        );
      }
    });

    it("2.3: Case-insensitive English and mixed alphanumeric matching: @code, @Coder, @boss, @Reviewer", () => {
      const testCases = [
        { input: "请 @code 帮忙查看", expectedBot: "coder" },
        { input: "请 @Coder 帮忙查看", expectedBot: "coder" },
        { input: "抄送 @boss", expectedBot: "boss" },
        { input: "找 @Reviewer 审查代码", expectedBot: "reviewer" },
      ];

      for (const tc of testCases) {
        view.el.input.value = tc.input;
        // Position caret immediately after the mention token
        const match = tc.input.match(/@[A-Za-z0-9_]+/);
        const caret = match.index + match[0].length;
        view.el.input.selectionStart = caret;
        view.updateMentions();

        assert.equal(view.el.mentions.hidden, false, `Popover should be open for '${tc.input}' at caret ${caret}`);
        const items = view.el.mentions.querySelectorAll(".mention-item");
        assert.ok(items.length >= 1, `Items found for ${tc.input}`);
        assert.equal(items[0].dataset.mention, tc.expectedBot);
      }
    });

    it("2.4: Mixed text context with multiple @ mentions accurately isolates the current caret token", () => {
      // First mention token in progress: @boss
      view.el.input.value = "任务已分派给 @boss，请 @开发 协同";
      // Position caret right after @boss (length 11)
      view.el.input.selectionStart = 11;
      view.updateMentions();
      assert.equal(view.el.mentions.hidden, false);
      let items = view.el.mentions.querySelectorAll(".mention-item");
      assert.equal(items[0].dataset.mention, "boss");

      // Position caret at the end of the text right after @开发
      view.el.input.selectionStart = view.el.input.value.indexOf("@开发") + 3;
      view.updateMentions();
      assert.equal(view.el.mentions.hidden, false);
      items = view.el.mentions.querySelectorAll(".mention-item");
      assert.equal(items[0].dataset.mention, "coder");
    });

    it("2.5: Non-existent query closes popover", () => {
      view.el.input.value = "联系 @未知机器人_xyz999";
      view.el.input.selectionStart = view.el.input.value.length;
      view.updateMentions();

      assert.equal(view.el.mentions.hidden, true, "Popover must hide when no bot matches");
    });

    it("2.6: Arrow key cycling stress: 100 rapid ArrowDown and ArrowUp events maintain strict bounds and single active item", () => {
      view.el.input.value = "@";
      view.el.input.selectionStart = 1;
      view.updateMentions();

      const totalMatches = view.mentionMatches.length;
      assert.equal(totalMatches, 4);

      // Hammer 50 ArrowDown events
      for (let i = 0; i < 50; i++) {
        view.handleMentionKey({ key: "ArrowDown", preventDefault: () => {} });
        const expectedIndex = (i + 1) % totalMatches;
        assert.equal(view.mentionIndex, expectedIndex, `ArrowDown step ${i + 1} index mismatch`);

        const items = view.el.mentions.querySelectorAll(".mention-item");
        const activeItems = Array.from(items).filter((el) => el.classList.contains("is-active"));
        assert.equal(activeItems.length, 1, "Exactly one item must be active");
        assert.equal(items[expectedIndex].classList.contains("is-active"), true);
      }

      // Hammer 50 ArrowUp events
      for (let i = 0; i < 50; i++) {
        const prevIndex = view.mentionIndex;
        view.handleMentionKey({ key: "ArrowUp", preventDefault: () => {} });
        const expectedIndex = (prevIndex - 1 + totalMatches) % totalMatches;
        assert.equal(view.mentionIndex, expectedIndex, `ArrowUp step ${i + 1} index mismatch`);

        const items = view.el.mentions.querySelectorAll(".mention-item");
        const activeItems = Array.from(items).filter((el) => el.classList.contains("is-active"));
        assert.equal(activeItems.length, 1, "Exactly one item must be active");
        assert.equal(items[expectedIndex].classList.contains("is-active"), true);
      }
    });

    it("2.7: Auto-completion via Tab key inserts @BotId with trailing space, closes popover, and updates caret", () => {
      view.el.input.value = "需求确认：请 @开";
      view.el.input.selectionStart = view.el.input.value.length;
      view.updateMentions();

      assert.equal(view.el.mentions.hidden, false);
      let prevented = false;
      const handled = view.handleMentionKey({
        key: "Tab",
        preventDefault: () => { prevented = true; },
      });

      assert.equal(handled, true);
      assert.equal(prevented, true, "Tab key calls preventDefault()");
      assert.equal(view.el.mentions.hidden, true, "Popover closed");
      assert.equal(view.el.input.value, "需求确认：请 @coder ", "Mention completed with trailing space");
      assert.equal(view.el.input.selectionStart, "需求确认：请 @coder ".length, "Caret placed after space");
    });

    it("2.8: Auto-completion via Enter key completes mention without triggering message submit", async () => {
      view.el.input.value = "任务下达 @审";
      view.el.input.selectionStart = view.el.input.value.length;
      view.updateMentions();

      assert.equal(view.el.mentions.hidden, false);

      let prevented = false;
      const enterEvent = Object.assign(new Event("keydown"), {
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        preventDefault: () => { prevented = true; },
      });

      view.el.input.dispatchEvent(enterEvent);

      assert.equal(prevented, true, "Enter calls preventDefault on mention completion");
      assert.equal(view.el.mentions.hidden, true, "Popover hidden");
      assert.equal(view.el.input.value, "任务下达 @reviewer ", "Mention auto-completed");
      assert.equal(sentMessages.length, 0, "Must NOT have submitted the message");
    });

    it("2.9: Escape key cancellation dismisses popover immediately and preserves typed text", () => {
      const originalText = "保留原始文本 @审查";
      view.el.input.value = originalText;
      view.el.input.selectionStart = originalText.length;
      view.updateMentions();

      assert.equal(view.el.mentions.hidden, false);

      let prevented = false;
      const escapeEvent = Object.assign(new Event("keydown"), {
        key: "Escape",
        preventDefault: () => { prevented = true; },
      });

      const handled = view.handleMentionKey(escapeEvent);
      assert.equal(handled, true);
      assert.equal(prevented, true);
      assert.equal(view.el.mentions.hidden, true, "Mentions popover dismissed");
      assert.equal(view.el.input.value, originalText, "Text untouched");
    });

    it("2.10: Mid-sentence mention replacement replaces only the mention token and preserves following text", () => {
      view.el.input.value = "请 @rev 尽快完成测试与发布工作";
      // Caret is at index 6, right after @rev
      view.el.input.selectionStart = 6;
      view.updateMentions();

      assert.equal(view.el.mentions.hidden, false);
      view.handleMentionKey({ key: "Tab", preventDefault: () => {} });

      assert.equal(
        view.el.input.value,
        "请 @reviewer  尽快完成测试与发布工作",
        "Mid-sentence mention replaced while preserving trailing text"
      );
    });

    it("2.11: Rapid typing and backspacing simulation: popover narrows, expands, and closes on '@' deletion", () => {
      // 1. Type @
      view.el.input.value = "@";
      view.el.input.selectionStart = 1;
      view.updateMentions();
      assert.equal(view.el.mentions.hidden, false);
      assert.equal(view.mentionMatches.length, 4);

      // 2. Type 开 -> 1 match
      view.el.input.value = "@开";
      view.el.input.selectionStart = 2;
      view.updateMentions();
      assert.equal(view.el.mentions.hidden, false);
      assert.equal(view.mentionMatches.length, 1);
      assert.equal(view.mentionMatches[0].id, "coder");

      // 3. Backspace back to @ -> 4 matches
      view.el.input.value = "@";
      view.el.input.selectionStart = 1;
      view.updateMentions();
      assert.equal(view.el.mentions.hidden, false);
      assert.equal(view.mentionMatches.length, 4);

      // 4. Backspace deleting @ -> empty string -> closed
      view.el.input.value = "";
      view.el.input.selectionStart = 0;
      view.updateMentions();
      assert.equal(view.el.mentions.hidden, true, "Popover closed on empty input");
    });
  });

  // =========================================================================
  // Suite 3: Attachment Lifecycle & Send Button Enablement Stress
  // =========================================================================
  describe("Suite 3: Attachment Lifecycle & Send Button Enablement Stress", () => {
    it("3.1: Batch upload: adding 10 attachments of diverse file types renders 10 distinct chips with badges", () => {
      const files = [
        { name: "index.js", size: 1024 },
        { name: "logo.png", size: 2048 },
        { name: "spec.pdf", size: 4096 },
        { name: "config.json", size: 512 },
        { name: "types.ts", size: 1200 },
        { name: "README.md", size: 800 },
        { name: "archive.zip", size: 65536 },
        { name: "data.csv", size: 3000 },
        { name: "style.css", size: 1500 },
        { name: "page.html", size: 2200 },
      ];

      for (let i = 0; i < files.length; i++) {
        view.pendingAttachments.push({
          id: `att_${i}`,
          name: files[i].name,
          size: files[i].size,
        });
      }

      view.renderAttachments();
      view.syncSendButtonState();

      assert.equal(view.el.attachments.hidden, false, "Attachment bar visible");
      const chips = view.el.attachments.querySelectorAll(".attachment-chip");
      assert.equal(chips.length, 10, "10 attachment chips rendered");

      // Verify each chip has name, badge, and remove button
      chips.forEach((chip, i) => {
        assert.equal(chip.dataset.attId, `att_${i}`);
        assert.ok(chip.querySelector(".attachment-chip-name"), "Chip has name");
        assert.ok(chip.querySelector(".attachment-chip-badge"), "Chip has badge");
        assert.ok(chip.querySelector(".attachment-chip-remove"), "Chip has remove button");
      });
    });

    it("3.2: Send button enablement: 10 attachments enable send button even when textarea text is completely empty", () => {
      view.el.input.value = "";
      view.syncSendButtonState();
      assert.equal(view.el.send.disabled, true, "Initially disabled when empty and no attachments");

      for (let i = 0; i < 10; i++) {
        view.pendingAttachments.push({ id: `att_${i}`, name: `doc_${i}.txt`, size: 100 });
      }
      view.renderAttachments();
      view.syncSendButtonState();

      assert.equal(view.el.send.disabled, false, "Send button MUST be enabled with attachments even if text is empty");
    });

    it("3.3: Selective chip removal: removing head (0), middle (4), and tail (9) updates pending list and DOM cleanly", () => {
      view.pendingAttachments = Array.from({ length: 10 }, (_, i) => ({
        id: `att_sel_${i}`,
        name: `file_${i}.dat`,
      }));
      view.renderAttachments();
      assert.equal(view.el.attachments.querySelectorAll(".attachment-chip").length, 10);

      // 1. Remove middle chip (att_sel_4)
      const midBtn = view.el.attachments.querySelector('[data-remove-id="att_sel_4"]');
      midBtn.click();
      assert.equal(view.pendingAttachments.length, 9);
      assert.ok(!view.pendingAttachments.find((a) => a.id === "att_sel_4"));
      assert.equal(view.el.attachments.querySelectorAll(".attachment-chip").length, 9);

      // 2. Remove head chip (att_sel_0)
      const headBtn = view.el.attachments.querySelector('[data-remove-id="att_sel_0"]');
      headBtn.click();
      assert.equal(view.pendingAttachments.length, 8);
      assert.ok(!view.pendingAttachments.find((a) => a.id === "att_sel_0"));
      assert.equal(view.el.attachments.querySelectorAll(".attachment-chip").length, 8);

      // 3. Remove tail chip (att_sel_9)
      const tailBtn = view.el.attachments.querySelector('[data-remove-id="att_sel_9"]');
      tailBtn.click();
      assert.equal(view.pendingAttachments.length, 7);
      assert.ok(!view.pendingAttachments.find((a) => a.id === "att_sel_9"));
      assert.equal(view.el.attachments.querySelectorAll(".attachment-chip").length, 7);
    });

    it("3.4: Complete detachment down to 0: removing all chips hides attachment bar and re-disables send button", () => {
      view.el.input.value = "";
      view.pendingAttachments = [
        { id: "a_last_1", name: "one.txt" },
        { id: "a_last_2", name: "two.txt" },
      ];
      view.renderAttachments();
      view.syncSendButtonState();

      assert.equal(view.el.send.disabled, false);

      // Remove first chip
      view.el.attachments.querySelector('[data-remove-id="a_last_1"]').click();
      assert.equal(view.pendingAttachments.length, 1);
      assert.equal(view.el.send.disabled, false, "Still enabled with 1 attachment remaining");

      // Remove second (last) chip
      view.el.attachments.querySelector('[data-remove-id="a_last_2"]').click();
      assert.equal(view.pendingAttachments.length, 0);
      assert.equal(view.el.attachments.hidden, true, "Attachment bar hidden when 0 attachments");
      assert.equal(view.el.send.disabled, true, "Send button re-disabled when 0 attachments and empty text");
    });

    it("3.5: Send button state matrix across all combinations of text and attachments", () => {
      // 1. (empty text, no attachments) -> disabled
      view.el.input.value = "";
      view.pendingAttachments = [];
      view.syncSendButtonState();
      assert.equal(view.el.send.disabled, true);

      // 2. (whitespace text, no attachments) -> disabled
      view.el.input.value = "   \n  ";
      view.pendingAttachments = [];
      view.syncSendButtonState();
      assert.equal(view.el.send.disabled, true);

      // 3. (text present, no attachments) -> enabled
      view.el.input.value = "Hello world";
      view.pendingAttachments = [];
      view.syncSendButtonState();
      assert.equal(view.el.send.disabled, false);

      // 4. (empty text, attachments present) -> enabled
      view.el.input.value = "";
      view.pendingAttachments = [{ id: "x1", name: "test.pdf" }];
      view.syncSendButtonState();
      assert.equal(view.el.send.disabled, false);

      // 5. (text present, attachments present) -> enabled
      view.el.input.value = "Attached report";
      view.pendingAttachments = [{ id: "x1", name: "test.pdf" }];
      view.syncSendButtonState();
      assert.equal(view.el.send.disabled, false);
    });

    it("3.6: Submission with attachments and empty text serializes attachment lines, clears attachments, and disables send on round completion", async () => {
      view.el.input.value = "";
      view.pendingAttachments = [
        { id: "a_sub_1", name: "spec.md" },
        { id: "a_sub_2", name: "architecture.png" },
      ];
      view.renderAttachments();
      view.syncSendButtonState();

      assert.equal(view.el.send.disabled, false);

      await view.submit();

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0].text, "[附件: spec.md]\n[附件: architecture.png]");
      assert.equal(view.pendingAttachments.length, 0, "Attachments cleared after submit");
      assert.equal(view.el.attachments.hidden, true, "Attachment bar hidden after submit");

      // While round is active, button is stop button and enabled
      assert.equal(state.activity[testRoomId].round, true);
      assert.equal(view.el.send.classList.contains("is-stop"), true);
      assert.equal(view.el.send.disabled, false);

      // Once generation round completes, button reverts to send and disables
      state.activity[testRoomId].round = false;
      view.syncSendButtonState();
      assert.equal(view.el.send.classList.contains("is-stop"), false);
      assert.equal(view.el.send.disabled, true, "Send button disabled after submit and round completion");
    });

    it("3.7: Submission with both text and attachments formats composite message with newlines and attachment markers", async () => {
      view.el.input.value = "请查收系统设计文档：";
      view.pendingAttachments = [{ id: "a_doc", name: "system_design.docx" }];
      view.renderAttachments();
      view.syncSendButtonState();

      await view.submit();

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0].text, "请查收系统设计文档：\n\n[附件: system_design.docx]");
      assert.equal(view.el.input.value, "");
      assert.equal(view.pendingAttachments.length, 0);
    });

    it("3.8: Rapid add/remove churn: 50 cycles of adding and immediately clearing attachments leaves zero ghost chips or DOM leaks", () => {
      for (let i = 0; i < 50; i++) {
        view.pendingAttachments.push({ id: `churn_${i}`, name: `test_${i}.bin` });
        view.renderAttachments();
        assert.equal(view.el.attachments.hidden, false);
        assert.equal(view.el.attachments.querySelectorAll(".attachment-chip").length, 1);

        view.el.attachments.querySelector(`[data-remove-id="churn_${i}"]`).click();
        assert.equal(view.el.attachments.hidden, true);
        assert.equal(view.pendingAttachments.length, 0);
      }

      assert.equal(view.el.attachments.querySelectorAll(".attachment-chip").length, 0);
      assert.equal(view.el.send.disabled, true);
    });
  });

  // =========================================================================
  // Suite 4: Stop Generation Cycle Thrashing & Event State Synchronization
  // =========================================================================
  describe("Suite 4: Stop Generation Cycle Thrashing & Event State Synchronization", () => {
    it("4.1: Rapid cycle thrashing: 100 alternating transitions of state.activity[roomId].round maintain strict synchronization of .is-stop class", () => {
      view.el.input.value = "";

      for (let i = 0; i < 100; i++) {
        const isGenerating = i % 2 === 0;
        state.activity[testRoomId].round = isGenerating;
        view.syncSendButtonState();

        if (isGenerating) {
          assert.equal(
            view.el.send.classList.contains("is-stop"),
            true,
            `Cycle ${i}: .is-stop must be present when round = true`
          );
          assert.equal(view.el.send.disabled, false, `Cycle ${i}: Stop button must be enabled`);
          assert.equal(view.el.send.title, "停止生成");
        } else {
          assert.equal(
            view.el.send.classList.contains("is-stop"),
            false,
            `Cycle ${i}: .is-stop must NOT be present when round = false`
          );
          assert.equal(view.el.send.disabled, true, `Cycle ${i}: Send button must be disabled when empty`);
          assert.equal(view.el.send.title, "发送");
        }
      }
    });

    it("4.2: Button metadata synchronization: title ('停止生成' vs '发送') and aria-label strictly track generation status across 100 cycles", () => {
      for (let i = 0; i < 100; i++) {
        const isGenerating = i % 2 === 1;
        state.activity[testRoomId].round = isGenerating;
        view.syncSendButtonState();

        const expectedTitle = isGenerating ? "停止生成" : "发送";
        assert.equal(view.el.send.title, expectedTitle, `Cycle ${i} title mismatch`);
        assert.equal(view.el.send.getAttribute("aria-label"), expectedTitle, `Cycle ${i} aria-label mismatch`);
      }
    });

    it("4.3: Icon SVG transition: stop square SVG <rect appears during round and reverts to send icon on completion", () => {
      // 1. Initially round = false: send icon
      assert.equal(view.el.send.innerHTML.includes("stop-icon"), false);

      // 2. Set round = true: stop square icon
      state.activity[testRoomId].round = true;
      view.syncSendButtonState();
      assert.equal(view.el.send.innerHTML.includes("stop-icon"), true);
      assert.equal(view.el.send.innerHTML.includes("<rect"), true);

      // 3. Set round = false: reverts to send icon
      state.activity[testRoomId].round = false;
      view.syncSendButtonState();
      assert.equal(view.el.send.innerHTML.includes("stop-icon"), false);
      assert.equal(view.el.send.innerHTML.includes("<rect"), false);
    });

    it("4.4: Click-to-stop event handling: clicking during active round halts round, clears sending/typing/tools, and updates button", () => {
      // Setup active generation state
      state.activity[testRoomId].round = true;
      state.activity[testRoomId].sending = true;
      state.activity[testRoomId].typing.add("coder");
      state.activity[testRoomId].tools.set("bash_1", { name: "bash", status: "running" });

      view.syncSendButtonState();
      assert.equal(view.el.send.classList.contains("is-stop"), true);

      // Trigger click on stop button
      view.el.send.click();

      // Verify all generation state fields are cleanly cleared
      assert.equal(state.activity[testRoomId].round, false, "round flag must be false");
      assert.equal(state.activity[testRoomId].sending, false, "sending flag must be false");
      assert.equal(state.activity[testRoomId].typing.size, 0, "typing set must be cleared");
      assert.equal(state.activity[testRoomId].tools.size, 0, "tools map must be cleared");

      // Verify button reverted
      assert.equal(view.el.send.classList.contains("is-stop"), false);
      assert.equal(view.el.send.title, "发送");
    });

    it("4.5: Multi-click resilience: clicking stop button 10 times consecutively causes zero errors and maintains stable stopped state", () => {
      state.activity[testRoomId].round = true;
      view.syncSendButtonState();

      for (let i = 0; i < 10; i++) {
        view.el.send.click();
        assert.equal(state.activity[testRoomId].round, false);
        assert.equal(view.el.send.classList.contains("is-stop"), false);
        assert.equal(view.el.send.title, "发送");
      }
    });

    it("4.6: Interleaved workflow stress: start round -> stop round -> type text -> send message -> complete round -> repeat 20 times", async () => {
      for (let cycle = 0; cycle < 20; cycle++) {
        // Step A: Active round starts
        state.activity[testRoomId].round = true;
        view.syncSendButtonState();
        assert.equal(view.el.send.classList.contains("is-stop"), true);

        // Step B: User clicks stop
        view.el.send.click();
        assert.equal(state.activity[testRoomId].round, false);
        assert.equal(view.el.send.classList.contains("is-stop"), false);

        // Step C: User types message
        view.el.input.value = `Message in cycle ${cycle}`;
        view.autosize();
        assert.equal(view.el.send.disabled, false);

        // Step D: User sends message
        await view.submit();
        assert.equal(view.el.input.value, "");
        assert.equal(view.el.send.classList.contains("is-stop"), true, "Morphs to stop button while generating");

        // Step E: Round completes
        state.activity[testRoomId].round = false;
        view.syncSendButtonState();
        assert.equal(view.el.send.classList.contains("is-stop"), false);
        assert.equal(view.el.send.disabled, true);
        assert.equal(sentMessages.length, cycle + 1);
      }
    });

    it("4.7: Handling state.activity[roomId].sending = true also activates stop mode and click-to-stop correctly", () => {
      state.activity[testRoomId].round = false;
      state.activity[testRoomId].sending = true;
      view.syncSendButtonState();

      assert.equal(view.el.send.classList.contains("is-stop"), true);
      assert.equal(view.el.send.title, "停止生成");

      view.el.send.click();

      assert.equal(state.activity[testRoomId].sending, false);
      assert.equal(view.el.send.classList.contains("is-stop"), false);
      assert.equal(view.el.send.title, "发送");
    });
  });
});
