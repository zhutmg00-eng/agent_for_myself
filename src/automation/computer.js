/**
 * Computer Use runtime & pi ToolDefinition factory (ZCode-inspired ergonomics).
 *
 * Provides window awareness + desktop screenshots + precise mouse/keyboard
 * actions across:
 *   - Windows (`win32`): zero-extra-dependency PowerShell + Win32 user32.dll + System.Drawing
 *   - macOS (`darwin`): screencapture + osascript (and cliclick if available)
 *   - Linux (`linux`): scrot/import + xdotool + wmctrl when X11 DISPLAY is present
 *   - Optional remote/local CUA/MCP HTTP bridge via `FUSION_COMPUTER_USE_URL`
 *
 * Security invariants:
 *   1. OFF by default — requires explicit manual user permission (`can_use_computer`).
 *   2. Global emergency kill switch immediately blocks every action.
 *   3. All mutating desktop actions require approval under `smart` & `ask` modes.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DIRS, assertNotC } from "../config.js";
import { createLogger } from "../log.js";

const execFileAsync = promisify(execFile);
const log = createLogger("automation.computer");

export const COMPUTER_TOOL_NAMES = Object.freeze([
  "computer_list_windows",
  "computer_focus_window",
  "computer_screenshot",
  "computer_click",
  "computer_drag",
  "computer_type",
  "computer_hotkey",
  "computer_scroll",
  "computer_wait",
]);

export const COMPUTER_READONLY_TOOLS = Object.freeze([
  "computer_list_windows",
  "computer_screenshot",
  "computer_wait",
]);

const DEFAULT_TIMEOUT_MS = 20_000;

function artifactsDir() {
  const dir = assertNotC(path.join(DIRS.dataRoot, "automation", "artifacts"), "automation artifacts");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function defaultExec(binary, args, opts = {}) {
  return execFileAsync(binary, args, {
    timeout: opts.timeout || DEFAULT_TIMEOUT_MS,
    maxBuffer: 12 * 1024 * 1024,
    windowsHide: true,
  });
}

function fail(message) {
  const err = new Error(String(message));
  err.isToolError = true;
  throw err;
}

function clampCoord(val, label) {
  const n = Math.round(Number(val));
  if (!Number.isFinite(n) || n < 0 || n > 16384) {
    fail(`非法坐标 ${label}：${val}（需为 0–16384 之间的整数）`);
  }
  return n;
}

/** Encode text safely for Windows PowerShell -EncodedCommand (UTF-16LE base64). */
export function psEncoded(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

/** Map friendly hotkey string like "Ctrl+Shift+S" to PowerShell SendKeys syntax. */
export function toWindowsSendKeys(combo) {
  const parts = String(combo || "")
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return "";
  const map = {
    ctrl: "^",
    control: "^",
    alt: "%",
    shift: "+",
    enter: "{ENTER}",
    return: "{ENTER}",
    tab: "{TAB}",
    esc: "{ESC}",
    escape: "{ESC}",
    backspace: "{BACKSPACE}",
    delete: "{DELETE}",
    del: "{DELETE}",
    up: "{UP}",
    down: "{DOWN}",
    left: "{LEFT}",
    right: "{RIGHT}",
    home: "{HOME}",
    end: "{END}",
    pageup: "{PGUP}",
    pagedown: "{PGDN}",
    space: " ",
  };
  let prefix = "";
  let key = "";
  for (const raw of parts) {
    const low = raw.toLowerCase();
    if (["ctrl", "control", "alt", "shift"].includes(low)) {
      prefix += map[low];
    } else if (map[low]) {
      key = map[low];
    } else if (/^f\d{1,2}$/i.test(raw)) {
      key = `{${raw.toUpperCase()}}`;
    } else {
      key = raw.length === 1 ? raw.toLowerCase() : raw;
    }
  }
  return `${prefix}${key}`;
}

/** Escape literal text for Windows SendKeys so special symbols don't trigger shortcuts. */
export function escapeWindowsSendKeysText(text) {
  return String(text ?? "").replace(/([+^%~(){}])/g, "{$1}");
}

/** Map friendly hotkey string like "Ctrl+S" to xdotool key syntax ("ctrl+s"). */
export function toXdotoolKey(combo) {
  const map = {
    ctrl: "ctrl",
    control: "ctrl",
    alt: "alt",
    shift: "shift",
    cmd: "super",
    meta: "super",
    win: "super",
    enter: "Return",
    return: "Return",
    tab: "Tab",
    esc: "Escape",
    escape: "Escape",
    backspace: "BackSpace",
    delete: "Delete",
    space: "space",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    pageup: "Page_Up",
    pagedown: "Page_Down",
  };
  return String(combo || "")
    .split("+")
    .map((p) => {
      const clean = p.trim();
      const low = clean.toLowerCase();
      return map[low] || (clean.length === 1 ? clean.toLowerCase() : clean);
    })
    .filter(Boolean)
    .join("+");
}

const obj = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });

