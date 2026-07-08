# Changelog

All notable changes to Helix are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Dual-verify `xhigh` stakes tier: a 4th, strictest self-classified stakes level above `high`
  (`stakes` on `helix_memory`-adjacent `helix_dual_verify`, and `dualVerify.stakesFloor` in config).
  With `stakesFloor: "xhigh"`, only calls the agent classifies `xhigh` spend Codex quota — `high`
  and below are skipped. Omitting `stakes` still bypasses the floor (an explicit call signals intent).
- Replay metrics sensor: content-free op/replay latency records in `~/.helix/metrics.jsonl`
  (default on; `metrics.enabled: false` disables; hook honors the global config only). The
  sensor makes the long-deferred "migrate to SQLite at recall p95 > 150 ms" trigger observable.
- Standing replay benchmark `scripts/bench-replay.ts`: synthetic EN/KO sweep with REAL signed
  verify records (HMAC-era baseline), `--real` read-only mode, and a streaming `--report` mode
  with a windowed dual verdict against the 150 ms trigger.
- Recall index cache (A4): an in-process, single-slot cache keyed by content identity — the ledger
  byte digest, the resolved MAC-subkey fingerprint, and the scope set. On an unchanged ledger a warm
  recall reuses the verified projection and BM25 artifacts instead of re-reading and re-replaying, so
  repeated recalls within a session get materially cheaper. Invalidated by any ledger byte change
  (content-digest keyed, so even a same-length in-place edit misses), a master-key/subkey change, or a
  project-ownership flip; it is per-process and dies with the store. Observable metrics effect: a warm
  (HIT) recall emits no replay row to `metrics.jsonl` (a cold/MISS recall still emits one per scope).
- Two-tier memory trust labels on the tool path: machine-corroborated **Corroborated**
  (`helix_memory_recheck`, a content-bound mechanical file check) and best-effort human-attested
  **Verified** (`helix_memory_confirm`).
- Ledger HMAC: `Corroborated`/`Verified` are now **tamper-evident at the file surface**. Trust is
  conferred only by `verify` records, each HMAC-SHA256-authenticated with a key held only in
  `~/.helix` (per-project HKDF subkey; never written to the repo ledger). A forged or edited ledger
  record replays as `Fresh`, so minting an elevated grade by appending raw JSON to the ledger no
  longer works — **unforgeable at the file surface against an adversary that cannot read `~/.helix`**.
  Still **not** the tool surface: a `helix_memory_confirm` call carries no enforceable human-approval
  signal, so do **not** allow-list it. Documented residuals: an adversary that can read `~/.helix`
  can mint valid MACs (irreducible; a readable home key voids the guarantee); rollback-by-suppression
  (deleting a later `verify`) is undetected (home high-water counter is a follow-on); and trust is
  machine-local (a `Verified` grade does not transfer to another machine).
- Ledger MAC v2: `verify` records now bind their system-time `tx` into the MAC, so a genuine
  verification's *timing* cannot be edited in place (authenticity, not clock accuracy). Reads
  dual-accept existing v1 signatures, so no grades are lost; only new verifications become
  `tx`-bound. A cross-version gen collision from a stale reader resolves to the lower trust grade
  (never a permanent conflict), and an older binary can no longer destroy a newer version's records
  during compaction.
- Best-effort garbage collection of leaked Codex scratch directories: an age-based sweep
  (3-day floor, directories only, rate-limited to once a day) runs at runner start and never
  throws into the verify path.
- Forensic point-in-time snapshot: `helix_memory_inspect asOf=<ISO instant>` reconstructs which
  facts were live at a system-time, the grade each held, and the full verify evidence for why.
  Grade reconstruction shares the live projection's rule (asOf(now) == live grade); membership and
  legacy v1 verify timing are surfaced as declared, only v2 verify timing is authenticated.

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
- Secret detection: the `entropy` catch-all no longer **egress-blocks** a pure-hex literal (git SHA,
  content digest, hex keyId) at the dual-verify guard — it still redacts on the write path, but a bare
  hex token in security-design prose no longer wedges `helix_dual_verify`. A credential keyword in the
  same statement (e.g. `secret <hex>`) keeps the block, and rich-alphabet (base62/64) tokens are
  unaffected. Release the residual via `dualVerify.egressPolicy.secretEntropy: 'allow'` as before.
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
