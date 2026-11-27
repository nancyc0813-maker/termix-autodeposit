#!/usr/bin/env node
// AutoDeposit 命令列：给你自己的 AI（Claude、Grok Bot…）或你自己在终端机用。
// 只能做控制视窗上按钮能做的事；碰不到本金去向（收回目的地固定是你的币安钱包）。
// 用法：node app/cli.mjs <status|start|stop|recall|refresh|connect|invite|report|strategies|plan>（存款计划模式下 start --amount 不起作用，金额以计划为准） [--amount N] [--rounds N] [--code X] [--confirm]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const out = (o, code = 0) => { console.log(JSON.stringify(o, null, 2)); process.exit(code); };
let url = '';
try { url = readFileSync(join(DATA, '.ui-url'), 'utf8').trim(); } catch { /* 没在跑 */ }
const m = url.match(/^(http:\/\/127\.0\.0\.1:\d+)\/#t=([0-9a-f]{48})$/);
if (!m) out({ ok: false, error: '工具没有在运行。请先双击桌面的「TermiX AutoDeposit」（或工具资料夹里的 Start-TermiX.vbs）启动。' }, 1);
const [, BASE, TOKEN] = m;
const args = process.argv.slice(2);
const cmd = args[0] || 'status';
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const has = (k) => args.includes('--' + k);
async function call(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body ? 'POST' : 'GET', headers: { 'x-anchor-token': TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(p === 'refresh' ? 420_000 : 120_000) }).catch((e) => { throw new Error(/abort|timeout/i.test(String(e?.name) + e?.message) ? '工具回应超时，稍后再执行 status 看结果' : '工具没有在运行（或刚关闭）。请先双击桌面的「TermiX AutoDeposit」启动。'); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function summary(S) {
  const e = S.env || {};
  const todo = [];
  if (e.wallet !== 'CONNECTED') todo.push('连接币安 AI 钱包：执行 connect，然后请用户用币安 App 扫码、核对配对码并确认');
  else if (!(e.devMode && e.devMode.enabled)) todo.push('请用户在币安 App → Agentic Wallet 设定里开启「开发者模式」，然后执行 refresh');
  else if (!e.login) todo.push('登录 TermiX 中，稍等后执行 refresh');
  else if (!(e.terms && e.terms.status === 'accepted')) todo.push('请用户本人在控制视窗阅读并同意 TermiX 使用条款（AI 不可代为同意）');
  else if (!e.agent) todo.push(e.heldAgent ? '正在自动启用用户的币安 Agent ID，稍等后执行 refresh' : '请用户在控制视窗按「新建代理身份」（约 0.0002 BNB 手续费）');
  const aw = (S.slots || []).map((s) => s.appWait).find(Boolean);
  if (aw) todo.push('请用户打开币安 App → 钱包 → Agentic Wallet 管理页，在「待确认」找到这笔交易并按确认：' + (aw.what === 'fund' ? '转出 USDC 和少量 BNB 到他自己的任务钱包（地址见 active[].taskWallet；App 若跳「异常收款地址／7702 账户」是因为任务钱包用 EIP-7702 升级成智能账户，地址一致就按「继续交易」）' : aw.what === 'fee-approve' ? '授权 1 USDC 额度给 TermiX 官方托管合约 0x6A52…913C（只能用来付手续费，只要一次）' : aw.what === 'fee-pay' ? '付这一轮的小额手续费给 TermiX 官方托管合约 0x6A52…913C' : '对象是 TermiX 官方托管合约 0x6A52…913C') + '。按完工具会自动继续；最多提醒 3 次，一直没确认这一轮会取消并收回本金。');
  if (S.note) todo.push('工具提示：' + S.note);
  return {
    ok: true, version: S.version, ready: S.ready, running: S.running, wallet: S.owner || null,
    balances: e.balances ? { usdc: e.balances.usdc, bnb: e.balances.bnb } : null,
    settings: { mode: (S.settings?.plan || []).length ? 'plan' : 'auto', plan: S.settings?.plan || [], amountPerRound: S.settings?.maxPerRoundU, stopAfterRounds: S.settings?.maxRounds || 0, roundsDoneThisRun: S.runDone || 0 },
    officialPoints: S.rewards ? S.rewards.total : null, inviter: S.rewards ? (S.rewards.inviter?.code || null) : null,
    active: (S.slots || []).map((s) => ({ amount: s.alloc, strategy: s.strategyName, termDays: s.termDays, step: s.stepCn, taskWallet: s.address || null, endsAt: s.endsAt ? new Date(s.endsAt).toISOString() : null, error: s.lastErr || null })),
    userActionNeeded: todo, note: S.note || null,
  };
}
try {
  switch (cmd) {
    case 'status': out(summary(await call('state')));
    case 'refresh': await call('refresh', {}); out(summary(await call('state')));
    case 'start': {
      const body = {};
      if (opt('amount') !== undefined) body.maxPerRoundU = Number(opt('amount'));
      if (opt('rounds') !== undefined) body.maxRounds = Number(opt('rounds'));
      if (Object.keys(body).length) await call('settings', body);
      await call('start', {}); out(summary(await call('state')));
    }
    case 'stop': await call('stop', {}); out(summary(await call('state')));
    case 'recall':
      if (!has('confirm')) out({ ok: false, error: '「全部收回」会马上中止进行中的单（拿不到这轮积分）。请先跟用户确认，再加 --confirm 执行。' }, 1);
      await call('recall', { confirm: 'RECALL' }); out(summary(await call('state')));
    case 'connect': { await call('connect', {}); await new Promise((r) => setTimeout(r, 8000)); const S = await call('state'); out({ ok: true, pairing: (S.pairing?.out || '').split('\n').filter((l) => /Pairing code|Link/.test(l)).join('\n'), tellUser: '请用币安 App 扫电脑上打开的 QR 码（或在手机打开上面的链接），核对配对码一致后按确认。' }); }
    case 'report': {
      if (!has('confirm')) { const r = await call('report-preview', { note: opt('note') || '', lang: 'ai' }); out({ ok: false, preview: r.report, error: '会把上面的内容（已去掉钥匙与私人资料）送给工具作者。请先给用户看并取得同意，再加 --confirm 送出。' }, 1); }
      out(await call('report', { note: opt('note') || '', lang: 'ai' }));
    }
    case 'strategies': { const r = await call('strategies', { fresh: true }); out({ ok: true, note: '只列出通过安全条件、可以存的策略。terms 是可选期限（天，0.25 = 6 小时）；avail 是剩余空位（U）。期限越长积分越少：每 1U 每完成一单 = 100 TP。', items: r.items }); }
    case 'plan': {
      if (has('auto')) { await call('settings', { plan: [] }); out({ ok: true, mode: 'auto', note: '已改回自动挑选' }); }
      const raw = opt('set'); if (!raw) out({ ok: false, error: '用法：plan --set \'[{"strategyId":"…","termDays":0.25,"amount":100}]\'（最多 12 项；先用 strategies 看可选的策略与期限）｜ plan --auto 改回自动挑选' }, 1);
      let arr; try { arr = JSON.parse(raw); } catch { out({ ok: false, error: '--set 要是 JSON 阵列' }, 1); }
      await call('settings', { plan: arr }); const S = await call('state'); out({ ok: true, mode: 'plan', plan: S.settings.plan, note: '已保存，下一次开新单起生效；要开始请执行 start' });
    }
    case 'invite': { const c = opt('code'); if (!c) out({ ok: false, error: '用法：invite --code 邀请码（一次性，绑了不能改）' }, 1); out(await call('invite-bind', { code: c })); }
    default: out({ ok: false, error: '未知指令。可用：status | start [--amount N] [--rounds N] | stop | recall --confirm | refresh | connect | strategies | plan --set JSON | plan --auto | invite --code X | report [--note 说明] --confirm' }, 1);
  }
} catch (e) { out({ ok: false, error: e.message }, 1); }
