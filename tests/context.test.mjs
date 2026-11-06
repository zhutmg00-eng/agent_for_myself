/**
 * 群聊上下文装配（水位 + 摘要 + 预算）测试 —— docs/hermes/CONTRACT.md §7.1 / docs/hermes/CONTEXT.md。
 *
 * 覆盖：水位持久化跨重开、delta 只含新消息、首次 compose 退化、summary 档、
 * 预算裁剪与省略标注、超长单条截断、中文、digest 稳定性、空房间、level=none、
 * 幂等、stats、本轮消息去重、文件清单、未决分派、markInjected 单调、参数校验。
 *
 * 全部确定性：数据根由 tests/_helpers/env.mjs 隔离到 D:\能力测试\temp 下，
 * 不联网、不调 LLM、不读数据根之外。
 */
import { TEST_DATA_ROOT, onCleanup } from "./_helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Store, defaultPermissions } from "../src/store.js";
import { createRoomContext } from "../src/rooms/context.js";

const ROOM_ID = "room-ctx";
const TS = "2026-01-01T00:00:00.000Z";

function dbPathFor(name) {
  return path.join(TEST_DATA_ROOT, "data", `${name}.db`);
}

function openStore(name) {
  const store = new Store(dbPathFor(name));
  onCleanup(() => store.close());
  return store;
}

function seedRoom(store, { title = "上下文压缩验收群", topic = "把每轮注入从整份转录改成水位增量" } = {}) {
  store.upsertRoom({
    room_id: ROOM_ID,
    title,
    owner_id: "boss",
    parent_room_id: null,
    topic,
    context_policy: "shared",
    status: "active",
    created_at: TS,
    updated_at: TS,
  });
  store.setRoomMembers(
    ROOM_ID,
    ["boss", "coder", "reviewer"].map((bot_id) => ({ bot_id, permissions: defaultPermissions() })),
  );
}

function say(store, speaker, content, kind = speaker === "user" ? "user" : "assistant") {
  return store.appendRoomMessage(ROOM_ID, { speaker, content, kind, ts: TS });
}

/* ------------------------------------------------------------------ 水位 */

test("水位持久化：markInjected 落 kv，重开 store 后仍然生效", () => {
  const dbFile = dbPathFor("ctx-wm");
  const first = new Store(dbFile);
  seedRoom(first);
  say(first, "boss", "先定验收标准"); // seq 1
  say(first, "coder", "水位方案已给出"); // seq 2

  const ctx1 = createRoomContext({ store: first, roomId: ROOM_ID });
  assert.equal(ctx1.watermark("coder"), 0, "全新房间没有水位");
  assert.deepEqual(ctx1.markInjected("coder", 2), { ok: true });
  assert.equal(first.getKV(`ctx:wm:${ROOM_ID}:coder`), 2, "值就是被注入过的最大 seq");
  first.close();

  const reopened = new Store(dbFile);
  onCleanup(() => reopened.close());
  const ctx2 = createRoomContext({ store: reopened, roomId: ROOM_ID });
  assert.equal(ctx2.watermark("coder"), 2, "水位来自 kv，不依赖进程内缓存");
  assert.deepEqual(ctx2.deltaFor("coder"), [], "已消费的发言不会重放");
  assert.equal(ctx2.watermark("reviewer"), 0, "不同成员的水位互不影响");
  assert.equal(ctx2.watermark("coder"), 2, "重复读取稳定");
});

test("markInjected：单调不减（低 seq 不会让水位倒退），非法值抛错", () => {
  const store = openStore("ctx-monotonic");
  seedRoom(store);
  const ctx = createRoomContext({ store, roomId: ROOM_ID });

  ctx.markInjected("coder", 7);
  ctx.markInjected("coder", 3);
  assert.equal(ctx.watermark("coder"), 7, "水位只前进");
  assert.equal(store.getKV(`ctx:wm:${ROOM_ID}:coder`), 7);
  ctx.markInjected("coder", 9);
  assert.equal(ctx.watermark("coder"), 9);
  assert.throws(() => ctx.markInjected("coder", -1), /非负 seq/);
  assert.throws(() => ctx.markInjected("", 1), /需要非空 botId/);
});

/* ------------------------------------------------------------------ 增量 */

