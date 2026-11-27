#!/usr/bin/env node
//
// Termix Quant — CLIENT-side "接单" (job creation) flow.
//
// Ports the browser wizard (packages/frontend/app/quant/new) so an AI can take a
// quant job from the terminal — no raw private key. The per-job task wallet is
// HD-derived from ONE signature; its LOCAL derived key signs the EIP-7702 upgrade +
// Altana session grant; the login wallet pays the principal transfer + fee escrow.
// The backend never sees a private key and only records addresses.
//
// The derivation signature comes from the active identity:
//   agentic  — the Binance Agentic Wallet signs an EIP-712 message (own wallet set).
//              BSC mainnet only (agentic cannot sign on testnets).
//   link     — the browser web wallet personal_signs via a MESSAGE sign-request
//              (`/sign?id=`); derives the SAME task wallets as the website. Works on
//              any chain the web wallet supports, including testnets.
//
// Order (each real-money step is its own subcommand, preview-first):
//   login (once)   node scripts/a2a-runtime.mjs login  (agentic) | aacp-link.mjs start (link)
//   client-strategy --strategy <id>                            # inspect (no money)
//   derive [--verify]                                          # derive (agentic: determinism gate)
//   allocate       --strategy <id>                             # server-allocates HD index
//   register       --index <n>                                 # derive + register address
//   fund           --index <n> --allocationU <U> [--yes]       # $$ principal + gas
//   create --strategy <id> --index <n> --allocationU <U> --dailyCapU <U> --termDays <d>
//   deliver        --index <n> --job <id>                      # 7702 grant + seal + POST session
//   checkout       --job <id>                                  # open fee escrow
//   escrow-fee     --checkout <id> [--yes]                     # $$ approve + createOrder + confirm
//
import {
  createCipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exitIfTermsRequired, requireTermsAccepted } from "./aacp-terms.mjs";
import { activeChain, assertQuantSupported, chainCacheFile, resolveApiBaseUrl } from "./aacp-chain.mjs";
import { activeIdentity, loadSessionToken } from "./aacp-credentials.mjs";
import { agenticAddress } from "./aacp-wallet.mjs";
import { signMessageViaBrowser } from "./aacp-sign-message.mjs";
import { estimateGas, getChainId, getFees, getNonce, rpc, sendRawTransaction, waitReceipt } from "./eth-rpc.mjs";
import { signTransaction } from "./vendor/eth-signer.mjs";
import {
  deriveTaskWallet,
  deriveTaskWalletAddress,
  deriveTaskWalletSeedFromSig,
  signDerivationMessage,
  wipeBytes,
} from "./quant-task-wallet.mjs";
import { deriveSeedFromWebSig } from "./quant-task-wallet-web.mjs";
import { termixClientHeaders } from "./aacp-client.mjs";
const require = createRequire(import.meta.url);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];

function arg(name) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
function requireArg(name) {
  const v = arg(name);
  if (!v || v === true) throw new Error(`--${name} is required`);
  return String(v);
}
const flag = (name) => arg(name) === true || arg(name) === "true";

// ── backend calls (agentic / linked session) ────────────────────────────────

