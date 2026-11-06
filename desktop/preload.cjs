'use strict';
/**
 * AgentFusion preload（contextIsolation + sandbox）。
 *
 * 暴露两个桥：
 *  - window.harnessWindow：复用自 agentharness 前端（web/js/app.js、main.js、views/settings.js
 *    会读取 window.harnessWindow.isElectron / minimize / maximizeToggle / close / openDataDir / openLog）。
 *    为了不改写前端，这里保持同名同形。
 *  - window.fusionDesktop：AgentFusion 自己的命名空间（版本/数据目录/平台等）。
 */
const { contextBridge, ipcRenderer } = require('electron');

function readInfo() {
  try {
    const info = ipcRenderer.sendSync('fusion:info');
    if (info && typeof info === 'object') return info;
  } catch {
    /* ignore */
  }
  return {};
}

const info = readInfo();

const windowControls = {
  minimize: () => ipcRenderer.send('win:minimize'),
  maximizeToggle: () => ipcRenderer.send('win:maximize-toggle'),
  close: () => ipcRenderer.send('win:close'),
  openDataDir: () => ipcRenderer.invoke('app:open-data'),
  openLog: () => ipcRenderer.invoke('app:open-log'),
};

contextBridge.exposeInMainWorld('harnessWindow', {
  isElectron: true,
  product: info.product || 'AgentFusion',
  version: info.version || '',
  dataRoot: info.dataRoot || '',
  platform: info.platform || process.platform,
  ...windowControls,
});

contextBridge.exposeInMainWorld('fusionDesktop', {
  isElectron: true,
  product: info.product || 'AgentFusion',
  version: info.version || '',
  dataRoot: info.dataRoot || '',
  logFile: info.logFile || '',
  port: info.port || 0,
  url: info.url || '',
  packaged: Boolean(info.packaged),
  platform: info.platform || process.platform,
  electron: process.versions.electron || '',
  ...windowControls,
});
