// 在线更新：从官方 GitHub 读取「作者签名过的更新清单」，只更新程序文件，不碰 data/（钱包密钥、备份、设置、进行中的单）。
// 安全：清单必须通过内嵌公钥（Ed25519）验证；每个文件下载后核对 SHA-256；路径只允许清单白名单内的相对路径。
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';

const REPO_RAW = 'https://raw.githubusercontent.com/nancyc0813-maker/termix-autodeposit';
const MANIFEST_URL = `${REPO_RAW}/main/update.json`;
const PUB = createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAvYmISbn7eiXEcEhhiU8obs+bUeTQVzGLwbB7hMjikSo=
-----END PUBLIC KEY-----`);
const ALLOW_RE = /^(app\/[\w.-]+|skills\/termix-agent-skills\/[\w.-]+(\/[\w.-]+)*|client-deps\.tgz|Start-TermiX\.vbs|LICENSE|README\.md|SHA256SUMS\.txt|使用说明\.txt|给AI的使用说明\.md)$/;
// 路径不准有 ..、. 或空的分段（防止跳出白名单文件夹，例如写进 data\ 钱包密钥）
const ALLOW = { test: (p) => typeof p === 'string' && ALLOW_RE.test(p) && p.split('/').every((x) => x && x !== '.' && x !== '..') };

export const vcmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; } return 0; };
// 签名内容 = 清单去掉 sig 后，按键排序的 JSON（制作工具 tools/sign-update.mjs 用同一个函数）
export const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function get(url, ms) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export function makeUpdater({ root, version, log }) {
  const ROOT = resolve(root);
  const U = { checkedAt: 0, latest: null, critical: false, notes: null, error: '', applying: false, applied: '' };
  let manifest = null;

  async function check() {
    try {
      const m = JSON.parse((await get(`${MANIFEST_URL}?t=${Date.now()}`, 20_000)).toString('utf8'));
      const { sig, ...body } = m;
      if (!sig || !verify(null, Buffer.from(canon(body)), PUB, Buffer.from(String(sig), 'base64'))) throw new Error('更新清单签名不对，已忽略（可能不是作者发布的）');
      if (!/^\d+\.\d+\.\d+$/.test(body.version) || !Array.isArray(body.files) || !body.files.length) throw new Error('更新清单格式不对');
      for (const f of body.files) if (!ALLOW.test(f.path) || !/^[0-9a-f]{64}$/.test(f.sha256) || !(f.size > 0 && f.size < 60e6)) throw new Error('更新清单含不允许的文件：' + f.path);
      manifest = body;
      U.latest = body.version; U.critical = !!body.critical; U.notes = body.notes || null; U.error = ''; U.commit = /^[0-9a-f]{40}$/.test(body.commit || '') ? body.commit : '';
    } catch (e) { U.error = String(e.message || e).slice(0, 160); }
    U.checkedAt = Date.now();
    return status();
  }
  const status = () => ({ current: version, latest: U.latest, available: !!U.latest && vcmp(U.latest, version) > 0, critical: U.critical, notes: U.notes, checkedAt: U.checkedAt, error: U.error, applying: U.applying, applied: U.applied });

  // 下载并换上新文件；成功后由呼叫端重启引擎。任何一个文件验证失败 → 整批放弃，原文件不动。
  async function apply() {
    if (U.applying) throw new Error('正在更新中');
    if (!manifest || vcmp(manifest.version, version) <= 0) throw new Error('目前已经是最新版本');
    U.applying = true;
    const stage = join(ROOT, 'data', '.update', manifest.version), bak = join(ROOT, 'data', '.update', 'backup-' + version);
    try {
      rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
      const todo = [];
      for (const f of manifest.files) {
        const dst = resolve(ROOT, f.path);
        if (!ALLOW.test(f.path) || !dst.startsWith(ROOT + sep) || [join(ROOT, 'data'), join(ROOT, 'node_modules'), join(ROOT, 'electron'), join(ROOT, 'baw')].some((d) => dst === d || dst.startsWith(d + sep))) throw new Error('路径不允许：' + f.path);
        let same = false; try { same = sha(readFileSync(dst)) === f.sha256; } catch { /* 新文件 */ }
        if (same) continue;
        const ref = U.commit || 'main';
        const buf = await get(`${REPO_RAW}/${ref}/${f.path.split('/').map(encodeURIComponent).join('/')}`, 180_000);
        if (buf.length !== f.size || sha(buf) !== f.sha256) throw new Error('下载的文件校验不通过：' + f.path + '（可能 GitHub 正在更新，稍后再试）');
        const tmp = join(stage, String(todo.length)); writeFileSync(tmp, buf); todo.push({ f, dst, tmp });
      }
      // 全部验证通过才动原文件；先备份旧版，方便出问题时还原
      for (const t of todo) { if (existsSync(t.dst)) { const b = join(bak, t.f.path); mkdirSync(dirname(b), { recursive: true }); copyFileSync(t.dst, b); } }
      const done = [];
      try {
        for (const t of todo) { mkdirSync(dirname(t.dst), { recursive: true }); try { renameSync(t.tmp, t.dst); } catch { copyFileSync(t.tmp, t.dst); } done.push(t); }
      } catch (e) {
        // 换到一半出错：已换的文件全部还原，避免新旧版混在一起
        for (const t of done) { const b = join(bak, t.f.path); try { if (existsSync(b)) copyFileSync(b, t.dst); else rmSync(t.dst, { force: true }); } catch { /* ignore */ } }
        throw new Error('更新时写入文件失败，已还原旧版：' + (e.message || e));
      }
      rmSync(stage, { recursive: true, force: true });
      // 记录这次更新：启动器若发现新版一直打不开，会用备份自动退回旧版
      writeFileSync(join(ROOT, 'data', '.update', 'pending.json'), JSON.stringify({ from: version, to: manifest.version, backup: bak, files: todo.map((t) => t.f.path), at: Date.now() }));
      U.applied = manifest.version;
      log(`⬆ 已更新到 v${manifest.version}（换了 ${todo.length} 个文件），正在重新启动`);
      return { version: manifest.version, files: todo.length };
    } finally { U.applying = false; }
  }
  return { check, apply, status };
}
