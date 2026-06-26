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

  > **Honest, not cryptographic.** `Corroborated` and `Verified` are good-faith grades on the tool surface, **not adversary-proof**: an agent with filesystem/ledger write can forge either by appending to the ledger. Do **not** add `helix_memory_confirm` to `permissions.allow` — it must prompt for your explicit approval. Cryptographic ledger integrity is future work.
- **Re-verify before use.** A `Suspect` item on a high-blast-radius path must be re-checked before it is acted on.
- **Content quarantine.** Recalled memory and external-model output are framed as labeled DATA; forged frame markers are neutralized so stored text can never act as an instruction.
- **Secret hygiene.** Common credential formats and high-entropy tokens are redacted before anything is written, and dual-verify refuses to send a payload containing a secret to the external model.
- **Right-to-erasure.** `erase` physically rewrites the ledger to remove the content, leaving only a content-free tombstone. The ledger is locked across processes, so concurrent sessions can't corrupt it or resurrect erased data.

## Trust & data flow (what runs on your machine)

Helix is local-first. Installing it lets Claude Code run code on your machine — here is exactly what that code does:

- **MCP server** (`node bin/helix-mcp.mjs`, launched by Claude Code): reads and writes memory under `~/.helix/` (and an owned `<project>/.helix/` ledger when present). It makes **no network calls** except the optional dual-verify path below.
- **Session hooks:** SessionStart reads your trusted memory and injects it into the session as quarantined DATA (never as instructions); SessionEnd appends a session record. Neither sends anything off-machine.
- **No telemetry.** Helix never phones home.

### What dual-verify sends (only when you enable it)

`helix_dual_verify` spawns the external **Codex CLI** to cross-check an answer. It is **off by default** (`dualVerify.enabled`).

- **Sent:** exactly the `question` + `helixAnswer` you pass to the tool — nothing else (no memory, no files).
- **Blocked before sending:** an egress guard refuses the call if the payload contains a credential (override-proof), high-severity or bulk PII, or a verbatim copy of a stored memory.
- **Logging:** off by default. The exact prompt/response are written to `~/.helix/codex-log.jsonl` (`0o600`) only if you set `dualVerify.logContent: true`; the audit log stays content-free regardless.
- **Disable:** set `dualVerify.enabled: false` (the default) — or never create the config.

## Security & threat model

Helix is a defense kit for **memory & context poisoning** (OWASP Agentic Top 10 — ASI06). Its guarantees:

- **Provenance firewall (fail-closed):** a reality-check raises a fact only to `Corroborated`; only you can promote it to `Verified`; external agreement never can. These are honest grades, not tamper-proof.
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
