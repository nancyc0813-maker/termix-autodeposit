// TermiX 自动存款（币安 AI 钱包）— 本地引擎 + 控制页面
// 只在使用者自己的电脑运行；只连 TermiX 官方 API、BNB 链 RPC、可选 Telegram；
// 使用者亲自按「反馈问题」时，才会把去掉敏感资讯的错误记录送给作者（REPORT_URL），不会自动上传。
// 安全原则：
//   1. 本金只在「使用者币安 AI 钱包」⇄「本工具产生的任务钱包」之间移动；收回目的地固定是使用者钱包，没有可改的转出地址。
//      给策略方的权限是「函数层级」：Venus 存款类只能 vUSDC.mint / redeem / redeemUnderlying、comptroller.enterMarkets；USDC 持有类没有任何操作权限（不能转帐、借款、换币）。
//   2. 每一步动钱前先读链上余额／付款记录，做过的不重做（不会重复转账或重复付费）。
//   3. 付费只送 TermiX 官方托管合约，金额上限由本机依策略费率计算；只存 Nancy 的 Venus 存款类与 USDC 持有类策略。
//   4. 任何非预期状况 → 该笔暂停并提醒，不继续动钱。
//   5. 控制页面只接受本机连接 + 随机访问码；不开 CORS。
//   6. 在线更新只读官方 GitHub、只接受作者签名过的清单，且只更新程序文件（updater.mjs），不碰 data/。
import { tgText, tgTitle } from './tg-i18n.mjs';
import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, readdirSync, appendFileSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { openApp } from './openapp.mjs';
import { release as osRelease } from 'node:os';
import { makeUpdater } from './updater.mjs';

const VERSION = '1.0.9';
const REPORT_URL = 'https://autodeposit-report.nightshift-hood.workers.dev/report'; // 作者的错误反馈收件箱（只收使用者按下「反馈问题」发送的内容）
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DATA = join(ROOT, 'data');
const SEED_DIR = join(DATA, 'seed');
const SK = join(ROOT, 'skills', 'termix-agent-skills', 'scripts');
const DEPS = ROOT; // node_modules 放在工具根目录（技能脚本从上层目录找得到套件）
let PORT = Number(process.env.ANCHOR_PORT || 0) || (() => { try { const n = Number(readFileSync(join(ROOT, 'data', '.port'), 'utf8')); return n >= 17890 && n <= 17899 ? n : 17890; } catch { return 17890; } })();
const BAW_MODE = (() => { try { return readFileSync(join(ROOT, 'data', '.baw-mode'), 'utf8').trim(); } catch { return 'global'; } })();
// 独立模式：币安钱包工具用「网卡 MAC」当登入信息的加密密钥，电脑多了 VPN／虚拟网卡时会变，导致登入失效。
// 改用本工具自己的固定识别码，登入信息才不会莫名失效。
const INSTANCE_ID = BAW_MODE !== 'private' ? '' : (() => { const f = join(ROOT, 'data', '.instance-id'); try { const v = readFileSync(f, 'utf8').trim(); if (/^[0-9a-f]{32}$/.test(v)) return v; } catch { /* 第一次 */ } const v = randomBytes(16).toString('hex'); try { mkdirSync(join(ROOT, 'data'), { recursive: true }); writeFileSync(f, v); } catch { /* ignore */ } return v; })();
const TEST_STRATEGY = String(process.env.ANCHOR_DEV_TEST_STRATEGY || ''); // 仅开发者实测用；设置档／介面无法开启
mkdirSync(DATA, { recursive: true });
process.env.ANCHOR_DEPS_DIR = DEPS; // 让本进程加载技能模组时也找得到套件

const req = createRequire(join(DEPS, 'package.json'));
const { createPublicClient, http: viemHttp, fallback, parseAbi, formatUnits, parseUnits, getAddress } = req('viem');
const { bsc } = req('viem/chains');

// ── 常数（全部来自 TermiX 官方 /api/v1/config/contracts，2026-11-26 核对）────────
const A = {
  USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  ESCROW: '0x6a52ba4c84b348faeae13ddc7a97b4f6af23913c',
  COMPTROLLER: '0xfd36e2c2a6789db23113685031d7f16329158384',
  VUSDC: '0xeca88125a5adbe82614ffc12d0db554e2e2867c8',
  VBTC: '0x882c173bc7ff3b7786ca16dfed3dfffb9ee7847b',
  ROUTER: '0x10ed43c718714eb63d5aa57b78b54704e256024e',
  WBNB: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
};
const API = 'https://platform-backend.prod.termix.live';
const TERM_DAYS = 0.25;              // 自动挑选时的期限：6 小时（积分按每 1U 每单计，越短跑越多单）
const TD = (s) => Number(s?.termDays) > 0 ? Number(s.termDays) : TERM_DAYS; // 每笔自己的期限（天）
const MAX_PLAN = 12;
const MAX_TERM_DAYS = 1; // 币安开发者模式一次最长约 7 天，到期前要能结算，所以只开放 6 小时与 1 天
const GAS_BNB = '0.004';             // 每个任务钱包的 gas（授权约用 0.002，其余收回时退回）
const KEEP_BNB = '0.004';            // 币安钱包至少保留的 BNB
const FEE_RESERVE_USDC = 0.2;        // 留在币安钱包付手续费的 USDC
const ACCEPT_TIMEOUT_MS = 45 * 60_000; // 策略方 45 分钟没接单 → 退费换策略（取消的话授权登记费就白付了，所以不要太急）
const SWEEP_AFTER_END_MS = 2 * 60_000; // 到期 2 分钟后收回本金
const TICK_MS = 20_000;
const OK_DONE = new Set(['SETTLED', 'COMPLETED', 'ACCEPTED', 'RELEASED']);
const REFUND_DONE = new Set(['CANCELLED', 'CANCELED', 'REFUNDED', 'EXPIRED', 'CLOSED']);
const ACCEPTED_LIVE = new Set(['FUNDED', 'IN_PROGRESS', 'DELIVERED', 'IN_DISPUTE']);
// 受信任的提供者（Nancy 的策略）：优先存入
const PREFERRED_PROVIDERS = ['cmwxfbukv3j6ypf1kq4be8b0p'];

