/**
 * Browser Use runtime & pi ToolDefinition factory.
 *
 * Driven by `playwright-cli` (zero npm overhead, isolated per-room/per-member
 * browser sessions, works across Linux, macOS, and Windows). Every tool enforces
 * the member's explicit manual permission grant (`can_use_browser`) and respects
 * the global emergency kill switch.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DIRS, assertNotC } from "../config.js";
import { createLogger } from "../log.js";

const execFileAsync = promisify(execFile);
const log = createLogger("automation.browser");

export const BROWSER_TOOL_NAMES = Object.freeze([
  "browser_open",
  "browser_snapshot",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_eval",
  "browser_close",
]);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 16_000;

export function artifactsDir() {
  const dir = assertNotC(path.join(DIRS.dataRoot, "automation", "artifacts"), "automation artifacts");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sanitizeSessionName(raw) {
  const clean = String(raw || "default")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return `af-${clean || "default"}`;
}

/** Validate URL scheme to prevent local file exfiltration or javascript: execution. */
export function validateBrowserUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) throw new Error("请提供要访问的 URL（例如 https://example.com）");
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?:\/\/|[^0-9])/.test(value);
  const withScheme = hasScheme ? value : `https://${value}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`无效的 URL：${value}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`出于安全限制，仅允许 http/https 协议，拒绝：${parsed.protocol}`);
  }
  return parsed.toString();
}

