# Changelog

All notable changes to Helix are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- `dualVerify.timeoutMs` is now clamped to a 1-hour maximum. A valid integer ≥ 1s is accepted
  and capped at 1h; previously a value above Node's `setTimeout` 32-bit ceiling fell back to the
  default. The Codex runner also hard-clamps the timeout at its boundary, so no run can exceed 1h.
- Codex dual-verify scratch directories are now created under a single `<temp>/helix/` folder
  instead of `helix-codex-*` scattered across the temp root, so scratch left behind by a cleanup
  race collects in one easily-purged place.

### Added
- Best-effort garbage collection of leaked Codex scratch directories: an age-based sweep
  (3-day floor, directories only, rate-limited to once a day) runs at runner start and never
  throws into the verify path.

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