// ── 档案 ────────────────────────────────────────────────────────────────────
const F = { state: join(DATA, 'state.json'), settings: join(DATA, 'settings.json'), log: join(DATA, 'log.txt') };
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { writeFileSync(f + '.tmp', JSON.stringify(o, null, 1)); renameSync(f + '.tmp', f); };
const DEFAULT_SETTINGS = { maxPerRoundU: 20, maxRounds: 0, approveUsdc: 1, tgToken: '', tgChatId: '', plan: [], autoUpdate: true }; // plan 空 = 自动挑选；否则 [{ id, strategyId, termDays, amount }]
let settings = { ...DEFAULT_SETTINGS, ...readJson(F.settings, {}) };
delete settings.testStrategyId; delete settings.allowOthers; delete settings.maxSlots; // 旧版设置一律忽略
// 每次循环重读设置档：改设置（金额、轮数）不用重新启动
function reloadSettings() {
  const f = readJson(F.settings, null); if (!f) return;
  const n = { ...DEFAULT_SETTINGS, ...f }; delete n.testStrategyId; delete n.allowOthers; delete n.maxSlots;
  settings = n;
}
const st = readJson(F.state, null) || readJson(F.state + '.bak', null) || ({ running: false, slots: [], history: [], stats: { rounds: 0, tpEst: 0, refunded: 0 } });
if (st.setupDone === undefined && st.owner) st.setupDone = true; // 旧版已设置好过的电脑
st.slots ||= []; st.history ||= []; st.stats ||= { rounds: 0, tpEst: 0, refunded: 0 };
const save = () => { try { if (existsSync(F.state)) copyFileSync(F.state, F.state + '.bak'); } catch { /* ignore */ } writeJson(F.state, st); };
const logs = [];
const ts = () => new Date().toLocaleString('zh-CN', { hour12: false });
let logWrites = 199;
function log(msg, level = 'info') {
  const line = `[${ts()}]${level === 'info' ? '' : ` [${level.toUpperCase()}]`} ${msg}`;
  console.log(line);
  logs.push({ t: Date.now(), level, msg });
  if (logs.length > 300) logs.shift();
  try {
    // 超过 20MB 换新档（旧的留一份 log.1.txt），避免日志一直变大
    if (++logWrites % 200 === 0 && statSync(F.log).size > 20 * 1024 * 1024) { const old = F.log.replace(/\.txt$/, '') + '.1.txt'; try { rmSync(old, { force: true }); } catch { /* ignore */ } renameSync(F.log, old); }
  } catch { /* ignore */ }
  try { appendFileSync(F.log, line + '\n'); } catch { /* ignore */ }
}
const scrub = (s) => String(s).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'JWT…').replace(/0x[0-9a-fA-F]{64}\b/g, '0x…').replace(/(token|seed|key)["']?\s*[:=]\s*["']?[A-Za-z0-9:_\-]{20,}/gi, '$1=…');

// 同一种提醒最多通知 3 次（24 小时内）；之后只写进运行记录，不再打扰用户
// tag：同一种提醒但属于不同的单（例如每一轮都要在 App 确认），各自算 3 次
async function notify(text, { always = false, tag = '' } = {}) {
  const key = String(text).replace(/[0-9.]+/g, '#').slice(0, 80) + (tag ? '|' + tag : '');
  st.notifyCounts ||= {};
  for (const [k, v] of Object.entries(st.notifyCounts)) if (Date.now() - v.first > 48 * 3600_000) delete st.notifyCounts[k];
  const n = st.notifyCounts[key];
  const fresh = !n || Date.now() - n.first > 24 * 3600_000;
  const c = fresh ? { first: Date.now(), count: 0 } : n;
  if (!always && c.count >= 3) { log('（已提醒 3 次，不再通知）' + text, 'warn'); return; }
  c.count += 1; st.notifyCounts[key] = c;
  log('🔔 ' + text, 'warn');
  if (settings.tgToken && settings.tgChatId) {
    try {
      await fetch(`https://api.telegram.org/bot${settings.tgToken}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: settings.tgChatId, text: `${tgTitle(settings.lang)} ${tgText(text, settings.lang)}` }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch { /* 通知失败不影响主流程 */ }
  }
}

// ── 币安 AI 钱包 CLI 位置 ─────────────────────────────────────────────────────
let BAWJS = '';
try {
  const root = BAW_MODE === 'private' ? join(ROOT, 'baw', 'node_modules') : execSync(process.platform === 'win32' ? 'npm.cmd root -g' : 'npm root -g', { encoding: 'utf8' }).trim();
  const dir = join(root, '@binance', 'agentic-wallet');
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  BAWJS = join(dir, typeof pj.bin === 'string' ? pj.bin : Object.values(pj.bin)[0]);
} catch { /* setup 页面会提示安装 */ }

let OWNER = ''; // 使用者币安 AI 钱包地址（从钱包本身读取，不能被设置改写）
let ownerConflict = false; // 钱包地址与记录不符时，封锁一切动钱
let ownerVerified = false; // 本次启动后是否已从钱包本身确认过地址
let otherInstance = ''; // 同一个币安钱包已有另一份工具在运行（路径），本份完全不动钱
function cleanEnv() {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(WALLET_KEY|A2A_|AACP_|TERMIX_|OPENAI|OPENROUTER|ANCHOR_|BAW_|BINANCE_BAW_DIR$)/i.test(k)) delete e[k];
  return e;
}
const env = (extra = {}) => ({
  ...cleanEnv(),
  AACP_CHAIN: 'bsc', TERMIX_WALLET_MODE: 'agentic', A2A_RPC_URL: 'https://bsc-dataseed.bnbchain.org', ANCHOR_RPC_FALLBACKS: 'https://bsc-rpc.publicnode.com,https://bsc-dataseed1.defibit.io,https://bsc-dataseed1.ninicoin.io',
  ...(BAWJS ? { BAW_BIN: BAWJS } : {}),
  ...(BAW_MODE === 'private' ? { BINANCE_BAW_DIR: join(DATA, 'baw-session'), BINANCE_INSTANCE_ID: INSTANCE_ID } : {}),
  ANCHOR_OWN_PROVIDERS: PREFERRED_PROVIDERS.join(','),
  ANCHOR_SEED_DIR: SEED_DIR, ...(LEGACY_SEED ? { ANCHOR_LEGACY_SEED: '1' } : {}), ANCHOR_DEPS_DIR: DEPS, ANCHOR_OWNER: OWNER, ANCHOR_STRICT: '1',
  ...(OWNER && ownerVerified ? { ANCHOR_SEED_BACKUP2: join(BACKUP2, OWNER.toLowerCase()) } : {}),
  // 手续费授权额度：一次授权 1 USDC（只给 TermiX 官方托管合约付手续费用），让「到币安 App 确认」很久才需要一次
  ANCHOR_APPROVE_WEI: String(parseUnits(String(Math.min(Math.max(Number(settings.approveUsdc) || 1, 1), 2)), 18)),
  ...(TEST_STRATEGY ? { ANCHOR_TEST_STRATEGY: TEST_STRATEGY } : {}),
  ...extra,
});

function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* ignore */ }
}
function lastJson(s) {
  const t = String(s || '').trim();
  try { return JSON.parse(t); } catch { /* fallthrough */ }
  const idx = [];
  for (let i = 0; i < t.length; i++) if (t[i] === '{' && (i === 0 || t[i - 1] === '\n')) idx.push(i);
  for (let k = idx.length - 1; k >= 0; k--) { try { return JSON.parse(t.slice(idx[k])); } catch { /* next */ } }
  return null;
}
function run(script, args, { timeoutMs = 300_000, extraEnv = {} } = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [join(SK, script), ...args], { cwd: DATA, env: env(extraEnv), windowsHide: true });
    let out = '', err = '', killed = false;
    const t = setTimeout(() => { killed = true; killTree(child); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(t);
      try { appendFileSync(F.log, `  > ${script} ${args.filter((a) => a.length < 200).join(' ')} → exit ${code}${killed ? ' (超时)' : ''}\n${scrub((out + err).trim()).split('\n').slice(-30).map((l) => '    ' + l).join('\n')}\n`); } catch { /* ignore */ }
      res({ code: killed ? -2 : code, out, err, all: out + err, json: lastJson(out) });
    });
    child.on('error', (e) => { clearTimeout(t); res({ code: -1, out, err: e.message, all: e.message, json: null }); });
  });
}
const lastLine = (s) => {
  const L = String(s || '').trim().split('\n').map((x) => x.trim()).filter(Boolean);
  if (L.some((x) => /no session|not signed in|session (token )?expired|401|unauthorized/i.test(x))) return 'TermiX 登录过期，正在自动重新登录';
  // 优先取真正的错误行（Error: …），不要取最后一行的「下一步提示命令」
  const e = L.find((x) => /error|failed|revert|insufficient|denied|rejected|timeout/i.test(x) && !/^node scripts\//.test(x)) || L.filter((x) => !/^node scripts\//.test(x)).slice(-1)[0] || L.slice(-1)[0] || '';
  return scrub(e).slice(0, 220);
};
const needsApp = (s) => /needs approval in the Binance App|PENDING_CONFIRMATION|must approve this/i.test(s);
const appRejected = (s) => /(rejected|declined|denied) by (the )?user|user (rejected|declined|denied|cancel)|rejected in (the )?(Binance )?App/i.test(s); // 用户在币安 App 按了拒绝

async function api(method, path, body) {
  const args = [method, path, '--auth', 'session'];
  if (body !== undefined) args.push('--body', JSON.stringify(body));
  const r = await run('aacp-api.mjs', args, { timeoutMs: 90_000 });
  if (r.code !== 0 || !r.json) { const e = new Error(lastLine(r.all) || `API ${method} ${path} 失败`); e.auth = /401|unauthor|not signed|session token/i.test(r.all); throw e; }
  return r.json;
}
async function publicGet(path) {
  const res = await fetch(API + path, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${path} ${res.status}`);
  return res.json();
}

// ── 链上读取 ──────────────────────────────────────────────────────────────────
const pc = createPublicClient({ chain: bsc, transport: fallback([viemHttp('https://bsc-dataseed.bnbchain.org', { timeout: 15_000 }), viemHttp('https://bsc-rpc.publicnode.com', { timeout: 15_000 }), viemHttp('https://bsc.drpc.org', { timeout: 15_000 }), viemHttp('https://binance.llamarpc.com', { timeout: 15_000 })]) });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function exchangeRateStored() view returns (uint256)', 'event Transfer(address indexed from, address indexed to, uint256 value)']);
const bal = (token, who) => pc.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] });
const bnb = (who) => pc.getBalance({ address: who });
const U = (x) => Number(formatUnits(x, 18));
async function escrowPayLogs(fromBlock) { // 你的钱包 → 托管合约 的 USDC 转账（分段查，避免 RPC 区块范围限制）
  const latest = await pc.getBlockNumber();
  const ev = ERC20.find((x) => x.name === 'Transfer');
  const out = [];
  for (let a = fromBlock; a <= latest; a += 4000n) {
    const b = a + 3999n > latest ? latest : a + 3999n;
    out.push(...await pc.getLogs({ address: A.USDC, event: ev, args: { from: OWNER, to: getAddress(A.ESCROW) }, fromBlock: a, toBlock: b }));
  }
  return out;
}
async function taskValue(addr) { // 任务钱包的 USDC 价值（含 Venus 存款）
  const [u, vb, er] = await Promise.all([bal(A.USDC, addr), bal(A.VUSDC, addr), pc.readContract({ address: A.VUSDC, abi: ERC20, functionName: 'exchangeRateStored' })]);
  return u + (vb * er) / 10n ** 18n;
}

// ── 种子备份（任务钱包唯一的密钥）───────────────────────────────────────────
const HOME = process.env.USERPROFILE || process.env.HOME || ROOT;
// 密钥备份文件夹：新安装用英文名（各语言用户都看得懂）；旧版已建立的中文文件夹继续沿用，绝不搬动密钥
const BACKUP2 = (() => {
  const f = join(DATA, '.backup-dir'); // 第一次决定后就记住，之后永远用同一个文件夹（避免和旧版的文件夹混用）
  try { const p = readFileSync(f, 'utf8').trim(); if (p) return p; } catch { /* 第一次 */ }
  const old = join(HOME, 'TermiX-自动存款-备份（不要删除）');
  const p = existsSync(old) ? old : join(HOME, 'TermiX-AutoDeposit-Backup (DO NOT DELETE)');
  try { writeFileSync(f, p); } catch { /* ignore */ }
  return p;
})();
let seedCache = { at: 0, v: null };
function seedSafe(fresh = false) {
  if (!fresh && seedCache.v && Date.now() - seedCache.at < 60_000) return seedCache.v;
  const v = seedSafeRaw(); seedCache = { at: Date.now(), v }; return v;
}
function seedSafeRaw() {
  const f = join(SEED_DIR, 'task-wallet-seed.hex');
  if (!existsSync(f)) return { ok: false, why: '种子尚未产生' };
  const main = readFileSync(f, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(main)) return { ok: false, why: '种子文件损坏' };
  const h = createHash('sha256').update(main).digest('hex');
  // 密钥绑定钱包：密钥只属于第一次使用它的币安钱包；文件夹被复制到别人的电脑／换钱包时，拒绝动钱
  const ownerFile = join(SEED_DIR, 'owner.txt');
  if (OWNER && ownerVerified) {
    if (!existsSync(ownerFile)) writeFileSync(ownerFile, OWNER);
    const bound = readFileSync(ownerFile, 'utf8').trim();
    if (bound.toLowerCase() !== OWNER.toLowerCase()) return { ok: false, why: `这把任务钱包密钥属于 ${bound}，与目前的币安钱包 ${OWNER} 不同。请勿复制别人的工具文件夹；若是你自己换了钱包，请换回原钱包。` };
  }
  // 第二份备份按钱包地址分文件夹：同一台电脑多个币安钱包各自独立，不会互相还原到别人的密钥
  const copies = [join(SEED_DIR, 'backup', 'task-wallet-seed.hex'), ...(OWNER && ownerKnown() ? [join(BACKUP2, OWNER.toLowerCase(), 'task-wallet-seed.hex')] : [])];
  for (const c of copies) {
    try {
      mkdirSync(dirname(c), { recursive: true });
      if (!existsSync(c)) copyFileSync(f, c);
      const v = readFileSync(c, 'utf8').trim();
      if (createHash('sha256').update(v).digest('hex') !== h) return { ok: false, why: `备份 ${c} 与主种子不一致，已停止（请勿删除任何种子文件，联系作者）` };
    } catch (e) { return { ok: false, why: '无法写入备份：' + e.message }; }
  }
  try { if (!existsSync(join(BACKUP2, '说明.txt'))) writeFileSync(join(BACKUP2, '说明.txt'), 'This folder backs up the TermiX AutoDeposit task-wallet keys. Never delete it while a task wallet holds funds, and never share it.\r\n\r\n这个文件夹是 TermiX 自动存款「任务钱包」的密钥备份。\r\n只要任务钱包里还有钱，就绝对不要删除，也不要给任何人看。\r\n每个子文件夹以币安钱包地址命名。工具文件夹不见时，把对应地址文件夹里的 task-wallet-seed.hex 放回 工具\\data\\seed\\ 即可找回。\r\n'); } catch { /* ignore */ }
  return { ok: true, hash: h.slice(0, 8) };
}
// v1.0 单一钱包时代的旧备份位置，只属于当初那台电脑的旧安装（共用模式且已有记录）；新安装绝不能还原它，否则会拿到别人的任务钱包密钥
const LEGACY_SEED = BAW_MODE === 'global' && !!st.owner;
// 种子不存在时，从备份还原（只还原，不覆盖）
(function restoreSeedIfMissing() {
  const f = join(SEED_DIR, 'task-wallet-seed.hex');
  if (existsSync(f)) return;
  const ow = (st.owner || '').toLowerCase();
  // 最后才用 v1.0 的旧位置（单一钱包时代），避免产生新种子而找不回旧任务钱包
  for (const c of [join(SEED_DIR, 'backup', 'task-wallet-seed.hex'), ...(ow ? [join(BACKUP2, ow, 'task-wallet-seed.hex')] : []), ...(LEGACY_SEED ? [join(BACKUP2, 'task-wallet-seed.hex')] : [])]) {
    if (existsSync(c)) { mkdirSync(SEED_DIR, { recursive: true }); copyFileSync(c, f); log('已从备份还原任务钱包种子'); return; }
  }
})();

// 收回目的地是否可信：本次已从钱包确认过，或与密钥绑定的钱包地址（seed/owner.txt）一致（离线、电脑重开时也能收回）
function ownerKnown() {
  if (ownerVerified) return true;
  try { const b = readFileSync(join(SEED_DIR, 'owner.txt'), 'utf8').trim(); return !!OWNER && b.toLowerCase() === OWNER.toLowerCase(); } catch { return false; }
}
// 一个币安钱包只能由一份工具操作：避免两份工具（例如新旧版本在不同文件夹）互相收回对方正在跑的任务钱包
let lockOwned = false;
function walletLock() {
  if (!OWNER || !ownerKnown()) return;
  const f = join(BACKUP2, OWNER.toLowerCase(), 'instance.json');
  try {
    const o = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
    let alive = false;
    if (o && o.pid) { try { process.kill(Number(o.pid), 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
    const other = o && o.root && o.root !== ROOT && alive && Date.now() - Number(o.at || 0) < 3 * 60_000;
    // 同时启动时两份都以为自己拿到锁：用文件夹路径决胜（固定规则，不会来回抢）
    if (other && !(lockOwned && ROOT < o.root)) {
      if (otherInstance !== o.root) { log(`这个币安钱包已经由另一份工具在运行（${o.root}），这份不开新单`, 'warn'); notify(`同一个币安钱包装了两份工具，这份（${ROOT}）不再开新单，只把自己进行中的单收完。请只保留 ${o.root} 那份。`); }
      otherInstance = o.root; lockOwned = false; st.running = false; return;
    }
    otherInstance = ''; lockOwned = true;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ root: ROOT, pid: process.pid, port: PORT, at: Date.now() }));
  } catch { /* 写不进去不影响（单机通常只有一份） */ }
}
setInterval(walletLock, 30_000).unref(); // 心跳独立于主循环：长步骤（授权、收回）进行中也不会被误判为没在跑
function walletUnlock() {
  try { if (!OWNER || !lockOwned) return; const f = join(BACKUP2, OWNER.toLowerCase(), 'instance.json'); const o = JSON.parse(readFileSync(f, 'utf8')); if (o.root === ROOT) unlinkSync(f); } catch { /* ignore */ }
}
process.on('exit', walletUnlock);

// ── 环境状态（钱包 / 登入 / 条款 / 代理）─────────────────────────────────────
let agentAutoTried = false;
const env0 = { baw: !!BAWJS, heldAgent: '', wallet: 'UNKNOWN', address: '', devMode: null, login: false, terms: null, agentId: '', checkedAt: 0, balances: null, pairing: null };
function tokenExp() {
  try {
    const f = readdirSync(DATA).find((n) => /^\.termix-a2a-session\.bsc-.*\.env$/.test(n));
    const m = readFileSync(join(DATA, f), 'utf8').match(/^A2A_SESSION_TOKEN=(.+)$/m);
    return JSON.parse(Buffer.from(m[1].trim().split('.')[1], 'base64url').toString()).exp * 1000;
  } catch { return 0; }
}
const BOOT_AT = Date.now(); // 设置好过的电脑：重开后 90 秒内连接还没回来，先显示「处理中」，不闪「首次设置」
async function refreshEnv(force = false) {
  try { return await refreshEnvInner(force); } finally { env0.checked = true; if (ready() && !st.setupDone) { st.setupDone = true; save(); } }
}
async function refreshEnvInner(force = false) {
  if (!force && Date.now() - env0.checkedAt < 10 * 60_000 && env0.wallet === 'CONNECTED') return;
  env0.checkedAt = Date.now();
  env0.baw = !!BAWJS;
  if (!BAWJS) { env0.wallet = 'NO_CLI'; return; }
  const w = (await run('aacp-wallet.mjs', ['status'], { timeoutMs: 60_000 })).json;
  env0.wallet = w?.wallet || 'UNKNOWN';
  env0.devMode = w?.devMode || null;
  if (w?.address && /^0x[0-9a-fA-F]{40}$/.test(w.address)) {
    if (OWNER && OWNER.toLowerCase() !== w.address.toLowerCase() && st.slots.some((s) => !s.principalSwept && s.address)) {
      // 钱包换了而还有钱在路上：绝不改收回目的地
      if (!ownerConflict) await notify(`币安钱包地址变了（原 ${OWNER} → 现 ${w.address}），还有任务钱包未收回，已暂停所有动作。请切回原钱包。`);
      ownerConflict = true; st.running = false; save(); env0.wallet = 'CONFLICT';
      return;
    }
    ownerConflict = false; ownerVerified = true;
    OWNER = getAddress(w.address);
    st.owner = OWNER; save();
    walletLock();
  }
  env0.address = OWNER;
  if (env0.wallet !== 'CONNECTED' || !env0.devMode?.enabled) { env0.login = false; return; }
  if (tokenExp() - Date.now() < 2 * 3600_000) await run('a2a-runtime.mjs', ['login'], { timeoutMs: 120_000 });
  env0.login = tokenExp() - Date.now() > 30 * 60_000;
  if (!env0.login) return;
  const t = (await run('aacp-terms.mjs', ['status'], { timeoutMs: 60_000 })).json;
  env0.terms = t || null;
  if (t?.status !== 'accepted') return;
  try {
    const ag = await api('GET', '/api/v1/agents');
    const list = Array.isArray(ag) ? ag : ag?.items ?? [];
    env0.myAgents = list.map((a) => a.id || a.agentId).filter(Boolean);
    env0.agentId = env0.myAgents[0] || '';
    if (!env0.agentId) {
      // 还没有 TermiX 代理：先看使用者有没有现成的币安 Agent ID；有就直接启用（不花手续费，也能拿官方 50 TP），不用按按钮
      const ag2 = (await run('a2a-runtime.mjs', ['agents'], { timeoutMs: 90_000 })).json;
      const held = (ag2?.unactivated || [])[0];
      env0.heldAgent = held?.name || '';
      if (held?.name && !agentAutoTried) {
        agentAutoTried = true;
        try {
          await api('POST', '/api/v1/agents/activate', { provider: held.provider || 'binance_agent_id', name: held.name.replace(/\.ai$/, ''), category: 'Finance & Audit', description: 'Personal auto-deposit agent.', tags: ['auto-deposit'] });
          log(`已自动启用你的币安 Agent ID：${held.name}`);
          const ag3 = await api('GET', '/api/v1/agents');
          const l3 = Array.isArray(ag3) ? ag3 : ag3?.items ?? [];
          env0.myAgents = l3.map((a) => a.id || a.agentId).filter(Boolean);
          env0.agentId = env0.myAgents[0] || '';
        } catch (e) { log('自动启用币安 Agent ID 失败：' + e.message, 'warn'); }
      }
    }
  } catch (e) { log('读取代理失败：' + e.message, 'warn'); }
}
if (st.owner && /^0x[0-9a-fA-F]{40}$/.test(st.owner)) OWNER = st.owner;
const ready = () => env0.wallet === 'CONNECTED' && env0.devMode?.enabled && env0.login && env0.terms?.status === 'accepted' && !!env0.agentId && !!OWNER && (!existsSync(join(SEED_DIR, 'task-wallet-seed.hex')) || seedSafe().ok);

// 官方积分与邀请人（公开信息，免登入）
const DEFAULT_INVITE = 'X8UTKPUM'; // 工具作者 Nancy 的邀请码；使用者可自行改成别的或不绑
let rewards = { at: 0, v: null };
async function refreshRewards(force = false) {
  if (!OWNER || (!force && Date.now() - rewards.at < 5 * 60_000)) return;
  try {
    const r = await publicGet(`/api/v1/rewards/account/${OWNER.toLowerCase()}`);
    rewards = { at: Date.now(), v: { total: Number(r.totalPoints || 0), inviter: r.inviter || null, myCode: r.inviteCode || '', breakdown: (r.breakdown || []).map((x) => ({ type: x.sourceType, total: Number(x.total || 0) })) } };
  } catch { rewards.at = Date.now(); }
}
async function refreshBalances() {
  refreshRewards().catch(() => {});
  if (!OWNER) return;
  try {
    const [u, b] = await Promise.all([bal(A.USDC, OWNER), bnb(OWNER)]);
    let allowance = 0n;
    try { allowance = await pc.readContract({ address: A.USDC, abi: ERC20, functionName: 'allowance', args: [OWNER, A.ESCROW] }); } catch { /* ignore */ }
    env0.balances = { usdc: U(u), bnb: U(b), allowance: U(allowance), at: Date.now() };
  } catch (e) { log('读取余额失败：' + e.message, 'warn'); }
}

// ── 策略挑选（只选 Venus USDC 存款型；Nancy 的优先）──────────────────────────────────
const cooldown = {}; // strategyId → until
const set = (a) => new Set((a || []).map((x) => String(x).toLowerCase()));
const subset = (a, b) => [...a].every((x) => b.has(x));
function classify(s) {
  const tok = set(s.tokenAllowlist), ven = set(s.venueAllowlist);
  const venusUsdc = s.protocol === 'venus' && subset(tok, new Set([A.USDC])) && subset(ven, new Set([A.COMPTROLLER, A.VUSDC]));
  const preferred = PREFERRED_PROVIDERS.includes(s.providerAgentId);
  // 自家 USDC 持有策略：授权时策略方没有任何操作权限
  const hold = preferred && s.protocol !== 'venus' && subset(tok, new Set([A.WBNB, A.USDC])) && subset(ven, new Set([A.ROUTER, A.USDC, A.WBNB]));
  const test = !!TEST_STRATEGY && s.id === TEST_STRATEGY && s.protocol === 'venus';
  // 只存自家策略（风险第一：策略方是自己人）；Venus 存款类与 USDC 持有类各有固定的授权范围
  return { venusUsdc, preferred: preferred || test, ok: (preferred && (venusUsdc || hold)) || test, label: test ? '测试（只授权 Venus USDC）' : hold ? 'USDC 持有（策略方无操作权限）' : venusUsdc ? 'Venus USDC 存款（只能存取 Venus）' : '' };
}
let stratCache = { at: 0, v: null };
async function allStrategies(fresh = false) {
  if (!fresh && stratCache.v && Date.now() - stratCache.at < 60_000) return stratCache.v;
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const d = await publicGet(`/api/v1/quant/strategies?pageSize=100&page=${page}`);
    items.push(...(d.items || []));
    if (!d.totalPages || page >= d.totalPages) break;
  }
  stratCache = { at: Date.now(), v: { items } };
  return { items };
}
let lastPickNote = '';
// 可以存的策略（给「存款计划」挑选用）：只列安全条件通过的自家策略，附上类型、费率、空位、可选期限
async function eligibleStrategies(fresh = false) {
  const d = await allStrategies(fresh);
  const mine = new Set(env0.myAgents || []);
  return (d.items || [])
    .filter((s) => (s.status === 'LISTED' || s.status === 'AUDITION') && s.openForJobs !== false && !s.delistedAt)
    .filter((s) => !mine.has(s.providerAgentId))
    .filter((s) => Number(s.mgmtFeeBps) <= 300)
    .map((s) => ({ s, c: classify(s), avail: Math.max(0, Math.floor(Number(s.capacityU) - Number(s.managedU || 0))) }))
    .filter((x) => x.c.ok)
    .map((x) => ({ id: x.s.id, name: x.s.name, kind: x.c.label, hold: !x.c.venusUsdc, feeBps: Number(x.s.mgmtFeeBps), avail: x.avail, cap: Math.floor(Number(x.s.capacityU) || 0), min: Math.max(10, Number(x.s.minAllocationU) || 10), terms: (x.s.termDaysOptions || []).map(Number).filter((t) => t > 0 && t <= MAX_TERM_DAYS).sort((a, b) => a - b), cooldown: cooldown[x.s.id] > Date.now() }));
}
async function pickStrategies() {
  const d = await allStrategies();
  const mine = new Set(env0.myAgents || []);
  return (d.items || [])
    .filter((s) => (s.status === 'LISTED' || s.status === 'AUDITION') && s.openForJobs !== false && !s.delistedAt)
    .filter((s) => (s.termDaysOptions || []).map(Number).includes(TERM_DAYS))
    .filter((s) => !mine.has(s.providerAgentId))
    .filter((s) => Number(s.mgmtFeeBps) <= 300)
    .filter((s) => !(cooldown[s.id] > Date.now()))
    .map((s) => ({ s, c: classify(s), avail: Math.floor(Number(s.capacityU) - Number(s.managedU || 0)) })) // 可存空位 = 容量 − 别人已占用（长期单也会占位）
    .filter((x) => x.c.ok)
    .filter((x) => x.avail >= Math.max(10, Number(x.s.minAllocationU) || 10))
    .sort((a, b) => (b.c.preferred - a.c.preferred) || (b.c.venusUsdc - a.c.venusUsdc) || (b.avail - a.avail) || (Number(a.s.mgmtFeeBps) - Number(b.s.mgmtFeeBps)));
}

