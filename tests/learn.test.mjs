/**
 * 经验 → 技能（learn）测试：闸门四类拒绝 + 放行、草稿形状与五段结构、标题提炼、证据收集、
 * signature 稳定性（跨回合去重的前提）与纯函数/确定性。时间与外部状态全部不参与，断言可逐字节复现。
 */
import { TEST_DATA_ROOT } from "./_helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AUTO_PROPOSE_MODES,
  TITLE_MAX_CHARS,
  buildSkillDraft,
  evaluateLearningGate,
} from "../src/skills/learn.js";

/** 标准回合：一个实现者 + 一个复核者，都是 observed。 */
const TURNS = [
  { bot_id: "coder", text: "## 实现\n把三份原始材料压成三条结论，先跑 diff 再汇报。", evidence: "observed", ms: 1200 },
  { bot_id: "reviewer", text: "## 复核\n逐条对照验收标准，确认无 mismatch 后通过。", evidence: "observed", ms: 800 },
];

const SUMMARY = { observed: 2, prepared: 0, mismatch: 0, total: 2 };

const SECTION_ORDER = ["## 目标", "## 步骤", "## 验收标准", "## 证据", "## 适用场景"];

/* ------------------------------------------------------------------ 闸门 */

test("learn: 闸门放行 —— 2 个 observed 回合、无 mismatch、无 reviewer", () => {
  const gate = evaluateLearningGate({ turns: TURNS, evidenceSummary: SUMMARY });
  assert.equal(gate.ok, true);
  assert.match(gate.reason, /通过/);
  assert.match(gate.reason, /2 个成员回合/);
  assert.match(gate.reason, /无 reviewer/);
});

test("learn: 闸门拒绝 —— 少于 2 个成员回合（含空文本与非法入参）", () => {
  const single = evaluateLearningGate({ turns: [TURNS[0]], evidenceSummary: { observed: 1, total: 1 } });
  assert.equal(single.ok, false);
  assert.match(single.reason, /只有 1 个成员回合/);

  const noTurns = evaluateLearningGate({ turns: null, settings: null });
  assert.equal(noTurns.ok, false);
  assert.match(noTurns.reason, /只有 0 个成员回合/);

  const blankTurn = evaluateLearningGate({ turns: [{ bot_id: "ghost", text: "   " }, TURNS[0]] });
  assert.equal(blankTurn.ok, false, "没有正文的回合不算成员回合");
  assert.match(blankTurn.reason, /只有 1 个成员回合/);
});

test("learn: 闸门拒绝 —— settings.auto_propose_skills = off（字符串与布尔都认）", () => {
  const off = evaluateLearningGate({ turns: TURNS, evidenceSummary: SUMMARY, settings: { auto_propose_skills: "off" } });
  assert.equal(off.ok, false);
  assert.match(off.reason, /off/);

  const offBool = evaluateLearningGate({ turns: TURNS, evidenceSummary: SUMMARY, settings: { auto_propose_skills: false } });
  assert.equal(offBool.ok, false);

  assert.deepEqual(AUTO_PROPOSE_MODES, ["off", "observed", "always"]);
});

test("learn: 闸门拒绝 —— summary 或回合级 mismatch 任一存在", () => {
  const fromSummary = evaluateLearningGate({
    turns: TURNS,
    evidenceSummary: { observed: 1, prepared: 0, mismatch: 1, total: 2 },
  });
  assert.equal(fromSummary.ok, false);
  assert.match(fromSummary.reason, /mismatch=1/);

  const fromTurn = evaluateLearningGate({
    turns: [TURNS[0], { ...TURNS[1], evidence: "mismatch" }],
  });
  assert.equal(fromTurn.ok, false);
  assert.match(fromTurn.reason, /存在证据不符/);
});

test("learn: reviewer —— reject/无法识别拒绝，pass/中文通过放行，null 视为无 reviewer", () => {
  const rejected = evaluateLearningGate({ turns: TURNS, evidenceSummary: SUMMARY, reviewerVerdict: "reject" });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /reviewer/);

  const unknown = evaluateLearningGate({ turns: TURNS, evidenceSummary: SUMMARY, reviewerVerdict: "maybe" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /无法识别/);

  for (const verdict of ["pass", "PASS", "通过"]) {
    const ok = evaluateLearningGate({ turns: TURNS, evidenceSummary: SUMMARY, reviewerVerdict: verdict });
    assert.equal(ok.ok, true, `${verdict} 应放行`);
    assert.match(ok.reason, /reviewer 通过/);
  }

  const none = evaluateLearningGate({ turns: TURNS, evidenceSummary: SUMMARY, reviewerVerdict: null });
  assert.equal(none.ok, true);
  assert.match(none.reason, /无 reviewer/);
});