test("deltaFor：只返回水位之后的发言，字段与顺序符合契约", () => {
  const store = openStore("ctx-delta");
  seedRoom(store);
  for (let i = 1; i <= 6; i += 1) say(store, i % 2 ? "boss" : "coder", `第${i}条`);

  const ctx = createRoomContext({ store, roomId: ROOM_ID });
  ctx.markInjected("coder", 4);
  const delta = ctx.deltaFor("coder");
  assert.deepEqual(delta.map((m) => m.seq), [5, 6], "升序、且不含已注入的 1..4");
  assert.deepEqual(Object.keys(delta[0]).sort(), ["content", "kind", "seq", "speaker", "ts"]);
  assert.equal(delta[1].content, "第6条");
  assert.deepEqual(ctx.deltaFor("coder", { limit: 1 }).map((m) => m.seq), [6], "limit 取最新一条");
  assert.equal(ctx.watermark("coder"), 4, "deltaFor 不消费水位");
});

test("首次 compose（无水位）：退化为最近 30 条，并把窗口前计入省略", () => {
  const store = openStore("ctx-first");
  seedRoom(store);
  for (let i = 1; i <= 40; i += 1) say(store, i % 2 ? "boss" : "coder", `第${i}条发言`);

  const ctx = createRoomContext({ store, roomId: ROOM_ID });
  const { text, stats } = ctx.compose("coder");
  assert.equal(stats.deltaCount, 30);
  assert.equal(stats.trimmed, 10, "seq 1..10 被 30 条窗口挡在外面");
  assert.equal(stats.firstSeq, 11, "注入的最小 seq");
  assert.equal(stats.throughSeq, 40, "首次退化后 throughSeq = 窗口最后一条");
  assert.match(text, /（已省略 10 条更早发言）/);
  assert.ok(text.includes("第11条发言"), "窗口从 seq 11 开始");
  assert.ok(text.includes("第40条发言"), "最新一条一定在");
  assert.ok(!text.includes("第9条发言"), "更早的不注入");
  assert.equal(ctx.watermark("coder"), 40, "首次 compose 也把水位推到最新");
});

/* --------------------------------------------------------------- 各档位 */

test("summary 档：digest + 最近 4 条，且不消费水位", () => {
  const store = openStore("ctx-summary");
  seedRoom(store);
  for (let i = 1; i <= 10; i += 1) say(store, i % 2 ? "boss" : "coder", `第${i}条发言`);

  const ctx = createRoomContext({ store, roomId: ROOM_ID });
  const { text, stats } = ctx.compose("coder", { level: "summary" });
  assert.equal(stats.deltaCount, 4);
  assert.equal(stats.throughSeq, 0, "summary 不消费水位，throughSeq 恒为 0");
  assert.equal(stats.firstSeq, 7, "仍报出实际展示窗口的最小 seq");
  assert.ok(text.includes("第7条发言") && text.includes("第10条发言"));
  assert.ok(!text.includes("第6条发言"), "只留最近 4 条");
  assert.match(text, /群上下文摘要/);
  assert.equal(ctx.watermark("coder"), 0, "summary 不消费水位（受限成员可被提回 full）");
});

test("level=none：空串、零统计、不消费水位", () => {
  const store = openStore("ctx-none");
  seedRoom(store);
  say(store, "coder", "这一条不该被注入");
  const ctx = createRoomContext({ store, roomId: ROOM_ID });

  const out = ctx.compose("coder", { level: "none" });
  assert.equal(out.text, "");
  assert.deepEqual(out.stats, {
    digestChars: 0,
    deltaCount: 0,
    totalChars: 0,
    trimmed: 0,
    throughSeq: 0,
    firstSeq: 0,
  });
  assert.equal(ctx.watermark("coder"), 0);
});

/* --------------------------------------------------------------- 预算 */

