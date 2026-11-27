// AutoDeposit 控制视窗（独立桌面程式，不借用浏览器）
// 只载入本机 127.0.0.1 的控制页面；其他网址一律不在视窗里开
'use strict';
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
app.setPath('userData', path.join(DATA, 'window'));
app.setAppUserModelId('TermiX.AutoDeposit.' + Buffer.from(ROOT).toString('hex').slice(-16));

const pickUrl = (argv) => {
  const a = argv.find((x) => /^http:\/\/127\.0\.0\.1:\d+\//.test(x));
  if (a) return a;
  try { const u = fs.readFileSync(path.join(DATA, '.ui-url'), 'utf8').trim(); if (/^http:\/\/127\.0\.0\.1:\d+\//.test(u)) return u; } catch { /* ignore */ }
  return '';
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
let win = null;
app.on('second-instance', (_e, argv) => {
  if (!win) return;
  const u = pickUrl(argv);
  if (u) win.loadURL(u);
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
});

if (gotLock) app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const url = pickUrl(process.argv);
  win = new BrowserWindow({
    width: 1320, height: 900, minWidth: 980, minHeight: 640,
    backgroundColor: '#0c0c0e', title: 'AutoDeposit', icon: path.join(__dirname, 'app.ico'),
    autoHideMenuBar: true, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  const local = (u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u);
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https:\/\//.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, u) => { if (!local(u)) { e.preventDefault(); if (/^https:\/\//.test(u)) shell.openExternal(u); } });
  // 页面要求关闭视窗（例如按「关闭工具」后）
  win.webContents.on('console-message', (e, _lvl, m2) => { const msg = (e && typeof e.message === 'string') ? e.message : m2; if (msg === '__AUTODEPOSIT_CLOSE__') win.close(); });
  if (url) win.loadURL(url); else win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="background:#0c0c0e;color:#aaa;font:14px sans-serif;padding:40px">工具尚未启动，请点桌面图标重新打开。</body>'));
});
app.on('window-all-closed', () => app.quit());
