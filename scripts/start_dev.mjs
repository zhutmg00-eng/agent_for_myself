#!/usr/bin/env node
/**
 * AgentFusion 桌面壳开发启动器
 *
 *   node scripts/start_dev.mjs                 # 用仓库里的 desktop/main.cjs 起 Electron
 *   node scripts/start_dev.mjs -- --port 8800  # 透传参数给桌面壳
 *   node scripts/start_dev.mjs --data-root D:\AgentFusion-dev
 *
 * 说明：
 *  - 直接使用 electronDist() 解析到的 electron.exe，参数为仓库根目录（含 package.json → main=desktop/main.cjs）；
 *  - 所有可写目录（userData/temp/logs）由 desktop/main.cjs 重定向到 D 盘数据根；
 *  - 不用 npm install，也不用 electron-builder。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const IS_WIN = process.platform === 'win32';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const ownArgs = sep >= 0 ? argv.slice(0, sep) : argv;
const passthrough = sep >= 0 ? argv.slice(sep + 1) : [];

function argValue(flag) {
  for (let i = 0; i < ownArgs.length; i++) {
    const a = ownArgs[i];
    if (a === flag && i + 1 < ownArgs.length) return ownArgs[i + 1];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return null;
}

function assertD(target, label) {
  const abs = path.resolve(String(target));
  const m = /^([a-zA-Z]):[\\/]/.exec(abs);
  if (m && m[1].toUpperCase() === 'C') {
    throw new Error(`[guard] 拒绝使用 C 盘路径（${label}）：${abs}`);
  }
  return abs;
}

async function resolveElectron() {
  let cfg = {};
  try {
    cfg = await import(pathToFileURL(path.join(ROOT, 'src', 'config.js')).href);
  } catch {
    /* ignore */
  }
  if (typeof cfg.electronDist === 'function') {
    try {
      const found = cfg.electronDist();
      if (found) return found;
    } catch {
      /* ignore */
    }
  }
  const candidates = [
    process.env.FUSION_ELECTRON_DIST,
    path.join(ROOT, 'node_modules', 'electron', 'dist'),
    path.resolve(ROOT, '..', 'agentharness', 'desktop', 'node_modules', 'electron', 'dist'),
    'D:\\tools\\pi\\node_modules\\electron\\dist',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, IS_WIN ? 'electron.exe' : 'electron'))) return path.resolve(c);
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function main() {
  const electronDir = await resolveElectron();
  if (!electronDir) {
    console.error('[dev] ✗ 找不到 Electron 运行时（需要包含 electron.exe 的 dist 目录）');
    console.error('[dev]   可用 FUSION_ELECTRON_DIST 环境变量指定');
    process.exit(1);
  }
  const exe = path.join(electronDir, IS_WIN ? 'electron.exe' : 'electron');
  const desktopMain = path.join(ROOT, 'desktop', 'main.cjs');
  if (!fs.existsSync(desktopMain)) {
    console.error(`[dev] ✗ 缺少桌面壳入口：${desktopMain}`);
    process.exit(1);
  }

  const dataRoot = assertD(
    argValue('--data-root') || process.env.FUSION_DATA_ROOT || (IS_WIN ? 'D:\\AgentFusion' : path.join(os.homedir(), 'AgentFusion')),
    'data-root',
  );
  const tempDir = path.join(dataRoot, 'temp');
  fs.mkdirSync(tempDir, { recursive: true });

  const env = {
    ...process.env,
    FUSION_DATA_ROOT: dataRoot,
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
  };
  // 若从 ELECTRON_RUN_AS_NODE 环境继承，Electron 会变成纯 Node，桌面壳起不来。
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.FUSION_PORT) env.FUSION_PORT = process.env.FUSION_PORT;

  const electronArgs = [ROOT, ...passthrough];
  console.log(`[dev] electron : ${exe}`);
  console.log(`[dev] app root : ${ROOT}`);
  console.log(`[dev] data root: ${dataRoot}`);
  console.log(`[dev] args     : ${electronArgs.slice(1).join(' ') || '(无)'}`);
  console.log('');

  const child = spawn(exe, electronArgs, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    windowsHide: false,
  });

  const stop = (signal) => {
    if (child.exitCode !== null || child.killed) return;
    if (IS_WIN) {
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch {
        /* ignore */
      }
    } else {
      try {
        child.kill(signal || 'SIGTERM');
      } catch {
        /* ignore */
      }
    }
  };
  process.on('SIGINT', () => {
    stop('SIGINT');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stop('SIGTERM');
    process.exit(0);
  });
  child.on('exit', (code, signal) => {
    console.log(`[dev] Electron 退出 code=${code} signal=${signal || '-'}`);
    process.exit(code == null ? 0 : code);
  });
  child.on('error', (err) => {
    console.error(`[dev] ✗ 启动 Electron 失败：${err && err.message}`);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(`[dev] ✗ ${(err && err.stack) || err}`);
  process.exit(1);
});
