# Helix — preregistered recall pilot, protocol v2

Date drafted: 2026-07-31 · §10 filled: 2026-08-02 · Status: **IN FORCE from the commit that
carries this filled table — that commit is the freeze.**

§10's pin table is **filled** from the freeze receipt
([`v2-freeze-receipt-2026-08.json`](./v2-freeze-receipt-2026-08.json), payload
`55720757298abee064f5a319bd4e31ef723c2ed18d21f36fc0d7b8418d24a89c`), issued by the committed
`freeze-receipt.ts` after it verified the working tree equal to the candidate commit for every
pinned path and the cutoff equal to that commit's authored time. The measurement window is
`2026-08-02T11:35:05.000Z < tx ≤ 2026-08-30T11:35:05.000Z`. `gate-decision-2026-07-22.md` D2 is
explicit that v2 becomes *prospective* only when its actual method is frozen — a half-pinned
document is not a preregistration, which is why this header carried **DRAFT — NOT YET IN FORCE**
until the table below was filled.

Governing texts: `gate-decision-2026-07-22.md` (D1–D5, BINDING, as amended 2026-07-29/30),
`o67-class-rule-2026-07.md` (BINDING, as amended 2026-07-30),
`readiness-criteria-2026-07.md` (§5 closure list, §7 owner decisions).
`pilot-protocol.md` is the **HISTORICAL** v1 method: it is not rewritten, and this document — not
that one — is the acceptance test for the release it governs.

---

## 1. The claim v2 supports, and what it does not

v2 exists to support this and nothing stronger:

> **The release decision was governed by a rule frozen before the v2 window, and no method,
> product, or remediation decision was informed by the v2 holdout's contents or outcomes.**

The wording is deliberate. "A rule not adjusted after seeing results" would be **false**: D5
requires disclosing that v2's gate design *is* informed by v1's O_67 outcome, and it plainly is.
The claim's scope is the **v2 window's** contents and outcomes, not every result ever seen. The
honest position is not "we looked at nothing" but "here is what we looked at, and here is the
not-yet-seen material we agreed to be graded on."

**What v2 does NOT claim.** It must not support an inferential or general recall-performance
claim. `pilot-protocol.md:38-43` already caps this exercise for v1 and v2 alike — same author,
same corpus, same process, therefore development evidence, not independent efficacy evidence —
and no sample size repairs that dependence. A realized `x / n` is weak *descriptive* evidence
about those specific cases and may be reported as such; the inferential step to "Helix recall
performs well" is forbidden.

**Honest coverage statement.** v2 is a prospective, ledger-only temporal validation of
self-derived decision queries. It is not a repetition or replacement of v1's two-sided pilot. v1
scored 25 ledger probes plus 26 independently worded oracle probes with a manual semantic mapping
and 4 preregistered coverage gaps; v2's population is structurally ledger-only, so coverage gaps
cannot arise and the human oracle no longer independently checks what the memory failed to
capture. **v2 does not validate** oracle segmentation, retrieval from an independent human
restatement, the manual mapping, or resolution of the oracle-side O_67 failure.

---

## 2. Population — the temporal holdout window

The measured population is **ledger records only**, selected by transaction time:

```
cutoff < tx ≤ close
```

- **cutoff** = the **candidate commit's** authored time, canonical UTC
  (`YYYY-MM-DDTHH:MM:SS.sssZ`), compared with a strict string `>`; the freeze instant itself is
  **not** in the holdout. *(Clarified 2026-08-02; an earlier draft said "the freeze commit's",
  which is circular: the freeze commit is the one that carries §10's filled table, so it cannot
  exist when the freeze receipt is issued and its authored time cannot be verified at issue time.
  The candidate commit — the code identity §10 pins — is knowable at T, and `freeze-receipt.ts`
  verifies `--cutoff` against exactly it, refusing disagreement. The freeze COMMIT then follows
  the receipt, containing it.)*
- **close** = cutoff + 28 days, the same canonical form, **inclusive**, because the close is the
  window's last moment rather than the boundary before it.

The two bounds do not have the same reach, and the asymmetry is deliberate. The cutoff narrows
the probe **source** only — a record minted before it still competes for rank at scoring time, so
dropping it from the competitor set would flatter the holdout exactly where the holdout is meant
to be hardest. The close bounds the **entire corpus**, every scope and both roles, because it
stands in for an atomic snapshot taken at the close instant: a record that did not exist then
cannot have competed, and a post-close `supersede` / `invalidate` / `erase` must not reach back
and close a record that was live at the close.

