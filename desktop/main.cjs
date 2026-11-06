'use strict';
/**
 * AgentFusion — Electron 桌面壳（CommonJS）
 *
 * 职责：
 *  1. 在 app ready 之前把所有可写目录（userData / temp / crashDumps / logs）重定向到 D 盘数据根；
 *  2. 进程内 `import()` ESM 服务端（src/api/server.js）并启动 HTTP 服务（不 spawn 子进程）；
 *  3. splash → 主窗口加载 http://127.0.0.1:<port>；
 *  4. 单实例锁、外链拦截、退出时关闭服务端并清理；
 *  5. 启动失败时展示错误页并写日志；
 *  6. 诊断通道（自动化验收用，正常使用时不参与）：
 *     FUSION_DIAG_FILE=<json 路径>  → 页面加载完成后写诊断 JSON + 窗口截图 PNG
 *     FUSION_AUTOQUIT_MS=<毫秒>     → 诊断写完后关闭主窗口（走真实退出路径）
 *
 * 重要：任何 Electron/Chromium 路径设置在 import 服务端之前完成，且 FUSION_DATA_ROOT
 * 必须在 import 之前写入 process.env（src/config.js 在模块加载时读取）。
 */
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PRODUCT = 'AgentFusion';
const APP_ID = 'com.agentfusion.desktop';
const T0 = Date.now();
/** 开发时 = fusion/；打包后 = <resources>/app/ */
const APP_DIR = path.resolve(__dirname, '..');
const IS_PACKAGED = (() => {
  try {
    return app.isPackaged === true;
  } catch {
    return false;
  }
})();
const DEFAULT_DATA_ROOT =
  process.platform === 'win32' ? 'D:\\AgentFusion' : path.join(os.homedir(), 'AgentFusion');

function readVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}
const APP_VERSION = readVersion();

/* ------------------------------------------------------------------ 路径守卫 */

/** 拒绝 C 盘路径（FUSION_SPEC §0 铁律 1）。 */
function assertNotC(target, label) {
  const abs = path.resolve(String(target));
  const m = /^([a-zA-Z]):[\\/]/.exec(abs);
  if (m && m[1].toUpperCase() === 'C') {
    throw new Error(`拒绝写入 C 盘（${label}）：${abs}`);
  }
  return abs;
}

let DATA_ROOT = '';
let DIRS = null;
let LOG_FILE = '';
let startupError = null;

function prepareDataRoots() {
  const raw = String(process.env.FUSION_DATA_ROOT || '').trim();
  DATA_ROOT = assertNotC(raw ? path.resolve(raw) : DEFAULT_DATA_ROOT, 'FUSION_DATA_ROOT');
  DIRS = {
    root: DATA_ROOT,
    logs: path.join(DATA_ROOT, 'logs'),
    temp: path.join(DATA_ROOT, 'temp'),
    cache: path.join(DATA_ROOT, 'cache'),
    userData: path.join(DATA_ROOT, 'electron-userData'),
    crashDumps: path.join(DATA_ROOT, 'cache', 'crashpad'),
    data: path.join(DATA_ROOT, 'data'),
    workspace: path.join(DATA_ROOT, 'workspace'),
  };
  for (const dir of Object.values(DIRS)) {
    assertNotC(dir, '数据目录');
    fs.mkdirSync(dir, { recursive: true });
  }
  LOG_FILE = path.join(DIRS.logs, 'desktop.log');
}