// ── 交易意图白名单检查（官方后端若被入侵，也送不出恶意交易）───────────────────
function assertEscrowIntent(intent, label) {
  const to = String(intent?.to || intent?.contract || '').toLowerCase();
  if (to !== A.ESCROW) throw new Error(`${label} 的交易目标不是 TermiX 官方托管合约（${to}），已拒绝`);
  if (intent?.value && BigInt(intent.value) !== 0n) throw new Error(`${label} 带有 BNB 转账，已拒绝`);
  const data = String(intent?.data || intent?.callData || '');
  // 托管合约上只会是「订单状态操作」：绝不能是代币授权／转账类的函数
  if (/^0x(095ea7b3|a9059cbb|23b872dd|39509351|d505accf|42842e0e|b88d4fde|a22cb465)/i.test(data)) throw new Error(`${label} 的交易内容是代币授权或转账，已拒绝`);
}
async function sendIntent(intent, label) {
  const r = await run('aacp-tx.mjs', ['--intent', JSON.stringify(intent), '--yes'], { timeoutMs: 240_000 });
  if (needsApp(r.all)) return { app: true };
  if (r.code !== 0) throw new Error(`${label} 失败：${lastLine(r.all)}`);
  return { ok: true, json: r.json };
}

// ── 每一笔（slot）的状态机 ─────────────────────────────────────────────────────
const STEP_CN = {
  allocate: '分配任务钱包', register: '登记任务钱包', fund: '转入本金', create: '建立委托单', deliver: '授权策略方',
  checkout: '开立手续费单', pay: '支付手续费', feerecover: '追踪手续费订单', wait_accept: '等策略方接单', active: '运行中', sweep: '收回本金', fee: '结算积分', done: '完成', paused: '已暂停',
};
function slotLog(s, m) { s.log = [...(s.log || []).slice(-15), `${ts()} ${m}`]; log(`[${s.id}] ${m}`); }
const NEVER_PAUSE = new Set(['sweep', 'fee', 'feerecover', 'wait_accept', 'active', 'pay']);
function fail(s, e) {
  s.errCount = (s.errCount || 0) + 1;
  s.lastErr = scrub(e?.message || String(e)).slice(0, 300);
  s.nextTryAt = Date.now() + Math.min(30 * 60_000, 20_000 * 2 ** Math.min(s.errCount - 1, 7));
  if (/did not confirm: status=PENDING/.test(s.lastErr)) s.nextTryAt = Date.now() + 8 * 60_000; // Altana 中继慢：多等一下，避免重复付授权登记费
  slotLog(s, `⚠️ ${STEP_CN[s.step] || s.step}出错（第 ${s.errCount} 次，稍后自动重试）：${s.lastErr}`);
  if (NEVER_PAUSE.has(s.step)) { if (s.errCount === 6) notify(`一笔 ${s.alloc}U 在「${STEP_CN[s.step]}」一直出错，工具会持续重试。原因：${s.lastErr}`); return; }
  if (s.errCount >= 8 && ['fund', 'create', 'deliver', 'checkout'].includes(s.step) && s.address) {
    // 本金已在任务钱包：不要停着等人处理，直接取消这一轮并收回本金
    s.cancelReason = `「${STEP_CN[s.step]}」一直出错，已取消并收回本金`; s.force = true; s.step = 'sweep'; s.errCount = 0; s.nextTryAt = 0;
    st.abortStreak = (st.abortStreak || 0) + 1; if (s.strategyId) cooldown[s.strategyId] = Date.now() + 2 * 3600_000;
    if (st.abortStreak >= 2) st.running = false;
    notify(`一笔 ${s.alloc}U 在准备阶段一直出错，已取消并自动收回本金。原因：${s.lastErr}`);
    return;
  }
  if (s.errCount >= 8 && ['allocate', 'register'].includes(s.step)) {
    // 准备阶段还没动到钱：安静取消，不要停在「暂停」挡住后面的单
    s.cancelReason = '准备阶段失败，没有动到钱'; s.principalSwept = true; s.step = 'done'; s.errCount = 0; s.nextTryAt = 0;
    if (s.strategyId) cooldown[s.strategyId] = Date.now() + 30 * 60_000;
    slotLog(s, '准备阶段失败，没有动到钱，已取消（稍后自动再开新单）');
    return;
  }
  if (s.errCount >= 8 && s.step !== 'paused') {
    s.pausedFrom = s.step; s.step = 'paused';
    notify(`一笔 ${s.alloc}U 存款在「${STEP_CN[s.pausedFrom]}」一直出错，已暂停（钱在任务钱包 ${s.address || '(尚未转入)'}，可按「全部收回」取回）。原因：${s.lastErr}`);
  }
}
const ok = (s, next, m) => { s.step = next; s.errCount = 0; s.lastErr = ''; s.nextTryAt = 0; if (m) slotLog(s, m); };

async function getJob(id) { return api('GET', `/api/v1/quant/jobs/${encodeURIComponent(id)}`); }
async function getOrder(id) { return api('GET', `/api/v1/orders/${encodeURIComponent(id)}`); }