Oracle entries are **not** in the population. They are not ledger records and carry no `tx`, so
no window can date them; the generator enforces this structurally by refusing an oracle side
together with a window.

**Deriving the cutoff has a trap that must not be repeated.**
`git log --format=%ad --date=format:'…Z'` renders in the **commit's own** timezone, so stamping a
literal `Z` yields a time wrong by the author's UTC offset. Use
`TZ=UTC git log -1 --format=%ad --date=format-local:'%Y-%m-%dT%H:%M:%S.000Z' <commit>`.

---

## 3. The six §f elements (D2), filled

D2 requires all six fixed in advance (`gate-decision-2026-07-22.md:30-33`). "Fixed in advance"
means **before the window**, not "identical to v1": the metric form may legitimately be revised,
and D5 expressly anticipates a revised subset rule validated on new temporal cases only.

| D2 element | v2 |
|---|---|
| system and configuration identity | pinned in §10 |
| eligibility rules | the manifest's `unambiguous` flag, computed against the **merged global + project** competitor set — the universe production recall actually serves |
| query derivation and mapping rules | derivation rule v1 unchanged (`pilot-protocol.md` §3a, `:117-131`, six ordered steps over `derive.ts`'s `topicTerms`); **mapping rule = mechanical identity mapping**, `relevant = [record.id]` |
| K and every metric definition | K = 20 unchanged; Hit@1 per §5; the full gate, all seven conditions, in §4 |
| the holdout cutoff | §2 — the candidate commit's authored time, canonical UTC, strict `>`, plus the close instant |
| minimum sample size or explicit stopping rule | minimum **2**, with a **fixed 28-day close** (§5) |

**The mapping element is filled positively, not waived.** Recording it as "not applicable"
because v2 runs no oracle side would leave a required element unfilled and invite the reading
that v2 skipped it. Mapping *does* occur — mechanically — so naming the rule is both accurate and
complete. Oracle segmentation and the manual oracle mapping are outside the v2 measured method
and receive **no validation claim**.

---

## 4. The gate — all seven conditions

v1 gated six conditions (`pilot-protocol.md:181-194`). **All six are carried into v2; only
Recall@20 survives unaltered, and one condition is added.**

| condition | disposition | denominator / exposure | blocks? |
|---|---|---|---|
| **Recall@20 = n/n** | predicate unchanged | every probe | yes |
| **Hit@1 = m/m** | altered (denominator, minimum — §5) | distinct eligible target identities; `M < 2` blocks | yes |
| **Target-relative contradiction = 0** | altered — renamed, re-anchored, narrowed to semantic negation | every probe | yes |
| **Stale-served-as-live = 0** | altered — exposure semantics; violation rubric retained verbatim | `Es` = valid closer relationships in the as-of-close snapshot | only when `Es > 0` |
| **Errors / unscorable = 0** | altered — scope widened to the whole pipeline | snapshot validation, prepare, classifier, runner, adjudication completeness, scoring | yes |
| **Stability** | altered — scope widened, payload split | 3 runs of the deterministic payload | yes |
| **Protocol and population integrity** *(new)* | binding | the provenance chain of §9, end to end | yes |

**Recall@20 is kept as a regression tripwire, not as evidence.** In v2 every probe has a
retrievable target by construction — a ledger probe targets the record it was derived from — and
coverage gaps are impossible because they arise only on the oracle side. Measured on the frozen
snapshot, all 25 ledger-side targets ranked 1 and the worst rank among 47 targeted probes was 3,
against a threshold of 20. **The threshold is enormously slack**, so a pass yields a tight-looking
bound on an event that is nearly certain regardless of system quality. Its reported bound must
never be presented as evidence of recall quality. It is kept because a change that genuinely
broke retrieval would trip it and the cost of keeping it is zero.

**Target-relative contradiction**, re-anchored for v2 because v1's rubric names "the oracle
entry's current statement" and v2 has no oracle side:

> A returned live record that addresses the same proposition asserts the **negation** of **the
> probe target record's** current statement. Both texts are quoted and recorded.

**This is a construct change, not a substitution, and must be labelled as one.** v1's condition
asked whether retrieval agreed with an *independently maintained human statement*. In v2 the
target and the query source are the same ledger record under mechanical identity mapping, so the
condition can only test **internal retrieval coherence relative to that target**. It cannot show
that the target is correct, complete, or consistent with any external account. **v2 must not
describe it as oracle validation.** It remains a judgment condition, adjudicated with quoted text
recorded for every call.

The "superseded form" half of v1's rubric moves **out** of this condition and into the stale
condition below. v1 defines that half semantically — "an outdated version of what the decision
currently is" — and two live `assert` rows can stand in that relation with no closer row
existing. Zero closer rows establishes zero *structural* staleness, not zero *semantic*
staleness. So: semantic negation between live records stays here; structurally closed or
superseded records go exclusively to stale. Each hazard has exactly one home.

**Stale-served-as-live.** The violation rubric is retained verbatim from v1 — a closed record
appears in the top-K without its current form at an equal-or-better rank — and any violation
blocks. What changes is exposure:

> `Es` = the number of valid **closer relationships** in the **as-of-close snapshot** — not the
> number of closed records that happen to be returned. Violations are then sought in the top-K
> outputs. `Es = 0` reports `UNEXPOSED — no temporal evidence`, non-blocking; `Es > 0` makes the
> condition binding exactly as in v1.

`Es = 0` is the expected state. Measured 2026-07-31 over the live corpus
(the dogfood tinytask project ledger plus the global ledger; path de-identified 2026-08-12,
measurement content unchanged): **33 rows, every one an `assert`, zero `supersede` / `invalidate` /
`erase` rows across the corpus's entire 43-day history**, of which 8 postdate the v1 cutoff. So the
condition is expected to report
`UNEXPOSED` unless the owner corrects or retracts something during the window — which is precisely
why its consequence is disclosure rather than a block.

**Why unexposed stale does not block while unexercised Hit@1 does.** Not a logical distinction —
in both cases the opportunity count is zero. It is a preregistered policy, stated as one:

- Hit@1 carries an explicit **evidence-sufficiency floor**. `M = 0` yields `0/0`; `M = 1` lets a
  single event decide the verdict. A shortfall blocks because the pilot's primary measurement did
  not happen.
- Stale handling is a **zero-violation safety property** whose organic exposure depends on
  whether the owner happened to correct or retract anything. No minimum stale fixture is
  preregistered, so `Es = 0` is reported honestly but must not convert an absence of churn into a
  release failure.
- **And the release is not untested on stale handling.** C2.3 requires a green suite at the
  freeze commit, and `test/memory/projection.test.ts` deterministically verifies that
  `supersede`, `invalidate` and `erase` remove their predecessors from the live projection. The
  pilot's contribution here would be *temporal* evidence on top of a fixture that already exists,
  which is why its absence is disclosable rather than disqualifying.

**Errors / unscorable = 0, pipeline-wide.** v1's condition was per-probe. v2 has more stages that
can fail silently, so the condition covers snapshot validation, the prepare phase, the
classifier, the runner, adjudication completeness, and scoring. Zero failures anywhere.

**Stability, with the payload split.** v1 compared three runner outputs byte for byte. v2 adds
stages, and a naive "three runs of the whole chain byte-identical" would **contradict** the
integrity condition, which requires retaining real wall-clock timestamps and run identifiers that
differ on every run by construction. The two are reconciled by splitting every artifact:

> Each artifact separates a **deterministic payload** from **volatile audit receipts** (real
> timestamps, run ids, host facts). Stability compares **payload hashes only**: run the runner
> three times and require `h1 = h2` and `h1 = h3`; then re-run deterministic scoring against the
> same adjudication input and require the same equality. Audit receipts are retained and hashed
> into the provenance chain, never into the stability comparison.

**Shortfall labels and their consequences:**

| component | labels | consequence |
|---|---|---|
| Hit@1 | `UNEXERCISED — 0/2` · `PARTIALLY EXERCISED — n/2 (minimum not met)` · `EXERCISED — n/2` | first two **block** |
| O_67 class | `UNEXERCISED — 0 distinct cases observed (reporting only, non-blocking)` · `EXERCISED — n distinct cases observed (reporting only, non-blocking)` | neither blocks; reporting only |
| any classifier / mapping / snapshot / pipeline error | `UNSCORABLE — GATE FAILURE` | blocks |

---

## 5. Sample unit, minimum, close, and the reported bound

**Sample unit — three roles, stated separately:**

| role | unit |
|---|---|
| exposure / minimum | distinct post-cutoff target identity `(scope, record-id)` |
| metric denominator | the eligible probe rows corresponding to those identities |
| success rule | every one of those probe rows ranks 1 |

Under a ledger-only holdout the generator emits exactly one probe per source record, so all three
coincide. **That coincidence is frozen as an invariant and preparation fails closed on a
duplicate identity**; otherwise paraphrase probes could inflate the nominal sample and break the
independence the reported bound rests on.

**Minimum: 2.** Explicitly a **starvation floor, not a statistical minimum**. Nothing statistical
selects 2; it is the smallest value at which no single event determines the outcome. Raising it
buys no evidence: because the window closes on a fixed date, the minimum is evaluated once at the
end rather than acting as a stopping condition, so a window realizing 3 cases gives the same
result under either minimum and a higher minimum only causes 2-case windows to block.

**Close: a fixed 28-day close, not a stopping rule.** Scoring happens at the preregistered close
instant regardless of how many cases accrued. This is the strongest available form of
score-blindness: closing "as soon as the minimum is reached" would let a healthy window be
truncated the moment it becomes passable. Two consequences: the earlier proposal's **14-day floor
is removed** — under a fixed close it can never bind — and the term "stopping rule" is a misnomer
for v2 and must not be used; it is a **close rule**.

**Reported bound.** Every Hit@1 verdict is reported together with the **nominal one-sided 95
percent exact-binomial lower bound for Hit@1 under a common independent-success model**. Not a
bound on the gate as a whole, and the model qualification travels with the number.

```
L(x, n) = 0                                  if x = 0
L(x, n) = BetaInverse(0.05; x, n - x + 1)    if x > 0
L(0, 0)  undefined — report N/A, never 0
```

`0.05^(1/n)` is the **all-success special case only**; using it for a failed result is wrong.
Worked values: `2/2 → 0.2236`, `1/2 → 0.0253`, `0/2 → 0`, `28/28 → 0.8985`.

**Why report it at all, and how not to read it.** The gate demands a perfect score over the
eligible subset, so the bound is protection against misreading a small realized ratio as strong
evidence — it is **not** a substitute for sample size. A bound describes sampling error, not how
hard the test was. Reporting it alongside Recall@20, whose threshold is slack, is the clearest
illustration: 22 of 22 yields 0.873 on an event that was nearly certain anyway.

**Accrual is not forecast.** Any scenario table in supporting material is illustrative only, for
three reasons: the marginal eligibility estimate rests on a single eligible event; eligibility is
measurably declining as the corpus grows; and **eligibility is not monotone in time** — it is
recomputed against every live competitor at close, so a record added late can make an earlier
probe ambiguous, and records can leave the live projection entirely.

**Cost of a starved window, stated accurately.** D3 freezes the *measured candidate and
configuration* for the window's duration, not all development: work may continue elsewhere so
long as the measured surface is untouched. A starved window costs the window, not the month.

---

## 6. The O_67 class — reporting only, threshold-free

Owner decision **D-a** (2026-07-30) removed O_67-class exposure from the release-blocking set;
owner decision **D-b** keeps in-class members **in** the binding Hit@1 denominator. There is
therefore no `E` denominator, no `PARTIALLY EXERCISED` state, and no shadow Hit@1 — with no
exclusion there is nothing to shadow.

Report:

- the full single-target census;
- the number of distinct in-class target identities;
- how many of those are Hit@1 eligible;
- per case: witnesses, best rank, Hit@1, Recall@K;
- the label `UNEXERCISED — 0 distinct cases observed (reporting only, non-blocking)` or
  `EXERCISED — n distinct cases observed (reporting only, non-blocking)`.

**The class does not participate in the close rule.** If it did, a window with zero in-class
cases could never close, reintroducing exactly the starvation D-a removes.

**Honest qualification.** D-b does **not** guarantee the class is ever tested. If no in-class case
appears — the expected outcome — D-b and the old exclusion produce identical results, and D5's
unexercised report applies either way. D-b's real effect is that *should* a case appear, it is
graded rather than set aside. **In-class membership grants no Recall@20 exemption.**

The membership rule itself is unchanged and is `o67-class-rule-2026-07.md` §2, with the candidate
universe of its §3 and the fail-closed statuses of its §4.

---

## 7. D5 disclosure duties

These are duties, not options, and they are what make the non-blocking treatment of §6 honest
rather than quiet:

1. **v2's gate design is informed by v1's O_67 outcome and must say so wherever v2 is
   described.** This document is one such place; the final report is another.
2. **Any revised unambiguity/subset rule validates on NEW TEMPORAL CASES ONLY.** The merged-scope
   competitor denominator (§3) is such a revision: widening the competitor set can only move
   probes *out* of the unambiguous subset, so it relaxes Hit@1 and tightens O_67 exposure
   accrual. The frozen corpus cannot demonstrate it — 25 project rows against 1 global row, no
   probe flips either way — so it carries **no v1 validation claim**.
3. **An absent class is reported unexercised, never silently validated.**
4. **The measured method's limits are stated with the result**, not in a footnote: §1's
   coverage statement travels with every published verdict.

---

## 8. Window lifecycle (D3) — open, inspect, reset, abort

**Open.** The window opens at the commit that fills §10 and commits this document.

**What may be inspected while the window is open.** This is fixed here rather than left
discretionary. Permitted: **nothing derived from ranks.** The classifier is outcome-blind by
construction and may be run at any time; the prepare phase is outcome-blind and may be run at any
time. Forbidden until the close instant: running the pilot runner over window records, reading
any rank or hit, and any use of such a reading to choose when to stop — the close is fixed, so
there is no stopping decision to corrupt, and this clause exists so that the absence of one is
verifiable rather than asserted.

Counting qualifying exposures during the window needs no special procedure precisely because the
close is fixed: a count cannot change when scoring happens. Where an earlier draft required a
blinded census procedure, the fixed close supersedes that need.

**Reset.** Any intervening **system, config, rule, or metric** change resets the window, which
restarts from the change (`pilot-amendment-1.md` §f, D3). The measured surface is code, config
and the frozen rules — **not prose**: amending a document that does not change a measured rule
does not reset the window. Building any of the method's tooling *after* the freeze **does** reset
it, because implementing an unspecified detail resolves a method choice.

**Abort.** If the retrodiction re-run or the freeze-commit checks uncover a defect in the frozen
method, the window is **aborted, not repaired in place**: the defect and its discovery date are
recorded, the fix lands, and a new freeze opens a new window. A repaired window would be a window
whose method changed after it opened.

**A post-gap fix and its immediate recheck are remediation verification, never independent
forward evidence** (D3).

---

## 9. Execution order, the evidence chain, and the final report

This section is the **integrity condition** of §4 made checkable, and it is what the reporting
tooling must satisfy.

**Ordering.** At the close, in this order, each step completed and hashed before the next begins:

```
freeze receipt → close-bounded snapshot → manifest / candidate universe / classifier
              → prepare → runner outputs → adjudication → score → release decision
```

Nothing that reads a rank may run before the prepare artifact exists and is hashed.

**Retained evidence, each element binding its exact parents:**

1. a **freeze receipt** binding the candidate commit, the configuration, the method and tool
   hashes, the cutoff and the close instant;
2. an **as-of-close snapshot hash** demonstrating `cutoff < tx ≤ close`;
3. the **manifest, candidate-universe, classifier and prepare** artifacts;
4. an **append-only or externally attested receipt** showing `prepare-finished` before
   `runner-started`;
5. **runner outputs embedding the prepare hash and the run id**;
6. an **adjudication artifact** binding the runner-output hash and quoting both sides of every
   judgment;
7. a **score artifact** binding the prepare, runner and adjudication hashes;
8. a **release record** binding the score hash and showing the preregistered consequence was
   actually applied.

**If the chain cannot be reconstructed from retained evidence, the gate fails.**

**What this closes and what it does not.** A single coordinator that refuses pre-existing outputs,
mints a fresh run id, creates every file exclusively, parent-links each artifact and is the only
permitted path to the runner closes the *careless-operator* class — an exploratory pass run first,
paths reused or overwritten, files copied with metadata preserved, a clean-looking official
sequence assembled after outcomes were already visible. It does **not** prove that no such earlier
pass occurred, and no self-attested timestamp can. Self-reported wall clocks are labelled as such
in every artifact that carries one.

**Two conditions are structurally always-pass in a report that exists.** Every pipeline check
fails closed and refuses to produce a report, so `Errors / unscorable` and the mechanical half of
`Protocol and population integrity` cannot appear as failures in a file that was written at all.
The report must **say so in the condition's own detail**, and name the evidence that lives outside
it: the freeze receipt, the as-of-close snapshot hash, and the append-only prepare-before-run
receipt. A condition that cannot fail in the artifact reporting it is not a check; the run log and
the retained chain are where its evidence actually is.

### 9a. Required content of the final report

Because v2's claim is about **process integrity** (§1), the provenance section *is* the
deliverable rather than a footnote. The report must carry, at minimum:

- the **freeze commit** and every pinned hash from §10, and the pins re-verified at the close;
- the **cutoff and close timestamps**, and the demonstration that the scored snapshot satisfies
  `cutoff < tx ≤ close`;
- the **prepared-artifact hash with its pre-run timestamp**, and the ordering evidence of item 4
  above;
- the **reset and deviation history** — every reset, its cause and its date, or an explicit
  statement that there were none;
- **evidence that the declared consequence was actually applied**: if the gate blocked, what was
  not released; if it passed, the release that followed and its record;
- the **D5 disclosures** of §7, in full, not by reference;
- the **§1 claim and coverage statement**, verbatim, alongside every reported number.

### 9b. Tooling delta this section requires

Recorded here because writing this section is what surfaced it, and because a requirement no
program satisfies is not "fixed in advance":

- **The runner must embed the prepare hash and the run id** (item 5). It currently writes
  `{ k, results }` and neither. Adding them naively would break the stability condition, because
  a run id differs on every run — so the runner must adopt the §4 **payload / receipts split**,
  and the scoring phase must compare **payload hashes** rather than whole-file hashes. The two
  changes are one change and must land together.
- **The freeze receipt, the ordering receipt and the release record** (items 1, 4, 8) have no
  producer yet.

Both must land **before** the freeze, since building them afterwards would resolve method choices
and reset the window (§8).

> **Delivered (2026-08-02).** Both obligations landed, through four adversarial-review rounds
> whose confirmed findings are themselves regression-locked in `test/pilot/`:
>
> - `run-pilot.ts` writes the §4 payload/receipts split (payload = deterministic, embedding the
>   prepare hash; receipts = run id + self-reported wall clocks with an attestation naming what
>   they do not prove), and `score-gate.ts` compares **payload** hashes for Stability.
> - Element 1 split into **two artifacts** because §9's own ordering demands it: `freeze-receipt.ts`
>   (the METHOD half, issued at T: candidate commit — verified to be a commit, and verified to
>   equal the working tree for every pinned path — runtime identity at both load paths,
>   configuration bytes, K, window, tool and method-doc hashes) and `input-pins.ts` (the INPUT
>   half, derived at the close, bound back by `freezeSha256`, and re-verifying the method pins at
>   the close per §9a — tools, method docs, config; the runtime identity is declared, not
>   re-derivable, and the pins' attestation says so).
> - `ordering-receipt.ts` (element 4): hash-chained append-only log with a verify mode whose
>   verdict records which optional anchors ran; `release-record.ts` (element 8): binds the score
>   hash, refuses a decision contradicting the gate in either direction, and anchors the ordering
>   log's final head.
> - The verification rounds forced one widening this section had not asked for: the pinned-input
>   surface grew from five names to **ten** (`ownership:registry`, `ownership:owner`,
>   `trust:master-key`, `trust:witness` by raw bytes with a literal `absent` sentinel, and
>   `expansion:semantic-neighbors` as a content hash of the RESOLVED table), because live probes
>   flipped the release verdict through each of those surfaces with all five original pins green.
>   The runner verifies and embeds every pin it consumes; the scorer cross-checks all three runs;
>   `prepare-gate` additionally enforces `tx ≤ close` over every snapshot row (§2's bound, §9
>   item 2's demonstration). What none of this proves is unchanged and stated in §9: no
>   self-attested artifact shows that no unrecorded earlier pass occurred.

---

## 10. Frozen identities and hashes

**FILLED 2026-08-02, from the freeze receipt** (`v2-freeze-receipt-2026-08.json`, payload
`55720757298abee064f5a319bd4e31ef723c2ed18d21f36fc0d7b8418d24a89c`) — the commit carrying this
filled table is the freeze. The runtime was redeployed at the candidate commit the same day per
`deploy-runbook.md` (three shas equal, both load paths byte-identical), so the candidate and
runtime pins coincide; they remain separate rows because they CAN drift, and both are verified
again at the close.

Identities are pinned **separately**, because they can drift independently:

| pin | value |
|---|---|
| candidate commit (protocol / classifier / tooling) | `27b4373d64d13c7b258aab011570be2d973c34da` |
| runtime bytes actually serving recall — installed plugin `gitCommitSha`, both load paths | `27b4373d64d13c7b258aab011570be2d973c34da` — both load paths verified byte-identical, 2026-08-02 redeploy per `deploy-runbook.md` |
| configuration actually serving recall (`~/.helix/config.json`, redacted) | `sha256 16f6d97fffb6b9934f82bcb03570af8657464d9899c22deb89c9cb61555ef9c3` |
| holdout cutoff (canonical UTC) | `2026-08-02T11:35:05.000Z` |
| close instant (cutoff + 28 days, canonical UTC) | `2026-08-30T11:35:05.000Z` |
| K | **20** |
| `git hash-object` — `scripts/pilot/derive.ts` | `68065a1b12d4b38655af432873d609a07c8d2070` |
| `git hash-object` — `scripts/pilot/generate-manifest.ts` | `45ffe35803ac8f9eae938c9a4deb42182a5d5d21` |
| `git hash-object` — `scripts/pilot/snapshot.ts` | `e4cf939d2ac42bbf13d9409eee4f6d0ffb92a26c` |
| `git hash-object` — `scripts/pilot/classify-o67.ts` | `2f0f2ccbd8753fdafddcebe06e64c63757678b7c` |
| `git hash-object` — `scripts/pilot/candidate-universe.ts` | `8d78e7a420798b5d836ed40f1505359475837af3` |
| `git hash-object` — `scripts/pilot/gate-set.ts` | `54c8b767fb6da35349062d1baedc1dcde8ede6f9` |
| `git hash-object` — `scripts/pilot/prepare-gate.ts` | `38a29589ecf705fcd2d0ba8efb013d9e76f37f5f` |
| `git hash-object` — `scripts/pilot/score-gate.ts` | `bc49663e43210d8f06ff77075b5b68a6d689750e` |
| `git hash-object` — `scripts/pilot/binomial.ts` | `5bdc0c6dc6879de2caa3872869636cbfe0ff6ef3` |
| `git hash-object` — `scripts/pilot/run-pilot.ts` | `4c5383d8786a508169d8251a938ef89c15edbf73` |
| `git hash-object` — `scripts/pilot/freeze-receipt.ts` *(added 2026-08-02)* | `72c89a51b57121cd512b9851044c7440120f9c13` |
| `git hash-object` — `scripts/pilot/input-pins.ts` *(added 2026-08-02)* | `abc4f4fb90a09033dee9f709fa45b57dd1b52dbe` |
| `git hash-object` — `scripts/pilot/ordering-receipt.ts` *(added 2026-08-02)* | `72a5bd1b8b0d11317632e4821ce04ecd43a41b45` |
| `git hash-object` — `scripts/pilot/release-record.ts` *(added 2026-08-02)* | `40fbe797ccca53e6dd0d4cff78c84e034f8c874f` |
| `git hash-object` — `scripts/pilot/pin-hashes.ts` *(added 2026-08-02)* | `bf9276386ff52ba4e83db675f991047b2facf37d` |
| `git hash-object` — `scripts/pilot/artifact-io.ts` *(added 2026-08-02)* | `9fe42a028e349fd6c02f2cfb40e480cdffe95eb5` |
| `git hash-object` — `src/memory/retrieval.ts` (primitive + tokenizer) | `52b15217ecbb5cd5a391d76a8b55619f67919515` |
| `git hash-object` — `src/memory/store.ts` *(added 2026-08-02)* | `80f0688d93a251150efc77334e306e3f213831a7` |
| `git hash-object` — `src/memory/expansion.ts` *(added 2026-08-02)* | `88d472e3bdb6494684fdd161bceaf7a0ae233dbf` |
| `git hash-object` — `src/memory/ownership.ts` *(added 2026-08-02)* | `bb9d3999b8b43be105957c39b2332bee29d72d6d` |
| `git hash-object` — `src/memory/verified-read.ts` *(added 2026-08-02)* | `027333ed8a4abf12b2295fcf837d686db7a9416f` |
| `git hash-object` — `src/memory/verified-projection.ts` *(added 2026-08-02)* | `80192ba43815b4a2b3a0134519c268431a7bd885` |
| `git hash-object` — `src/memory/witness-store.ts` *(added 2026-08-02)* | `8f381105a7dcdaf9a3ef850009ef7348af7ac28d` |
| `git hash-object` — `src/memory/witness-read.ts` *(added 2026-08-02)* | `c948a73cf740d1c2c580d1aaa916c70abca3af09` |
| `git hash-object` — `src/memory/witness-core.ts` *(added 2026-08-02)* | `bde7f616306dcf220bed67f62f2cafdf2d0cd575` |
| sha256 — `o67-class-rule-2026-07.md` | `c1fe768ca0ec2b117bc41a73e8c45546d83a2d3b7d8f344fe143114814b8a448` |
| sha256 — `gate-decision-2026-07-22.md` *(added 2026-08-02)* | `ebdbb307e13310a948f789f686aa4819a8f92f6e5dba037646d61d2d0b4424ae` |
| sha256 — this document's parent commit blob | *(n/a — see below)* |

*(Rows added 2026-08-02, in two groups mirroring `pin-hashes.ts`'s `PINNED_TOOL_PATHS` /
`PINNED_METHOD_DOCS` — the freeze receipt fills every row from those lists and a table missing
them could not be walked against the receipt row by row. The six pilot rows are the evidence
producers §9b required before the freeze plus the hashing and artifact IO they share; the eight
`src/memory` rows are the rank path the round-3 verification enumerated — the original table
pinned the ranking algorithm while leaving the modules the ranks flow through unpinned, which is
the structural reason the witness/registry/expansion substitutions existed. The tree-vs-commit
divergence refusal covers exactly the pinned paths, so membership in this table is what makes a
file's drift from the candidate commit visible at all. The second method-doc row exists because
the preregistration's own governing-texts line names `gate-decision-2026-07-22.md` BINDING, and
no other pin covered it.)*

The **runtime** pin and the **candidate commit** pin are separate on purpose: a repository commit
is not proof of what is installed, and this deployment has already produced a window where the
two disagreed. Both are verified again at the close.

This document cannot pin its own hash. What binds it is the freeze commit id, which the report
carries and which any reader can resolve to these bytes.

**Output schemas** are pinned by the tooling hashes above; each artifact additionally names its
own `rule` and `artifact` fields so a file identifies itself without reference to a filename.

---

## 11. Failure semantics and reuse

- A **failed run is preserved and reported**, not discarded. Its raw outputs are retained and the
  failure is described in the published evidence.
- A blocked release is a **result**, not an incident to be re-run until it passes. Re-running
  requires a new freeze and a new window (§8).
- Conversion of the v2 probes into a regression suite happens **after** a release, as in v1 §8.
  D4's non-gating early reuse of the v1 manifests during development is unaffected.

---

## 12. Why-log pointer

The decisions in §§1–9 came from an independent draft, four symmetric peer-review rounds, and
measurement-decided divergences, recorded in
the 2026-07-29 v2-gate-composition design spec §9 (a local operating doc — see
also `2026-07-26-o67-class-rule-design.md` §8 for the membership rule). *(Edited 2026-08-12:
the workspace-path citation was replaced by the spec's title — de-identification only, no
content change.)* The substantive reversals worth naming here, because no code or changelog
preserves them:

- the claim was **narrowed** to process integrity (§1) after "a rule not adjusted after seeing
  results" was found to contradict D5;
- the exclusion-plus-shadow gate composition was **replaced** by D-b, after measurement showed a
  ledger-only window structurally cannot produce an in-class case;
- the **stopping rule became a close rule**, and the 14-day floor was removed as unreachable
  under a fixed close;
- the contradiction condition was **split**, semantic negation from structural staleness, after
  the claim that an all-assert corpus disables the superseded-form half was refuted;
- the D2 mapping element was **filled positively** rather than waived as "not applicable";
- the stale exposure denominator was **corrected** from "superseded records in the top-K" to
  closer relationships in the as-of-close snapshot.
