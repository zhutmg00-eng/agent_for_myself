/**
 * reviewer 裁决解析（judge）测试：三态语义的边界都在这里——"没表态 ≠ 通过"、否定式修改、
 * 词形陷阱（未通过率）、中英混合、多 reviewer 取最严格、reviewerId 三种传法、可解释性与确定性。
 */
import { TEST_DATA_ROOT } from "./_helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { VERDICTS, judgeReviewer } from "../src/skills/judge.js";

const turn = (bot_id, text) => ({ bot_id, text, evidence: "observed", ms: 0 });

test("judge: 常量与返回形状", () => {
  assert.deepEqual(VERDICTS, ["pass", "reject", "null"]);
  const result = judgeReviewer({ turns: [turn("reviewer", "通过")] });
  assert.deepEqual(Object.keys(result).sort(), ["matched", "reasons", "reviewer", "verdict"]);
  assert.ok(Array.isArray(result.reasons) && result.reasons.length > 0);
  assert.ok(result.reasons.every((line) => typeof line === "string" && line.length > 0));
  assert.ok(VERDICTS.includes(String(result.verdict)), "verdict 必须是三态之一");
});

test("judge: 没有 reviewer 回合 → null，reviewer/matched 为 null", () => {
  const result = judgeReviewer({
    turns: [turn("coder", "我写完了。"), turn("writer", "LGTM 我润色完了。")],
  });
  assert.equal(result.verdict, null);
  assert.equal(result.reviewer, null);
  assert.equal(result.matched, null);
  assert.match(result.reasons[0], /没有 reviewer 回合/);
});

test("judge: reviewer 文本为空 → null，不当作通过", () => {
  const result = judgeReviewer({ turns: [turn("reviewer", "   ")] });
  assert.equal(result.verdict, null);
  assert.equal(result.reviewer, "reviewer");
  assert.equal(result.matched, null);
  assert.match(result.reasons[0], /文本为空/);
});

test("judge: 「稍后复核」是未表态 → null（旧启发式会误判 pass）", () => {
  const result = judgeReviewer({ turns: [turn("reviewer", "我先过一遍，稍后复核。")] });
  assert.equal(result.verdict, null);
  assert.match(result.matched, /稍后/);
  assert.match(result.reasons[0], /未表态/);
});

test("judge: 中文显式通过", () => {
  const result = judgeReviewer({ turns: [turn("reviewer", "逐条对照验收标准，**通过**。")] });
  assert.equal(result.verdict, "pass");
  assert.equal(result.reviewer, "reviewer");
  assert.match(result.matched, /通过/);
  assert.match(result.reasons[0], /命中通过表述/);
});

test("judge: 「需要修改」→ reject", () => {
  const result = judgeReviewer({ turns: [turn("reviewer", "需要修改第 2 步的错误处理。")] });
  assert.equal(result.verdict, "reject");
  assert.match(result.matched, /需要修改/);
  assert.match(result.reasons[0], /命中拒绝表述/);
});

test("judge: 否定语境「不用修改 / 无需修改 / 不需要修改」→ pass，不是 reject", () => {
  for (const text of ["没有问题，不用改。", "无需修改，可以合并。", "不需要修改，直接通过。"]) {
    const result = judgeReviewer({ turns: [turn("reviewer", text)] });
    assert.equal(result.verdict, "pass", `「${text}」应判 pass，实际 matched=${result.matched}`);
  }
});

test("judge: 词形陷阱 —— 「未通过率 / 通过率」不是裁决 → null", () => {
  const metric = judgeReviewer({ turns: [turn("reviewer", "本次未通过率 0.3%，比上周下降。")] });
  assert.equal(metric.verdict, null);
  assert.match(metric.reasons[0], /没有明确结论/);

  const rate = judgeReviewer({ turns: [turn("reviewer", "用例通过率 98%，数据见附件。")] });
  assert.equal(rate.verdict, null);
});

test("judge: 中英混合 —— LGTM + nits 记 pass", () => {
  const result = judgeReviewer({ turns: [turn("reviewer", "LGTM，只有两条 nits，不阻塞。")] });
  assert.equal(result.verdict, "pass");
  assert.match(result.matched, /LGTM/i);
});

