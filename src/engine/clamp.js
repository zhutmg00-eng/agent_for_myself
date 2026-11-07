import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DIRS, assertNotC, TOOL_OUTPUT_CLAMP } from "../config.js";

/**
 * Proactively clamp large tool output strings using head + tail preservation
 * and persist full raw output to spillover storage.
 *
 * @param {string} rawText
 * @param {{
 *   maxChars?: number,
 *   headChars?: number,
 *   tailChars?: number,
 *   toolName?: string,
 *   toolCallId?: string,
 *   fileSpace?: object,
 *   roomId?: string,
 * }} options
 * @returns {{
 *   clamped: boolean,
 *   text: string,
 *   originalChars: number,
 *   truncatedChars: number,
 *   originalLines: number,
 *   truncatedLines: number,
 *   spillPath: string|null,
 *   fileId: string|null,
 * }}
 */
export function clampToolOutput(rawText, options = {}) {
  const text = typeof rawText === "string" ? rawText : String(rawText ?? "");
  const maxChars = options.maxChars ?? TOOL_OUTPUT_CLAMP.maxChars;
  const originalChars = text.length;

  if (originalChars <= maxChars) {
    return {
      clamped: false,
      text,
      originalChars,
      truncatedChars: 0,
      originalLines: text.split("\n").length,
      truncatedLines: 0,
      spillPath: null,
      fileId: null,
    };
  }

  const headBudget = options.headChars ?? TOOL_OUTPUT_CLAMP.headChars;
  const tailBudget = options.tailChars ?? TOOL_OUTPUT_CLAMP.tailChars;
  const lines = text.split("\n");
  const totalLines = lines.length;

  // Align Head to nearest newline boundary within budget
  let headSlice = text.slice(0, headBudget);
  const lastNlHead = headSlice.lastIndexOf("\n");
  if (lastNlHead > headBudget * 0.7) {
    headSlice = headSlice.slice(0, lastNlHead);
  }

  // Align Tail to nearest newline boundary within budget
  let tailSlice = text.slice(text.length - tailBudget);
  const firstNlTail = tailSlice.indexOf("\n");
  if (firstNlTail !== -1 && firstNlTail < tailBudget * 0.3) {
    tailSlice = tailSlice.slice(firstNlTail + 1);
  }

  const preservedChars = headSlice.length + tailSlice.length;
  const truncatedChars = Math.max(0, originalChars - preservedChars);
  const headLines = headSlice.split("\n").length;
  const tailLines = tailSlice.split("\n").length;
  const truncatedLines = Math.max(0, totalLines - headLines - tailLines);

  // Write full raw output to DIRS.temp/tool_outputs (assertNotC enforced)
  let spillPath = null;
  let fileId = null;
  try {
    const tempDir = path.join(DIRS.temp, "tool_outputs");
    assertNotC(tempDir, "tool outputs dir");
    fs.mkdirSync(tempDir, { recursive: true });

    const safeName = (options.toolName || "tool").replace(/[^a-zA-Z0-9_-]/g, "_");
    const stamp = Date.now();
    const nonce = crypto.randomBytes(3).toString("hex");
    const fileName = `${safeName}_${stamp}_${nonce}.log`;
    spillPath = path.join(tempDir, fileName);
    assertNotC(spillPath, "tool output spill file");
    fs.writeFileSync(spillPath, text, "utf8");
  } catch (err) {
    /* temp write is best-effort */
  }

  // If room fileSpace is available, optionally save or index
  if (options.fileSpace?.save && options.roomId) {
    try {
      const rec = options.fileSpace.save({
        name: `tool_outputs/${path.basename(spillPath || "output.log")}`,
        content: text,
        description: `工具 ${options.toolName || ""} 原始输出（共 ${originalChars} 字符）`,
        actor: "system",
      });
      if (rec?.file_id) fileId = rec.file_id;
    } catch {
      /* room file save is best effort */
    }
  }

  const pointerMsg = fileId
    ? `完整输出已存入群文件 (file_id: ${fileId})，可用 room_file_read 读取。本地镜像: ${spillPath || "无"}`
    : `完整原始输出已存入文件: ${spillPath || "（写入失败）"}，可按需读取。`;

  const notice = `\n\n[... 工具输出超出阈值，已截断 ${truncatedChars.toLocaleString()} 字符 (${truncatedLines.toLocaleString()} 行) ... ${pointerMsg}]\n\n`;
  const clampedText = `${headSlice}${notice}${tailSlice}`;

  return {
    clamped: true,
    text: clampedText,
    originalChars,
    truncatedChars,
    originalLines: totalLines,
    truncatedLines,
    spillPath,
    fileId,
  };
}
