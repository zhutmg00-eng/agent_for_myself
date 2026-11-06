/**
 * 持久记忆（memory）测试 —— docs/hermes/CONTRACT.md §3.4 / docs/hermes/MEMORY.md。
 *
 * 覆盖：save/get/list/search（中文与英文两套）/ FTS 命中与 LIKE 退化路径 / 触发器同步 /
 * pinned 加成 / 时间衰减 / 去重 / 替换 / 删除 / contextBlock 预算截断 / audit / stats /
 * 跨重开持久化 / FTS 重建。
 *
 * 时间全部由注入的 now() 控制，测试确定性、不联网、不碰 LLM。
 */
import { TEST_DATA_ROOT, onCleanup } from "./_helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Store } from "../src/store.js";
import { createMemory, MAX_ENTRY_CHARS } from "../src/memory.js";

const DAY_MS = 86_400_000;

function dbPathFor(name) {
  return path.join(TEST_DATA_ROOT, "data", `${name}.db`);
}

/** 每个用例一个独立库 + 可控时钟（默认停在 2026-01-01T00:00:00Z）。 */
function makeMemory(name, { now, ...options } = {}) {
  const store = new Store(dbPathFor(name));
  const clock = { t: Date.parse("2026-01-01T00:00:00Z") };
  const mem = createMemory({ store, now: now || (() => clock.t), ...options });
  onCleanup(() => store.close());
  return { store, mem, clock };
}

/** 直接查 FTS 索引，用来证明触发器真的同步了（而不是靠搜索路径猜）。 */
function ftsHitCount(store, term) {
  const row = store.db.prepare("SELECT COUNT(*) AS n FROM mem_fts WHERE mem_fts MATCH ?").get(`"${term}"`);
  return Number(row.n);
}

test("save/get：默认值、id、归属维度与去重标记", () => {
  const { mem } = makeMemory("mem-save");

  const a = mem.save({ scope: "room", roomId: "r1", content: "项目使用 Node 24 运行时", tags: ["env", "env", ""] });
  assert.match(a.id, /^[0-9a-f]{16}$/, "id 是 makeId(8) 生成的 16 位十六进制");
  assert.equal(a.scope, "room");
  assert.equal(a.roomId, "r1");
  assert.equal(a.botId, null, "room 作用域只认 roomId");
  assert.equal(a.target, "memory");
  assert.equal(a.content, "项目使用 Node 24 运行时");
  assert.deepEqual(a.tags, ["env"], "标签去重并丢弃空串");
  assert.equal(a.pinned, false);
  assert.equal(a.source, "agent");
  assert.equal(a.createdAt, "2026-01-01T00:00:00.000Z", "时间来自注入的 now()");
  assert.equal(a.deduped, false);
  const { deduped: _deduped, ...stored } = a;
  assert.deepEqual(mem.get(a.id), stored, "get 返回落库后的条目（不含 save 的 deduped 标记）");
  assert.equal(mem.get("missing"), null);

  const b = mem.save({ scope: "bot", botId: "b1", roomId: "r9", content: "机器人偏好短句" });
  assert.equal(b.roomId, null, "bot 作用域只认 botId");
  assert.equal(b.botId, "b1");

  const c = mem.save({ scope: "global", roomId: "r9", botId: "b9", target: "user", content: "用户偏好中文回答" });
  assert.equal(c.roomId, null, "global 作用域不挂任何归属");
  assert.equal(c.botId, null);
  assert.equal(c.target, "user");
});

test("save：非法入参会抛出可解释错误", () => {
  const { mem } = makeMemory("mem-save-errors");

  assert.throws(() => mem.save({ scope: "global", content: "   " }), /记忆内容不能为空/);
  assert.throws(() => mem.save({ scope: "team", content: "x" }), /非法记忆作用域/);
  assert.throws(() => mem.save({ scope: "room", content: "x" }), /room 作用域的持久记忆需要 roomId/);
  assert.throws(() => mem.save({ scope: "bot", content: "x" }), /bot 作用域的持久记忆需要 botId/);
  assert.throws(() => mem.save({ scope: "global", content: "x", target: "note" }), /非法记忆目标/);
  assert.throws(() => mem.save({ scope: "global", content: "字".repeat(MAX_ENTRY_CHARS + 1) }), /记忆内容过长/);
  assert.throws(() => createMemory({}), /需要 \{ store \}/);
});