async function stepSlot(s) {
  const now = Date.now();
  switch (s.step) {
    case 'allocate': {
      const r = await run('quant-client-local.mjs', ['allocate', '--strategy', s.strategyId]);
      if (r.json?.index == null) throw new Error(lastLine(r.all));
      s.index = Number(r.json.index); return ok(s, 'register', `分配任务钱包 #${s.index}`);
    }
    case 'register': {
      const r = await run('quant-client-local.mjs', ['register', '--index', String(s.index)]);
      const addr = r.json?.address;
      if (!r.json?.registered || !/^0x[0-9a-fA-F]{40}$/.test(addr || '')) throw new Error(lastLine(r.all));
      const sf = seedSafe(true); if (!sf.ok) throw new Error(sf.why);
      if (st.slots.some((o) => o !== s && o.address && !o.principalSwept && o.address.toLowerCase() === String(addr).toLowerCase())) throw new Error('平台分配到的任务钱包正被另一笔使用，已拒绝（不会把两笔钱放进同一个钱包）');
      s.address = getAddress(addr); s.seed = sf.hash;
      st.wallets ||= []; if (!st.wallets.some((w) => w.address === s.address)) st.wallets.push({ index: s.index, address: s.address });
      return ok(s, 'fund', `任务钱包 ${s.address}（密钥已备份）`);
    }
    case 'fund': {
      const sf = seedSafe(true); if (!sf.ok || sf.hash !== s.seed) throw new Error('种子备份检查未通过：' + (sf.why || '种子与登记时不同'));
      const need = parseUnits(String(s.alloc), 18), gas = parseUnits(GAS_BNB, 18);
      const [hu, hb] = await Promise.all([bal(A.USDC, s.address), bnb(s.address)]);
      const intents = [];
      if (hu < need) intents.push({ action: 'fund-principal', to: getAddress(A.USDC), value: '0', data: '0xa9059cbb' + s.address.slice(2).toLowerCase().padStart(64, '0') + (need - hu).toString(16).padStart(64, '0') });
      if (hb < (gas * 9n) / 10n) intents.push({ action: 'fund-gas', to: s.address, value: (gas - hb).toString(), data: '0x' });
      if (!intents.length) { s.fundedOk = true; s.appWaitUntil = 0; return ok(s, 'create', `已到账：${U(hu)} USDC + ${U(hb)} BNB`); }
      if (s.appWaitUntil && hu >= need) s.appWaitUntil = 0; // 本金已到账（只差 gas）：不用再等 App
      if (s.fundSentAt && now - s.fundSentAt < 5 * 60_000) return; // 上次发送后 5 分钟内只等到账，绝不重送
      if (s.appWaitUntil && now < s.appWaitUntil) return; // 等使用者在 App 确认，期间不重送
      // 币安钱包余额检查
      const [ou, ob] = await Promise.all([bal(A.USDC, OWNER), bnb(OWNER)]);
      const wantU = intents.find((i) => i.action === 'fund-principal') ? need - hu : 0n;
      const wantB = intents.find((i) => i.action === 'fund-gas') ? gas - hb : 0n;
      if (ou < wantU) throw new Error(`币安钱包 USDC 不足（需要 ${U(wantU)}，只有 ${U(ou)}）`);
      if (ob < wantB + parseUnits(KEEP_BNB, 18)) throw new Error(`币安钱包 BNB 不足（需要 ${U(wantB)} + 保留 ${KEEP_BNB}）`);
      if ((s.fundPrompts || 0) >= 3) { s.cancelReason = '转入本金在币安 App 连续 3 次没确认'; s.force = true; st.running = false; await notify('转入本金在币安 App 连续 3 次没确认，这一轮已取消。要继续请按「开始」。'); return ok(s, 'sweep'); }
      slotLog(s, `转入 ${U(wantU)} USDC + ${U(wantB)} BNB 到任务钱包`);
      s.fundSentAt = now; save();
      const r = await run('aacp-tx.mjs', ['--intents', JSON.stringify(intents), '--yes'], { timeoutMs: 240_000 });
      if (needsApp(r.all) || appRejected(r.all)) s.fundPrompts = (s.fundPrompts || 0) + 1; // 只算「请你在 App 确认／你按了拒绝」，网络或节点错误不算
      if (needsApp(r.all)) {
        s.fundSentAt = 0;
        s.appWaitUntil = now + 15 * 60_000; s.appWhat = 'fund'; await notify('请打开币安 App 确认转入本金的交易', { tag: s.id }); return; }
      if (r.code !== 0) throw new Error(lastLine(r.all));
      for (let i = 0; i < 12; i++) { // 等上链
        const [u2, b2] = await Promise.all([bal(A.USDC, s.address), bnb(s.address)]);
        if (u2 >= need && b2 >= (gas * 9n) / 10n) { s.fundedOk = true; return ok(s, 'create', '本金与 gas 已到账'); }
        await new Promise((r2) => setTimeout(r2, 5000));
      }
      throw new Error('转账已发送但还没看到到账，下一轮再查（不会重送已到账的部分）');
    }
    case 'create': {
      // 当机重启保护：这个任务钱包若已经有委托单，直接沿用，不重复建立
      try {
        const lst = await api('GET', '/api/v1/quant/jobs');
        const items = Array.isArray(lst) ? lst : lst?.items ?? lst?.jobs ?? [];
        const ex = items.find((j) => String(j.tradingWalletAddress || '').toLowerCase() === s.address.toLowerCase() && !['REVOKED', 'CANCELLED', 'COMPLETED', 'SETTLED'].includes(j.status));
        const local = readJson(join(DATA, readdirSync(DATA).find((n) => /^\.termix-quant-client\..*\.json$/.test(n)) || 'none'), {});
        if (ex && local?.jobs?.[ex.id]) { s.jobId = ex.id; if (ex.strategyId) s.strategyId = ex.strategyId; return ok(s, 'deliver', `沿用已建立的委托单 ${ex.id}`); }
      } catch { /* 查不到就照常建立 */ }
      const r = await run('quant-client-local.mjs', ['create', '--strategy', s.strategyId, '--index', String(s.index), '--address', s.address, '--allocationU', String(s.alloc), '--dailyCapU', String(s.alloc), '--termDays', String(TD(s))]);
      if (!r.json?.jobId) {
        if (/capacity|full|not open|not listed|closed|exceed/i.test(r.all)) {
          cooldown[s.strategyId] = now + 30 * 60_000;
          if (s.planId) { s.cancelReason = '策略空位已满'; return ok(s, 'sweep', '你选的策略已满，收回本金，有空位会再存'); }
          const alt = (await pickStrategies()).find((x) => x.avail >= s.alloc);
          if (alt) { s.strategyId = alt.s.id; s.strategyName = alt.s.name; s.label = alt.c.label; s.venueAllow = alt.s.venueAllowlist; s.provider = alt.s.agentHandle; s.feeBps = alt.s.mgmtFeeBps; slotLog(s, `原策略已满，改存「${alt.s.name}」`); return; }
          s.cancelReason = '没有可用策略'; return ok(s, 'sweep', '暂时没有可用策略，收回本金');
        }
        if ((s.errCount || 0) >= 2 && !s.planId) {
          cooldown[s.strategyId] = now + 60 * 60_000;
          const alt = (await pickStrategies()).find((x) => x.avail >= s.alloc && x.s.id !== s.strategyId);
          if (alt) { s.strategyId = alt.s.id; s.strategyName = alt.s.name; s.label = alt.c.label; s.venueAllow = alt.s.venueAllowlist; s.provider = alt.s.agentHandle; s.feeBps = alt.s.mgmtFeeBps; slotLog(s, `建单一直失败，改存「${alt.s.name}」`); s.errCount = 0; return; }
        }
        throw new Error(lastLine(r.all));
      }
      s.jobId = r.json.jobId; return ok(s, 'deliver', `委托单 ${s.jobId}`);
    }
    case 'deliver': {
      const j0 = await getJob(s.jobId);
      if (j0.status === 'DRAFT' || !j0.sessionPublicKey) {
        // 授权前再检查一次策略是否仍是 Venus USDC 存款型（防止策略被改）
        const sd = (await allStrategies()).items.find((x) => x.id === s.strategyId);
        if (sd) { s.venueAllow = sd.venueAllowlist; if (Number(sd.mgmtFeeBps) > Number(s.feeBps)) { await abortSlot(s, '策略费率在授权前被调高'); return ok(s, 'sweep', '策略费率被调高，取消并收回'); } }
        if (!sd || !classify(sd).ok) { await abortSlot(s, '策略内容变了，不再安全'); return ok(s, 'sweep', '策略已不符合安全条件，取消并收回'); }
        s.grantTries = (s.grantTries || 0) + 1; save();
        if (s.grantTries > 3) { await abortSlot(s, '授权一直无法完成'); return ok(s, 'sweep', '授权试了 3 次都没完成，取消并收回本金（避免重复付登记费）'); }
        s.deliverAt = Date.now();
        const r = await run('quant-client-local.mjs', ['deliver', '--index', String(s.index), '--job', s.jobId], { timeoutMs: 600_000 });
        if (r.code !== 0) throw new Error(lastLine(r.all));
      }
      const j = await getJob(s.jobId);
      if (!j.sessionPublicKey || ['DRAFT', 'REVOKED', 'CANCELLED'].includes(j.status)) throw new Error(`授权后状态异常：${j.status}`);
      s.jobStatusSeen = j.status;
      // 授权范围由本机程序依写死的白名单产生（函数层级），不依赖后台回传
      s.endsAt = Date.parse(j.endsAt); s.startedAt = Date.parse(j.startedAt);
      s.endsCap = (s.deliverAt || Date.now()) + TD(s) * 86400_000 + 30 * 60_000; // 后台给的到期时间不得超过本机计算的上限
      if (!Number.isFinite(s.endsAt) || s.endsAt > s.endsCap) s.endsAt = s.endsCap;
      return ok(s, 'checkout', `已授权，${new Date(s.endsAt).toLocaleTimeString('zh-CN', { hour12: false })} 到期`);
    }
    case 'checkout': {
      const r = await run('quant-client-local.mjs', ['checkout', '--job', s.jobId], { timeoutMs: 120_000 });
      if (!r.json?.checkoutSessionId) throw new Error(lastLine(r.all));
      const maxFee = (Number(s.alloc) * Math.min(Number(s.feeBps) || 300, 300) / 1e4 * TD(s)) / 365 * 1.02 + 1e-6;
      if (r.json.feeU == null || !(Number(r.json.feeU) <= maxFee)) { await abortSlot(s, `手续费异常 ${r.json.feeU}`); return ok(s, 'sweep', `手续费 ${r.json.feeU} 超过合理上限，取消`); }
      s.checkoutId = r.json.checkoutSessionId; s.feeU = r.json.feeU; s.checkoutAt = now;
      return ok(s, 'pay', `手续费 ${Number(s.feeU || 0).toFixed(6)} USDC`);
    }
    case 'pay': {
      const j0 = await getJob(s.jobId);
      if (j0.orderId) { s.orderId = j0.orderId; s.orderedAt ||= now; return ok(s, 'wait_accept', '手续费已付（已确认）'); }
      if (s.orderSentAt) {
        // createOrder 已经发送过：只做「补登记」，绝不再送第二次付款
        try { await api('POST', `/api/v1/checkout/${s.checkoutId}/recover`, {}); } catch { /* 还没上链或已登记 */ }
        const j1 = await getJob(s.jobId);
        if (j1.orderId) { s.orderId = j1.orderId; s.orderedAt = now; return ok(s, 'wait_accept', '手续费已付（补登记完成）'); }
        if (now - s.orderSentAt > 60 * 60_000) { await abortSlot(s, '付款后 60 分钟仍未登记，先收回本金'); await notify('一笔付款发送 60 分钟仍未在平台登记，已先收回本金，订单会持续追踪'); return ok(s, 'sweep'); }
        return;
      }
      s.checkoutAt ||= now;
      if (s.appWaitUntil && now < s.appWaitUntil) {
        const al = await pc.readContract({ address: A.USDC, abi: ERC20, functionName: 'allowance', args: [OWNER, A.ESCROW] }).catch(() => null);
        if (al === null) return; // 节点暂时读不到，下一轮再看（不当成没授权）
        if (al < parseUnits(String(s.feeU || '0.000001'), 18)) return; // 还在等 App 确认
        s.appWaitUntil = 0; s.payAttemptAt = 0; save(); // 已确认：马上继续付款
      }
      if (s.payBlock) {
        // 上次付款尝试中断过：先查链上有没有「你的钱包 → 托管合约」的 USDC 转账，有就只补登记，绝不重付
        const logs = await escrowPayLogs(BigInt(s.payBlock)).catch(() => null);
        if (logs === null) {
          // 查不到链上记录也不能无限等：超过 2 小时先收回本金，手续费交给「找回手续费」步骤继续追
          if (now - s.checkoutAt > 2 * 3600_000) { s.orderSentAt ||= now; s.payUnknown = true; save(); await abortSlot(s, '无法确认手续费是否已付'); return ok(s, 'sweep'); }
          throw new Error('无法查询链上付款记录，稍后再试');
        }
        if (logs.length) { s.orderSentAt ||= now; save(); return; }
        if (now - (s.payAttemptAt || 0) < 5 * 60_000) return;
      }
      if (now - s.checkoutAt > 2 * 3600_000) { await abortSlot(s, '手续费 2 小时都付不出去'); await notify(`一笔 ${s.alloc}U：手续费 2 小时都付不出去，已取消并收回本金。原因：${s.lastErr || '—'}`); return ok(s, 'sweep'); }
      if ((s.appPrompts || 0) >= 3) { await abortSlot(s, '币安 App 的授权一直没确认（可能被拒绝）'); await notify('手续费授权在币安 App 连续 3 次没确认，这一轮已取消并收回本金。要继续请先在 App 确认授权，再按「开始」。'); return ok(s, 'sweep'); }
      s.payBlock = Number(await pc.getBlockNumber()) - 5; s.payAttemptAt = now; save();
      const maxFeeWei = parseUnits(((Number(s.alloc) * Math.min(Number(s.feeBps) || 300, 300) / 1e4 * TD(s)) / 365 * 1.02 + 1e-6).toFixed(18), 18);
      // 授权额度：6 小时单 1 USDC（约 70 轮才用完）；长期单手续费较高，就授权「这单手续费的 2 倍」，最多 5 USDC，只给官方托管合约
      const approveWei = (() => { const one = parseUnits('1', 18), five = parseUnits('5', 18); let w = maxFeeWei * 2n; if (w < one) w = one; if (w > five) w = five; return w; })();
      const r = await run('quant-client-local.mjs', ['escrow-fee', '--checkout', s.checkoutId, '--yes'], { timeoutMs: 300_000, extraEnv: { ANCHOR_MAX_FEE_WEI: String(maxFeeWei), ANCHOR_APPROVE_WEI: String(approveWei) } });
      if (/sent createOrder|createOrderTx/.test(r.all)) { s.orderSentAt = now; save(); }
      if (!s.orderSentAt && (needsApp(r.all) || appRejected(r.all))) { s.appPrompts = (s.appPrompts || 0) + 1; save(); } // 只算「App 确认／拒绝」，网络或节点错误不算（另有 2 小时上限）
      if (!s.orderSentAt && /refusing/i.test(r.all)) { await abortSlot(s, '手续费交易内容不符安全规则，已拒绝付款'); await notify(`一笔 ${s.alloc}U：后台送来的付费交易不符安全规则，已拒绝并收回本金。原因：${lastLine(r.all)}`); return ok(s, 'sweep'); }
      if (needsApp(r.all) && /createOrder/.test(r.all)) { s.orderSentAt = now; s.appWaitUntil = now + 15 * 60_000; s.appWhat = 'fee-pay'; save(); await notify('请在币安 App 确认「付手续费」交易', { tag: s.id }); return; }
      if (needsApp(r.all) && !s.orderSentAt) {
        s.appWaitUntil = now + 15 * 60_000; s.appWhat = 'fee-approve'; await notify('第一次需要在币安 App 按「确认」授权手续费额度（额度用完才会再请你确认），按完会自动继续', { tag: s.id }); return; }
      const j = await getJob(s.jobId);
      if (j.orderId) { s.orderId = j.orderId; s.orderedAt = now; return ok(s, 'wait_accept', '手续费已付，等策略方接单'); }
      if (s.orderSentAt) return; // 下一轮补登记
      throw new Error(lastLine(r.all));
    }
    case 'wait_accept': {
      const o = await getOrder(s.orderId);
      s.orderStatus = o.status; s.lastErr = ''; s.errCount = 0; // 查到订单就清掉之前的连接错误，避免画面一直显示旧错误
      if (o.status === 'PENDING_ACCEPT') {
        if (now - s.orderedAt < ACCEPT_TIMEOUT_MS) return;
        const hard = now - s.orderedAt > ACCEPT_TIMEOUT_MS + 60 * 60_000;
        if ((s.cancelPrompts || 0) >= 3 || (s.cancelErrs || 0) >= 5 || hard) { await abortSlot(s, '策略方没接单（取消订单未完成，手续费可能不退）'); return ok(s, 'sweep'); } // 不为了一点手续费一直押着本金；计入连续中止，会冷却并停止开新单
        slotLog(s, '策略方 45 分钟没接单，取回手续费、换策略');
        const it = await api('POST', `/api/v1/orders/${s.orderId}/cancel-pending/prepare`, {});
        assertEscrowIntent(it, '取消订单');
        let r; try { r = await sendIntent(it, '取消订单'); } catch (e) { s.cancelErrs = (s.cancelErrs || 0) + 1; save(); throw e; }
        if (r.app) {
          s.cancelPrompts = (s.cancelPrompts || 0) + 1; s.appWaitUntil = now + 15 * 60_000; s.appWhat = 'cancel';
          s.nextTryAt = now + 15 * 60_000; await notify('请在币安 App 确认「取消订单」，手续费才会退回', { tag: s.id }); return;
        }
        st.noAccept = (st.noAccept || 0) + 1;
        cooldown[s.strategyId] = now + 2 * 3600_000 * 2 ** Math.min(st.noAccept - 1, 4);
        s.cancelReason = '策略方没接单（手续费退回）';
        if (st.noAccept >= 3) { st.running = false; await notify('策略方连续 3 次没接单，已停止开新单（避免一直付授权费）。确认策略方正常后再按「开始」。'); }
        await revoke(s); return ok(s, 'sweep');
      }
      if (ACCEPTED_LIVE.has(o.status) || OK_DONE.has(o.status)) { st.noAccept = 0; st.abortStreak = 0; return ok(s, 'active', '策略方已接单，开始计时'); }
      if (REFUND_DONE.has(o.status)) { await abortSlot(s, '订单已取消'); return ok(s, 'sweep'); }
      if (now - (s.orderedAt || now) > ACCEPT_TIMEOUT_MS + 15 * 60_000) { await abortSlot(s, `策略方一直没有接单（${o.status}），已自动取消并收回本金`); return ok(s, 'sweep', '订单一直没被接单，取消并收回本金'); }
      return;
    }
    case 'active': {
      if (!Number.isFinite(s.endsAt) || s.endsAt < 1e12) { const j = await getJob(s.jobId); s.endsAt = Date.parse(j.endsAt); if (!Number.isFinite(s.endsAt)) throw new Error('读不到到期时间，暂不收回'); }
      if (!s.lastWatch || now - s.lastWatch > 10 * 60_000) {
        s.lastWatch = now;
        try { const j = await getJob(s.jobId); const e2 = Date.parse(j.endsAt); if (Number.isFinite(e2)) s.endsAt = Math.min(e2, s.endsCap || e2); } catch { /* 下次再读 */ }
        const v = await taskValue(s.address).catch(() => null);
        if (v !== null && v < parseUnits(String(s.alloc), 18) * 99n / 100n) {
          s.cancelReason = `任务钱包价值异常下降（${U(v).toFixed(4)} / ${s.alloc}）`; s.force = true;
          await revoke(s); await notify(`⚠️ ${s.alloc}U 那笔的任务钱包价值降到 ${U(v).toFixed(4)}，已撤销授权并提前收回`);
          return ok(s, 'sweep');
        }
      }
      if (now < s.endsAt + SWEEP_AFTER_END_MS) return;
      return ok(s, 'sweep', '已到期，收回本金');
    }
    case 'sweep': {
      if (!s.address) { s.principalSwept = true; return ok(s, s.orderId ? 'fee' : 'done', '没有资金需要收回'); }
      if (!s.cancelReason && !s.force && s.jobId && (!Number.isFinite(s.endsAt) || now < s.endsAt + SWEEP_AFTER_END_MS)) return ok(s, 'active');
      if (!/^0x[0-9a-fA-F]{40}$/.test(OWNER) || ownerConflict || !ownerKnown()) throw new Error('钱包地址尚未从币安钱包确认，暂不收回（连上钱包后自动继续）');
      { const sf = seedSafe(true); if (!sf.ok) throw new Error('密钥检查未通过，暂不收回：' + sf.why); }
      if (s.preSweepValue == null) { const v = await taskValue(s.address).catch(() => null); if (v === null) throw new Error('读不到任务钱包余额，稍后再收回'); s.preSweepValue = U(v); save(); }
      if (!s.onchainRevoked && (s.revokeFails || 0) < 3) {
        // 先在链上撤销策略方的 session 密钥，再搬钱（只通知后台不够：链上授权要到期才会失效）
        const rv = await run('quant-client-local.mjs', ['revoke-onchain', '--index', String(s.index), '--address', s.address], { timeoutMs: 300_000 });
        if (rv.code !== 0 || rv.json?.sessionKeysLeft !== 0 && !/not delegated/.test(rv.all)) {
          s.revokeFails = (s.revokeFails || 0) + 1; save();
          if (/insufficient funds|gas required exceeds|have 0/i.test(rv.all)) await topUpGas(s, true);
          // 撤销失败不能卡住本金：策略方的授权本来就动不到本金，失败 3 次后先收回本金
          throw new Error('链上撤销授权未完成（第 ' + s.revokeFails + ' 次，3 次后会先收回本金）：' + lastLine(rv.all));
        }
        s.onchainRevoked = true; save(); slotLog(s, '已在链上撤销策略方授权');
      }
      const r = await run('quant-client-local.mjs', ['sweep', '--index', String(s.index), '--address', s.address, '--to', OWNER, '--yes'], { timeoutMs: 300_000 });
      // 同一个区块高度读余额（避免多节点高度不一读到假的 0）；极小零头（例如地址投毒打进来的灰尘）视同已收回
      { const vm = /sent \d+ (vUSDC|vBTC) to/.exec(r.all); if (vm) { s.vSentToOwner = vm[1]; save(); } }
      const bn = await pc.getBlockNumber();
      const rd = (t) => pc.readContract({ address: t, abi: ERC20, functionName: 'balanceOf', args: [s.address], blockNumber: bn });
      const [u, b, v1, v2, w1] = await Promise.all([rd(A.USDC), pc.getBalance({ address: s.address, blockNumber: bn }), rd(A.VUSDC), rd(A.VBTC), rd(A.WBNB)]);
      if (u < 10n ** 16n && v1 < 10n ** 6n && v2 < 10n ** 4n && w1 < 10n ** 13n) {
        s.principalSwept = true;
        // Venus 赎回不了时，工具会把 vUSDC 本身转回你的钱包：明确告诉用户要自己去 Venus 赎回
        if (s.vSentToOwner) { slotLog(s, `⚠️ Venus 暂时无法赎回，已把 ${s.vSentToOwner} 直接转回你的币安钱包`); await notify(`${Number(s.alloc) > 0 ? '一笔 ' + s.alloc + 'U' : '补收的零钱'}：Venus 暂时无法赎回，工具已把 ${s.vSentToOwner}（Venus 存款凭证）直接转回你的币安钱包，钱没有少。请到 Venus 把它赎回成 USDC，下一轮才有 USDC 可以存。`); }
        if (!s.onchainRevoked) slotLog(s, '⚠️ 链上授权撤销未完成（本金已收回；授权本来就动不到本金，到期自动失效）');
        const got = Number(s.preSweepValue ?? 0);
        if (s.fundedOk && got < Number(s.alloc) * 0.995) {
          s.shortfall = true; st.running = false;
          await notify(`⚠️ 本金短少：存入 ${s.alloc}，收回 ${got.toFixed(4)}。已停止自动存款，这笔不会放款，请到 agent.family 对订单提出争议。`);
        }
        if (!s.orderId && s.jobId) { try { const j = await getJob(s.jobId); if (j.orderId) s.orderId = j.orderId; } catch { /* ignore */ } }
        return ok(s, s.orderId ? 'fee' : (s.orderSentAt ? 'feerecover' : 'done'), `本金已收回到你的币安钱包：${got.toFixed(4)} USDC`);
      }
      if (b < 3n * 10n ** 14n && /0 BNB for gas|insufficient funds|gas required exceeds/i.test(r.all)) await topUpGas(s); // 只有确定是缺 gas 才补
      throw new Error(`收回未完成：USDC ${U(u)}、vUSDC ${v1}、WBNB ${U(w1)}。${lastLine(r.all)}`);
    }
    case 'feerecover': {
      // 付款可能已上链但还没登记：持续补登记 12 小时，找到订单就进入结算（可取消／放款）
      if (s.nextFeeCheck && now < s.nextFeeCheck) return;
      s.nextFeeCheck = now + 5 * 60_000;
      if (s.checkoutId) { try { await api('POST', `/api/v1/checkout/${s.checkoutId}/recover`, {}); } catch { /* ignore */ } }
      if (s.jobId) { const j = await getJob(s.jobId); if (j.orderId) { s.orderId = j.orderId; return ok(s, 'fee', '找到订单，进入结算'); } }
      if (now - (s.orderSentAt || now) > 12 * 3600_000) { await notify(s.payUnknown ? `一笔手续费无法确认是否已付出（checkout ${s.checkoutId}），本金早已收回，请到 agent.family 查看` : `一笔手续费付款一直没在平台登记（checkout ${s.checkoutId}），请到 agent.family 查看`); return ok(s, 'done', '手续费订单无法登记，已通知'); }
      return;
    }
    case 'fee': {
      if (s.nextFeeCheck && now < s.nextFeeCheck) return;
      s.nextFeeCheck = now + 60_000;
      let o;
      try { o = await getOrder(s.orderId); }
      catch (e) {
        // 平台一直查不到这张订单：本金早已收回的话，超过期限就结案，不要永远占着「进行中」、挡住下一轮
        if (s.principalSwept && s.endsAt && (s.errCount || 0) >= 4 && now > s.endsAt + ((s.shortfall || s.cancelReason) ? 86400_000 : 7 * 86400_000)) {
          s.feeFinal = 'UNSETTLED_UNREACHABLE'; if (!s.cancelReason) st.stats.refunded += 1;
          return ok(s, 'done', '平台订单一直查不到，本金早已收回，已结案（手续费金额很小，可到 agent.family 查看）');
        }
        throw e;
      }
      s.orderStatus = o.status;
      if (o.status === 'DELIVERED' && s.shortfall) { if (!s.shortNotified) { s.shortNotified = true; await notify(`订单 ${s.orderId} 本金短少，未放款，请在挑战期内到 agent.family 提出争议`); } s.nextFeeCheck = now + 3600_000; return; }
      if (o.status === 'DELIVERED') {
        if ((s.acceptPrompts || 0) >= 3) { s.nextFeeCheck = now + 3600_000; return; } // 已请 3 次：不再送，只查状态（平台到期会自动放款）
        const it = await api('POST', `/api/v1/orders/${s.orderId}/accept/prepare`, {});
        assertEscrowIntent(it, '确认放款');
        const r = await sendIntent(it, '确认放款');
        if (r.app) { s.acceptPrompts = (s.acceptPrompts || 0) + 1; s.appWaitUntil = now + 15 * 60_000; s.appWhat = 'release'; if (s.acceptPrompts >= 3) slotLog(s, '放款已请你在 App 确认 3 次，之后不再送（平台到期也会自动放款）'); s.nextFeeCheck = now + 15 * 60_000; await notify('请在币安 App 确认放款（积分要放款后才入账）', { tag: s.id + ':release' }); return; }
        slotLog(s, '已确认放款，积分约 10 分钟入账'); return;
      }
      if (OK_DONE.has(o.status)) {
        s.feeFinal = o.status;
        if (!s.cancelReason && !s.shortfall) { st.stats.rounds += 1; st.stats.tpEst += Math.floor(Number(s.alloc)) * 100; }
        return ok(s, 'done', s.cancelReason ? '手续费已结算（本轮提前结束，可能没有积分）' : `✅ 本轮完成，预估 +${Math.floor(Number(s.alloc)) * 100} TP`);
      }
      if (REFUND_DONE.has(o.status)) { s.feeFinal = o.status; st.stats.refunded += 1; return ok(s, 'done', '手续费已退回（本轮没有积分）'); }
      if (o.status === 'PENDING_ACCEPT') {
        if ((s.cancelPrompts || 0) >= 3) { s.feeFinal = 'CANCEL_UNCONFIRMED'; st.stats.refunded += 1; return ok(s, 'done', '取消订单在 App 连续 3 次没确认，手续费可能不退（金额很小）'); }
        const it = await api('POST', `/api/v1/orders/${s.orderId}/cancel-pending/prepare`, {});
        assertEscrowIntent(it, '取消订单'); const r = await sendIntent(it, '取消订单');
        if (r.app) { s.cancelPrompts = (s.cancelPrompts || 0) + 1; s.appWaitUntil = now + 15 * 60_000; s.appWhat = 'cancel'; await notify('请在币安 App 确认「取消订单」，手续费才会退回', { tag: s.id }); s.nextFeeCheck = now + 15 * 60_000; }
        return;
      }
      if (o.status === 'IN_DISPUTE') { if (!s.disputeNotified) { s.disputeNotified = true; await notify(`订单 ${s.orderId} 进入争议，请到 agent.family 查看`); } s.nextFeeCheck = now + 3600_000; return; }
      // 本金早已收回、只剩平台订单没结案：超过期限太久就结案进历史（不再占着「进行中」）
      if (s.principalSwept && s.endsAt && ((s.shortfall || s.cancelReason) ? now > s.endsAt + 86400_000 : now > s.endsAt + 7 * 86400_000) && !['DELIVERED', 'IN_DISPUTE'].includes(o.status)) {
        s.feeFinal = 'UNSETTLED_' + o.status; if (!s.cancelReason) st.stats.refunded += 1;
        return ok(s, 'done', `平台订单一直停在 ${o.status}，本金早已收回，已结案（手续费金额很小，可到 agent.family 查看）`);
      }
      const due = Date.parse(o.deadlines?.deliveryDueAt || o.deliveryDueAt || 0);
      if (['FUNDED', 'IN_PROGRESS'].includes(o.status) && due && now > due + 60_000) {
        if ((s.expirePrompts || 0) >= 3) { s.nextFeeCheck = now + 6 * 3600_000; return; }
        const it = await api('POST', `/api/v1/orders/${s.orderId}/cancel-expired/prepare`, {});
        assertEscrowIntent(it, '逾期退费'); const r = await sendIntent(it, '逾期退费');
        if (r.app) { s.expirePrompts = (s.expirePrompts || 0) + 1; s.appWaitUntil = now + 15 * 60_000; s.appWhat = 'refund'; s.nextFeeCheck = now + 15 * 60_000; await notify('请在币安 App 确认「逾期退费」，手续费才会退回', { tag: s.id }); return; }
        slotLog(s, '策略方逾期未交付，已申请退费'); s.nextFeeCheck = now + 10 * 60_000; return;
      }
      if (s.endsAt && now > s.endsAt + 4 * 86400_000) { s.nextFeeCheck = now + 3600_000; }
      return;
    }
    default: return;
  }
}
// 授权之后被迫中止的单：同一策略冷却、连续中止就停止开新单（避免反复付授权登记费）
async function abortSlot(s, reason) {
  s.cancelReason = reason;
  await revoke(s);
  st.abortStreak = (st.abortStreak || 0) + 1;
  if (s.strategyId) cooldown[s.strategyId] = Date.now() + 2 * 3600_000 * 2 ** Math.min(st.abortStreak - 1, 4);
  if (st.abortStreak >= 2 && st.running) { st.running = false; await notify(`连续 ${st.abortStreak} 轮在中途被迫取消（最近一次：${reason}），已停止开新单，避免一直付授权费。确认原因后再按「开始」。`); }
  save();
}
async function topUpGas(s, forRevoke = false) {
  // 任务钱包没 gas 了：从你的币安钱包补 0.001 BNB 到「这个任务钱包」（地址是工具自己产生的）；每笔最多补 3 次
  const now = Date.now();
  if (s.gasTopAt && now - s.gasTopAt < 10 * 60_000) return;
  if ((s.gasTops || 0) + (s.revokeTops || 0) >= 3) { if (!s.gasNotified) { s.gasNotified = true; await notify(`任务钱包 ${s.address} 已补 3 次 gas，不再补；本金之后会再尝试收回，若一直失败请按「反馈问题」`); } return; }
  if (!forRevoke && (s.gasTops || 0) >= 3) { if (!s.gasNotified) { s.gasNotified = true; await notify(`任务钱包 ${s.address} 补了 3 次 gas 仍无法收回，已停止补，请联系作者`); } return; }
  if (forRevoke && (s.revokeTops || 0) >= 2) return;
  s.gasTopAt = now; if (forRevoke) s.revokeTops = (s.revokeTops || 0) + 1; else s.gasTops = (s.gasTops || 0) + 1; save();
  const t = await run('aacp-tx.mjs', ['--intents', JSON.stringify([{ action: 'sweep-gas', to: s.address, value: String(10n ** 15n), data: '0x' }]), '--yes'], { timeoutMs: 180_000 });
  slotLog(s, t.code === 0 ? '已补 0.001 BNB gas，稍后再收回' : '补 gas 失败：' + lastLine(t.all));
}
async function revoke(s) {
  if (!s.jobId || s.revoked) return;
  try { await api('POST', `/api/v1/quant/jobs/${s.jobId}/revoke`, {}); s.revoked = true; slotLog(s, '已撤销策略方授权'); } catch (e) { slotLog(s, '撤销授权失败（收回本金后授权也无钱可动）：' + e.message); }
}

