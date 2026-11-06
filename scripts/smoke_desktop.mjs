#!/usr/bin/env node
/**
 * AgentFusion 桌面冒烟测试（零依赖）
 *
 *   node scripts/smoke_desktop.mjs [--exe <path>] [--port 8799] [--timeout 180000]
 *                                  [--data-root D:\AgentFusion] [--keep] [--no-c-check]
 *
 * 流程：
 *   1. 启动 dist/AgentFusion-win64/AgentFusion.exe（真实 Electron 运行时）；
 *   2. 轮询 http://127.0.0.1:<port>/api/health 直到 200，记录启动耗时；
 *   3. 等待桌面壳写出的诊断 JSON（含窗口标题/DOM 文本长度/窗口截图 PNG）；
 *   4. 窗口自动关闭（FUSION_AUTOQUIT_MS）→ 校验退出码、无残留进程、端口已释放；
 *   5. 对比 C 盘（%TEMP% / %LOCALAPPDATA% / %APPDATA%）快照，确认没有新增 AgentFusion 文件。
 *
 * 退出码：0 = PASS，1 = FAIL。
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const IS_WIN = process.platform === 'win32';

const DEFAULT_DATA_ROOT = IS_WIN ? 'D:\\AgentFusion' : path.join(os.homedir(), 'AgentFusion');
const DEFAULT_EXE = path.join(ROOT, 'dist', 'AgentFusion-win64', 'AgentFusion.exe');

function parseArgs(argv) {
  const out = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) continue;
    if (a.includes('=')) {
      const idx = a.indexOf('=');
      out.values[a.slice(0, idx)] = a.slice(idx + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('-')) {
      out.values[a] = next;
      i++;
    } else {
      out.flags.add(a);
    }
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const EXE = path.resolve(ARGS.values['--exe'] || process.env.FUSION_EXE || DEFAULT_EXE);
const BASE_PORT = Number(ARGS.values['--port'] || process.env.FUSION_SMOKE_PORT || 8799) || 8799;
const TIMEOUT_MS = Number(ARGS.values['--timeout'] || 180000) || 180000;
const KEEP = ARGS.flags.has('--keep');
const NO_C_CHECK = ARGS.flags.has('--no-c-check');
const ISOLATED = ARGS.flags.has('--isolated');
const AUTO_QUIT_MS = Number(ARGS.values['--autoquit'] || 1200) || 1200;

let DATA_ROOT = path.resolve(ARGS.values['--data-root'] || process.env.FUSION_DATA_ROOT || DEFAULT_DATA_ROOT);

function assertD(target, label) {
  const abs = path.resolve(String(target));
  const m = /^([a-zA-Z]):[\\/]/.exec(abs);
  if (m && m[1].toUpperCase() === 'C') {
    throw new Error(`[guard] 拒绝在 C 盘写入（${label}）：${abs}`);
  }
  return abs;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtSize(bytes) {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/* --------------------------------------------------------------- 端口/健康 */

function portIsFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        s.close(() => resolve(ok));
      } catch {
        resolve(ok);
      }
    };
    s.once('error', () => finish(false));
    s.once('listening', () => finish(true));
    try {
      s.listen(port, '127.0.0.1');
    } catch {
      finish(false);
    }
  });
}

async function choosePort(base) {
  for (let p = base; p <= base + 24; p++) if (await portIsFree(p)) return p;
  return base;
}

function getJson(port, urlPath, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let req;
    try {
      req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          raw += c;
          if (raw.length > 1_000_000) res.destroy();
        });
        res.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
          done({ ok: res.statusCode === 200, status: res.statusCode, body });
        });
        res.on('error', () => done({ ok: false, status: 0, body: null }));
      });
    } catch {
      done({ ok: false, status: 0, body: null });
      return;
    }
    req.on('timeout', () => {
      req.destroy();
      done({ ok: false, status: 0, body: null });
    });
    req.on('error', () => done({ ok: false, status: 0, body: null }));
  });
}

/* ------------------------------------------------------------- C 盘快照 */

function cRoots() {
  const list = [];
  for (const key of ['TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE']) {
    const v = process.env[key];
    if (v && /^[a-zA-Z]:[\\/]/.test(v) && v[0].toUpperCase() === 'C') {
      list.push(v);
      if (key === 'LOCALAPPDATA' || key === 'APPDATA') list.push(path.join(v, '..'));
    }
  }
  if (process.env.TEMP && process.env.TEMP[0] && process.env.TEMP[0].toUpperCase() !== 'C') {
    // 当前进程 TEMP 已在 D 盘时，仍要检查系统默认 C 盘临时目录
    const home = os.homedir();
    if (/^[a-zA-Z]:/.test(home) && home[0].toUpperCase() === 'C') {
      list.push(path.join(home, 'AppData', 'Local', 'Temp'), path.join(home, 'AppData', 'Roaming'));
    }
  }
  return [...new Set(list.map((p) => path.resolve(p)))].filter((p) => p[0].toUpperCase() === 'C');
}

