# Helix

> Better with Every Turn.

Helix is a [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin that gives Claude a **verifiable, trust-indexed memory** across sessions, plus **optional cross-validation** of its answers against [Codex](https://github.com/openai/codex). Memory is treated as data to be checked, not gospel: every fact carries provenance and a trust state, recalled content is quarantined from instructions, secrets are redacted before they touch disk, and erasure is physical.

It ships the **engine** — memory and dual-verify, exposed as MCP tools and session hooks. Your assistant's voice and behavior stay yours to configure (your own `CLAUDE.md` or output style).

## Requirements

- **Node.js ≥ 20 on your `PATH`.** Claude Code launches the MCP server and the session hooks with `node`; a standalone Claude Code install with no system Node.js cannot run them. Check with `node --version`.
- **Claude Code** — the host application.
- **Codex CLI** — *optional*, only for the `helix_dual_verify` tool. Install it and sign in (`codex login`); dual-verify is **off by default**.

No build or `npm install` is needed to *use* Helix — the runtime ships as self-contained bundles under `bin/`.

## Install

```bash
claude plugin marketplace add wlsgur073/helix
claude plugin install helix@helix
```

Restart Claude Code, then confirm the server is live with `/mcp` (you should see **helix**). Update later with `claude plugin update helix`; remove with `claude plugin uninstall helix`.

## What you get

Nine MCP tools:

| Tool | Purpose |
|------|---------|
| `helix_memory_commit` | Store a fact (secret-scanned, provenance recorded) |
| `helix_memory_recall` | Retrieve relevant memory as a quarantined DATA block |
| `helix_memory_inspect` | List current memory items with their trust state |
| `helix_memory_recheck` | Re-check a fact against reality (content-bound file check) → `Corroborated` (machine-checked, never `Verified`) |
| `helix_memory_confirm` | Promote a fact to `Verified` because you explicitly vouched for it (requires your approval; never self-confirm) |
| `helix_memory_erase` | Physically erase an item (right-to-erasure) |
| `helix_memory_adopt` | Trust the current project's pre-existing memory file (for a recognized/team-shared ledger; default-deny) |
| `helix_dual_verify` | Cross-check an answer with Codex (off by default) |
| `helix_codex_status` | Show Codex connection state (CLI/version, login, auth mode), dual-verify config, and content-log state — free, no metered call |

Two hooks run automatically: **SessionStart** injects current, trusted memory into the session; **SessionEnd** records the session. Global state lives under `~/.helix/` (`memory.jsonl`, `audit.jsonl`, `sessions.jsonl`, `config.json`, `projects.json`). Project memory lives at `<project-root>/.helix/memory.jsonl` (see [Memory scope](#memory-scope) below).

## Configuration

Dual-verify is disabled by default. To enable it, create `~/.helix/config.json` (user-wide) or `.helix/config.json` (per-project):

```json
{
  "dualVerify": {
    "enabled": true,
    "mode": "compare",
    "stakesFloor": "high"
  }
}
```

- `mode` — `compare` (independent answer + an agreement map) or `critique` (Codex reviews your answer).
- `stakesFloor` — skip the metered Codex call below this stakes level (`low` / `medium` / `high`).
- `model` / `effort` — omit (or `null`) to inherit your `~/.codex/config.toml`; set to override for dual-verify only.

`HELIX_HOME` relocates all state; `HELIX_LEDGER` points the memory ledger elsewhere.

### Automatic compaction (opt-in, off by default)

Over time a ledger accumulates dead rows (superseded facts, erased content, closed history). Compaction
rewrites it down to the live projection. Helix can do this for you, but it is **destructive**, so it is
off unless you turn it on:

```json
{
  "compaction": {
    "auto": true,
    "dirtyRatio": 0.5,
    "minRows": 200,
    "minDirtyBytes": 1048576,
    "graceMs": 86400000,
    "maxBytes": 52428800
  }
}
```

> **Read this before enabling it.** Compaction drops *every* dead record, however recently it died —
> there is no per-record age filter. Once a ledger has been idle past `graceMs`, an ordinary
> `helix_memory_recall` can **permanently close the soft-erase undo window** — a soft-erased fact stays
> recoverable on disk only until a compaction, which physically destroys it — and **drop recent
> point-in-time `asOf` / `history` rows**. What a recall returns is unaffected: the live projection is
> preserved by construction.

- **Global config only.** These keys are read from `~/.helix/config.json` and nowhere else. A project
  `.helix/config.json` can neither enable nor tune compaction, so a repo you cloned cannot destroy your
  memory. That single global setting does still govern **both** your global ledger and an *owned* project
  ledger — each is gated independently.
- **When it fires.** At most **once per session**, synchronously, during a recall — the first one that
  rebuilds its index (a recall served from the in-process cache, i.e. unchanged ledger bytes, skips the
  check) and whose ledger passes every gate below. It never runs on a write, on a timer, or in the
  background. That single attempt is spent whether it **succeeds or fails**: a compaction that throws is
  swallowed (your recall still answers normally, and the ledger is left byte-identical) but it is not
  retried until a new session. A failure surfaces as an `"ok": false` metric row *if metrics are enabled*
  (see Observability below) — never as a retry.
- `auto` (bool, default `false`) — the master switch.
- `dirtyRatio` — `(0, 1]`, default `0.5`. Fire when reclaimable rows / total rows reaches this.
- `minDirtyBytes` — integer ≥ 1, default `1048576` (1 MiB). Alternative trigger: fire when the exact
  reclaimable byte count reaches this, whatever the ratio.
- `minRows` — integer ≥ 0, default `200`. Never compact a ledger with fewer physical rows.
- `graceMs` — integer ≥ 0, default `86400000` (24 h). Required idle time since the ledger file's **last
  write** (its mtime). This is the window that protects your undo. `graceMs: 0` disables the grace
  entirely — a fact soft-erased moments ago can be destroyed by the very next eligible recall, with no
  undo window at all.
- `maxBytes` — integer > 0, default `52428800` (50 MiB). Skip ledgers larger than this.

Invalid or out-of-range values are ignored and the default is kept (Helix never fails to start over a
config typo).

**Observability.** When metrics are enabled (`metrics.enabled`, the default), every attempt appends a
content-free `compaction` record to `~/.helix/metrics.jsonl`, failed attempts included (`"ok": false`).
Its `reclaimed_bytes` can legitimately be **negative** when a compaction drops little but adds a
content-free audit tombstone, so the file net-grew. If you set `metrics.enabled: false`, the metrics sink
is a no-op and compactions — successful *or* failed — leave **no trace at all**. Enabling a destructive
operation with metrics turned off means you cannot tell whether it ever ran.

**Known v1 limitations.** This is not a size cap. Preserved audit data — erase tombstones and genuine
signed verifies on live facts — is never reclaimed, so it does not bound total ledger size. A ledger you
write to constantly may **never** auto-compact, because quiescence is required and there is no max-lag
force-compaction. A ledger already above `maxBytes` is skipped and gets no automatic relief; compact it
manually. And a **forward clock jump of at least `graceMs`** (a bad RTC at boot, a restored VM snapshot)
can make a just-written ledger look idle and fire compaction early, closing the undo window ahead of
schedule — quiescence compares file mtime against the wall clock, and the read path has no monotonic
reference. A backward jump only defers compaction, never fires it early. In none of these cases is
ledger **integrity** at risk: compaction holds the ledger lock across read → rewrite → atomic rename, so
a concurrent append is never lost and erased content is never resurrected.

## Memory scope

Helix keeps two ledgers that it always reads together:

| Scope | Location | When active |
|-------|----------|-------------|
| **Global** | `~/.helix/memory.jsonl` | Always |
| **Project** | `<project-root>/.helix/memory.jsonl` | Only when `<cwd>/.helix/` exists on server startup |

**Activation.** The project layer switches on automatically when the server is launched from a directory that has a `.helix/` folder. In the absence of that folder the server operates in global-only mode — it will never create a `.helix/` directory on its own.

**Trust model (ownership gate).** A project ledger is read and written only if it is *owned*: a dual-key check matches a home-side registry entry (`~/.helix/projects.json`) against an in-repo stamp file (`.helix/.owner`). The registry lives in the user's home directory, so a freshly cloned repo cannot forge it. A foreign (cloned) ledger is silently ignored on recall and refused on write until you explicitly call `helix_memory_adopt` — after which the ledger's existing content becomes visible and future writes are accepted.

**Privacy by default.** `.helix/` is gitignored, so project memory stays private to each developer. To share project memory across a team, un-ignore `.helix/` in your repo and have each team member run `helix_memory_adopt` after cloning. This is intentionally opt-in.

**Recall output.** Each recalled item is labeled with its scope: `DATA[Fresh:project]|` or `DATA[Fresh:global]|`. Items from both ledgers appear together in a single quarantined DATA block.

## How it works

- **Trust states.** Every memory item is `Fresh`, `Corroborated`, `Verified`, or `Suspect`. A mechanical reality-check (`helix_memory_recheck`) can raise a fact to `Corroborated` (machine-checked at one moment in time); only you (`helix_memory_confirm`) can promote it to `Verified` — agreement from an external model never can (a provenance firewall, fail-closed).

  > **Tamper-evident at the file surface.** Trust is conferred only by `verify` records, each HMAC-SHA256-authenticated with a key held only in `~/.helix` (never written to the repo ledger). A forged or hand-edited ledger record replays as `Fresh`, so `Corroborated`/`Verified` are **unforgeable at the file surface against an adversary that cannot read `~/.helix`** — minting a grade by appending raw JSON to the ledger no longer works. This is *not* the tool surface: a `helix_memory_confirm` call still carries no enforceable human-approval signal, so do **not** add `helix_memory_confirm` to `permissions.allow` — it must prompt for your explicit approval. (Residuals: an adversary that can read `~/.helix` can mint valid MACs; rollback-by-suppression is undetected; trust is machine-local. See [SECURITY.md](./SECURITY.md).)
- **Re-verify before use.** A `Suspect` item on a high-blast-radius path must be re-checked before it is acted on.
- **Content quarantine.** Recalled memory and external-model output are framed as labeled DATA; forged frame markers are neutralized so stored text can never act as an instruction.
- **Secret hygiene.** Common credential formats and high-entropy tokens are redacted before anything is written, and dual-verify refuses to send a payload containing a secret to the external model.
- **Right-to-erasure.** `erase` physically rewrites the ledger to remove the content, leaving only a content-free tombstone. The ledger is locked across processes, so concurrent sessions can't corrupt it or resurrect erased data.

## Trust & data flow (what runs on your machine)

Helix is local-first. Installing it lets Claude Code run code on your machine — here is exactly what that code does:

- **MCP server** (`node bin/helix-mcp.mjs`, launched by Claude Code): reads and writes memory under `~/.helix/` (and an owned `<project>/.helix/` ledger when present). It makes **no network calls** except the optional dual-verify path below.
- **Session hooks:** SessionStart reads your trusted memory and injects it into the session as quarantined DATA (never as instructions); SessionEnd appends a session record. Neither sends anything off-machine.
- **No telemetry.** Helix never phones home.
- **Metrics (local only):** Helix appends content-free latency/size records (tool op durations,
  ledger row/byte counts — never memory content, queries, paths, or error messages) to
  `~/.helix/metrics.jsonl` to sense when the ledger needs the planned SQLite migration.
  Disable with `metrics: { "enabled": false }` in `~/.helix/config.json` (the SessionStart
  hook honors the global config only; a per-project `.helix/config.json` setting silences
  just that project's server records).

### What dual-verify sends (only when you enable it)

`helix_dual_verify` spawns the external **Codex CLI** to cross-check an answer. It is **off by default** (`dualVerify.enabled`).

- **Sent:** exactly the `question` + `helixAnswer` you pass to the tool — nothing else (no memory, no files).
- **Blocked before sending:** an egress guard refuses the call if the payload contains a credential (override-proof), high-severity or bulk PII, or a verbatim copy of a stored memory.
- **Logging:** off by default. The exact prompt/response are written to `~/.helix/codex-log.jsonl` (`0o600`) only if you set `dualVerify.logContent: true`; the audit log stays content-free regardless.
- **Disable:** set `dualVerify.enabled: false` (the default) — or never create the config.

## Security & threat model

Helix is a defense kit for **memory & context poisoning** (OWASP Agentic Top 10 — ASI06). Its guarantees:

- **Provenance firewall (fail-closed):** a reality-check raises a fact only to `Corroborated`; only you can promote it to `Verified`; external agreement never can. `Corroborated`/`Verified` are tamper-evident at the file surface — conferred only by HMAC-authenticated `verify` records (key held only in `~/.helix`), so a forged or edited ledger record replays as `Fresh`. Unforgeable at the file surface against an adversary that cannot read `~/.helix`; still not an enforceable tool-surface approval (do **not** allow-list `helix_memory_confirm`).
- **Trust states & re-verify:** `Fresh / Corroborated / Verified / Suspect`, with re-verification required before a `Suspect` item is used on a high-blast-radius path.
- **Quarantine:** untrusted text is normalized and datamarked inside a nonce-framed DATA block, so it cannot act as an instruction.
- **Egress guard:** the only outbound path (dual-verify) is gated for secrets / PII / memory echo.

**Out of scope:** the dual-verify echo check is a verbatim-copy tripwire, not a robust exfiltration guard against a host model that transforms content. The primary boundary is the provenance firewall + secret-scan + DATA-quarantine.

Report vulnerabilities privately — see [SECURITY.md](./SECURITY.md).

## Development

```bash
git clone https://github.com/wlsgur073/helix
cd helix
npm install
npm run build      # esbuild → bin/ (committed: a cloned plugin gets no npm install)
npm test           # vitest — rebuild bin/ first after editing bundled src
npm run typecheck
```

The runtime targets **Node ≥ 20**; development (the toolchain) expects **Node ≥ 24**. `bin/` is committed on purpose, so an installed plugin runs with no install step.

## License

See [LICENSE](./LICENSE).