test("judge: 中英混合 —— Changes requested → reject", () => {
  const result = judgeReviewer({ turns: [turn("reviewer", "Changes requested：需要补一版测试。")] });
  assert.equal(result.verdict, "reject");
  assert.match(result.matched, /Changes requested/i);
});

test("judge: 英文否定语境 —— no changes needed / no blocking issues → pass", () => {
  for (const text of [
    "No changes needed，直接合并。",
    "No blocking issues, LGTM.",
    "This doesn't need any work.",
    "Nothing to fix.",
  ]) {
    const result = judgeReviewer({ turns: [turn("reviewer", text)] });
    assert.equal(result.verdict, "pass", `「${text}」应判 pass，实际 matched=${result.matched}`);
  }

  // 非否定的同一表述仍然 reject。
  assert.equal(judgeReviewer({ turns: [turn("reviewer", "Changes needed：补一版测试。")] }).verdict, "reject");
  assert.equal(judgeReviewer({ turns: [turn("reviewer", "Blocking issues: 2")] }).verdict, "reject");
});

test("judge: 多 reviewer，任一 reject → reject（reviewer 指向打回的那个）", () => {
  const result = judgeReviewer({
    turns: [turn("reviewer-a", "通过"), turn("reviewer-b", "需要修改，回归测试没过。")],
  });
  assert.equal(result.verdict, "reject");
  assert.equal(result.reviewer, "reviewer-b");
  assert.match(result.matched, /需要修改/);
  assert.ok(result.reasons.some((line) => /多 reviewer 取最严格结论/.test(line)));
});

test("judge: 多 reviewer 全 pass → pass（reviewer 取第一个 pass）", () => {
  const result = judgeReviewer({
    turns: [turn("reviewer-a", "LGTM"), turn("reviewer-b", "通过")],
  });
  assert.equal(result.verdict, "pass");
  assert.equal(result.reviewer, "reviewer-a");
  assert.equal(result.reasons.filter((line) => /命中通过表述/.test(line)).length, 2);
});

test("judge: 多 reviewer 混合未表态 → null，不按通过处理", () => {
  const result = judgeReviewer({
    turns: [turn("reviewer-a", "通过"), turn("reviewer-b", "我还没看完，稍后复核。")],
  });
  assert.equal(result.verdict, null);
  assert.equal(result.reviewer, "reviewer-a", "混合时 reviewer 指向第一个 pass");
  assert.ok(result.reasons.some((line) => /未全部表态/.test(line)));
});

test("judge: reviewerId 单值只判指定 reviewer", () => {
  const turns = [turn("reviewer-a", "通过"), turn("reviewer-b", "打回重做")];
  const result = judgeReviewer({ turns, reviewerId: "reviewer-a" });
  assert.equal(result.verdict, "pass");
  assert.equal(result.reviewer, "reviewer-a");

  const onlyB = judgeReviewer({ turns, reviewerId: "reviewer-b" });
  assert.equal(onlyB.verdict, "reject");
});

test("judge: reviewerId 数组参与聚合", () => {
  const result = judgeReviewer({
    turns: [turn("reviewer-a", "通过"), turn("reviewer-b", "打回重做"), turn("writer", "忽略我")],
    reviewerId: ["reviewer-a", "reviewer-b"],
  });
  assert.equal(result.verdict, "reject");
  assert.equal(result.reviewer, "reviewer-b");
});

test("judge: 未传 reviewerId 时按 bot_id 含 review 推断（不区分大小写）", () => {
  const result = judgeReviewer({ turns: [turn("Code-Reviewer", "approved")] });
  assert.equal(result.verdict, "pass");
  assert.equal(result.reviewer, "Code-Reviewer");
});

test("judge: 指定 reviewer 但没有回合 → null 且原因可读", () => {
  const result = judgeReviewer({ turns: [turn("coder", "通过")], reviewerId: "reviewer-x" });
  assert.equal(result.verdict, null);
  assert.equal(result.reviewer, null);
  assert.match(result.reasons[0], /没有回合/);
});