test("list：按 scope/roomId/target 过滤，置顶在前，limit 生效", () => {
  const { mem, clock } = makeMemory("mem-list");
  const older = mem.save({ scope: "room", roomId: "r1", content: "房间事实 A" });
  clock.t += 1000;
  const pinned = mem.save({ scope: "room", roomId: "r1", content: "置顶事实 B", pinned: true });
  clock.t += 1000;
  mem.save({ scope: "room", roomId: "r2", content: "别的房间" });
  mem.save({ scope: "bot", botId: "b1", content: "机器人事实" });
  mem.save({ scope: "global", target: "user", content: "用户偏好" });

  const room = mem.list({ scope: "room", roomId: "r1" });
  assert.deepEqual(room.map((e) => e.id), [pinned.id, older.id], "置顶在前，其余按更新时间倒序");
  assert.equal(mem.list({ scope: "room" }).length, 3, "只给 scope 时跨房间");
  assert.deepEqual(mem.list({ target: "user" }).map((e) => e.content), ["用户偏好"]);
  assert.deepEqual(mem.list({ scope: "bot", botId: "b1" }).map((e) => e.content), ["机器人事实"]);
  assert.equal(mem.list().length, 5);
  assert.equal(mem.list({ limit: 2 }).length, 2);
});

test("search（英文）：走 FTS，前缀与跨词序都能命中", () => {
  const { mem } = makeMemory("mem-search-en");
  mem.save({ scope: "room", roomId: "r1", content: "deployment pipeline uses docker compose" });
  mem.save({ scope: "room", roomId: "r1", content: "alice prefers tabs over spaces" });

  const debug = mem.searchDebug({ query: "docker" });
  assert.equal(debug.path, "fts", "英文查询应命中 FTS 路径");
  assert.equal(debug.hits.length, 1);
  assert.match(debug.hits[0].entry.content, /docker compose/);
  assert.ok(debug.hits[0].score > 1, "score = 相关度 + 时间衰减（此处相关度 1）");

  assert.equal(mem.search({ query: "deploy" }).length, 1, "前缀匹配（FTS 前缀星）");
  assert.equal(mem.search({ query: "compose docker" }).length, 1, "词序无关（FTS 隐式 AND）");
  assert.equal(mem.search({ query: "kubernetes" }).length, 0);
  assert.equal(mem.search({ query: "tabs", scope: "bot", botId: "nobody" }).length, 0, "作用域过滤生效");
});

test("search（中文）：FTS 无法切分的子串退化为 LIKE，整段 token 仍走 FTS", () => {
  const { mem } = makeMemory("mem-search-zh");
  mem.save({ scope: "room", roomId: "r1", content: "青鸟计划定在三月启动" });
  mem.save({ scope: "room", roomId: "r1", content: "预算审批走财务系统" });
  mem.save({ scope: "global", content: "蓝鲸" });

  const sub = mem.searchDebug({ query: "青鸟计划" });
  assert.equal(sub.path, "like", "中文子串在 unicode61 下零命中，必须退化");
  assert.equal(sub.hits.length, 1);
  assert.match(sub.hits[0].entry.content, /青鸟计划定在三月启动/);

  const single = mem.search({ query: "鸟" });
  assert.equal(single.length, 1, "单字查询也能命中");
  assert.equal(mem.search({ query: "财务" }).length, 1);

  const whole = mem.searchDebug({ query: "蓝鲸" });
  assert.equal(whole.path, "fts", "整段连续汉字恰好是一个 token 时走 FTS");
  assert.equal(whole.hits.length, 1);

  // 中文部分覆盖按二元组打分：只覆盖部分二元组的查询相关度明显低于整串命中
  const partial = mem.search({ query: "计划启动" })[0];
  const exact = mem.search({ query: "青鸟计划" })[0];
  assert.ok(partial.score > 0.6 && partial.score < exact.score, `部分覆盖 ${partial.score} < 整串 ${exact.score}`);
});