async function clientApi(method, path, body) {
  const token = loadSessionToken();
  if (!token) {
    throw new Error(
      "No session for this backend. Sign in first:\n" +
        "  node scripts/a2a-runtime.mjs login   (agentic wallet)\n" +
        "  node scripts/aacp-link.mjs start     (web account)",
    );
  }
  const res = await fetch(`${resolveApiBaseUrl()}${path}`, {
    method,
    headers: {
      ...termixClientHeaders(),
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    exitIfTermsRequired(res.status, json, `${method} ${path}`);
    const message = json?.error?.message ?? json?.message ?? String(text).slice(0, 300);
    const err = new Error(`${method} ${path} → ${res.status}: ${message}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ── chain / venue config (live from the backend, never hardcoded) ────────────

async function resolveQuantChainClient() {
  const chainId = Number(activeChain().chainId);
  const config = await clientApi("GET", "/api/v1/config/contracts");
  const quant = config?.quant ?? {};
  if (quant.chainId != null && Number(quant.chainId) !== chainId) {
    throw new Error(`Chain mismatch: skill on ${chainId}, backend serves quant on ${quant.chainId}.`);
  }
  const uToken = quant.token?.address ?? quant.paymentToken ?? null;
  const uDecimals = Number(quant.token?.decimals ?? 18);
  const venueAllowlist = quant.venueAllowlist ?? [];
  const tokens = (quant.tradableTokens ?? [])
    .filter((t) => t?.address)
    .map((t) => ({ address: t.address, symbol: t.symbol ?? "?", decimals: Number(t.decimals ?? 18) }));
  if (!uToken || !tokens.length || !venueAllowlist.length) {
    throw new Error(`The quant vertical is not configured on ${resolveApiBaseUrl()} (chain ${chainId}).`);
  }
  const venusMarkets = (quant.venus?.markets ?? []).filter((m) => m?.vToken).map((m) => ({ vToken: m.vToken, underlying: m.underlying, symbol: m.symbol ?? "v?" }));
  return { chainId, uToken, uDecimals, venueAllowlist, tokens, venusMarkets };
}

/**
 * The session's on-chain call allowlist + the tokens the agent may spend.
 * Port of quant-new-page.tsx:237-256. Fail-closed: the venue list must include
 * the router, U, AND each traded token (a swap's approve is a call to the token).
 */
// Anchor 硬白名单：授权给策略方的合约只能在这里面（不信任后端回传的清单）
const ANCHOR_HARD = {
  USDC: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  COMPTROLLER: "0xfd36e2c2a6789db23113685031d7f16329158384",
  VUSDC: "0xeca88125a5adbe82614ffc12d0db554e2e2867c8",
  ROUTER: "0x10ed43c718714eb63d5aa57b78b54704e256024e",
  WBNB: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
};
const ANCHOR_VTOKENS = ["0xeca88125a5adbe82614ffc12d0db554e2e2867c8", "0x882c173bc7ff3b7786ca16dfed3dfffb9ee7847b"];
function anchorStrictAllowlist(chain, strategy) {
  const low = (a) => (a || []).map((x) => String(x).toLowerCase());
  const tok = low(strategy?.tokenAllowlist), ven = low(strategy?.venueAllowlist);
  const H = ANCHOR_HARD;
  if (String(chain.uToken).toLowerCase() !== H.USDC) throw new Error("Base token is not USDC; refusing to grant.");
  // Venus USDC：只准 Venus 主控合约、vUSDC、USDC；不准任何兑换
  const testOk = process.env.ANCHOR_TEST_STRATEGY && strategy?.id === process.env.ANCHOR_TEST_STRATEGY && strategy?.protocol === "venus";
  if (testOk || (strategy?.protocol === "venus" && tok.every((t) => t === H.USDC) && ven.every((v) => v === H.COMPTROLLER || v === H.VUSDC))) {
    return { kind: "venus", venues: [H.COMPTROLLER, H.VUSDC, H.USDC], tradableTokens: [] };
  }
  // 自家「USDC 持有」策略：钱放着不动，策略方不需要任何操作权限（只给一个无害的 enterMarkets，SDK 不接受空清单）
  const own = String(process.env.ANCHOR_OWN_PROVIDERS || "").toLowerCase().split(",").filter(Boolean);
  const holdVen = new Set([H.ROUTER, H.USDC, H.WBNB]);
  if (strategy?.protocol !== "venus" && own.includes(String(strategy?.providerAgentId || "").toLowerCase()) && /USDC Hold/i.test(String(strategy?.name || "")) &&
      tok.every((t) => t === H.WBNB || t === H.USDC) && ven.every((v) => holdVen.has(v))) {
    return { kind: "hold", venues: [], tradableTokens: [] };
  }
  throw new Error("Strategy is outside the Anchor safe set (Venus USDC supply / own USDC hold only); refusing to grant.");
}

function buildSessionAllowlist(chain, strategy) {
  if (process.env.ANCHOR_STRICT === "1") return anchorStrictAllowlist(chain, strategy);
  const wanted = new Set((strategy?.tokenAllowlist ?? []).map((a) => String(a).toLowerCase()));
  let chosen = chain.tokens.filter((t) => wanted.has(t.address.toLowerCase()));
  if (chosen.length === 0) chosen = chain.tokens; // legacy strategies with no allowlist trade all curated tokens
  const routerVenues = chain.venueAllowlist.filter((v) => v.kind === "venue").map((v) => v.address);
  const marketVenues = chain.venueAllowlist.filter((v) => v.kind === "money-market").map((v) => v.address);
  if (routerVenues.length === 0 || chosen.length === 0) {
    throw new Error("The trading venue is not configured for this network yet.");
  }
  const seen = new Set();
  const venues = [];
  for (const addr of [...routerVenues, ...marketVenues, chain.uToken, ...chosen.map((t) => t.address)]) {
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    venues.push(addr);
  }
  return { venues, tradableTokens: chosen.map((t) => ({ address: t.address, symbol: t.symbol })) };
}

// ── on-chain deps (viem + Altana SDK, installed in cwd — same as trade path) ──

async function importFromCwd(specifier) {
  try {
    // Anchor：存款端授权要用官网同版的 @bnbagent/sdk 0.5.3（0.6.x 会拒绝官网的授权格式），放在 ANCHOR_DEPS_DIR
    const require = createRequire(resolve(process.env.ANCHOR_DEPS_DIR || process.cwd(), "noop.cjs"));
    return await import(pathToFileURL(require.resolve(specifier)).href);
  } catch {
    return import(specifier);
  }
}
async function loadTradingDeps() {
  try {
    const [viem, wallets] = await Promise.all([importFromCwd("viem"), importFromCwd("@bnbagent/sdk/wallets")]);
    wallets.setAltanaSdkImporter(() => importFromCwd("@altananetwork/sdk"));
    return { viem, wallets };
  } catch (err) {
    throw new Error(
      "Granting a session needs three packages this skill does not bundle:\n" +
        `  cd ${process.cwd()} && npm i viem @bnbagent/sdk @altananetwork/sdk\n` +
        "Note @altananetwork/sdk is GPL-3.0-or-later and ESM-only.\n" +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const ALTANA_NETWORKS = { 56: "bnb-mainnet", 97: "bnb-testnet" };

/**
 * EIP-7702 upgrade + restricted session grant, driven by the LOCAL derived task
 * key. Node port of packages/frontend/lib/quant/altana.ts:69-132. register:true is
 * mandatory — the relay resolves the session key through the on-chain KeyStore.
 */
async function grantAgenticSession({ taskPrivateKey, chainId, paymentToken, dailyCapU, tradableTokens, venues, ttlSeconds, kind }) {
  const network = ALTANA_NETWORKS[chainId];
  if (!network) throw new Error(`No Altana network for chain ${chainId} (expected 56 or 97).`);
  if (!paymentToken) throw new Error("grantAgenticSession requires paymentToken (the live base token).");
  const { viem, wallets } = await loadTradingDeps();
  const { AltanaWalletProvider, defaultAgentPermissions, serializeSession } = wallets;
  const admin = new AltanaWalletProvider({ privateKey: taskPrivateKey, network });
  if (process.env.ANCHOR_STRICT === "1") {
    // Anchor：授权只到「函数」层级——策略方只能把 USDC 存进 Venus、从 Venus 赎回；
    // 不能转帐 USDC、不能转 vUSDC、不能借款、不能换币。不使用 SDK 的预设清单（它会对 USDC 开放所有函数）。
    const H = ANCHOR_HARD;
    if (kind !== "venus" && kind !== "hold") throw new Error("Unknown Anchor permission template; refusing to grant.");
    const permissions = {
      calls: kind === "hold" ? [{ to: H.COMPTROLLER, signature: "enterMarkets(address[])" }] : [
        { to: H.VUSDC, signature: "mint(uint256)" },
        { to: H.VUSDC, signature: "redeem(uint256)" },
        { to: H.VUSDC, signature: "redeemUnderlying(uint256)" },
        { to: H.COMPTROLLER, signature: "enterMarkets(address[])" },
      ],
      // 不给 USDC 任何花费额度：Porto 账户的 pay()（中继付费通道）会依 session 的花费额度直接把代币转给「付款收款人」，
      // 若 USDC 额度 = 本金，拿到 session 的人可把本金当「手续费」领走（GuardedExecutor/IthacaAccount 原始码确认）。
      // 存入 Venus 不受影响：mint 由 vUSDC 用「任务钱包自己」预先给的额度扣款，而只有「有花费额度的代币」才会被记帐检查。
      // 只留极少的 BNB 额度给中继手续费（最多损失 0.003 BNB/天，远小于任务钱包里的 gas）。
      spend: [
        { limit: viem.parseUnits("0.003", 18), period: "day" },
      ],
    };
    const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
    const session = await admin.grantSession({ permissions, expiry, register: true });
    return { serialized: serializeSession(session), sessionPublicKey: session.publicKey, expiry: session.expiry };
  }
  const base = defaultAgentPermissions({
    chainId,
    // Override the SDK's hardcoded paymentToken preset (BNB_CHAIN_ADDRESSES[chainId])
    // with the live base token. That preset is the legacy token address; after the
    // base-token migration (U → USDC) a session built without this override caps
    // spend on the OLD token and every trade reverts NoSpendPermissions.
    addresses: { paymentToken },
    tokenSpend: { limit: viem.parseUnits(dailyCapU, 18), period: "day" },
    nativeSpend: { limit: viem.parseUnits("0.05", 18), period: "day" },
    extraCalls: venues.map((to) => ({ to })),
  });
  const permissions = {
    ...base,
    spend: [
      ...(base.spend ?? []),
      ...tradableTokens.map((token) => ({ limit: viem.parseUnits(dailyCapU, 18), period: "day", token: token.address })),
    ],
  };
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const session = await admin.grantSession({ permissions, expiry, register: true });
  return { serialized: serializeSession(session), sessionPublicKey: session.publicKey, expiry: session.expiry };
}

// ── X25519 session seal (client direction; mirrors aacp-quant openEnvelope) ──

const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const pubFromRaw = (raw32) => createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, raw32]), format: "der", type: "spki" });
const rawOf = (key) => key.export({ type: "spki", format: "der" }).subarray(-32);

function sealSession(recipientRawB64, plaintext) {
  const recipient = pubFromRaw(Buffer.from(recipientRawB64, "base64"));
  const eph = generateKeyPairSync("x25519");
  const ephRaw = rawOf(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = Buffer.from(hkdfSync("sha256", shared, ephRaw, Buffer.from("termix-quant-envelope-v1"), 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: Buffer.concat([ct, cipher.getAuthTag()]).toString("base64"),
    ephemeralPublicKey: ephRaw.toString("base64"),
    nonce: nonce.toString("base64"),
    algorithm: "x25519-hkdf-chacha20poly1305",
  };
}

// ── small utils ──────────────────────────────────────────────────────────────

function toUnits(human, decimals) {
  const s = String(human).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Not a non-negative decimal amount: ${human}`);
  const [intPart, fracPart = ""] = s.split(".");
  const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  return (BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(frac || "0")).toString();
}
function encodeErc20Transfer(to, amountWei) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(to)) throw new Error(`Bad recipient address: ${to}`);
  const addr = to.slice(2).toLowerCase().padStart(64, "0");
  const amt = BigInt(amountWei).toString(16).padStart(64, "0");
  return `0xa9059cbb${addr}${amt}`;
}
const sigFingerprint = (sig) => createHash("sha256").update(String(sig).replace(/^0x/, "").toLowerCase()).digest("hex");

// ── local state (never the private key) ──────────────────────────────────────

function stateFile() { return resolve(process.cwd(), chainCacheFile(".termix-quant-client", ".json")); }
function loadClientState() { try { return JSON.parse(readFileSync(stateFile(), "utf8")); } catch { return {}; } }
function saveClientState(state) { writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); }

