# Changelog

This file records what shipped in each release of Helix. It follows
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-09

First release.

### Added

#### Memory, trust, and integrity

- Trust-indexed, verifiable cross-session memory: an append-only JSONL ledger with a provenance
  firewall (fail-closed promotion), `Fresh / Corroborated / Verified / Suspect` trust states,
  blast-radius re-verify-before-use, crash-safe compaction, and a cross-process lock.
- Layered memory scope: a global ledger plus an ownership-gated per-project ledger
  (`helix_memory_adopt`, default-deny).
- Two-tier trust labels: machine-corroborated **Corroborated** (`helix_memory_recheck`, a
  content-bound mechanical file check) and human-attested **Verified** (`helix_memory_confirm`).
- Lexical recall ranker (coverage / phrase-first, BM25-assisted), with an in-process recall cache
  keyed by content identity — the ledger byte digest, the resolved MAC-subkey fingerprint, and the
  scope set — so repeated recalls in a session reuse the verified projection instead of replaying it.
- Ledger HMAC: `Corroborated`/`Verified` are tamper-evident at the file surface. Trust is conferred
  only by `verify` records, and every one that confers a grade is HMAC-SHA256-authenticated with a
  key held only in `~/.helix` (per-project HKDF subkey, never written to the repo ledger); the
  unsigned, target-less markers a ledger rewrite writes confer nothing. A forged or edited ledger
  record replays as `Fresh`. **Unforgeable at the file surface against an adversary that cannot read
  `~/.helix`** — and no further: a reader of `~/.helix` can mint valid MACs, trust is local to one
  trust store and, for a project ledger, to one project path, and `helix_memory_confirm` carries no
  enforceable human-approval signal, so do **not** allow-list it.
- Ledger MAC v2: `verify` records bind their system-time `tx` into the MAC, so a genuine
  verification's *timing* cannot be edited in place — authenticity, not clock accuracy. Reads
  dual-accept v1 signatures, so no grade is lost.
- Rollback witness: a home-side, per-scope high-water counter (`~/.helix/witness.json`, MAC'd with
  the same master key) that detects a ledger forked from or behind the head it last saw — a
  regression the per-record MAC cannot catch, because a restored older ledger is itself validly
  signed. A mismatch clamps that scope's grades to `Fresh` on every live projection and renders a
  disclosure note; reads and ordinary appends continue — an elevated `verify` (a `confirm` or a
  passing `recheck`) is refused before anything is written — and the witness never advances past a
  mismatch without an explicit re-baseline. Armed from the first release, not opt-in.
- Operator re-baseline ceremony: `node bin/helix-rebaseline.mjs --scope global` (or
  `--scope <projectRoot>`), the only sanctioned way to clear a witness mismatch. Interactive and
  TTY-only, it displays the mismatched hash and target epoch, requires a typed confirmation, and
  holds the ledger lock from that display through the commit.
- Operator trust-resolution ceremony:
  `node bin/helix-trust-resolve.mjs --scope <absoluteProjectRoot> --repair | --fresh`, the only
  sanctioned way to settle a project ledger in `trust-pending` — the state an ambiguous re-adoption
  enters when a registered path returns without its `.owner` stamp, where every read clamps to
  `Fresh` until a person decides. `--repair` keeps the lineage and re-elevates the earlier verifies;
  `--fresh` rotates the nonce so a reused path cannot inherit trust the new content never earned.
- Neither ceremony is an MCP tool: no MCP tool parameter can invoke either, and nothing invokes them
  automatically. Their terminal gate proves interface shape, not human presence: an agent that can
  drive a shell can run either under a pty and type the confirmation.
- Forensic point-in-time views: `helix_memory_inspect asOf=<ISO instant>` reconstructs which facts
  were live at a system-time and the evidence for each grade, and `history` reconstructs every
  fact's `[tx, txTo)` interval and what closed it (`supersede` / `invalidate` / `erase`). An
  unresolvable master key clamps every grade shown to `Fresh` with an explicit note.
- Lock durability: the cross-process ledger lock is published atomically with its owner payload, a
  liveness matrix — never age — decides whether a recorded holder may be reclaimed, every reclaim is
  serialized through a reaper gate named per boot where the platform exposes a boot id (Linux; on
  macOS and Windows one gate name serves every boot, so a reaper that crashed inside the gate blocks
  automatic reclaim of that lock until the gate file is removed by hand), appends and compactions
  fsync both the data and its directory before reporting success, and a hard-linked ledger (link
  count ≠ 1) is refused outright.
- Untrusted-content quarantine: NFKC / control / bidi normalization, per-line datamarking, and a
  per-call 128-bit nonce frame.

#### Optional Codex dual-verify — off by default

- `helix_dual_verify` with a deterministic egress guard (secret / PII / memory-echo), plus
  `helix_codex_status` and an opt-in content log.