test("预算裁剪：超 budget 从旧到新整条丢弃，并标注省略条数", () => {
  const store = openStore("ctx-budget");
  seedRoom(store);
  for (let i = 1; i <= 30; i += 1) say(store, i % 2 ? "boss" : "coder", `第${i}条：${"内容".repeat(20)}`);

  const ctx = createRoomContext({ store, roomId: ROOM_ID });
  const { text, stats } = ctx.compose("coder", { budget: 800 });
  assert.ok(stats.trimmed > 0, "必然有被省略的条数");
  assert.match(text, new RegExp(`（已省略 ${stats.trimmed} 条更早发言）`));
  assert.ok(text.length <= 800, `总长 ${text.length} 必须不超预算`);
  assert.ok(text.includes("第30条"), "最新的发言一定留下");
  assert.ok(!text.includes("第1条"), "最旧的整条丢弃");
  assert.equal(ctx.watermark("coder"), 30, "被省略的也算已消费（省略已显式标注）");
});

test("单条超长：按 budget 的 1/3 截断并标注原文长度", () => {
  const store = openStore("ctx-long");
  seedRoom(store);
  say(store, "coder", `会议纪要：${"长".repeat(3000)}`);
  const ctx = createRoomContext({ store, roomId: ROOM_ID });

  const { text, stats } = ctx.compose("coder", { budget: 600 });
  assert.equal(stats.deltaCount, 1);
  assert.match(text, /（已截断，原文 \d+ 字）/);
  assert.ok(text.length <= 600);
  assert.ok(!text.includes("长".repeat(250)), "超长单条不会被整段注入");
  assert.ok(text.includes("会议纪要："), "截断保留开头，信息不丢主旨");
});

test("预算边界：本轮消息永不裁剪，其余从旧到新让位", () => {
  const store = openStore("ctx-round-priority");
  seedRoom(store);
  for (let i = 1; i <= 10; i += 1) say(store, "coder", `第${i}条${"内容".repeat(30)}`);
  const ctx = createRoomContext({ store, roomId: ROOM_ID });

  const round = "必须原样出现在注入里";
  const { text, stats } = ctx.compose("coder", { roundMessage: round, budget: 300 });
  assert.ok(text.endsWith(`=== 本轮消息 ===\n${round}`), "本轮消息是最后一段且完整");
  assert.ok(stats.trimmed >= 5, "其余发言为新消息让位");
});

/* --------------------------------------------------------------- 摘要 */

test("digest 确定性：同输入同输出，换实例也一致，compose 不改变摘要", () => {
  const store = openStore("ctx-digest-stable");
  seedRoom(store);
  say(store, "boss", "结论 A：先做水位");
  say(store, "coder", "结论 B：再做摘要");

  const ctx = createRoomContext({ store, roomId: ROOM_ID });
  const a = ctx.digestText();
  assert.equal(ctx.digestText(), a, "同一实例两次相等");
  ctx.compose("coder", { level: "summary" });
  assert.equal(ctx.digestText(), a, "compose 不改变摘要内容");
  assert.equal(createRoomContext({ store, roomId: ROOM_ID }).digestText(), a, "换实例也一致");
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(a), "摘要里刻意不含时间戳，保证稳定");
});

test("digest：群主题 → 最近 3 条成员结论（截断 120 字）→ 文件 → 未决分派 的优先级", () => {
  const store = openStore("ctx-digest-priority");
  seedRoom(store, { title: "中文房间", topic: "上下文压缩：水位 + 摘要 + 预算" });
  for (let i = 1; i <= 5; i += 1) say(store, "coder", `结论${i}：${"细".repeat(200)}`);
  say(store, "user", "这条用户发言不进结论");

  const digest = createRoomContext({ store, roomId: ROOM_ID }).digestText();
  assert.ok(digest.startsWith(`=== 群上下文摘要（房间 ${ROOM_ID}：中文房间） ===`));
  assert.ok(digest.includes("【群主题】上下文压缩：水位 + 摘要 + 预算"));
  const conclusionLines = digest.split("\n").filter((line) => line.startsWith("- coder："));
  assert.equal(conclusionLines.length, 3, "只取最近 3 条成员结论");
  assert.ok(!digest.includes("这条用户发言不进结论"), "user 发言不算成员结论");
  assert.ok(conclusionLines[0].length <= "- coder：".length + 120, "每条结论截断到 120 字");
  assert.ok(digest.includes("结论5"), "取的是最近的结论");
  assert.ok(!digest.includes("结论2"), "更早的结论不进摘要");
});

