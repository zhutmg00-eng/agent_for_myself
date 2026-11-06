#!/usr/bin/env node
/**
 * AgentFusion process entry point.
 *
 *   node src/main.js [--port 8720] [--host 127.0.0.1] [--data-root D:\AgentFusion]
 *
 * IMPORTANT: config.bootstrapEnv() must run BEFORE anything imports pi, and pi is
 * imported from inside the engine modules. Therefore every project module is
 * loaded dynamically, after the environment is prepared.
 */
import process from "node:process";
import path from "node:path";
import os from "node:os";

const USAGE = `AgentFusion server

用法:
  node src/main.js [options]

选项:
  -p, --port <n>        监听端口 (默认 8720；被占用时自动 +1 重试，最多 10 次)
      --host <addr>     监听地址 (默认 127.0.0.1)
      --data-root <dir> 数据根目录 (默认 D:\\AgentFusion，环境变量 FUSION_DATA_ROOT)
  -v, --verbose         输出调试日志 (等价于 FUSION_VERBOSE=1)
  -h, --help            显示本帮助
`;

function parseArgs(argv) {
  const opts = { port: undefined, host: undefined, dataRoot: undefined, verbose: false, help: false };
  const args = argv.slice(2);
  const takeValue = (index, flag) => {
    const value = args[index];
    if (value === undefined || value.startsWith("--") || value.startsWith("-")) {
      throw new Error(`${flag} 需要一个值`);
    }
    return value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "-v" || arg === "--verbose") {
      opts.verbose = true;
    } else if (arg === "-p" || arg === "--port") {
      const raw = takeValue((i += 1), arg);
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`端口不合法: ${raw}`);
      opts.port = port;
    } else if (arg.startsWith("--port=")) {
      const port = Number(arg.slice("--port=".length));
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`端口不合法: ${arg}`);
      opts.port = port;
    } else if (arg === "--host") {
      opts.host = takeValue((i += 1), arg);
    } else if (arg.startsWith("--host=")) {
      opts.host = arg.slice("--host=".length);
    } else if (arg === "--data-root" || arg === "--data") {
      opts.dataRoot = takeValue((i += 1), arg);
    } else if (arg.startsWith("--data-root=")) {
      opts.dataRoot = arg.slice("--data-root=".length);
    } else if (arg === "--") {
      break;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return opts;
}

function fail(message, code = 1) {
  process.stderr.write(`[AgentFusion] ${message}\n`);
  process.exit(code);
}

function banner(env, serverInfo) {
  const { url, port } = serverInfo;
  const app = serverInfo.app || {};
  const lines = [
    "",
    "  AgentFusion — 群聊智能体工作台 (pi 内核)",
    `  服务地址   ${url}`,
    `  端口       ${port}`,
    `  数据目录   ${env.DATA_ROOT}`,
    `  工作区     ${env.DIRS.workspace}`,
    `  内核       ${app.wiring?.engine === "ok" ? "pi 已就绪" : `pi ${app.wiring?.engine || "未加载"}`}`,
    "",
    "  API:",
    "    GET  /api/health                健康检查",
    "    GET  /api/bots                  机器人名册",
    "    GET  /api/models                模型目录",
    "    GET  /api/rooms                 群聊列表           POST /api/rooms 建群",
    "    POST /api/rooms/{id}/say        在群里发言（立即返回，回合后台跑）",
    "    GET  /api/thread/{id}/events    事件回放",
    "    GET  /api/skills                技能库          GET /api/hooks 治理规则",
    "    GET  /api/events                SSE 事件流",
    "    GET  /api/stats                 用量统计",
    "    GET  /                          前端页面",
    "",
    "  按 Ctrl+C 停止服务。",
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
  const problems = Object.entries(app.errors || {});
  if (problems.length) {
    process.stdout.write("  ⚠ 部分子模块未就绪（HTTP 仍可用，相关端点降级）：\n");
    for (const [name, message] of problems) process.stdout.write(`    - ${name}: ${message}\n`);
    process.stdout.write("\n");
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    process.stderr.write(`[AgentFusion] ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (opts.verbose) process.env.FUSION_VERBOSE = "1";

  // Environment must be prepared before config.js is evaluated (DATA_ROOT) and
  // before anything imports pi.
  if (opts.dataRoot) process.env.FUSION_DATA_ROOT = opts.dataRoot;
  if (opts.port !== undefined) process.env.FUSION_PORT = String(opts.port);
  if (opts.host) process.env.FUSION_HOST = opts.host;
  if (!process.env.FUSION_DATA_ROOT) {
    process.env.FUSION_DATA_ROOT = path.join("D:\\AgentFusion");
  }

  const config = await import("./config.js");
  config.bootstrapEnv();

  const { createLogger } = await import("./log.js");
  const log = createLogger("main");
  log.info(`AgentFusion starting (pid ${process.pid}, node ${process.version})`);
  log.info(`data root: ${config.DATA_ROOT}`);

  const { startServer } = await import("./api/server.js");

  let serverInfo;
  try {
    serverInfo = await startServer({
      port: opts.port ?? config.PORT_DEFAULT,
      host: opts.host ?? config.HOST,
    });
  } catch (err) {
    fail(`启动失败: ${err?.stack || err?.message || err}`);
    return;
  }

  banner(config, serverInfo);
  log.info(`server ready at ${serverInfo.url}`);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n[AgentFusion] 收到 ${signal}，正在关闭…\n`);
    const timer = setTimeout(() => {
      process.stderr.write("[AgentFusion] 关闭超时，强制退出。\n");
      process.exit(1);
    }, 8000);
    timer.unref?.();
    try {
      await serverInfo.close();
    } catch (err) {
      process.stderr.write(`[AgentFusion] 关闭时出错: ${err?.message || err}\n`);
    } finally {
      clearTimeout(timer);
    }
    process.stdout.write("[AgentFusion] 已停止。\n");
    process.exit(0);
  };

  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGHUP", () => void stop("SIGHUP"));
  process.on("unhandledRejection", (reason) => {
    log.error("unhandledRejection:", reason?.stack || reason?.message || String(reason));
  });
  process.on("uncaughtException", (err) => {
    log.error("uncaughtException:", err?.stack || err?.message || String(err));
    if (err?.code === "EPIPE") return;
  });
  process.on("exit", (code) => {
    log.info(`process exiting with code ${code}`);
  });

  return serverInfo;
}

main().catch((err) => {
  process.stderr.write(`[AgentFusion] 致命错误: ${err?.stack || err?.message || err}\n`);
  process.exit(1);
});

export { parseArgs };