export class ComputerDriver {
  /**
   * @param {{
   *   platform?: string,
   *   execImpl?: Function,
   *   fetchImpl?: Function,
   *   remoteUrl?: string,
   *   artifactsRoot?: string,
   *   env?: object,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.platform = opts.platform || process.platform;
    this.execImpl = typeof opts.execImpl === "function" ? opts.execImpl : defaultExec;
    this.fetchImpl = typeof opts.fetchImpl === "function" ? opts.fetchImpl : globalThis.fetch;
    this.remoteUrl = String(opts.remoteUrl ?? process.env.FUSION_COMPUTER_USE_URL ?? "").trim().replace(/\/+$/, "");
    this.artifactsRoot = opts.artifactsRoot || null;
    this.env = opts.env || process.env;
    this.emergencyStopped = false;
    this._detected = null;
  }

  getArtifactsDir() {
    if (this.artifactsRoot) {
      fs.mkdirSync(this.artifactsRoot, { recursive: true });
      return this.artifactsRoot;
    }
    return artifactsDir();
  }

  setEmergencyStop(stopped) {
    this.emergencyStopped = Boolean(stopped);
    return this.emergencyStopped;
  }

  _guardActive() {
    if (this.emergencyStopped) {
      fail("桌面自动化急停开关已启用：所有 Computer Use 操作已被拦截，请在设置中恢复。");
    }
  }

  async detect(force = false) {
    if (this._detected && !force) {
      return { ...this._detected, emergencyStopped: this.emergencyStopped };
    }
    if (this.remoteUrl) {
      this._detected = {
        available: true,
        platform: this.platform,
        driver: "remote-cua-bridge",
        endpoint: this.remoteUrl,
        reason: null,
      };
      return { ...this._detected, emergencyStopped: this.emergencyStopped };
    }
    if (this.platform === "win32") {
      try {
        await this.execImpl("powershell", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { timeout: 5000 });
        this._detected = {
          available: true,
          platform: "win32",
          driver: "windows-win32-powershell",
          reason: null,
        };
      } catch (err) {
        this._detected = {
          available: false,
          platform: "win32",
          driver: "windows-win32-powershell",
          reason: `PowerShell 不可用：${err?.message || err}`,
        };
      }
      return { ...this._detected, emergencyStopped: this.emergencyStopped };
    }
    if (this.platform === "darwin") {
      this._detected = {
        available: true,
        platform: "darwin",
        driver: "macos-osascript-screencapture",
        reason: null,
      };
      return { ...this._detected, emergencyStopped: this.emergencyStopped };
    }
    // Linux: require active X11 DISPLAY + xdotool / scrot
    const display = this.env?.DISPLAY || "";
    if (!display) {
      this._detected = {
        available: false,
        platform: this.platform,
        driver: "linux-x11",
        reason: "当前为无头 Linux 环境（未检测到桌面 DISPLAY）。在 Windows/macOS 桌面端或配置 FUSION_COMPUTER_USE_URL 后可直接操控本机桌面；网页任务请使用 Browser Use。",
      };
      return { ...this._detected, emergencyStopped: this.emergencyStopped };
    }
    try {
      await this.execImpl("which", ["xdotool"], { timeout: 3000 });
      this._detected = {
        available: true,
        platform: "linux",
        driver: "linux-x11-xdotool",
        reason: null,
      };
    } catch {
      this._detected = {
        available: false,
        platform: "linux",
        driver: "linux-x11-xdotool",
        reason: "Linux 桌面模式需安装 xdotool 与 scrot（或配置 FUSION_COMPUTER_USE_URL 接入 trycua/cua）。",
      };
    }
    return { ...this._detected, emergencyStopped: this.emergencyStopped };
  }

  async _callRemote(action, payload = {}) {
    const res = await this.fetchImpl(`${this.remoteUrl}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    if (!res.ok) fail(`远端 Computer Use 桥接返回 HTTP ${res.status}`);
    return res.json();
  }

  async _runPs(script) {
    const { stdout } = await this.execImpl("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      psEncoded(script),
    ]);
    return String(stdout || "").trim();
  }

  async _ensureDesktopReady() {
    this._guardActive();
    const status = await this.detect();
    if (!status.available) fail(status.reason || "当前环境不支持桌面 Computer Use");
  }

  async listWindows() {
    await this._ensureDesktopReady();
    if (this.remoteUrl) return this._callRemote("list_windows");

    if (this.platform === "win32") {
      const out = await this._runPs(`
        Get-Process | Where-Object { $_.MainWindowTitle -ne "" } |
        Select-Object Id, ProcessName, MainWindowTitle |
        ConvertTo-Json -Compress
      `);
      const parsed = out ? JSON.parse(out) : [];
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return {
        windows: rows.filter(Boolean).map((r) => ({
          pid: r.Id,
          process: r.ProcessName,
          title: r.MainWindowTitle,
        })),
      };
    }

    if (this.platform === "darwin") {
      const { stdout } = await this.execImpl("osascript", [
        "-e",
        'tell application "System Events" to get {name, title of every window} of (every process whose background only is false)',
      ]);
      return { windows: [{ title: String(stdout || "").trim() }] };
    }

    const { stdout } = await this.execImpl("wmctrl", ["-lp"]);
    const windows = String(stdout || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(\S+)\s+\S+\s+(\d+)\s+\S+\s+(.*)$/);
        return m ? { id: m[1], pid: Number(m[2]), title: m[3].trim() } : { title: line.trim() };
      });
    return { windows };
  }

  async focusWindow(query) {
    await this._ensureDesktopReady();
    const target = String(query || "").trim();
    if (!target) fail("请提供要切换的窗口标题或进程名关键字");
    if (this.remoteUrl) return this._callRemote("focus_window", { query: target });

    if (this.platform === "win32") {
      const safe = target.replace(/'/g, "''");
      const out = await this._runPs(`
        Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class WinFocus {
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
          [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        }
"@
        $p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${safe}*' -or $_.ProcessName -like '*${safe}*' } | Select-Object -First 1
        if (-not $p) { throw "未找到匹配窗口: ${safe}" }
        [WinFocus]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
        [WinFocus]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
        Write-Output "$($p.ProcessName): $($p.MainWindowTitle)"
      `);
      return { focused: out || target };
    }

    if (this.platform === "darwin") {
      const safe = target.replace(/"/g, '\\"');
      await this.execImpl("osascript", ["-e", `tell application "${safe}" to activate`]);
      return { focused: target };
    }

    await this.execImpl("wmctrl", ["-a", target]);
    return { focused: target };
  }

  async screenshot() {
    await this._ensureDesktopReady();
    const dir = this.getArtifactsDir();
    const filename = `desktop_${Date.now()}_${crypto.randomBytes(3).toString("hex")}.png`;
    const filePath = path.join(dir, filename);

    if (this.remoteUrl) {
      const remote = await this._callRemote("screenshot");
      if (remote?.base64) {
        fs.writeFileSync(filePath, Buffer.from(remote.base64, "base64"));
      }
      return {
        filename,
        filePath,
        artifactUrl: `/api/automation/artifacts/${encodeURIComponent(filename)}`,
        base64: remote?.base64 || null,
        width: remote?.width || null,
        height: remote?.height || null,
      };
    }

    let width = null;
    let height = null;
    if (this.platform === "win32") {
      const safePath = filePath.replace(/'/g, "''");
      const dims = await this._runPs(`
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
        $bmp.Save('${safePath}', [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        Write-Output "$($b.Width)x$($b.Height)"
      `);
      const m = dims.match(/(\d+)x(\d+)/);
      if (m) {
        width = Number(m[1]);
        height = Number(m[2]);
      }
    } else if (this.platform === "darwin") {
      await this.execImpl("screencapture", ["-x", filePath]);
    } else {
      await this.execImpl("scrot", [filePath]);
    }

    let base64 = null;
    if (fs.existsSync(filePath)) {
      base64 = fs.readFileSync(filePath).toString("base64");
    }
    return {
      filename,
      filePath,
      artifactUrl: `/api/automation/artifacts/${encodeURIComponent(filename)}`,
      base64,
      width,
      height,
    };
  }

  async click({ x, y, button = "left", clicks = 1 } = {}) {
    await this._ensureDesktopReady();
    const px = clampCoord(x, "x");
    const py = clampCoord(y, "y");
    const btn = ["left", "right", "middle"].includes(String(button).toLowerCase()) ? String(button).toLowerCase() : "left";
    const count = Math.max(1, Math.min(3, Math.trunc(Number(clicks) || 1)));
    if (this.remoteUrl) return this._callRemote("click", { x: px, y: py, button: btn, clicks: count });

    if (this.platform === "win32") {
      const flags = btn === "right" ? [0x08, 0x10] : btn === "middle" ? [0x20, 0x40] : [0x02, 0x04];
      await this._runPs(`
        Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class WinMouse {
          [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
          [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
        }
"@
        [WinMouse]::SetCursorPos(${px}, ${py}) | Out-Null
        for ($i = 0; $i -lt ${count}; $i++) {
          [WinMouse]::mouse_event(${flags[0]}, 0, 0, 0, [UIntPtr]::Zero)
          [WinMouse]::mouse_event(${flags[1]}, 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 40
        }
      `);
      return { x: px, y: py, button: btn, clicks: count };
    }

    if (this.platform === "darwin") {
      const action = btn === "right" ? "rc" : count === 2 ? "dc" : "c";
      await this.execImpl("cliclick", [`${action}:${px},${py}`]);
      return { x: px, y: py, button: btn, clicks: count };
    }

    const xBtn = btn === "right" ? "3" : btn === "middle" ? "2" : "1";
    await this.execImpl("xdotool", ["mousemove", String(px), String(py), "click", "--repeat", String(count), xBtn]);
    return { x: px, y: py, button: btn, clicks: count };
  }

  async drag({ from_x, from_y, to_x, to_y } = {}) {
    await this._ensureDesktopReady();
    const x1 = clampCoord(from_x, "from_x");
    const y1 = clampCoord(from_y, "from_y");
    const x2 = clampCoord(to_x, "to_x");
    const y2 = clampCoord(to_y, "to_y");
    if (this.remoteUrl) return this._callRemote("drag", { from_x: x1, from_y: y1, to_x: x2, to_y: y2 });

    if (this.platform === "win32") {
      await this._runPs(`
        Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class WinDrag {
          [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
          [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
        }
"@
        [WinDrag]::SetCursorPos(${x1}, ${y1}) | Out-Null
        [WinDrag]::mouse_event(0x02, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [WinDrag]::SetCursorPos(${x2}, ${y2}) | Out-Null
        Start-Sleep -Milliseconds 60
        [WinDrag]::mouse_event(0x04, 0, 0, 0, [UIntPtr]::Zero)
      `);
      return { from_x: x1, from_y: y1, to_x: x2, to_y: y2 };
    }

    if (this.platform === "darwin") {
      await this.execImpl("cliclick", [`dd:${x1},${y1}`, `du:${x2},${y2}`]);
      return { from_x: x1, from_y: y1, to_x: x2, to_y: y2 };
    }

    await this.execImpl("xdotool", ["mousemove", String(x1), String(y1), "mousedown", "1", "mousemove", String(x2), String(y2), "mouseup", "1"]);
    return { from_x: x1, from_y: y1, to_x: x2, to_y: y2 };
  }

  async type(text) {
    await this._ensureDesktopReady();
    const value = String(text ?? "");
    if (!value) fail("请提供要输入的文本内容");
    if (this.remoteUrl) return this._callRemote("type", { text: value });

    if (this.platform === "win32") {
      const escaped = escapeWindowsSendKeysText(value).replace(/'/g, "''");
      await this._runPs(`
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait('${escaped}')
      `);
      return { typed: value.length };
    }

    if (this.platform === "darwin") {
      const safe = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      await this.execImpl("osascript", ["-e", `tell application "System Events" to keystroke "${safe}"`]);
      return { typed: value.length };
    }

    await this.execImpl("xdotool", ["type", "--clearmodifiers", "--", value]);
    return { typed: value.length };
  }

  async hotkey(combo) {
    await this._ensureDesktopReady();
    const clean = String(combo || "").trim();
    if (!clean) fail("请提供快捷键组合（例如 Ctrl+S、Alt+Tab、Enter）");
    if (this.remoteUrl) return this._callRemote("hotkey", { combo: clean });

    if (this.platform === "win32") {
      const keys = toWindowsSendKeys(clean).replace(/'/g, "''");
      await this._runPs(`
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait('${keys}')
      `);
      return { combo: clean };
    }

    if (this.platform === "darwin") {
      await this.execImpl("osascript", ["-e", `tell application "System Events" to keystroke "${clean.replace(/"/g, '\\"')}"`]);
      return { combo: clean };
    }

    await this.execImpl("xdotool", ["key", "--clearmodifiers", toXdotoolKey(clean)]);
    return { combo: clean };
  }

  async scroll({ x = null, y = null, delta_y = -3 } = {}) {
    await this._ensureDesktopReady();
    const dy = Math.trunc(Number(delta_y) || -3);
    if (this.remoteUrl) return this._callRemote("scroll", { x, y, delta_y: dy });

    if (this.platform === "win32") {
      const moveCode = x !== null && y !== null ? `[WinScroll]::SetCursorPos(${clampCoord(x, "x")}, ${clampCoord(y, "y")}) | Out-Null` : "";
      const wheel = dy * 120;
      await this._runPs(`
        Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class WinScroll {
          [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
          [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
        }
"@
        ${moveCode}
        [WinScroll]::mouse_event(0x0800, 0, 0, ${wheel}, [UIntPtr]::Zero)
      `);
      return { delta_y: dy };
    }

    if (this.platform === "linux") {
      const args = [];
      if (x !== null && y !== null) args.push("mousemove", String(clampCoord(x, "x")), String(clampCoord(y, "y")));
      const btn = dy < 0 ? "5" : "4";
      args.push("click", "--repeat", String(Math.max(1, Math.min(20, Math.abs(dy)))), btn);
      await this.execImpl("xdotool", args);
      return { delta_y: dy };
    }

    return { delta_y: dy, note: "macOS scroll requires remote CUA bridge or cliclick extension" };
  }

  async wait(ms = 1000) {
    this._guardActive();
    const clamped = Math.max(100, Math.min(10_000, Math.trunc(Number(ms) || 1000)));
    await new Promise((r) => setTimeout(r, clamped));
    return { waited_ms: clamped };
  }
}

/**
 * Build pi ToolDefinition[] for Computer Use bound to one member.
 * Every execute() double-checks live manual permission (`canUse()`).
 */
export function createComputerTools({ driver, canUse, botId } = {}) {
  if (!driver) return [];
  const guard = () => {
    if (typeof canUse === "function" && !canUse()) {
      fail(`权限不足：成员 ${botId || ""} 尚未获得 Computer Use 手动授权，请在右侧「群信息 → 成员」点击开启。`);
    }
  };
  const ok = (text, details = {}, imageBase64 = null) => {
    const content = [{ type: "text", text: String(text) }];
    if (imageBase64) {
      content.push({ type: "image", data: imageBase64, mimeType: "image/png" });
    }
    return { content, details };
  };

  return [
    {
      name: "computer_list_windows",
      label: "列举桌面窗口",
      description: "列出当前本机桌面上全部可见应用窗口（标题、进程名、PID），对齐 ZCode 窗口感知能力。",
      parameters: obj({}),
      execute: async () => {
        guard();
        const res = await driver.listWindows();
        const lines = (res.windows || []).map((w) => `- ${w.process ? `[${w.process}] ` : ""}${w.title || "(无标题)"}${w.pid ? ` (PID ${w.pid})` : ""}`);
        return ok(lines.length ? lines.join("\n") : "（当前未检测到可见窗口）", res);
      },
    },
    {
      name: "computer_focus_window",
      label: "切换桌面窗口",
      description: "按窗口标题或进程名关键字将目标应用窗口置顶并获取焦点。",
      parameters: obj({ query: str("窗口标题或进程名关键字（例如 Chrome、VSCode、Notepad）") }, ["query"]),
      execute: async (_id, params = {}) => {
        guard();
        const res = await driver.focusWindow(params.query);
        return ok(`已将窗口置顶：${res.focused || params.query}`, res);
      },
    },
    {
      name: "computer_screenshot",
      label: "截取桌面屏幕",
      description: "截取本机当前桌面高清 PNG 画面（多模态模型可直接观察界面与坐标，同时返回预览链接）。",
      parameters: obj({}),
      execute: async () => {
        guard();
        const res = await driver.screenshot();
        const dims = res.width && res.height ? ` (${res.width}x${res.height})` : "";
        return ok(
          `桌面截图已保存${dims}：${res.artifactUrl}\n本地文件：${res.filePath}`,
          { artifact_url: res.artifactUrl, filename: res.filename, width: res.width, height: res.height },
          res.base64,
        );
      },
    },
    {
      name: "computer_click",
      label: "桌面鼠标点击",
      description: "移动鼠标至桌面坐标 (x, y) 并执行单击/双击/右键点击。操作前应先调用 computer_screenshot 确认坐标。",
      parameters: obj(
        {
          x: num("屏幕横坐标 x（像素）"),
          y: num("屏幕纵坐标 y（像素）"),
          button: str("鼠标按键：left（默认）、right、middle"),
          clicks: num("点击次数：1（单击，默认）或 2（双击）"),
        },
        ["x", "y"],
      ),
      execute: async (_id, params = {}) => {
        guard();
        const res = await driver.click(params);
        return ok(`已在 (${res.x}, ${res.y}) 执行 ${res.button} 键点击 ×${res.clicks}`, res);
      },
    },
    {
      name: "computer_drag",
      label: "桌面鼠标拖拽",
      description: "按住鼠标左键从 (from_x, from_y) 拖拽至 (to_x, to_y)。",
      parameters: obj(
        {
          from_x: num("起点 x"),
          from_y: num("起点 y"),
          to_x: num("终点 x"),
          to_y: num("终点 y"),
        },
        ["from_x", "from_y", "to_x", "to_y"],
      ),
      execute: async (_id, params = {}) => {
        guard();
        const res = await driver.drag(params);
        return ok(`已从 (${res.from_x}, ${res.from_y}) 拖拽至 (${res.to_x}, ${res.to_y})`, res);
      },
    },
    {
      name: "computer_type",
      label: "桌面键盘输入",
      description: "向当前聚焦的桌面应用窗口输入文本内容。",
      parameters: obj({ text: str("要输入的文本") }, ["text"]),
      execute: async (_id, params = {}) => {
        guard();
        const res = await driver.type(params.text);
        return ok(`已向当前桌面窗口输入 ${res.typed} 个字符`, res);
      },
    },
    {
      name: "computer_hotkey",
      label: "桌面快捷键",
      description: "发送组合快捷键（例如 Ctrl+S、Ctrl+C、Alt+Tab、Enter、Escape）。",
      parameters: obj({ combo: str("组合键，例如 Ctrl+S 或 Alt+Tab") }, ["combo"]),
      execute: async (_id, params = {}) => {
        guard();
        const res = await driver.hotkey(params.combo);
        return ok(`已发送桌面快捷键：${res.combo}`, res);
      },
    },
    {
      name: "computer_scroll",
      label: "桌面滚轮滚动",
      description: "在指定坐标（或当前鼠标位置）滚动鼠标滚轮，delta_y 为负数向下滚、正数向上滚。",
      parameters: obj({
        x: num("可选：目标横坐标 x"),
        y: num("可选：目标纵坐标 y"),
        delta_y: num("滚动格数：负数为向下（如 -5），正数为向上（如 5）"),
      }),
      execute: async (_id, params = {}) => {
        guard();
        const res = await driver.scroll(params);
        return ok(`已执行桌面滚轮滚动（delta_y=${res.delta_y}）`, res);
      },
    },
    {
      name: "computer_wait",
      label: "等待界面响应",
      description: "暂停等待桌面应用加载或动画完成（100–10000ms），常用于操作后重新截图前。",
      parameters: obj({ ms: num("等待毫秒数（100–10000，默认 1000）") }),
      execute: async (_id, params = {}) => {
        guard();
        const res = await driver.wait(params.ms);
        return ok(`已等待 ${res.waited_ms}ms`, res);
      },
    },
  ];
}

export default ComputerDriver;
