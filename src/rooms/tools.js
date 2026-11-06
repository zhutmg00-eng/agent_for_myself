/**
 * Model-callable tools that implement the group-chat vision on top of pi.
 *
 * These are plain pi `ToolDefinition` objects (see
 * node_modules/@earendil-works/pi-coding-agent/docs/extensions.md#tools):
 *   { name, label, description, parameters <JSON Schema>, execute(...) }
 *
 * Permission model (mirrors the old harness + SPEC §3):
 *   - the room owner (boss) gets the admin surface,
 *   - `librarian` gets the write side of the group file space,
 *   - everyone can read the file space and list members,
 *   - a member with `can_create_subgroup` may pull a sub-group,
 *   - skills are available to all.
 */
import path from "node:path";

const ok = (text, details = {}) => ({
  content: [{ type: "text", text: String(text) }],
  details,
});

const fail = (text) => {
  const err = new Error(String(text));
  err.isToolError = true;
  throw err;
};

const obj = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const str = (description) => ({ type: "string", description });
const bool = (description) => ({ type: "boolean", description });

function requireRoomMethod(room, name) {
  if (typeof room?.[name] !== "function") {
    fail(`房间能力 ${name} 不可用（宿主未实现）`);
  }
  return room[name].bind(room);
}

/* ------------------------------------------------------------------ admin */

