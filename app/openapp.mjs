// 打开控制视窗：优先用工具自己的桌面视窗（Electron）；还没装好时才退回 Edge／Chrome 的 App 视窗
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ELECTRON_EXE = join(HERE, '..', 'electron', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'AutoDeposit.exe' : 'electron');

export function openApp(link, dataDir) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(link)) return;
  try {
    if (existsSync(ELECTRON_EXE)) {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
      spawn(ELECTRON_EXE, [join(HERE, 'window.cjs'), link], { detached: true, stdio: 'ignore', windowsHide: false, env }).unref();
      return;
    }
    if (process.platform !== 'win32') return;
    const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    const cands = [...pf.map((p) => join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe')), ...pf.map((p) => join(p, 'Google', 'Chrome', 'Application', 'chrome.exe'))];
    const exe = cands.find((c) => { try { return existsSync(c); } catch { return false; } });
    if (exe) {
      const prof = join(dataDir, 'app-window');
      mkdirSync(prof, { recursive: true });
      spawn(exe, [`--app=${link}`, `--user-data-dir=${prof}`, '--window-size=1320,900', '--no-first-run', '--no-default-browser-check', '--disable-sync'], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('cmd', ['/c', 'start', '', link], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
  } catch { /* ignore */ }
}
