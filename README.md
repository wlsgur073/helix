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

Five MCP tools:

| Tool | Purpose |
|------|---------|
| `helix_memory_commit` | Store a fact (secret-scanned, provenance recorded) |
| `helix_memory_recall` | Retrieve relevant memory as a quarantined DATA block |
| `helix_memory_inspect` | List current memory items with their trust state |
| `helix_memory_erase` | Physically erase an item (right-to-erasure) |
| `helix_dual_verify` | Cross-check an answer with Codex (off by default) |

Two hooks run automatically: **SessionStart** injects current, trusted memory into the session; **SessionEnd** records the session. State lives under `~/.helix/` (`memory.jsonl`, `audit.jsonl`, `sessions.jsonl`, `config.json`).

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

## How it works

- **Trust states.** Every memory item is `Fresh`, `Verified`, or `Suspect`. Only you or a reality-check can promote an item to `Verified` — agreement from an external model never can (a provenance firewall, fail-closed).
- **Re-verify before use.** A `Suspect` item on a high-blast-radius path must be re-checked before it is acted on.
- **Content quarantine.** Recalled memory and external-model output are framed as labeled DATA; forged frame markers are neutralized so stored text can never act as an instruction.
- **Secret hygiene.** Common credential formats and high-entropy tokens are redacted before anything is written, and dual-verify refuses to send a payload containing a secret to the external model.
- **Right-to-erasure.** `erase` physically rewrites the ledger to remove the content, leaving only a content-free tombstone. The ledger is locked across processes, so concurrent sessions can't corrupt it or resurrect erased data.

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
