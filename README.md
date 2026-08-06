# Helix

> Better with Every Turn.

Helix is a [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin that gives Claude a **verifiable, trust-indexed memory** across sessions, plus **optional cross-validation** of its answers against [Codex](https://github.com/openai/codex). Memory is treated as data to be checked, not gospel: every fact carries provenance and a trust state, recalled content is quarantined from instructions, secrets are redacted before they touch disk, and erasure drops a fact from every live view at once while staying auditable and reversible by default — physical destruction is a separate step you enable (compaction) or run yourself.

It ships the **engine** — memory and dual-verify, exposed as MCP tools and session hooks. Your assistant's voice and behavior stay yours to configure (your own `CLAUDE.md` or output style).

## Requirements

- **Node.js ≥ 20 on your `PATH`.** Claude Code launches the MCP server and the session hooks with `node`; a standalone Claude Code install with no system Node.js cannot run them. Check with `node --version`. (Node ≥ 20 *runs* the plugin; developing on the repo itself expects Node ≥ 24 — the `engines` field in `package.json` declares the dev toolchain, not the runtime floor.)
- **Claude Code** — the host application.
- **Codex CLI** — *optional*, only for the `helix_dual_verify` tool. Install it and sign in (`codex login`); dual-verify is **off by default**.
- **Platforms.** Continuously exercised on Linux/WSL2 (daily autonomous use); macOS is expected to work (POSIX semantics, hard-link file locking) but is not continuously exercised; **native Windows is not currently validated** — the locking layer's hard-link semantics have only been verified on POSIX filesystems. On Korean Windows hosts, set the console to UTF-8 (`chcp 65001`) — a cp949 console garbles non-ASCII output from any CLI in the chain.
- **Scale.** Correctness is exercised daily at tens-of-rows scale and was acceptance-tested on a frozen pilot corpus; recall latency is benchmark-characterized to a few thousand rows (cold-path ≈150 ms near ~3.3k union rows on the baseline machine). Treat ledgers **beyond ~2,500 union rows** (bulk imports, shared team ledgers) as outside the v0.1 validated envelope: an indexed-storage design is approved and deliberately unbuilt until real corpora approach that scale.

No build or `npm install` is needed to *use* Helix — the runtime ships as self-contained bundles under `bin/`.

## Install

```bash
claude plugin marketplace add wlsgur073/helix
claude plugin install helix@helix
```

Restart Claude Code, then confirm the server is live with `/mcp` (you should see **helix**). Update later with `claude plugin update helix@helix` (the `update` subcommand requires the full `plugin@marketplace` id; `uninstall` accepts the bare name); remove with `claude plugin uninstall helix`. Release notes: [CHANGELOG.md](./CHANGELOG.md). Two update caveats: `plugin update` skips reinstalling when the version string is unchanged (the cache is keyed by version) — for a same-version refresh (e.g. tracking a development branch) run `claude plugin uninstall helix` then `claude plugin install helix@helix` instead. And new bytes serve **new** Claude Code sessions only: restart Claude Code after any update (`/clear` does not restart the MCP server). Maintainers: full procedure in `docs/release/deploy-runbook.md`.

## Quick start

1. Ask Claude to remember something — "remember that staging runs Postgres 16 on port 5433". It calls `helix_memory_commit` and the fact lands in the ledger: secret-scanned, provenance-stamped, trust state `Fresh`. Helix exposes the tool but never tells your assistant *when* to reach for it — if you want that reflex to be reliable, say so in your own `CLAUDE.md`.
2. Open a new session — the **SessionStart** hook injects your current, trusted memory automatically as quarantined DATA. There is nothing to invoke.
3. Audit what is stored with `helix_memory_inspect`; remove anything with `helix_memory_erase` (a soft erase — it leaves every live view immediately, and stays reversible by default).
4. Per-project memory activates only when the project has a `.helix/` folder (see [Memory scope](#memory-scope)); Codex cross-checking stays off until you enable it (see [Configuration](#configuration)).

## What you get

Nine MCP tools:

| Tool | Purpose |
|------|---------|
| `helix_memory_commit` | Store a fact (secret-scanned, provenance recorded) |
| `helix_memory_recall` | Retrieve relevant memory as a quarantined DATA block |
| `helix_memory_inspect` | List current memory items with their trust state |
| `helix_memory_recheck` | Re-check a fact against reality (content-bound file check) → `Corroborated` (machine-checked, never `Verified`) |
| `helix_memory_confirm` | Promote a fact to `Verified` because you explicitly vouched for it (requires your approval; never self-confirm) |
| `helix_memory_erase` | Erase an item from every live view (soft: tombstoned and audited, recoverable until a compaction) |
| `helix_memory_adopt` | Trust the current project's pre-existing memory file (for a recognized/team-shared ledger; default-deny) |
| `helix_dual_verify` | Cross-check an answer with Codex (off by default) |
| `helix_codex_status` | Show Codex connection state (CLI/version, login, auth mode), dual-verify config, and content-log state — free, no metered call |

Two hooks run automatically: **SessionStart** injects current, trusted memory into the session; **SessionEnd** records the session. Global state lives under `~/.helix/` (`memory.jsonl`, `audit.jsonl`, `sessions.jsonl`, `config.json`, `projects.json`, plus `metrics.jsonl`, the rollback-witness state, and the ledger signing key). Project memory lives at `<project-root>/.helix/memory.jsonl` (see [Memory scope](#memory-scope) below).

## Configuration

Dual-verify is disabled by default. To enable it, create `~/.helix/config.json`. This is the only
file these settings are read from: a project's `.helix/config.json` is **not** consulted, because a
repository you opened must not be able to configure the process that opened it — turning the outbound
path on, releasing the egress legs, or enabling verbatim prompt logging are all decisions that belong
to you, not to a checkout. (If you have such a file from an earlier version, the server prints a note
at startup saying it is being ignored.)

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
- `stakesFloor` — skip the metered Codex call below this stakes level (`low` / `medium` / `high` / `xhigh`).
  It gates only calls that **declare** `stakes`. A call that omits the argument bypasses the floor and
  spends quota at any setting — omitting it is read as an explicit request, not as the lowest tier.
- `model` / `effort` — omit (or `null`) to inherit your `~/.codex/config.toml`; set to override for
  dual-verify only. Valid efforts are `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. Support varies
  by model — `codex debug models` lists what yours accepts.
- `timeoutMs` — Codex run timeout (default `1500000` = 25 min, clamped to 1 hour). The default covers
  routine `max`/`ultra` runs; a timeout kills the run *after* the quota is spent, so keep headroom if
  you lower it. `helix_codex_status` always shows the timeout and resolves the model even when inherited (a free
  `codex doctor --json` probe) — there is no such probe for effort, so an inherited effort prints only
  the literal `inherited from codex config` with no value, and the `max`/`ultra` advisory note fires only
  when `effort` is a Helix override, never on the inherited path.

A `mode`, `stakesFloor`, `model` or `effort` value that is present but invalid is ignored with a warning
on stderr, not silently.

`HELIX_HOME` relocates all state; `HELIX_LEDGER` points the memory ledger **file** elsewhere. The
split is deliberate: `HELIX_LEDGER` moves your data, never your trust store. The ledger signing key,
the ownership registry and the rollback witness always live under `HELIX_HOME`, because a signing key
that followed the ledger into a git-tracked tree would let anyone with the repo mint valid trust
grades. Two consequences worth knowing before you set it: if you back up your memory, back up that
file too — it is no longer inside `HELIX_HOME` — and repointing `HELIX_LEDGER` at a *different*
ledger later presents the rollback witness with a file it has never seen, which reads as tamper until
you re-bless the scope with the [re-baseline ceremony](./SECURITY.md).

If you used `HELIX_LEDGER` before v0.1.0, an older build wrote the trust store beside the ledger
instead. The server now refuses to start on that layout rather than silently minting a new key (which
would drop every `Corroborated`/`Verified` grade you have) — it prints both directories and the two
ways to resolve it.

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

- **Global config only.** These keys are read from `~/.helix/config.json` and nowhere else — as are
  every other setting on this page. A project
  `.helix/config.json` can neither enable nor tune compaction, so a repo you cloned cannot destroy your
  memory. That single global setting does still govern **both** your global ledger and an *owned* project
  ledger — each is gated independently.
- **When it fires.** At most **once per session**, synchronously, during a recall — the first one that
  rebuilds its index (a recall served from the in-process cache, i.e. unchanged ledger bytes, skips the
  check) and whose ledger passes every gate below. It never runs on a write, on a timer, or in the
  background. That single attempt is spent whether it **succeeds or fails**: a compaction that throws is
  swallowed (your recall still answers normally) but it is not retried until a new session. Whether the
  ledger is left byte-identical depends on **where** it failed. A failure before the atomic rename
  changes nothing and the writer retracts its own journal. A failure after the rename — the durability
  fsync or the transition completion — has already replaced the file: the live projection is preserved
  by construction, but soft-erased plaintext is gone and the undo window with it, and the scope
  self-heals on the next read rather than staying dark. Either way a failure surfaces as an
  `"ok": false` metric row *if metrics are enabled* (see Observability below) — never as a retry.
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
is a no-op, so you lose the operational detail — how much a compaction reclaimed, and whether it failed.
You do not lose the *fact* that the ledger was rewritten: every rewrite appends a content-free line to
`~/.helix/witness-log.jsonl` (`{"v":1,"scope":…,"epoch":…,"kind":"compaction","tx":…}`) regardless of the
metrics setting, so that file — not metrics — is the reliable answer to "did something rewrite my ledger,
and when?".

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

**Activation.** The project layer switches on automatically when the server is launched from a directory that has a `.helix/` folder. In the absence of that folder the server operates in global-only mode — it will never create a `.helix/` directory on its own. To opt a project in, create the folder yourself (`mkdir .helix` at the project root) and start a new session there: the first commit claims the empty layer automatically (a home-registry entry plus the in-repo `.owner` stamp) and creates the ledger. Only a pre-existing ledger that Helix did not create needs the explicit `helix_memory_adopt` gate below.

**Trust model (ownership gate).** A project ledger is read and written only if it is *owned*: a dual-key check matches a home-side registry entry (`~/.helix/projects.json`) against an in-repo stamp file (`.helix/.owner`). The registry lives in the user's home directory, so a freshly cloned repo cannot forge it. A foreign (cloned) ledger's content is excluded from reads — though a constant note discloses its presence — and writes to it are refused until you explicitly call `helix_memory_adopt`, after which the ledger's existing content becomes visible and future writes are accepted.

**Privacy by default.** Add `.helix/` to your repo's `.gitignore` — Helix never edits your `.gitignore` for you, and an untracked ledger stays private to each developer (this repository ignores its own `.helix/` the same way). To share project memory across a team, track `.helix/` instead and have each team member run `helix_memory_adopt` after cloning. Sharing is intentionally opt-in.

**Recall output.** Each recalled item is labeled with its scope: `DATA[Fresh:project]|` or `DATA[Fresh:global]|`. Items from both ledgers appear together in a single quarantined DATA block.

## Backup, restore & recovery

Helix's memory lives in plain files under your control. Back them up like any other data — here is what to expect on restore.

- **What to back up.** `~/.helix/` holds the global ledger (`memory.jsonl`), the signing key (`ledger-mac-master.key`), the rollback-witness state (`witness.json`) and its diagnostic log (`witness-log.jsonl`), config (`config.json`), and the project-ownership registry (`projects.json`). Each project's own `<project-root>/.helix/` is a second, independent unit. Back up both while no Claude Code session is running against them — an external backup tool isn't covered by Helix's own file lock, so copying mid-rewrite can catch an inconsistent instant. If you set `HELIX_LEDGER`, the global ledger is **not** inside `~/.helix/` — back up that file separately; everything else in the list stays under `HELIX_HOME` regardless.
- **Restoring.** Copy the directories back into place. **An intentionally restored older ledger will trip the rollback witness by design**: the witness lives in `~/.helix/` independently of whichever ledger bytes are on disk, so a restored file that no longer matches the head it last saw gets that scope's elevated grades clamped to `Fresh` plus a disclosure note. This is not a failure to route around — the legitimate way to adopt an old backup on purpose is the operator re-baseline ceremony: `node bin/helix-rebaseline.mjs --scope global` (or `--scope <absoluteProjectRoot>` for a project), an interactive, TTY-only command that is never run automatically. See [SECURITY.md's rollback witness section](./SECURITY.md#rollback-witness-cross-boundary-ledger-rollback) for the full mechanics.
- **Key loss.** Without `ledger-mac-master.key`, no signed `verify` record can validate, so any grade a `verify` record conferred — `Corroborated`, `Verified`, or `Suspect` — reverts to `Fresh` until a new key signs fresh verifications; for `Suspect` that reversion is a trust *increase*, not fail-low: the item's displayed state quietly reads `Fresh` again and the session hint loses its Suspect-specific wording, though such items (always non-authoritative) remain flagged for confirmation on source grounds. A new key is minted automatically on the next write; re-elevate a fact with `helix_memory_confirm`, or re-run `helix_memory_recheck` to restore a lapsed `Suspect` label. Losing the key never loses content — only a verify-conferred grade is affected.
- **Corruption.** A torn tail line (e.g. power loss mid-append) is repaired by the next writer, which prefixes a separator so its own record lands cleanly while the torn fragment is isolated as its own skipped line. A more structurally damaged line elsewhere in the ledger is simply excluded from the live view rather than guessed at or fabricated. Restore from backup for anything worse than a torn tail, and never hand-edit a ledger file while a session is running — Helix's own file lock coordinates only its own processes, not an external editor.
- **Migration & downgrade honesty.** The ledger is append-only JSONL with no schema migrations to date, and Helix does not yet guarantee forward or backward compatibility across versions before 1.0. Keep your backups across upgrades.
- **Undoing an erase or a wrong supersede.** There is no undo command, but a soft-erased or superseded fact is recoverable until a compaction — the recipes (and the trap that `inspect history` blanks erased content while `inspect asOf` returns it) are in [the recovery playbook](./docs/release/recovery-playbook.md), which also carries the verified backup command.

## Uninstall & data removal

`claude plugin uninstall helix` removes the plugin from Claude Code — **it never touches your data**. Everything Helix wrote stays on disk: `~/.helix/` (global ledger, signing key, witness state, config, metrics, project registry) and every per-project `<project-root>/.helix/`.

To remove the data too:

1. **List adopted projects first** — the keys of `~/.helix/projects.json` (all except the `@global` entry) are the project roots that may carry a `<root>/.helix/` ledger. Read it *before* deleting `~/.helix/`, or you lose the list.
2. Delete each `<project-root>/.helix/` you want gone (skip any a team shares via git).
3. Delete `~/.helix/`.

Partial-removal note: deleting only the signing key (`ledger-mac-master.key`) is the key-loss scenario above — verify-conferred grades revert to `Fresh`, content survives. Reinstalling the plugin later over surviving data just works (ledgers are plain files); restoring *older* copies of a ledger trips the rollback witness by design — see **Restoring** above.

## How it works

- **Trust states.** Every memory item is `Fresh`, `Corroborated`, `Verified`, or `Suspect`. A mechanical reality-check (`helix_memory_recheck`) can raise a fact to `Corroborated` (machine-checked at one moment in time); only you (`helix_memory_confirm`) can promote it to `Verified` — agreement from an external model never can (a provenance firewall, fail-closed).

  > **Tamper-evident at the file surface.** Trust is conferred only by `verify` records, each HMAC-SHA256-authenticated with a key held only in `~/.helix` (never written to the repo ledger). A forged or hand-edited ledger record replays as `Fresh`, so `Corroborated`/`Verified` are **unforgeable at the file surface against an adversary that cannot read `~/.helix`** — minting a grade by appending raw JSON to the ledger no longer works. This is *not* the tool surface: a `helix_memory_confirm` call still carries no enforceable human-approval signal, so do **not** add `helix_memory_confirm` to `permissions.allow` — it must prompt for your explicit approval. (Residuals: an adversary that can read `~/.helix` can mint valid MACs; rollback-by-suppression is undetected; trust is machine-local. See [SECURITY.md](./SECURITY.md).)
- **Re-verify before use.** A `Suspect` item on a high-blast-radius path must be re-checked before it is acted on.
- **Content quarantine.** Recalled memory and external-model output are framed as labeled DATA; forged frame markers are neutralized so stored text can never act as an instruction.
- **Secret hygiene.** Common credential formats and high-entropy tokens are redacted before anything is written. Dual-verify refuses to send a payload containing a secret to the external model, with one documented exemption on the egress side — hex-shaped and low-entropy-chain tokens are released by default unless you close the `secretEntropyExempt` leg. The write-path redaction has no such exemption.
- **Right-to-erasure (two-stage).** The `helix_memory_erase` tool is a **soft** erase: it appends a content-free tombstone to the ledger and records the erase in `audit.jsonl` (the id only, never the text), so the fact leaves every live surface — recall, inspect, SessionStart — immediately, while the original line stays in the ledger file until a compaction rewrites it. That surviving line is the undo window: it is what makes an erroneous or poisoned erase both detectable and recoverable (see [the recovery playbook](./docs/release/recovery-playbook.md)). Physical destruction — rewriting the ledger without the record — is the operator-run `permanent` path, deliberately kept off the agent tool surface so a prompt-injected agent cannot reach it; enabling [automatic compaction](#automatic-compaction-opt-in-off-by-default) destroys it too, which is exactly why compaction is opt-in and off by default. Either way, "physical" means durable namespace removal by Helix's own write paths, not media sanitization (see [SECURITY.md](./SECURITY.md)) — and the ledger is locked across processes, so concurrent sessions can't corrupt it or resurrect erased data.

## Trust & data flow (what runs on your machine)

Helix is local-first. Installing it lets Claude Code run code on your machine — here is exactly what that code does:

- **MCP server** (`node bin/helix-mcp.mjs`, launched by Claude Code): reads and writes memory under `~/.helix/` (and an owned `<project>/.helix/` ledger when present). It makes **no network calls** except the optional dual-verify path below.
- **Re-baseline ceremony** (`node bin/helix-rebaseline.mjs --scope global`, or `--scope <absoluteProjectRoot>` for a project; run by you): an interactive, TTY-only maintenance command that re-blesses a ledger scope after the rollback witness flags it as regressed (see [SECURITY.md](./SECURITY.md)). It is never launched automatically and is not exposed as an MCP tool.
- **Scale-trigger snapshot** (`node bin/helix-trigger.mjs`; run by you or your own scheduler, never launched by the plugin or by Claude Code): appends one content-free evaluation of the indexed-storage migration trigger (ledger row / byte / latency legs) to `~/.helix/trigger.jsonl` — the measurement behind the Scale note in [Requirements](#requirements).
- **Session hooks:** SessionStart reads your trusted memory and injects it into the session as quarantined DATA (never as instructions); SessionEnd appends a session record. Neither sends anything off-machine.
- **No telemetry.** Helix never phones home.
- **Metrics (local only):** Helix appends content-free latency/size records (tool op durations,
  ledger row/byte counts — never memory content, queries, paths, or error messages) to
  `~/.helix/metrics.jsonl` to sense when the ledger needs the planned SQLite migration.
  Disable with `metrics: { "enabled": false }` in `~/.helix/config.json` — the only file this
  setting is read from, for both the server and the SessionStart hook.

### What dual-verify sends (only when you enable it)

`helix_dual_verify` spawns the external **Codex CLI** to cross-check an answer. It is **off by default** (`dualVerify.enabled`).

- **Sent by Helix:** exactly the `question` + `helixAnswer` you pass to the tool. Helix composes the
  payload and adds nothing to it — no memory, no file contents.
- **What the CLI itself can still reach.** Codex is a separate program with its own model, and
  `-s read-only` sandboxes its *writes*, not its *reads*. Helix therefore starts it in an empty
  scratch directory, points its `--cd` there, and hands it a constructed environment rather than the
  server's own — so it does not begin in your project and does not inherit your variables. What
  remains, and is worth knowing before you enable this: a model that decides to read an absolute path
  it can guess is not stopped by any of that, and anything it reads leaves over Codex's own API
  connection, which Helix never sees. The egress guard governs the payload Helix builds; it is not a
  sandbox around the CLI. If that residue matters for your data, run Codex under an OS-level sandbox
  or leave dual-verify off.
- **Blocked before sending:** an egress guard refuses the call if the payload contains a named provider credential (override-proof), a heuristic- or entropy-detected secret (blocked by default, per-leg overridable), high-severity or bulk PII, or a verbatim copy of a stored memory. One entropy subclass is **released** by default — a token whose stripped core is pure hex (git SHA, digest) or a chain of individually low-entropy segments, with no credential keyword in the same statement. Close it with the `secretEntropyExempt` leg; the write path redacts those bytes regardless. See [SECURITY.md](./SECURITY.md) for why the exemption exists.
- **Refused rather than scanned:** the guard fails closed on size. A payload over 200,000 characters, or an aggregate ledger over 8,000,000 characters, is refused unscanned rather than sent — so a large enough call or a large enough ledger makes dual-verify unavailable, which is the intended failure direction.
- **Logging:** off by default. The exact prompt/response are written to `~/.helix/codex-log.jsonl` (`0o600`) only if you set `dualVerify.logContent: true`; the audit log stays content-free regardless.
- **Disable:** set `dualVerify.enabled: false` (the default) — or never create the config.

## Security & threat model

Helix is a defense kit for **memory & context poisoning** (OWASP Agentic Top 10 — ASI06). Its guarantees:

- **Provenance firewall (fail-closed):** a reality-check raises a fact only to `Corroborated`; only you can promote it to `Verified`; external agreement never can. `Corroborated`/`Verified` are tamper-evident at the file surface — conferred only by HMAC-authenticated `verify` records (key held only in `~/.helix`), so a forged or edited ledger record replays as `Fresh`. Unforgeable at the file surface against an adversary that cannot read `~/.helix`; still not an enforceable tool-surface approval (do **not** allow-list `helix_memory_confirm`).
- **Trust states & re-verify:** `Fresh / Corroborated / Verified / Suspect`, with re-verification required before a `Suspect` item is used on a high-blast-radius path.
- **Quarantine:** untrusted text is normalized and datamarked inside a nonce-framed DATA block, so it cannot act as an instruction.
- **Egress guard:** the only outbound path (dual-verify) is gated for secrets / PII / memory echo, and fails closed on size — an oversized payload or ledger is refused unscanned, never sent.

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

MIT — see [LICENSE](./LICENSE).
