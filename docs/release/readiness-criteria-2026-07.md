# Service-readiness criteria + redo roadmap — DRAFT (not ratified)

Date: 2026-07-22 · Status: **DRAFT — awaiting owner ratification.** Owner decisions Q2 and Q3
landed 2026-07-22 (§7); the sole remaining blocker is Q1, the owner's felt-gaps enumeration,
deferred to a follow-up session — per the cross-review verdict, completeness is impossible
before that list lands. Companion to `gate-decision-2026-07-22.md`, which governs all
recall-quality claims (locked template) and the protocol-v2 path.

Scope guard: v0.1 of a personal-scale tool. Every criterion cites a recorded defect, lesson,
or prior-approved requirement; anything else is gold-plating and was deliberately excluded.

## 1. Product completeness

- **C1.1 Provenance acceptance drill.** The once-dormant provenance paths (Fresh→Verified
  promotion; erase/compaction routing) were audited CLOSED on 2026-07-17 (committed probe
  tests, all passing). Criterion: re-run the committed probe suite at release time as an
  acceptance drill — no new wiring.
- **C1.2 Matcher follow-up triage.** Pre-release part DONE 2026-07-22: the two ranking locks
  promoted from first-element-only to full-array assertions (mutation-verified both ways) and
  the stale "(exact back-compat)" comment referent fixed. Post-v1 (explicitly deferred):
  query-dependent firing counters (needs its own privacy adjudication); runtime canonicality
  metadata.
- **C1.3 v2 offline O_67-class rule.** Deferring runtime canonicality metadata is fine, but
  the v2 freeze MUST include a prospectively frozen OFFLINE rule for classifying new
  superset-competition (O_67-class) cases — without it the exercised/unexercised report
  required by gate-decision D5 cannot be produced.

## 2. Quality gates

- **C2.1 Flaky lock test (DONE 2026-07-22).** Root-caused: the test's rmSync adversary passes
  through a legal intermediate state (lock name free, dir alive) where acquisition is correct
  behavior — a test-design defect, not an implementation bug. Fixed deterministically: the
  vanish is now an atomic renameSync (no intermediate state exists). Evidence: 0/12 failed
  full-suite runs under the previously reproducing condition (was 2/10).
  Blanket "N consecutive green suites" was considered and REJECTED as statistically weak.
- **C2.2 Egress false-positive class.** Long hyphen-chains containing digits still trip the
  entropy leg (fired twice on real governance filenames, most recently on this cycle's own
  gate-decision filename). Fix the class, or ship in-product guidance on rewording.
- **C2.3 Green at freeze.** Full suite + typecheck green at the v2 freeze commit; any
  readiness fix landing after the freeze resets the holdout window (gate-decision D3), so all
  fixes in this document precede the freeze.

## 3. Security honesty

- **C3.1 SECURITY claim-accuracy audit** (accuracy, not length): every claim re-verified
  against the release candidate; disclosure channel exercised at least once.
- **C3.2 Threat-model disclosure** includes the unconfined-agent deployment class (an
  allow-listed runtime plus a readable master key voids the ledger-MAC threat model in such
  deployments — previously decided accept-and-document).
- **C3.3 Defaults audit.** Fresh-install defaults reviewed against operational reality (known
  instance: the dual-verify timeout default is unusable at effort=max; the maintainer config
  carries a manual override today). Audit item, not an automatic blocker.

## 4. Operability (carry-forward of the 2026-07-20 readiness design §5 — each item kept)

The prior approved design's clean-room tier and drill set are carried forward IN FULL
(pristine AND upgrade profiles; destructive drills on corpus copies):

- **C4.1** Upgrade-with-cache-proof drill (installed artifact must report version AND exact
  candidate commit — the version-keyed cache trap is the known failure mode).
- **C4.2** Backup → restore into empty data dir (integrity, counts, spot oracle probe).
- **C4.3** Interrupted update/migration on a disposable ledger copy (fails visibly, source
  intact, restorable).
- **C4.4** Truncated/corrupt ledger copy (detection, safe failure, recovery from backup).
- **C4.5** Uninstall/reinstall + disable/enable (documented data-preservation behavior holds).
- **C4.6** Maintainer tabletop: hosting-account/token recovery + ledger master-key-loss drill.
  Tag signing stays out of scope until tags are actually signed.
- **C4.7 Uninstall/data-removal statement (NEW — genuine gap).** README documents the
  uninstall command only; it must state what remains afterward (`~/.helix/` global ledger,
  keys, metrics, witness state; per-project `.helix/`) and give full-removal steps.
- **C4.8 Deploy runbook in-repo (DONE 2026-07-22).** The same-version cache trap (plugin
  update cache-skips; uninstall+install required) and the MCP launch barrier (new CLI process
  required after install) previously lived only in session memory, and README recommended
  plain `plugin update` unconditionally. Now: `deploy-runbook.md` (this directory) carries the
  full maintainer procedure + verification commands, and README's install section carries the
  user-facing caveats.