// ── 主循环 ──────────────────────────────────────────────────────────────────
let busy = false, lastNewSlot = 0, exiting = false, apiBusy = 0;
const PRE = ['allocate', 'register', 'fund', 'create', 'deliver', 'checkout', 'pay'];
async function tick() {
  if (busy || exiting) return; busy = true;
  try {
    reloadSettings();
    await refreshEnv();
    await refreshBalances();
    if (OWNER && ownerKnown()) walletLock();
    const canAct = ready();
    if (st.recallRequested) { await recallAll(); st.recallRequested = false; save(); }
    for (const s of st.slots) {
      if (s.step === 'done' || s.step === 'paused') continue;
      if (otherInstance && ['allocate', 'register', 'fund', 'create', 'deliver', 'checkout'].includes(s.step)) {
        // 另一份工具在操作这个钱包：准备阶段的单不再继续（避免两份各转一次本金），已转入的直接收回
        if (!s.address) { s.step = 'done'; s.principalSwept = true; s.cancelReason = '另一份工具在运行，已取消'; } else { s.cancelReason = '另一份工具在运行，已取消并收回'; s.force = true; await revoke(s); s.step = 'sweep'; }
        save(); continue;
      }
      // 收回/结算在停止时也继续（保护资金）；收回本金只要知道你的钱包地址即可，不需要登入
      if (ownerConflict) break;
      if (s.nextTryAt && Date.now() < s.nextTryAt) continue;
      // 钱包断线／登录失效时，到期收回本金照样进行（收回用任务钱包自己的密钥，不需要币安或 TermiX 登录）
      if (!canAct && s.step === 'wait_accept' && Date.now() - (s.orderedAt || Date.now()) > TD(s) * 86400_000 + 30 * 60_000) { s.cancelReason = '长时间离线，没确认到接单'; s.force = true; s.step = 'sweep'; slotLog(s, '离线太久，直接收回本金'); }
      if (!canAct && !((s.step === 'sweep' || s.step === 'active') && OWNER && ownerKnown())) continue;
      try { await stepSlot(s); } catch (e) { if (e.auth || /TermiX 登录过期/.test(e?.message || '')) { await run('a2a-runtime.mjs', ['login'], { timeoutMs: 120_000 }).catch(() => {}); await refreshEnv(true); } fail(s, e); }
      save();
    }
    // 完成的移到历史
    const fin = st.slots.filter((s) => s.step === 'done');
    if (fin.length) { st.history = [...fin.map((s) => ({ ...s, log: (s.log || []).slice(-4) })), ...st.history].slice(0, 200); st.slots = st.slots.filter((s) => s.step !== 'done'); save(); }
    if (!ownerConflict && OWNER && !otherInstance) await rescanWallets(); // 被另一份工具接管时：只收完自己的单，不复查、不开新单
    if (st.running && canAct && !ownerConflict && !otherInstance) await maybeNewSlot();
  } catch (e) { log('主循环错误：' + e.message, 'error'); }
  finally { busy = false; }
}
// 本次按「开始」后，成功完成（有放款、本金完整）的轮数；中途取消的不算
function doneRounds(planId) {
  const since = st.runStartedAt || 0;
  const mine = (x) => planId === undefined || x.planId === planId;
  const settled = st.history.filter((h) => mine(h) && (h.createdAt || 0) >= since && OK_DONE.has(h.feeFinal) && !h.cancelReason && !h.shortfall).length;
  const settling = st.slots.filter((x) => mine(x) && (x.createdAt || 0) >= since && ['fee', 'feerecover'].includes(x.step) && !x.cancelReason && !x.shortfall).length; // 本金已收回、正在结算的也算
  return settled + settling;
}
const planOn = () => Array.isArray(settings.plan) && settings.plan.length > 0;
async function maybeNewSlot() {
  if (Date.now() - lastNewSlot < 60_000) return;
  if (planOn()) return maybeNewPlanSlot();
  const maxR = Math.min(150, Math.floor(Number(settings.maxRounds) || 0));
  if (maxR > 0 && doneRounds() >= maxR) {
    if (!st.slots.some((x) => !x.principalSwept && x.step !== 'paused')) { st.running = false; save(); log(`已跑完设置的 ${maxR} 轮，自动停止开新单`); await notify(`已跑完设置的 ${maxR} 轮，自动停止。要继续请在控制页面按「开始」。`); }
    return;
  }
  if (maxR > 0 && st.slots.some((s) => s.step !== 'paused')) return; // 设了轮数：上一轮完全结算后才开下一轮，绝不超跑
  if (st.slots.some((s) => PRE.includes(s.step))) return; // 一次只准备一笔，避免并发动钱
  const live = st.slots.filter((s) => !s.principalSwept && s.step !== 'paused');
  if (live.length >= 1) return; // 一次只跑一笔：最单纯、最好查
  if (st.slots.some((s) => s.step === 'paused')) return; // 有暂停的单先处理
  const dm = env0.devMode;
  if (dm?.expiresAt && Date.parse(dm.expiresAt) - Date.now() < 7 * 3600_000) { lastPickNote = '开发者模式 7 小时内会到期，先不开新单：请到币安 App 延长开发者模式'; return; }
  const [ou, ob] = await Promise.all([bal(A.USDC, OWNER), bnb(OWNER)]);
  if (ob < parseUnits(GAS_BNB, 18) + parseUnits(KEEP_BNB, 18)) { lastPickNote = `币安钱包 BNB 不足，至少要 ${Number(GAS_BNB) + Number(KEEP_BNB)} BNB 才会开新单`; return; }
  let avail = Math.floor(U(ou) - FEE_RESERVE_USDC);
  avail = Math.min(avail, Math.min(1000, Math.max(10, Math.floor(Number(settings.maxPerRoundU) || 20)))); // 一定有上限，不会默认把整个钱包存进去
  let quotaLow = false;
  if (dm?.dailyLimit && dm.quotaUsed != null) { const q = Math.floor(Number(dm.dailyLimit) - Number(dm.quotaUsed)); if (q < avail) { avail = q; quotaLow = true; } }
  if (avail < 10) { lastPickNote = quotaLow ? '开发者模式今天的额度剩不到 10U，明天会自动继续（也可到币安 App 调高每日额度）' : '币安钱包可用 USDC 不足 10'; return; }
  const cands = await pickStrategies();
  const c = cands.find((x) => Math.min(x.avail, avail) >= Math.max(10, Number(x.s.minAllocationU) || 10));
  if (!c) { lastPickNote = '目前没有已上架且有空位的策略（策略要先通过官方审核），会自动再找'; return; }
  lastPickNote = '';
  const alloc = Math.min(c.avail, avail);
  lastNewSlot = Date.now();
  const s = { id: randomBytes(3).toString('hex'), createdAt: Date.now(), strategyId: c.s.id, strategyName: c.s.name, provider: c.s.agentHandle, label: c.c.label, feeBps: c.s.mgmtFeeBps, venueAllow: c.s.venueAllowlist, alloc, step: 'allocate', log: [] };
  slotLog(s, `新一轮：${alloc} U → ${c.s.name}（${c.c.label}）`);
  st.slots.push(s); save();
}

