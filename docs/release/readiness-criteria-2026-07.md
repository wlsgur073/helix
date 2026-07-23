# Service-readiness criteria + redo roadmap — RATIFIED 2026-07-24

Date: 2026-07-22 (ratified 2026-07-24) · Status: **RATIFIED.** All owner decisions are closed: Q2 and
Q3 landed 2026-07-22 (§7), and Q1 — the owner's felt-gaps enumeration, the sole remaining blocker —
was resolved 2026-07-24 by a domain-by-domain owner interview: all 13 enumerated gaps map to a
criterion or an accepted v0.1 limitation (§7 Q1, §9), and the owner confirmed NONE is a personal-scale
correctness blocker. Companion to `gate-decision-2026-07-22.md`, which governs all recall-quality
claims (locked template) and the protocol-v2 path.

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
- **C1.4 Registry-as-trust-store hardening + mixed-key deletion fix (SHIPPED local; round-4/5 Codex
  compare).** The ownership registry (`~/.helix/projects.json`) is a trust store — its per-scope MAC
  nonce selects the ledger verification subkey — but was not hardened like the ledger/master-key: a
  wrong/lost/aliased/corrupt nonce let compaction physically DELETE genuine signed verifies (plus a
  false integrity marker), unrecoverably. Hardened over PR-1..F/G/H (commits 8f46462..86fd151),
  keystoned by the nonce-continuity compaction chokepoint. Round-4 compare then DIVERGED: the
  chokepoint's EXISTENTIAL test ("does any verify validate?") still allowed a MIXED-KEY deletion —
  genuine rows under nonce N1, a lost/rotated/aliased registry rotates to N2, Helix itself signs ONE
  new verify under N2 which "proves" the key and licenses deletion of the entire N1 lineage. Codex
  found it, reproduced end-to-end (keepSurvives false->true, false marker minted), and it was fixed
  @ 7d8909d with a SINGLE-LINEAGE gate (`planCompaction` drops a verify only when the resolved key
  proves a single keyId lineage — `keyProven AND singleLineage`; `provesKey` now FAIL-CLOSED). Round-5
  compare CONVERGED: Codex independently verified (against the bundled planner) that the deletion class
  is CLOSED for all shipped MemoryStore/MCP paths, the exact N1->N2 sequence included. So the chokepoint
  now GENUINELY satisfies the F3 deletion-stopgap; F3's absent-vs-lost create-once MINTING design stays
  deferred (the gate covers the DELETION half — a mis-mint's effect is now non-destructive).
  TRACKED LIMITATIONS on the deletion axis (recorded honestly, NOT "harmless" — round-5 Codex):
  (i) `keyId` is a 64-bit truncation (`keyIdOf`, ledger-mac.ts:77): two subkeys colliding on keyId
  (~2^-64, not deliberately exploitable in the ledger-only attacker model) would defeat the
  single-lineage gate — widening the lineage commitment to >=128 bits is future hardening.
  (ii) exported `compactLedger` called with NEITHER HMAC predicate uses legacy bake-and-drop and
  deletes live-target verifies; NOT reachable via MemoryStore/MCP (both production callers pass both
  predicates) — a low-level API footgun to type-harden later.
  (iii) three round-4 findings, confirmed by round-5 as correctly OUT of the deletion-blocker scope but
  genuine: `.owner` reused-path trust-LAUNDERING (copied same-path rows validate under an inherited
  nonce — a conferral vector, not deletion; the "launders nothing" comment is inaccurate; a
  repair-vs-adopt ceremony split is owed); witnessed-append AUDIT mislabel (a confirm whose verify row
  lands but whose witness advance throws is audited `rejected`); post-stamp `.helix` symlink /
  project-to-project alias coverage (an alias-PREVENTION gap, rendered non-destructive by the gate).
  Deploy dependency: the fix protects only sessions served by the redeployed plugin — the cold-process
  barrier (SECURITY.md) must hold so no pre-fix MCP process compacts with the old bytes. (The running
  plugin was still pre-fix 74f3621 at ratification time; redeploy is a release precondition, not hygiene.)

## 2. Quality gates

- **C2.1 Flaky lock test (DONE 2026-07-22).** Root-caused: the test's rmSync adversary passes
  through a legal intermediate state (lock name free, dir alive) where acquisition is correct
  behavior — a test-design defect, not an implementation bug. Fixed deterministically: the
  vanish is now an atomic renameSync (no intermediate state exists). Evidence: 0/12 failed
  full-suite runs under the previously reproducing condition (was 2/10).
  Blanket "N consecutive green suites" was considered and REJECTED as statistically weak.
- **C2.2 Egress false-positive class (DONE 2026-07-22).** Long hyphen-chains containing digits
  tripped the entropy leg (fired twice on real governance filenames, most recently on this
  cycle's own gate-decision filename). Fixed as an EH-4-parallel gate-time exemption:
  `entropyWordChain` — a separator-joined chain (≥2 segments over `-._/`) in which EVERY
  segment is individually low-entropy (pure alpha; digits ≤4; word+digit-suffix ≤8) is
  released on egress UNLESS a credential keyword sits in the same statement. One
  disqualifying segment keeps the token in the net (anti-greedy); write-path redaction
  unchanged; covert re-encoding is an explicit non-goal of this low-confidence net. TDD'd
  (both real FP tokens pass; mixed-segment/interleave/digit-run/single-segment adversaries
  still block; keyword guard locked) + mutation-verified (digit-cap loosening to {1,12}
  turns its lock RED). LIVE only after the next plugin deploy.
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
- **C4.7 Uninstall/data-removal statement (DONE 2026-07-22).** README previously documented
  the uninstall command only; it now has an "Uninstall & data removal" section: plugin
  uninstall never touches data; what remains (`~/.helix/` global ledger, key, witness state,
  metrics, registry; per-project `.helix/`); full-removal steps (enumerate adopted projects
  from `projects.json` BEFORE deleting the registry); partial-removal key-loss note.
- **C4.8 Deploy runbook in-repo (DONE 2026-07-22).** The same-version cache trap (plugin
  update cache-skips; uninstall+install required) and the MCP launch barrier (new CLI process
  required after install) previously lived only in session memory, and README recommended
  plain `plugin update` unconditionally. Now: `deploy-runbook.md` (this directory) carries the
  full maintainer procedure + verification commands, and README's install section carries the
  user-facing caveats.
- **C4.9 Supported-platforms statement (DONE 2026-07-22).** README's Requirements section now
  carries: the runtime ≥20 / dev ≥24 split restated at the point of install (engines field =
  dev toolchain, not runtime floor); the platform list (Linux/WSL2 continuously exercised;
  macOS expected-POSIX but not exercised; native Windows NOT currently validated — the lock
  layer's hard-link semantics are POSIX-verified only); the cp949→UTF-8 Korean-Windows console
  note; and the supported-scale statement (correctness at daily dogfood scale + frozen pilot
  corpus; latency benchmark-characterized, cold ≈150 ms near ~3.3k union rows; ≥~2,500 union
  rows outside the v0.1 envelope — pairs with the C4.10 advisory).
- **C4.10 Local scale advisory (DONE 2026-07-22; decided same day, owner decision Q2).**
  Implemented at SCALE_ADVISORY_ROWS = 2,000 union physical rows (80% of the Stage-1 build
  trigger; the count is the sum of the same per-scope rows the replay sensor emits, so the
  advisory and the real trigger measure the same quantity). One content-free line rides the
  SessionStart trailer — outside the quarantined frame, outside the char budget, rendered even
  when the record set is empty (a fat all-superseded ledger is exactly the signal). No
  telemetry: computed and shown locally. TDD'd (boundary 2000/1999, empty-frame, saturation
  survival, wiring helper) + verified end-to-end by spawning the rebuilt bundle on a
  2,100-row fixture ledger. LIVE only after the next plugin deploy (deploy-runbook.md).

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

- **Q1 (R6) — RESOLVED 2026-07-24 (felt-gaps enumerated and mapped; ratification unblocked).** The
  stand-down "shortcomings" were enumerated in a domain-by-domain owner interview. All 13 gaps map to
  an existing criterion or an explicitly ACCEPTED v0.1 limitation, and the owner confirmed NONE is a
  personal-scale correctness blocker (scope guard: a maturity/measurement/UX gap is not a correctness
  blocker). The full enumeration and disposition are recorded in §9; the three items the interview
  newly surfaced are the accepted limitations L1–L3 there.
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

Round-4/5 registry-hardening reconciliation (Codex compare, SYMMETRIC — the why-log the code and
changelog do not preserve). The answer-first draft claimed the nonce-continuity chokepoint closed the
genuine-verify deletion class. Round-4 compare DIVERGED: Codex, answering the neutral question
independently, found a mixed-key sequence the draft missed (one new verify signed under a rotated
nonce "proves" the key and licenses deleting the prior lineage). It was reproduced end-to-end
(keepSurvives false->true), conceded without defense, and fixed @ 7d8909d (single-lineage gate +
provesKey fail-closed + durable-write unification: master-key/audit via `writeAll`, Buffer + zero-
progress guard, audit first-create dir fsync). Round-5 compare CONVERGED: Codex independently verified
the class is closed for all shipped paths and CALIBRATED the claim from absolute to
practical-plus-two-tracked-residuals — the 64-bit keyId-collision (~2^-64) and the legacy
`compactLedger` footgun, both now recorded in C1.4 as limitations, not dismissed — and confirmed
#3/#4/#6 correctly deferred AS LIMITATIONS. Lessons: (a) an existential "some key validates" is not
lineage continuity — the fix keys on the per-record `keyId` lineage, not on any-verify-validates;
(b) the SYMMETRIC compare (not critique) surfaced the miss precisely because Codex reasoned to the
neutral question independently rather than attacking the draft — one question, two minds, facts
deciding; (c) "negligible" is not "absent" — a 2^-64 residual is recorded, not waved away.

## 9. Q1 felt-gaps enumeration & disposition (ratification record, 2026-07-24)

The owner's stand-down "shortcomings" were enumerated in a domain-by-domain interview — 13 gaps, each
mapped to a criterion or an accepted v0.1 limitation. The owner confirmed none is a personal-scale
correctness blocker (scope guard: v0.1 of a personal-scale tool — a maturity, measurement, or UX gap
is not a correctness blocker). This is the list §7 Q1 required; folding it in unblocked ratification.

Covered by existing criteria (no new work): recall ranking → C1.2 / C1.3 / C5.2; deletion-and-trust
residue → C1.4; concurrency corners → C2.1 + the lock-durability bucket; platform coverage → C4.9;
unconfined-agent acceptance → C3.2; deploy manual-ness / fragility → C4.1 / C4.8 + C1.4's cold-process
dependency; pilot unexecuted → C5.2 / Q3; scale threshold adoption-coupled → §6; latency
live-distribution → C4.9 / C4.10; Hit@1 / O_67 exposure → C5.2 / Q3.

Newly surfaced by the interview, recorded as ACCEPTED v0.1 limitations (tracked, not blockers):
- **L1 Trust-tier decision-efficacy is unevaluated.** The two-tier ladder (Corroborated/Verified) is
  SHIPPED (@ 6833ff6), but whether the tiers measurably improve the user's decisions is not evaluated —
  that needs usage data and folds into the pilot's remit. Accepted for v0.1.
- **L2 No one-step undo for permanent lifecycle operations.** A soft erase is a recoverable tombstone,
  but a permanent erase or a wrong supersede has no one-step undo; recovery is by re-commit. Accepted;
  a short recovery playbook is owed in docs (tracked, not a blocker).
- **L3 Provenance boundary clarity.** The provenance WIRING is audited closed (C1.1), but the
  user-relayed vs agent-inference boundary can read as ambiguous in use — a docs/UX limitation,
  accepted for v0.1.
