# Changelog

All notable changes to Helix are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Two-tier memory trust labels on the tool path: machine-corroborated **Corroborated**
  (`helix_memory_recheck`, a content-bound mechanical file check) and best-effort human-attested
  **Verified** (`helix_memory_confirm`). These are honest grading signals, **NOT adversary-proof**:
  a compromised agent with filesystem/ledger write can forge them by appending to the ledger. Do
  **not** allow-list `helix_memory_confirm`. Cryptographic ledger integrity is future work.
- Best-effort garbage collection of leaked Codex scratch directories: an age-based sweep
  (3-day floor, directories only, rate-limited to once a day) runs at runner start and never
  throws into the verify path.

### Changed
- `dualVerify.timeoutMs` is now clamped to a 1-hour maximum. A valid integer ≥ 1s is accepted
  and capped at 1h; previously a value above Node's `setTimeout` 32-bit ceiling fell back to the
  default. The Codex runner also hard-clamps the timeout at its boundary, so no run can exceed 1h.
- Codex dual-verify scratch directories are now created under a single `<temp>/helix/` folder
  instead of `helix-codex-*` scattered across the temp root, so scratch left behind by a cleanup
  race collects in one easily-purged place.
- Secret detection gains a `heuristic` confidence tier: the broad keyword-assignment matcher
  (`pass:`/`secret:`/`api_key:` + value) is no longer override-proof at the dual-verify egress
  guard — it still redacts on the write path, but its egress block is now policy-overridable.
- **Breaking config replacement:** `dualVerify.memoryEgress` (single `block`/`allow`) is replaced
  by `dualVerify.egressPolicy`, a per-leg map (`memoryEcho` / `piiHigh` / `piiBulk` /
  `secretHeuristic` / `secretEntropy`), each defaulting to `block`. Provider-format secrets stay
  override-proof. A leftover `memoryEgress` key is ignored with a startup warning.

## [0.1.0] — 2026-06-18

First public release.

### Added
- Trust-indexed, verifiable cross-session memory: an append-only JSONL ledger with a
  provenance firewall (fail-closed promotion), `Fresh / Verified / Suspect` trust
  states, blast-radius re-verify-before-use, crash-safe compaction, and a
  cross-process lock.
- Layered memory scope: a global ledger plus an ownership-gated per-project ledger
  (`helix_memory_adopt`, default-deny).
- Lexical recall ranker (coverage / phrase-first, BM25-assisted).
- Untrusted-content quarantine: NFKC/control/bidi normalization + per-line
  datamarking + a per-call 128-bit nonce frame.
- Optional Codex dual-verify (off by default) with a deterministic egress guard
  (secret / PII / memory-echo), plus `helix_codex_status` and an opt-in content log.
- Seven MCP tools and SessionStart/SessionEnd hooks, installable as a Claude Code
  plugin with self-contained committed bundles (no `npm install` to use).

### Security
- Secret-scan redaction on the memory write path; the dual-verify egress guard
  hard-blocks credential tokens (override-proof).
- Provenance firewall: agreement from an external model never promotes to `Verified`.
- Content-free audit log; the Codex content log is opt-in, `0o600`, and capped.

[Unreleased]: https://github.com/wlsgur073/helix/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/wlsgur073/helix/releases/tag/v0.1.0