// 「存款计划」：每一列（策略＋期限＋金额）各自一轮接一轮；准备阶段一次只做一笔（App 确认不会同时跳好几个）
let deadPlanIds = new Set();
const feeCap = (alloc, bps, td) => (Number(alloc) * Math.min(Number(bps) || 300, 300) / 1e4 * Number(td)) / 365 * 1.02 + 0.001; // 这单手续费上限（USDC）
async function maybeNewPlanSlot() {
  const maxR = Math.min(150, Math.floor(Number(settings.maxRounds) || 0));
  const rows = settings.plan.slice(0, MAX_PLAN);
  let list;
  try { list = await eligibleStrategies(true); } catch { lastPickNote = '暂时读不到策略清单，稍后自动再试'; return; }
  const dead = (r) => { const sd = list.find((x) => x.id === r.strategyId); return !sd || !sd.terms.includes(Number(r.termDays)); }; // 下架或不再提供这个期限：当作这列已结束
  deadPlanIds = new Set(rows.filter(dead).map((r) => r.id));
  const rowDone = (r) => dead(r) || (maxR > 0 && doneRounds(r.id) >= maxR);
  if (rows.every(rowDone)) {
    if (!st.slots.some((x) => !x.principalSwept && x.step !== 'paused')) { st.running = false; save(); log('存款计划的每一项都已结束（跑满轮数或策略下架），自动停止开新单'); await notify('存款计划的每一项都已结束（跑满设置轮数，或策略已下架），自动停止。要继续请在控制页面按「开始」。'); }
    if (rows.some(dead)) lastPickNote = '存款计划里有策略已下架或不再提供你选的期限，请到设置里重新选择';
    return;
  }
  if (st.slots.some((s) => PRE.includes(s.step))) return; // 一次只准备一笔
  if (st.slots.some((s) => s.step === 'paused')) return; // 有暂停的单先处理
  const dm = env0.devMode;
  const devLeft = dm?.expiresAt ? Date.parse(dm.expiresAt) - Date.now() : Infinity;
  if (devLeft < 7 * 3600_000) { lastPickNote = '开发者模式 7 小时内会到期，先不开新单：请到币安 App 延长开发者模式'; return; }
  // 这个策略已经有单在跑（不论是哪一列开的）就不再开，避免同一策略重复存入
  const busy = (r) => st.slots.some((x) => x.step !== 'done' && (x.planId === r.id || x.strategyId === r.strategyId) && (maxR > 0 || !x.principalSwept));
  const todo = rows.filter((r) => !rowDone(r) && !busy(r));
  const notes = rows.filter(dead).map((r) => `「${r.name || r.strategyId}」已下架或不再提供你选的期限，跳过`);
  if (!todo.length) { lastPickNote = notes.join('；'); return; }
  const [ou, ob] = await Promise.all([bal(A.USDC, OWNER), bnb(OWNER)]);
  if (ob < parseUnits(GAS_BNB, 18) + parseUnits(KEEP_BNB, 18)) { lastPickNote = `币安钱包 BNB 不足，至少要 ${Number(GAS_BNB) + Number(KEEP_BNB)} BNB 才会开新单`; return; }
  let avail = U(ou) - FEE_RESERVE_USDC;
  if (dm?.dailyLimit && dm.quotaUsed != null) avail = Math.min(avail, Math.floor(Number(dm.dailyLimit) - Number(dm.quotaUsed)));
  for (const r of todo) {
    const sd = list.find((x) => x.id === r.strategyId);
    if (sd.cooldown) { notes.push(`「${sd.name}」刚中途取消过，稍后再试`); continue; }
    if (devLeft < Number(r.termDays) * 86400_000 + 2 * 3600_000) { notes.push(`「${sd.name}」选了 ${termText(r.termDays)}，但开发者模式会先到期，请到币安 App 延长后再存`); continue; }
    const want = Math.min(1000, Math.floor(Number(r.amount) || 0));
    const alloc = Math.min(want, sd.avail);
    if (alloc < sd.min) { notes.push(`「${sd.name}」空位不足（剩 ${sd.avail}U），有空位会自动存`); continue; }
    const fee = feeCap(alloc, sd.feeBps, r.termDays);
    if (alloc + fee > avail) { notes.push(`币安钱包 USDC 不够存「${sd.name}」（需要 ${Math.ceil((alloc + fee) * 100) / 100}U，可用 ${Math.max(0, Math.floor(avail * 100) / 100)}U）`); continue; }
    lastPickNote = notes.join('；');
    lastNewSlot = Date.now();
    const raw = (await allStrategies()).items.find((x) => x.id === sd.id) || {};
    const s = { id: randomBytes(3).toString('hex'), planId: r.id, termDays: Number(r.termDays), createdAt: Date.now(), strategyId: sd.id, strategyName: sd.name, provider: raw.agentHandle, label: sd.kind, feeBps: sd.feeBps, venueAllow: raw.venueAllowlist, alloc, step: 'allocate', log: [] };
    slotLog(s, `新一轮（计划）：${alloc} U → ${sd.name}（${sd.kind}，${termText(r.termDays)}）`);
    st.slots.push(s); save();
    return;
  }
  lastPickNote = notes.join('；');
}
const termText = (d) => { d = Number(d); return d < 1 ? Math.round(d * 24) + ' 小时' : d + ' 天'; };