test("judge: matched ≤80 字且带上下文，reasons 逐条可解释", () => {
  const long = `${"前置说明。".repeat(30)}我确认这次改动通过。${"后续补充。".repeat(30)}`;
  const result = judgeReviewer({ turns: [turn("reviewer", long)] });
  assert.equal(result.verdict, "pass");
  assert.ok(result.matched.length <= 80, `matched 应 ≤80 字，实际 ${result.matched.length}`);
  assert.match(result.matched, /通过/);
  assert.ok(result.reasons.length >= 1);
});

test("judge: 同一个 reviewer 多回合 —— 最后一次有效表态说了算", () => {
  const rejectedThenPassed = judgeReviewer({
    turns: [turn("reviewer", "需要修改错误处理。"), turn("reviewer", "已修改，通过。")],
  });
  assert.equal(rejectedThenPassed.verdict, "pass");

  const passedThenRejected = judgeReviewer({
    turns: [turn("reviewer", "通过。"), turn("reviewer", "再看了一遍，打回重做。")],
  });
  assert.equal(passedThenRejected.verdict, "reject");

  // 未表态不覆盖之前已有的结论。
  const passedThenPending = judgeReviewer({
    turns: [turn("reviewer", "通过。"), turn("reviewer", "我稍后再看一遍。")],
  });
  assert.equal(passedThenPending.verdict, "pass");
});

test("judge: emoji 标记（✅ / 🔴）也能判", () => {
  assert.equal(judgeReviewer({ turns: [turn("reviewer", "✅")] }).verdict, "pass");
  assert.equal(judgeReviewer({ turns: [turn("reviewer", "🔴 有阻塞问题")] }).verdict, "reject");
  assert.equal(judgeReviewer({ turns: [turn("reviewer", "💬 只留了评论")] }).verdict, null);
});

test("judge: 纯函数 —— 确定性、不改入参、不写盘", () => {
  const input = {
    turns: [turn("reviewer-a", "通过"), turn("reviewer-b", "需要修改")],
    reviewerId: ["reviewer-a", "reviewer-b"],
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  const before = fs.readdirSync(TEST_DATA_ROOT).sort();

  const first = judgeReviewer(input);
  const second = judgeReviewer(input);
  assert.deepEqual(first, second, "同输入必须同输出");
  assert.deepEqual(input, snapshot, "不能修改调用方入参");
  assert.deepEqual(fs.readdirSync(TEST_DATA_ROOT).sort(), before, "纯函数不应写盘");

  // 非法/空入参也要稳定返回三态，不抛错。
  assert.equal(judgeReviewer().verdict, null);
  assert.equal(judgeReviewer({ turns: null }).verdict, null);
  assert.equal(judgeReviewer({ turns: [null, 42, { text: "无 bot_id" }] }).verdict, null);
});

test("judge: 「本环节无需退回」不能被「退回」误判 reject", () => {
  const out = judgeReviewer({
    turns: [{
      bot_id: "reviewer",
      text: "**总判定：通过**\n1. 可读取性：通过。\n2. 字数：通过，90 字 ≤100。\n@boss 三个环节证据链完整，可出汇总结论；本环节无需退回。",
    }],
  });
  assert.equal(out.verdict, "pass", `实际：${out.verdict} 命中：${out.matched}`);
});

test("judge: 「没有发现需要退回修改的点」是 pass（否定包裹的退回/修改）", () => {
  const out = judgeReviewer({
    turns: [{
      bot_id: "reviewer",
      text: "**结论：通过。** note.md 满足全部验收标准；我没有发现需要退回修改的点。",
    }],
  });
  assert.equal(out.verdict, "pass", `实际：${out.verdict} 命中：${out.matched}`);
});

test("judge: 「不建议退回」「不建议修改」都是 pass（否定 + 建议）", () => {
  for (const text of ["四项全部通过；两点备注不影响验收，不建议退回。", "结论：通过；不建议修改。"]) {
    const out = judgeReviewer({ turns: [{ bot_id: "reviewer", text }] });
    assert.equal(out.verdict, "pass", `文本=${text} 实际=${out.verdict} 命中=${out.matched}`);
  }
});