function adminTools({ room, botId }) {
  const guardOwner = () => {
    if (!room.isOwner?.(botId)) fail(`权限不足：只有群主可以执行该操作（当前调用者 ${botId}）`);
  };

  return [
    {
      name: "room_list_members",
      label: "列出群成员",
      description: "列出本群全部成员、每个成员的权限（能否发言/上下文范围/能否拉小群）。",
      parameters: obj({}),
      execute: async () => {
        const members = room.listMembers?.() || [];
        const text = members
          .map((m) => {
            const p = m.permissions || {};
            return `- ${m.bot_id}${m.bot_id === room.owner_id ? "（群主）" : ""}：can_speak=${p.can_speak !== false}，context=${p.context_access || "full"}，can_create_subgroup=${Boolean(p.can_create_subgroup)}`;
          })
          .join("\n");
        return ok(text || "（无成员）", { members });
      },
    },
    {
      name: "room_assign_task",
      label: "分派任务",
      description:
        "群主给某个成员分派具体任务。被分派的成员会在本轮按依赖顺序发言；一旦分派，本轮只跑被分派的成员。并行任务请声明 write_scope（会写到哪些路径/区域），写同一区域的任务必须用 depends_on 串行化，否则会被拒绝。",
      parameters: obj(
        {
          member: str("成员 id"),
          task: str("任务内容与验收标准"),
          task_id: str("可选：给这个任务起个 id（缺省自动 t1/t2…）；后续 depends_on 用它引用"),
          write_scope: str("可选：本任务会写到的路径/区域，逗号分隔（例如 reports/, src/rooms/）；不写文件可留空"),
          depends_on: str("可选：必须排在这些任务之后，填之前分派的 task_id，逗号分隔"),
        },
        ["member", "task"],
      ),
      execute: async (_id, params) => {
        guardOwner();
        const assign = requireRoomMethod(room, "assignTask");
        const list = (raw) =>
          String(raw || "")
            .split(/[,，;；]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        const writeScope = list(params.write_scope);
        const dependsOn = list(params.depends_on);
        try {
          const res = await assign(String(params.member), String(params.task), {
            id: params.task_id ? String(params.task_id).trim() : null,
            writeScope,
            dependsOn,
          });
          const suffix = [
            `task_id=${res.task_id}`,
            writeScope.length ? `写域=${writeScope.join(",")}` : "",
            dependsOn.length ? `依赖=${dependsOn.join(",")}` : "",
          ]
            .filter(Boolean)
            .join("，");
          return ok(`已把任务分派给 ${params.member}（${suffix}）：${params.task}`, { member: params.member, task_id: res.task_id, write_scope: writeScope, depends_on: dependsOn });
        } catch (err) {
          // fanout 契约拒绝：把原因原样回给群主，让它改成分步/加依赖，而不是抛栈。
          if (err?.code === "fanout_invalid") fail(err.message);
          throw err;
        }
      },
    },
    {
      name: "room_grant_permission",
      label: "授予权限",
      description: "群主调整成员权限：can_speak（能否发言）、context_access（full|summary|none）、can_create_subgroup。",
      parameters: obj(
        {
          member: str("成员 id"),
          can_speak: bool("是否允许发言"),
          context_access: str("上下文范围：full | summary | none"),
          can_create_subgroup: bool("是否允许发起小群"),
        },
        ["member"],
      ),
      execute: async (_id, params) => {
        guardOwner();
        const patch = {};
        if (params.can_speak !== undefined) patch.can_speak = Boolean(params.can_speak);
        if (params.context_access !== undefined) patch.context_access = String(params.context_access);
        if (params.can_create_subgroup !== undefined) patch.can_create_subgroup = Boolean(params.can_create_subgroup);
        const grant = requireRoomMethod(room, "grantPermission");
        const next = await grant(String(params.member), patch);
        return ok(`已更新 ${params.member} 的权限：${JSON.stringify(next)}`, { member: params.member, permissions: next });
      },
    },
    {
      name: "room_revoke_permission",
      label: "收回权限",
      description: "群主收回成员的某项权限（can_speak / can_create_subgroup / context_access）。",
      parameters: obj({ member: str("成员 id"), key: str("要收回的权限名") }, ["member", "key"]),
      execute: async (_id, params) => {
        guardOwner();
        const revoke = requireRoomMethod(room, "revokePermission");
        const next = await revoke(String(params.member), String(params.key));
        return ok(`已收回 ${params.member} 的 ${params.key}`, { member: params.member, permissions: next });
      },
    },
    {
      name: "room_set_context_policy",
      label: "设置上下文策略",
      description:
        "群主设置本群的上下文共享策略：shared（全员看到完整转录）/ summary（只看摘要+近窗）/ isolated（只看本轮任务）。",
      parameters: obj({ policy: str("shared | summary | isolated") }, ["policy"]),
      execute: async (_id, params) => {
        guardOwner();
        const setPolicy = requireRoomMethod(room, "setContextPolicy");
        const next = await setPolicy(String(params.policy));
        return ok(`上下文策略已设为 ${next}`, { policy: next });
      },
    },
    {
      name: "room_set_topic",
      label: "设置群主题",
      description: "群主更新本群的主题/目标，方便成员对齐。",
      parameters: obj({ topic: str("新的群主题") }, ["topic"]),
      execute: async (_id, params) => {
        guardOwner();
        const setTopic = requireRoomMethod(room, "setTopic");
        const next = await setTopic(String(params.topic));
        return ok(`群主题已更新为：${next}`, { topic: next });
      },
    },
  ];
}

function subgroupTool({ room, botId }) {
  return [
    {
      name: "room_create_subgroup",
      label: "拉小群讨论",
      description:
        "按任务需要从本群成员里挑几个人建一个小群，围绕指定问题讨论一轮，结论会自动回传到大群。",
      parameters: obj(
        {
          members: { type: "array", items: { type: "string" }, description: "要拉进小群的成员 id 列表" },
          topic: str("小群讨论的主题"),
          question: str("要小群回答的具体问题（可选）"),
        },
        ["members", "topic"],
      ),
      execute: async (_id, params) => {
        const canCreate = room.isOwner?.(botId) || room.permissionsOf?.(botId)?.can_create_subgroup;
        if (!canCreate) fail(`权限不足：${botId} 没有拉小群的权限`);
        const create = requireRoomMethod(room, "createSubgroup");
        const result = await create({
          members: Array.isArray(params.members) ? params.members.map(String) : [],
          topic: String(params.topic || ""),
          question: params.question ? String(params.question) : "",
          actor: botId,
        });
        const report = result?.report || result?.summary || "";
        return ok(
          `小群已建立（room_id=${result?.room_id || result?.roomId || "?"}），本轮结论：\n${report || "（无结论）"}`,
          result || {},
        );
      },
    },
  ];
}

/* ------------------------------------------------------------------ files */

function fileTools({ room, botId, fileSpace, permissions, archetype }) {
  const canWrite = archetype === "librarian" || archetype === "boss" || Boolean(permissions?.can_write_files);
  const tools = [
    {
      name: "room_file_list",
      label: "列出群文件",
      description: "列出群文件空间里的文件（file_id、文件名、描述）。当你不确定某个文件叫什么时先调用它。",
      parameters: obj({}),
      execute: async () => {
        const files = fileSpace.list();
        const text = files.length
          ? files.map((f) => `- file_id=${f.file_id} · ${path.posix.basename(f.path)}${f.description ? ` — ${f.description}` : ""}`).join("\n")
          : "（群文件空间为空）";
        return ok(text, { files });
      },
    },
    {
      name: "room_file_read",
      label: "按 file_id 读群文件",
      description: "用稳定的 file_id 读取群文件内容。不要用路径取文件——文件可能被移走，file_id 永远有效。",
      parameters: obj({ file_id: str("文件的 file_id") }, ["file_id"]),
      execute: async (_id, params) => {
        try {
          const file = fileSpace.read({ fileId: String(params.file_id) });
          return ok(
            `文件 ${file.path}（file_id=${file.file_id}）内容：\n\n${file.content}`,
            { file_id: file.file_id, path: file.path, bytes: file.bytes, truncated: file.truncated },
          );
        } catch (err) {
          fail(err?.message || String(err));
        }
      },
    },
  ];

  if (canWrite) {
    tools.push(
      {
        name: "room_file_save",
        label: "保存群文件",
        description: "把内容保存到群文件空间（文件管家职责）。保存后在群里只广播 file_id 与文件名，不要贴绝对路径。",
        parameters: obj(
          {
            name: str("文件名或相对路径，例如 intro.md 或 reports/2026-11.md"),
            content: str("文件全文"),
            description: str("一句话描述这个文件是什么"),
            tags: { type: "array", items: { type: "string" }, description: "标签" },
          },
          ["name", "content"],
        ),
        execute: async (_id, params) => {
          try {
            const rec = await fileSpace.save({
              name: params.name,
              content: params.content,
              description: params.description || "",
              tags: params.tags || [],
              actor: botId,
            });
            return ok(
              `已保存：file_id=${rec.file_id}，文件名 ${path.posix.basename(rec.path)}。请只广播 file_id 与文件名。`,
              rec,
            );
          } catch (err) {
            fail(err?.message || String(err));
          }
        },
      },
      {
        name: "room_file_move",
        label: "移动/重命名群文件",
        description:
          "移动或重命名群文件。成员继续用同一个 file_id 引用即可；系统会自动通知全员新地址，避免找不到文件。",
        parameters: obj(
          {
            file_id: str("要移动的文件的 file_id"),
            path: str("新的相对路径/文件名"),
            description: str("新的描述（可选）"),
          },
          ["file_id", "path"],
        ),
        execute: async (_id, params) => {
          try {
            const rec = await fileSpace.move({
              fileId: String(params.file_id),
              path: String(params.path),
              description: params.description,
              actor: botId,
            });
            return ok(
              `已移动：file_id=${rec.file_id}，新位置 ${rec.path}；已通知全员（file_id 不变）。`,
              rec,
            );
          } catch (err) {
            fail(err?.message || String(err));
          }
        },
      },
    );
  }

  return tools;
}

/* ----------------------------------------------------------------- skills */

function skillTools({ skills, botId, telemetry, roomId }) {
  if (!skills) return [];
  const listFn =
    typeof skills.list === "function" ? skills.list.bind(skills) : typeof skills === "object" && Array.isArray(skills.skills) ? () => skills.skills : null;
  const getFn = typeof skills.get === "function" ? skills.get.bind(skills) : null;
  if (!listFn) return [];

  // 用量遥测绝不能影响工具本身：记录失败只吞掉（对齐 Hermes skills_usage 的旁路写法）。
  const track = (skill, event, extra = {}) => {
    try {
      telemetry?.record?.({ skill, event, roomId, botId, ...extra });
    } catch {
      /* telemetry is best-effort */
    }
  };

  return [
    {
      name: "skill_list",
      label: "列出技能",
      description: "列出当前可用的技能（skill）及其用途说明。",
      parameters: obj({}),
      execute: async () => {
        const list = listFn() || [];
        for (const skill of list) track(skill?.name, "list");
        const text = list.length
          ? list.map((s) => `- ${s.name}：${s.description || ""}`).join("\n")
          : "（暂无技能）";
        return ok(text, { skills: list.map((s) => ({ name: s.name, description: s.description })) });
      },
    },
    {
      name: "skill_invoke",
      label: "加载技能指令",
      description: "按名字加载一个技能的完整指令，然后按它的步骤工作。",
      parameters: obj({ name: str("技能名") }, ["name"]),
      execute: async (_id, params) => {
        const started = Date.now();
        const skill = getFn ? getFn(String(params.name)) : (listFn() || []).find((s) => s.name === params.name);
        if (!skill) {
          track(String(params.name), "error", { ok: false, ms: Date.now() - started, detail: "not found" });
          fail(`技能不存在：${params.name}`);
        }
        track(skill.name, "invoke", { ok: true, ms: Date.now() - started });
        return ok(`技能 ${skill.name} 的指令：\n\n${skill.body || skill.content || skill.instructions || ""}`, {
          name: skill.name,
        });
      },
    },
  ];
}

/* ----------------------------------------------------------------- memory */

/**
 * 持久记忆工具（对齐 Hermes `memory` 工具的 action/target 语义）。
 *
 * 为什么要工具而不是让 agent 直接写库：记忆是**跨回合事实**，必须可审计、可删除、
 * 有 scope 边界；模型只能通过这个受控入口写，Lead 才能保证「谁在哪个房间记了什么」。
 * 破坏性动作（remove）要求显式 id，且 source 记为 agent，落 mem_audit。
 */
function memoryTools({ memory, roomId, botId }) {
  if (!memory) return [];
  const scopeOf = (raw) => {
    const scope = String(raw || "").trim().toLowerCase();
    return ["room", "bot", "global"].includes(scope) ? scope : "room";
  };
  const targetOf = (raw) => {
    const target = String(raw || "").trim().toLowerCase();
    return ["memory", "user"].includes(target) ? target : "memory";
  };
  const tagsOf = (raw) => {
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    return String(raw || "")
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  };
  const where = (scope) => ({ scope, roomId, botId });

  return [
    {
      name: "memory",
      label: "持久记忆",
      description:
        "读写跨回合的持久记忆。action: save（新增/合并相近内容）、replace（按 id 改写）、remove（按 id 删除）、search（关键词检索）、list（最近条目）。scope: room（本群）/ bot（本成员）/ global；target: memory（事实）/ user（用户偏好）。",
      parameters: obj(
        {
          action: str("save | replace | remove | search | list"),
          content: str("要记住的内容（save/replace；用陈述句，一条一个事实）"),
          query: str("检索关键词（search）"),
          id: str("记忆 id（replace/remove）"),
          scope: str("room | bot | global，默认 room"),
          target: str("memory | user，默认 memory"),
          tags: str("标签，逗号分隔"),
          pinned: bool("是否置顶（置顶条目优先注入上下文）"),
        },
        ["action"],
      ),
      execute: async (_id, params) => {
        const action = String(params.action || "").trim().toLowerCase();
        const scope = scopeOf(params.scope);
        const target = targetOf(params.target);

        if (action === "save") {
          const entry = memory.save({
            ...where(scope),
            target,
            content: String(params.content ?? ""),
            tags: tagsOf(params.tags),
            pinned: Boolean(params.pinned),
            source: "agent",
          });
          return ok(`已记住（${entry.scope}/${entry.target}）：${entry.content}`, { entry });
        }
        if (action === "replace") {
          const entry = memory.replace(String(params.id || ""), {
            content: params.content === undefined ? undefined : String(params.content),
            tags: params.tags === undefined ? undefined : tagsOf(params.tags),
            pinned: params.pinned === undefined ? undefined : Boolean(params.pinned),
            source: "agent",
          });
          return ok(`已更新记忆 ${entry.id}`, { entry });
        }
        if (action === "remove") {
          const result = memory.remove(String(params.id || ""), { source: "agent", reason: "agent 主动删除" });
          if (!result?.ok) fail(result?.error || "删除失败");
          return ok(`已删除记忆 ${params.id}`, result);
        }
        if (action === "search") {
          const results = memory.search({
            query: String(params.query ?? ""),
            ...where(scope),
            target,
            limit: 10,
          });
          const text = results.length
            ? results.map((hit) => `- [${hit.entry.id}] ${hit.entry.content}`).join("\n")
            : "（没有匹配的记忆）";
          return ok(text, { results });
        }
        if (action === "list") {
          const entries = memory.list({ ...where(scope), target, limit: 20 });
          const text = entries.length
            ? entries.map((entry) => `- [${entry.id}] ${entry.pinned ? "📌 " : ""}${entry.content}`).join("\n")
            : "（暂无记忆）";
          return ok(text, { entries });
        }
        fail(`未知 action：${params.action}（可选 save / replace / remove / search / list）`);
        return null;
      },
    },
  ];
}

/* --------------------------------------------------------------- evidence */

/**
 * 证据阶梯查询（read-only，全员可用）。
 *
 * 为什么做成工具而不是只在 UI 展示：审查员需要**在回合内**核对"对方的完成声明有没有
 * 真实工具结果支撑"。把它变成工具，模型才能主动查；也避免把证据状态硬塞进系统提示
 * （那会破坏 pi 的 prompt 前缀缓存）。
 */
function evidenceTools({ room }) {
  if (!room?.evidenceStore) return [];
  return [
    {
      name: "room_evidence_status",
      label: "查询证据阶梯",
      description:
        "查询本群每个成员回合的证据判定：observed（有真实成功的工具结果）、prepared（只有文本声明）、mismatch（声称的文件/操作与证据不符）。审查前用它核对产出是否真的被工具验证过。",
      parameters: obj({ limit: str("可选：最多返回多少条，默认 12") }),
      execute: async (_id, params = {}) => {
        const limit = Math.max(1, Math.min(Number(params.limit) || 12, 50));
        const evidence = room.evidenceStore;
        const summary = evidence.summary({ roomId: room.room_id });
        const records = evidence.list({ roomId: room.room_id, limit });
        const lines = records.map(
          (r) => `- #${r.message_seq} ${r.bot_id || "?"}：${r.status}${r.reasons?.length ? `（${r.reasons.join("；")}）` : ""}`,
        );
        const text = [
          `证据汇总：observed=${summary.observed} prepared=${summary.prepared} mismatch=${summary.mismatch}（共 ${summary.total}）`,
          lines.length ? lines.join("\n") : "（还没有证据记录）",
        ].join("\n");
        return ok(text, { summary, records });
      },
    },
  ];
}

/* ---------------------------------------------------------------- factory */

/**
 * @param {{room:object, botId:string, permissions?:object, fileSpace:object, skills?:object,
 *          memory?:object, telemetry?:object}} ctx
 * @returns {Array<object>} pi ToolDefinition[]
 */
export function createRoomTools({ room, botId, permissions, fileSpace, skills, memory, telemetry } = {}) {
  if (!room) throw new Error("createRoomTools requires a room");
  if (!botId) throw new Error("createRoomTools requires botId");
  const perms = permissions || {};
  const archetype = room.botArchetype?.(botId) || perms.archetype;
  const owner = room.isOwner?.(botId);
  const tools = [];
  const roomId = room.room_id;

  // Everyone may see the roster; the rest of the admin surface is owner-only.
  tools.push({
    name: "room_list_members",
    label: "列出群成员",
    description: "列出本群全部成员及其权限。",
    parameters: obj({}),
    execute: async () => {
      const members = room.listMembers?.() || [];
      const text = members
        .map((m) => `- ${m.bot_id}${m.bot_id === room.owner_id ? "（群主）" : ""}`)
        .join("\n");
      return ok(text || "（无成员）", { members });
    },
  });

  if (owner) tools.push(...adminTools({ room, botId }).filter((t) => t.name !== "room_list_members"));
  if (owner || perms.can_create_subgroup) tools.push(...subgroupTool({ room, botId }));
  if (fileSpace) tools.push(...fileTools({ room, botId, fileSpace, permissions: perms, archetype }));
  tools.push(...evidenceTools({ room }));
  tools.push(...skillTools({ skills, botId, telemetry, roomId }));
  tools.push(...memoryTools({ memory, roomId, botId }));

  return tools;
}

export default createRoomTools;