- Configuration is read from the global `~/.helix/config.json` only — a checkout's
  `.helix/config.json` can neither enable the outbound path nor loosen it. Keys: `enabled` (default
  `false`), `mode`, `model` (≤ 64 characters, or `null` to inherit `~/.codex/config.toml`), `effort`,
  `stakesFloor`, `timeoutMs` (integer ≥ 1 s, clamped to 1 hour), and `egressPolicy` — a per-leg map
  over `memoryEcho`, `piiHigh`, `piiBulk`, `secretHeuristic`, `secretEntropy` and
  `secretEntropyExempt`. Each leg is `block` or `allow`; all default to `block` except
  `secretEntropyExempt`, which defaults to `allow` and is what releases a hex-shaped or
  low-entropy-chain token — a git SHA quoted in design prose — past the guard. On the write path the
  word-chain arm of that shape has its own key, `persistence.releaseWordChains` (default `true`), so
  a dated path or note slug persists verbatim while a hex-core token still redacts; a credential
  keyword within the 40 characters on either side of the token (a newline, `.` or `;` cuts that
  window short) vetoes the release on both paths; one farther away, even in the same sentence, does
  not. Provider-format credentials are
  override-proof: no policy value releases them.
- An invalid value on `mode`, `stakesFloor`, `model` or `effort` is refused with a bounded
  single-line stderr warning and the default is kept, so a crafted newline cannot forge a second
  diagnostic line. `enabled`, `timeoutMs` and `logContent` fall back to their defaults silently. An
  absent key is silent in every case.
- A fourth, strictest stakes tier `xhigh` above `high`. Omitting `stakes` is read as the lowest
  tier, so any floor above `low` refuses an undeclared call: omission is not an exemption.
- Codex 5.6 reasoning efforts: `dualVerify.effort` accepts `max` and `ultra`. Per-model support
  varies and Helix does not arbitrate it — `codex debug models` is the authority. A Helix-set `max`
  or `ultra` at a run timeout of `300000` ms or less prints an advisory, because a timeout
  tree-kills the run after the quota is spent.
- `helix_codex_status` reports the effective model, the configured effort and the run timeout. With
  `dualVerify.model: null` it resolves the name from a free `codex doctor --json` probe and prints
  `(unresolved)` rather than guessing; there is no equivalent probe for effort, so a `null` effort
  prints only `inherited from codex config`.
- Every result whose payload was actually transmitted — a successful run, and a run that reached
  Codex and then errored — carries an `egress: …` disclosure line above the quarantine frame, so the
  calling agent can tell a config-valved release from a clean pass. A refused, unavailable or
  skipped result carries no line, because nothing left the machine. The line is content-free: it
  names leg outcomes and policy keys, never the scanned content.
- Agreement is assigned claim-to-claim rather than by scoring every candidate pair, so a sentence
  pair whose figures differ cannot render `agree` — the verdict withholds and names both values.
  Every `agree` is labelled lexical agreement in the response itself: matched claims share tokens
  and polarity, and that is not a semantic check.
- The egress guard scans what each mode actually transmits. `compare` sends the normalized
  `question` alone, so `helixAnswer` — which never leaves the machine in that mode — is not scanned
  against the ledger and cannot refuse a call over bytes that stay local; its own 65,536-character
  cap is enforced directly in `dualVerify` instead, so no entry path escapes it.
  `critique` sends both fields inside the prompt, and both are scanned.
- A refusal the memory-echo leg decided names *where* it matched. For each record that still
  blocks, the tool response quotes the runs of the caller's own payload that matched that record —
  up to 10 records, 3 runs each, 160 characters per run, with a count of whatever was left out —
  inside a datamarked DATA frame, because the runs are content rather than advisory prose. The
  audit row stays content-free: it never receives a span.

#### Automatic compaction — opt-in, default OFF

- `compaction.auto`. When enabled, a recall whose ledger passes every gate rewrites that ledger
  through the crash-safe `compactLedger` (lock held across read → rewrite → atomic rename),
  synchronously, at most once per session. The attempt is counted whether it succeeds or fails: a
  compaction that throws never breaks the recall, but still spends the session's single attempt.
