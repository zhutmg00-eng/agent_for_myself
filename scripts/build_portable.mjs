#!/usr/bin/env node
/**
 * AgentFusion 便携版打包脚本（不依赖 electron-builder / 任何 npm 依赖）
 *
 *   node scripts/build_portable.mjs             # 全量：electron dist + resources/app
 *   node scripts/build_portable.mjs --app-only  # 只重建 resources/app（迭代时很快）
 *   node scripts/build_portable.mjs --dry-run   # 只打印计划
 *   node scripts/build_portable.mjs --strict    # 相对 import 解析失败即失败
 *
 * 产物：<repo>/dist/AgentFusion-win64/
 *   ├─ AgentFusion.exe                 （由 electron.exe 改名）
 *   ├─ *.dll / *.pak / locales/ …      （Electron 运行时全量）
 *   └─ resources/app/
 *        ├─ package.json              （main = desktop/main.cjs）
 *        ├─ desktop/{main.cjs,preload.cjs,splash.html,assets/**}
 *        ├─ src/**                    （ESM 服务端；跳过临时 *.mjs）
 *        ├─ web/**                    （静态前端）
 *        └─ node_modules/@earendil-works/pi-coding-agent/{package.json,dist,CHANGELOG.md}
 *
 * 安全：任何删除/复制前都做「只允许 C 盘以外 + 只允许 fusion/dist 之下」的绝对路径校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST_PARENT = path.join(ROOT, 'dist');
const OUT_DIR = path.join(DIST_PARENT, 'AgentFusion-win64');
const RES_DIR = path.join(OUT_DIR, 'resources');
const APP_DIR = path.join(RES_DIR, 'app');
const PI_REL = path.join('node_modules', '@earendil-works', 'pi-coding-agent');
const EXE_NAME = 'AgentFusion.exe';
const SRC_EXE = 'electron.exe';
const PRODUCT = 'AgentFusion';

const ARGV = process.argv.slice(2);
const FLAGS = new Set(ARGV.filter((a) => a.startsWith('-')));
const APP_ONLY = FLAGS.has('--app-only') || FLAGS.has('--apponly');
const DRY_RUN = FLAGS.has('--dry-run');
const STRICT = FLAGS.has('--strict');
const ALLOW_MISSING_SERVER = FLAGS.has('--allow-missing-server');
const NO_CLEAN = FLAGS.has('--no-clean');

const T0 = Date.now();
const log = (m) => console.log(`[build] ${m}`);
const warn = (m) => console.warn(`[build][warn] ${m}`);

/* --------------------------------------------------------------- 路径守卫 */

function assertD(target, label) {
  const abs = path.resolve(String(target));
  const m = /^([a-zA-Z]):[\\/]/.exec(abs);
  if (m && m[1].toUpperCase() === 'C') {
    throw new Error(`[guard] 拒绝操作 C 盘路径（${label}）：${abs}`);
  }
  return abs;
}