// 定期复查所有用过的任务钱包：若有晚到账的钱，自动收回（不会有钱被遗忘）
let lastRescan = 0;
async function rescanWallets() {
  if (Date.now() - lastRescan < 60 * 60_000) return;
  lastRescan = Date.now();
  if (!seedSafe(true).ok) return; // 密钥不属于目前的钱包时，不扫也不收
  st.wallets ||= [];
  for (const s of st.slots) if (s.address && !st.wallets.some((w) => w.address === s.address)) st.wallets.push({ index: s.index, address: s.address });
  // 本机记录遗失也找得回来：向平台取回本账号登记过的所有任务钱包，只收「本机密钥推得出来」的
  try {
    const sf = seedSafe(true);
    if (sf.ok && env0.login) {
      const lst = await api('GET', '/api/v1/quant/trading-wallets?chainId=56');
      const seedHex = readFileSync(join(SEED_DIR, 'task-wallet-seed.hex'), 'utf8').trim();
      const { deriveTaskWalletAddress } = await import(pathToFileURL(join(SK, 'quant-task-wallet.mjs')).href);
      for (const it of lst?.items || []) {
        const addr = String(it.address || '');
        if (!/^0x[0-9a-fA-F]{40}$/.test(addr) || st.wallets.some((w) => w.address.toLowerCase() === addr.toLowerCase())) continue;
        const mine = await deriveTaskWalletAddress(Buffer.from(seedHex, 'hex'), Number(it.derivationIndex));
        if (String(mine).toLowerCase() === addr.toLowerCase()) st.wallets.push({ index: Number(it.derivationIndex), address: getAddress(addr) });
      }
    }
  } catch (e) { log('向平台核对任务钱包清单失败（下次再试）：' + e.message, 'warn'); }
  const busyAddr = new Set(st.slots.filter((s) => !s.principalSwept).map((s) => s.address));
  // 平台上还有效的委托单不当成遗留资金（可能是同一钱包在别处的正常单）
  try {
    const lst = await api('GET', '/api/v1/quant/jobs');
    for (const j of (Array.isArray(lst) ? lst : lst?.items ?? lst?.jobs ?? [])) {
      const a = String(j.tradingWalletAddress || '');
      const live = !['REVOKED', 'CANCELLED', 'COMPLETED', 'SETTLED', 'EXPIRED'].includes(j.status) && !(Date.parse(j.endsAt) + SWEEP_AFTER_END_MS < Date.now());
      if (live && /^0x[0-9a-fA-F]{40}$/.test(a)) busyAddr.add(getAddress(a));
    }
  } catch { log('读不到平台委托单清单，这次只依本机记录复查', 'warn'); }
  for (const w of st.wallets) {
    if (busyAddr.has(w.address)) continue;
    try {
      const [u, v1, v2] = await Promise.all([bal(A.USDC, w.address), bal(A.VUSDC, w.address), bal(A.VBTC, w.address)]);
      if (u >= 10n ** 16n || v1 > 10n ** 6n || v2 > 10n ** 4n) { // 忽略别人打进来的零头，避免白烧 gas
        const s = { id: randomBytes(3).toString('hex'), createdAt: Date.now(), alloc: 0, index: w.index, address: w.address, strategyName: '补收遗留资金', step: 'sweep', force: true, cancelReason: '补收遗留资金', log: [] };
        slotLog(s, `发现任务钱包 ${w.address} 还有 ${U(u)} USDC，自动收回`);
        st.slots.push(s);
      }
    } catch { /* 下次再查 */ }
  }
  save();
}

