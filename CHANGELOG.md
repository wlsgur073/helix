# Changelog

All notable changes to Helix are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
  surfaces as an `ok: false` metric row *if metrics are enabled* (see below). On that failure path the
  ledger is byte-identical — `compactLedger` writes a tmp file and renames — so nothing was dropped.

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
  itself forgeable (see below). With `metrics.enabled: false` the sink is a no-op, so **neither a
  successful nor a failed compaction leaves any trace**: turning compaction on while metrics are off
  means a destructive operation runs with zero visibility.

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
  and below are skipped. Omitting `stakes` still bypasses the floor (an explicit call signals intent).
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
- **Breaking audit schema change:** `audit.jsonl`'s `blockedLeg` field is replaced by `decidedLeg` +
  `releasedLegs` — the old key conflated "the leg that decided the call" with "the leg that would
  otherwise have blocked it," so a policy-released block was indistinguishable from a leg that never
  fired. Anyone parsing `audit.jsonl` directly is affected. Existing rows are **not** rewritten (the
  audit log is append-only history) — they keep the legacy `blockedLeg` key; only new rows carry
  `decidedLeg`/`releasedLegs`.

### Removed
- `dualVerify.effort: 'minimal'`. The CLI still parses it, but no model in `codex debug models`
  advertises it, so the API rejects it after the metered call is already spent.

### Fixed
- A witnessed rewrite that fails before its first byte lands no longer strands the scope. Both
  rewrite paths — the re-baseline ceremony and witnessed compaction — publish a write-ahead witness
  journal and only then touch the ledger, so a refusal in between (an unwritable ledger file, a
  failed rename, an orphan-tmp sweep error) used to leave a pending journal over unchanged bytes:
  `transition-interrupted`, where reads exclude the scope and writes throw, until an operator re-ran
  a ceremony. The failing writer is the one party that can prove nothing landed — it holds the
  ledger lock continuously and re-reads the unchanged bytes under it — so it now retracts its own
  journal (a new witness-store retract operation, keyed on the journal's random nonce and logged to
  the witness log before the slot clears). Two states deliberately get no retraction. A crashed
  writer: from disk alone, "bytes match the pre-transition state" cannot distinguish a rewrite that
  never started from one that landed and was rolled back, so that stays `transition-interrupted` —
  the conservative verdict — by design. And a rewrite that superseded a still-pending journal: the
  journal slot holds one transition at a time, so the predecessor's evidence is already gone and
  clearing the slot would delete an alarm this writer cannot vouch for rather than restore anything.
  Such a failure leaves the journal pending for a re-drive to supersede, exactly as before.
- `bench-replay --real` no longer benches one physical file under two labels. Its project-scope
  gate checked ownership but not the one-file-is-one-participant rule the server, session-start
  hook, and trigger measurement already apply, so in the default layout a benchmark run from an
  adopted `$HOME` printed a phantom `project` row measuring the global ledger a second time.
- `dualVerify.mode`, `stakesFloor`, `model` and `effort` no longer discard an invalid value in
  silence. Previously an unrecognised `effort` left the field at `null`, which means "omit `-c` and
  inherit `~/.codex/config.toml`" — so `"effort": "max"` produced whatever Codex was configured with,
  with no diagnostic. Each key now warns on stderr when present and invalid. An **absent** key stays
  silent, so a valid global+project config pair emits nothing.
- `dualVerify.model` is now bounded at 64 characters, as the same predicate guards a value rendered
  into a tool result.
- `dualVerify.egressPolicy`'s unknown-key and invalid-value warnings now render the untrusted config
  data through the same bounded single-line guard as `mode`/`stakesFloor`/`model`/`effort`, instead of
  interpolating it raw. A crafted value (or key) containing a newline could otherwise forge a second
  line in the stderr diagnostic; an ordinary key/value renders byte-identically to before.
- A malformed ledger row — a bare `null` line, or a row with a non-string `tx` — could throw inside
  `helix_memory_recall` and disable memory until the offending line was found and removed by hand
  (`tx` is dereferenced by a ranking tie-break, `.localeCompare`, the moment two rows land on an equal
  score). The parse-boundary guard now also validates `tx`, alongside the already-guarded
  `id`/`content`/`provenance`/`mac`, and skips a structurally invalid row exactly like an existing
  torn-line, instead of letting a downstream predicate dereference it.