function snapshotC() {
  const hits = new Set();
  for (const root of cRoots()) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (/agentfusion|agent-fusion/i.test(e.name)) hits.add(path.join(root, e.name));
    }
  }
  return hits;
}

/* ------------------------------------------------------------- 进程检查 */

/**
 * 列出「可执行文件路径等于本产物」的进程（避免把并行构建/其它目录的同名进程误判为残留）。
 * 返回 [{ pid, exePath }]；PowerShell 不可用时退回 tasklist（只给 pid）。
 */
function listProcsWithPath(exePath) {
  if (!IS_WIN) return null;
  const image = path.basename(exePath);
  try {
    const res = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='${image}'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 25000 },
    );
    const out = String(res.stdout || '').trim();
    if (res.status !== 0 && !out) return null;
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf('|');
        const pid = Number(idx >= 0 ? line.slice(0, idx) : line);
        const exe = idx >= 0 ? line.slice(idx + 1).trim() : '';
        return { pid, exePath: exe };
      })
      .filter((p) => Number.isFinite(p.pid) && p.pid > 0);
  } catch {
    return null;
  }
}

function tasklistPids(imageName) {
  if (!IS_WIN) return [];
  try {
    const res = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
    });
    const out = String(res.stdout || '');
    const pids = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (m) pids.push(Number(m[2]));
    }
    return pids;
  } catch {
    return [];
  }
}

/** 只返回属于本产物路径的进程。 */
function ownProcesses(exePath, baselinePids) {
  const exeResolved = path.resolve(exePath).toLowerCase();
  const procs = listProcsWithPath(exePath);
  if (procs === null) {
    // PowerShell 不可用：退化为「同名进程 pid 与本进程启动前快照的差集」
    const now = tasklistPids(path.basename(exePath));
    return now.filter((pid) => !baselinePids.has(pid)).map((pid) => ({ pid, exePath: '(unknown)' }));
  }
  return procs.filter((p) => {
    if (baselinePids.has(p.pid)) return false;
    if (!p.exePath) return true; // 路径不可读（权限），按新增 pid 计
    return path.resolve(p.exePath).toLowerCase() === exeResolved;
  });
}

function killTree(pid) {
  if (!IS_WIN) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15000,
    });
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ main */