test("learn: observed 模式要求可观测证据，always 模式放宽", () => {
  const prepared = [
    { bot_id: "a", text: "我先说说思路，还没有实际产出。", evidence: "prepared" },
    { bot_id: "b", text: "补充一点方向性建议。", evidence: "prepared" },
  ];
  const summary = { observed: 0, prepared: 2, mismatch: 0, total: 2 };

  const strict = evaluateLearningGate({ turns: prepared, evidenceSummary: summary, settings: {} });
  assert.equal(strict.ok, false, "默认 observed 模式不应放行 prepared-only 回合");
  assert.match(strict.reason, /observed=0/);

  const relaxed = evaluateLearningGate({
    turns: prepared,
    evidenceSummary: summary,
    settings: { auto_propose_skills: "always" },
  });
  assert.equal(relaxed.ok, true);
  assert.match(relaxed.reason, /always/);

  const explicit = evaluateLearningGate({
    turns: prepared,
    evidenceSummary: summary,
    settings: { auto_propose_skills: "observed" },
  });
  assert.equal(explicit.ok, false);
});

/* ------------------------------------------------------------------ 草稿 */

test("learn: 草稿形状 —— 五段顺序、步骤按回合顺序、无 frontmatter、签名 40 位", () => {
  const draft = buildSkillDraft({
    instruction: "把三份材料压成三条结论，标注不确定项",
    roomId: "room123",
    roomTitle: "研究组",
    topic: "调研",
    members: ["coder", "reviewer"],
    turns: TURNS,
    files: [{ file_id: "abc12345", path: "notes/draft.md" }],
    evidenceSummary: SUMMARY,
    tags: ["调研", "调研", " 流程 "],
  });
  assert.ok(draft, "有完整输入时必须产出草稿");
  assert.ok([...draft.title].length <= TITLE_MAX_CHARS);
  assert.ok(!/^---/.test(draft.body), "body 不能含 frontmatter（由 curator.adopt 统一补）");
  assert.match(draft.body, /^# /);

  let cursor = -1;
  for (const section of SECTION_ORDER) {
    const index = draft.body.indexOf(section);
    assert.ok(index > cursor, `${section} 缺失或顺序错误`);
    cursor = index;
  }

  const coderAt = draft.body.indexOf("1. **coder**");
  const reviewerAt = draft.body.indexOf("2. **reviewer**");
  assert.ok(coderAt > 0 && reviewerAt > coderAt, "步骤必须按回合顺序编号");

  assert.deepEqual(draft.tags, ["调研", "流程"]);
  assert.match(draft.signature, /^[0-9a-f]{40}$/);
});

test("learn: 标题提炼 —— 去掉 @称呼与多余标点、超长截断", () => {
  const mention = buildSkillDraft({ instruction: "「写一份周报。」", turns: TURNS });
  assert.equal(mention.title, "写一份周报");

  const longInstruction =
    "@coder 请把 2026 年第四季度所有来源的原始材料（含访谈记录、埋点数据、客服工单）整理成一份可以直接给管理层看的季度复盘报告";
  const long = buildSkillDraft({ instruction: longInstruction, turns: TURNS, roomTitle: "研究组" });
  assert.ok([...long.title].length <= TITLE_MAX_CHARS);
  assert.ok(!long.title.includes("@"), "标题不能带 @称呼");
  assert.ok(long.title.startsWith("请把 2026 年第四季度"));

  const prefixed = buildSkillDraft({ instruction: "群主：把会议纪要整理成待办", turns: TURNS });
  assert.equal(prefixed.title, "把会议纪要整理成待办");

  const noInstruction = buildSkillDraft({ turns: TURNS, topic: "调研" });
  assert.equal(noInstruction.title, "调研", "没有指令时回落到话题");
});

test("learn: 证据段收集 file_id（files + 回合文本），去重保序", () => {
  const draft = buildSkillDraft({
    instruction: "整理材料",
    turns: [
      { bot_id: "librarian", text: "已保存初稿：file_id: abc12345，稍后复核。", evidence: "observed" },
      { bot_id: "reviewer", text: "复核通过，见 file_id：abc12345 与 file_id=def67890。", evidence: "observed" },
    ],
    files: [{ file_id: "def67890", path: "notes/draft.md" }],
  });
  assert.match(draft.body, /file_id：abc12345/);
  assert.match(draft.body, /file_id：def67890（notes\/draft\.md）/);
  const evidenceSection = draft.body.slice(
    draft.body.indexOf("## 证据"),
    draft.body.indexOf("## 适用场景"),
  );
  assert.equal(
    (evidenceSection.match(/file_id：abc12345/g) || []).length,
    1,
    "证据段里同一个 file_id 只出现一次（回合文本里的重复提及不应重复列出）",
  );
  assert.ok(
    evidenceSection.indexOf("def67890") < evidenceSection.indexOf("abc12345"),
    "先列群文件（带描述），再列只在回合文本里点名的 file_id",
  );
});

test("learn: 中文指令 + 空 members/topic 也能产出，成员标签回退 bot_id", () => {
  const draft = buildSkillDraft({ instruction: "整理会议纪要并标注待办", turns: TURNS });
  assert.ok(draft);
  assert.match(draft.body, /整理会议纪要并标注待办/);
  assert.match(draft.body, /1\. \*\*coder\*\*：/);
  assert.match(draft.body, /2\. \*\*reviewer\*\*：/);
  assert.match(draft.body, /本群/, "没有房间名时回落到「本群」");
  assert.match(draft.body, /同类任务/, "没有 topic 时回落到「同类任务」");
});

test("learn: signature 稳定且能区分内容，ms 不参与签名", () => {
  const base = { instruction: "整理材料", turns: TURNS, files: [{ file_id: "abc12345" }] };
  const first = buildSkillDraft(base);
  const second = buildSkillDraft(base);
  assert.equal(first.signature, second.signature);
  assert.deepEqual(first, second);

  const otherInstruction = buildSkillDraft({ ...base, instruction: "整理另一类材料" });
  assert.notEqual(first.signature, otherInstruction.signature);

  const otherFile = buildSkillDraft({ ...base, files: [{ file_id: "ffff9999" }] });
  assert.notEqual(first.signature, otherFile.signature);

  const otherTurns = buildSkillDraft({ ...base, turns: TURNS.map((turn) => ({ ...turn, ms: 99999 })) });
  assert.equal(first.signature, otherTurns.signature, "耗时变化不能改变去重键");
});

test("learn: 没有可用材料时返回 null", () => {
  assert.equal(buildSkillDraft(), null);
  assert.equal(buildSkillDraft({}), null);
  assert.equal(buildSkillDraft({ turns: [] }), null);
  assert.equal(buildSkillDraft({ instruction: "   " }), null);
  assert.equal(buildSkillDraft({ instruction: "@coder。", turns: [] }), null, "只剩称呼与标点时没有标题");
  assert.equal(
    buildSkillDraft({ instruction: "@coder。", turns: [{ bot_id: "a", text: "   " }] }),
    null,
    "空回合不构成材料",
  );
});

test("learn: 纯函数 —— 确定性且不修改入参", () => {
  const input = {
    instruction: "整理材料",
    roomId: "r1",
    roomTitle: "研究组",
    topic: "调研",
    members: [{ id: "coder", name: "实现者" }],
    turns: TURNS.map((turn) => ({ ...turn })),
    files: [{ file_id: "abc12345", path: "notes/draft.md" }],
    evidenceSummary: { ...SUMMARY },
    tags: ["调研"],
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  const first = buildSkillDraft(input);
  const second = buildSkillDraft(input);
  assert.deepEqual(first, second, "同输入必须同输出");
  assert.deepEqual(input, snapshot, "不能修改调用方入参");
  assert.match(first.body, /\*\*实现者\*\*/, "members 里的显示名优先于 bot_id");

  const gateInput = { turns: input.turns, evidenceSummary: input.evidenceSummary, settings: { auto_propose_skills: "observed" } };
  const gateSnapshot = JSON.parse(JSON.stringify(gateInput));
  evaluateLearningGate(gateInput);
  assert.deepEqual(gateInput, gateSnapshot);
});

test("learn: 纯函数不写盘（数据根快照不变）", () => {
  const before = fs.readdirSync(TEST_DATA_ROOT).sort();
  evaluateLearningGate({ turns: TURNS, evidenceSummary: SUMMARY });
  buildSkillDraft({ instruction: "整理材料", turns: TURNS });
  assert.deepEqual(fs.readdirSync(TEST_DATA_ROOT).sort(), before);
});

test("learn: 标题剥掉「请群主分派：让 coder …」这类指令外壳", () => {
  const base = {
    roomId: "r1",
    members: ["coder", "reviewer"],
    turns: [
      { bot_id: "coder", text: "写好了，file_id 12345678", evidence: "observed", ms: 1 },
      { bot_id: "reviewer", text: "通过", evidence: "observed", ms: 1 },
    ],
    evidenceSummary: { observed: 2, prepared: 0, mismatch: 0, total: 2 },
    reviewerVerdict: "pass",
  };
  const dispatched = buildSkillDraft({ ...base, instruction: "请群主分派：让 coder 写一份 100 字以内的产品简介" });
  assert.ok(dispatched, "应产出草稿");
  assert.ok(!dispatched.title.includes("请群主分派"), `标题不应带指令外壳：${dispatched.title}`);
  assert.ok(!/\bcoder\b/.test(dispatched.title), `标题不应带执行者 id：${dispatched.title}`);
  assert.match(dispatched.title, /产品简介|写一份/);

  const plain = buildSkillDraft({ ...base, instruction: "把发布说明整理成清单" });
  assert.equal(plain.title, "把发布说明整理成清单", "普通指令保持不变");
});