function fallbackDataRoots() {
  DATA_ROOT = DEFAULT_DATA_ROOT;
  DIRS = {
    root: DATA_ROOT,
    logs: path.join(DATA_ROOT, 'logs'),
    temp: path.join(DATA_ROOT, 'temp'),
    cache: path.join(DATA_ROOT, 'cache'),
    userData: path.join(DATA_ROOT, 'electron-userData'),
    crashDumps: path.join(DATA_ROOT, 'cache', 'crashpad'),
    data: path.join(DATA_ROOT, 'data'),
    workspace: path.join(DATA_ROOT, 'workspace'),
  };
  try {
    fs.mkdirSync(DIRS.logs, { recursive: true });
  } catch {
    /* ignore */
  }
  LOG_FILE = path.join(DIRS.logs, 'desktop.log');
}

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  if (process.env.FUSION_DEBUG !== '0') {
    try {
      console.log(`[desktop] ${line}`);
    } catch {
      /* ignore */
    }
  }
  try {
    if (LOG_FILE) fs.appendFileSync(LOG_FILE, msg + '\n', 'utf8');
  } catch {
    /* ignore */
  }
}

function applyAppPaths() {
  try {
    app.setName(PRODUCT);
  } catch {
    /* ignore */
  }
  process.env.FUSION_DATA_ROOT = DATA_ROOT;
  process.env.FUSION_APP_VERSION = APP_VERSION;
  // Chromium / Node 临时目录也必须在 D 盘。
  process.env.TEMP = DIRS.temp;
  process.env.TMP = DIRS.temp;
  process.env.TMPDIR = DIRS.temp;
  const set = (name, value) => {
    try {
      app.setPath(name, value);
    } catch (err) {
      log(`app.setPath(${name}) 失败：${err && err.message}`);
    }
  };
  set('userData', DIRS.userData);
  set('sessionData', path.join(DIRS.userData, 'session'));
  set('temp', DIRS.temp);
  set('crashDumps', DIRS.crashDumps);
  set('logs', DIRS.logs);
  try {
    app.setAppUserModelId(APP_ID);
  } catch {
    /* ignore */
  }
  try {
    app.commandLine.appendSwitch('disk-cache-dir', path.join(DIRS.cache, 'chromium-disk-cache'));
  } catch {
    /* ignore */
  }
}

try {
  prepareDataRoots();
} catch (err) {
  startupError = err;
  fallbackDataRoots();
}
applyAppPaths();

/* --------------------------------------------------------------- 运行期状态 */

let mainWindow = null;
let serverHandle = null;
let SERVER_URL = '';
let APP_PORT = 0;
let serverStartMs = 0;
let firstLoadMs = 0;
let shuttingDown = false;
let windowShownAt = 0;
let userClosedWindow = false;
let appIsQuitting = false;

function argValue(flag) {
  const argv = process.argv.slice(1);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag && i + 1 < argv.length) return argv[i + 1];
    if (a.startsWith(flag + '=')) return a.slice(flag.length + 1);
  }
  return null;
}

/* ------------------------------------------------------------------ 端口/健康 */

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        server.close(() => resolve(ok));
      } catch {
        resolve(ok);
      }
    };
    server.once('error', () => finish(false));
    server.once('listening', () => finish(true));
    try {
      server.listen(port, '127.0.0.1');
    } catch {
      finish(false);
    }
  });
}

async function choosePort(base) {
  const start = Number(base) > 0 ? Math.trunc(Number(base)) : 8720;
  for (let port = start; port <= start + 24; port++) {
    if (await portIsFree(port)) return port;
  }
  return start;
}

function checkHealthOnce(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let req;
    try {
      req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > 262144) {
            res.destroy();
            done(false);
          }
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return done(false);
          try {
            const body = JSON.parse(raw);
            done(Boolean(body) && (body.status === 'ok' || body.ok === true));
          } catch {
            done(false);
          }
        });
        res.on('error', () => done(false));
      });
    } catch {
      done(false);
      return;
    }
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
  });
}

async function waitHealth(port, timeoutMs, onTick) {
  const deadline = Date.now() + timeoutMs;
  let tick = 0;
  while (Date.now() < deadline) {
    if (shuttingDown) return false;
    if (await checkHealthOnce(port, 1500)) return true;
    tick += 1;
    if (onTick && tick % 10 === 0) onTick(tick);
    await new Promise((r) => setTimeout(r, tick < 20 ? 150 : 400));
  }
  return false;
}

/* ------------------------------------------------------------------- 服务端 */

