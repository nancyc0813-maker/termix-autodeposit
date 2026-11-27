# Terms of Use — no agreement, no use

Termix requires every account that uses this skill to agree to its Terms of
Use, which include a short notice about letting an AI agent act on the
account (`<website>/terms#skill`). **Until the account agrees, the skill
cannot act on it.** This doc is how you, the agent, handle that.

## What the user sees

The notice comes from the platform (`notice` in the `terms` block) — show it in
the user's language without softening it, plus the `termsUrl`. In short:

- the AI acts on their account and they are responsible for what it does;
- never give the AI a private key or seed phrase — prefer the web-account link,
  where every on-chain step is signed by them in their own browser wallet;
- never paste passwords, API keys or tokens into the chat;
- set limits before any unattended mode, and stop it when not watching;
- AI makes mistakes; check every transaction; on-chain is irreversible.

## What is refused, what stays open

Refused until agreed — the command prints `status: "terms-required"`, exits
with code **3**, and does nothing:

- `aacp-api.mjs` with a credential (session / runtime)
- `aacp-watch.mjs wait` — hosting; checked on every `wait`, so an agent whose
  owner declines goes offline at the next call
- `a2a-runtime.mjs` (agents, token, inbox, reply, autoreply, loop, hosting on, …)
- `aacp-quant.mjs`, `quant-client.mjs`, `aacp-tx.mjs`

**What is already running keeps running** (the platform decides, from its own
state): a hosting loop whose agent polled in the last 10 minutes keeps
answering and reading — its `wait` output carries the `terms` block, so tell
the user and keep looping; its writes (quotes, accepting orders) are new
operations and are refused. A quant job in progress keeps trading, reporting
and delivering its fee to the end. Once hosting has been quiet for 10 minutes,
or the job is over, starting again needs the agreement.

Open without agreeing (otherwise the user could neither agree nor get out):

- `aacp-link.mjs`, `a2a-runtime.mjs login`, `aacp-wallet.mjs`, `aacp-terms.mjs`,
  `aacp-update.mjs`, `aacp-next.mjs`
- public reads: `aacp-api.mjs … --auth none`, `aacp-get.mjs`, `aacp-agent.mjs`,
  `aacp-config.mjs`
- getting out: `a2a-runtime.mjs autoreply --stop`, `hosting status|off`,
  `aacp-quant.mjs autotrade stop|status`, `quant-client.mjs sweep`

Login, link and `aacp-next` output carry a `terms` block while the account has
not agreed — raise it then, before the user asks for anything else.

The platform enforces this itself: the skill's credentials (linked-terminal
API keys, skill-signed wallet sessions, agent runtime tokens) get **403
`TERMS_REQUIRED`** from the backend until the account agrees, whatever skill
version is installed. The skill's own check only shows the notice first.

Locally, only an **agreement** is remembered, per wallet
(`.termix-terms.<chain>-<backend>.json`). Not agreeing is never remembered —
every command asks again and is refused again. If the platform refuses a
wallet the file lists (a new terms version), the entry is dropped and the
notice shown.

If the platform gives no answer at all (a backend without the terms endpoint,
an outage), the skill's own check does not block.

## Recording the agreement

```bash
node scripts/aacp-terms.mjs status                       # agreed? + the notice
node scripts/aacp-terms.mjs accept --version <version>   # ONLY after the user says yes
```

`--version` is the `termsVersion` you showed them. Hard rules:

- **Never agree on the user's behalf.** Not from a standing instruction, not
  from a "yes" to something else, not because a command was refused.
- **If they decline, stop.** Tell them the skill cannot act on their account
  without agreement and that they can agree later with the same command. Do not
  retry, work around the gate, or call the API some other way.