test("空房间：digest 为空串，compose 只保留本轮消息，stats 全零", () => {
  const store = openStore("ctx-empty");
  const ctx = createRoomContext({ store, roomId: "empty-room" });

  assert.equal(ctx.digestText(), "");
  assert.deepEqual(ctx.compose("coder"), {
    text: "",
    stats: { digestChars: 0, deltaCount: 0, totalChars: 0, trimmed: 0, throughSeq: 0, firstSeq: 0 },
  });
  const withRound = ctx.compose("coder", { roundMessage: "继续" });
  assert.equal(withRound.text, "=== 本轮消息 ===\n继续");
  assert.deepEqual(ctx.stats(), { bots: 0, digestChars: 0, messages: 0 });
});

test("digest：群文件清单用 file_id + 名称，最多 20 条（保留最新的）", () => {
  const store = openStore("ctx-files");
  seedRoom(store);
  for (let i = 1; i <= 25; i += 1) {
    const n = String(i).padStart(4, "0");
    store.upsertRoomFile(ROOM_ID, {
      file_id: `f${n}`,
      path: `docs/文件${i}.md`,
      description: `说明${i}`,
      updated_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    });
  }

  const digest = createRoomContext({ store, roomId: ROOM_ID }).digestText();
  const lines = digest.split("\n").filter((line) => line.startsWith("- file_id "));
  assert.equal(lines.length, 20);
  assert.ok(lines[0].includes("f0006") && lines[0].includes("文件6.md"), "按 updated_at 取最新 20 个");
  assert.ok(!digest.includes("f0005"), "更早的文件不进摘要");
});

test("digest：识别 room_assign_task 形态的分派，识别不到就不写这一节", () => {
  const store = openStore("ctx-assign");
  seedRoom(store);
  say(store, "boss", "已把任务分派给 coder：补齐水位回归用例");
  say(store, "coder", '调用 room_assign_task {"member":"reviewer","task":"复核省略标注逻辑"}');

  const digest = createRoomContext({ store, roomId: ROOM_ID }).digestText();
  assert.match(digest, /【未决分派/);
  assert.ok(digest.includes("- → coder：补齐水位回归用例"));
  assert.ok(digest.includes("- → reviewer：复核省略标注逻辑"));

  const plain = openStore("ctx-noassign");
  seedRoom(plain);
  say(plain, "boss", "大家先看看现状，再决定谁做什么");
  assert.ok(
    !createRoomContext({ store: plain, roomId: ROOM_ID }).digestText().includes("未决分派"),
    "识别不到就不写",
  );
});

/* --------------------------------------------------------------- 幂等 */