/** 目标必须位于 base 之内（含 base 本身）。 */
function assertUnder(target, base, label) {
  const t = assertD(target, label);
  const b = assertD(base, label);
  if (t === b) return t;
  if (!t.startsWith(b + path.sep)) {
    throw new Error(`[guard] 路径越界（${label}）：${t} 不在 ${b} 之下`);
  }
  return t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找出可能占用目标目录的进程（用于给出可操作的报错，而不是裸 EPERM）。 */
function listHolderProcesses(needle = 'AgentFusion') {
  if (process.platform !== 'win32') return '';
  try {
    const res = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -like '*${needle}*') -or ($_.Name -eq 'electron.exe') } | ForEach-Object { "    pid=$($_.ProcessId)  $($_.ExecutablePath)" }`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 25000 },
    );
    return String(res.stdout || '').trim();
  } catch {
    return '';
  }
}

async function removeTree(target, label) {
  const t = assertUnder(target, DIST_PARENT, label);
  if (t === path.resolve(DIST_PARENT)) throw new Error('[guard] 拒绝删除 dist 根目录');
  if (t === path.resolve(ROOT)) throw new Error('[guard] 拒绝删除仓库根目录');
  if (DRY_RUN) {
    log(`[dry-run] 删除 ${t}`);
    return;
  }
  if (!fs.existsSync(t)) return;
  let lastErr = null;
  for (const delay of [0, 400, 900, 1600, 2600]) {
    if (delay) await sleep(delay);
    try {
      fs.rmSync(t, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  const holders = listHolderProcesses(t);
  throw new Error(
    `删除失败（目录被占用）：${t}\n` +
      (holders ? `  占用进程：\n${holders}\n` : '') +
      '  处理办法：关闭正在运行的 AgentFusion 窗口后重试；' +
      '或加 --app-only 只重建 resources/app（不影响 Electron 运行时）。\n' +
      `  原始错误：${(lastErr && lastErr.message) || lastErr}`,
  );
}

/* -------------------------------------------------------------- 文件工具 */

function fmtSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function dirStats(dir) {
  const files = walk(dir);
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += fs.statSync(f).size;
    } catch {
      /* ignore */
    }
  }
  return { files: files.length, bytes };
}

function copyTree(src, dest, filter) {
  if (DRY_RUN) {
    log(`[dry-run] 复制 ${src} → ${dest}`);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: true,
    force: true,
    errorOnExist: false,
    filter,
  });
}

function copyFile(src, dest) {
  if (DRY_RUN) {
    log(`[dry-run] 复制文件 ${src} → ${dest}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/* ------------------------------------------------------------ 依赖解析 */

async function loadConfig() {
  try {
    return await import(pathToFileURL(path.join(ROOT, 'src', 'config.js')).href);
  } catch (err) {
    warn(`无法加载 src/config.js（${err && err.message}），使用内置候选路径`);
    return {};
  }
}

async function resolveElectronDist(cfg) {
  const tried = [];
  if (typeof cfg.electronDist === 'function') {
    try {
      const found = cfg.electronDist();
      if (found) return { dir: found, via: 'src/config.js#electronDist()' };
    } catch (err) {
      tried.push(`config.electronDist(): ${err && err.message}`);
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
      if (fs.existsSync(path.join(c, SRC_EXE)) && fs.existsSync(path.join(c, 'resources'))) {
        return { dir: path.resolve(c), via: '内置候选' };
      }
      tried.push(c);
    } catch {
      tried.push(c);
    }
  }
  throw new Error(
    '未找到 Electron dist（需要包含 electron.exe 与 resources/）。\n' +
      `  已尝试：\n    ${tried.join('\n    ')}\n` +
      '  可通过环境变量 FUSION_ELECTRON_DIST 指定。',
  );
}

async function resolvePiPackage(cfg) {
  const dirs = [];
  if (typeof cfg.piPackageCandidates === 'function') {
    try {
      dirs.push(...cfg.piPackageCandidates());
    } catch {
      /* ignore */
    }
  }
  dirs.push(
    process.env.FUSION_PI_PACKAGE,
    path.join(ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent'),
    'D:\\tools\\pi\\node_modules\\@earendil-works\\pi-coding-agent',
  );
  for (const candidate of dirs.filter(Boolean)) {
    try {
      const real = fs.realpathSync(candidate); // junction → 真实目录
      const pkgFile = path.join(real, 'package.json');
      if (!fs.existsSync(pkgFile)) continue;
      const dist = path.join(real, 'dist');
      if (!fs.existsSync(dist)) continue;
      const bundle = path.join(dist, 'bundle', 'index.js');
      const plain = path.join(dist, 'index.js');
      return {
        dir: real,
        pkgFile,
        dist,
        entry: fs.existsSync(bundle) ? bundle : plain,
        hasBundle: fs.existsSync(bundle),
      };
    } catch {
      /* next */
    }
  }
  throw new Error(
    '未找到 @earendil-works/pi-coding-agent（需要 package.json + dist/）。\n' +
      '  可通过环境变量 FUSION_PI_PACKAGE 指定。',
  );
}

/* ------------------------------------------------------------- 前置校验 */

function preflight() {
  const missing = [];
  const need = [
    ['package.json', path.join(ROOT, 'package.json')],
    ['src/config.js', path.join(ROOT, 'src', 'config.js')],
    ['desktop/main.cjs', path.join(ROOT, 'desktop', 'main.cjs')],
    ['desktop/preload.cjs', path.join(ROOT, 'desktop', 'preload.cjs')],
    ['desktop/splash.html', path.join(ROOT, 'desktop', 'splash.html')],
    ['web/index.html', path.join(ROOT, 'web', 'index.html')],
  ];
  if (!ALLOW_MISSING_SERVER) need.push(['src/api/server.js', path.join(ROOT, 'src', 'api', 'server.js')]);
  for (const [label, p] of need) {
    if (!fs.existsSync(p)) missing.push(`${label}  (${p})`);
  }
  if (missing.length) {
    console.error('[build] ✗ 打包源缺失：');
    for (const m of missing) console.error(`         - ${m}`);
    if (!ALLOW_MISSING_SERVER) {
      console.error('         （服务端尚未就绪时可加 --allow-missing-server 仅验证复制/启动链路）');
    }
    process.exit(1);
  }
}

/* --------------------------------------------------------------- 主流程 */

async function main() {
  log(`仓库：${ROOT}`);
  log(`产物：${OUT_DIR}`);
  if (DRY_RUN) log('模式：dry-run（不落盘）');
  if (APP_ONLY) log('模式：--app-only（复用已有 Electron 运行时）');

  preflight();

  const cfg = await loadConfig();
  const electron = await resolveElectronDist(cfg);
  const pi = await resolvePiPackage(cfg);

  log(`Electron dist：${electron.dir}（${electron.via}）`);
  log(`pi 包：${pi.dir}${pi.hasBundle ? '（bundle 入口）' : '（无 bundle，使用 dist/index.js）'}`);

  if (DRY_RUN) {
    /* 继续走流程只为打印计划 */
  }

  /* 1) 产物目录 ------------------------------------------------------------ */
  fs.mkdirSync(DIST_PARENT, { recursive: true });
  assertUnder(OUT_DIR, DIST_PARENT, '产物目录');

  const needFull = !APP_ONLY || !fs.existsSync(path.join(OUT_DIR, EXE_NAME));
  if (needFull && !NO_CLEAN) {
    if (APP_ONLY) warn('未找到已有产物，自动转为全量构建');
    log('清理旧产物…');
    await removeTree(OUT_DIR, '旧产物');
  }

  /* 2) Electron 运行时 ------------------------------------------------------ */
  if (needFull) {
    log(`复制 Electron 运行时（${electron.dir}）…`);
    copyTree(electron.dir, OUT_DIR);

    if (!DRY_RUN) {
      const from = path.join(OUT_DIR, SRC_EXE);
      const to = path.join(OUT_DIR, EXE_NAME);
      if (!fs.existsSync(from)) throw new Error(`复制后未找到 ${from}`);
      try {
        fs.renameSync(from, to);
      } catch (err) {
        throw new Error(`重命名 electron.exe → ${EXE_NAME} 失败：${err && err.message}`);
      }
      log(`${SRC_EXE} → ${EXE_NAME}`);
      // 移除 Electron 默认应用，避免 resources/app 缺失时启动成“Electron 默认壳”。
      const defaultApp = path.join(RES_DIR, 'default_app.asar');
      if (fs.existsSync(defaultApp)) {
        assertUnder(defaultApp, OUT_DIR, 'default_app.asar');
        fs.rmSync(defaultApp, { force: true });
        log('移除 resources/default_app.asar');
      }
    }
  } else {
    log('复用已有 Electron 运行时（--app-only）');
  }

  /* 3) resources/app -------------------------------------------------------- */
  log('重建 resources/app…');
  await removeTree(APP_DIR, 'resources/app');

  // 3.1 package.json（main → desktop/main.cjs）
  if (!DRY_RUN) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    pkg.main = 'desktop/main.cjs';
    pkg.productName = PRODUCT;
    pkg.fusion = {
      ...(pkg.fusion || {}),
      packaged: true,
      buildTime: new Date().toISOString(),
      electron: readVersionFile(path.join(OUT_DIR, 'version')),
      pi: readPiVersion(pi.pkgFile),
    };
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.writeFileSync(path.join(APP_DIR, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    log('写入 resources/app/package.json（main=desktop/main.cjs）');
  }

  // 3.2 desktop/
  const desktopDir = path.join(ROOT, 'desktop');
  const appDesktop = path.join(APP_DIR, 'desktop');
  if (!DRY_RUN) fs.mkdirSync(appDesktop, { recursive: true });
  for (const name of ['main.cjs', 'preload.cjs', 'splash.html']) {
    const src = path.join(desktopDir, name);
    if (fs.existsSync(src)) copyFile(src, path.join(appDesktop, name));
  }
  const assetsDir = path.join(desktopDir, 'assets');
  if (fs.existsSync(assetsDir)) {
    copyTree(assetsDir, path.join(appDesktop, 'assets'));
  }

  // 3.3 src/（跳过临时 *.mjs 产物）
  const skipped = [];
  const srcRoot = path.join(ROOT, 'src');
  const srcFilter = (source) => {
    const base = path.basename(source);
    if (base === 'node_modules' || base === '.git') return false;
    if (source !== srcRoot && /\.mjs$/i.test(base)) {
      skipped.push(path.relative(ROOT, source).split(path.sep).join('/'));
      return false;
    }
    return true;
  };
  copyTree(srcRoot, path.join(APP_DIR, 'src'), srcFilter);
  if (skipped.length) {
    log(`跳过临时 .mjs 文件：${skipped.join(', ')}`);
  }

  // 3.4 web/
  const webRoot = path.join(ROOT, 'web');
  const webFilter = (source) => {
    const base = path.basename(source);
    if (base === 'node_modules' || base === '.git' || base === '.mimosa' || base === '.vite') return false;
    return true;
  };
  copyTree(webRoot, path.join(APP_DIR, 'web'), webFilter);

  // 3.5 pi 包（package.json + dist + CHANGELOG.md）
  const piDest = path.join(APP_DIR, PI_REL);
  if (!DRY_RUN) fs.mkdirSync(piDest, { recursive: true });
  copyFile(pi.pkgFile, path.join(piDest, 'package.json'));
  copyTree(pi.dist, path.join(piDest, 'dist'));
  const changelog = path.join(pi.dir, 'CHANGELOG.md');
  if (fs.existsSync(changelog)) copyFile(changelog, path.join(piDest, 'CHANGELOG.md'));
  const readme = path.join(pi.dir, 'README.md');
  if (fs.existsSync(readme)) copyFile(readme, path.join(piDest, 'README.md'));

  // 3.6 构建信息 + 启动说明
  if (!DRY_RUN) {
    const buildInfo = {
      product: PRODUCT,
      version: readPkgVersion(),
      builtAt: new Date().toISOString(),
      electron: readVersionFile(path.join(OUT_DIR, 'version')),
      pi: readPiVersion(pi.pkgFile),
      repo: ROOT,
      electronDist: electron.dir,
      piPackage: pi.dir,
      entry: pi.entry,
      skippedMjs: skipped,
    };
    fs.writeFileSync(path.join(APP_DIR, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'README-AgentFusion.txt'), launchReadme(buildInfo), 'utf8');
  }

  /* 4) 校验 ---------------------------------------------------------------- */
  if (!DRY_RUN) validate();
  if (!DRY_RUN && STRICT) {
    const missing = scanImports();
    if (missing.length) {
      console.error('[build] ✗ 相对 import 解析失败（--strict）：');
      for (const m of missing) console.error(`         - ${m}`);
      process.exit(1);
    }
  } else if (!DRY_RUN) {
    const missing = scanImports();
    if (missing.length) {
      warn(`相对 import 解析失败 ${missing.length} 处（运行期可能报错，加 --strict 可阻断）：`);
      for (const m of missing.slice(0, 40)) warn(`  - ${m}`);
    }
  }

  /* 5) 报告 ---------------------------------------------------------------- */
  if (DRY_RUN) {
    log(`dry-run 完成（${((Date.now() - T0) / 1000).toFixed(1)}s）`);
    return;
  }
  report({ electron, pi, skipped });
}

function readVersionFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function readPkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readPiVersion(pkgFile) {
  try {
    return JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function launchReadme(info) {
  return [
    `${PRODUCT} ${info.version} — 便携版`,
    '',
    '启动：双击 AgentFusion.exe',
    '数据目录：D:\\AgentFusion（环境变量 FUSION_DATA_ROOT 可覆盖；不允许 C 盘）',
    '日志：D:\\AgentFusion\\logs\\desktop.log',
    '端口：默认 8720，被占用时自动向后选择空闲端口',
    '',
    `Electron：${info.electron}`,
    `pi 内核：${info.pi}`,
    `构建时间：${info.builtAt}`,
    '',
    '卸载：关闭应用后直接删除本目录与 D:\\AgentFusion 即可（本程序不写 C 盘、不写注册表）。',
    '',
  ].join('\r\n');
}

/** 校验 index.html 引用的本地静态资源都在 web/ 下（server 把 /static/* 映射到 web/）。 */
function missingWebAssets() {
  const webDir = path.join(APP_DIR, 'web');
  const missing = [];
  let html = '';
  try {
    html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  } catch {
    return ['web/index.html 不可读'];
  }
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) {
    const ref = m[1];
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(ref)) continue; // 外链 / 锚点 / data:
    let rel = ref.split('?')[0].split('#')[0].replace(/^\//, '');
    rel = rel.replace(/^static\//, '');
    if (!rel) continue;
    const target = path.join(webDir, rel);
    const candidates = [target, `${target}.js`, path.join(target, 'index.html')];
    const ok = candidates.some((c) => {
      try {
        return fs.statSync(c).isFile();
      } catch {
        return false;
      }
    });
    if (!ok) missing.push(`web/${rel.split(path.sep).join('/')}（被 index.html 引用）`);
  }
  return missing;
}

function validate() {
  const required = [
    path.join(OUT_DIR, EXE_NAME),
    path.join(OUT_DIR, 'resources', 'app', 'package.json'),
    path.join(APP_DIR, 'package.json'),
    path.join(APP_DIR, 'desktop', 'main.cjs'),
    path.join(APP_DIR, 'desktop', 'preload.cjs'),
    path.join(APP_DIR, 'desktop', 'splash.html'),
    path.join(APP_DIR, 'web', 'index.html'),
    path.join(APP_DIR, PI_REL, 'package.json'),
    path.join(APP_DIR, PI_REL, 'dist', 'bundle', 'index.js'),
  ];
  if (!ALLOW_MISSING_SERVER) required.push(path.join(APP_DIR, 'src', 'api', 'server.js'));
  required.push(path.join(APP_DIR, 'src', 'config.js'));

  const missing = required.filter((p) => !fs.existsSync(p));
  // index.html 引用的本地静态资源必须都在产物里（入口文件名变化时不至于漏拷）
  if (fs.existsSync(path.join(APP_DIR, 'web', 'index.html'))) {
    missing.push(...missingWebAssets());
  }
  if (!missing.length) {
    const jsCount = walk(path.join(APP_DIR, 'web')).filter((f) => /\.js$/i.test(f)).length;
    if (jsCount < 1) missing.push('web/**/*.js（前端脚本）');
  }
  if (missing.length) {
    console.error('[build] ✗ 产物校验失败，缺少：');
    for (const m of missing) console.error(`         - ${m}`);
    process.exit(1);
  }
  // package.json 的 main 必须指向桌面壳
  const appPkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
  if (appPkg.main !== 'desktop/main.cjs') {
    console.error(`[build] ✗ resources/app/package.json 的 main 不是 desktop/main.cjs（实际：${appPkg.main}）`);
    process.exit(1);
  }
  log('产物校验通过');
}

/** 扫描 src/ 与 desktop/ 的相对 import 是否都能在产物里解析。 */
function scanImports() {
  const roots = [path.join(APP_DIR, 'src'), path.join(APP_DIR, 'desktop')].filter((p) => fs.existsSync(p));
  const missing = [];
  const SPEC_RE =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])((?:\.[^"'\n]*)|(?:@[^"'\n]+)|(?:[a-zA-Z][^"'\n]*))(["'])/g;
  for (const rootDir of roots) {
    for (const file of walk(rootDir).filter((f) => /\.(?:js|cjs|mjs)$/i.test(f))) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      let m;
      while ((m = SPEC_RE.exec(text))) {
        const spec = m[2];
        if (!spec) continue;
        if (/^(?:node:|data:|https?:|file:)/.test(spec)) continue;
        if (!resolveSpec(file, spec)) {
          missing.push(`${path.relative(APP_DIR, file)} → ${spec}`);
        }
      }
    }
  }
  return missing;
}

function resolveSpec(fromFile, spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const abs = path.resolve(path.dirname(fromFile), spec);
    const candidates = [
      abs,
      `${abs}.js`,
      `${abs}.cjs`,
      `${abs}.mjs`,
      path.join(abs, 'index.js'),
      path.join(abs, 'index.cjs'),
      path.join(abs, 'index.mjs'),
    ];
    return candidates.some((c) => {
      try {
        return fs.statSync(c).isFile();
      } catch {
        return false;
      }
    });
  }
  const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  if (!bare) return true;
  // 'electron' 由 Electron 运行时（内置模块）提供，不需要 node_modules
  if (bare === 'electron') return true;
  const inApp = path.join(APP_DIR, 'node_modules', bare);
  try {
    if (fs.existsSync(inApp)) return true;
  } catch {
    /* ignore */
  }
  // 允许打包产物里不需要的纯工具依赖：@earendil-works/* 由 pi 包自带 dist 解析
  if (bare.startsWith('@earendil-works/')) {
    return fs.existsSync(path.join(APP_DIR, PI_REL, 'package.json'));
  }
  return false;
}

function report({ electron, pi }) {
  const total = dirStats(OUT_DIR);
  const appStats = dirStats(APP_DIR);
  const exeStat = fs.statSync(path.join(OUT_DIR, EXE_NAME));
  const parts = [
    ['src', path.join(APP_DIR, 'src')],
    ['web', path.join(APP_DIR, 'web')],
    ['desktop', path.join(APP_DIR, 'desktop')],
    ['pi', path.join(APP_DIR, PI_REL)],
  ].map(([name, dir]) => `${name} ${fmtSize(dirStats(dir).bytes)}`);

  const elapsed = ((Date.now() - T0) / 1000).toFixed(1);
  console.log('');
  log(`✅ 产物就绪：${OUT_DIR}`);
  log(`   ${EXE_NAME}：${fmtSize(exeStat.size)}`);
  log(`   总大小：${fmtSize(total.bytes)}（${total.files} 个文件）`);
  log(`   resources/app：${fmtSize(appStats.bytes)}（${appStats.files} 个文件）`);
  log(`     ${parts.join(' · ')}`);
  log(`   Electron：${readVersionFile(path.join(OUT_DIR, 'version')) || '?'}（${electron.dir}）`);
  log(`   pi：${readPiVersion(pi.pkgFile)}（入口 ${pi.hasBundle ? 'dist/bundle/index.js' : 'dist/index.js'}）`);
  log(`   耗时：${elapsed}s`);
  console.log('');
}

main().catch((err) => {
  console.error(`[build] ✗ ${(err && err.stack) || err}`);
  process.exit(1);
});