- **C4.9 Supported-platforms statement (NEW).** Runtime Node ≥ 20 vs development Node ≥ 24 is
  a documented split (README line 229) — restate it in one place users read, plus the
  UTF-8/cp949 console lesson for Korean Windows, and the validated-platform list (WSL2 is the
  only continuously exercised environment today). Include the supported-scale statement from
  §6 ("validated to N rows", N fixed from the pilot corpus and bench evidence).
- **C4.10 Local scale advisory (NEW — decided 2026-07-22, owner decision Q2).** Ship a local,
  content-free advisory before the v2 freeze: when union ledger rows cross a soft threshold
  (below the Stage-1 build trigger), surface a one-line session-start note. No telemetry —
  the advisory is computed and shown on the user's machine only.

## 5. Evidence & protocol (v2 scheduling per gate-decision D2/D3)

- **C5.1 v2 freeze checklist** = the six §f elements (system/config identity, eligibility,
  derivation/mapping, K+metrics, cutoff, minimum sample or stopping rule) + C1.3's offline
  O_67-class rule + the exposure policy from open decision Q3 below.
- **C5.2 Stopping rule (PROPOSED, to be preregistered verbatim at freeze):** stop only after
  **≥ 20 eligible new product-decision probes** AND **≥ 14 days**, hard cap 28 days; the cap
  does NOT waive the minimum — a starved window reports unexercised, never a trivial pass;
  stopping never depends on observed scores; Hit@1 and O_67-class get separately frozen
  exposure/reporting rules. (At the observed ~1.65 ledger rows/day, 20 raw rows ≈ 12 days —
  but eligible product-decision probes accrue SLOWER than raw rows; hence the 14-day floor
  and the honest starvation clause.)
- **C5.3 Ordering.** Every criterion in this document lands BEFORE the v2 freeze (D3: any
  intervening change resets the untouched window).
- **C5.4 Historical marker (DONE 2026-07-22, landed with this document's first commit).**
  `audit-2026-07.md` narrated the stood-down 0.2.0 flip in future tense; it now carries a
  HISTORICAL status header so tracked release docs make no stale forward-looking claims.

## 6. Recall-index scale governance (Part B disposition, promoted to tracked docs)

- Thresholds UNCHANGED and re-affirmed dormant: Stage-1 build trigger at **2,500 union rows
  OR 4 MB union bytes OR 3 recalls > 150 ms** (union of participating scopes). Current
  reality: 28 union rows, ~1.65 rows/day → all arms are years away at dogfood scale; the
  trigger is **adoption-coupled** (only post-release usage can reach it).
- The earlier "users cannot hit the slow cliff before the ladder fires" claim is **REJECTED
  as unconditional** (cross-review, accepted): the trigger is a BUILD signal, not a deployed
  index; the spec's own prediction puts cold recall ≈ 103 ms AT the 2,500-row trigger on the
  baseline machine; slower hardware crosses 150 ms below the trigger; a restored or shared
  ledger can jump past it in one step; and the latency arm by design fires only after three
  slow recalls. Conditionality is now the recorded position.
- **Observability gap (accepted finding):** trigger evaluation runs only via the dogfood
  systemd adapter; nothing evaluates or surfaces threshold crossing for an external adopter
  (and Helix has no telemetry, by design). **Remedy DECIDED 2026-07-22 (owner decision Q2):
  BOTH** the supported-scale statement (folded into C4.9) **AND** the local content-free
  advisory (C4.10) ship before the v2 freeze.

## 7. Owner decisions (ratification gate)

- **Q1 (R6) — OPEN, the sole remaining ratification blocker.** The stand-down reason ("many
  shortcomings") is still un-enumerated; the owner will supply the felt-gaps list in a
  follow-up session (decided 2026-07-22: deferred, not skipped). This document is complete
  only when that list is folded in and each item maps to a criterion or an explicit
  rejection.
- **Q2 — DECIDED 2026-07-22: both remedies.** v0.1 does not silently accept unbounded
  imported/team ledgers; it ships the supported-scale statement (C4.9) AND the local
  content-free advisory (C4.10).
- **Q3 — DECIDED 2026-07-22: minimum exposure required.** The v2 pilot may NOT release with
  Hit@1 or O_67-class evidence unexercised; each carries a preregistered minimum exposure
  count, fixed verbatim at the v2 freeze (C5.2 encodes this position).

## 8. Why-log (provenance of this draft)

Pre-registered skeleton (assistant): R1–R6 buckets + suspected-missing list + the
anti-goldplating guard. One collaborative cross-review round produced 8 findings: 7 accepted
— including four blocking (ratifiability requires R6; the prior design's drill set had been
dropped from the skeleton, now carried forward in full in §4; "weeks-scale" replaced by the
§5.2 stopping rule; the recall-index no-pain claim rejected as unconditional and the
observability gap recorded) — and one **rejected with evidence**: the claimed Node-version
inconsistency (README line 229 documents the runtime ≥20 / dev ≥24 split deliberately;
residual adopted into C4.9). Several suspected-missing items were found already covered
(privacy/data-flow, migration no-guarantee, SemVer declaration, provenance wiring) and were
downgraded from "create" to "verify". Convergence not yet declared: this draft is one round
in; ratification (§7) gates the next step, and a follow-up round on the ratified version is
budgeted.
