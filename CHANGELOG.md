# Changelog

This file records what shipped in each release of Helix. It follows
[Semantic Versioning](https://semver.org/).

## [0.1.0]

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
- Nine MCP tools and SessionStart/SessionEnd hooks, installable as a Claude Code
  plugin with self-contained committed bundles (no `npm install` to use).
- Codex 5.6 reasoning efforts. `dualVerify.effort` now accepts `max` and `ultra`. Per-model support
  varies and Helix does not arbitrate it — `codex debug models` is the authority.
- `helix_codex_status` now reports the effective model, the configured effort, and the run timeout.
  When `dualVerify.model` is `null` (inherit), it resolves the name from a free
  `codex doctor --json` probe; a failed probe prints `(unresolved)` rather than guessing. There is no
  equivalent probe for effort — `codex doctor --json` does not report `model_reasoning_effort` — so when
  `dualVerify.effort` is `null` the line prints only the literal `inherited from codex config`, and the
  advisory note below never fires on that path. A Helix-set (non-`null`) `max` or `ultra` effort at a run
  timeout of `300000` ms or less prints that advisory note, because a timeout tree-kills the run after
  the Codex quota is spent.
- Automatic compaction trigger — **opt-in, GLOBAL config only, default OFF** (`compaction.auto`).
  When enabled, a recall whose ledger passes every gate rewrites that ledger through the existing
  crash-safe `compactLedger` (ledger lock held across read → rewrite → atomic rename), synchronously,
  at most once per session. It is checked on the first recall that rebuilds its index — a recall served
  from the in-process recall cache (unchanged ledger bytes) skips the check entirely. The attempt is
  counted whether it **succeeds or fails**: a compaction that throws is swallowed (it never breaks the
  recall) but still consumes the session's single attempt, and is not retried until a new session. It
  surfaces as an `ok: false` metric row *if metrics are enabled* (see below). That failure path splits at
  the rename. A throw **before** it leaves the ledger byte-identical — `compactLedger` writes a tmp file
  and renames — and the writer retracts its own journal, so nothing was dropped. A throw **after** it
  (the directory fsync, or completing the witness transition) is a failure over a ledger that has
  already been replaced: the live projection survives by construction, but the soft-erase undo window
  does not, and the scope recovers through `transition-heal` on the next read. The metric row tells the
  two apart: `landed` is `false` for a before-the-rename throw (`dropped_rows`/`reclaimed_bytes` are
  honestly `0`, nothing happened) and `true` for an after-the-rename throw, where `dropped_rows`/
  `reclaimed_bytes` report the REAL counts the rewrite actually wrote, not a zeroed default.

  **The consequence you are opting into.** Compaction drops *every* dead record, however recently it
  died — it has no per-record age filter. So once a ledger goes quiescent past the grace window
  (`compaction.graceMs`, default 24 h since the ledger file's **last write**), an ordinary
  `helix_memory_recall` can **permanently close the soft-erase undo window** and **drop recent
  point-in-time (`asOf` / `history`) rows**. What a recall *answers* is unchanged: the live projection
  is preserved by construction.

  Because the config is destructive it is read from the **global `~/.helix/config.json` only** — a
  cloned repo's `.helix/config.json` can neither enable nor tune it. That one global setting still
  governs compaction of **both** the global ledger and an *owned* project ledger, each gated
  independently.

  Keys (invalid or out-of-range values silently keep the default): `auto` (bool, `false`),
  `dirtyRatio` in `(0, 1]` (`0.5`), `minRows` int ≥ 0 (`200`), `minDirtyBytes` int ≥ 1 (`1048576`),
  `graceMs` int ≥ 0 (`86400000`), `maxBytes` int > 0 (`52428800`). `graceMs: 0` disables the grace
  entirely — a fact soft-erased moments ago can be destroyed by the very next eligible recall, with no
  undo window at all.

  Self-limiting: a compacted ledger has *essentially* zero reclaimable rows and bytes, so it will not
  re-compact until new churn. The content-free integrity/horizon tombstones a compaction mints (see
  below) are a **coalesced canonical fixpoint** — constant ids (`integrity_marker` / `horizon_marker`)
  and fixed sentinel timestamps — so a later compaction *re-mints the byte-identical row*, it does not
  drop it. That makes the self-limiting argument *stronger*, not weaker: a preserved marker is
  simultaneously read (in the compaction's input rows) and rewritten (in its kept set) every time, so
  it contributes exactly **zero** to `reclaimable = records.length - kept.length` — the very count the
  next compaction's dirty-gate is computed from. It also cannot re-trigger the gates by growth alone:
  one ~330-byte row satisfies neither the default `dirtyRatio` (at the default `minRows` of 200,
  `1/200` is far below `0.5`) nor the default `minDirtyBytes` of 1 MiB.

  Observable **when metrics are enabled** (`metrics.enabled`, the default): every attempt emits a
  content-free `compaction` record to `~/.helix/metrics.jsonl`, failures included (`ok: false`). Its
  `reclaimed_bytes` is **legitimately negative** when a compaction drops little but mints a content-free
  horizon/integrity tombstone — the ledger net-grew, and that is reported, not clamped. The record also
  carries `dropped_forged_verifies`: a content-free count of forged `verify` rows this compaction
  destroyed under HMAC-aware compaction (`0` when compaction ran without a resolvable subkey, or
  genuinely dropped none) — the forensic counterpart to the integrity marker's mere presence, which is
  itself forgeable (see below); and `landed`, a boolean recording whether the rewrite physically reached
  disk for this attempt (see the rename-split note above) — the field that lets `dropped_rows`/
  `reclaimed_bytes` be trusted on an `ok: false` row instead of read as an unconditional zero. With
  `metrics.enabled: false` the sink is a no-op, so **neither a successful nor a failed compaction leaves
  any trace**: turning compaction on while metrics are off means a destructive operation runs with zero
  visibility.

  Named v1 limitations (spec §7). It does **not** bound total ledger size: preserved audit data (erase
  tombstones, genuine signed verifies on live targets) is never reclaimed. A continuously churny ledger
  may **never** auto-compact — quiescence is required and there is no max-lag force-compaction. A ledger
  already above `maxBytes` is skipped and gets **no automatic relief**; it defers to manual/incremental
  compaction. And a **forward clock step of at least `graceMs`** (bad RTC at boot, VM snapshot restore)
  can make a just-written ledger read as quiescent and fire early, closing the undo window ahead of
  schedule — quiescence is file-mtime versus wall clock, and the read path has no monotonic reference.
  Backward skew only defers, never fires early. **Ledger integrity is never at risk in any of these
  cases**: the compaction lock plus the atomic rename hold regardless.
- Dual-verify `xhigh` stakes tier: a 4th, strictest self-classified stakes level above `high`
  (`stakes` on `helix_memory`-adjacent `helix_dual_verify`, and `dualVerify.stakesFloor` in config).
  With `stakesFloor: "xhigh"`, only calls the agent classifies `xhigh` spend Codex quota — `high`
  and below are skipped. Omitting `stakes` is read as the lowest tier, so any floor above `low`
  refuses an undeclared call — omission is not an exemption.
- Every `helix_dual_verify` result whose payload was actually TRANSMITTED — a successful `sent` run
  AND a run that reached Codex but then errored out — now carries an `egress: ...` disclosure line,
  rendered ABOVE the quarantine frame, so the calling agent can tell a config-valved release from a
  clean pass instead of crediting the pass to its own prose. That includes the failure path: the prompt
  already left the machine before Codex exited non-zero, so the disclosure renders there too, not just
  on success. A refused (firewall-blocked), unavailable (runner never invoked), or skipped (disabled /
  below the stakes floor) result carries no disclosure line, because nothing left the machine. Three
  forms: `pass` (every leg clean), `pass with audit-only legs` (a leg logged the check but did not
  block), and `allowed_override with released policy keys + audit-only legs` (an otherwise-blocking leg
  was released by `dualVerify.egressPolicy`). The line is content-free — it names leg outcomes and
  policy keys, never the scanned content.
- Replay metrics sensor: content-free op/replay latency records in `~/.helix/metrics.jsonl`
  (default on; `metrics.enabled: false` disables; hook honors the global config only). The
  sensor makes the long-deferred "migrate to SQLite at recall p95 > 150 ms" trigger observable.
- Standing replay benchmark `scripts/bench-replay.ts`: synthetic EN/KO sweep with REAL signed
  verify records (HMAC-era baseline), `--real` read-only mode, and a streaming `--report` mode with a
  windowed, **tri-state** verdict (`exceeded` / `below` / `insufficient`) against the 150 ms trigger,
  computed from **successful** recalls only — a failed recall carries no latency signal, so it no
  longer counts toward a confident `below` verdict. `insufficient` requires fewer than 20 successful
  samples in the window and renders an explicit reason (`no successful samples` vs. `n < 20`); with at
  least one successful sample it still renders the provisional p95-vs-trigger comparison, just flagged
  as provisional, so a single lucky/unlucky sample is visible but never mistaken for a confident
  judgment.
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
  (deleting a later `verify`) is invisible to the per-record MAC alone — the rollback witness
  (below) closes that gap; and trust is machine-local (a `Verified` grade does not transfer to
  another machine).
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
- Bitemporal history: `helix_memory_inspect history` reconstructs every fact's system-time
  `[tx, txTo)` interval across the whole ledger — when it became live and, if closed, when and by
  what (`supersede` / `invalidate` / `erase`) — computed atomically alongside the live projection
  in the same single read `asOf` uses. An unresolvable master key clamps every grade shown to
  `Fresh` with an explicit note, the same policy `asOf` and recall already apply, rather than
  silently trusting stale evidence.
- Lock durability hardening: the cross-process ledger lock is now published atomically together
  with its owner payload (`linkSync`), so a live creator can never present a malformed lock file,
  and a liveness matrix — never age — decides whether a recorded holder is reclaimed: only a
  provably-dead holder is ever stolen, and every reclaim is serialized through a per-boot reaper
  gate so two reapers can never act on the same victim. Every append and compaction now fsyncs
  both the data and the containing directory before reporting success, and a hard-linked ledger
  (link count ≠ 1) is refused outright, since two alias names would carry two independent locks
  with no mutual exclusion.
- Rollback witness (high-water counter): a home-side, per-scope witness (`~/.helix/witness.json`,
  MAC'd with the same master key as `verify` records) detects a ledger that has forked from or
  fallen behind the head it last saw — a regression the per-record MAC alone cannot catch, because
  a restored older ledger file is itself validly signed. A detected mismatch clamps that scope's
  `Verified`/`Corroborated` grades to `Fresh` on every live projection (recall, inspect, the
  SessionStart hook) and renders a constant disclosure note; the scope keeps serving reads and
  accepting new appends, but the witness itself never advances past a mismatch until an explicit
  re-baseline. Fenced to each scope's current head only — never a history of erased eras — and
  kept honest by a content-free marker planted at the end of every legitimate rewrite. Armed from
  the first release, not opt-in; first contact, a key rotation, and a deleted witness file are all
  honest trust-on-first-use, each surfaced by its own note.
- Operator re-baseline ceremony: `node bin/helix-rebaseline.mjs --scope global` (or
  `--scope <projectRoot>`) is the only sanctioned way to clear a rollback-witness mismatch — an
  interactive, TTY-only command that displays the mismatched scope's hash and target epoch,
  requires a typed confirmation, and holds the ledger lock from that display through the commit.
  It is deliberately not an MCP tool: no agent-suppliable parameter can invoke it, and nothing
  invokes it automatically.
- Dual-verify configuration, read from the global `~/.helix/config.json` only — a checkout's
  `.helix/config.json` can neither enable the outbound path nor loosen it: `enabled` (bool, default
  `false`), `mode`, `model` (bounded at 64 characters, or `null` to inherit `~/.codex/config.toml`),
  `effort`, `stakesFloor`, `timeoutMs` (a valid integer ≥ 1 s, clamped to a 1-hour maximum at the
  config boundary and again in the Codex runner), and `egressPolicy` — a per-leg map over
  `memoryEcho`, `piiHigh`, `piiBulk`, `secretHeuristic`, `secretEntropy` and `secretEntropyExempt`.
  Each leg is `block` or `allow`. All default to `block` except `secretEntropyExempt`, which defaults
  to `allow` and is what releases a hex-shaped or low-entropy-chain token — a git SHA quoted in
  design prose — past the egress guard while the write path still redacts it. Provider-format
  credentials are override-proof: no policy value releases them. An invalid value on any of these
  keys is refused with a bounded single-line stderr warning and the default is kept, so a crafted
  newline in a key or value cannot forge a second diagnostic line; an absent key is silent.
- Two environment inputs place Helix's state. `HELIX_HOME` (default `~/.helix`) is where the ledger
  signing key, the ownership registry, the rollback witness, the audit log and the metrics stream
  are always created; `HELIX_LEDGER` moves the global ledger data file and nothing else. A server
  that finds trust-store files beside a relocated ledger refuses to start and names both
  directories, rather than minting a fresh key and silently dropping every grade the old one
  conferred.