test("幂等：同一 bot 连续两次 compose，第二次 delta 为空、只剩摘要", () => {
  const store = openStore("ctx-idem");
  seedRoom(store);
  say(store, "boss", "分工：coder 写水位，reviewer 写用例");
  say(store, "coder", "水位方案已发");

  const ctx = createRoomContext({ store, roomId: ROOM_ID });
  const first = ctx.compose("coder");
  assert.equal(first.stats.deltaCount, 2);
  assert.ok(first.text.includes("[coder] 水位方案已发"));

  const second = ctx.compose("coder");
  assert.equal(second.stats.deltaCount, 0, "不重复消费");
  assert.equal(second.stats.trimmed, 0);
  assert.equal(second.stats.throughSeq, 2, "delta 为空时 throughSeq 仍给出已注入位置（markInjected 幂等）");
  assert.equal(second.stats.firstSeq, 0);
  assert.ok(second.text.includes("群上下文摘要"), "摘要仍然给");
  assert.ok(!/^\[/m.test(second.text), "第二次没有逐条发言行");
  assert.equal(ctx.watermark("coder"), 2);
});

test("throughSeq：只到本次真正注入的最后一条，被裁掉的旧消息不算已读", () => {
  const store = openStore("ctx-through");
  seedRoom(store);
  for (let i = 1; i <= 30; i += 1) say(store, i % 2 ? "boss" : "coder", `第${i}条：${"内容".repeat(20)}`);

  const ctx = createRoomContext({ store, roomId: ROOM_ID });
  const { text, stats } = ctx.compose("coder", { budget: 800 });
  assert.ok(stats.deltaCount > 0 && stats.deltaCount < 30, "确实发生了裁剪");
  assert.equal(stats.throughSeq, 30, "最新一条一定被注入");
  assert.equal(stats.firstSeq, 30 - stats.deltaCount + 1, "保留的是连续尾窗");
  assert.ok(text.includes(`第${stats.firstSeq}条`), "firstSeq 那条在文本里");
  assert.ok(!text.includes(`第${stats.firstSeq - 1}条`), "firstSeq 之前那条确实没注入");
  assert.equal(ctx.watermark("coder"), stats.throughSeq, "水位与 throughSeq 一致，没有多吃");
});

test("预算撑爆时：一条都没注入就 throughSeq=0、水位不动，下次还能补发", () => {
  const store = openStore("ctx-nothing-fits");
  seedRoom(store);
  for (let i = 1; i <= 5; i += 1) say(store, "coder", `第${i}条发言`);

  const ctx = createRoomContext({ store, roomId: ROOM_ID });
  const blocked = ctx.compose("coder", { roundMessage: "长".repeat(200), budget: 120 });
  assert.equal(blocked.stats.deltaCount, 0, "本轮消息自己就把预算吃完了");
  assert.equal(blocked.stats.throughSeq, 0, "什么都没注入就不认领水位");
  assert.equal(ctx.watermark("coder"), 0, "水位没被误吃");
  assert.ok(blocked.text.includes("=== 本轮消息 ==="));

  const retry = ctx.compose("coder", { budget: 6000 });
  assert.equal(retry.stats.deltaCount, 5, "上次没注入的消息这次全部补上");
  assert.equal(retry.stats.firstSeq, 1);
  assert.equal(retry.stats.throughSeq, 5);
  assert.equal(ctx.watermark("coder"), 5);
});

test("本轮消息去重：已落库的最后一条 user 发言不在增量里重复出现", () => {
  const store = openStore("ctx-round");
  seedRoom(store);
  say(store, "boss", "上轮结论");
  say(store, "user", "本轮：请给出水位实现");

  const ctx = createRoomContext({ store, roomId: ROOM_ID });
  const { text, stats } = ctx.compose("coder", { roundMessage: "本轮：请给出水位实现" });
  assert.equal(stats.deltaCount, 1, "只保留 boss 那条");
  assert.ok(!text.includes("[user] 本轮：请给出水位实现"));
  assert.ok(text.includes("=== 本轮消息 ===\n本轮：请给出水位实现"));
  assert.equal(ctx.watermark("coder"), 2, "重复的那条也算已消费");
});

/* --------------------------------------------------------------- 统计 */

test("stats：bots 统计有水位记录的成员，messages/digestChars 与内容一致", () => {
  const store = openStore("ctx-stats");
  seedRoom(store);
  for (let i = 1; i <= 5; i += 1) say(store, i % 2 ? "boss" : "coder", `第${i}条`);

  const ctx = createRoomContext({ store, roomId: ROOM_ID });
  const before = ctx.stats();
  assert.equal(before.messages, 5);
  assert.equal(before.bots, 0);
  assert.equal(before.digestChars, ctx.digestText().length);

  ctx.compose("coder");
  ctx.compose("reviewer");
  assert.equal(ctx.stats().bots, 2);
  ctx.markInjected("boss", 1);
  assert.equal(ctx.stats().bots, 3, "换实例也能从 kv 数出来");

  const reopened = createRoomContext({ store, roomId: ROOM_ID });
  assert.equal(reopened.stats().bots, 3, "bots 来自 kv，不是进程内缓存");
  assert.equal(createRoomContext({ store, roomId: "another-room" }).stats().bots, 0, "房间之间水位隔离");
});

/* --------------------------------------------------------------- 校验 */

test("参数校验：缺 store / 缺 roomId / 非法档位 / 空 botId 都抛出可解释错误", () => {
  assert.throws(() => createRoomContext({}), /需要 \{ store \}/);
  const store = openStore("ctx-errors");
  assert.throws(() => createRoomContext({ store }), /需要 \{ roomId \}/);
  const ctx = createRoomContext({ store, roomId: ROOM_ID });
  assert.throws(() => ctx.compose("coder", { level: "everything" }), /非法上下文档位/);
  assert.throws(() => ctx.compose(""), /需要非空 botId/);
  assert.throws(() => ctx.deltaFor(null), /需要非空 botId/);
});