// Run aacp-tx.mjs for a real-money leg. stderr (preview/risks/progress) streams to
// the user; the final JSON on stdout is captured so we can read the tx hash.
function runTxIntents(intents, { yes }) {
  return new Promise((res, rej) => {
    const argv = [resolve(SCRIPT_DIR, "aacp-tx.mjs"), "--intents", JSON.stringify(intents), ...(yes ? ["--yes"] : [])];
    const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "inherit"], env: process.env });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", rej);
    child.on("exit", (code) => {
      if (out.trim()) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
      let parsed = null;
      try { parsed = JSON.parse(out.trim()); } catch { /* preview-only or malformed */ }
      if (code !== 0) return rej(new Error(`aacp-tx.mjs exited ${code}`));
      res(parsed);
    });
  });
}

function isLinked() {
  return activeIdentity() === "linked";
}

// The determinism gate only guards the AGENTIC (MPC) scheme, whose signature
// determinism we verify empirically. LINK signs with a plain web EOA — ECDSA
// RFC-6979 is deterministic by spec — so the gate does not apply.
function assertDeterminismVerified(state) {
  if (isLinked() || process.env.ANCHOR_SEED_DIR) return;
  if (state.determinismVerified !== true) {
    throw new Error(
      "Determinism gate not passed. A task wallet you cannot reliably re-derive is unrecoverable.\n" +
        "Run `derive --verify`, then sign the wallet out and reconnect it (`baw auth signout` → `aacp-wallet.mjs connect`), " +
        "then `derive --verify` again until it reports crossSession: PASS.",
    );
  }
}

// LINK mode: get the browser web wallet to personal_sign the derivation message
// via the shared MESSAGE bridge. Returns { domain, signature } — the same web scheme
// the wizard uses, so the terminal derives the SAME task wallets as the website.
function deriveViaLinkBridge(chainId) {
  return signMessageViaBrowser({
    chainId,
    messageKind: "QUANT_TASK_WALLET_DERIVE",
    action: "quantDerive",
    title: "Derive your Termix Quant task wallet",
  });
}

// The task-wallet master seed for the active identity. LINK → browser personal_sign
// (web scheme, same wallets as the site). AGENTIC → Binance EIP-712 (agentic scheme).
async function resolveTaskSeed({ chainId }) {
  if (isLinked()) {
    const { domain, signature } = await deriveViaLinkBridge(chainId);
    return deriveSeedFromWebSig(signature, domain);
  }
  // LOCAL SEED (Anchor 工具)：幣安 AI 錢包（MPC）簽名不可重現，所以任務錢包不從簽名推導，
  // 改用本機隨機產生的 32 bytes 主種子（只存在使用者電腦，並自動備份）。同一份種子永遠推出同一組任務錢包。
  return loadLocalSeed();
}