async function main() {
  const startedAt = Date.now();
  const logs = [];
  const step = (msg) => {
    logs.push(msg);
    console.log(`[smoke] ${msg}`);
  };
  const fail = (msg) => {
    console.error(`[smoke] ✗ ${msg}`);
    failure = true;
  };
  let failure = false;

  if (!fs.existsSync(EXE)) {
    console.error(`[smoke] ✗ 找不到可执行文件：${EXE}`);
    console.error('[smoke]   请先运行：node scripts/build_portable.mjs');
    process.exit(1);
  }

  DATA_ROOT = assertD(DATA_ROOT, 'data-root');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (ISOLATED) {
    // 与其它并行会话/正在运行的实例彻底隔离（各自独立的 userData、DB、临时目录）
    DATA_ROOT = path.join(DATA_ROOT, 'smoke', stamp);
  }
  const workDir = assertD(path.join(DATA_ROOT, 'logs', `smoke-${stamp}`), 'smoke work dir');
  fs.mkdirSync(workDir, { recursive: true });
  const diagFile = path.join(workDir, 'diag.json');
  const outLog = path.join(workDir, 'stdout.log');
  const errLog = path.join(workDir, 'stderr.log');

  step(`可执行文件：${EXE}（${fmtSize(fs.statSync(EXE).size)}）`);
  step(`数据目录：${DATA_ROOT}`);

  const port = await choosePort(BASE_PORT);
  step(`端口：${port}${port !== BASE_PORT ? `（${BASE_PORT} 被占用）` : ''}`);

  // 只把「与本产物同路径」的进程算作既有实例，避免误伤并行构建的同名程序
  const exeLower = EXE.toLowerCase();
  const baselineProcs = (listProcsWithPath(EXE) || []).filter(
    (p) => p.exePath && path.resolve(p.exePath).toLowerCase() === exeLower,
  );
  const baselinePids = new Set(baselineProcs.map((p) => p.pid));
  if (baselineProcs.length) {
    console.warn(`[smoke] ! 本产物已有 ${baselineProcs.length} 个实例在运行：${baselineProcs.map((p) => p.pid).join(', ')}`);
  }

  const beforeC = NO_C_CHECK ? new Set() : snapshotC();
  step(`C 盘快照：${beforeC.size} 个既有 AgentFusion 条目`);

  const env = {
    ...process.env,
    FUSION_DATA_ROOT: DATA_ROOT,
    FUSION_PORT: String(port),
    FUSION_DIAG_FILE: diagFile,
    FUSION_AUTOQUIT_MS: KEEP ? '0' : String(AUTO_QUIT_MS),
    // 冒烟环境可能有同 userData 的既有实例，禁用单实例锁以保证本次一定真正启动
    FUSION_SINGLE_INSTANCE: '0',
    TEMP: path.join(DATA_ROOT, 'temp'),
    TMP: path.join(DATA_ROOT, 'temp'),
  };
  // 会话环境里若残留 ELECTRON_RUN_AS_NODE=1，Electron 会退化成纯 Node 并静默退出。
  if (env.ELECTRON_RUN_AS_NODE) {
    console.warn('[smoke] ! 已忽略继承的 ELECTRON_RUN_AS_NODE（否则 Electron 会以 Node 模式运行）');
    delete env.ELECTRON_RUN_AS_NODE;
  }
  fs.mkdirSync(env.TEMP, { recursive: true });

  const outFd = fs.openSync(outLog, 'a');
  const errFd = fs.openSync(errLog, 'a');
  let child;
  const exitInfo = { code: null, signal: null, at: 0 };
  try {
    child = spawn(EXE, [], {
      env,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      detached: false,
    });
  } finally {
    try {
      fs.closeSync(outFd);
    } catch {
      /* ignore */
    }
    try {
      fs.closeSync(errFd);
    } catch {
      /* ignore */
    }
  }

  let exited = false;
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      exitInfo.code = code;
      exitInfo.signal = signal;
      exitInfo.at = Date.now();
      resolve(exitInfo);
    });
    child.once('error', (err) => {
      console.error(`[smoke] ✗ 启动失败：${err && err.message}`);
      failure = true;
      resolve({ code: null, signal: null, error: err });
    });
  });
  step(`已启动（pid=${child.pid}），轮询健康检查…`);

  // 1) 健康检查
  const deadline = Date.now() + TIMEOUT_MS;
  let health = { ok: false };
  let healthAt = 0;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    health = await getJson(port, '/api/health', 1800);
    if (health.ok) {
      healthAt = Date.now();
      break;
    }
    if (exited) {
      fail(`进程在健康检查通过前退出（code=${exitInfo.code}）`);
      break;
    }
    await sleep(attempt < 10 ? 200 : 500);
  }
  if (!health.ok && !exited) fail(`健康检查超时（${TIMEOUT_MS}ms，尝试 ${attempt} 次）`);
  if (health.ok) {
    step(`/api/health 200，耗时 ${healthAt - startedAt}ms → ${JSON.stringify(health.body).slice(0, 200)}`);
  }

  // 2) 诊断（窗口内容 + 截图）
  const diagDeadline = Date.now() + Math.max(60000, TIMEOUT_MS / 2);
  while (Date.now() < diagDeadline && !fs.existsSync(diagFile)) {
    if (exited) break; // 进程已退出就不会再写诊断，立刻失败
    await sleep(250);
  }
  let diag = null;
  if (fs.existsSync(diagFile)) {
    try {
      diag = JSON.parse(fs.readFileSync(diagFile, 'utf8'));
      step(
        `窗口：title=${JSON.stringify(diag.title)} url=${diag.url} ` +
          `textLength=${diag.dom ? diag.dom.textLength : 'n/a'} nodes=${diag.dom ? diag.dom.nodes : 'n/a'}`,
      );
      if (diag.dom) {
        if (diag.dom.isErrorPage) fail('窗口显示的是启动失败错误页（服务端/前端未能加载）');
        if (!diag.dom.textLength || diag.dom.textLength < 20) fail('窗口内容为空（DOM 文本过短）');
        else step(`窗口内容 OK（品牌=${JSON.stringify(diag.dom.brand || '')}，前 80 字：${String(diag.dom.textSample || '').slice(0, 80).replace(/\s+/g, ' ')}）`);
        if (diag.dom.brand && !/AgentFusion/i.test(diag.dom.brand)) {
          console.warn(`[smoke] ! 品牌名不是 AgentFusion：${diag.dom.brand}`);
        }
      }
      if (diag.screenshot && fs.existsSync(diag.screenshot)) {
        step(`截图：${diag.screenshot}（${fmtSize(fs.statSync(diag.screenshot).size)}）`);
      } else {
        console.warn('[smoke] ! 未生成窗口截图');
      }
      if (diag.port && Number(diag.port) !== port) {
        console.warn(`[smoke] ! 诊断端口 ${diag.port} 与预期 ${port} 不一致`);
      }
      const t = diag.timings || {};
      step(`时序：窗口可见 ${t.windowShownMs || '?'}ms · 服务端启动 ${t.serverStartMs || '?'}ms · 首屏 ${t.firstLoadMs || '?'}ms`);
    } catch (err) {
      fail(`诊断 JSON 解析失败：${err && err.message}`);
    }
  } else {
    fail('未等到桌面壳诊断文件（窗口可能没起来）');
  }

  // 3) 退出
  if (KEEP) {
    step('--keep：保留进程，3s 后强制结束');
    await sleep(3000);
    killTree(child.pid);
  }
  const settle = Math.min(45000, Math.max(15000, TIMEOUT_MS / 3));
  const waitExit = await Promise.race([exitPromise, sleep(settle).then(() => null)]);
  if (!waitExit) {
    fail(`进程在 ${settle}ms 内未退出`);
    killTree(child.pid);
    await Promise.race([exitPromise, sleep(8000)]);
  } else {
    step(`进程退出：code=${exitInfo.code} signal=${exitInfo.signal}（退出耗时 ${exitInfo.at - startedAt}ms）`);
    if (!KEEP && exitInfo.code !== 0) fail(`退出码非 0：${exitInfo.code}`);
  }

  // 4) 残留进程（只统计本产物路径下的进程；Chromium 子进程可能比主进程晚 1~3s 退出）
  let residual = ownProcesses(EXE, baselinePids);
  for (let i = 0; i < 20 && residual.length; i++) {
    await sleep(250);
    residual = ownProcesses(EXE, baselinePids);
  }
  if (residual.length) {
    fail(`仍有本产物残留进程 ${residual.length} 个（等待 5s 后仍在）：`);
    for (const p of residual) console.error(`        pid=${p.pid}  ${p.exePath}`);
    for (const p of residual) killTree(p.pid);
    await sleep(700);
    const left = ownProcesses(EXE, baselinePids);
    if (left.length) console.error(`[smoke] 强制清理后仍有 ${left.length} 个残留`);
    else step('已强制清理残留进程（说明主进程退出不干净，需要排查）');
  } else {
    step('无残留进程（进程树已完全退出）');
  }
  const freeAfter = await portIsFree(port);
  if (!freeAfter) fail(`端口 ${port} 关闭后仍被占用`);
  else step(`端口 ${port} 已释放`);

  // 5) C 盘
  if (!NO_C_CHECK) {
    const afterC = snapshotC();
    const added = [...afterC].filter((p) => !beforeC.has(p));
    if (added.length) {
      fail(`C 盘新增 AgentFusion 条目 ${added.length} 个：`);
      for (const p of added) console.error(`        ${p}`);
    } else {
      step(`C 盘无新增（检查了 ${cRoots().length} 个目录：${cRoots().join(', ')}）`);
    }
  }

  // 6) 失败时打印日志尾部
  if (failure) {
    for (const [label, file] of [
      ['stderr', errLog],
      ['stdout', outLog],
      ['desktop.log', path.join(DATA_ROOT, 'logs', 'desktop.log')],
    ]) {
      try {
        const text = fs.readFileSync(file, 'utf8').trim();
        if (text) console.error(`\n[smoke] --- ${label} (${file}) 尾部 ---\n${text.split(/\r?\n/).slice(-40).join('\n')}`);
      } catch {
        /* ignore */
      }
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('');
  console.log(
    failure
      ? `[smoke] ❌ FAIL（${elapsed}s）`
      : `[smoke] ✅ PASS（${elapsed}s） 健康检查 ${healthAt ? healthAt - startedAt : '?'}ms · 窗口截图 ${diag && diag.screenshot ? diag.screenshot : '无'}`,
  );
  console.log(`[smoke] 本次产物：${workDir}`);
  process.exit(failure ? 1 : 0);
}

main().catch((err) => {
  console.error(`[smoke] ✗ ${(err && err.stack) || err}`);
  process.exit(1);
});