function clipText(text, max = MAX_OUTPUT_CHARS) {
  const s = String(text ?? "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（输出已截断，共 ${s.length} 字符）`;
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

const obj = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const bool = (description) => ({ type: "boolean", description });

export class BrowserManager {
  /**
   * @param {{ binary?: string, execImpl?: Function, artifactsRoot?: string }} [opts]
   */
  constructor(opts = {}) {
    this.binary = opts.binary || process.env.FUSION_PLAYWRIGHT_CLI || "playwright-cli";
    this.execImpl = typeof opts.execImpl === "function" ? opts.execImpl : defaultExec;
    this.artifactsRoot = opts.artifactsRoot || null;
    this.emergencyStopped = false;
    this.sessions = new Map(); // sessionName -> { url, updatedAt, botId, roomId }
    this._detected = null;
  }

  getArtifactsDir() {
    if (this.artifactsRoot) {
      fs.mkdirSync(this.artifactsRoot, { recursive: true });
      return this.artifactsRoot;
    }
    return artifactsDir();
  }

  async detect(force = false) {
    if (this._detected && !force) return { ...this._detected, activeSessions: this.sessions.size, emergencyStopped: this.emergencyStopped };
    try {
      const { stdout } = await this.execImpl(this.binary, ["--version"], { timeout: 5000 });
      this._detected = {
        available: true,
        driver: "playwright-cli",
        binary: this.binary,
        version: String(stdout || "").trim().split(/\r?\n/)[0] || "ready",
        reason: null,
      };
    } catch (err) {
      this._detected = {
        available: false,
        driver: "playwright-cli",
        binary: this.binary,
        version: null,
        reason: `未检测到 playwright-cli（${err?.message || "not found"}）。请安装 @playwright/cli 或设置 FUSION_PLAYWRIGHT_CLI。`,
      };
    }
    return { ...this._detected, activeSessions: this.sessions.size, emergencyStopped: this.emergencyStopped };
  }

  setEmergencyStop(stopped) {
    this.emergencyStopped = Boolean(stopped);
    return this.emergencyStopped;
  }

  async runCli(sessionName, args, opts = {}) {
    if (this.emergencyStopped) {
      fail("自动化急停开关已启用：所有 Browser Use 操作已被暂停，请在设置中恢复后再试。");
    }
    const fullArgs = [`-s=${sessionName}`, ...args];
    try {
      const { stdout, stderr } = await this.execImpl(this.binary, fullArgs, opts);
      return { stdout: String(stdout || ""), stderr: String(stderr || "") };
    } catch (err) {
      const detail = err?.stderr || err?.stdout || err?.message || String(err);
      fail(`Browser Use 执行失败（${args[0] || "cmd"}）：${clipText(detail, 1200)}`);
    }
  }

  async open(sessionName, rawUrl, meta = {}) {
    const url = validateBrowserUrl(rawUrl);
    const { stdout } = await this.runCli(sessionName, ["open", url]);
    this.sessions.set(sessionName, { url, updatedAt: new Date().toISOString(), ...meta });
    return { url, output: clipText(stdout) };
  }

  async snapshot(sessionName) {
    const { stdout } = await this.runCli(sessionName, ["snapshot"]);
    return { output: clipText(stdout) };
  }

  async screenshot(sessionName, { fullPage = false } = {}) {
    const dir = this.getArtifactsDir();
    const filename = `browser_${Date.now()}_${crypto.randomBytes(3).toString("hex")}.png`;
    const filePath = path.join(dir, filename);
    const args = ["screenshot", `--filename=${filePath}`];
    if (fullPage) args.push("--full-page");
    const { stdout } = await this.runCli(sessionName, args);
    let base64 = null;
    if (fs.existsSync(filePath)) {
      try {
        base64 = fs.readFileSync(filePath).toString("base64");
      } catch (err) {
        log.warn("read browser screenshot failed", err?.message || err);
      }
    }
    return {
      filename,
      filePath,
      artifactUrl: `/api/automation/artifacts/${encodeURIComponent(filename)}`,
      base64,
      output: clipText(stdout),
    };
  }

  async click(sessionName, target) {
    const ref = String(target || "").trim();
    if (!ref) fail("请提供要点击的元素 ref（来自 browser_snapshot）或选择器");
    const { stdout } = await this.runCli(sessionName, ["click", ref]);
    return { output: clipText(stdout) };
  }

  async type(sessionName, target, text, { submit = false } = {}) {
    const ref = String(target || "").trim();
    const value = String(text ?? "");
    if (!ref) fail("请提供要输入的输入框 ref 或选择器");
    const args = ["fill", ref, value];
    const { stdout } = await this.runCli(sessionName, args);
    if (submit) {
      await this.runCli(sessionName, ["press", "Enter"]);
    }
    return { output: clipText(stdout) };
  }

  async press(sessionName, key) {
    const clean = String(key || "").trim();
    if (!clean) fail("请提供按键名称（如 Enter、Tab、Escape、PageDown）");
    const { stdout } = await this.runCli(sessionName, ["press", clean]);
    return { output: clipText(stdout) };
  }

  async scroll(sessionName, { direction = "down", amount = 600 } = {}) {
    const dy = String(direction).toLowerCase() === "up" ? -Math.abs(Number(amount) || 600) : Math.abs(Number(amount) || 600);
    const { stdout } = await this.runCli(sessionName, ["eval", `() => { window.scrollBy(0, ${dy}); return { scrollY: Math.round(window.scrollY), height: document.documentElement.scrollHeight }; }`]);
    return { output: clipText(stdout), dy };
  }

  async evaluate(sessionName, expression) {
    const expr = String(expression || "").trim();
    if (!expr) fail("请提供要在页面执行的 JS 表达式（例如 () => document.title）");
    const { stdout } = await this.runCli(sessionName, ["eval", expr]);
    return { output: clipText(stdout) };
  }

  async close(sessionName) {
    try {
      await this.execImpl(this.binary, [`-s=${sessionName}`, "close"], { timeout: 10_000 });
    } catch {
      /* ignore if already closed */
    }
    this.sessions.delete(sessionName);
    return { closed: true };
  }

  async killAll() {
    this.emergencyStopped = true;
    const names = [...this.sessions.keys()];
    await Promise.allSettled(names.map((name) => this.close(name)));
    this.sessions.clear();
    return { closedSessions: names.length, emergencyStopped: true };
  }
}

/**
 * Build pi ToolDefinition[] for Browser Use bound to one (room, bot) member.
 * Every execute() double-checks live manual permission (`canUse()`) so revoking
 * permission takes effect instantaneously even mid-round.
 */
export function createBrowserTools({ manager, sessionKey, canUse, botId, roomId } = {}) {
  if (!manager) return [];
  const sessionName = sanitizeSessionName(sessionKey || `${roomId || "solo"}-${botId || "bot"}`);
  const guard = () => {
    if (typeof canUse === "function" && !canUse()) {
      fail(`权限不足：成员 ${botId || ""} 尚未获得 Browser Use 手动授权，请在右侧「群信息 → 成员」点击开启。`);
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
      name: "browser_open",
      label: "打开网页",
      description: "使用无头浏览器打开指定 http/https 网页，建立本成员专属的隔离浏览会话。打开后建议紧接调用 browser_snapshot 获取可交互元素 ref。",
      parameters: obj({ url: str("目标网页 URL（仅支持 http/https）") }, ["url"]),
      execute: async (_id, params = {}) => {
        guard();
        const res = await manager.open(sessionName, params.url, { botId, roomId });
        return ok(`已打开网页：${res.url}\n${res.output || ""}`.trim(), res);
      },
    },
    {
      name: "browser_snapshot",
      label: "读取页面结构快照",
      description: "获取当前网页的可访问性元素树与交互 ref（如 e1、e2），便于精准点击与输入，无需盲猜像素坐标。",
      parameters: obj({}),
      execute: async () => {
        guard();
        const res = await manager.snapshot(sessionName);
        return ok(res.output || "（空页面快照）", res);
      },
    },
    {
      name: "browser_screenshot",
      label: "截取网页截图",
      description: "截取当前网页画面并保存为 PNG（多模态模型可直接查看截图内容，同时返回可预览链接）。",
      parameters: obj({ full_page: bool("是否截取整页长图，默认 false（仅当前视口）") }),
      execute: async (_id, params = {}) => {
        guard();
        const res = await manager.screenshot(sessionName, { fullPage: Boolean(params.full_page) });
        return ok(
          `网页截图已保存：${res.artifactUrl}\n本地文件：${res.filePath}`,
          { artifact_url: res.artifactUrl, filename: res.filename },
          res.base64,
        );
      },
    },
    {
      name: "browser_click",
      label: "点击页面元素",
      description: "点击网页中的按钮、链接或控件。优先传入 browser_snapshot 返回的元素 ref（如 e5），也支持 CSS 选择器。",
      parameters: obj({ ref: str("元素 ref（来自 browser_snapshot）或 CSS 选择器") }, ["ref"]),
      execute: async (_id, params = {}) => {
        guard();
        const res = await manager.click(sessionName, params.ref);
        return ok(`已点击元素 ${params.ref}\n${res.output || ""}`.trim(), res);
      },
    },
    {
      name: "browser_type",
      label: "向网页输入框填字",
      description: "向指定 ref 或 CSS 选择器的输入框写入文本，可选 submit=true 自动按回车提交。",
      parameters: obj(
        {
          ref: str("输入框元素 ref 或 CSS 选择器"),
          text: str("要输入的文本内容"),
          submit: bool("可选：输入后是否按 Enter 提交，默认 false"),
        },
        ["ref", "text"],
      ),
      execute: async (_id, params = {}) => {
        guard();
        const res = await manager.type(sessionName, params.ref, params.text, { submit: Boolean(params.submit) });
        return ok(`已在 ${params.ref} 输入文本${params.submit ? "并提交" : ""}\n${res.output || ""}`.trim(), res);
      },
    },
    {
      name: "browser_press",
      label: "网页按键",
      description: "在当前焦点页面发送键盘按键（如 Enter、Tab、Escape、PageDown、ArrowDown）。",
      parameters: obj({ key: str("按键名（如 Enter / Escape / Tab / PageDown）") }, ["key"]),
      execute: async (_id, params = {}) => {
        guard();
        const res = await manager.press(sessionName, params.key);
        return ok(`已发送按键 ${params.key}\n${res.output || ""}`.trim(), res);
      },
    },
    {
      name: "browser_scroll",
      label: "滚动网页",
      description: "上下滚动当前网页并回报最新滚动位置。",
      parameters: obj({
        direction: str("滚动方向：down（向下，默认）或 up（向上）"),
        amount: num("滚动像素，默认 600"),
      }),
      execute: async (_id, params = {}) => {
        guard();
        const res = await manager.scroll(sessionName, { direction: params.direction, amount: params.amount });
        return ok(`已滚动页面（dy=${res.dy}px）\n${res.output || ""}`.trim(), res);
      },
    },
    {
      name: "browser_eval",
      label: "读取页面信息（JS）",
      description: "在当前网页上下文执行一段只读检查函数（如 () => document.title 或提取表格数据）。",
      parameters: obj({ expression: str("JS 函数表达式，例如 () => document.title") }, ["expression"]),
      execute: async (_id, params = {}) => {
        guard();
        const res = await manager.evaluate(sessionName, params.expression);
        return ok(res.output || "（无返回值）", res);
      },
    },
    {
      name: "browser_close",
      label: "关闭浏览器会话",
      description: "关闭本成员的浏览器会话并释放内存。",
      parameters: obj({}),
      execute: async () => {
        guard();
        await manager.close(sessionName);
        return ok(`已关闭浏览器会话 ${sessionName}`, { closed: true });
      },
    },
  ];
}

export default BrowserManager;