function loadLocalSeed() {
  const dir = process.env.ANCHOR_SEED_DIR;
  if (!dir) throw new Error("ANCHOR_SEED_DIR not set");
  const { mkdirSync, copyFileSync } = require("node:fs");
  mkdirSync(dir, { recursive: true });
  const f = resolve(dir, "task-wallet-seed.hex");
  if (!existsSync(f)) {
    // 先从备份还原；只有完全没有任何备份时才产生新的种子
    for (const b of [resolve(dir, "backup", "task-wallet-seed.hex"), process.env.ANCHOR_SEED_BACKUP2 ? resolve(process.env.ANCHOR_SEED_BACKUP2, "task-wallet-seed.hex") : null, process.env.ANCHOR_SEED_BACKUP2 && process.env.ANCHOR_LEGACY_SEED === "1" ? resolve(process.env.ANCHOR_SEED_BACKUP2, "..", "task-wallet-seed.hex") : null].filter(Boolean)) {
      if (existsSync(b)) { copyFileSync(b, f); break; }
    }
  }
  if (!existsSync(f)) {
    const { randomBytes: rb } = require("node:crypto");
    writeFileSync(f, rb(32).toString("hex"), { mode: 0o600 });
  }
  const bdir = resolve(dir, "backup"); mkdirSync(bdir, { recursive: true });
  const bf = resolve(bdir, "task-wallet-seed.hex"); if (!existsSync(bf)) copyFileSync(f, bf);
  const hex = readFileSync(f, "utf8").trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("Local seed file is corrupt: " + f);
  return Buffer.from(hex, "hex");
}

// ── subcommands ───────────────────────────────────────────────────────────────

async function cmdClientStrategy() {
  const strategyId = requireArg("strategy");
  const s = await clientApi("GET", `/api/v1/quant/strategies/${strategyId}`);
  console.log(JSON.stringify({
    id: s.id,
    name: s.name,
    providerAgentId: s.providerAgentId,
    status: s.status,
    mgmtFeeBps: s.mgmtFeeBps,
    minAllocationU: s.minAllocationU,
    capacityU: s.capacityU,
    termDaysOptions: s.termDaysOptions,
    tokenAllowlist: s.tokenAllowlist,
    note: "The provider's encryption key is verified at `create` time (the job returns it).",
  }, null, 2));
}