function resolveServerEntry() {
  const override = String(process.env.FUSION_SERVER_ENTRY || '').trim();
  if (override) return assertNotC(path.resolve(override), 'FUSION_SERVER_ENTRY');
  const resources = process.resourcesPath || '';
  const packaged = resources ? path.join(resources, 'app', 'src', 'api', 'server.js') : '';
  if (packaged && fs.existsSync(packaged)) return packaged;
  const dev = path.join(__dirname, '..', 'src', 'api', 'server.js');
  if (fs.existsSync(dev)) return dev;
  return packaged || dev;
}

async function bootServer() {
  const basePort = Number(argValue('--port') || process.env.FUSION_PORT || 8720) || 8720;
  const entry = resolveServerEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(`服务端入口不存在：${entry}`);
  }
  log(`导入服务端：${entry}`);
  const mod = await import(pathToFileURL(entry).href);
  const startServer =
    (mod && typeof mod.startServer === 'function' && mod.startServer) ||
    (mod && mod.default && typeof mod.default.startServer === 'function' && mod.default.startServer) ||
    null;
  if (!startServer) {
    throw new Error(`${entry} 未导出 startServer({port,host})`);
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await choosePort(basePort + attempt);
    process.env.FUSION_PORT = String(port);
    const t = Date.now();
    try {
      log(`启动服务端 port=${port}`);
      const handle = await startServer({ port, host: '127.0.0.1' });
      serverStartMs = Date.now() - t;
      serverHandle = handle && typeof handle === 'object' ? handle : {};
      APP_PORT = Number(serverHandle.port || port) || port;
      const reported = typeof serverHandle.url === 'string' ? serverHandle.url : '';
      SERVER_URL = /^https?:\/\//.test(reported) ? reported : `http://127.0.0.1:${APP_PORT}`;
      // 归一化到 127.0.0.1，避免 localhost/IPv6 差异导致健康检查失败。
      try {
        const u = new URL(SERVER_URL);
        if (u.hostname === 'localhost') {
          u.hostname = '127.0.0.1';
          SERVER_URL = u.toString().replace(/\/$/, '');
        }
      } catch {
        /* ignore */
      }
      process.env.FUSION_URL = SERVER_URL;
      log(`服务端就绪：${SERVER_URL}（${serverStartMs}ms）`);
      setSplash('正在加载界面…');
      const ok = await waitHealth(APP_PORT, 180000, (n) => {
        if (n % 20 === 0) log(`等待健康检查…（${n} 次）`);
      });
      if (!ok) throw new Error(`健康检查超时（${SERVER_URL}/api/health）`);
      log(`健康检查通过（${Date.now() - t}ms）`);
      return;
    } catch (err) {
      lastErr = err;
      try {
        await closeServer();
      } catch {
        /* ignore */
      }
      const hay = `${(err && err.code) || ''} ${(err && err.message) || ''}`;
      if (attempt < 4 && /EADDRINUSE|address already in use/i.test(hay)) {
        log(`端口 ${port} 被占用，重试下一个端口`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('服务端启动失败');
}

async function closeServer() {
  const handle = serverHandle;
  serverHandle = null;
  if (!handle) return;
  try {
    if (typeof handle.close === 'function') await handle.close();
  } catch (err) {
    log(`关闭服务端出错：${err && err.message}`);
  }
}

/* ------------------------------------------------------------------- 窗口 */

function appIconPath() {
  for (const name of ['icon.ico', 'app.ico']) {
    const p = path.join(__dirname, 'assets', name);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 700,
    frame: false,
    show: false,
    backgroundColor: '#fbfaf7',
    title: PRODUCT,
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  mainWindow = win;
  try {
    win.setMenuBarVisibility(false);
  } catch {
    /* ignore */
  }
  if (typeof win.setTitleBarOverlay === 'function' && process.platform === 'win32') {
    try {
      win.setTitleBarOverlay(false);
    } catch {
      /* ignore */
    }
  }
  win.once('ready-to-show', () => {
    windowShownAt = Date.now() - T0;
    try {
      win.show();
    } catch {
      /* ignore */
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    if (!appIsQuitting) userClosedWindow = true;
  });

  const wc = win.webContents;
  wc.on('will-navigate', (event, url) => {
    if (!isAllowedUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  wc.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (!/^https?:/i.test(String(validatedURL || ''))) return;
    log(`主框架加载失败 ${validatedURL} code=${errorCode} ${errorDescription}`);
    showError('界面加载失败', `${validatedURL}\n错误码 ${errorCode}：${errorDescription}`, LOG_FILE);
  });
  wc.on('render-process-gone', (event, details) => {
    log(`渲染进程退出：${JSON.stringify(details)}`);
  });
  wc.on('did-finish-load', () => {
    const url = wc.getURL() || '';
    if (!/^https?:/i.test(url)) return; // splash 页面不处理
    firstLoadMs = Date.now() - T0;
    log(`主界面加载完成：${url}（首次加载 ${firstLoadMs}ms）`);
    setTimeout(() => {
      runDiagnostics(wc).catch(() => {});
    }, 900);
  });

  win.loadFile(path.join(__dirname, 'splash.html')).catch((err) => {
    // 导航到应用 URL 时 splash 的加载会被中断（ERR_ABORTED），属正常现象
    if (err && Number(err.errno) === -3) return;
    log(`splash 加载失败：${err && err.message}`);
  });
  return win;
}

function isAllowedUrl(rawUrl) {
  const url = String(rawUrl || '');
  if (url.startsWith('file:')) return true;
  if (!SERVER_URL) return false;
  try {
    const target = new URL(url);
    const base = new URL(SERVER_URL);
    return target.origin === base.origin;
  } catch {
    return false;
  }
}

function openExternal(rawUrl) {
  const url = String(rawUrl || '');
  if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) return;
  if (isAllowedUrl(url)) return;
  try {
    shell.openExternal(url);
  } catch (err) {
    log(`打开外部链接失败：${err && err.message}`);
  }
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function errorPage(title, detail, logFile) {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="fusion-error" content="1"><title>${escapeHtml(
    title,
  )}</title><style>
    :root{color-scheme:light}
    html,body{height:100%;margin:0;background:#fbfaf7;color:#1c1b18;
      font-family:"Segoe UI Variable Text","Segoe UI","PingFang SC","Microsoft YaHei UI",sans-serif}
    .wrap{height:100%;display:grid;place-items:center;padding:32px}
    .box{max-width:760px;text-align:left}
    h1{font-size:18px;font-weight:600;margin:0 0 10px}
    p{font-size:13px;line-height:1.65;color:rgba(28,27,24,.72);margin:0 0 14px}
    pre{font-size:12px;line-height:1.6;background:#f2f0ea;border:1px solid #e4e0d6;border-radius:10px;
      padding:12px 14px;color:#4a463d;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
    .row{display:flex;gap:10px;margin-top:16px}
    button{font:inherit;font-size:13px;padding:8px 14px;border-radius:9px;border:1px solid #d9d4c7;
      background:#fff;color:#1c1b18;cursor:pointer}
    button.primary{background:#1c1b18;color:#fbfaf7;border-color:#1c1b18}
  </style></head><body><div class="wrap"><div class="box">
    <h1>${escapeHtml(title)}</h1>
    <p>本地运行时没有成功启动。请查看下方信息，并把日志文件发给开发者。</p>
    <pre>${escapeHtml(detail || '')}</pre>
    ${logFile ? `<p>日志：${escapeHtml(logFile)}</p>` : ''}
    <div class="row">
      <button class="primary" onclick="try{window.fusionDesktop&&window.fusionDesktop.openLog()}catch(e){}">打开日志</button>
      <button onclick="try{window.fusionDesktop&&window.fusionDesktop.openDataDir()}catch(e){}">打开数据目录</button>
      <button onclick="try{window.fusionDesktop&&window.fusionDesktop.close()}catch(e){}">退出</button>
    </div>
  </div></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function showError(title, detail, logFile) {
  log(`ERROR ${title}: ${detail}`);
  if (userClosedWindow) return; // 用户已经主动关窗，不再弹窗打断退出
  if (!mainWindow || mainWindow.isDestroyed()) {
    try {
      mainWindow = createWindow();
    } catch (err) {
      log(`无法创建错误窗口：${err && err.message}`);
      return;
    }
  }
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    if (!win.isVisible()) win.show();
  } catch {
    /* ignore */
  }
  win.loadURL(errorPage(title, detail, logFile))
    .then(() => {
      // 错误页也写诊断，便于自动化测试给出可读的失败原因
      runDiagnostics(win.webContents).catch(() => {});
    })
    .catch(() => {});
}

function setSplash(text) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  const url = wc.getURL() || '';
  if (!url.startsWith('file:')) return;
  wc.executeJavaScript(`window.__splashStatus && window.__splashStatus(${JSON.stringify(String(text))})`, true).catch(
    () => {},
  );
}

/* ------------------------------------------------------------------- 诊断 */

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

async function runDiagnostics(wc) {
  const diagFile = String(process.env.FUSION_DIAG_FILE || '').trim();
  if (!diagFile) return;
  let target;
  try {
    target = assertNotC(path.resolve(diagFile), 'FUSION_DIAG_FILE');
  } catch (err) {
    log(`诊断文件路径非法：${err && err.message}`);
    return;
  }
  const dir = path.dirname(target);
  const info = {
    ok: true,
    product: PRODUCT,
    version: APP_VERSION,
    packaged: IS_PACKAGED,
    appDir: APP_DIR,
    resourcesPath: process.resourcesPath || null,
    pid: process.pid,
    port: APP_PORT,
    url: '',
    title: '',
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dataRoot: DATA_ROOT,
    logFile: LOG_FILE,
    timings: {},
    dom: null,
    screenshot: null,
  };
  try {
    info.url = wc.getURL();
    info.title = wc.getTitle();
  } catch {
    /* ignore */
  }
  try {
    info.dom = await wc.executeJavaScript(
      `(() => {
        const bodyText = (document.body && document.body.innerText || '').trim();
        return {
          title: document.title,
          href: location.href,
          textLength: bodyText.length,
          textSample: bodyText.slice(0, 400),
          nodes: document.querySelectorAll('*').length,
          brand: ((document.querySelector('.brand-name') || {}).textContent || '').trim(),
          isErrorPage: Boolean(document.querySelector('meta[name="fusion-error"]')),
          hasApp: Boolean(document.getElementById('app')),
          hasTitlebar: Boolean(document.getElementById('titlebar')),
          scripts: Array.from(document.scripts).map(s => s.src || '(inline)').slice(0, 12),
        };
      })()`,
      true,
    );
  } catch (err) {
    info.domError = String((err && err.message) || err);
  }
  try {
    const image = await wc.capturePage();
    const pngPath = path.join(dir, 'window.png');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pngPath, image.toPNG());
    info.screenshot = pngPath;
    info.screenshotBytes = fs.statSync(pngPath).size;
  } catch (err) {
    info.screenshotError = String((err && err.message) || err);
  }
  info.timings = {
    bootMs: Date.now() - T0,
    windowShownMs: windowShownAt,
    serverStartMs,
    firstLoadMs,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(safeJson(info), null, 2), 'utf8');
    log(`诊断写入 ${target}`);
  } catch (err) {
    log(`写诊断失败：${err && err.message}`);
    return;
  }
  const autoQuit = Number(process.env.FUSION_AUTOQUIT_MS || 0);
  if (autoQuit > 0) {
    setTimeout(() => {
      log(`诊断完成，${autoQuit}ms 后关闭主窗口（模拟用户关闭）`);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      else app.quit();
    }, autoQuit);
  }
}

/* --------------------------------------------------------------------- IPC */

ipcMain.on('fusion:info', (event) => {
  event.returnValue = {
    isElectron: true,
    product: PRODUCT,
    version: APP_VERSION,
    dataRoot: DATA_ROOT,
    logFile: LOG_FILE,
    port: APP_PORT,
    url: SERVER_URL,
    packaged: IS_PACKAGED,
    platform: process.platform,
  };
});
ipcMain.on('win:minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});
ipcMain.on('win:maximize-toggle', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});
ipcMain.handle('app:open-log', async () => {
  try {
    if (LOG_FILE && fs.existsSync(LOG_FILE)) shell.showItemInFolder(LOG_FILE);
    else shell.openPath(DIRS.logs);
  } catch {
    /* ignore */
  }
  return true;
});
ipcMain.handle('app:open-data', async () => {
  try {
    await shell.openPath(DATA_ROOT);
  } catch {
    /* ignore */
  }
  return true;
});

/* ---------------------------------------------------------------- 生命周期 */

let shutdownPromise = null;
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    log('开始关闭…');
    await closeServer();
    log('服务端已关闭');
  })();
  return shutdownPromise;
}

// FUSION_SINGLE_INSTANCE=0 用于自动化冒烟/多实例调试（同一 userData 下只有一个实例时会拒绝启动）。
const SINGLE_INSTANCE = String(process.env.FUSION_SINGLE_INSTANCE || '1') !== '0';
const gotLock = SINGLE_INSTANCE ? app.requestSingleInstanceLock() : true;
if (!gotLock) {
  log('已有 AgentFusion 实例在运行（单实例锁），本实例退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      Menu.setApplicationMenu(null);
    } catch {
      /* ignore */
    }
    log(
      `启动：packaged=${IS_PACKAGED} appDir=${APP_DIR} resources=${process.resourcesPath || '-'} ` +
        `electron=${process.versions.electron} node=${process.versions.node} data=${DATA_ROOT}`,
    );
    createWindow();
    if (startupError) {
      showError('数据目录配置错误', String(startupError.message || startupError), LOG_FILE);
      return;
    }
    try {
      setSplash('正在启动本地服务…');
      await bootServer();
      if (userClosedWindow) {
        log('用户在启动期间关闭了窗口，直接退出');
        appIsQuitting = true;
        app.quit();
        return;
      }
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      await mainWindow.loadURL(SERVER_URL);
    } catch (err) {
      const detail = [
        String((err && err.message) || err),
        '',
        `数据目录：${DATA_ROOT}`,
        `日志：${LOG_FILE}`,
        `electron：${process.versions.electron}  node：${process.versions.node}`,
      ].join('\n');
      showError(`${PRODUCT} 启动失败`, detail, LOG_FILE);
    }
  });

  app.on('window-all-closed', () => {
    appIsQuitting = true;
    log('所有窗口已关闭，退出应用');
    shutdown()
      .catch(() => {})
      .finally(() => app.quit());
  });

  app.on('before-quit', (event) => {
    appIsQuitting = true;
    if (shutdownPromise && shuttingDown) return; // 已经处理过
    shuttingDown = true;
    event.preventDefault();
    shutdown()
      .catch(() => {})
      .finally(() => {
        try {
          app.exit(0);
        } catch {
          /* ignore */
        }
      });
  });
}

process.on('exit', () => {
  try {
    if (LOG_FILE) fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] 进程退出\n`, 'utf8');
  } catch {
    /* ignore */
  }
});
process.on('SIGINT', () => {
  shutdown()
    .catch(() => {})
    .finally(() => app.exit(0));
});
process.on('SIGTERM', () => {
  shutdown()
    .catch(() => {})
    .finally(() => app.exit(0));
});
process.on('uncaughtException', (err) => {
  log(`未捕获异常：${(err && err.stack) || err}`);
  try {
    showError('运行时异常', String((err && err.stack) || err), LOG_FILE);
  } catch {
    /* ignore */
  }
});
process.on('unhandledRejection', (reason) => {
  log(`未处理的 Promise 拒绝：${(reason && reason.stack) || reason}`);
});
