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
- **C1.3 v2 offline O_67-class rule (DONE 2026-07-26).** Deferring runtime canonicality metadata is fine, but
  the v2 freeze MUST include a prospectively frozen OFFLINE rule for classifying new
  superset-competition (O_67-class) cases — without it the exercised/unexercised report
  required by gate-decision D5 cannot be produced. Shipped @ c17e0ed:
  `o67-class-rule-2026-07.md` (this directory) + `scripts/pilot/classify-o67.ts` + the shared
  `lexicalEvidence` scorer primitive (behavior-neutral — archived pilot hashes reproduced at
  HEAD). Retrodiction anchor met: the general rule classifies exactly {O_67} in-class on both
  frozen manifests. **DONE = rule, classifier, scorer primitive and retrodiction anchor
  DELIVERED; prospective v2 use remains gated by C5.1 closure items 1–6, 9 and 10** —
  scope-qualified identities, the candidate-universe EMISSION capability, the cutoff (without
  which the rule's "distinct post-cutoff target identity" exposure unit is unproducible), the
  unambiguity denominator (whose bias inflates the base-eligible set the exposure count rests
  on — optimistic for exposure specifically; see closure item 4 for the metric-dependent
  direction), the gate-composition confirmation (`finalHit1Eligible` is named for a
  composition the freeze must confirm or rename), the exposure minima, the preregistration,
  and the freeze-commit retrodiction rerun.
  > **Updated 2026-07-31 (§11).** Of the gates listed above, items 1–6 and 8 are **delivered** and
  > item 9 is **drafted but not in force**; item 10 still runs at the freeze commit. The anchor was
  > re-verified on 2026-07-30 across the eligibility-field change and reproduced verbatim on both
  > manifests, which is continuity evidence and not a substitute for that rerun.
  Those are downstream freeze-INTEGRATION prerequisites for a completed artifact, not evidence
  that the artifact is unshipped. Reopen this criterion only if that work changes the normative
  membership rule, or if the freeze-commit retrodiction fails — never merely because the
  identity is not yet pinned.
- **C1.4 Registry-as-trust-store hardening + mixed-key deletion fix (SHIPPED and DEPLOYED; round-4/5
  Codex compare).** Deployment status corrected 2026-07-27: the "SHIPPED local" wording below predates
  the C4.1 drill, which redeployed the plugin and verified fresh processes serve the hardened bytes —
  the cold-process dependency noted at the end of this entry is CLOSED, not outstanding.
  The ownership registry (`~/.helix/projects.json`) is a trust store — its per-scope MAC
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
  CLOSED 2026-07-27 by the C4.1 drill: `installed_plugins.json` records `gitCommitSha`
  afc29c4 (installed 12:42Z), and every helix-mcp process alive since started after it, so no
  74f3621 writer survives. Commits after afc29c4 are docs-only — no runtime bytes differ.

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

- **C3.1 SECURITY claim-accuracy audit (DONE 2026-07-26)** (accuracy, not length): every claim
  re-verified against the release candidate; disclosure channel exercised at least once.
  Executed: 60 claims verified (56 accurate as written; 1 code fix, 2 doc fixes, 1 accepted
  empirical statement); channel exercised end-to-end via test advisory `GHSA-m7p7-4mx7-jw96`.
  Record: `c3-audit-2026-07.md` (this directory).
- **C3.2 Threat-model disclosure (DONE 2026-07-26)** includes the unconfined-agent deployment
  class (an allow-listed runtime plus a readable master key voids the ledger-MAC threat model in
  such deployments — previously decided accept-and-document). The class is now stated verbatim
  as a residual-bounds bullet in SECURITY.md.
- **C3.3 Defaults audit (DONE 2026-07-26).** Fresh-install defaults reviewed against operational
  reality (known instance: the dual-verify timeout default is unusable at effort=max; the
  maintainer config carries a manual override today). Audit item, not an automatic blocker.
  Executed: full defaults table in `c3-audit-2026-07.md`; the known instance FIXED — default
  `dualVerify.timeoutMs` raised to 1,500,000 ms (owner decision 2026-07-26).

## 4. Operability (carry-forward of the 2026-07-20 readiness design §5 — each item kept)

The prior approved design's clean-room tier and drill set are carried forward IN FULL
(pristine AND upgrade profiles; destructive drills on corpus copies):

- **C4.1 (DONE 2026-07-27).** Upgrade-with-cache-proof drill: the version-keyed cache trap
  live-reproduced (same-version `plugin update` reported "already at the latest version" with
  stale bytes serving) and defeated by the runbook procedure; 3-sha identity + marker verified
  in both load paths; pristine-profile public-path install landed the candidate commit-exactly
  (sha + marker) with the documented empty-home first-run behavior (TOFU note; key minted on
  first write).
  Also closed the deferred afc29c4 redeploy and yielded the F1 docs fix — `plugin update`
  needs the `plugin@marketplace` id on current CLIs (fixed @ d481893). Record:
  `c4-drills-2026-07.md` (this directory, all six drills; findings and observations F1 +
  O2–O5 dispositioned there).
- **C4.2 (DONE 2026-07-27).** Backup → restore into an empty data dir: a consistent whole-home
  restore serves with no witness alarm; counts match; foreign→adopt→spot-oracle probe hit on
  the corpus copy with the ledger byte-identical across adoption (grade clamp on re-adopt is
  the documented machine-local-trust consequence).
- **C4.3 (DONE 2026-07-27).** Interrupted rewrite on copies: crash window A fails VISIBLY
  (exact interrupted note + write-block error), source byte-intact, ceremony-restorable
  (pty); window B self-heals at startup; the orphan-tmp sweep works but is completely silent
  (tracked observation O2 in the record).
- **C4.4 (DONE 2026-07-27).** Truncated/corrupt ledger copies: witnessed-range damage is
  visibly alarmed (mismatch note) and safely excluded with appends still landing and the torn
  fragment isolated; the unwitnessed-suffix blind spot confirmed exactly as SECURITY.md
  documents; backup recovery returns to alarm-free service.
- **C4.5 (DONE 2026-07-27).** Uninstall/reinstall + disable/enable: README's
  data-preservation sentences hold at byte level (eight stable files hash-identical across
  the full cycle); reinstall over surviving data serves with no alarm from a fresh process.
- **C4.6 (DONE 2026-07-27).** Maintainer tabletop + key-loss drill: key-loss semantics proven
  live on a copy (README's key-loss paragraph holds as documented: grades revert, content
  survives, new key auto-mints, re-confirm restores); the six-question tabletop transcribed
  (answers = the owner's adoption of a Codex-compare-reconciled recommendation, disclosed in
  the record) with dispositions (Q1/Q2/Q4 findings with owner-owed [REAL-OP] actions — recovery-code
  verification, account-side credential inventory, first real backup; Q3 sound, but carrying one
  FREEZE-COUPLED action the earlier summary omitted: mint and verify a fresh source bundle holding
  the frozen candidate and the historical tag, stored off this physical machine — it belongs on the
  C5.1 checklist, and it is independent of the non-blocking Q4 backup, which must not become a
  blocker by association; Q5 procedure-sound / unconfined-class-accepted; Q6 accepted-limitation).
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
  O_67-class rule + the exposure policy from open decision Q3 below. C1.3 pinning carries two
  explicit confirmations at freeze (final-review findings, 2026-07-26): the classifier's
  `finalHit1Eligible` field is named for the RECOMMENDED gate composition and must be
  consciously confirmed-or-renamed with that decision; and the exposure unit must become
  scope-qualified — see closure item 1. An earlier draft called that a schema-field addition;
  the round-one correction called it a candidate-POOL change. Both halves are needed and the
  either/or was wrong: the pool change is the PREREQUISITE, and scope-qualifying every emitted
  identity is a real `ProbeVerdict` schema change, which rule §6 (`o67-class-rule:102`) pins
  at the freeze. Reciprocally: these are downstream
  freeze-INTEGRATION prerequisites for C1.3's already-completed artifact — C5.1 owns
  integration, policy confirmation, output completion, pinning and freeze-time reproduction;
  C1.3 owns the shipped rule itself.
  > **Updated 2026-07-31 (§11).** The two confirmations named above are resolved. The
  > `finalHit1Eligible` field was **deleted**, not renamed — owner decision D-b removed the
  > exclusion the field encoded, so there is no second tier left to name — and every emitted
  > identity is scope-qualified. The checklist's "minimum sample or stopping rule" element is now
  > a minimum of 2 plus a **fixed close**; "stopping rule" is a misnomer for v2 and should not be
  > used for it.
- **C5.1 pre-freeze closure list (merged 2026-07-27/28 from an owner draft + two Codex compare
  rounds; reconciled in §8).** Nothing here changes the pilot's measured question: items 1–4
  make the frozen method *executable*, 5–8 decide what gets frozen, 9 writes it down, 10–12
  verify and preserve. Only items 1–9 land before or in the freeze commit in C5.3's sense;
  items 10–11 RUN ON that commit, and item 12 is an off-machine copy taken after it, landing
  in no commit at all — which is why C5.3 is not violated by placing it last (C5.3 forbids a
  CHANGE after the cutoff, and a backup is not a change). Evidence paths cited below under
  the private workspace docs are LOCAL operating records (that tree is gitignored), not shipped
  artifacts; the claims they support are restated here so this document stands alone.

  **The numbers are stable IDENTIFIERS, not the execution order** — C1.3 above and
  `c4-drills-2026-07.md` both cite items by number, so renumbering as the plan refines would
  silently break those references. Blocks 5–8, 9, 10–12 do run in the order written, and each
  of those consumes the previous block's output. **Within block 1–4 that is FALSE and an
  earlier draft of this paragraph wrongly asserted it** (analysis 2026-07-28, evidence in
  the local sequencing-evidence record): items 3–4 live in
  `generate-manifest.ts`, items 1–2 in `classify-o67.ts`, and the data flow runs
  generator → manifest → classifier, i.e. 3–4 → 1–2. The classifier never feeds the generator.
  Execution order nonetheless runs the OTHER way, and deliberately: the block's sequencing is
  decided by regression-lock economics and by where the open decisions sit, not by the data
  flow — nothing in items 1–2 changes what the generator produces, so running them first
  cannot invalidate items 3–4. The verified execution order inside the block is:

  **item 2 → item 1 → items 3+4 as ONE change.** Item 2 first because it is NOT blocked by
  item 1 (scope already rides on `RecalledItem`, `store.ts:64-72`, one step upstream of the
  pool that discards it), because it touches no already-pinned blob hash
  (`pilot-protocol.md:300-303` pins derive/segment-oracle/run-pilot/generate-manifest;
  `classify-o67.ts` postdates the v1 freeze and is absent), and because as a SEPARATE artifact
  it leaves the classifier's output bytes untouched — which keeps the C1.3 retrodiction usable
  as a live regression lock while the rest of the block lands (verified 2026-07-28 at HEAD: the
  outputs reproduce BYTE-IDENTICALLY, sha256 `a3374ad3…` / `ed5dc97e…`, equal to the hashes
  recorded for the 2026-07-26 run made at c17e0ed — that commit ships the rule document only,
  so the hashes themselves live in the local evidence tree, not in git). Item 1 second because
  it is the only item that changes the classifier's output schema, so it re-baselines that lock
  once rather than repeatedly, and because it carries the block's one governance risk (below)
  and settles the scope-qualified identity that item 4 then needs. Items 3 and 4 together
  because each names the other as a prerequisite decision, both rewrite overlapping parts of
  the same file (item 3 the arg list and probe-source loop, `generate-manifest.ts:9-10,22`;
  item 4 the competitor set and flag, `:11,13-15,16-20`; `live` at `:14` serves BOTH roles, so
  enlarging it naively would silently add global-scope PROBES as well as competitors), and both
  need the same refactor neither mentions: the file exports nothing (it executes on import) and
  is OUTSIDE the typecheck program, so C2.3's typecheck gate is currently VACUOUS for it.
  1. **Thread scope through the classifier candidate pool, then scope-qualify every identity
     it emits.** `classify-o67.ts:95` builds the pool as `{ id, content }` and discards
     `it.scope`, so `targetScope` cannot be derived downstream — the pool shape changes first.
     `targetId` is not the only identity affected: the rule's exposure unit is the pair
     `(scope, record-id)` (`o67-class-rule-2026-07.md:59`), so `witnesses[].id` and
     `equalCoverage[]` must carry scope too. **CORRECTION 2026-07-28 — this item does not, by
     itself, fix the cross-scope collision an earlier draft cited as its motivation.** The
     scope tag it would thread is ALREADY collapsed upstream: `store.ts:523` keys `byId` by
     bare record id (`new Map(enforcedScoped.map((s) => [s.record.id, s]))`) and `:529` reads
     `scope` back through it, while `recallInput` pushes global before project (`:322-326`) —
     so under a colliding id BOTH rows are tagged `project`. (The `?? 'global'` fallback on the
     same line is a silent default rather than a fail-closed error, but it is unreachable —
     `byId` and `hits` derive from the same array, so the lookup never misses. A posture smell,
     not this hazard's mechanism.) `retrieval.ts:353-357` fixed exactly
     this last-wins hazard for the SCORING path with positional pairing and says so in
     comment; the scope-tagging path never got the same treatment. Hence a DECISION rides on
     this item: repair `store.recall`'s scope pairing (a production runtime-byte change — a
     "system change" under rule §6/§f, requiring a redeploy) or accept it as a documented
     limitation. Accepting is defensible at this scale: honest ids are random UUIDs so a
     collision is adversarial-only, and the frozen snapshot has ZERO cross-scope collisions
     (25 project ids vs 1 global id, intersection empty, measured 2026-07-28). If accepted,
     the classifier must assert-and-fail-closed on a collision rather than emit a tag it
     cannot justify. Note also that scope-qualifying identities can change the meaning of the
     `duplicate-target-identity` hard error (`classify-o67.ts:53-55`, `o67-class-rule` §2) —
     that is a normative membership change and WOULD trip C1.3's reopen condition, so it must
     be settled deliberately, not as a side effect.
  2. **Build the capability to emit the candidate-universe artifact the binding procedure
     already requires.** `o67-class-rule-2026-07.md:140-142` mandates that at window close,
     BEFORE scoring, the candidate-universe artifact be generated and hashed — but the pool at
     `classify-o67.ts:95` is transient and only verdicts are written (line 106), so the FULL
     universe does not survive. (Precisely: a filtered PROJECTION of it does survive, as
     `witnesses[]` and `equalCoverage[]` at `classify-o67.ts:67-68` — which is exactly why the
     artifact and the verdicts must be emitted from the SAME in-run pool, or the verdicts can
     name identities absent from the hashed universe.) What lands pre-freeze is the EMISSION
     capability (a deterministic, sorted, scope-qualified per-probe universe); the artifact
     ITSELF is still generated and hashed at window close, unchanged. Emit it as a SEPARATE
     file, not a section of the classifier's output, so the classifier stays byte-stable and
     the C1.3 retrodiction remains a valid regression lock. This is an executability blocker of
     the same class as items 3–4, not a nicety: hashing what the system COULD have returned,
     before looking at what it DID rank, is the procedure's anti-peeking device. Because this
     item SHIPS FIRST and emits scope-qualified identities, the collision guard discussed under
     item 1 lands HERE: assert that no two candidates share an id across scopes and fail closed
     if they do, so the artifact never carries a scope tag the code cannot justify. One wording
     defect for item 9 to tidy, not a blocker: rule §6 names the universe artifact BEFORE the
     holdout manifest, but the universe is enumerated PER PROBE, so the manifest must exist
     first — §6's phrasing is a comma list of deliverables, and item 9 should state the
     executable order explicitly rather than let it read as a sequence.
  3. **Give the manifest generator a transaction-time cutoff** (`generate-manifest.ts:9` takes
     four positional args, none of them a cutoff), or specify the post-cutoff enumeration
     procedure in the preregistration completely enough to execute without ambiguity. Until
     one of the two exists, the temporal holdout is not producible with current tooling.
  4. **Resolve the unambiguity denominator.** `generate-manifest.ts:16-20` flags a probe
     `unambiguous` when no OTHER live row shares ≥3 topic terms with the query — but its `live`
     set (line 14) comes from the PROJECT ledger alone (line 11), so a global-scope competitor
     is invisible to the test, while `run-pilot.ts` ranks against the merged global+project
     universe production recall actually serves. Probes are therefore flagged unambiguous that
     are not. **CORRECTION 2026-07-28 — the resulting bias is METRIC-DEPENDENT, not uniformly
     optimistic as an earlier draft said.** Enlarging the competitor set is monotone — it can
     only move probes OUT of the unambiguous subset — **provided identities do not collide**.
     Given monotonicity, the project-only denominator makes the Hit@1 gate HARDER (every
     unambiguous probe must rank 1, `pilot-protocol.md:178`) — the current state is
     self-penalizing there — while it INFLATES the O_67 qualifying-exposure count, since
     exposure is "in-class AND base-Hit@1-eligible" (`o67-class-rule:57-60`). The fix therefore
     RELAXES the gate and TIGHTENS exposure accrual; say so when disclosing it. The proviso is
     load-bearing and is THIS item's link to item 1: `generate-manifest.ts:15` builds `termsOf`
     id-keyed and last-wins (`new Map(live.map((r) => [r.id, …]))`) — the same collapse as
     `store.ts:523` — and `:18` compares `r.id !== relevant[0]` on a bare id. Merging scopes
     into `live` therefore CREATES a cross-scope collision surface that does not exist today:
     a colliding id overwrites one competitor's term set, `:18` tests the wrong content, and a
     probe can move INTO the unambiguous subset, breaking monotonicity in the flattering
     direction. So item 4 must consume the scope-qualified identity item 1 settles, or assert
     collision-freedom and fail closed.
     Choose the denominator deliberately and make generator and runner agree. Note the fix is
     UNFALSIFIABLE on the frozen corpus — that snapshot holds 25 project rows against 1 global
     row, so no probe flips either way (measured 2026-07-28); it can only be demonstrated on a
     corpus with real global content, i.e. item 3's holdout. — *Acceptance for items 1–3 is
     ordinary implementation work: focused tests for scope propagation and cutoff boundaries
     ship with the change. Item 4 is NOT: `gate-decision-2026-07-22.md:57-58` (D5) rules that
     "any revised unambiguity/subset rule validates on new temporal cases only" and must be
     disclosed wherever v2 is described. The coding is ordinary; the disclosure and
     new-cases-only validation are duties, and they align with the unfalsifiability above.*
  5. **Confirm or replace the O_67 gate composition**, renaming `finalHit1Eligible` if the
     composition changes.
  6. **Set separate positive-exposure minima for Hit@1 and for the O_67 class, and define the
     sample unit** (probe rows vs distinct decision identities — the protocol can emit several
     probes per decision).
  7. **State the shortfall consequence in the shipped rule's own labels.** Reaching the 28-day
     cap without the minimum blocks release under Q3 — the cap is never a waiver — and the
     report distinguishes `UNEXERCISED — 0/E` from `PARTIALLY EXERCISED — n/E (minimum not
     met)`; **both block** (`o67-class-rule-2026-07.md:61-64`). D3's own prose says only
     "unexercised" because it predates that refinement; the two-label form is the shipped one,
     so a nonzero shortfall must not be reported as `UNEXERCISED`.
  8. **Adopt for v2 — or explicitly carry forward — the D2 elements the other items do not
     already settle.** D2 requires ALL six fixed in advance
     (`gate-decision-2026-07-22.md:30-33`); items 3 and 9 own the cutoff and the identity
     pinning, items 5–7 own eligibility composition and the sample side, so what remains here
     is query-derivation/mapping and K + every metric definition. These are NOT bare tooling
     defaults: `pilot-protocol.md:106-121` fixes derivation rule v1 normatively (six ordered
     steps over `derive.ts`'s `topicTerms`, with "changing any behavior of this function after
     the method freeze is a deviation"), `:170-171` fixes K = 20 and the metric definitions,
     oracle segmentation is frozen in `segment-oracle.ts`, and the mapping is a manual JSON
     frozen with the manifest. The step is therefore mostly TRANSCRIPTION of already-normative
     v1 text into the v2 preregistration — but it must be a conscious re-adoption, so that item
     9 pins rather than decides: a choice first made while drafting the preregistration could
     demand new tooling and invalidate the hashes that document just pinned.
  9. **Write the v2 preregistration as a tracked release doc:** the six §f elements, the D5
     disclosure duties, frozen hashes and output schema, the window-close ordering, and the
     identities pinned SEPARATELY — the runtime bytes and config actually serving recall, the
     protocol/classifier commit, and the exact transaction-time cutoff. It must also state the
     **D3 window lifecycle** that no existing document fixes: what may be inspected while the
     window is open (C5.2 forbids stopping on observed scores, but counting qualifying
     exposures needs a preregistered BLINDED census procedure or a fixed close date — the
     classifier can count in-class exposures without reading ranks, and that must be written
     down rather than left discretionary), and the abort/reset rule if items 10–11 uncover a
     defect. Window open/close ordering itself is already fixed by D3 and rule §6.
  10. **Re-run the C1.3 retrodiction reproduction AT the freeze commit** rather than relying on
      the 2026-07-26 run.
  > **Items 5–10: see §11 (added 2026-07-31). The text above is unchanged and is the record of
  > what was asked on 2026-07-27/28; §11 states what was decided and where the two now disagree.**
  > Read together with it, because two phrases above are actively misleading on their own: item 6
  > asks for a minimum for the O_67 class, which **no longer has one**, and item 7 says both
  > shortfall labels block, which is now true of **Hit@1 only**. The method itself is written out
  > in [`v2-preregistration-2026-07.md`](./v2-preregistration-2026-07.md) — drafted, **not yet in
  > force**, since filling its §10 pin table is the freeze.
  11. **On the freeze commit itself:** the committed provenance-audit suite as the C1.1
      acceptance drill, and full suite + typecheck as C2.3. The two opt-in metered
      external-model end-to-end tests (the only skips in an otherwise green tree) are
      explicitly **NON-GATING** — no criterion requires them; running them once is optional
      supporting evidence, never a closure obligation.
  12. **LAST — mint and verify the off-machine source bundle** holding the frozen candidate and
      the historical tag (C4.6 Q3's freeze-coupled action; independent of the Q4 backup). It
      goes after items 10–11, not before: a bundle minted earlier is stale the moment a failed
      check forces a new commit. The bundle is an operational copy, not a measured surface, so
      minting it last does not touch the D3 window.
  Provenance, not steps (all four already applied 2026-07-27/28): D3's qualifier restored and
  the ordering clause reworded (C5.3); C1.3 cross-referenced to its open prerequisites, both
  directions; C1.4's stale "SHIPPED local" corrected and its cold-process dependency closed
  with evidence; the freeze-time source bundle added to the C4.6 summary and decoupled from
  the non-blocking Q4 backup.
- **C5.2 Stopping rule (PROPOSED, to be preregistered verbatim at freeze):** stop only after
  **≥ 20 eligible new product-decision probes** AND **≥ 14 days**, hard cap 28 days; the cap
  does NOT waive the minimum, and a starved window is never a trivial pass — it reports in the
  shipped rule's two labels, `UNEXERCISED — 0/E` when nothing qualified and `PARTIALLY
  EXERCISED — n/E (minimum not met)` when something did, and **both block release**
  (`o67-class-rule-2026-07.md:61-64`; see C5.1 closure item 7 — this text is preregistered
  VERBATIM, so the coarser single-label wording must not survive into the freeze);
  stopping never depends on observed scores; Hit@1 and O_67-class get separately frozen
  exposure/reporting rules. (At the observed ~1.65 ledger rows/day, 20 raw rows ≈ 12 days —
  but eligible product-decision probes accrue SLOWER than raw rows; hence the 14-day floor
  and the honest starvation clause.)
- **C5.2 SUPERSEDED 2026-07-30 — the bullet above is a PROPOSAL and is replaced by the one below.**
  It is left visible because it is the record of what was proposed on 2026-07-22, and because the
  reason it failed is itself evidence. It was calibrated on ~1.65 ledger rows/day; the measured
  rate is **0.78** — one row per active day, on about 78 % of days, stable over both the corpus's
  whole 41-day history and the 9 days since the v1 cutoff. A 28-day cap therefore yields about 22
  raw rows, and at the measured **14 %** marginal eligibility about **3** eligible probes. Reaching
  20 would take roughly `20 ÷ (0.78 × 0.14) ≈ 183 days`. The proposal above asked for a minimum its
  own cap could not deliver, and the same bullet made the shortfall block release — freezing it
  verbatim would have preregistered a gate that could not be passed.
- **C5.2 v2 window close (PROPOSED 2026-07-30, to be preregistered verbatim at freeze).** Scoring
  happens at a **fixed 28-day close**, not when a threshold is reached: closing as soon as the
  minimum accrues would let a healthy window be truncated the moment it became passable, so a fixed
  date is the strongest available form of score-blindness. "Stopping rule" is therefore a misnomer
  for v2 and is not used. The **14-day floor is removed** — under a fixed close it can never bind,
  and its derivation went with the 20. At the close: **Hit@1 requires ≥ 2 distinct eligible target
  identities** and every corresponding probe at rank 1; `UNEXERCISED — 0/2` and
  `PARTIALLY EXERCISED — 1/2 (minimum not met)` **both block release**. The **O_67 class does not
  participate in the close and does not block**; it reports `UNEXERCISED — 0` or `EXERCISED — n`
  (see the Q3 amendment in §7). The minimum of 2 is a **starvation floor, not a power
  calculation**, and must be labelled as such wherever it is reported: it is the smallest value at
  which no single event decides the verdict. Modelling one Bernoulli trial per day at
  `p = (7 rows/9 days) × (1 eligible/7 rows) = 1/9`, a 28-day window reaches 2 with probability
  **83 %** — so roughly one window in six is expected to starve and block, and that is a
  preregistered outcome rather than a surprise. Every Hit@1 verdict is reported with the nominal
  one-sided 95 % exact-binomial lower bound for the realized `x/n` under a common
  independent-success model, so a small realized `n` cannot be read as strong evidence: `2/2` bounds
  the true rank-1 rate only at **22.4 %**.
- **C5.3 Ordering.** Every criterion in this document lands **before or in** the freeze commit —
  not strictly before it, since C2.3 (green suite) and C5.1 (the freeze checklist itself) execute
  AT that commit by construction. What must not happen is a change AFTER the cutoff: D3's reset
  rule is scoped to "any intervening **system, config, rule, or metric** change"
  (`gate-decision-2026-07-22.md` D3, quoting `pilot-amendment-1.md` §f) — an earlier restatement
  here dropped that qualifier and so appeared to make a documentation commit reset the holdout
  window. It does not; the measured surface is code, config, and the frozen rules, not prose.
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
  count, fixed verbatim at the v2 freeze (C5.2 encodes this position). *Clarification
  2026-07-28 (not a re-decision): the decisive word is "minimum" — the later O_67 rule splits
  a shortfall into `UNEXERCISED — 0/E` and `PARTIALLY EXERCISED — n/E`, and reads Q3 as
  blocking BOTH (`o67-class-rule-2026-07.md:63`). Q3's single-label phrasing above predates
  that split and must not be read as licensing release on a nonzero shortfall.*
  **AMENDED 2026-07-30 — the O_67 half is withdrawn; the Hit@1 half stands.** The decision text
  and its 07-28 clarification above are left intact as the record of what Q3 required from
  2026-07-22 to 2026-07-30. From 2026-07-30 the v2 pilot may not release with **Hit@1** evidence
  short of its preregistered minimum (now **2** distinct eligible target identities), but
  **O_67-class evidence is reporting-only and does not block** — it carries no minimum, no `E`
  denominator and no `PARTIALLY EXERCISED` state, so the 07-28 clarification's "blocking BOTH"
  reading survives for Hit@1 alone. D5's duty to report an absent class as unexercised rather
  than silently validated is untouched. Reason, in one line: the v2 holdout is ledger-only and a
  ledger probe cannot structurally produce the class, so a blocking minimum would have been
  unreachable rather than demanding. Full record in §10.

## 8. Why-log (provenance of this draft)

Pre-registered skeleton (assistant): R1–R6 buckets + suspected-missing list + the
anti-goldplating guard. One collaborative cross-review round produced 8 findings: 7 accepted
— including four blocking (ratifiability requires R6; the prior design's drill set had been
dropped from the skeleton, now carried forward in full in §4; "weeks-scale" replaced by the
§5.2 stopping rule; the recall-index no-pain claim rejected as unconditional and the
observability gap recorded) — and one **rejected with evidence**: the claimed Node-version
inconsistency (README documents the runtime ≥20 / dev ≥24 split deliberately — at this
draft's commit `fb31d6c` the sentence sat at README line 229; later README additions
(`0cad1a6`, the C4.7/C4.9 sections) shifted it to line 243 as of `afc29c4`;
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

Post-ratification follow-up round (Codex compare, 2026-07-27/28) — the round budgeted at the end of
the first paragraph above, run against the RATIFIED text, producing the C5.1 closure list in §5.
Round one diverged on six points. Three were code-level and verified before adoption: the O_67
classifier discards item scope when building its candidate pool (`classify-o67.ts:95`), so
scope-qualification is a POOL change, not the schema-field addition C5.1 then described; the manifest
generator takes no transaction-time cutoff (`generate-manifest.ts:9`), so the temporal holdout is not
producible with current tooling; and `unambiguous` is computed over the project ledger alone (`:14`,
`:16-20`) while `run-pilot.ts` ranks the merged global+project universe, biasing eligibility
OPTIMISTICALLY. **Two of those three were later REFINED, and the round-one phrasing is kept here as
the record of what was concluded THEN, not as current doctrine** — see the sequencing paragraph
below: "POOL change, not schema addition" was a false either/or (both are needed), and the bias is
optimistic only for exposure accrual, conservative for the Hit@1 gate. Two of the draft's own points
survived on evidence: C5.3's restatement had dropped
D3's qualifier ("any intervening **system, config, rule, or metric** change"), which made a mere
documentation commit appear to reset the holdout window; and the C1.3 retrodiction must be re-run AT
the freeze commit rather than inherited from 2026-07-26.

Round two cost two failed calls first, and both are recorded because both are informative. The first
returned `AbortError` with no result — nothing is attributed to it. The second was MALFORMED BY THE
ASKER: the question said "the merged list is in my answer below", but `compare` mode by construction
sends Codex the neutral question ALONE, so the list was structurally invisible. Codex reported the
absence instead of inventing a list to grade — and, reading the workspace, found the real defect
underneath: the merged list existed only in conversation while C5.1 still carried pre-round-one text.
The list was therefore written INTO C5.1 and round two re-asked by file pointer.

Round two then diverged on five substantive points, each verified at its cited source before
adoption. (i) The binding procedure requires the candidate-universe artifact to be generated and
hashed at window close BEFORE scoring (`o67-class-rule-2026-07.md:140-142`), but the pool is
transient and only verdicts are written (`classify-o67.ts:95,106`) — an executability blocker the
draft had missed entirely; now item 2. (ii) The exposure unit is the PAIR `(scope, record-id)` (rule
`:59`), so `witnesses[].id` and `equalCoverage[]` need scope too, not just the target — folded into
item 1. (iii) **The draft's starved-window wording was WRONG**: it reported any shortfall as
"unexercised", but the shipped rule distinguishes `UNEXERCISED — 0/E` from `PARTIALLY EXERCISED —
n/E` and BOTH block (rule `:61-64`); D3 says only "unexercised" because it predates that refinement.
Item 7 now carries both labels and the reason for the discrepancy. (iv) D2 requires all six §f
elements fixed in advance (`gate-decision-2026-07-22.md:30-33`), but the draft settled only
eligibility composition and the sample side, leaving derivation/mapping, K and metric definitions and
system/config identity to be decided while DRAFTING the preregistration — where a new choice could
demand new tooling and invalidate the hashes just pinned; new item 8 settles or records their
carry-forward first. (v) The off-machine bundle was ordered before the freeze checks, so a failed
check would leave it stale; it moved to last (item 12), which does not touch the D3 window because an
operational copy is not a measured surface. One finding was MERGED, not adopted: Codex called the
metered external-model E2E sentence gold-plating and would delete it; it is kept but marked
explicitly NON-GATING, which removes the obligation objected to without losing the fact that the two
skips are deliberate rather than failures.

The open divergence resolved AGAINST the position that raised it: Codex WITHDREW its round-one "C1.3
prematurely marked DONE" recommendation, agreeing that DONE records a shipped deliverable while
freeze-readiness is a separate predicate C5.1 owns, and that reverting the marker would misreport a
shipped artifact as unshipped. Its proposed status line was adopted almost verbatim; the
cross-reference is now explicit in BOTH directions, with the reopen condition stated — reopen C1.3
only if the normative membership rule changes or the freeze-commit retrodiction fails, never merely
because identity is not yet pinned.

Round three was the convergence test, asked against the revised twelve-item list in the workspace.
It returned agreement on substance — every round-two finding closed, the bundle correctly last,
nothing newly missing or gold-plated — plus a ratification of the one MERGED disposition: the
non-gating external-model sentence stays, because it "documents deliberate skips without creating an
obligation". It added one precision, adopted: what lands pre-freeze for item 2 is the EMISSION
CAPABILITY; the artifact itself is still generated and hashed at window close, unchanged. And it
caught one INCOMPLETE PROPAGATION of the round-two label correction — C5.2, whose own header says it
is "to be preregistered **verbatim** at freeze", still reported every starved window as
"unexercised", so the coarse single-label rule would have been frozen into the binding
preregistration. Fixed. A sweep for the same wording elsewhere found three more sites that are
CORRECT as written (`pilot-protocol.md:177` and `:265`, and `gate-decision-2026-07-22.md:64`, all
describing the genuinely EMPTY case, which IS the zero label) and two carrying the coarse label over
a span that includes a
nonzero shortfall: §7 Q3 here, given an additive clarification that does not re-decide it, and D3 in
the ratified gate decision, deliberately NOT edited — amending a ratified decision record is an owner
call, and C5.1 item 7 already tells a later reader which form is the shipped one.

**CONVERGENCE DECLARED (2026-07-28, round three).** Round three surfaced no new substantive
divergence: it returned agreement plus one adopted precision (item 2's pre-freeze scope) and one
propagation fix that it characterised itself as "not a new substantive finding; it is incomplete
propagation of the already-resolved round-two label correction" — which is the protocol's stated
stopping condition. Three rounds, within budget; the exchange ends here.

Implementation-sequencing analysis of block 1–4 (2026-07-28, parallel code audit + adversarial
refutation of the sequencing claims; evidence in
the local sequencing-evidence record). The owner's draft answer — "start
with item 1, because item 2 depends on it and because items 1 and 4 share a scope-qualified identity
primitive" — fell apart on its first leg and half of its second, and is recorded here because the
correction took three passes to settle. Leg one, REFUTED: scope never had to come through the pool.
It rides on `RecalledItem` (`store.ts:64-72`) and `classify-o67.ts:95` narrows it away only AFTER
`recall()` returns, so a universe emitter placed before that `.map()` has scope for free — item 2 is
independent. Leg two, HALF refuted: the "reuse" framing is impossible, since the data flow runs
generator → manifest → classifier and an upstream generator cannot reuse a representation established
downstream — the only ARTIFACT coupling is the `unambiguous` boolean, pointing 4 → 1. But the
underlying observation survived a further pass: item 4 merges scopes into a `live` set whose
competitor map is id-keyed and last-wins (`generate-manifest.ts:15`, the same collapse as
`store.ts:523`) and whose competitor test compares bare ids (`:18`), so item 4 CREATES a cross-scope
collision surface and does need the scope-qualified identity item 1 settles. Three readings each held
a piece: the draft saw a shared primitive but mis-derived it from data flow, the audit refuted the
data-flow claim but declared the whole leg dead, and the verification pass found the primitive is
shared for a different reason than either had given. Six defects in the block's own text fell out and
are corrected above: item 1 does not fix the cross-scope collision it cited (the scope tag is already
collapsed at `store.ts:523/529`, the very last-wins hazard `retrieval.ts:353-357` fixed for the
scoring path and only that path); item 2's "nothing hashable survives" ignored the filtered
projection that DOES survive as `witnesses[]`/`equalCoverage[]`, which forces the artifact and the
verdicts to come from one in-run pool; item 4's bias is metric-dependent, self-penalizing for the
Hit@1 gate and inflationary for exposure, not uniformly optimistic; the blanket "ordinary
implementation work, not a governance item" clause is false for item 4, which D5 binds to
new-temporal-case validation and disclosure; the "each block consumes the previous block's output"
rationale is false inside 1–4; and C5.1's "a POOL change, NOT the schema-field addition" framing was
a false either/or — the pool change is the prerequisite FOR the schema change, and rule §6 pins that
schema at the freeze. Two measurements
decided as much as the reading did: the C1.3 retrodiction still reproduces BYTE-IDENTICALLY at HEAD
(so it is a live regression lock, and item 2 is sequenced first partly to keep it one), and the
frozen snapshot is 25 project rows to 1 global row with an empty id intersection — which makes item
4's fix unfalsifiable there and its collision hazard vacuous there, converting two blocking questions
into a guard and a documented limitation.

Lessons: (a) in `compare` mode the ARTIFACT is the channel — whatever is under review must be IN the
workspace, because the answer field never reaches the other reasoner; the malformed call's one
benefit was forcing the plan out of conversation and into the tracked doc where it belonged; (b) a
failed call is not a finding and is attributed nothing; (c) the sharpest correction of the round was
a LABEL — the draft had inherited D3's coarser vocabulary for a case the shipped rule splits in two,
the kind of drift only a reader holding both documents at once will catch; (d) a correction is not
applied until it is PROPAGATED — fixing the plan while leaving the stale wording in text marked
"preregistered verbatim" would have frozen the error into the binding artifact, so the last act of
resolving a wording defect is a repository-wide sweep for the old wording, judging each hit in
context rather than replacing it mechanically.

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
- **L2 No one-step undo for permanent lifecycle operations (limitation ACCEPTED; playbook DELIVERED
  2026-07-27).** A soft erase is a recoverable tombstone, but a permanent erase or a wrong supersede
  has no one-step undo; recovery is by re-commit. The owed playbook shipped as
  `recovery-playbook.md` (this directory) — every recipe executed against the shipped bundle, not
  inferred: the window-open checks, the `asOf`-not-`history` retrieval route, what a re-commit does
  NOT restore (id, grade, verifications, bitemporal interval), the re-confirm eligibility rule, and
  the C4.6-Q4 backup command. Two by-products, both fixed in the same change: README described the
  `helix_memory_erase` TOOL as physical erasure in three places (tool table, "How it works",
  intro) — false for the shipped soft-only tool, contradicted by SECURITY.md, and doubly harmful
  (it tells a user their data is gone, so they never look for the undo window, while overstating
  the destruction guarantee); and README's compaction-observability paragraph claimed that with
  `metrics.enabled: false` a compaction leaves "no trace at all" — disproven by executing one
  (`witness-log.jsonl` records every rewrite ungated by metrics), so the corrected text now names
  that file as the reliable rewrite record. Also newly documented, because it appeared nowhere:
  the history-vs-`asOf` redaction asymmetry (erase-closed rows render content-blank,
  supersede-closed rows keep their content). One reviewer pass on the playbook produced a further
  eight corrections, all verified by execution before folding in — including a headline `tar`
  command that failed as printed (missing `mkdir -p`) and the cross-scope supersede refusal that
  strands a user mid-recovery without an explicit `scope`.
- **L3 Provenance boundary clarity.** The provenance WIRING is audited closed (C1.1), but the
  user-relayed vs agent-inference boundary can read as ambiguous in use — a docs/UX limitation,
  accepted for v0.1.

## 10. Amendment record — 2026-07-30 (owner decisions D-a and D-b)

This section exists so that the sections above can be left as they were written. Nothing earlier in
this document has been rewritten; two sites carry inline amendment markers because their own text
says they are transcribed VERBATIM at the freeze and would otherwise be frozen stale — the Q3 bullet
in §7 and C5.2 in §5. Everything else that the two decisions touch is listed here instead, which
also keeps every existing `file:line` citation into §1–§9 valid.

**The two decisions.** *D-a*: O_67-class exposure is removed from the release-blocking set and
becomes reporting-only; the Hit@1 half of Q3 stands, with a minimum of 2. *D-b*: in-class members
REMAIN in the binding Hit@1 denominator — the exclusion-plus-shadow default in
`o67-class-rule-2026-07.md` §4 is replaced, not confirmed. Both are recorded normatively in that
rule's §4 amendment, and in `gate-decision-2026-07-22.md` after D5.

**Why.** Measured 2026-07-29: the v2 holdout population is ledger-only, and a ledger probe derives
its query from its own target, so the target matches essentially every query term and no competitor
can strictly superset it. The record that produced v1's only in-class case is NOT in class when
probed from the ledger side, and 0 of 25 ledger probes are in class — a v2 window could not have
caught v1's own O_67 case. A blocking minimum would have been unreachable rather than demanding.
Separately, the corpus grows at 0.78 rows/day, not the 1.65 C5.2 assumed.

**What each affected passage should now be read as saying.** None of these are rewritten in place.

| passage | read as |
|---|---|
| §1 C1.3 integration paragraph, "the gate-composition confirmation (`finalHit1Eligible` is named for a composition the freeze must confirm or rename)" | Resolved: the composition was REPLACED (D-b), so the field is **deleted**, not renamed. `baseHit1Eligible` becomes `hit1Eligible`. The prerequisite is now an implementation task, not an open decision. |
| §1 C1.3, "the base-eligible set" and "the exposure minima" (plural) | There is one eligibility tier, not a base and a final; and one minimum, Hit@1's. |
| §5 C5.1 header, "the exposure policy from open decision Q3" and the `finalHit1Eligible` confirm-or-rename obligation | Q3 is no longer symmetric across the two components; the field obligation is discharged by deletion. |
| §5 closure item 5, "Confirm or replace the O_67 gate composition" | **Done** — replaced (D-b). |
| §5 closure item 6, "separate positive-exposure minima for Hit@1 and for the O_67 class" | **Done, asymmetrically** — Hit@1 gets a minimum of 2; the O_67 class gets none. Sample unit: distinct target identity `(scope, record-id)` for both, with the metric denominator being the corresponding eligible probe rows. |
| §5 closure item 7, the two blocking labels applied to both components | Hit@1 keeps `UNEXERCISED — 0/2` and `PARTIALLY EXERCISED — 1/2`, both blocking. O_67 has `UNEXERCISED — 0` and `EXERCISED — n`, neither blocking. The instruction "a nonzero shortfall must not be reported as `UNEXERCISED`" holds for Hit@1 only; O_67 has no shortfall state. |
| §5 closure item 8, "what remains here is query-derivation/mapping and K + every metric definition" | **Done.** Derivation rule v1 and K = 20 carry forward unchanged. The mapping rule is fixed POSITIVELY as mechanical identity mapping, `relevant = [record.id]` — not waived as "not applicable", which would leave a required D2 element unfilled. Oracle segmentation and the manual oracle mapping do not execute in v2 and receive no validation claim. All seven gate conditions are settled, including one added: protocol and population integrity. |
| §5 closure item 9 | Still open, and now larger: it must also carry the amendments recorded here, the full seven-condition gate, the deterministic-payload/audit-receipt split, and the provenance chain from freeze receipt to release record. |
| §5 closure item 10 | Unchanged in substance, but now certain rather than conditional: the classifier's output schema changes, so the retrodiction MUST be re-run and re-baselined at the freeze commit. |
| §8 why-log, and §5's block 1–4 narrative | **Deliberately not amended.** A why-log records what was concluded on a date, not current doctrine; the same reasoning left D3's coarser wording standing when it was noticed on 2026-07-28. Read those passages as history. |

**Where the reasoning lives.** The decisions were taken after three symmetric peer-synthesis rounds
plus a fourth on the gate conditions, and the reconciliation — including four points on which this
session's first answer was wrong and had to be withdrawn — is in the working design record:
the local v2 gate-composition design notes (2026-07-29), §9. That workspace is gitignored, so
this section and the two normative amendments are the tracked account; C5.1 closure item 9 folds
them into the v2 preregistration.

---

## 11. Amendment record — 2026-07-31 (C5.1 closure items 5–10)

Appended at the end so no line number above it moves. §5's closure list is **unchanged and left
visible**; this section states the disposition of items 5–10 and supersedes their text where the
two now disagree. The method they settle is written out in the new tracked document
[`v2-preregistration-2026-07.md`](./v2-preregistration-2026-07.md), which is **drafted but NOT YET
IN FORCE** — its §10 pin table is unfilled, and filling it is the freeze.

| item | disposition |
|---|---|
| **5** — confirm or replace the O_67 gate composition | **SETTLED and SHIPPED.** Owner decision D-b replaced the recommended default: in-class members REMAIN in the binding Hit@1 denominator, so there is no exclusion and nothing to shadow. `finalHit1Eligible` was **deleted rather than renamed** — a "base" only means something against a "final" — leaving one tier, `hit1Eligible`, echoing the manifest's flag on every return path including the unscorable ones. |
| **6** — separate minima and the sample unit | **SETTLED, asymmetrically.** Hit@1 takes a minimum of **2** distinct eligible target identities, explicitly a starvation floor rather than a statistical minimum. The O_67 class takes **no minimum at all**: D-a made it reporting-only, so its `E` denominator does not exist. The sample unit's three roles — exposure, denominator, success rule — are stated separately and coincide only because a ledger-only holdout emits one probe per record; that coincidence is frozen as an invariant and preparation fails closed on a duplicate identity. |
| **7** — shortfall consequence in the shipped labels | **SETTLED; the item's "both block" is superseded for O_67 only.** Hit@1's `UNEXERCISED — 0/2` and `PARTIALLY EXERCISED — n/2 (minimum not met)` both block. The O_67 labels block neither. `UNSCORABLE — GATE FAILURE` is unchanged and its scope is now the whole pipeline. The item's "28-day cap" framing is also superseded: v2 has a **fixed 28-day close**, not a cap over a stopping rule, so the cap can never function as a waiver because there is no earlier stop to waive. |
| **8** — adopt or carry forward the remaining D2 elements | **SETTLED.** All six are filled in the preregistration §3. The item correctly predicted this would be mostly transcription; one element was not. The **mapping rule is filled positively** as mechanical identity mapping rather than waived as "not applicable" — v2 runs no oracle side, but mapping still occurs, and recording it as N/A would leave a required element unfilled and invite the reading that v2 skipped it. |
| **9** — write the v2 preregistration | **DRAFTED, not in force.** It carries the six §f elements, the D5 duties, the window-close ordering, the separately-pinned identities, and the D3 window lifecycle no existing document fixed. One requirement in the item lapsed: a **blinded census procedure** is no longer needed, because a fixed close means a count of qualifying exposures cannot change when scoring happens. What replaced it is an explicit inspection rule — nothing derived from ranks may be read while the window is open — so the absence of a stopping decision is verifiable rather than asserted. |
| **10** — re-run the C1.3 retrodiction at the freeze commit | **Unchanged, still due at the freeze.** Recorded for continuity: the anchor was re-verified on 2026-07-30 across the eligibility-field change and reproduced **verbatim** on both manifests, needing no re-baseline. That is not a substitute for the freeze-commit run. |

**A pre-freeze code obligation this section discovered.** Writing the preregistration's evidence
chain surfaced a requirement nothing satisfies: the chain binds **runner outputs embedding the
prepare hash and the run id**, and `run-pilot.ts` writes neither. Adding them naively would break
the stability condition, since a run id differs on every run — so the runner must adopt the
payload / receipts split, and the scoring phase must compare **payload** hashes rather than
whole-file hashes. The two are one change. Likewise the **freeze receipt**, the
**prepare-before-run ordering receipt** and the **release record** have no producer yet. All of it
must land **before** the freeze: building method tooling afterwards resolves a method choice and
resets the window.

**Why this was written before the remaining code.** Doing item 9 first was an owner decision, and
it paid for itself immediately — the runner/stability coupling above would otherwise have surfaced
midway through building the reporting tooling, after its shape was already fixed.

**One measurement corrected while writing this.** C5.2's superseded bullet (§5) describes the
accrual rate as "0.78 — one row per active day, on about 78 % of days". Re-measured 2026-07-31
over the live corpus, the **rate is confirmed** at 0.77 rows/day, and the corpus still holds **33
rows, all `assert`, with zero closer rows across its whole 43-day history** — but the
*decomposition* is wrong: activity falls on **24 of 43 days (56 %)** at about **1.4 rows per
active day**. The product is the same, so the 183-day arithmetic that retired the 20-case proposal
is unaffected and no conclusion moves. The distribution claim is corrected here rather than in
that bullet, which stays as the record of what was written on 2026-07-30.

---

## 12. Amendment record — 2026-08-02 (§11's code obligation DELIVERED)

The pre-freeze code obligation §11 recorded is **done**; the preregistration's §9b carries the
authoritative delivery note, and this section only fixes the readiness ledger. What landed, in
the tree and green (typecheck clean; full suite 1871 passed / 2 skipped, the two being the
long-standing opt-in metered external-model tests):

- **§9b's two bullets**: the runner's payload/receipts split with payload-hash Stability
  comparison, and producers for the freeze receipt, the ordering receipt and the release record.
  Element 1 became TWO artifacts (`freeze-receipt.ts` at T, `input-pins.ts` at the close, bound by
  `freezeSha256`) because §9's own ordering makes a single receipt unissuable at its ordered
  position — the first adversarial-review round proved the one-artifact design could only be
  issued after the close, exactly what §8 forbids.
- **Four rounds of adversarial verification with live CLI reproductions**, each round's confirmed
  findings regression-locked before the next: a query-swap and a K-swap invisible to every
  id-level check; a snapshot substitution and a silent scope degradation via a deleted ownership
  registry; a macNonce swap, a planted witness journal and an emptied semantic-neighbor table,
  each flipping the release verdict with all then-current pins green; the runner minting a nonce
  INTO the frozen snapshot; `tx > close` rows passing preparation and post-close closers inflating
  `Es`; and the freeze receipt pinning working-tree bytes no commit contained. The repairs widened
  the pinned-input surface to **ten names** and the pinned-tool table to **25 paths + 2 method
  docs** (prereg §10, rows dated 2026-08-02), added tree-vs-commit divergence refusal at the
  freeze, close-time re-verification of the method pins (§9a's sentence now has an implementer),
  and a byte-identity regression test over the whole snapshot across a successful run.
- **Residuals accepted and stated in the artifacts themselves**: nothing signs a run
  (self-attested chain; the ordering receipt's honesty text and the stability condition's detail
  say exactly what is and is not established), `redactionAcknowledged` remains a declaration, and
  the runtime identity is verified at freeze/deploy time, not re-derivable at the close (the pins'
  attestation says so).

C5.1's remaining pre-freeze work is unchanged by this section: fill prereg §10 and commit — the
freeze — then run the close sequence the tooling now enforces.
