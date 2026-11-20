/**
 * Unit & integration tests for Browser Use & Computer Use + manual permission gating.
 */
import { TEST_DATA_ROOT, onCleanup } from "./_helpers/env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BrowserManager,
  BROWSER_TOOL_NAMES,
  createBrowserTools,
  validateBrowserUrl,
  sanitizeSessionName,
} from "../src/automation/browser.js";
import {
  ComputerDriver,
  COMPUTER_TOOL_NAMES,
  createComputerTools,
  psEncoded,
  toWindowsSendKeys,
  escapeWindowsSendKeysText,
  toXdotoolKey,
} from "../src/automation/computer.js";
import { createApproval } from "../src/approval.js";
import { Store, defaultPermissions } from "../src/store.js";
import { createRoomTools } from "../src/rooms/tools.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0s0AAAAASUVORK5CYII=",
  "base64",
);

function mkTmpArtifacts() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "af-auto-test-"));
}

test("Browser URL validation & session sanitization", () => {
  assert.equal(validateBrowserUrl("example.com"), "https://example.com/");
  assert.equal(validateBrowserUrl("http://127.0.0.1:3000/test"), "http://127.0.0.1:3000/test");
  assert.throws(() => validateBrowserUrl(""), /URL/);
  assert.throws(() => validateBrowserUrl("file:///etc/passwd"), /http\/https/);
  assert.throws(() => validateBrowserUrl("javascript:alert(1)"), /http\/https/);

  assert.equal(sanitizeSessionName("room 1 / Coder!"), "af-room-1-coder");
  assert.equal(sanitizeSessionName(""), "af-default");
});