- dual-verify compare mode: a zero-pair claim alignment now reports `verdict: indeterminate`
  (with a fixed guidance line, a `no claim pairs found by aligner` fallback, and an `unmatched
  claims:` list) instead of mislabeling the comparison failure as `diverge`. Audit rows may now
  carry `verdict: "indeterminate"`; consumers must treat it as non-coverage — never fold it into
  divergence.

### Security
- The egress guard no longer blocks source citations by accident. A `path/to/file.ts:112` pointer has
  no `:` in the benign-word-chain separator class, so its final segment disqualified the whole token
  and the citation landed in the entropy net — while the same shape one character shorter passed, the
  outcome turning on path length rather than on content. A bounded trailing line reference (`:112`,
  `:44-45`, `:45:7`) is now stripped before the **unchanged** chain test, so the path in front is
  judged on its own and the exemption inherits every existing anti-greedy rule. Not done by adding
  `:` to the separator class, which would have exempted `label:<secret>` pairs. The strip is earned
  by the prefix's grammar rather than granted to any digit tail: it applies only when the prefix is
  file-shaped (ending in a dot plus a 1–5 character extension) and each number is at most five
  digits. Without that condition a colon alone would launder digits past the sibling "no digit run
  over 4" rule — `backup.recovery.identifier.593821` is caught by it, and an unconditional strip
  released the same digits the moment the separator became a colon. A secret-shaped path segment, a
  word-labelled numeric value, a long digit run and an interior colon all stay in the net; a
  recognized provider credential still blocks through its own override-proof leg; and the write path
  still redacts these bytes.
- Everything Helix persists under `HELIX_HOME` is owner-only, and stays that way. Creation sites
  passed no mode and inherited `0666` masked by the process umask — on a `umask 002` box that is
  `0664`, **group-writable**, not the `0644` an earlier audit assumed and bounded as a confidentiality
  problem. The ledger, the audit log, the session log and the lock publish files now pass an explicit
  `0o600`, and a startup pass (`hardenHomePermissions`) repairs what shipped versions already wrote —
  creation modes cannot reach files that already exist. **The decisive part is the directory:** POSIX
  puts unlink permission on the parent, so a `0600` master key inside a `0775` `~/.helix` can still be
  replaced wholesale; the pass tightens the directory to `0700` too. It warns and fixes rather than
  failing closed (an over-broad mode is a state shipped versions created, not evidence of tampering),
  refuses to chmod through a symlink or a non-regular file rather than following it, leaves project
  `.helix` trees alone — those are boundary-writable by design — and never throws.
- The write-path secret scan sees confusables. It read raw bytes while the render path NFKC-folds, so
  a fullwidth-encoded credential was persisted verbatim and came back out live. `findSecrets` now
  runs a per-token NFKC pass and reports the raw token's span, giving the write path the coverage the
  egress guard already had. Per-token rather than whole-string because the spans must address the
  caller's own bytes; token boundaries survive folding because JS `\s` already includes every space
  character NFKC can produce.
- The egress policy now decides on the FULL secret classification instead of a lossy projection of
  it. Two reducers upstream of the policy table were collapsing the detection before any leg could
  see it, and each produced a way for a payload to be released that the operator's configuration
  said should block:
  - **Overlapping spans kept only the highest-CONFIDENCE tier.** `mergeSpans` ranks
    `named > heuristic > entropy`, which is right for choosing a redaction label and wrong for
    choosing a policy leg. With `secretHeuristic: allow, secretEntropy: block`, a bare high-entropy
    token blocked but the SAME token prefixed `password=` merged to heuristic-only and was released —
    adding a credential marker made the bytes *less* blocked. A span now carries every tier that
    matched it (`SecretSpan.tiers`); `tier` remains the display/redaction winner. The mirror case
    (provider + heuristic) was already covered by a test and passed only because `named` happens to
    outrank `heuristic`.
  - **The EH-4/C2.2 hex/word-chain release was applied inside the detector.** `scanText` — whose
    contract is "pure, no policy, no decision" — subtracted exempt spans from the entropy signal, so
    `egressPolicy.secretEntropy: block` had nothing left to gate and no configuration could close
    the release. The exemption is now its own leg, **`secretEntropyExempt`**, defaulting to `allow`:
    the shipped verdict for a git SHA in design prose is byte-for-byte what it was (an audit-only
    `pass`), but an operator can now set it to `block`. It is an opt-in leg — applicable only when
    set to `block` — so the default introduces no verdict churn on the false-positive class the
    exemption exists to serve. `SECURITY.md`'s "blocked by default but per-leg policy-overridable"
    claim was false for this subclass in both halves; it now names the exception.
  The audit record's `releasedLegs` type was a hand-copied union of the five leg names and went
  stale the moment a sixth existed; it is now sourced from `EgressLeg`.