async function cmdDerive() {
  const index = Number(arg("index") ?? 0);
  const chainId = activeChain().chainId;

  // LINK: the browser web wallet derives (web scheme, same wallets as the site).
  // ECDSA is deterministic by spec, so there is no cross-session gate to run.
  if (isLinked()) {
    const { domain, signature } = await deriveViaLinkBridge(chainId);
    const seed = deriveSeedFromWebSig(signature, domain);
    let address;
    try { address = await deriveTaskWalletAddress(seed, index); } finally { wipeBytes(seed); }
    console.log(JSON.stringify({ index, address, identity: "linked", domain, note: "Web-scheme address (matches the website). Key never printed or stored." }, null, 2));
    return;
  }

  const sig = await signDerivationMessage({ chainId });
  const seed = deriveTaskWalletSeedFromSig(sig);
  let address;
  try { address = await deriveTaskWalletAddress(seed, index); } finally { wipeBytes(seed); }

  if (!flag("verify")) {
    console.log(JSON.stringify({ index, address, note: "Address only — the private key is never printed or stored." }, null, 2));
    return;
  }

  const fp = sigFingerprint(sig);
  const state = loadClientState();
  const prior = state.determinism;
  if (prior?.fingerprint) {
    const match = prior.fingerprint === fp;
    state.determinism = { fingerprint: fp, address, at: new Date().toISOString() };
    state.determinismVerified = match;
    saveClientState(state);
    if (!match) {
      console.error(JSON.stringify({
        index, address, crossSession: "FAIL", priorAddress: prior.address,
        error: "The agentic wallet produced a DIFFERENT signature for the same message. Do NOT fund — derived task wallets would be unrecoverable.",
      }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({ index, address, crossSession: "PASS", ok: "Determinism verified — safe to fund." }, null, 2));
    return;
  }
  state.determinism = { fingerprint: fp, address, at: new Date().toISOString() };
  state.determinismVerified = false;
  saveClientState(state);
  console.log(JSON.stringify({
    index, address, recorded: true,
    next: "Now sign the wallet out and reconnect it (`baw auth signout`, then `node scripts/aacp-wallet.mjs connect`), and run `derive --verify` again. An identical address = cross-session determinism confirmed.",
  }, null, 2));
}

async function cmdAllocate() {
  const strategyId = requireArg("strategy");
  const chain = await resolveQuantChainClient();
  const res = await clientApi("POST", "/api/v1/quant/trading-wallets", { chainId: chain.chainId });
  const index = res.derivationIndex ?? res.index;
  if (index == null) throw new Error(`Allocate returned no derivation index: ${JSON.stringify(res)}`);
  const state = loadClientState();
  state.pending = { strategyId, index, chainId: chain.chainId };
  saveClientState(state);
  console.log(JSON.stringify({ index, strategyId, next: `register --index ${index}` }, null, 2));
}

async function cmdRegister() {
  const index = Number(arg("index") ?? loadClientState().pending?.index);
  if (!Number.isInteger(index)) throw new Error("--index is required (or run `allocate` first)");
  const chain = await resolveQuantChainClient();
  const seed = await resolveTaskSeed({ chainId: chain.chainId });
  let address;
  try { address = await deriveTaskWalletAddress(seed, index); } finally { wipeBytes(seed); }
  await clientApi("PATCH", `/api/v1/quant/trading-wallets/${index}`, { chainId: chain.chainId, address });
  const state = loadClientState();
  state.pending = { ...(state.pending || {}), index, address, chainId: chain.chainId };
  saveClientState(state);
  console.log(JSON.stringify({ index, address, registered: true, next: `fund --index ${index} --allocationU <U>` }, null, 2));
}

async function cmdFund() {
  const state = loadClientState();
  assertDeterminismVerified(state);
  const index = Number(arg("index") ?? state.pending?.index);
  const address = arg("address") ?? state.pending?.address;
  if (!address) throw new Error("No task wallet address. Run `register --index N` first.");
  const allocationU = requireArg("allocationU");
  const gasBnb = String(arg("gas-bnb") ?? "0.02");
  const chain = await resolveQuantChainClient();
  const intents = [
    { to: chain.uToken, data: encodeErc20Transfer(address, toUnits(allocationU, chain.uDecimals)), action: "quant-fund-principal" },
    { to: address, value: toUnits(gasBnb, 18), action: "quant-fund-gas" },
  ];
  const yes = flag("yes");
  process.stderr.write(
    `[quant] funding task wallet ${address}: ${allocationU} U (principal) + ${gasBnb} BNB (gas).\n` +
      (yes ? "" : "[quant] preview only — re-run with --yes to broadcast.\n"),
  );
  await runTxIntents(intents, { yes });
  if (yes) console.log(JSON.stringify({ funded: address, allocationU, gasBnb, next: "create …" }, null, 2));
}

async function cmdCreate() {
  const strategyId = requireArg("strategy");
  const state = loadClientState();
  const index = Number(arg("index") ?? state.pending?.index);
  const address = arg("address") ?? state.pending?.address;
  if (!address) throw new Error("No task wallet address. Run `register` first.");
  const allocationU = requireArg("allocationU");
  const dailyCapU = requireArg("dailyCapU");
  const termDays = Number(requireArg("termDays"));
  const job = await clientApi("POST", "/api/v1/quant/jobs", {
    strategyId, tradingWalletAddress: address, allocationU, dailyCapU, termDays,
  });
  const encKey = job.agentEncryptionPublicKey;
  if (!encKey) {
    throw new Error(
      `Job ${job.id} was created (DRAFT) but its provider agent has published no encryption key, so it cannot receive a session. ` +
        "Ask the provider to run `aacp-quant.mjs register-key`. Nothing was funded by this step.",
    );
  }
  state.jobs = state.jobs || {};
  state.jobs[job.id] = {
    jobId: job.id, strategyId, index, address, allocationU, dailyCapU, termDays,
    recipientAgentId: job.recipientAgentId, agentEncryptionPublicKey: encKey,
  };
  saveClientState(state);
  console.log(JSON.stringify({ jobId: job.id, status: job.status, next: `deliver --index ${index} --job ${job.id}` }, null, 2));
}

async function cmdDeliver() {
  const state = loadClientState();
  assertDeterminismVerified(state);
  const jobId = requireArg("job");
  const job = state.jobs?.[jobId];
  if (!job) throw new Error(`No local record for job ${jobId}. Run \`create\` first.`);
  const index = Number(arg("index") ?? job.index);
  const chain = await resolveQuantChainClient();
  const strategy = await clientApi("GET", `/api/v1/quant/strategies/${job.strategyId}`);
  const { venues, tradableTokens, kind } = buildSessionAllowlist(chain, strategy);

  const seed = await resolveTaskSeed({ chainId: chain.chainId });
  let granted;
  try {
    const wallet = await deriveTaskWallet(seed, index);
    try {
      if (wallet.address.toLowerCase() !== String(job.address).toLowerCase()) {
        throw new Error(
          `Re-derived address ${wallet.address} does not match the registered task wallet ${job.address}. ` +
            "Refusing to grant. Your funds are at the REGISTERED address; do not open a new job with this account until this is resolved.",
        );
      }
      if (process.env.ANCHOR_STRICT === "1" && kind === "venus") {
        // Anchor：由任务钱包自己授权 vUSDC 动用「刚好本金」的 USDC（存入 Venus 用），策略方的权限里就不必有 USDC
        const H = ANCHOR_HARD;
        const amt = (BigInt(toUnits(job.allocationU, 18)) * 10n).toString(); // 10 倍：赎回后再存入也够用；vUSDC 只能从任务钱包自己 mint 时拉款
        const cur = BigInt(String(await rpc("eth_call", [{ to: H.USDC, data: "0xdd62ed3e" + wallet.address.slice(2).toLowerCase().padStart(64, "0") + H.VUSDC.slice(2).padStart(64, "0") }, "latest"])).slice(0, 66));
        if (cur < BigInt(amt)) {
          const data = "0x095ea7b3" + H.VUSDC.slice(2).padStart(64, "0") + BigInt(amt).toString(16).padStart(64, "0");
          const cid = await getChainId();
          const nonce = await getNonce(wallet.address);
          const fees = await getFees();
          const gas = await estimateGas({ from: wallet.address, to: H.USDC, value: "0", data });
          const signed = signTransaction(wallet.privateKey, { chainId: cid, nonce, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, gas, to: H.USDC, value: "0", data });
          const txHash = await sendRawTransaction(signed.raw, signed.hash);
          process.stderr.write(`[quant] task wallet approve vUSDC ${job.allocationU} USDC tx=${txHash}\n`);
          const rc = await waitReceipt(txHash);
          if (rc.status !== "0x1") throw new Error(`Task-wallet approve to vUSDC reverted (${txHash}).`);
        }
      }
      granted = await grantAgenticSession({
        taskPrivateKey: wallet.privateKey,
        chainId: chain.chainId,
        // Live base token — overrides the SDK's stale hardcoded paymentToken preset
        // so the session can spend the current settlement token (USDC post-migration).
        paymentToken: chain.uToken,
        dailyCapU: job.dailyCapU,
        tradableTokens,
        venues,
        kind,
        ttlSeconds: job.termDays * 86_400,
      });
    } finally {
      wallet.privateKey = `0x${"0".repeat(64)}`; // best-effort scrub (JS strings are immutable)
    }
  } finally {
    wipeBytes(seed);
  }

  const envelope = sealSession(job.agentEncryptionPublicKey, granted.serialized);
  const sessionExpiresAt = new Date(granted.expiry * 1000).toISOString();
  await clientApi("POST", `/api/v1/quant/jobs/${jobId}/session`, {
    recipientAgentId: job.recipientAgentId,
    ciphertext: envelope.ciphertext,
    ephemeralPublicKey: envelope.ephemeralPublicKey,
    nonce: envelope.nonce,
    algorithm: envelope.algorithm,
    sessionPublicKey: granted.sessionPublicKey,
    sessionExpiresAt,
  });
  console.log(JSON.stringify({ jobId, sessionPublicKey: granted.sessionPublicKey, sessionExpiresAt, status: "session delivered", next: `checkout --job ${jobId}` }, null, 2));
}

async function cmdCheckout() {
  const jobId = requireArg("job");
  const state = loadClientState();
  let clientAgentId = arg("client-agent");
  if (!clientAgentId) {
    const agents = await clientApi("GET", "/api/v1/agents");
    const list = Array.isArray(agents) ? agents : agents?.items ?? [];
    clientAgentId = list[0]?.id;
  }
  if (!clientAgentId) {
    throw new Error("Checkout needs one of your own agents (clientAgentId); this account owns none. Mint an agent first, or pass --client-agent <id>.");
  }
  const res = await clientApi("POST", `/api/v1/quant/jobs/${jobId}/checkout`, { clientAgentId, idempotencyKey: `quant-${jobId}` });
  const checkoutSessionId = res.checkoutSessionId ?? res.checkoutId ?? res.id;
  if (state.jobs?.[jobId]) { state.jobs[jobId].checkoutSessionId = checkoutSessionId; saveClientState(state); }
  console.log(JSON.stringify({ jobId, checkoutSessionId, feeU: res.feeU, next: `escrow-fee --checkout ${checkoutSessionId}` }, null, 2));
}

async function cmdEscrowFee() {
  const checkoutId = requireArg("checkout");
  const yes = flag("yes");

  const approve = await clientApi("POST", `/api/v1/checkout/${checkoutId}/tx-intent`, { action: "approveEscrow" });
  // Anchor：链上授权额度已经够就跳过 approve（币安 App 对「未验证合约」的授权会要求人工确认，只需第一次）
  let r1 = null;
  try {
    const d = String(approve.data || approve.callData || "");
    const spender = "0x" + d.slice(10 + 24, 10 + 64);
    const need = BigInt("0x" + d.slice(10 + 64, 10 + 128));
    // Anchor：第一次授权一个较大的额度（ANCHOR_APPROVE_WEI），之后每轮都跳过授权，币安 App 就不用再按确认
    const want = process.env.ANCHOR_APPROVE_WEI ? BigInt(process.env.ANCHOR_APPROVE_WEI) : 0n;
    // 只对 TermiX 官方 USDC 托管合约放大额度，且上限 5 USDC（金额以 18 位小数计）
    const OFFICIAL_ESCROW = "0x6a52ba4c84b348faeae13ddc7a97b4f6af23913c";
    const tokenOk = String(approve.to || approve.contract || "").toLowerCase() === "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
    if (d.startsWith("0x095ea7b3") && d.length === 138 && tokenOk && spender.toLowerCase() === OFFICIAL_ESCROW && want > need && want <= 5n * 10n ** 18n) {
      const nd = d.slice(0, 74) + want.toString(16).padStart(64, "0");
      if (approve.data) approve.data = nd; else approve.callData = nd;
    }
    const maxFee = process.env.ANCHOR_MAX_FEE_WEI ? BigInt(process.env.ANCHOR_MAX_FEE_WEI) : null;
    if (process.env.ANCHOR_STRICT === "1" && (maxFee === null || need > maxFee)) {
      throw new Error(`Fee ${need} exceeds the locally computed maximum ${maxFee}; refusing.`);
    }
    const owner = String(process.env.ANCHOR_OWNER || "");
    const tokenAddr = approve.to || approve.contract;
    if (owner && tokenAddr && /^0x[0-9a-f]{40}$/i.test(spender)) {
      const res = await rpc("eth_call", [{ to: tokenAddr, data: "0xdd62ed3e" + owner.slice(2).toLowerCase().padStart(64, "0") + spender.slice(2).toLowerCase().padStart(64, "0") }, "latest"]);
      const have = BigInt(String(res).slice(0, 66));
      if (have >= need) { console.error(`[quant] escrow allowance ${have} >= ${need}: skip approve`); r1 = { skipped: true }; }
    }
  } catch (e) { if (/refusing/.test(e.message)) throw e; throw new Error("allowance check failed (RPC), will retry later instead of asking for a new approval: " + e.message); }
  {
    const ad = String(approve.data || approve.callData || "");
    const at = String(approve.to || approve.contract || "").toLowerCase();
    if (at !== "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" || ad.length !== 138 || !ad.startsWith("0x095ea7b3") || ad.slice(34, 74).toLowerCase() !== "6a52ba4c84b348faeae13ddc7a97b4f6af23913c") {
      throw new Error("approveEscrow intent is not USDC.approve(official TermiX escrow); refusing.");
    }
  }
  if (process.env.ANCHOR_STRICT === "1") {
    const ad2 = String(approve.data || approve.callData || "");
    const needAfter = BigInt("0x" + ad2.slice(74, 138));
    const capWei = (process.env.ANCHOR_MAX_FEE_WEI ? BigInt(process.env.ANCHOR_MAX_FEE_WEI) : 0n);
    const ceiling = process.env.ANCHOR_APPROVE_WEI ? BigInt(process.env.ANCHOR_APPROVE_WEI) : 0n;
    if (needAfter > (ceiling > capWei ? ceiling : capWei)) throw new Error("Approve amount exceeds the local ceiling; refusing.");
  }
  if (!r1) r1 = await runTxIntents([approve], { yes });
  if (!yes) {
    console.log(JSON.stringify({ stage: "preview", note: "Previewed approveEscrow. Re-run with --yes to broadcast approve + createOrder + confirm." }, null, 2));
    return;
  }

  let createOrder;
  try {
    createOrder = await clientApi("POST", `/api/v1/checkout/${checkoutId}/tx-intent`, { action: "createOrder" });
  } catch (err) {
    if (/already|funded|recover/i.test(String(err.message))) {
      await clientApi("POST", `/api/v1/checkout/${checkoutId}/recover`, {});
      console.log(JSON.stringify({ checkoutId, recovered: true, note: "Order was already funded; ran /recover instead." }, null, 2));
      return;
    }
    throw err;
  }
  // Anchor：付费交易只能送到 TermiX 官方 USDC 托管合约，否则拒绝
  createOrder.action = "createOrder";
  if (createOrder.value && BigInt(createOrder.value) !== 0n) throw new Error("createOrder carries BNB value; refusing.");
  if (String(createOrder.to || createOrder.contract || "").toLowerCase() !== "0x6a52ba4c84b348faeae13ddc7a97b4f6af23913c") {
    throw new Error(`createOrder target ${createOrder.to || createOrder.contract} is not the official TermiX USDC escrow; refusing.`);
  }
  if (/^0x(095ea7b3|a9059cbb|23b872dd|39509351|d505accf)/i.test(String(createOrder.data || createOrder.callData || ""))) throw new Error("createOrder intent is a token approve/transfer, not an escrow order; refusing.");
  const r2 = await runTxIntents([createOrder], { yes });
  const txHash = r2?.results?.find((x) => x.txHash)?.txHash;
  if (!txHash) {
    throw new Error("createOrder produced no tx hash (App confirmation pending?). Find it with `baw wallet tx-history --json`, then POST /checkout/" + checkoutId + "/confirm { txHash } via aacp-api.");
  }
  await clientApi("POST", `/api/v1/checkout/${checkoutId}/confirm`, { txHash });
  console.log(JSON.stringify({ checkoutId, approveTx: r1?.results?.[0]?.txHash ?? null, createOrderTx: txHash, confirmed: true, status: "management fee escrowed — job is live" }, null, 2));
}

const balanceOfCall = (token, owner) =>
  rpc("eth_call", [{ to: token, data: `0x70a08231${owner.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"]);

// Recover a task wallet at term end: send its ERC-20 balances (U + any tradable
// tokens it holds) back to the login wallet, THEN the remaining native BNB. Token
// legs FIRST, native LAST — each token transfer costs native, so draining native
// first would strand the tokens (load-bearing order, mirrors frontend sweep.ts).
// Signed LOCALLY by the re-derived task key; broadcast via raw RPC.
async function cmdSweep() {
  const state = loadClientState();
  const jobs = Object.values(state.jobs || {});
  const index = Number(arg("index") ?? state.pending?.index ?? jobs[0]?.index);
  if (!Number.isInteger(index)) throw new Error("--index is required (or run the flow first so it is in state).");
  const registered = arg("address") ?? state.pending?.address ?? jobs.find((j) => j.index === index)?.address;
  let chain;
  try {
    if (process.env.ANCHOR_STRICT === "1") throw new Error("Anchor strict mode: never trust backend token config for sweep");
    chain = await resolveQuantChainClient();
  } catch (e) {
    // Anchor：平台连不上也要能收回本金——用写死的代币清单（2026-11-26 自官方 config 核对）
    process.stderr.write(`[quant] config unavailable (${e.message}); using built-in token list for sweep.\n`);
    chain = { chainId: 56, uToken: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", uDecimals: 18,
      tokens: [["0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", "WBNB", 18], ["0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", "Cake", 18], ["0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE", "XRP", 18], ["0x2170Ed0880ac9A755fd29B2688956BD959F933F8", "ETH", 18], ["0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", "BTCB", 18], ["0xbA2aE424d960c26247Dd6c32edC70B295c744C43", "DOGE", 8], ["0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD", "LINK", 18]].map(([address, symbol, decimals]) => ({ address, symbol, decimals })),
      venusMarkets: [{ vToken: "0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8", symbol: "vUSDC" }, { vToken: "0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B", symbol: "vBTC" }] };
  }
  if (!arg("to") && process.env.ANCHOR_STRICT === "1") throw new Error("--to is required in Anchor mode.");
  const dest = String(arg("to") ?? (await agenticAddress()));
  if (!/^0x[a-fA-F0-9]{40}$/.test(dest)) throw new Error(`--to is not a valid address: ${dest}`);
  const yes = flag("yes");

  const seed = await resolveTaskSeed({ chainId: chain.chainId });
  let wallet;
  try {
    wallet = await deriveTaskWallet(seed, index);
  } finally {
    wipeBytes(seed);
  }
  try {
    if (registered && wallet.address.toLowerCase() !== String(registered).toLowerCase()) {
      throw new Error(`Re-derived address ${wallet.address} != registered ${registered}. Refusing to sweep — funds are at the registered address.`);
    }
    const from = wallet.address;
    const pk = wallet.privateKey;
    const chainId = await getChainId();

    // Anchor：先把仍存在 Venus 的部位（vToken）用任务钱包自己的钥匙赎回成原币，再转走。
    // 策略方正常会在到期前赎回；这里是保险，避免本金卡在 Venus。
    const vHeld = [];
    for (const m of (chain.venusMarkets ?? []).filter((x) => ANCHOR_VTOKENS.includes(String(x.vToken).toLowerCase()))) {
      const vb = BigInt((await balanceOfCall(m.vToken, from)) || "0x0");
      if (vb > 0n) vHeld.push({ ...m, vb });
    }
    if (vHeld.length && yes) {
      const nb = BigInt((await rpc("eth_getBalance", [from, "pending"])) || "0x0");
      if (nb === 0n) throw new Error(`Task wallet ${from} still has Venus positions but 0 BNB for gas; send a little BNB to it, then sweep again.`);
      let vn = await getNonce(from);
      for (const m of vHeld) {
        const data = "0xdb006a75" + m.vb.toString(16).padStart(64, "0"); // redeem(uint256 redeemTokens)
        const fees = await getFees();
        const gas = await estimateGas({ from, to: m.vToken, value: "0", data });
        const signed = signTransaction(pk, { chainId, nonce: vn, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, gas, to: m.vToken, value: "0", data });
        const txHash = await sendRawTransaction(signed.raw, signed.hash);
        process.stderr.write(`[quant] venus redeem ${m.symbol} nonce=${vn} tx=${txHash}\n`);
        const rc = await waitReceipt(txHash);
        if (rc.status !== "0x1") throw new Error(`Venus redeem ${m.symbol} reverted (${txHash}); NOT sweeping BNB so the wallet keeps gas for a retry.`);
        const left = BigInt((await balanceOfCall(m.vToken, from)) || "0x0");
        if (left > 0n) throw new Error(`Venus redeem ${m.symbol} left ${left} vTokens (market liquidity?); retry later.`);
        vn += 1n;
      }
    }

    // Dedupe U + tradable tokens by address.
    const seen = new Set();
    const tokens = [{ address: chain.uToken, symbol: "U", decimals: chain.uDecimals }, ...chain.tokens].filter((t) => {
      const k = t.address.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const balances = [];
    for (const t of tokens) {
      const bal = BigInt((await balanceOfCall(t.address, from)) || "0x0");
      if (bal > 0n) balances.push({ ...t, bal });
    }
    const nativeBal = BigInt((await rpc("eth_getBalance", [from, "pending"])) || "0x0");

    if (balances.length && nativeBal === 0n) {
      throw new Error(`Task wallet ${from} holds tokens but has 0 BNB for gas. Send a little BNB to it first (e.g. \`aacp-tx.mjs --intent '{"to":"${from}","value":"2000000000000000"}' --yes\`), then sweep.`);
    }

    const plan = [
      ...balances.map((b) => ({ kind: "token", ...b, human: Number(b.bal) / 10 ** b.decimals })),
      ...(nativeBal > 0n ? [{ kind: "native", bal: nativeBal, human: Number(nativeBal) / 1e18 }] : []),
    ];
    if (vHeld.length && !yes) plan.unshift(...vHeld.map((m) => ({ kind: "venus", symbol: m.symbol, human: Number(m.vb) / 1e8 })));
    if (plan.length === 0) {
      console.log(JSON.stringify({ from, dest, note: "Task wallet already empty — nothing to sweep." }, null, 2));
      return;
    }
    if (!yes) {
      console.log(JSON.stringify({
        stage: "preview", from, dest,
        willSweep: plan.map((p) => ({ token: p.kind === "native" ? "BNB" : p.symbol, amount: p.human })),
        note: "Re-run with --yes to broadcast (token legs first, native last).",
      }, null, 2));
      return;
    }

    const results = [];
    let nonce = await getNonce(from);
    // Token legs first.
    for (const b of balances) {
      const data = encodeErc20Transfer(dest, b.bal.toString());
      const fees = await getFees();
      const gas = await estimateGas({ from, to: b.address, value: "0", data });
      const signed = signTransaction(pk, { chainId, nonce, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, gas, to: b.address, value: "0", data });
      const txHash = await sendRawTransaction(signed.raw, signed.hash);
      process.stderr.write(`[quant] sweep ${b.symbol} nonce=${nonce} tx=${txHash}\n`);
      const rc = await waitReceipt(txHash);
      results.push({ token: b.symbol, amount: Number(b.bal) / 10 ** b.decimals, txHash, status: rc.status === "0x1" ? "success" : "reverted" });
      nonce += 1n;
    }
    // Anchor：任何一笔代币转账失败，就不转走 BNB（保留 gas 让下次重试），并以失败结束
    if (results.some((x) => x.status !== "success")) {
      console.log(JSON.stringify({ sweptTo: dest, from, results, note: "token leg failed; BNB kept for retry" }, null, 2));
      process.exit(3);
    }
    // Native last: send balance minus this tx's gas cost.
    const freshNative = BigInt((await rpc("eth_getBalance", [from, "pending"])) || "0x0");
    if (freshNative > 0n) {
      const fees = await getFees();
      const gas = await estimateGas({ from, to: dest, value: "0", data: "0x" });
      const cost = gas * fees.maxFeePerGas;
      const value = freshNative - cost;
      if (value > 0n) {
        const signed = signTransaction(pk, { chainId, nonce, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, gas, to: dest, value: value.toString(), data: "0x" });
        const txHash = await sendRawTransaction(signed.raw, signed.hash);
        process.stderr.write(`[quant] sweep BNB nonce=${nonce} tx=${txHash}\n`);
        const rc = await waitReceipt(txHash);
        results.push({ token: "BNB", amount: Number(value) / 1e18, txHash, status: rc.status === "0x1" ? "success" : "reverted" });
      } else {
        results.push({ token: "BNB", skipped: "remaining balance below gas cost" });
      }
    }
    console.log(JSON.stringify({ sweptTo: dest, from, results }, null, 2));
  } finally {
    wallet.privateKey = `0x${"0".repeat(64)}`;
  }
}

// Anchor：在链上撤销任务钱包上所有「非管理员」的 session 钥匙（策略方的授权）。
// IthacaAccount.revoke 只能由账户自己呼叫；7702 账户的 EOA 钥匙直接对自己送交易即可。
async function cmdRevokeOnchain() {
  const index = Number(requireArg("index"));
  const registered = requireArg("address");
  const seed = await resolveTaskSeed({ chainId: 56 });
  let wallet;
  try { wallet = await deriveTaskWallet(seed, index); } finally { wipeBytes(seed); }
  try {
    if (wallet.address.toLowerCase() !== String(registered).toLowerCase()) throw new Error(`Re-derived address ${wallet.address} != ${registered}`);
    const viem = await importFromCwd("viem");
    const { bsc } = await importFromCwd("viem/chains");
    const { privateKeyToAccount } = await importFromCwd("viem/accounts");
    const transport = viem.fallback([viem.http("https://bsc-dataseed.bnbchain.org", { timeout: 15000 }), viem.http("https://bsc-rpc.publicnode.com", { timeout: 15000 })]);
    const pc = viem.createPublicClient({ chain: bsc, transport });
    const wc = viem.createWalletClient({ chain: bsc, transport, account: privateKeyToAccount(wallet.privateKey) });
    const abi = viem.parseAbi(["function getKeys() view returns ((uint40 expiry,uint8 keyType,bool isSuperAdmin,bytes publicKey)[] keys, bytes32[] keyHashes)", "function revoke(bytes32 keyHash)"]);
    const code = await pc.getCode({ address: wallet.address });
    if (!code || code === "0x") { console.log(JSON.stringify({ address: wallet.address, revoked: [], note: "not delegated — no session keys" })); return; }
    const [keys, hashes] = await pc.readContract({ address: wallet.address, abi, functionName: "getKeys" });
    const revoked = [];
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].isSuperAdmin) continue;
      const h = await wc.writeContract({ address: wallet.address, abi, functionName: "revoke", args: [hashes[i]] });
      const rc = await pc.waitForTransactionReceipt({ hash: h, timeout: 120000 });
      if (rc.status !== "success") throw new Error(`revoke ${hashes[i]} reverted (${h})`);
      revoked.push({ keyHash: hashes[i], tx: h });
    }
    let left = 0;
    for (let i = 0; i < 6; i++) { // BSC 节点读取可能落后几秒，最多等 30 秒
      const [k2] = await pc.readContract({ address: wallet.address, abi, functionName: "getKeys" });
      left = k2.filter((k) => !k.isSuperAdmin).length;
      if (!left) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (left) throw new Error(`${left} session key(s) still present after revoke`);
    console.log(JSON.stringify({ address: wallet.address, revoked, sessionKeysLeft: 0 }));
  } finally {
    wallet.privateKey = `0x${"0".repeat(64)}`;
  }
}

const COMMANDS = {
  "revoke-onchain": cmdRevokeOnchain,
  "client-strategy": cmdClientStrategy,
  derive: cmdDerive,
  allocate: cmdAllocate,
  register: cmdRegister,
  fund: cmdFund,
  create: cmdCreate,
  deliver: cmdDeliver,
  checkout: cmdCheckout,
  "escrow-fee": cmdEscrowFee,
  sweep: cmdSweep,
};

// Exported pure helpers so the self-test can drive them without a live wallet.
export { buildSessionAllowlist, encodeErc20Transfer, sealSession, toUnits };

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const run = COMMANDS[cmd];
  if (!run) {
    console.error(`Usage: node quant-client.mjs <${Object.keys(COMMANDS).join("|")}> [flags]`);
    process.exit(1);
  }
  try {
    assertQuantSupported();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  // Terms of Use (aacp-terms.mjs): no agreement, no use — except `sweep`,
  // which returns the client's own funds from the task wallet.
  (cmd === "sweep" || cmd === "revoke-onchain" ? Promise.resolve() : requireTermsAccepted(`quant-client.mjs ${cmd}`))
    .then(() => run())
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
