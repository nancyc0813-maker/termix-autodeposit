#!/usr/bin/env node
//
// Termix Terms of Use — the skill / AI-agent risk notice, and the user's
// agreement to it.
//
// THE RULE: no agreement, no use.
//   * Every command that acts on the account through the platform refuses to
//     run until the account has agreed to the current terms —
//     `requireTermsAccepted()` at each script's entry (aacp-api, a2a-runtime,
//     aacp-watch, aacp-quant, quant-client, aacp-tx, aacp-sign-message).
//   * Still available without agreeing, because without them the user could
//     neither agree nor get out: linking / logging in, this script, update,
//     public reads (`--auth none`, aacp-get, aacp-agent, aacp-config), and
//     stopping what already runs locally (`autoreply --stop`,
//     `autotrade stop|status`, `hosting status|off`, `sweep`).
//   * Only an AGREEMENT is remembered locally, per wallet, in
//     `.termix-terms.<chain>-<backend>.json` — so several wallets in one
//     directory never share it. Not agreeing is never remembered: every command
//     asks the platform again and refuses again. When the platform refuses a
//     wallet the file says has agreed (a new terms version), that entry is
//     dropped and the notice shown.
//   * The platform enforces all of this itself (backend services/terms.ts:
//     403 TERMS_REQUIRED for the skill's credentials). This check only shows
//     the notice before a command runs; the local file cannot unlock anything.
//   * When the platform gives no answer at all (a backend without the terms
//     endpoint, an outage), the command is not blocked: it would fail on its own
//     in an outage, and a skill release must not lock everyone out of a backend
//     that has not shipped the terms yet.
//
// Usage:
//   node aacp-terms.mjs status                   has this account agreed? prints the notice
//   node aacp-terms.mjs accept --version <v>     record the user's agreement — ONLY after
//                                                they said so themselves, never on their behalf
//
// Zero dependencies, no side effects on import (house style for this skill).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chainCacheFile, resolveApiBaseUrl } from "./aacp-chain.mjs";
import { currentWallet, loadSessionToken } from "./aacp-credentials.mjs";
import { skillVersion, termixClientHeaders } from "./aacp-client.mjs";
import { resolveWebUrl } from "./aacp-web.mjs";

const STATUS_TIMEOUT_MS = 5_000;
export const TERMS_REQUIRED_EXIT_CODE = 3;
export const TERMS_REQUIRED_CODE = "TERMS_REQUIRED";

// Addressed to the agent reading the output, not to the user.
const AGREEMENT_INSTRUCTION =
  "Show the notice to the user in their language, word for word in meaning, and give them the terms link. " +
  "Run the accept command ONLY after the user explicitly says they agree. Never agree on the user's behalf, " +
  "and never treat silence, a previous 'yes' to something else, or a standing instruction as agreement. " +
  "If they decline, stop: the skill cannot act on their account until they agree.";

// ── pure helpers (no I/O) ───────────────────────────────────────────────────

// The backend builds the link from its own idea of the website, which on test
// backends is the production site; the build's web origin is the right one.
function webTermsUrl(url) {
  try {
    return url ? resolveWebUrl(url) : url;
  } catch {
    return url;
  }
}

/** The block shown to the user while they have not agreed. */
export function termsNotice(status) {
  return {
    termsVersion: status.currentVersion,
    termsUrl: webTermsUrl(status.termsUrl),
    notice: status.notice ?? [],
    howToAgree: `node scripts/aacp-terms.mjs accept --version ${status.currentVersion}`,
    instruction: AGREEMENT_INSTRUCTION,
  };
}

/** Has this wallet agreed, according to the local file? (`cache` is its parsed content.) */
export function agreedLocally(cache, wallet) {
  return Boolean(wallet && cache?.agreed?.[wallet]?.version);
}

/** Given the platform's answer (or null for none), may the command run? */
export function termsAllow(status) {
  return !status || status.accepted === true;
}

// ── I/O ─────────────────────────────────────────────────────────────────────

function cachePath() {
  return resolve(process.cwd(), chainCacheFile(".termix-terms", ".json"));
}

function readCache() {
  try {
    return existsSync(cachePath()) ? JSON.parse(readFileSync(cachePath(), "utf8")) : null;
  } catch {
    return null;
  }
}

function writeCache(value) {
  try {
    writeFileSync(cachePath(), JSON.stringify(value, null, 2));
  } catch {
    /* read-only directory: the platform is just asked every time */
  }
}

/** Remember that `wallet` agreed to `version`. Agreements only — never a refusal. */
function rememberAgreement(wallet, version) {
  if (!wallet || !version) return;
  const cache = readCache() ?? {};
  writeCache({ ...cache, agreed: { ...(cache.agreed ?? {}), [wallet]: { version, agreedAt: new Date().toISOString() } } });
}

/** Drop `wallet`'s remembered agreement (the platform says it no longer holds). */
export function forgetAgreement(wallet) {
  const cache = readCache();
  if (!wallet || !cache?.agreed?.[wallet]) return;
  const { [wallet]: _gone, ...rest } = cache.agreed;
  writeCache({ ...cache, agreed: rest });
}