test("mem_fts 与 mem_entries 由触发器同步（直接 SQL 写入/更新/删除）", () => {
  const { store, mem } = makeMemory("mem-trigger");
  const entry = mem.save({ scope: "global", content: "trigger sync alpha" });
  assert.equal(ftsHitCount(store, "alpha"), 1, "INSERT 触发器写入 FTS");

  store.db.prepare("UPDATE mem_entries SET content = ? WHERE id = ?").run("trigger sync beta", entry.id);
  assert.equal(ftsHitCount(store, "alpha"), 0, "UPDATE 触发器清掉旧 token");
  assert.equal(ftsHitCount(store, "beta"), 1);
  assert.match(mem.search({ query: "beta" })[0].entry.content, /beta/);

  const ts = "2026-01-01T00:00:00.000Z";
  store.db
    .prepare(
      `INSERT INTO mem_entries(id, scope, target, content, tags_json, pinned, source, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run("raw1", "global", "memory", "raw insert gamma", "[]", 0, "sql", ts, ts);
  assert.equal(ftsHitCount(store, "gamma"), 1, "绕过 API 的写入也被索引");
  assert.ok(mem.search({ query: "gamma" }).some((hit) => hit.entry.id === "raw1"));

  store.db.prepare("DELETE FROM mem_entries WHERE id = ?").run("raw1");
  assert.equal(ftsHitCount(store, "gamma"), 0, "DELETE 触发器从 FTS 移除");
  assert.equal(mem.search({ query: "gamma" }).length, 0);
});

test("search：FTS 查询里的特殊字符不会炸，空查询返回空", () => {
  const { mem } = makeMemory("mem-search-special");
  mem.save({ scope: "global", content: "docker-compose 配置在 deploy/ 目录" });

  for (const query of ['"docker"', "docker:compose", "*", "a-b", "P2.2", "NOT docker", "deploy+compose", "^foo"]) {
    assert.doesNotThrow(() => mem.search({ query }), `查询 ${query} 不应抛错`);
  }
  assert.equal(mem.search({ query: "docker" }).length, 1, "清洗后仍能命中（- 被当分隔符）");
  assert.deepEqual(mem.search({ query: "" }), []);
  assert.deepEqual(mem.search({ query: "   " }), []);
  assert.equal(mem.searchDebug({ query: "" }).path, "empty");
  assert.equal(mem.searchDebug({ query: "不存在的词xyz" }).path, "none");
});

test("search：pinned 加成让旧但置顶的记忆排在较新的前面", () => {
  const { store, mem, clock } = makeMemory("mem-pinned");
  const old = mem.save({ scope: "room", roomId: "r1", content: "发布流程需要双人 review", pinned: true });
  clock.t += 400 * DAY_MS;
  const fresh = mem.save({ scope: "room", roomId: "r1", content: "review 时需要跑完整测试" });

  const hits = mem.search({ query: "review" });
  assert.deepEqual(hits.map((hit) => hit.entry.id), [old.id, fresh.id], "置顶加成压过时间衰减");

  // 取消置顶后，排序回到"新的在前"（两条相关度相同）
  mem.replace(old.id, { pinned: false });
  const flipped = mem.search({ query: "review" });
  assert.deepEqual(flipped.map((hit) => hit.entry.id), [fresh.id, old.id]);
  assert.ok(store.db, "store 仍可访问");
});

test("search：时间衰减按半衰期计算，halfLifeDays 可配置", () => {
  const { mem, clock } = makeMemory("mem-decay");
  mem.save({ scope: "global", content: "缓存策略用 LRU" });
  clock.t += 30 * DAY_MS; // 正好一个半衰期（默认 30 天）
  mem.save({ scope: "global", content: "缓存失效走事件通知" });

  const hits = mem.search({ query: "缓存" });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].entry.content, "缓存失效走事件通知", "新的在前");
  // 相关度都是 1；差值 = decayWeight(0.15) × (1 - 0.5) = 0.075
  assert.ok(Math.abs(hits[0].score - hits[1].score - 0.075) < 1e-6, `实际差值：${hits[0].score - hits[1].score}`);

  const custom = makeMemory("mem-decay-custom", { halfLifeDays: 1 });
  custom.mem.save({ scope: "global", content: "索引重建要一小时" });
  custom.clock.t += 2 * DAY_MS; // 两个半衰期 → 衰减 0.25
  custom.mem.save({ scope: "global", content: "索引分片按天滚动" });
  const customHits = custom.mem.search({ query: "索引" });
  assert.ok(Math.abs(customHits[0].score - customHits[1].score - 0.1125) < 1e-6, "半衰期 1 天时衰减更快");
});

test("save：同归属下的高相似内容被去重，合并标签/置顶并刷新时间", () => {
  const { mem, clock } = makeMemory("mem-dedupe");
  const first = mem.save({ scope: "room", roomId: "r1", content: "服务端口是 8080", tags: ["ops"] });
  clock.t += 5000;
  const second = mem.save({ scope: "room", roomId: "r1", content: "服务端口是 8080。", tags: ["deploy"], pinned: true });

  assert.equal(second.deduped, true);
  assert.equal(second.id, first.id, "去重是合并到原条目，不新增");
  assert.equal(mem.list({ scope: "room", roomId: "r1" }).length, 1);
  const merged = mem.get(first.id);
  assert.deepEqual(merged.tags, ["ops", "deploy"], "标签取并集");
  assert.equal(merged.pinned, true, "置顶取或");
  assert.ok(merged.updatedAt > first.updatedAt, "updatedAt 被刷新");
  assert.equal(mem.audit({ limit: 1 })[0].action, "dedupe", "合并留痕");
  assert.equal(mem.audit({ limit: 1 })[0].detail.similarity, 1);
});

test("save：不相似不误合并；超集内容采用新文本；近似但非超集保留原文", () => {
  const { mem } = makeMemory("mem-dedupe-2");
  const a = mem.save({ scope: "global", content: "发布前必须跑全量测试" });
  const b = mem.save({ scope: "global", content: "数据库迁移要先备份" });
  assert.notEqual(b.id, a.id, "不同事实各自成条");
  assert.equal(b.deduped, false);

  const superset = mem.save({ scope: "global", content: "发布前必须跑全量测试，并通知值班" });
  assert.equal(superset.id, a.id, "超集合并到原条目");
  assert.equal(superset.deduped, true);
  assert.match(mem.get(a.id).content, /并通知值班/, "超集采用新文本，不丢新增信息");

  const before = mem.save({ scope: "bot", botId: "b2", content: "数据库迁移之前必须先做全量备份再执行" });
  const nearDup = mem.save({ scope: "bot", botId: "b2", content: "数据库迁移之前必须先做全量备份后执行" });
  assert.equal(nearDup.deduped, true, "近似文本（相似度 ≥ 0.85）合并");
  assert.equal(nearDup.id, before.id);
  assert.equal(mem.get(before.id).content, "数据库迁移之前必须先做全量备份再执行", "非超集时保留原文，避免静默丢细节");
  assert.equal(mem.audit({ limit: 1 })[0].detail.adoptedNewContent, false);
});

test("replace：显式替换内容/标签/置顶并留痕；不存在的 id 抛错", () => {
  const { mem } = makeMemory("mem-replace");
  const entry = mem.save({ scope: "bot", botId: "b1", content: "偏好简洁回答", tags: ["style"] });

  const next = mem.replace(entry.id, { content: "偏好简洁、直接的答案", tags: ["style", "tone"], pinned: true });
  assert.equal(next.content, "偏好简洁、直接的答案");
  assert.deepEqual(next.tags, ["style", "tone"]);
  assert.equal(next.pinned, true);
  assert.ok(next.updatedAt >= entry.updatedAt);

  const rec = mem.audit({ limit: 1 })[0];
  assert.equal(rec.action, "replace");
  assert.equal(rec.entryId, entry.id);
  assert.equal(rec.detail.beforeChars, entry.content.length);
  assert.equal(rec.detail.afterChars, next.content.length);

  assert.match(mem.search({ query: "简洁" })[0].entry.content, /直接的答案/, "FTS 随内容更新");
  assert.throws(() => mem.replace("missing", { content: "x" }), /记忆不存在/);
});

test("remove：删除条目并记录 source 与原因；不存在时返回 ok:false", () => {
  const { mem } = makeMemory("mem-remove");
  const entry = mem.save({ scope: "room", roomId: "r1", content: "临时记忆：今晚发布" });
  assert.equal(mem.search({ query: "今晚发布" }).length, 1);

  const out = mem.remove(entry.id, { source: "user", reason: "已过时" });
  assert.equal(out.ok, true);
  assert.equal(out.removed.id, entry.id);
  assert.equal(mem.get(entry.id), null);
  assert.equal(mem.search({ query: "今晚发布" }).length, 0, "FTS 也被清理");

  const rec = mem.audit({ limit: 1 })[0];
  assert.equal(rec.action, "remove");
  assert.equal(rec.source, "user");
  assert.equal(rec.reason, "已过时");

  const missing = mem.remove("missing");
  assert.equal(missing.ok, false);
  assert.match(missing.error, /记忆不存在/);
});

test("contextBlock：严格按 scope 过滤，三段拼接不重复（对齐 room.js 的注入方式）", () => {
  const { mem } = makeMemory("mem-block");
  mem.save({ scope: "global", content: "全局事实：项目代号青鸟" });
  mem.save({ scope: "room", roomId: "rA", content: "房间A：接口用 REST" });
  mem.save({ scope: "room", roomId: "rB", content: "房间B：这里不该出现" });
  mem.save({ scope: "bot", botId: "b1", content: "机器人b1：偏好中文" });
  mem.save({ scope: "bot", botId: "b2", content: "机器人b2：偏好英文" });

  const room = mem.contextBlock({ scope: "room", roomId: "rA", botId: "b1", budgetChars: 2000 });
  assert.match(room, /房间A：接口用 REST/);
  assert.ok(!room.includes("这里不该出现"), "同 scope 其他房间的内容不能混进来");
  assert.ok(!room.includes("全局事实"), "room 块不越权包含全局记忆（拼接由调用方负责）");
  assert.ok(!room.includes("偏好中文"), "别的机器人的私有记忆不能混进来");

  const bot = mem.contextBlock({ scope: "bot", botId: "b1" });
  assert.match(bot, /机器人b1：偏好中文/);
  assert.ok(!bot.includes("偏好英文"));

  const global = mem.contextBlock({ scope: "global" });
  assert.match(global, /全局事实/);
  assert.ok(!global.includes("房间A"), "global 视图只含全局记忆");

  // 房间拼三段（room.js memoryBlock）：每条记忆在合成上下文里恰好出现一次
  const composed = [room, bot, global].join("\n\n");
  assert.equal(composed.match(/全局事实：项目代号青鸟/g).length, 1);
  assert.equal(composed.match(/房间A：接口用 REST/g).length, 1);
  assert.equal(composed.match(/机器人b1：偏好中文/g).length, 1);

  assert.throws(() => mem.contextBlock({ scope: "room" }), /需要 roomId/);
  assert.throws(() => mem.contextBlock({ scope: "bot" }), /需要 botId/);
  assert.equal(makeMemory("mem-block-empty").mem.contextBlock({ scope: "room", roomId: "rX" }), "");
});

test("search/list：与 scope 不符的 roomId/botId 被忽略（房间工具三个参数一起传）", () => {
  const { mem } = makeMemory("mem-scope-normalize");
  mem.save({ scope: "global", content: "全局检索目标 alpha" });
  mem.save({ scope: "bot", botId: "b1", content: "机器人检索目标 beta" });
  mem.save({ scope: "room", roomId: "r1", content: "房间检索目标 gamma" });

  assert.equal(mem.search({ scope: "global", roomId: "r1", botId: "b1", query: "alpha" }).length, 1);
  assert.equal(mem.list({ scope: "global", roomId: "r1", botId: "b1" }).length, 1);
  assert.equal(mem.search({ scope: "bot", roomId: "r1", botId: "b1", query: "beta" }).length, 1);
  assert.equal(mem.search({ scope: "room", roomId: "r1", botId: "b1", query: "gamma" }).length, 1);
  assert.equal(mem.search({ scope: "bot", roomId: "r1", botId: "b2", query: "beta" }).length, 0, "bot 维度仍生效");
});

test("contextBlock：置顶先占预算，超预算截断并标注条数", () => {
  const { mem } = makeMemory("mem-block-budget");
  const pinned = mem.save({ scope: "room", roomId: "r1", content: "置顶：必须保留的事实", pinned: true });
  const facts = [
    "缓存命中率要盯到 90% 以上，否则先查慢查询",
    "索引重建安排在低峰期，提前通知值班同学",
    "回滚脚本必须每月演练一次并记录耗时",
    "监控告警阈值改动要走双人复核",
    "备份保留七天，异地副本单独加密存放",
    "发布窗口固定在周二上午十点之前完成",
  ];
  for (const fact of facts) mem.save({ scope: "room", roomId: "r1", content: fact });

  const block = mem.contextBlock({ scope: "room", roomId: "r1", budgetChars: 260 });
  assert.ok(block.length <= 260, `块长度必须落在预算内：${block.length}`);
  assert.ok(block.includes("置顶：必须保留的事实"), "置顶条目优先进入预算");
  const note = block.match(/已截断 (\d+) 条/);
  assert.ok(note, "必须标注截断条数");
  const shown = block.split("\n").filter((line) => line.startsWith("- ")).length;
  assert.equal(shown + Number(note[1]), 7, "显示 + 截断 = 全部候选");
  assert.ok(Number(note[1]) > 0);
  assert.ok(mem.get(pinned.id).pinned);
});

test("clear：按 scope 批量清理并逐条留审计（房间删除时用）", () => {
  const { mem } = makeMemory("mem-clear");
  mem.save({ scope: "room", roomId: "r1", content: "房间一记忆甲" });
  mem.save({ scope: "room", roomId: "r1", content: "房间一记忆乙" });
  mem.save({ scope: "room", roomId: "r2", content: "房间二记忆" });

  const out = mem.clear({ scope: "room", roomId: "r1", source: "system", reason: "房间已删除" });
  assert.deepEqual(out, { ok: true, removed: 2 });
  assert.equal(mem.list({ scope: "room", roomId: "r1" }).length, 0);
  assert.equal(mem.list({ scope: "room", roomId: "r2" }).length, 1, "别的房间不受影响");

  const rows = mem.audit({ limit: 2 });
  assert.ok(rows.every((row) => row.action === "remove" && row.source === "system" && row.reason === "房间已删除"));
  assert.throws(() => mem.clear({ roomId: "r1" }), /需要显式 scope/);
});

test("audit：save/dedupe/replace/remove 全部留痕且按时间倒序", () => {
  const { mem } = makeMemory("mem-audit");
  const entry = mem.save({ scope: "global", content: "第一条记忆" });
  mem.save({ scope: "global", content: "第一条记忆。" }); // dedupe
  mem.replace(entry.id, { content: "第一条记忆（改）" });
  mem.remove(entry.id, { reason: "清理" });

  const rows = mem.audit({ limit: 10 });
  assert.deepEqual(rows.map((row) => row.action), ["remove", "replace", "dedupe", "save"]);
  assert.equal(rows.length, 4);
  assert.equal(mem.audit({ limit: 2 }).length, 2);
  assert.equal(rows[3].entryId, entry.id);
  assert.ok(rows.every((row) => typeof row.ts === "string" && row.ts.length > 0));
});

test("stats：total / pinned / byScope", () => {
  const { mem } = makeMemory("mem-stats");
  mem.save({ scope: "global", content: "全局一", pinned: true });
  mem.save({ scope: "global", target: "user", content: "全局二" });
  mem.save({ scope: "room", roomId: "r1", content: "房间一" });
  mem.save({ scope: "bot", botId: "b1", content: "机器人一", pinned: true });

  assert.deepEqual(mem.stats(), { total: 4, pinned: 2, byScope: { room: 1, bot: 1, global: 2 } });
});

test("持久化：关闭 store 重开后条目、检索与审计仍在", () => {
  const dbPath = dbPathFor("mem-restart");
  const store1 = new Store(dbPath);
  const mem1 = createMemory({ store: store1, now: () => Date.parse("2026-01-01T00:00:00Z") });
  const entry = mem1.save({ scope: "global", content: "重启后仍然存在的记忆 key=persist-42" });
  store1.close();

  const store2 = new Store(dbPath);
  onCleanup(() => store2.close());
  const mem2 = createMemory({ store: store2, now: () => Date.parse("2026-01-02T00:00:00Z") });
  assert.equal(mem2.get(entry.id).content, "重启后仍然存在的记忆 key=persist-42");
  assert.equal(mem2.search({ query: "persist-42" }).length, 1, "索引随库持久化");
  assert.equal(mem2.searchDebug({ query: "persist-42" }).path, "fts");
  assert.ok(mem2.audit().some((row) => row.action === "save"), "审计同样持久化");
  assert.equal(mem2.stats().total, 1);
});

test("mem_fts 重建：索引被清空后 LIKE 仍可用，rebuildFts 恢复 FTS 路径", () => {
  const { store, mem } = makeMemory("mem-rebuild");
  mem.save({ scope: "global", content: "青鸟计划定在三月启动" });
  assert.equal(mem.searchDebug({ query: "青鸟计划定在三月启动" }).path, "fts");

  store.db.exec("INSERT INTO mem_fts(mem_fts) VALUES('delete-all')");
  assert.equal(mem.searchDebug({ query: "青鸟计划定在三月启动" }).path, "like", "索引没了仍靠 LIKE 兜底");
  assert.equal(mem.search({ query: "青鸟计划" }).length, 1);

  mem.rebuildFts();
  assert.equal(mem.searchDebug({ query: "青鸟计划定在三月启动" }).path, "fts", "重建后回到 FTS 路径");
});
