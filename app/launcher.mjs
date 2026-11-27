// TermiX 自动存款 · 启动器（在背景执行，没有黑视窗）
// - 第一次：解压套件、安装币安官方 AI 钱包工具、在桌面与「开机启动」建立捷径
// - 之后：在背景启动引擎；引擎意外停止就 10 秒后自动重启；在控制页面按「关闭工具」才真正结束
// - 参数 --boot：开机自动启动时使用（不弹出浏览器）
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, unlinkSync, statSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openApp } from './openapp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
mkdirSync(DATA, { recursive: true });
const LOG = join(DATA, 'launcher.log');
const log = (m) => { try { appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${m}\n`); } catch { /* ignore */ } };
const boot = process.argv.includes('--boot');
const win = process.platform === 'win32';
const hidden = { cwd: ROOT, windowsHide: true, encoding: 'utf8' };

function openUi() {
  try { const link = readFileSync(join(DATA, '.ui-url'), 'utf8').trim(); if (win && link) openApp(link, DATA); } catch { /* ignore */ }
}
function msg(text) {
  // 没有黑视窗，所以用讯息框告诉使用者（0x40000 = 最上层，不会被其他视窗挡住）
  if (!win) return console.log(text);
  spawnSync('powershell', ['-NoProfile', '-Command', '(New-Object -ComObject WScript.Shell).Popup($env:TX_MSG, 0, "TermiX", 0x40030) | Out-Null'], { ...hidden, env: { ...process.env, TX_MSG: text } });
}

// 00) Node 版本：控制视窗元件需要 Node 22.12 以上
{
  const [ma, mi] = process.versions.node.split('.').map(Number);
  if (ma < 22 || (ma === 22 && mi < 12)) { msg(`电脑上的 Node.js 版本太旧（${process.versions.node}）。请到 https://nodejs.org 下载安装最新的 LTS 版本，装好后再点一次桌面图示。`); process.exit(1); }
}

// 0) 同时只准一个启动器在做安装（避免双击两次同时解压／安装）
const LOCK = join(DATA, '.launcher.lock');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const lockHeld = () => {
  try {
    if (!existsSync(LOCK)) return false;
    const pid = Number(readFileSync(LOCK, 'utf8').trim());
    if (!pid || !alive(pid) || Date.now() - statSync(LOCK).mtimeMs > 15 * 60_000) { try { unlinkSync(LOCK); } catch { /* ignore */ } return false; } // 上次当掉留下的锁：直接清掉
    return true;
  } catch { return false; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 另一个启动器正在安装时先等它装完（最多 15 分钟），再照常往下（之后会打开控制页面）
for (let i = 0; lockHeld() && i < 180; i++) await sleep(5000);
let locked = false;
let noticed = false;
const lock = () => {
  if (!locked) { try { writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); } catch { writeFileSync(LOCK, String(process.pid)); } locked = true; }
  // 第一次安装要几分钟：先告诉使用者，免得以为没反应又一直点（讯息 20 秒后自动消失，不卡安装）
  if (!noticed && !boot && win) { noticed = true; spawn('powershell', ['-NoProfile', '-Command', '(New-Object -ComObject WScript.Shell).Popup($env:TX_MSG, 20, "TermiX", 0x40040) | Out-Null'], { cwd: ROOT, windowsHide: true, detached: true, stdio: 'ignore', env: { ...process.env, TX_MSG: '正在安装需要的元件（第一次约 2～5 分钟），装好会自动打开视窗。请不要重复点桌面图示。' } }).unref(); }
};
const unlock = () => { if (locked) { try { unlinkSync(LOCK); } catch { /* ignore */ } locked = false; } };
const fail = (m) => { unlock(); msg(m); process.exit(1); };

// 1) 第一次使用（或套件更新过）：解压套件
// 套件指纹用 SHA-256（在线更新换了 client-deps.tgz 也能发现，大小相同也不会漏掉）
const depsSigNow = () => { try { return createHash('sha256').update(readFileSync(join(ROOT, 'client-deps.tgz'))).digest('hex'); } catch { return ''; } };
const depsOldSig = () => { try { return readFileSync(join(DATA, '.deps-sig'), 'utf8').trim(); } catch { return ''; } };
function ensureDeps(quiet) {
  const sig = depsSigNow();
  if (existsSync(join(ROOT, 'node_modules', 'viem', 'package.json')) && (!sig || sig === depsOldSig())) return true;
  if (!quiet) lock();
  log('解压工具套件');
  const tar = win ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const r = spawnSync(tar, ['-xzf', 'client-deps.tgz', '-C', '.'], hidden);
  if (!existsSync(join(ROOT, 'node_modules', 'viem', 'package.json'))) { log('解压失败：' + (r.stderr || r.error || '')); return false; }
  if (sig) { try { writeFileSync(join(DATA, '.deps-sig'), sig); } catch { /* ignore */ } }
  return true;
}
if (!ensureDeps(false)) fail('解压工具套件失败，请重新下载完整的工具包。');

// 2) 币安官方 AI 钱包工具（固定 1.12.0）
//    「独立模式」（新安装预设）：装一份只给本工具用的钱包工具在 ROOT\baw，并拿掉系统钥匙圈模组，
//    登入资料只存在本工具的 data 资料夹。这样同一台电脑可以同时跑好几个工具、各连各的币安钱包，
//    也不会挤掉使用者自己其他程式（例如其他 AI 代理）登入的币安钱包。
//    旧版已经在用的电脑维持「共用模式」，不用重新扫码。
const npm = win ? 'npm.cmd' : 'npm';
const q = (p) => (win ? `"${p}"` : p); // shell:true 时路径有空格／括号要加引号
const MODE_F = join(DATA, '.baw-mode');
let mode = '';
try { mode = readFileSync(MODE_F, 'utf8').trim(); } catch { /* 第一次 */ }
if (mode !== 'global' && mode !== 'private') {
  mode = existsSync(join(DATA, '.installed')) && existsSync(join(DATA, 'state.json')) ? 'global' : 'private';
  writeFileSync(MODE_F, mode);
}
const BAWDIR = join(ROOT, 'baw');
const bawPkg = mode === 'private' ? join(BAWDIR, 'node_modules', '@binance', 'agentic-wallet', 'package.json') : '';
let bawVer = '';
if (mode === 'private') {
  try { bawVer = JSON.parse(readFileSync(bawPkg, 'utf8')).version; } catch { /* 未安装 */ }
  if (bawVer !== '1.12.0') {
    lock();
    log(`安装独立的 @binance/agentic-wallet@1.12.0（目前：${bawVer || '未安装'}）`);
    mkdirSync(BAWDIR, { recursive: true });
    const r = spawnSync(npm, ['i', '--prefix', q(BAWDIR), '@binance/agentic-wallet@1.12.0', '--no-audit', '--no-fund'], { ...hidden, shell: win, timeout: 600_000 });
    if (r.status !== 0) { log('安装失败：' + (r.stderr || '').slice(-500)); fail('安装币安官方 AI 钱包工具失败，请确认网路正常后再点一次桌面图示。'); }
  }
  // 拿掉系统钥匙圈模组 → 登入资料改存本工具的 data\baw-session
  try { rmSync(join(BAWDIR, 'node_modules', '@github', 'keytar'), { recursive: true, force: true }); } catch { /* ignore */ }
} else {
  const groot = (spawnSync(npm, ['root', '-g'], { ...hidden, shell: win }).stdout || '').trim();
  try { bawVer = JSON.parse(readFileSync(join(groot, '@binance', 'agentic-wallet', 'package.json'), 'utf8')).version; } catch { /* 未安装 */ }
  if (bawVer !== '1.12.0') {
    lock();
    log(`安装 @binance/agentic-wallet@1.12.0（目前：${bawVer || '未安装'}）`);
    const r = spawnSync(npm, ['i', '-g', '@binance/agentic-wallet@1.12.0'], { ...hidden, shell: win, timeout: 600_000 });
    if (r.status !== 0) {
      log('安装失败：' + (r.stderr || '').slice(-500));
      if (!bawVer) fail('安装币安官方 AI 钱包工具失败，请确认网路正常后再点一次桌面图示。');
      log('沿用已安装的版本继续执行');
    }
  }
}

// 2b) 控制视窗（独立桌面程式 Electron，固定版本；装在工具资料夹里，不影响电脑上其他程式）
const ELECTRON_VER = '45.5.0';
const EDIR = join(ROOT, 'electron');
let eVer = '';
try { eVer = JSON.parse(readFileSync(join(EDIR, 'node_modules', 'electron', 'package.json'), 'utf8')).version; } catch { /* 未安装 */ }
const eExe = join(EDIR, 'node_modules', 'electron', 'dist', win ? 'electron.exe' : 'electron');
if (eVer !== ELECTRON_VER || !existsSync(eExe)) {
  // （已装但缺本体时也会进来补下载）
  lock();
  log(`安装控制视窗元件 electron@${ELECTRON_VER}（第一次约需 1～3 分钟）`);
  mkdirSync(EDIR, { recursive: true });
  const r = spawnSync(npm, ['i', '--prefix', q(EDIR), `electron@${ELECTRON_VER}`, '--no-audit', '--no-fund'], { ...hidden, shell: win, timeout: 900_000 });
  // 有些电脑的 npm 设定会跳过安装脚本，元件本体没下载到 → 自己跑一次下载
  if (!existsSync(eExe) && existsSync(join(EDIR, 'node_modules', 'electron', 'install.js'))) {
    const r2 = spawnSync(process.execPath, ['install.js'], { ...hidden, cwd: join(EDIR, 'node_modules', 'electron'), timeout: 900_000 });
    if (!existsSync(eExe)) log('下载控制视窗元件失败：' + String(r2.stdout || '').slice(-300) + ' ' + String(r2.stderr || '').slice(-500));
  }
  if (r.status !== 0 || !existsSync(eExe)) log('控制视窗元件安装失败，改用浏览器视窗：status=' + r.status + ' ' + String(r.error || '') + ' ' + String(r.stdout || '').slice(-400) + ' ' + String(r.stderr || '').slice(-600));
}
// 程式名称改成 AutoDeposit.exe（工作列、工作管理员都显示这个名字，也不会跟电脑上其他 Electron 程式混在一起）
const aExe = join(EDIR, 'node_modules', 'electron', 'dist', 'AutoDeposit.exe');
if (win && existsSync(eExe) && (!existsSync(aExe) || statSync(aExe).size !== statSync(eExe).size)) { try { copyFileSync(eExe, aExe); } catch (e) { log('建立 AutoDeposit.exe 失败：' + e.message); } }

// 3) 捷径：桌面图示每次覆写（资料夹搬家后自动更新）；开机自动启动只在第一次建立，
//    或原本就存在时更新路径——使用者自己删掉就不会再被加回来
if (win) {
  const firstRun = !existsSync(join(DATA, '.installed'));
  const ps = String.raw`
$s = New-Object -ComObject WScript.Shell
$dd = [Environment]::GetFolderPath('Desktop'); New-Item -ItemType Directory -Force -Path $dd | Out-Null
$nm = 'TermiX AutoDeposit'; $i = 1
while ($true) { $p = Join-Path $dd ($nm + '.lnk'); if (-not (Test-Path $p)) { break }; $o = $s.CreateShortcut($p); if ($o.Arguments -and $o.Arguments.Contains($env:TX_VBS)) { break }; $i++; $nm = 'TermiX AutoDeposit ' + $i }
$d = Join-Path $dd ($nm + '.lnk')
$l = $s.CreateShortcut($d); $l.TargetPath = 'wscript.exe'; $l.Arguments = '"' + $env:TX_VBS + '"'; $l.WorkingDirectory = $env:TX_ROOT; $l.IconLocation = (Join-Path $env:TX_ROOT 'app\app.ico') + ',0'; $l.Save()
$sd = [Environment]::GetFolderPath('Startup'); if (-not $sd) { $sd = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup' }
New-Item -ItemType Directory -Force -Path $sd | Out-Null
$b = Join-Path $sd ($nm + '.lnk')
if ($env:TX_FIRST -eq '1' -or (Test-Path $b)) { $l = $s.CreateShortcut($b); $l.TargetPath = 'wscript.exe'; $l.Arguments = '"' + $env:TX_VBS + '" --boot'; $l.WorkingDirectory = $env:TX_ROOT; $l.IconLocation = (Join-Path $env:TX_ROOT 'app\app.ico') + ',0'; $l.Save() }
`;
  // 路径用环境变数传入：资料夹名称有引号、空格、中文都不会出错
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { ...hidden, env: { ...process.env, TX_VBS: join(ROOT, 'Start-TermiX.vbs'), TX_ROOT: ROOT, TX_FIRST: firstRun ? '1' : '0' } });
  if (r.status !== 0) log('建立捷径失败：' + (r.stderr || '').slice(-300));
  else if (firstRun) writeFileSync(join(DATA, '.installed'), new Date().toISOString());
}
unlock();

// 4) 在背景执行引擎；意外停止就自动重启，但 5 分钟内停止 5 次就通知使用者并暂停
let first = true;
const crashes = [];
let startedAt = 0;
const PENDING = join(DATA, '.update', 'pending.json');
const readPending = () => { try { return JSON.parse(readFileSync(PENDING, 'utf8')); } catch { return null; } };
// 新版本连续启动失败 → 用更新前的备份退回旧版
function rollback(p) {
  try {
    for (const f of p.files || []) {
      const b = join(p.backup, f), d = join(ROOT, f);
      if (!d.startsWith(ROOT) || d.startsWith(DATA)) continue;
      if (existsSync(b)) copyFileSync(b, d); else rmSync(d, { force: true });
    }
    writeFileSync(join(DATA, '.update', 'rolledback.json'), JSON.stringify({ ...p, rolledBackAt: Date.now() }));
    unlinkSync(PENDING);
    log(`新版本 v${p.to} 连续启动失败，已自动退回 v${p.from}`);
    return true;
  } catch (e) { log('自动退回旧版失败：' + e.message); return false; }
}
function startEngine() {
  startedAt = Date.now();
  const env = { ...process.env, ANCHOR_OPEN_UI: first && !boot ? '1' : '0' };
  first = false;
  const child = spawn(process.execPath, [join(ROOT, 'app', 'server.mjs')], { cwd: ROOT, env, windowsHide: true, stdio: 'ignore' });
  child.on('exit', (code) => {
    // 新版本稳定跑超过 3 分钟 → 视为更新成功
    if (Date.now() - startedAt > 3 * 60_000) { try { unlinkSync(PENDING); } catch { /* ignore */ } }
    if (code === 10) ensureDeps(true); // 在线更新后：套件有换就先解压再重启
    if (code === 3) { log('工具已经在运行，打开控制页面'); if (!boot) openUi(); process.exit(0); }
    if (code === 4) { log('连接埠无法使用'); msg('找不到可用的连接埠（17890～17899 都被占用或被系统保留），请关闭占用的程式或重新开机后，再点桌面图示。'); process.exit(1); }
    if (code === 0) { log('已从控制页面关闭工具'); process.exit(0); }
    if (code !== 10) {
      crashes.push(Date.now());
      while (crashes.length && Date.now() - crashes[0] > 5 * 60_000) crashes.shift();
      const pend = readPending();
      if (pend && crashes.length >= 3 && rollback(pend)) { crashes.length = 0; ensureDeps(true); setTimeout(startEngine, 3000); return; }
      if (crashes.length >= 5) { log('5 分钟内停止 5 次，暂停自动重启'); msg('工具连续启动失败，已暂停。请把工具资料夹 data 里的 log.txt 传给作者，或重新开机后再试。'); process.exit(1); }
    }
    log(code === 10 ? '控制页面要求重新启动' : `引擎停止（代码 ${code}），10 秒后自动重启`);
    setTimeout(startEngine, code === 10 ? 1000 : 10_000);
  });
}
log(boot ? '开机自动启动' : '启动');
startEngine();
