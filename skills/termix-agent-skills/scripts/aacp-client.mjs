// The mark every request to Termix carries, so the platform can tell skill use
// apart from the website (backend lib/request-client.ts):
//
//   X-Termix-Client: skill/<version>
//   User-Agent:      termix-skill/<version> (node/<v>; <platform>)
//
// Every call to the Termix API and the Termix skill bucket spreads
// `termixClientHeaders()` into its headers. Third-party calls (LLM providers,
// public chain RPC, the Binance wallet CLI) do not — they are not ours to mark.
//
// Zero dependencies, no side effects on import (house style for this skill).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let version;

export function skillVersion() {
  if (version === undefined) {
    try {
      version = readFileSync(fileURLToPath(new URL("../VERSION", import.meta.url)), "utf8").trim() || null;
    } catch {
      version = null;
    }
  }
  return version;
}

// Best-effort: which harness this skill runs under, for operator fleet metrics
// (backend lib/skill-runtime.ts normalizes it). An installer can set the
// authoritative TERMIX_RUNTIME_ENV; otherwise we sniff well-known markers and fall
// back to "other". Never throws.
function detectRuntimeEnv() {
  const e = process.env;
  const override = e.TERMIX_RUNTIME_ENV?.trim();
  if (override) return override.slice(0, 40);
  if (e.OPENCLAW || e.OPENCLAW_SESSION || e.OPENCLAW_VERSION) return "openclaw";
  if (e.HERMES || e.HERMES_SESSION || e.HERMES_RUNTIME) return "hermes";
  if (e.CLAUDECODE === "1" || e.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (e.CODEX_SANDBOX || e.CODEX_HOME || e.CODEX_SESSION_ID) return "codex";
  if (e.CURSOR_TRACE_ID || e.CURSOR_SESSION) return "cursor";
  return "other";
}

// Best-effort model in use. Only a harness that exports it (or an explicit
// TERMIX_RUNTIME_MODEL) is known; otherwise "unknown". We never guess.
function detectRuntimeModel() {
  const e = process.env;
  const m = (e.TERMIX_RUNTIME_MODEL || e.ANTHROPIC_MODEL || e.CLAUDE_MODEL || e.CODEX_MODEL || e.OPENAI_MODEL || "").trim();
  return m ? m.slice(0, 60) : "unknown";
}

// `X-Termix-Runtime: env=<e>; model=<m>` — opt out entirely with TERMIX_TELEMETRY=off.
export function termixRuntimeHeader() {
  if ((process.env.TERMIX_TELEMETRY || "").trim().toLowerCase() === "off") return {};
  try {
    return { "x-termix-runtime": `env=${detectRuntimeEnv()}; model=${detectRuntimeModel()}` };
  } catch {
    return {};
  }
}

export function termixClientHeaders() {
  const v = skillVersion() ?? "unknown";
  return {
    "user-agent": `termix-skill/${v} (node/${process.versions.node}; ${process.platform})`,
    "x-termix-client": `skill/${v}`,
    ...termixRuntimeHeader(),
  };
}

// The platform refuses out-of-date skills with HTTP 426 + a SKILL_UPGRADE_REQUIRED body.
// On that response, print a clear, user-facing notice of what to run (and where) to
// upgrade, then stop — so a stale skill shows actionable guidance instead of a cryptic
// error. Called from every HTTP layer. No-op for any other response.
export function exitIfUpgradeRequired(status, json) {
  const err = json && typeof json === "object" ? json.error : null;
  if (status !== 426 && err?.code !== "SKILL_UPGRADE_REQUIRED") return;
  const d = (err && err.details) || {};
  const up = d.upgrade || {};
  const out = [
    "",
    "──────────────────────────────────────────────",
    "  Termix skill upgrade required",
    "──────────────────────────────────────────────",
    `  ${err?.message || "This Termix skill version is no longer accepted by the platform."}`,
    `  Your version: ${d.yourVersion || "(none — a build older than the version header)"}`,
    d.minVersion ? `  Required:     ${d.minVersion} or newer` : "",
    "",
    "  Upgrade now, then retry:",
    `    ${up.command || "node scripts/aacp-update.mjs apply"}`,
    up.url ? `    Details: ${up.url}` : "",
    "──────────────────────────────────────────────",
    "",
  ].filter((l) => l !== "");
  process.stderr.write(out.join("\n") + "\n");
  process.exit(1);
}
