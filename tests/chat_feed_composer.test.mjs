/**
 * agent_for_myself/tests/chat_feed_composer.test.mjs
 *
 * Comprehensive Headless DOM Verification Suite for Milestone 3 (Features 12 to 16):
 * - Feature 12 (R1-Scrollbar-Autoscroll): Anti-jump gutter, 64px latching state machine, floating pill.
 * - Feature 13 (R1-Message-Clusters): 4 distinct role clusters, model badges, markdown containers, action toolbar.
 * - Feature 14 (R1-Tool-Accordion): Event buffering in store, Claude-style accordion, duration, clamped output, copy.
 * - Feature 15 (R1-Evidence-Badges): Interactive Evidence Ladder badges, tool card highlighting, inspector navigation.
 * - Feature 16 (R1-Composer-Dock): Floating capsule dock, auto-expanding textarea, keyboard handling, Unicode mentions, attachments, stop button transform.
 *
 * Environment: Node >= 22.19.0, pure ESM, ZERO new external npm dependencies.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// 1. Setup Headless DOM Harness
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
  // fallback if navigator is not defined or locked
}

// Import application modules under test
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

describe("Milestone 3: Chat Feed, Tool Cards & Composer Consolidated Test Suite", () => {
  const cssPath = path.join(repoRoot, "web/app.css");
  let appCss = "";

  beforeEach(() => {
    lastCopiedText = null;
    appCss = fs.readFileSync(cssPath, "utf8");
  });

  // =========================================================================
  // Suite 1: CSS Standards & Token Compliance (Features 12 to 16)
  // =========================================================================
  describe("Suite 1: CSS Standards & Token Compliance", () => {
    it("1.1: .chat-body declares scrollbar-gutter: stable, overscroll-behavior-y: contain, and overflow-anchor: auto", () => {
      assert.ok(appCss.includes(".chat-body"), "app.css declares .chat-body");
      const match = /\.chat-body\s*\{([^}]+)\}/.exec(appCss);
      assert.ok(match, ".chat-body CSS block exists");
      const block = match[1];
      assert.ok(block.includes("scrollbar-gutter: stable"), "scrollbar-gutter: stable required");
      assert.ok(block.includes("overscroll-behavior-y: contain"), "overscroll-behavior-y: contain required");
      assert.ok(block.includes("overflow-anchor: auto"), "overflow-anchor: auto required");
      assert.ok(block.includes("overflow-y: auto"), "overflow-y: auto required");
    });

    it("1.2: floating pill button .btn-scroll-bottom and .scroll-unread-badge styles declared", () => {
      assert.ok(appCss.includes(".btn-scroll-bottom"), "Declares .btn-scroll-bottom");
      assert.ok(appCss.includes(".scroll-unread-badge"), "Declares .scroll-unread-badge");
      const match = /\.btn-scroll-bottom\s*\{([^}]+)\}/.exec(appCss);
      assert.ok(match, ".btn-scroll-bottom CSS rule exists");
      const block = match[1];
      assert.ok(block.includes("position: absolute"), "Must have absolute positioning");
      assert.ok(block.includes("border-radius: var(--r-pill)"), "Must use rounded pill radius");
      assert.ok(block.includes("box-shadow"), "Must declare elevation shadow");
    });

    it("1.3: message clusters declared: user, assistant, system, tool, model badge, and action toolbar", () => {
      assert.ok(appCss.includes(".msg-row.is-user"), "Declares .msg-row.is-user");
      assert.ok(appCss.includes(".msg-row.is-assistant") || appCss.includes(".msg-row.is-bot"), "Declares assistant row");
      assert.ok(appCss.includes(".msg-row.is-system"), "Declares .msg-row.is-system");
      assert.ok(appCss.includes(".msg-row.is-tool"), "Declares .msg-row.is-tool");
      assert.ok(appCss.includes(".msg-model"), "Declares .msg-model badge");
      assert.ok(appCss.includes(".msg-toolbar"), "Declares .msg-toolbar");
      assert.ok(appCss.includes(".bubble.markdown-body"), "Declares .bubble.markdown-body");
    });

    it("1.4: Claude-style .tool-card styles declared with collapsible states, duration pills, and clamped output", () => {
      assert.ok(appCss.includes(".tool-card"), "Declares .tool-card");
      assert.ok(appCss.includes(".tool-card-head"), "Declares .tool-card-head");
      assert.ok(appCss.includes(".tool-card-body"), "Declares .tool-card-body");
      assert.ok(appCss.includes(".tool-duration"), "Declares .tool-duration");
      assert.ok(appCss.includes(".tool-output-box.is-clamped"), "Declares .tool-output-box.is-clamped");
      assert.ok(appCss.includes(".tool-copy-btn"), "Declares .tool-copy-btn");
    });

    it("1.5: interactive evidence badge .ev-badge.is-interactive and pulse animation declared", () => {
      assert.ok(appCss.includes(".ev-badge.is-interactive"), "Declares .ev-badge.is-interactive");
      assert.ok(appCss.includes("@keyframes ev-pulse-red") || appCss.includes("ev-pulse-red"), "Declares red pulse keyframes");
    });

    it("1.6: floating capsule composer dock, attachment chips, and stop square animation declared", () => {
      assert.ok(appCss.includes(".composer.floating-dock"), "Declares .composer.floating-dock");
      assert.ok(appCss.includes(".composer-attachments"), "Declares .composer-attachments");
      assert.ok(appCss.includes(".attachment-chip"), "Declares .attachment-chip");
      assert.ok(appCss.includes(".send-btn.is-stop"), "Declares .send-btn.is-stop");
      assert.ok(appCss.includes("#composer-mentions") || appCss.includes(".mention-pop"), "Declares mentions popover");
    });
  });

  // =========================================================================
  // Suite 2: Viewport Latching State Machine (Feature 12)
  // =========================================================================
  describe("Suite 2: Viewport Latching State Machine", () => {
    let root;
    let view;
    const roomId = "room_latch_test";

    beforeEach(() => {
      document.body.innerHTML = '<div id="app"></div>';
      root = document.getElementById("app");
      state.roomById[roomId] = {
        room_id: roomId,
        title: "自滚动防抖测试群",
        topic: "Feature 12 测试",
        context_policy: "shared",
        owner_id: "boss",
        members: ["boss", "coder"],
      };
      state.messages[roomId] = [];
      state.activity[roomId] = newActivity(roomId);

      view = new GroupView(root);
      view.mount(roomId);

      // Setup simulated scroll metrics
      view.el.scroll.scrollHeight = 1000;
      view.el.scroll.clientHeight = 400;
      view.el.scroll.scrollTop = 600; // 1000 - 600 - 400 = 0 <= 64 (latched)
    });

    it("2.1: initial mount state is latched, unread count 0, #btn-scroll-bottom hidden", () => {
      assert.equal(view.isLatched, true, "Initial state must be latched");
      assert.equal(view.unreadCount, 0, "Initial unread count must be 0");
      assert.equal(view.el.scrollBottomBtn.hidden, true, "Floating bottom button must be hidden");
    });

    it("2.2: user scrolling up (>64px from bottom) detaches latching and reveals #btn-scroll-bottom", () => {
      // Scroll up: scrollTop = 300; dist = 1000 - 300 - 400 = 300 (> 64)
      view.el.scroll.scrollTop = 300;
      view.el.scroll.dispatchEvent(new Event("scroll"));

      assert.equal(view.isLatched, false, "Latching detached when distance > 64px");
      assert.equal(view.el.scrollBottomBtn.hidden, false, "#btn-scroll-bottom displayed");
      assert.equal(view.el.scrollUnreadBadge.hidden, true, "Badge hidden when unreadCount is 0");
    });

    it("2.3: in detached state, arrival of new message increments unreadCount and displays badge without scrolling", () => {
      view.el.scroll.scrollTop = 300;
      view.el.scroll.dispatchEvent(new Event("scroll"));
      assert.equal(view.isLatched, false);

      // New message arrives
      state.messages[roomId] = [
        { id: "m1", seq: 1, type: "msg", speaker: "coder", content: "第一条更新", ts: Date.now() },
      ];
      view.renderTimeline(state.roomById[roomId]);

      assert.equal(view.isLatched, false, "Remains detached");
      assert.equal(view.unreadCount, 1, "Unread count incremented to 1");
      assert.equal(view.el.scrollBottomBtn.hidden, false, "Button displayed");
      assert.equal(view.el.scrollUnreadBadge.hidden, false, "Unread badge displayed");
      assert.equal(view.el.scrollUnreadBadge.textContent, "1", "Badge displays '1'");
      assert.equal(view.el.scroll.scrollTop, 300, "Scroll position strictly preserved");
    });

    it("2.4: in detached state, multiple new messages accumulate on unread badge counter", () => {
      view.el.scroll.scrollTop = 300;
      view.el.scroll.dispatchEvent(new Event("scroll"));

      state.messages[roomId] = [
        { id: "m1", seq: 1, type: "msg", speaker: "coder", content: "消息 1", ts: Date.now() },
        { id: "m2", seq: 2, type: "msg", speaker: "coder", content: "消息 2", ts: Date.now() },
        { id: "m3", seq: 3, type: "msg", speaker: "coder", content: "消息 3", ts: Date.now() },
      ];
      view.renderTimeline(state.roomById[roomId]);

      assert.equal(view.unreadCount, 3, "Unread count accumulated to 3");
      assert.equal(view.el.scrollUnreadBadge.textContent, "3");
      assert.equal(view.el.scrollUnreadBadge.hidden, false);
    });

    it("2.5: clicking #btn-scroll-bottom re-latches viewport, scrolls to bottom, resets unread count, and hides button", () => {
      view.el.scroll.scrollTop = 300;
      view.el.scroll.dispatchEvent(new Event("scroll"));
      view.unreadCount = 4;
      view.updateScrollBottomButton();
      assert.equal(view.el.scrollBottomBtn.hidden, false);

      view.el.scrollBottomBtn.click();

      assert.equal(view.isLatched, true, "Re-latched on button click");
      assert.equal(view.unreadCount, 0, "Unread count reset to 0");
      assert.equal(view.el.scrollBottomBtn.hidden, true, "Button hidden after click");
    });

    it("2.6: user sending a message re-latches viewport and scrolls to bottom", async () => {
      view.el.scroll.scrollTop = 300;
      view.el.scroll.dispatchEvent(new Event("scroll"));
      assert.equal(view.isLatched, false);

      view.el.input.value = "这是我发送的新消息";
      view.syncSendButtonState();
      await view.submit();

      assert.equal(view.isLatched, true, "Re-latched on user message submit");
      assert.equal(view.unreadCount, 0, "Unread count reset on submit");
      assert.equal(view.el.scrollBottomBtn.hidden, true, "Button hidden");
    });

    it("2.7: manually scrolling back down within 64px threshold re-latches viewport and zeroes unread count", () => {
      view.el.scroll.scrollTop = 300;
      view.el.scroll.dispatchEvent(new Event("scroll"));
      assert.equal(view.isLatched, false);

      // Scroll down: dist = 1000 - 560 - 400 = 40 (<= 64)
      view.el.scroll.scrollTop = 560;
      view.el.scroll.dispatchEvent(new Event("scroll"));

      assert.equal(view.isLatched, true, "Re-latched when dist <= 64px");
      assert.equal(view.unreadCount, 0, "Unread count cleared");
      assert.equal(view.el.scrollBottomBtn.hidden, true, "Button hidden");
    });

    it("2.8: in latched state, new incoming messages automatically trigger scroll to bottom", () => {
      assert.equal(view.isLatched, true);
      state.messages[roomId] = [
        { id: "m1", seq: 1, type: "msg", speaker: "coder", content: "持续输出中...", ts: Date.now() },
      ];
      view.renderTimeline(state.roomById[roomId]);

      assert.equal(view.isLatched, true, "Still latched");
      assert.equal(view.unreadCount, 0, "No unread counter increment in latched mode");
      assert.equal(view.el.scrollBottomBtn.hidden, true);
    });
  });

  // =========================================================================
  // Suite 3: Message Cluster Cards & Role Distinction (Feature 13)
  // =========================================================================
  describe("Suite 3: Message Cluster Cards & Role Distinction", () => {
    let root;
    let view;
    const roomId = "room_cluster_test";

    beforeEach(() => {
      document.body.innerHTML = '<div id="app"></div>';
      root = document.getElementById("app");
      state.roomById[roomId] = {
        room_id: roomId,
        title: "消息卡片样式测试群",
        topic: "Feature 13",
        context_policy: "shared",
        owner_id: "boss",
        members: ["boss", "coder"],
      };
      state.botsById = {
        boss: { id: "boss", name: "Boss", role: "群主", badge: "群主", color: "#6366f1" },
        coder: { id: "coder", name: "Coder", role: "开发专家", badge: "开发", color: "#06b6d4" },
      };
      state.messages[roomId] = [];
      state.activity[roomId] = newActivity(roomId);

      view = new GroupView(root);
      view.mount(roomId);
    });

    it("3.1: user role renders right-aligned .msg-row.is-user, data-role='user', and .bubble.markdown-body.is-user-bubble", () => {
      const item = { id: "u1", seq: 1, type: "msg", speaker: "user", content: "请优化系统响应速度", ts: Date.now() };
      const html = view.messageHTML(item, state.roomById[roomId]);

      assert.ok(html.includes('class="msg-row is-user"'), "Must have class .msg-row.is-user");
      assert.ok(html.includes('data-role="user"'), "Must have data-role='user'");
      assert.ok(html.includes("is-user-bubble"), "Must contain .is-user-bubble");
      assert.ok(html.includes("markdown-body"), "Must wrap in .markdown-body");
      assert.ok(html.includes("你"), "Header identifies user as 你");
    });

    it("3.2: pending and failed user messages display distinct status indicators", () => {
      const pendingHtml = view.messageHTML({ speaker: "user", content: "发送中任务", pending: true }, state.roomById[roomId]);
      const failedHtml = view.messageHTML({ speaker: "user", content: "失败任务", failed: true }, state.roomById[roomId]);

      assert.ok(pendingHtml.includes("is-pending") && pendingHtml.includes("发送中"), "Pending message has is-pending and '发送中'");
      assert.ok(failedHtml.includes("发送失败"), "Failed message has '发送失败'");
    });

    it("3.3: assistant role renders left-aligned .msg-row.is-assistant, data-role='assistant', model badge, and markdown container", () => {
      const item = {
        id: "a1",
        seq: 2,
        type: "msg",
        speaker: "coder",
        content: "### 重构方案\n已将模块解耦并测试完毕。",
        ts: Date.now(),
      };
      const html = view.messageHTML(item, state.roomById[roomId]);

      assert.ok(html.includes('class="msg-row is-bot is-assistant"'), "Must have .is-bot.is-assistant");
      assert.ok(html.includes('data-role="assistant"'), "Must have data-role='assistant'");
      assert.ok(html.includes("msg-model"), "Must render model badge .msg-model");
      assert.ok(html.includes("Coder"), "Displays speaker name");
      assert.ok(html.includes("开发") || html.includes("工程师"), "Displays speaker role");
    });

    it("3.4: system role renders centered pill .msg-row.is-system with .msg-system-pill", () => {
      const item = { id: "s1", type: "msg", speaker: "system", content: "群聊策略已切换为「共享全文」", ts: Date.now() };
      const html = view.messageHTML(item, state.roomById[roomId]);

      assert.ok(html.includes('class="msg-row is-system"'), "Must have .msg-row.is-system");
      assert.ok(html.includes('data-role="system"'), "Must have data-role='system'");
      assert.ok(html.includes("msg-system-pill"), "Must contain .msg-system-pill");
      assert.ok(html.includes("共享全文"), "Contains system text");
    });

    it("3.5: tool role renders .msg-row.is-tool with .tool-card", () => {
      const item = {
        id: "t1",
        type: "msg",
        role: "tool",
        tool: "room_file_save",
        content: "README.md 写入完成",
        duration: 48,
        status: "ok",
      };
      const html = view.messageHTML(item, state.roomById[roomId]);

      assert.ok(html.includes('class="msg-row is-tool"'), "Must have .msg-row.is-tool");
      assert.ok(html.includes('data-role="tool"'), "Must have data-role='tool'");
      assert.ok(html.includes("tool-card"), "Must contain .tool-card");
      assert.ok(html.includes("room_file_save"), "Contains tool name");
    });

    it("3.6: assistant message includes .msg-toolbar with copy and retry buttons", () => {
      const item = { id: "a2", type: "msg", speaker: "coder", content: "分析完毕", ts: Date.now() };
      const html = view.messageHTML(item, state.roomById[roomId]);

      assert.ok(html.includes("msg-toolbar"), "Contains .msg-toolbar");
      assert.ok(html.includes("msg-copy"), "Contains .msg-copy button");
      assert.ok(html.includes("msg-retry"), "Contains .msg-retry button");
    });

    it("3.7: clicking copy button on message toolbar copies bubble text to clipboard and displays feedback", async () => {
      state.messages[roomId] = [
        { id: "a3", type: "msg", speaker: "coder", content: "这是一段重要的分析结论", ts: Date.now() },
      ];
      view.renderTimeline(state.roomById[roomId]);

      const copyBtn = view.el.inner.querySelector(".msg-copy");
      assert.ok(copyBtn, "Copy button exists in rendered timeline");

      await copyBtn.onclick();
      assert.ok(lastCopiedText.includes("这是一段重要的分析结论"), "Bubble text copied to clipboard");
      assert.ok(copyBtn.textContent.includes("已复制"), "Button text changes to '已复制'");
    });

    it("3.8: clicking retry button on message toolbar pre-fills composer textarea with @speaker prompt", () => {
      state.messages[roomId] = [
        { id: "a4", type: "msg", speaker: "coder", content: "旧版回答", ts: Date.now() },
      ];
      view.renderTimeline(state.roomById[roomId]);

      const retryBtn = view.el.inner.querySelector(".msg-retry");
      assert.ok(retryBtn, "Retry button exists");

      retryBtn.onclick();
      assert.equal(view.el.input.value, "@coder 请重新思考并优化回答：", "Pre-fills retry prompt with speaker mention");
    });
  });

  // =========================================================================
  // Suite 4: Claude-style Tool Call Accordion (Feature 14)
  // =========================================================================
  describe("Suite 4: Claude-style Tool Call Accordion", () => {
    it("4.1: toolCardHTML generates valid card with status icon, name, duration pill, and copy buttons", () => {
      const tool = {
        id: "call_abc123",
        tool: "sqlite_query",
        status: "ok",
        duration: 42,
        params: { query: "SELECT * FROM rooms", limit: 5 },
        output: "2 rows returned:\n1 | room-alpha\n2 | room-beta",
      };
      const html = toolCardHTML(tool);

      assert.ok(html.includes("tool-card"), "Contains .tool-card");
      assert.ok(html.includes("sqlite_query"), "Contains tool name");
      assert.ok(html.includes("42ms"), "Contains duration pill '42ms'");
      assert.ok(html.includes("tool-copy-btn"), "Contains copy buttons");
    });

    it("4.2: successful tool defaults to collapsed (hidden=true), error/running tool defaults to auto-expanded", () => {
      const okTool = { id: "t_ok", tool: "fs_read", status: "ok", duration: 12, params: {}, output: "ok" };
      const errTool = { id: "t_err", tool: "bash_exec", status: "error", duration: 90, params: {}, output: "Exit code 1" };
      const runTool = { id: "t_run", tool: "api_fetch", status: "running", params: {}, output: "" };

      const okHtml = toolCardHTML(okTool);
      const errHtml = toolCardHTML(errTool);
      const runHtml = toolCardHTML(runTool);

      assert.ok(okHtml.includes("hidden") && !okHtml.includes("is-expanded"), "Successful tool body is hidden by default");
      assert.ok(!errHtml.includes("hidden") && errHtml.includes("is-expanded"), "Error tool body is not hidden by default");
      assert.ok(!runHtml.includes("hidden") && runHtml.includes("is-expanded"), "Running tool body is not hidden by default");
    });

    it("4.3: clicking .tool-card-head toggles accordion expansion and .is-expanded class", () => {
      const wrap = document.createElement("div");
      wrap.innerHTML = toolCardHTML({
        id: "t_toggle",
        tool: "room_file_save",
        status: "ok",
        duration: 35,
        params: { path: "spec.json" },
        output: "Saved successfully",
      });
      document.body.appendChild(wrap);

      const view = new GroupView(wrap);
      view.el = { inner: wrap };
      view.bindMessageActions();

      const head = wrap.querySelector(".tool-card-head");
      const card = wrap.querySelector(".tool-card");
      const body = wrap.querySelector(".tool-card-body");

      assert.equal(body.hidden, true, "Initially hidden");
      assert.equal(card.classList.contains("is-expanded"), false);

      // Click head to expand
      head.onclick(new Event("click"));
      assert.equal(body.hidden, false, "Expanded on click");
      assert.equal(card.classList.contains("is-expanded"), true);

      // Click head to collapse
      head.onclick(new Event("click"));
      assert.equal(body.hidden, true, "Collapsed on second click");
      assert.equal(card.classList.contains("is-expanded"), false);
    });

    it("4.4: long output (>6 lines) renders with .tool-output-box.is-clamped and clamp toggle button", () => {
      const longOutput = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: Data stream log`).join("\n");
      const html = toolCardHTML({
        id: "t_clamp",
        tool: "fetch_logs",
        status: "ok",
        duration: 120,
        params: {},
        output: longOutput,
      });

      assert.ok(html.includes("tool-output-box is-clamped"), "Output box has .is-clamped class");
      assert.ok(html.includes("data-clamp-toggle"), "Clamp toggle button rendered");
      assert.ok(html.includes("展开完整输出 (12 行)"), "Toggle button shows correct line count");
    });

    it("4.5: clicking clamp toggle switches between .is-clamped and expanded ('收起输出' vs '展开完整输出')", () => {
      const longOutput = Array.from({ length: 10 }, (_, i) => `Log line ${i}`).join("\n");
      const wrap = document.createElement("div");
      wrap.innerHTML = toolCardHTML({
        id: "t_clamp_click",
        tool: "log_stream",
        status: "ok",
        duration: 50,
        params: {},
        output: longOutput,
      });

      const view = new GroupView(wrap);
      view.el = { inner: wrap };
      view.bindMessageActions();

      const toggleBtn = wrap.querySelector("[data-clamp-toggle]");
      const outputBox = wrap.querySelector(".tool-output-box");

      assert.equal(outputBox.classList.contains("is-clamped"), true);
      assert.ok(toggleBtn.textContent.includes("展开完整输出"));

      // Expand output
      toggleBtn.onclick(new Event("click"));
      assert.equal(outputBox.classList.contains("is-clamped"), false);
      assert.equal(toggleBtn.textContent, "收起输出");

      // Re-clamp output
      toggleBtn.onclick(new Event("click"));
      assert.equal(outputBox.classList.contains("is-clamped"), true);
      assert.ok(toggleBtn.textContent.includes("展开完整输出"));
    });

    it("4.6: tool copy button for parameters copies raw parameters to clipboard", async () => {
      const wrap = document.createElement("div");
      wrap.innerHTML = toolCardHTML({
        id: "t_copy_params",
        tool: "file_write",
        status: "ok",
        duration: 20,
        params: { filename: "test.txt", content: "Hello World" },
        output: "ok",
      });

      const view = new GroupView(wrap);
      view.el = { inner: wrap };
      view.bindMessageActions();

      const paramsCopyBtn = wrap.querySelector('[data-copy-target="params"]');
      assert.ok(paramsCopyBtn, "Params copy button exists");

      await paramsCopyBtn.onclick(new Event("click"));
      assert.ok(lastCopiedText.includes("Hello World"), "Copied raw params text");
      assert.equal(paramsCopyBtn.textContent, "已复制");
    });

    it("4.7: tool copy button for output copies output text to clipboard", async () => {
      const wrap = document.createElement("div");
      wrap.innerHTML = toolCardHTML({
        id: "t_copy_output",
        tool: "sql_exec",
        status: "ok",
        duration: 15,
        params: {},
        output: "SQL Result: 100 rows",
      });

      const view = new GroupView(wrap);
      view.el = { inner: wrap };
      view.bindMessageActions();

      const outputCopyBtn = wrap.querySelector('[data-copy-target="output"]');
      assert.ok(outputCopyBtn, "Output copy button exists");

      await outputCopyBtn.onclick(new Event("click"));
      assert.equal(lastCopiedText, "SQL Result: 100 rows", "Copied output text");
      assert.equal(outputCopyBtn.textContent, "已复制");
    });

    it("4.8: store tool event aggregation: tool_invoked and tool_result buffer into act.turnTools and attach to message on turn_completed", () => {
      const roomId = "room_store_tool_test";
      state.activity[roomId] = newActivity(roomId);
      state.messages[roomId] = [];
      state.roomById[roomId] = { room_id: roomId, title: "Tool test", members: ["coder"] };
      state.rooms = [state.roomById[roomId]];

      // Step 1: worker tool_invoked
      applyEvent({
        topic: "worker.coder.tool_invoked",
        sender: "coder",
        thread_id: `room:${roomId}`,
        payload: {
          member: "coder",
          tool: "ast_parse",
          call_id: "call_001",
          args: { source: "export const x = 1;" },
        },
      });

      const act = state.activity[roomId];
      const coderTools = act.turnTools.get("coder") || [];
      assert.ok(coderTools.some((t) => t.id === "call_001"), "turnTools buffers invoked tool");
      assert.equal(coderTools[0].status, "running");

      // Step 2: worker tool_result
      applyEvent({
        topic: "worker.coder.tool_result",
        sender: "coder",
        thread_id: `room:${roomId}`,
        payload: {
          member: "coder",
          tool: "ast_parse",
          call_id: "call_001",
          ok: true,
          ms: 38,
          result: "Parsed successfully with 1 AST declaration",
        },
      });

      assert.equal(coderTools[0].status, "ok");
      assert.equal(coderTools[0].duration, 38);

      // Step 3: room turn_completed
      applyEvent({
        topic: "room.room_store_tool_test.turn_completed",
        payload: {
          room_id: roomId,
          seq: 1,
          speaker: "coder",
          content: "解析已完成，未发现语法错误。",
          evidence: "observed",
        },
      });

      assert.equal(state.messages[roomId].length, 1);
      const msg = state.messages[roomId][0];
      assert.ok(Array.isArray(msg.tools), "Message has tools array attached");
      assert.equal(msg.tools.length, 1);
      assert.equal(msg.tools[0].tool, "ast_parse");
      assert.equal(msg.tools[0].duration, 38);
      assert.equal(msg.tools[0].status, "ok");
      assert.equal(act.turnTools.has("coder"), false, "turnTools cleared for next turn");
    });
  });

  // =========================================================================
  // Suite 5: Interactive Evidence Badges & Inspector Linking (Feature 15)
  // =========================================================================
  describe("Suite 5: Interactive Evidence Badges & Inspector Linking", () => {
    let root;
    let view;
    const roomId = "room_ev_test";

    beforeEach(() => {
      document.body.innerHTML = '<div id="app"></div>';
      root = document.getElementById("app");
      state.roomById[roomId] = {
        room_id: roomId,
        title: "证据梯子联动测试群",
        topic: "Feature 15",
        context_policy: "shared",
        owner_id: "boss",
        members: ["boss", "coder"],
      };
      state.messages[roomId] = [];
      state.activity[roomId] = newActivity(roomId);

      view = new GroupView(root);
      view.mount(roomId);
    });

    it("5.1: evidenceBadgeHTML renders interactive button element with .is-interactive and data-ev-badge", () => {
      const html = evidenceBadgeHTML("observed", { seq: 5 }, roomId);
      assert.ok(html.includes("<button"), "Renders as an interactive button");
      assert.ok(html.includes("ev-badge is-observed is-interactive"), "Has .is-interactive class");
      assert.ok(html.includes('data-ev-badge="observed"'), "Declares data-ev-badge='observed'");
      assert.ok(html.includes('data-seq="5"'), "Declares data-seq='5'");
    });

    it("5.2: tri-state rendering: observed (green), stated/prepared (yellow), mismatch (red)", () => {
      const obsHtml = evidenceBadgeHTML("observed", { seq: 1 }, roomId);
      const prepHtml = evidenceBadgeHTML("prepared", { seq: 2 }, roomId);
      const misHtml = evidenceBadgeHTML("mismatch", { seq: 3 }, roomId);

      assert.ok(obsHtml.includes("已观测"), "Observed shows '已观测'");
      assert.ok(prepHtml.includes("仅声明"), "Prepared/stated shows '仅声明'");
      assert.ok(misHtml.includes("证据不符") || misHtml.includes("存疑"), "Mismatch shows '证据不符'");
    });

    it("5.3: clicking evidence badge expands and highlights (.is-highlighted) corresponding tool card in the feed", () => {
      const toolMsg = {
        id: "msg_ev_tool",
        seq: 10,
        type: "msg",
        speaker: "coder",
        evidence: "observed",
        content: "已确认数据源可用。",
        tools: [
          {
            id: "call_ev_1",
            tool: "ping_datasource",
            status: "ok",
            duration: 18,
            params: {},
            output: "pong",
          },
        ],
      };
      state.messages[roomId] = [toolMsg];
      view.renderTimeline(state.roomById[roomId]);

      const badgeBtn = view.el.inner.querySelector("[data-ev-badge]");
      const toolCard = view.el.inner.querySelector(".tool-card");
      const toolBody = view.el.inner.querySelector(".tool-card-body");

      assert.ok(badgeBtn, "Evidence badge exists");
      assert.ok(toolCard, "Tool card exists");
      assert.equal(toolBody.hidden, true, "Initially collapsed");

      badgeBtn.click();

      assert.equal(toolBody.hidden, false, "Tool card expanded on badge click");
      assert.equal(toolCard.classList.contains("is-expanded"), true);
      assert.equal(toolCard.classList.contains("is-highlighted"), true, "Gains .is-highlighted class");
    });

    it("5.4: clicking evidence badge sets state.inspector to evidence tab and dispatches ah:inspector", () => {
      state.messages[roomId] = [
        { id: "m_seq12", seq: 12, type: "msg", speaker: "coder", evidence: "mismatch", content: "数据存疑" },
      ];
      view.renderTimeline(state.roomById[roomId]);

      let dispatchedEvent = null;
      document.addEventListener("ah:inspector", (ev) => {
        dispatchedEvent = ev.detail;
      }, { once: true });

      const badge = view.el.inner.querySelector("[data-ev-badge]");
      badge.click();

      assert.ok(dispatchedEvent, "ah:inspector event dispatched");
      assert.equal(state.inspector?.type, "group");
      assert.equal(state.inspector?.id, roomId);
      assert.equal(state.inspector?.tab, "evidence");
      assert.equal(state.inspector?.seq, 12);
    });
  });

  // =========================================================================
  // Suite 6: Modern Floating Composer Dock & Keyboard/Mentions (Feature 16)
  // =========================================================================
  describe("Suite 6: Modern Floating Composer Dock & Keyboard/Mentions", () => {
    let root;
    let view;
    const roomId = "room_composer_test";

    beforeEach(() => {
      document.body.innerHTML = '<div id="app"></div>';
      root = document.getElementById("app");
      state.roomById[roomId] = {
        room_id: roomId,
        title: "浮动输入坞测试群",
        topic: "Feature 16",
        context_policy: "shared",
        owner_id: "boss",
        members: ["boss", "coder", "reviewer"],
      };
      state.botsById = {
        boss: { id: "boss", name: "Boss", role: "群主", badge: "群主" },
        coder: { id: "coder", name: "Coder", role: "开发专家", badge: "开发" },
        reviewer: { id: "reviewer", name: "Reviewer", role: "代码审查", badge: "审查" },
        librarian: { id: "librarian", name: "Librarian", role: "资料管家", badge: "资料" },
      };
      state.messages[roomId] = [];
      state.activity[roomId] = newActivity(roomId);

      view = new GroupView(root);
      view.mount(roomId);
    });

    it("6.1: mounts floating capsule dock with all required elements (#g-composer.floating-dock, #g-input, #g-send)", () => {
      assert.ok(view.el.composer, "#g-composer floating dock exists");
      assert.ok(view.el.composer.classList.contains("floating-dock"), "has .floating-dock class");
      assert.ok(view.el.input, "#g-input textarea exists");
      assert.ok(view.el.send, "#g-send button exists");
      assert.ok(view.el.attach, "#btn-attach button exists");
      assert.ok(view.el.attachments, "#composer-attachments bar exists");
      assert.ok(view.el.mentions, "#composer-mentions popover exists");
    });

    it("6.2: send button is initially disabled when input is empty and no attachments", () => {
      assert.equal(view.el.input.value, "");
      assert.equal(view.el.send.disabled, true, "Send button disabled on empty input");
    });

    it("6.3: auto-expanding textarea: min-height 40px, expands dynamically with scrollHeight, clamps at max 160px with overflow-y: auto", () => {
      // 1. Empty input -> min 40px
      view.autosize();
      assert.equal(view.el.input.style.height, "40px");
      assert.equal(view.el.input.style.overflowY, "hidden");

      // 2. Multi-line input -> 90px
      view.el.input.value = "第一行\n第二行\n第三行";
      view.el.input.scrollHeight = 90;
      view.autosize();
      assert.equal(view.el.input.style.height, "90px");
      assert.equal(view.el.input.style.overflowY, "hidden");

      // 3. Overflow input -> clamp to 160px with overflowY: auto
      view.el.input.value = "超长段落\n".repeat(15);
      view.el.input.scrollHeight = 250;
      view.autosize();
      assert.equal(view.el.input.style.height, "160px");
      assert.equal(view.el.input.style.overflowY, "auto");
    });

    it("6.4: Enter without Shift submits message, resets height to 40px, and clears textarea", async () => {
      view.el.input.value = "测试自动发送";
      view.el.input.scrollHeight = 70;
      view.autosize();
      assert.equal(view.el.send.disabled, false);

      let prevented = false;
      const enterEvent = Object.assign(new Event("keydown"), {
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        preventDefault: () => { prevented = true; },
      });

      view.el.input.dispatchEvent(enterEvent);
      assert.equal(prevented, true, "Enter calls preventDefault()");
      assert.equal(view.el.input.value, "", "Input cleared after send");
      assert.equal(view.el.input.style.height, "40px", "Height reset to 40px");
    });

    it("6.5: Shift+Enter allows newline without submitting", () => {
      view.el.input.value = "第一行文字";
      let prevented = false;
      const shiftEnterEvent = Object.assign(new Event("keydown"), {
        key: "Enter",
        shiftKey: true,
        isComposing: false,
        preventDefault: () => { prevented = true; },
      });

      view.el.input.dispatchEvent(shiftEnterEvent);
      assert.equal(prevented, false, "Shift+Enter must not call preventDefault()");
      assert.equal(view.el.input.value, "第一行文字", "Input value preserved");
    });

    it("6.6: whitespace-only input disables send button and does not submit", () => {
      view.el.input.value = "   \t\n  ";
      view.autosize();

      assert.equal(view.el.send.disabled, true, "Whitespace-only input disables send button");

      let prevented = false;
      const enterEvent = Object.assign(new Event("keydown"), {
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        preventDefault: () => { prevented = true; },
      });

      view.el.input.dispatchEvent(enterEvent);
      assert.equal(view.el.input.value, "   \t\n  ", "Does not clear on invalid submit");
    });

    it("6.7: typing @ opens #composer-mentions popover with members and bots", () => {
      view.el.input.value = "@";
      view.el.input.selectionStart = 1;
      view.updateMentions();

      assert.equal(view.el.mentions.hidden, false, "Mentions popover displayed");
      const items = view.el.mentions.querySelectorAll(".mention-item");
      assert.ok(items.length >= 3, "Contains room members and bots");
      assert.ok(items[0].classList.contains("is-active"), "First item active by default");
    });

    it("6.8: Unicode mentions filtering supports both English IDs and Chinese names/roles", () => {
      // 1. English filter
      view.el.input.value = "咨询 @code";
      view.el.input.selectionStart = 9;
      view.updateMentions();
      assert.equal(view.el.mentions.hidden, false);
      let items = view.el.mentions.querySelectorAll(".mention-item");
      assert.equal(items.length, 1);
      assert.equal(items[0].dataset.mention, "coder");

      // 2. Chinese filter
      view.el.input.value = "咨询 @审查";
      view.el.input.selectionStart = 7;
      view.updateMentions();
      assert.equal(view.el.mentions.hidden, false);
      items = view.el.mentions.querySelectorAll(".mention-item");
      assert.equal(items.length, 1);
      assert.equal(items[0].dataset.mention, "reviewer");
    });

    it("6.9: ArrowDown and ArrowUp navigate through mention suggestions with .is-active class", () => {
      view.el.input.value = "@";
      view.el.input.selectionStart = 1;
      view.updateMentions();

      const items = view.el.mentions.querySelectorAll(".mention-item");
      assert.ok(items.length >= 2);

      // ArrowDown
      view.handleMentionKey({ key: "ArrowDown", preventDefault: () => {} });
      assert.equal(view.mentionIndex, 1);
      assert.equal(items[1].classList.contains("is-active"), true);

      // ArrowUp
      view.handleMentionKey({ key: "ArrowUp", preventDefault: () => {} });
      assert.equal(view.mentionIndex, 0);
      assert.equal(items[0].classList.contains("is-active"), true);
    });

    it("6.10: Enter or Tab completes selected mention @MemberName with trailing space", () => {
      view.el.input.value = "请 @rev";
      view.el.input.selectionStart = 6;
      view.updateMentions();

      assert.equal(view.el.mentions.hidden, false);
      view.handleMentionKey({ key: "Tab", preventDefault: () => {} });

      assert.equal(view.el.mentions.hidden, true, "Mentions popover closed");
      assert.equal(view.el.input.value, "请 @reviewer ", "Completed with trailing space");
    });

    it("6.11: Escape dismisses mentions popover without altering input text", () => {
      view.el.input.value = "请注意 @";
      view.el.input.selectionStart = 6;
      view.updateMentions();
      assert.equal(view.el.mentions.hidden, false);

      const handled = view.handleMentionKey({ key: "Escape", preventDefault: () => {} });
      assert.equal(handled, true);
      assert.equal(view.el.mentions.hidden, true, "Mentions popover dismissed");
      assert.equal(view.el.input.value, "请注意 @", "Input text unaltered");
    });

    it("6.12: adding attachments renders chip in #composer-attachments and enables send button", () => {
      assert.equal(view.el.attachments.hidden, true);

      view.pendingAttachments.push({ id: "att_1", name: "architecture.pdf", size: 4096 });
      view.renderAttachments();
      view.syncSendButtonState();

      assert.equal(view.el.attachments.hidden, false, "Attachment bar visible");
      const chip = view.el.attachments.querySelector('[data-att-id="att_1"]');
      assert.ok(chip, "Attachment chip exists");
      assert.ok(chip.textContent.includes("architecture.pdf"));
      assert.equal(view.el.send.disabled, false, "Send enabled with attachment even if input is empty");
    });

    it("6.13: clicking remove button on attachment chip deletes it from pending list", () => {
      view.pendingAttachments = [
        { id: "a1", name: "file1.txt" },
        { id: "a2", name: "file2.txt" },
      ];
      view.renderAttachments();
      assert.equal(view.el.attachments.querySelectorAll(".attachment-chip").length, 2);

      const removeBtn = view.el.attachments.querySelector('[data-remove-id="a1"]');
      removeBtn.click();

      assert.equal(view.pendingAttachments.length, 1);
      assert.equal(view.pendingAttachments[0].id, "a2");
      assert.equal(view.el.attachments.querySelectorAll(".attachment-chip").length, 1);
    });

    it("6.14: send button transforms to pulsing stop square during active generation (round = true)", () => {
      assert.equal(view.el.send.classList.contains("is-stop"), false);
      assert.equal(view.el.send.title, "发送");

      // Set round active
      state.activity[roomId].round = true;
      view.syncSendButtonState();

      assert.equal(view.el.send.classList.contains("is-stop"), true, "Gains .is-stop class");
      assert.equal(view.el.send.title, "停止生成", "Title updates to 停止生成");
      assert.ok(view.el.send.innerHTML.includes("stop-icon"), "Contains stop icon");
      assert.equal(view.el.send.disabled, false, "Stop button is enabled");
    });

    it("6.15: clicking stop button halts active room generation and reverts send button", () => {
      state.activity[roomId].round = true;
      view.syncSendButtonState();
      assert.equal(view.el.send.classList.contains("is-stop"), true);

      // Click stop
      view.el.send.click();

      assert.equal(state.activity[roomId].round, false, "Generation round flag cleared");
      assert.equal(view.el.send.classList.contains("is-stop"), false, "Reverts from stop button");
      assert.equal(view.el.send.title, "发送", "Title reverts to 发送");
    });
  });
});