function publicNote() { return otherInstance ? `这个币安钱包已经由另一份工具在运行（${otherInstance}），这份不会开新单，只把自己进行中的单收完。请只保留一份：关闭其中一份，并删掉多余的桌面图标` : ownerConflict ? '钱包地址与记录不符，已封锁所有动作' : (!ready() && st.slots.some((x) => !x.principalSwept && x.address)) ? `钱包连接或 TermiX 登录失效：任务钱包里的 ${st.slots.filter((x) => !x.principalSwept && x.address).reduce((a, x) => a + Number(x.alloc || 0), 0)} U 到期仍会自动收回；请到「首次设置」重新连接，才能完成积分结算` : /onedrive|google drive|dropbox|icloud/i.test(ROOT) ? '⚠️ 工具放在会自动同步到云盘的文件夹，密钥可能被上传。请把整个工具文件夹移到 C:\\TermiX 之类的位置' : lastPickNote; }
// ── 反馈问题（使用者亲自按才送；送之前先给使用者看内容）──────────────────
const reEsc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mask(x) {
  let t = scrub(String(x ?? ''));
  for (const [p, r] of [[ROOT, '<工具文件夹>'], [HOME, '~']]) if (p) { t = t.replace(new RegExp(reEsc(p), 'gi'), r).replace(new RegExp(reEsc(p.replace(/\\/g, '/')), 'gi'), r); }
  return t
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,50}\b/g, 'BOT…')
    .replace(/\b[0-9a-fA-F]{64}\b/g, '…')
    .replace(/0x([0-9a-fA-F]{4})[0-9a-fA-F]{32}([0-9a-fA-F]{4})\b/g, '0x$1…$2')
    .replace(/(file:\/{2,3})?[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'）)]+/gi, '~')
    .replace(/[A-Za-z]:[\\/]+(Documents and Settings)[\\/]+[^\\/\s"']+/gi, '~');
}
const cap = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t);
function buildReport(note = '', lang = '') {
  const e = env0;
  return {
    app: 'TermiX-AutoDeposit', version: VERSION, os: `${process.platform} ${osRelease()} · Node ${process.versions.node}`, lang: String(lang).slice(0, 8), mode: BAW_MODE,
    note: cap(mask(String(note || '')), 500),
    status: cap(mask(`钱包=${e.wallet} 开发者模式=${e.devMode?.enabled ? '开' : '关'} 登录=${e.login ? '是' : '否'} 条款=${e.terms?.status || '-'} 代理=${e.agentId ? '有' : '无'} 就绪=${ready() ? '是' : '否'} 运行=${st.running ? '是' : '否'} 密钥=${seedSafe().ok ? '正常' : seedSafe().why} 另一份=${otherInstance ? '有' : '无'} BNB=${e.balances?.bnb ?? '-'} USDC=${e.balances?.usdc ?? '-'}`), 600),
    screen: cap(mask(publicNote()), 400),
    slots: st.slots.slice(0, 5).map((x) => cap(mask(`${STEP_CN[x.step] || x.step}${x.pausedFrom ? '（从' + (STEP_CN[x.pausedFrom] || x.pausedFrom) + '）' : ''} ${x.alloc}U 错误${x.errCount || 0}次 ${x.lastErr || ''}`), 280)),
    logs: logs.slice(-25).map((l) => cap(mask(`${new Date(l.t).toISOString().slice(5, 19)} ${l.msg}`), 200)),
  };
}
const reportTimes = [];

// 紧急：全部收回
async function recallAll() {
  st.running = false; save();
  log('⛔ 使用者按下「全部收回」', 'warn');
  for (const s of st.slots) {
    if (s.principalSwept || s.step === 'done') continue;
    try {
      if (['allocate', 'register'].includes(s.step) && !s.address) { s.step = 'done'; s.principalSwept = true; s.cancelReason = '使用者收回'; continue; }
      if (s.orderId && (s.orderStatus === 'PENDING_ACCEPT' || s.step === 'wait_accept') && (s.cancelPrompts || 0) < 3) {
        try { const it = await api('POST', `/api/v1/orders/${s.orderId}/cancel-pending/prepare`, {}); assertEscrowIntent(it, '取消订单'); const r = await sendIntent(it, '取消订单'); if (r.app) s.cancelPrompts = (s.cancelPrompts || 0) + 1; s.appWaitUntil = now + 15 * 60_000; s.appWhat = 'cancel'; } catch (e) { slotLog(s, '取消订单：' + e.message); }
      }
      await revoke(s);
      s.cancelReason ||= '使用者收回'; s.force = true; if (s.step === 'paused') s.errCount = 0;
      s.step = 'sweep'; s.nextTryAt = 0; save();
    } catch (e) { fail(s, e); }
  }
  save();
}

// ── 本机控制页面 ────────────────────────────────────────────────────────────
// 访问码重启后沿用（控制页面不用重新打开）；只存在本机 data 文件夹
const TOKEN = (() => { try { const t = readFileSync(join(DATA, '.ui-token'), 'utf8').trim(); if (/^[0-9a-f]{48}$/.test(t)) return t; } catch { /* ignore */ } return randomBytes(24).toString('hex'); })();
try { copyFileSync(join(DATA, '.ui-token'), join(DATA, '.ui-token.prev')); } catch { /* first run */ }
const UI = readFileSync(join(HERE, 'ui.html'), 'utf8');
const UIV = createHash('sha256').update(UI).digest('hex').slice(0, 12); // 介面版本：引擎换版后，开着的窗口会自动重新加载
const tokOk = (t) => { try { const a = Buffer.from(String(t || '')); const b = Buffer.from(TOKEN); return a.length === b.length && timingSafeEqual(a, b); } catch { return false; } };
let pairing = null;
function publicState() {
  return {
    version: VERSION, uiv: UIV, running: st.running, ready: ready(), owner: OWNER,
    env: { checked: !!env0.checked && (!st.setupDone || Date.now() - BOOT_AT > 90_000), baw: env0.baw, wallet: env0.wallet, devMode: env0.devMode, login: env0.login, terms: env0.terms ? { status: env0.terms.status, version: env0.terms.termsVersion, url: env0.terms.termsUrl, notice: (Array.isArray(env0.terms.notice) ? env0.terms.notice : [env0.terms.notice].filter(Boolean)).map((x) => typeof x === 'string' ? x : [x?.title, x?.body || x?.text].filter(Boolean).join('\n')).join('\n\n').slice(0, 8000) } : null, agent: !!env0.agentId, heldAgent: env0.heldAgent || '', balances: env0.balances },
    pairing, runDone: planOn() ? (() => { const live = settings.plan.filter((r) => !deadPlanIds.has(r.id)); return live.length ? Math.min(...live.map((r) => doneRounds(r.id))) : 0; })() : doneRounds(), settings: { ...settings, tgToken: '', tgTokenSet: !!settings.tgToken },
    slots: st.slots.map((s) => ({ id: s.id, funded: !!(s.fundedOk || (s.address && !['allocate', 'register', 'fund'].includes(s.pausedFrom || s.step))), planId: s.planId || null, termDays: TD(s), step: s.step, stepCn: STEP_CN[s.step], pausedFrom: s.pausedFrom, appWait: s.appWaitUntil && Date.now() < s.appWaitUntil && (['fund', 'pay'].includes(s.step) || ['release', 'cancel', 'refund'].includes(s.appWhat)) && !['done', 'sweep'].includes(s.step) ? { until: s.appWaitUntil, what: s.appWhat || '' } : null, alloc: s.alloc, strategyName: s.strategyName, provider: s.provider, label: s.label, endsAt: s.endsAt, address: s.address, orderStatus: s.orderStatus, lastErr: s.lastErr, cancelReason: s.cancelReason, principalSwept: !!s.principalSwept, log: (s.log || []).slice(-6) })),
    history: st.history.slice(0, 30).map((s) => ({ id: s.id, alloc: s.alloc, strategyName: s.strategyName, feeFinal: s.feeFinal, ok: OK_DONE.has(s.feeFinal) && !s.cancelReason && !s.shortfall, cancelReason: s.shortfall ? '本金短少，未放款' : s.cancelReason, endsAt: s.endsAt, createdAt: s.createdAt })),
    update: updater.status(), stats: st.stats, rewards: rewards.v, defaultInvite: DEFAULT_INVITE, logs: logs.slice(-80), seed: seedSafe(), backupDir: BACKUP2, note: publicNote(),
  };
}
async function body(rq) { let d = ''; for await (const c of rq) { d += c; if (d.length > 1e5) throw new Error('too big'); } return d ? JSON.parse(d) : {}; }
const server = http.createServer(async (rq, rs) => {
  const host = String(rq.headers.host || '');
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) { rs.writeHead(403); return rs.end(); } // 防 DNS rebinding
  const url = new URL(rq.url, `http://${host}`);
  const send = (code, obj, type = 'application/json') => { rs.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" }); rs.end(type === 'application/json' ? JSON.stringify(obj) : obj); };
  try {
    if (rq.method === 'GET' && url.pathname === '/') return send(200, UI, 'text/html; charset=utf-8');
    if (!url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });
    if (!tokOk(rq.headers['x-anchor-token'])) return send(401, { error: '访问码错误，请从启动程序开的网址进入' });
    if (rq.method === 'GET' && url.pathname === '/api/state') return send(200, publicState());
    if (rq.method !== 'POST') return send(405, { error: '不支持的请求' });
    if ((rq.headers['content-type'] || '').split(';')[0] !== 'application/json') return send(415, { error: '不支持的请求' });
    const b = await body(rq);
    const txPath = ['/api/connect', '/api/accept-terms', '/api/create-agent'].includes(url.pathname);
    if (txPath && exiting) return send(503, { error: '工具正在关闭' });
    if (txPath) apiBusy++;
    try {
    switch (url.pathname) {
      case '/api/start': if (otherInstance) return send(400, { error: '这个币安钱包已经由另一份工具在运行，这份不能开始' }); if (!ready()) return send(400, { error: '还没完成设置' }); st.running = true; st.noAccept = 0; st.abortStreak = 0; st.runStartedAt = Date.now(); save(); log('▶ 开始自动存款'); tick(); return send(200, { ok: true });
      case '/api/stop': st.running = false; save(); log('⏸ 停止开新单（进行中的单会跑完并自动收回）'); return send(200, { ok: true });
      case '/api/logs': { // 给用户和用户自己的 AI 排查问题用（只在本机读取，不会上传）
        const n = Math.max(1, Math.min(1000, Math.floor(Number(b.n) || 200))), onlyErr = !!b.errors;
        let lines = [];
        try { const buf = readFileSync(F.log); lines = buf.subarray(Math.max(0, buf.length - 2_000_000)).toString('utf8').split(/\r?\n/).filter(Boolean); } catch { /* 还没有记录 */ }
        if (onlyErr) lines = lines.filter((l) => /\[(WARN|ERROR)\]|失败|错误|暂停|异常|error|failed/i.test(l));
        return send(200, { ok: true, file: F.log, lines: lines.slice(-n) });
      }
      case '/api/update-check': return send(200, { ok: true, update: await updateCheck() });
      case '/api/update-apply': { const u = updater.status(); if (!u.available) return send(400, { error: u.error || '目前已经是最新版本' }); updateWhenIdle(`使用者要求更新到 v${u.latest}`); return send(200, { ok: true, note: '正在下载并安装新版本，完成后工具会自动重新启动（约 30 秒），页面会自动刷新' }); }
      case '/api/restart': exitWhenIdle(10, '重新启动工具'); return send(200, { ok: true, note: '工具正在重新启动，约 15 秒后刷新页面' });
      case '/api/quit': if (b.confirm !== 'QUIT') return send(400, { error: '需要确认' }); st.running = false; save(); exitWhenIdle(0, '关闭工具（已停止开新单；进行中的存款下次开启时会继续收回）'); return send(200, { ok: true, note: '工具已关闭。要再开启，点桌面上的「TermiX AutoDeposit」' });
      case '/api/recall': if (b.confirm !== 'RECALL') return send(400, { error: '需要确认' }); st.running = false; st.recallRequested = true; save(); tick(); return send(200, { ok: true, note: '已开始收回，几分钟内完成，进度看「进行中」' });
      case '/api/retry': { if (busy) return send(409, { error: '正在处理中，几秒后再按' }); const s = st.slots.find((x) => x.id === b.id && x.step === 'paused'); if (!s) return send(404, { error: '找不到这一笔' }); s.step = s.pausedFrom || 'sweep'; s.errCount = 0; save(); tick(); return send(200, { ok: true }); }
      case '/api/settings': {
        const n = {};
        if (b.plan !== undefined) {
          if (!Array.isArray(b.plan)) return send(400, { error: '存款计划格式不对' });
          if (b.plan.length > MAX_PLAN) return send(400, { error: `最多 ${MAX_PLAN} 个策略` });
          const list = b.plan.length ? await eligibleStrategies(true).catch(() => null) : [];
          if (!list) return send(400, { error: '暂时读不到策略清单，请稍后再保存' });
          const seen = new Set(), out = [];
          for (const r of b.plan) {
            const sd = list.find((x) => x.id === String(r?.strategyId || ''));
            if (!sd) return send(400, { error: `「${String(r?.name || r?.strategyId || '').slice(0, 80)}」已下架或不符合安全条件，请删掉或重新选择` });
            if (seen.has(sd.id)) return send(400, { error: `「${sd.name}」重复了，每个策略只能选一次` });
            seen.add(sd.id);
            const td = Number(r.termDays);
            if (!sd.terms.includes(td)) return send(400, { error: `「${sd.name}」没有这个期限` });
            const amt = Math.floor(Number(r.amount) || 0);
            if (!(amt >= sd.min && amt <= 1000)) return send(400, { error: `「${sd.name}」金额要在 ${sd.min}～1000U 之间` });
            const old = (settings.plan || []).find((o) => o.strategyId === sd.id); // 同一策略沿用原本的编号（轮数接着算，不会重复开单）
            out.push({ id: old ? old.id : (String(r.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 12) || randomBytes(3).toString('hex')), strategyId: sd.id, name: sd.name, termDays: td, amount: amt });
          }
          n.plan = out;
        }
        if (b.maxRounds !== undefined) n.maxRounds = Math.max(0, Math.min(150, Math.floor(Number(b.maxRounds) || 0)));
        if (b.autoUpdate !== undefined) n.autoUpdate = !!b.autoUpdate;
        if (b.lang !== undefined && ['zh', 'en', 'ko', 'vi', 'ja'].includes(b.lang)) n.lang = b.lang;
        if (b.maxPerRoundU !== undefined) n.maxPerRoundU = Math.max(10, Math.min(1000, Math.floor(Number(b.maxPerRoundU) || 20)));
        let bad = '';
        if (b.tgToken !== undefined && b.tgToken !== '已设置') { if (b.tgToken === '') n.tgToken = ''; else if (/^\d{5,12}:[A-Za-z0-9_-]{30,50}$/.test(b.tgToken)) n.tgToken = b.tgToken; else bad = 'Bot Token 格式不对，没有保存'; }
        if (b.tgChatId !== undefined) { if (b.tgChatId === '') n.tgChatId = ''; else if (/^-?\d{3,20}$/.test(String(b.tgChatId))) n.tgChatId = String(b.tgChatId); else bad = bad || 'Chat ID 格式不对，没有保存'; }
        settings = { ...settings, ...n }; writeJson(F.settings, settings);
        return bad ? send(400, { error: bad }) : send(200, { ok: true });
      }
      case '/api/invite-bind': {
        const code = String(b.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{6,12}$/.test(code)) return send(400, { error: '邀请码格式不对' });
        if (!env0.login || !OWNER) return send(400, { error: '请先连接钱包并登录 TermiX' });
        await refreshRewards(true);
        if (rewards.v?.inviter) return send(400, { error: '这个钱包已经绑定过邀请人，不能更改' });
        if (rewards.v?.myCode && rewards.v.myCode === code) return send(400, { error: '不能绑定自己的邀请码' });
        try { await api('POST', '/api/v1/me/rewards/invite-code/bind', { code }); } catch (e) { return send(400, { error: '绑定失败：' + e.message }); }
        await refreshRewards(true);
        log(`已绑定邀请码 ${code}`);
        return send(200, { ok: true, note: '邀请码绑定成功' });
      }
      case '/api/tg-test': {
        if (!settings.tgToken || !settings.tgChatId) return send(400, { error: '请先填写并保存 Bot Token 和 Chat ID' });
        try {
          const r = await fetch(`https://api.telegram.org/bot${settings.tgToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: settings.tgChatId, text: `${tgTitle(settings.lang)} ${tgText('[TermiX 自动存款] 测试消息', settings.lang) === '[TermiX 自动存款] 测试消息' ? '测试：收到这则代表 TG 提醒正常' : tgText('[TermiX 自动存款] 测试消息', settings.lang)}` }), signal: AbortSignal.timeout(10_000) });
          if (!r.ok) return send(400, { error: ', settings.lang)}`Telegram 发送失败（请检查 Bot Token、Chat ID，并先对机器人按 Start）' });
        } catch { return send(400, { error: '连不上 Telegram，请检查网络' }); }
        return send(200, { ok: true, note: '已发出测试消息，请到 Telegram 查看' });
      }
      case '/api/strategies': { try { const items = await eligibleStrategies(!!b.fresh); const mine = new Set(env0.myAgents || []); const own = mine.size ? ((await allStrategies()).items || []).filter((s) => mine.has(s.providerAgentId)).length : 0; return send(200, { ok: true, items, ownExcluded: own }); } catch (e) { return send(400, { error: '暂时读不到策略清单，请稍后再试' }); } }
      case '/api/report-preview': return send(200, { ok: true, report: buildReport(b.note, b.lang) });
      case '/api/report': {
        while (reportTimes.length && Date.now() - reportTimes[0] > 3600_000) reportTimes.shift();
        if (reportTimes.length >= 3) return send(429, { error: '一小时内最多反馈 3 次，请稍后再试' });
        try {
          const r = await fetch(REPORT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildReport(b.note, b.lang)), signal: AbortSignal.timeout(15_000) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.ok) return send(400, { error: j.error || '反馈没有发送，请稍后再试' });
        } catch { return send(400, { error: '连不上反馈服务器，请检查网络' }); }
        reportTimes.push(Date.now());
        log('已发送问题反馈给作者');
        return send(200, { ok: true, note: '已发送，作者会收到。谢谢反馈！' });
      }
      case '/api/refresh': {
        // 「刷新状态」：钱包连接、余额、积分、策略清单、更新全部重读，出错在等待中的单也立刻重试一次（等待 App 确认中的不打扰）
        await refreshEnv(true); await refreshRewards(true); await refreshBalances();
        await allStrategies(true).catch(() => {});
        updateCheck().catch(() => {});
        const now = Date.now(); let retried = 0;
        // 只对「重试不会多花钱、也不会多跳 App 确认」的步骤立即重试；授权、付费、取消、结算照原本的等待时间
        const SAFE = new Set(['allocate', 'register', 'create', 'checkout', 'active', 'sweep', 'feerecover']);
        for (const s of st.slots) if (SAFE.has(s.step) && s.nextTryAt > now && !(s.appWaitUntil > now)) { s.nextTryAt = 0; retried++; }
        if (retried) save();
        setTimeout(() => tick().catch(() => {}), 50);
        return send(200, { ok: true, note: retried ? `已刷新，${retried} 笔单立即重新检查` : '已刷新' });
      }
      case '/api/connect': {
        if (pairing?.running) return send(200, { ok: true });
        pairing = { running: true, out: '' };
        const child = spawn(process.execPath, [join(SK, 'aacp-wallet.mjs'), 'connect'], { cwd: DATA, env: env(), windowsHide: true });
        const on = (d) => { pairing.out = scrub((pairing.out + d).slice(-3000)); };
        child.stdout.on('data', on); child.stderr.on('data', on);
        const kill = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 10 * 60_000); // 10 分钟没配对完就结束，可以再按一次
        child.on('error', () => { pairing.running = false; });
        child.on('close', async () => { clearTimeout(kill); pairing.running = false; await refreshEnv(true); setTimeout(() => refreshEnv(true).then(refreshBalances).catch(() => {}), 5000); });
        return send(200, { ok: true });
      }
      case '/api/accept-terms': {
        if (b.agree !== true || !env0.terms?.termsVersion || b.version !== env0.terms.termsVersion) return send(400, { error: '请先阅读并勾选同意' });
        const r = await run('aacp-terms.mjs', ['accept', '--version', env0.terms.termsVersion]);
        await refreshEnv(true); return send(r.code === 0 ? 200 : 400, { ok: r.code === 0, error: lastLine(r.all) });
      }
      case '/api/create-agent': {
        if (env0.agentId) return send(200, { ok: true });
        const ag = (await run('a2a-runtime.mjs', ['agents'])).json;
        const held = (ag?.unactivated || [])[0];
        if (held?.name) {
          await api('POST', '/api/v1/agents/activate', { provider: held.provider || 'binance_agent_id', name: held.name.replace(/\.ai$/, ''), category: 'Finance & Audit', description: 'Personal auto-deposit agent.', tags: ['auto-deposit'] });
        } else {
          const name = 'client-' + randomBytes(3).toString('hex');
          const prep = await api('POST', '/api/v1/agents/prepare', { name, displayName: 'Auto Deposit', category: 'Finance & Audit', description: 'Personal auto-deposit agent.', tags: ['auto-deposit'] });
          const reg = String(prep.contract || '').toLowerCase();
          if (reg !== '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432' && reg !== '0x50ccc2207bf4a148082073af1b64ab40ad38a210') return send(400, { error: '代理登记合约不是官方地址，已拒绝' });
          if (!/^0x[0-9a-f]{8}/i.test(String(prep.callData || '')) || /^0x(095ea7b3|a9059cbb|23b872dd|42842e0e|b88d4fde|a22cb465)/i.test(String(prep.callData))) return send(400, { error: '代理登记交易内容异常，已拒绝' });
          const r = await run('aacp-tx.mjs', ['--intent', JSON.stringify({ action: 'registerAgent', contract: prep.contract, callData: prep.callData, value: '0' }), '--yes']);
          if (needsApp(r.all)) return send(200, { ok: true, note: '请在币安 App 按确认，然后按「重新检查」' });
          if (r.code !== 0) return send(400, { error: lastLine(r.all) });
        }
        setTimeout(() => refreshEnv(true), 30_000);
        return send(200, { ok: true, note: '约 30 秒后完成' });
      }
      default: return send(404, { error: '找不到这个功能' });
    }
    } finally { if (txPath) apiBusy--; }
  } catch (e) { return send(500, { error: scrub(e.message) }); }
});
// 等目前这一步做完（不在动钱的中途）才结束程序；10 = 请启动器重新启动，0 = 关闭
const updater = makeUpdater({ root: ROOT, version: VERSION, log: (m) => log(m) });
let updWaiting = false;
// 等目前步骤做完、暂停开新步骤，再换文件并重启；换失败就恢复运行
function updateWhenIdle(why) {
  if (updWaiting || exiting) return false;
  updWaiting = true; log(`${why}（等目前步骤完成再更新）`);
  const t = setInterval(async () => {
    if (busy || apiBusy > 0 || st.recallRequested) return;
    clearInterval(t); exiting = true;
    try { await updater.apply(); save(); process.exit(10); }
    catch (e) { exiting = false; updWaiting = false; log(`更新没有完成：${e.message}（工具照常运行，稍后可再试）`, 'warn'); }
  }, 500);
  return true;
}
async function updateCheck() {
  const u = await updater.check();
  const auto = u.available && (u.critical || settings.autoUpdate !== false);
  if (auto) updateWhenIdle(`发现新版本 v${u.latest}，自动安装`);
  if (u.available && !auto && st.updNotified !== u.latest) { st.updNotified = u.latest; save(); notify(u.critical ? `AutoDeposit 有重要更新 v${u.latest}，工具会在空闲时自动安装。` : `AutoDeposit 有新版本 v${u.latest}。打开工具窗口，点上方「查看更新」即可一键更新（不影响钱包与进行中的单）。`).catch(() => {}); }
  return u;
}
setTimeout(() => updateCheck().catch(() => {}), 20_000).unref();
setInterval(() => updateCheck().catch(() => {}), 5 * 60_000).unref(); // 每 5 分钟看一次官方 GitHub（只读一个约 10KB 的小档案）；必要更新会自动安装
function exitWhenIdle(code, why) {
  log(`${why}（等目前步骤完成）`);
  const t = setInterval(() => {
    // 等主循环、正在送交易的操作、尚未执行的「全部收回」都结束
    if (busy || apiBusy > 0 || st.recallRequested) return;
    clearInterval(t); exiting = true; save(); process.exit(code);
  }, 500);
}
server.on('listening', () => { try { writeFileSync(join(DATA, '.port'), String(PORT)); } catch { /* ignore */ } });
server.listen(PORT, '127.0.0.1', async () => {
  const link = `http://127.0.0.1:${PORT}/#t=${TOKEN}`;
  writeFileSync(join(DATA, '.ui-url'), link); writeFileSync(join(DATA, '.ui-token'), TOKEN); writeFileSync(join(DATA, '.ui-token.prev'), TOKEN);
  log(`TermiX 自动存款 v${VERSION} 已启动`);
  try { const ni = (await import('node:os')).networkInterfaces(); log('网卡：' + Object.entries(ni).map(([n, a]) => n + (a.some((x) => !x.internal && x.family === 'IPv4') ? '(v4)' : '')).join(', ')); } catch { /* ignore */ }
  try { if (process.platform === 'win32' && process.env.ANCHOR_OPEN_UI === '1') openApp(link, DATA); } catch { /* ignore */ }
});
server.on('error', async (e) => {
  if (e.code === 'EACCES') process.exit(4);
  if (e.code !== 'EADDRINUSE') { console.error('无法启动：' + e.message); process.exit(1); }
  // 是不是本工具已在跑？用上次的访问码问问看
  let mine = false;
  try { const old = readFileSync(join(DATA, '.ui-token.prev'), 'utf8').trim(); const r = await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: { 'x-anchor-token': old }, signal: AbortSignal.timeout(3000) }); mine = r.ok; } catch { mine = false; }
  if (mine) process.exit(3);
  try { unlinkSync(join(DATA, '.ui-url')); } catch { /* ignore */ }
  // 被别的程序（或同一台电脑上的另一份本工具）占用 → 换下一个连接埠
  if (!process.env.ANCHOR_PORT && PORT < 17899) { PORT += 1; setTimeout(() => server.listen(PORT, '127.0.0.1'), 100); return; }
  process.exit(4);
});
server.on('listening', () => { refreshEnv(true).then(refreshBalances).then(tick).catch((e) => log('启动检查失败：' + e.message, 'warn')); setInterval(tick, TICK_MS); });