test("BrowserManager & all 9 browser_* tools enforce manual permission & kill switch", async () => {
  const dir = mkTmpArtifacts();
  const calls = [];
  const execImpl = async (bin, args) => {
    calls.push({ bin, args });
    if (args.includes("--version")) return { stdout: "playwright-cli 0.1.0\n", stderr: "" };
    const fnArg = args.find((a) => a.startsWith("--filename="));
    if (fnArg) {
      const target = fnArg.slice("--filename=".length);
      fs.writeFileSync(target, PNG_1X1);
      return { stdout: `Saved ${target}`, stderr: "" };
    }
    return { stdout: `ok ${args.join(" ")}`, stderr: "" };
  };

  const mgr = new BrowserManager({ execImpl, artifactsRoot: dir });
  const det = await mgr.detect(true);
  assert.equal(det.available, true);
  assert.equal(det.driver, "playwright-cli");

  let granted = false;
  const tools = createBrowserTools({
    manager: mgr,
    roomId: "r1",
    botId: "coder",
    canUse: () => granted,
  });
  assert.deepEqual(tools.map((t) => t.name), [...BROWSER_TOOL_NAMES]);

  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  // Denied when not manually granted
  await assert.rejects(
    () => byName.browser_open.execute("c1", { url: "https://example.com" }),
    /Browser Use 手动授权/,
  );

  // Manually grant -> all 9 tools work
  granted = true;
  const openRes = await byName.browser_open.execute("c2", { url: "example.com" });
  assert.match(openRes.content[0].text, /https:\/\/example\.com\//);

  const snapRes = await byName.browser_snapshot.execute("c3", {});
  assert.match(snapRes.content[0].text, /snapshot/);

  const shotRes = await byName.browser_screenshot.execute("c4", { full_page: true });
  assert.match(shotRes.content[0].text, /\/api\/automation\/artifacts\/browser_.*\.png/);
  assert.equal(shotRes.content.some((c) => c.type === "image" && c.mimeType === "image/png"), true);

  await byName.browser_click.execute("c5", { ref: "e12" });
  await byName.browser_type.execute("c6", { ref: "e13", text: "hello", submit: true });
  await byName.browser_press.execute("c7", { key: "Enter" });
  await byName.browser_scroll.execute("c8", { delta_y: 400 });
  await byName.browser_eval.execute("c9", { expression: "document.title" });
  await byName.browser_close.execute("c10", {});

  // Kill switch blocks execution
  mgr.setEmergencyStop(true);
  await assert.rejects(
    () => byName.browser_open.execute("c11", { url: "https://example.com" }),
    /急停/,
  );
  mgr.setEmergencyStop(false);

  // Revoke permission live -> immediately blocked
  granted = false;
  await assert.rejects(
    () => byName.browser_snapshot.execute("c12", {}),
    /Browser Use 手动授权/,
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test("Computer key mapping helpers (Windows SendKeys & xdotool)", () => {
  assert.equal(toWindowsSendKeys("Ctrl+Shift+S"), "^+s");
  assert.equal(toWindowsSendKeys("Alt+F4"), "%{F4}");
  assert.equal(toWindowsSendKeys("Ctrl+Enter"), "^{ENTER}");
  assert.equal(escapeWindowsSendKeysText("a+b%(c)"), "a{+}b{%}{(}c{)}");
  assert.equal(toXdotoolKey("Ctrl+Shift+C"), "ctrl+shift+c");
  assert.equal(toXdotoolKey("Alt+Tab"), "alt+Tab");
  assert.ok(Buffer.from(psEncoded("hello"), "base64").toString("utf16le") === "hello");
});

test("ComputerDriver headless linux fallback vs mocked win32 & all 9 computer_* tools", async () => {
  const dir = mkTmpArtifacts();

  // Headless Linux without DISPLAY -> cleanly reports unavailable
  const headless = new ComputerDriver({
    platform: "linux",
    env: {},
    remoteUrl: "",
    artifactsRoot: dir,
    execImpl: async () => ({ stdout: "", stderr: "" }),
  });
  const hDet = await headless.detect(true);
  assert.equal(hDet.available, false);
  assert.match(String(hDet.reason || ""), /图形桌面|DISPLAY/);

  // Mocked Windows driver -> available and executes all 9 tools
  const winDriver = new ComputerDriver({
    platform: "win32",
    remoteUrl: "",
    artifactsRoot: dir,
    execImpl: async (bin, args) => {
      const encIdx = args.indexOf("-EncodedCommand");
      if (encIdx >= 0) {
        const script = Buffer.from(args[encIdx + 1], "base64").toString("utf16le");
        if (script.includes("MainWindowTitle")) {
          return { stdout: JSON.stringify([{ Id: 123, ProcessName: "Code", MainWindowTitle: "VS Code" }]), stderr: "" };
        }
        const m = script.match(/Save\('([^']+\.png)'/);
        if (m) {
          fs.writeFileSync(m[1], PNG_1X1);
          return { stdout: "1920x1080", stderr: "" };
        }
      }
      return { stdout: "5.1", stderr: "" };
    },
  });

  const wDet = await winDriver.detect(true);
  assert.equal(wDet.available, true);
  assert.equal(wDet.driver, "windows-win32-powershell");

  let granted = false;
  const tools = createComputerTools({
    driver: winDriver,
    botId: "coder",
    canUse: () => granted,
  });
  assert.deepEqual(tools.map((t) => t.name), [...COMPUTER_TOOL_NAMES]);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  // Denied when not manually granted
  await assert.rejects(() => byName.computer_list_windows.execute("c1", {}), /Computer Use 手动授权/);

  granted = true;
  const winList = await byName.computer_list_windows.execute("c2", {});
  assert.match(winList.content[0].text, /VS Code/);

  await byName.computer_focus_window.execute("c3", { query: "VS Code" });
  const shot = await byName.computer_screenshot.execute("c4", {});
  assert.match(shot.content[0].text, /\/api\/automation\/artifacts\/desktop_.*\.png/);
  assert.equal(shot.content.some((c) => c.type === "image"), true);

  await byName.computer_click.execute("c5", { x: 120, y: 240, button: "left", clicks: 1 });
  await byName.computer_drag.execute("c6", { from_x: 10, from_y: 20, to_x: 100, to_y: 200 });
  await byName.computer_type.execute("c7", { text: "hello world" });
  await byName.computer_hotkey.execute("c8", { combo: "Ctrl+S" });
  await byName.computer_scroll.execute("c9", { delta_y: -300 });
  await byName.computer_wait.execute("c10", { ms: 100 });

  // Emergency stop blocks
  winDriver.setEmergencyStop(true);
  await assert.rejects(() => byName.computer_click.execute("c11", { x: 10, y: 10 }), /急停/);
  winDriver.setEmergencyStop(false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("Approval classifier distinguishes read-only vs mutating automation tools", () => {
  const dbPath = path.join(TEST_DATA_ROOT, "data", "auto-approval.db");
  const store = new Store(dbPath);
  onCleanup(() => store.close());
  const appr = createApproval({ store });
  const ctx = { roomId: "r_auto_appr", botId: "coder" };

  appr.setMode("smart");
  assert.equal(appr.evaluate({ tool: "browser_snapshot", input: {}, ...ctx }).decision, "allow");
  assert.equal(appr.evaluate({ tool: "browser_screenshot", input: {}, ...ctx }).decision, "allow");
  assert.equal(appr.evaluate({ tool: "computer_list_windows", input: {}, ...ctx }).decision, "allow");
  assert.equal(appr.evaluate({ tool: "computer_screenshot", input: {}, ...ctx }).decision, "allow");
  assert.equal(appr.evaluate({ tool: "computer_wait", input: {}, ...ctx }).decision, "allow");

  assert.equal(appr.evaluate({ tool: "computer_click", input: { x: 10, y: 20 }, ...ctx }).decision, "ask");
  assert.equal(appr.evaluate({ tool: "computer_type", input: { text: "hi" }, ...ctx }).decision, "ask");
  assert.equal(appr.evaluate({ tool: "computer_hotkey", input: { keys: "Ctrl+S" }, ...ctx }).decision, "ask");
  assert.equal(appr.evaluate({ tool: "browser_open", input: { url: "https://example.com" }, ...ctx }).decision, "ask");
  assert.equal(appr.evaluate({ tool: "browser_click", input: { ref: "e1" }, ...ctx }).decision, "ask");

  appr.setMode("yolo");
  assert.equal(appr.evaluate({ tool: "computer_click", input: { x: 10, y: 20 }, ...ctx }).decision, "allow");
});

test("Permissions default OFF and createRoomTools mounts automation tools only after manual grant", async () => {
  const def = defaultPermissions();
  assert.equal(def.can_use_browser, false);
  assert.equal(def.can_use_computer, false);

  const dir = mkTmpArtifacts();
  try {
    const browser = new BrowserManager({
      artifactsRoot: dir,
      execImpl: async () => ({ stdout: "ok", stderr: "" }),
    });
    const computer = new ComputerDriver({
      platform: "win32",
      artifactsRoot: dir,
      execImpl: async () => ({ stdout: "ok", stderr: "" }),
    });

    const perms = {
      coder: { ...defaultPermissions() },
      boss: { ...defaultPermissions(), can_create_subgroup: true },
    };
    const fakeRoom = {
      room_id: "r_auto",
      owner_id: "boss",
      members: ["boss", "coder"],
      isOwner: (id) => id === "boss",
      permissionsOf: (id) => perms[id] || defaultPermissions(),
      listMembers: () => [],
      contextPolicy: "shared",
      record: { title: "Auto Test", topic: "" },
    };

    // Before manual grant -> 0 browser_* and 0 computer_* tools
    const beforeTools = createRoomTools({
      room: fakeRoom,
      botId: "coder",
      permissions: perms.coder,
      automation: { browser, computer },
    }).map((t) => t.name);
    assert.equal(beforeTools.some((n) => n.startsWith("browser_")), false);
    assert.equal(beforeTools.some((n) => n.startsWith("computer_")), false);

    // Owner's room_grant_permission schema does NOT expose browser/computer grant fields
    const ownerTools = createRoomTools({
      room: fakeRoom,
      botId: "boss",
      permissions: perms.boss,
      automation: { browser, computer },
    });
    const grantTool = ownerTools.find((t) => t.name === "room_grant_permission");
    assert.ok(grantTool);
    assert.equal("can_use_browser" in grantTool.parameters.properties, false);
    assert.equal("can_use_computer" in grantTool.parameters.properties, false);

    // After manual grant -> all 9 browser_* and all 9 computer_* tools mounted
    perms.coder.can_use_browser = true;
    perms.coder.can_use_computer = true;
    const afterTools = createRoomTools({
      room: fakeRoom,
      botId: "coder",
      permissions: perms.coder,
      automation: { browser, computer },
    }).map((t) => t.name);
    for (const name of BROWSER_TOOL_NAMES) assert.ok(afterTools.includes(name), `missing ${name}`);
    for (const name of COMPUTER_TOOL_NAMES) assert.ok(afterTools.includes(name), `missing ${name}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