- **The consequence you are opting into.** Compaction drops *every* dead record, however recently it
  died — there is no per-record age filter. Once a ledger goes quiescent past the grace window
  (`compaction.graceMs`, default 24 h since the file's last write), an ordinary `helix_memory_recall`
  can permanently close the soft-erase undo window and drop recent `asOf` / `history` rows. What a
  recall *answers* is unchanged: the live projection is preserved by construction.
- Because the setting is destructive it is read from the **global `~/.helix/config.json` only** — a
  cloned repo's `.helix/config.json` can neither enable nor tune it. That one setting still governs
  both the global ledger and an owned project ledger, each gated independently.
- Keys, with invalid or out-of-range values silently keeping the default: `auto` (bool, `false`),
  `dirtyRatio` in `(0, 1]` (`0.5`), `minRows` ≥ 0 (`200`), `minDirtyBytes` ≥ 1 (`1048576`),
  `graceMs` ≥ 0 (`86400000`), `maxBytes` > 0 (`52428800`). `graceMs: 0` disables the grace entirely,
  so a fact soft-erased moments ago can be destroyed by the very next eligible recall.
- Self-limiting: a compacted ledger has essentially zero reclaimable rows, and the content-free
  integrity / horizon markers a compaction mints are a coalesced canonical fixpoint — a later
  compaction re-mints the byte-identical row rather than dropping it, contributing exactly zero to
  the count the next dirty-gate is computed from.
- Observable when metrics are enabled (`metrics.enabled`, the default): every attempt emits a
  content-free `compaction` record to `~/.helix/metrics.jsonl`, failures included. `reclaimed_bytes`
  is legitimately negative when a compaction drops little but mints a marker — the ledger net-grew,
  and that is reported rather than clamped. `landed` records whether the rewrite physically reached
  disk, which is what lets `dropped_rows` be trusted on a failed attempt instead of read as zero.
  With `metrics.enabled: false` the sink is a no-op, so a destructive operation runs with no
  visibility at all.
- Named limitations: it does not bound total ledger size, since preserved audit data is never
  reclaimed; a continuously churny ledger may never auto-compact, because quiescence is required and
  there is no max-lag force; a ledger already above `maxBytes` is skipped and gets no automatic
  relief; and a forward clock step of at least `graceMs` can make a just-written ledger read as
  quiescent and fire early. Ledger integrity is never at risk in any of these cases — the compaction
  lock and the atomic rename hold regardless.

#### Surface

- Nine MCP tools and SessionStart/SessionEnd hooks, installable as a Claude Code plugin with
  self-contained committed bundles — no `npm install` to use.
- Two environment inputs place Helix's state: `HELIX_HOME` (default `~/.helix`) holds the signing
  key, the ownership registry, the rollback witness, the audit log and the metrics stream;
  `HELIX_LEDGER` moves the global ledger data file and nothing else.
- Content-free replay metrics in `~/.helix/metrics.jsonl` (default on; `metrics.enabled: false`
  disables; the hook honours the global config only).
- `helix_memory_inspect` takes an `ids` filter: up to 20 ids render only those records, each with
  its `contentDigest` proof line, so a caller can read back exactly the records a dual-verify
  refusal named and declare them in `quotedMemory`. `ids`, `history` and `asOf` are mutually
  exclusive, and requested ids with no live record are reported as a count rather than dropped in
  silence.

### Limits

- `helix_memory_commit`'s `content` is capped at 16,384 characters, enforced by both the MCP schema
  and the store, so no non-MCP caller into the same store can bypass it.
- `helix_dual_verify`'s `question` and `helixAnswer` are capped at 65,536 characters each, and
  `helix_memory_recheck`'s `check.path` and `check.pattern` at 4,096 and 2,048. The two dual-verify
  fields meet the egress guard's 200,000-character scan limit *jointly* only in `critique` mode, the
  one that transmits both; `compare` transmits the question alone, so the limit sees that field by
  itself there. Both caps are chosen so each field and their sum stay under 200,000 either way.
- `helix_memory_recall` and `helix_memory_inspect` cap their rendered response at 262,144
  characters, dropping whole tail items rather than a partial one and appending an
  `N item(s) omitted (response cap)` note. `maxItems` (≤ 200) and `maxChars` (≤ 10,000) carry
  matching schema maxima.
- The session hooks bound their stdin read at 1 MiB and refuse fail-closed past it.
- Tool results report success as `<verb> {json}`, one JSON object carrying the id or path, so a
  caller-controlled value never re-enters the success prose as a bare unescaped string.

### Not claimed

- **Recall quality.** Helix makes no measured claim about how well recall ranks — no hit rate, no
  accuracy figure. A preregistered pilot was run to support one and did not reach its own minimum
  sample, so the claim was withdrawn rather than weakened. `docs/release/v2-close-report-2026-08.md`
  is the record.
- **Trust beyond one trust store.** Elevated grades are local to one trust store (`HELIX_HOME`) and, for a project ledger, to one project path: they do not transfer to another machine, to a second `HELIX_HOME` on the same machine, or to the same project moved or cloned to another path.
- **Compatibility before 1.0.** The ledger is append-only JSONL with no schema migrations to date,
  and no forward or backward compatibility is guaranteed across versions before 1.0.
- **Erasure of the opt-in content log.** `~/.helix/codex-log.jsonl`, written only under
  `dualVerify.logContent: true`, is outside every erase path: neither `helix_memory_erase` nor the
  operator-only permanent erase touches it, so a memory's text that a logged call carried stays
  there after the record is erased. Deleting the file is the remedy.

### Dependencies

- Dependency advisory triage is recorded in `docs/release/deps-audit-2026-09.md`; `fast-uri` is
  overridden to `3.1.7`. The advisories that remain are transitive dependencies of the MCP SDK's
  HTTP transports, which the shipped bundle does not contain — the record measures that rather than
  assuming it.

[0.1.0]: https://github.com/wlsgur073/helix/releases/tag/v0.1.0