- The re-baseline ceremony refuses a project scope that names the global ledger. It resolved the
  ledger from the scope argument and the witness key from the same argument by a second, independent
  route, and compared neither against the global ledger. In the default layout `HELIX_HOME` is
  `$HOME/.helix`, so `--scope $HOME` resolved to the global ledger file while keying the witness
  under the project root: one physical file recorded under two witness identities, with the older
  one left attesting to a prefix of a file that had since grown — an unwitnessed tail until the next
  write under that key. The ceremony compounded it by displaying `first-contact` and `epoch: 0 -> 1`
  beside a non-zero byte count, telling the operator they were blessing virgin ground. The ledger
  and its witness key are now derived together in one place, and that place is also where the
  components that already enforced this same rule read it from. Also refused up front: a ledger with
  more than one hard link. The append layer already rejected those, but only after the ceremony had
  published its write-ahead witness journal, which left the scope holding a transition the ledger
  never received. The link count is re-verified after the confirmation pause as well, next to the
  existing content re-verify: a hard link created while the ceremony waits for the operator changes
  no byte, so the content check alone cannot see it, and the append's own late refusal would strand
  the scope the same way. The pre-check stats the path rather than opening it: a directory or FIFO
  at the ledger path is not misreported as an alias — the downstream layer's own error stays the
  accurate one — and the check cannot hang on a FIFO, which `open('r')` would block on.
- The dual-verify subprocess no longer inherits the user's working directory or environment. It was
  spawned with only `stdio` set, so the external Codex CLI started in the user's project and
  received every variable the server had — and `-s read-only` sandboxes writes, not reads, while the
  egress guard inspects the composed prompt and cannot see what the subprocess reads afterwards. It
  now starts in an empty per-run scratch directory, is told (`--cd`) to treat that directory as its
  project, and receives a constructed environment holding only what it needs to authenticate and
  reach the network. README and SECURITY.md previously said the call sends "nothing else (no memory,
  no files)"; that was a statement about what Helix composes, read as a statement about what the CLI
  can reach. Both now state the confinement and the residue it does not cover.
- Dual-verify, egress-policy and content-logging settings are read from the global
  `~/.helix/config.json` only. A checkout's `.helix/config.json` was previously discovered from the
  working directory and merged LAST, so opening an untrusted repository let its config re-enable the
  outbound Codex path, drop every egress leg to `allow`, and turn on verbatim prompt/response logging
  into the user's home — silently, since a well-formed file produces no warning. Compaction and
  hook-metrics settings were already global-only for exactly this reason; the rest now match. A
  caller may still name a project config explicitly (the trigger CLI does); what it can no longer do
  is discover one. The server prints a note at startup when such a file exists and is being ignored.
- The trust store no longer follows `HELIX_LEDGER`. The ledger signing key, the ownership
  registry and the rollback witness are always created under `HELIX_HOME`; previously their
  location was derived from the ledger's own directory, so repointing `HELIX_LEDGER` at a
  git-tracked tree wrote the signing key there — where anyone with the repository could mint
  valid trust grades, and where the rollback witness sat on the untrusted side of the boundary
  it exists to guard. `HELIX_LEDGER` now moves the data file and nothing else. A server that
  finds trust-store files beside a relocated ledger refuses to start and names both directories,
  rather than minting a fresh key and silently dropping every grade the old one conferred.
- Secret-scan redaction on the memory write path; the dual-verify egress guard
  hard-blocks credential tokens (override-proof).
- Provenance firewall: agreement from an external model never promotes to `Verified`.
- Content-free audit log; the Codex content log is opt-in, `0o600`, and capped.
- The dual-verify egress firewall now scans the exact normalized bytes it transmits on the
  memory-echo leg, instead of a differently-normalized copy. Previously, zero-width and confusable
  padding interleaved into a memory was invisible to the scan but still present on the wire, so it
  could smuggle an echoed memory past the check.
- The egress scan now fails **closed** at its size bound instead of open: a payload over 200,000
  characters, or a dual-verify whose ledger exceeds roughly 8,000,000 content characters, is now
  **refused** rather than sent to Codex partially scanned. **Availability change:** a call this large
  previously went through unscanned past the bound; it now errors instead.
- Codex's stderr on a failed dual-verify run is now rendered inside a nonce-framed, datamarked
  quarantine block in the host-visible error, instead of interpolated as a plain line — external
  process output is untrusted content and is now handled like any other.