function walletOf(status) {
  return (typeof status?.walletAddress === "string" ? status.walletAddress.toLowerCase() : null) ?? currentWallet();
}

/** The platform's answer, or null when it gives none (never throws). */
export async function fetchTermsStatus() {
  const token = loadSessionToken();
  if (!token) return null;
  try {
    const res = await fetch(`${resolveApiBaseUrl()}/api/v1/terms/status`, {
      headers: { ...termixClientHeaders(), authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return null; // no terms on this backend (404), dead credential, outage
    const json = await res.json();
    if (typeof json?.currentVersion !== "string") return null;
    if (json.accepted) rememberAgreement(walletOf(json), json.currentVersion);
    else forgetAgreement(walletOf(json));
    return json;
  } catch {
    return null;
  }
}

/**
 * Gate at the entry of every command that acts on the account. Returns when the
 * account has agreed (or the platform gives no answer); otherwise prints the
 * terms-required block and exits with TERMS_REQUIRED_EXIT_CODE — nothing ran.
 */
export async function requireTermsAccepted(command) {
  if (agreedLocally(readCache(), currentWallet())) return;
  const status = await fetchTermsStatus();
  if (termsAllow(status)) return;
  refuse(command, termsNotice(status));
}

function refuse(command, notice) {
  console.log(JSON.stringify({
    status: "terms-required",
    command,
    ran: false,
    reason: "This account has not agreed to the TermiX Terms of Use. The skill cannot act on the account until the user agrees. Nothing was done.",
    ...notice,
    then: "After the user agrees and you have run howToAgree, run the same command again. If they decline, the skill stays unusable for this account.",
  }, null, 2));
  process.exit(TERMS_REQUIRED_EXIT_CODE);
}

/**
 * Call on any failed platform response. The platform refused because the terms
 * are not agreed (403 TERMS_REQUIRED — a new terms version, or a stale local
 * file): forget the local agreement, show the notice, exit. Otherwise returns.
 */
export function exitIfTermsRequired(status, json, command) {
  if (status !== 403 || json?.error?.code !== TERMS_REQUIRED_CODE) return;
  forgetAgreement(currentWallet());
  const details = json.error.details ?? {};
  refuse(command, termsNotice({
    currentVersion: details.termsVersion,
    termsUrl: details.termsUrl,
    notice: details.notice,
  }));
}

/**
 * For something that is ALREADY RUNNING (a hosting loop's next `wait`): never a
 * gate — the platform decides whether running work may continue — but the
 * notice to pass on while the account has not agreed, so the user hears about
 * it before their next operation is refused. Null once this wallet has agreed.
 */
export async function termsNoticeForRunning() {
  if (agreedLocally(readCache(), currentWallet())) return null;
  return termsNoticeIfPending();
}

/** For milestone outputs (login, link, aacp-next): the notice when not agreed, else nothing. */
export async function termsNoticeIfPending() {
  const status = await fetchTermsStatus();
  return status && !status.accepted ? termsNotice(status) : null;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function cmdStatus() {
  const status = await fetchTermsStatus();
  if (!status) {
    console.log(JSON.stringify({
      status: "unknown",
      hint: "Could not ask the platform — no credential yet (link or log in first), a backend without the terms, or the network.",
    }, null, 2));
    return;
  }
  console.log(JSON.stringify({
    status: status.accepted ? "accepted" : "not-accepted",
    termsVersion: status.currentVersion,
    acceptedAt: status.acceptedAt,
    acceptedVia: status.acceptedVia,
    termsUrl: webTermsUrl(status.termsUrl),
    ...(status.accepted ? {} : termsNotice(status)),
  }, null, 2));
}

async function cmdAccept(version) {
  if (typeof version !== "string" || !version) {
    throw new Error("--version <v> is required — the version shown to the user (from `status`), so they agree to the text they read.");
  }
  const token = loadSessionToken();
  if (!token) throw new Error("No credential. Link this terminal (`aacp-link.mjs start`) or log in (`a2a-runtime.mjs login`) first.");
  const res = await fetch(`${resolveApiBaseUrl()}/api/v1/terms/accept`, {
    method: "POST",
    headers: { ...termixClientHeaders(), authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ version, channel: "skill", ...(skillVersion() ? { skillVersion: skillVersion() } : {}) }),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`POST /api/v1/terms/accept → HTTP ${res.status}: ${json?.error?.message ?? text.slice(0, 200)}`);
  rememberAgreement(currentWallet(), json.version ?? version);
  console.log(JSON.stringify({ status: "accepted", ...json }, null, 2));
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const command = args[0] ?? "status";
  const versionIdx = args.indexOf("--version");
  try {
    if (command === "status") await cmdStatus();
    else if (command === "accept") await cmdAccept(versionIdx >= 0 ? args[versionIdx + 1] : undefined);
    else {
      process.stderr.write("Usage: node aacp-terms.mjs status | accept --version <v>\n");
      process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}
