# Helix v0.2.0 — preregistered recall pilot protocol

> **STATUS: HISTORICAL (marked 2026-07-29).** This protocol was executed on 2026-07-21/22: the
> registered 51-probe verdict is **NOT MET, permanently**, and the conditional frozen-method
> Hit@1 gate **FAILED at 27/28** (O_67 at rank 3 on both manifests, outside the pre-execution
> waiver). The v0.2.0 candidate was stood down on 2026-07-22 (`package.json` reverted to 0.1.0),
> and [`gate-decision-2026-07-22.md`](./gate-decision-2026-07-22.md) (**BINDING**) governs any
> release redo: a future release requires a prospectively preregistered **protocol v2**, so this
> document is no longer the acceptance test for any upcoming release. It remains the frozen v1
> method record referenced by `pilot-amendment-1.md`, the gate decision, and
> `o67-class-rule-2026-07.md`. Nothing below has been altered; post-execution notes are marked
> in place, matching the existing **[Amended pre-execution]** convention.

This document is the public, in-tag acceptance test for the v0.2.0 release of Helix's memory
recall. It is committed to the repository *before* the release candidate is frozen, so the tag
carries its own acceptance criteria. The commit that introduces this document is the **method
freeze**: from that commit onward the enumeration, the query derivation rule, the scored query
list, and the scoring gate are fixed and may not be changed for this release without labeling
the change a deviation (§8).

The pilot measures one thing: given a real project's decision history stored as Helix memory,
and an independent human-maintained record of the same decisions (the project's `STATE.md`),
does Helix recall surface the correct memory for a query derived from each decision? It is run
by the two committed scripts `scripts/pilot/generate-manifest.ts` (builds the frozen query
list) and `scripts/pilot/run-pilot.ts` (executes the queries against an isolated snapshot),
together with the frozen derivation and segmentation rules in `scripts/pilot/derive.ts` and
`scripts/pilot/segment-oracle.ts`.

The corpus itself is a private single-user project and is **not** published. Its exact bytes
are pinned by the hashes in §9, so any re-run can be checked against the frozen inputs, but the
raw memory and oracle text stay local. Everything needed to understand, audit, and reproduce
the *method* is in this document and the committed scripts.

---

## 1. Purpose and honest label

This exercise is a **frozen-corpus acceptance test plus a small temporal holdout**. It is
**development evidence, not independent efficacy evidence.** The corpus, the oracle, the
derivation rule, and the scoring were all produced by the same author and development process
that produced Helix; the test demonstrates that the system meets a preregistered bar on this
one real corpus, and it guards against regressions. It does **not** establish general
effectiveness across users, domains, or corpora.

The pilot was preceded by six earlier clean recall checks against this same oracle during
routine development. Those six are **correlated development evidence** — same author, same
machine, same iterative loop — and are explicitly **not** counted as six independent samples.
The only forward-looking, not-yet-seen evidence this protocol can produce is the temporal
holdout (§7): decisions the autonomous loop mints *after* the method freeze, scored under the
identical rules.

Any claim published from this pilot states the measured counts and this label together. No
general efficacy claim is made from these results.

---

## 2. Enumeration — what is probed

Probes are enumerated in two directions. The enumeration is emitted and frozen (as the query
manifest, §9) before any scoring.

### 2a. Ledger side (mechanical)

Every **live** record of the pinned memory ledger becomes one probe. A record is live if it is
an `assert` or `supersede` record that has not itself been superseded or erased by a later
record. The pinned corpus has **25 live records**, so there are **25 ledger-side probes**. Each
ledger-side probe's target (its "relevant" set) is exactly the one record it was derived from.

### 2b. Oracle side (fixed segmentation)

The oracle (`STATE.md`) is segmented by a frozen rule, **segmentation rule v1**, implemented in
`scripts/pilot/segment-oracle.ts`. An entry is a single top-level `- ` bullet. Two **frozen
exclusion classes** remove entries that are not settled, testable decisions:

- **(a) roadmap / open-question entries** — any entry whose own text matches `roadmap` or
  `open question` (case-insensitive). These are candidate future work or explicitly unresolved
  questions, not decisions to recall.
- **(b) roadmap-section entries** — every entry under a heading whose text matches `roadmap`
  (case-insensitive).

No entry is excluded for any other reason. Applied to the frozen oracle, segmentation yields:

| segmentation result                         | count |
|---------------------------------------------|-------|
| total top-level entries                     | 78    |
| excluded — under a roadmap heading (b)      | 34    |
| excluded — roadmap/open-question text (a)   | 18    |
| **eligible**                                | **26**|

Each eligible entry becomes one oracle-side probe (**26 oracle-side probes**). The **current
form of a decision is the probe target**: the derivation rule (§3) strips any `Formerly:` tail
before deriving the query, so a corrected decision is probed by its corrected wording, never by
a superseded fragment.

An eligible entry is mapped by meaning to the ledger record(s) it corresponds to. That mapping
was adjudicated once, by reading every live record, and is frozen alongside the manifest as
`docs/release/pilot-oracle-mapping.json`, with a one-line rationale per entry. An eligible
entry whose decision has **no corresponding ledger record** maps to the **empty set** and is a
**MISS** by construction — an honest *coverage gap*: the human recorded a decision the memory
never captured. Coverage gaps are preregistered, not hidden. This corpus has **4** of them
(§4): one changelog line recording the project's initial seed (the two seed commands predate
the project's decision-logging and have no dedicated record), and three notes describing the
review cadence of the harness that exercises the tool rather than a decision about the tool
itself. Mappings are never stretched to avoid an empty set, and no eligible entry is dropped to
avoid one.

### 2c. Totals

**51 probes** total: 25 ledger-side + 26 oracle-side. Of the 26 oracle-side probes, **22 have a
target** and **4 are coverage gaps**. Combined with the 25 ledger-side probes, **47 probes have
a retrievable target** and **4 do not**.

---

## 3. Query derivation and leakage rubric

### 3a. Derivation rule v1

The query for a probe is derived from its source text (a ledger record's content, or an oracle
entry's text) by the frozen, deterministic function `topicTerms` in `scripts/pilot/derive.ts`
as it exists at the method-freeze commit (identity pinned in §9). The rule, in order:

1. drop any `Formerly:` tail — the current form is the target;
2. strip code spans (text in backticks) — these often contain the answer verbatim;
3. strip all digit sequences — record ids, exit codes, dates, magnitudes;
4. lowercase, take word tokens matching `[a-z][a-z-]+`;
5. drop a fixed stopword list and duplicates;
6. keep the first **8** surviving terms, space-joined.

The rule has no I/O and no randomness: the same text always yields the same query. Changing any
behavior of this function after the method freeze is a deviation (§8).

### 3b. Leakage rubric

The derivation exists to prevent trivial retrieval. Every query in the frozen manifest is
checked against this rubric; the manifest is not frozen until it passes:

- **no record ids** — no query may contain a memory record identifier;
- **no verbatim outcome phrases** — no query may quote a decision's verdict verbatim;
- **no numerals** — every digit sequence is stripped;
- **no code spans / numerals** — text in backticks and every digit sequence are stripped
  (record ids, exit codes, dates, magnitudes). **[Amended pre-execution — see
  pilot-amendment-1.md]** This is the rubric's *goal*; the frozen rule (§3a) enforces the
  "unique literals" part **only for backticked spans and digits**. An identifier written
  *without* backticks — a store-function name in unbackticked parentheses in a changelog line —
  **survives** into the query. The earlier wording ("one-of-a-kind tokens ... are stripped")
  overstated the rule and is corrected here.

The manifest at this freeze was checked two ways. A mechanical sweep of all 51 queries
confirmed that none contains a digit, a backtick, a record identifier, or an underscore, and
that no query contains its own target's identifier. Three probes were additionally hand-checked
against the full rubric — one information-rich ledger probe, one oracle probe whose source is
dense with dates, magnitudes, and code spans, and one coverage-gap probe — and all three
carried only generic topic terms with no leaked id, outcome phrase, numeral, or literal.

**[Amended pre-execution — see pilot-amendment-1.md]** Five oracle-side probes carry a surviving
unbackticked store-function identifier — the changelog entries that name the function in
parentheses: `O_63` (sorttasks), `O_64` (computestats), `O_67` (completetask), `O_68`
(removetask), `O_69` (searchtasks). **Direction:** a surviving identifier makes recall *easier*
for those probes (a leniency toward hits), never harder. This is a documentation correction
only: the frozen manifest and every probe's mechanical flag were generated under the true rule
(§3a) and are unchanged, so correcting the prose **cannot silently flip any recorded hit or
miss**. The two integrity-critical legs are unaffected. An unambiguous (Hit@1) probe is, by
definition, one where no other live record shares three or more of its query terms, so a
surviving identifier **reinforces an already-unique match rather than manufacturing one** (four
of the five affected probes are unambiguous). And **ledger-side probes are outside this concern
entirely**: a ledger probe's query is derived from its own target record, so shared
implementation tokens are inherent to the probe by construction, not leakage from an independent
paraphrase.

`deriveQuery` is exported from the same module for callers that want the query as a string; the
generator uses `topicTerms` directly. Both share the single derivation above.

---

## 4. Combined acceptance gate

The candidate **passes** the pilot only if **all** of the following hold. Either this pilot or
the separate clean-room validation can reject a candidate.

- **Recall@20 = n / n** over every eligible probe that has a retrievable target (**n = 47**).
  K = 20 is the production recall bound (§9). Every targeted probe must return its target
  within the top 20 results.
- **Hit@1 = m / m** over the **unambiguous** probe subset. A probe is unambiguous, by mechanical
  definition frozen in the generator, when it has **exactly one** target **and no other live
  record shares three or more of the probe's query terms**. The subset size is reported. For
  this manifest the subset has **28** probes (non-empty), so Hit@1 is **exercised**; if a future
  manifest yields an empty subset, Hit@1 is labeled **unexercised**, never silently passed.
  Every unambiguous probe must return its target at **rank 1**.
- **Contradictions = 0** (§5).
- **Stale-served-as-live = 0** (§5).
- **Errors / unscorable = 0** — no probe may fail to run or produce an unscorable result.
- **Stability:** three repeated runs of `run-pilot` on the same snapshot and manifest produce
  **byte-identical** output. The runner writes deterministic JSON (a fixed injected clock, ids
  only — no wall-clock content), so any byte difference is a defect.

### Coverage gaps and honest reporting

The 4 coverage-gap probes (empty target set) are **guaranteed misses**: there is nothing to
retrieve. They are **not** folded into the Recall@20 ratio above — doing so would misreport a
gap in what the corpus *recorded* as a failure of *retrieval*. Instead the pilot reports the
full result as **X of Y at K = 20**, where **Y = 51** (all eligible probes) and the
**(Y − X)** shortfall is itemized into (i) preregistered coverage gaps — a property of the
corpus — and (ii) genuine retrieval misses — a property of the system. The pass/fail Recall@20
gate above is evaluated over the 47 targeted probes; the 4 coverage gaps are disclosed in the
published result, never counted as retrieval successes and never quietly excluded from the
denominator without note. A candidate is rejected on any genuine retrieval miss (ii > 0), and
on any coverage gap not already preregistered in this document.

**[Amended pre-execution — see pilot-amendment-1.md]** A pre-execution amendment (committed
before any retrieval ran) additionally defines a labeled *conditional* gate over **48** targeted
probes — the seed probe `O_66` remapped to its five underlying convention records — and locks the
release waiver to exactly the three remaining coverage gaps (`O_75`/`O_76`/`O_77`); this
registered 51-probe verdict is preserved and reported NOT MET regardless. See
`pilot-amendment-1.md`.

The full rank distribution is reported for **all** probes (§6). Ambiguous probes contribute to
Recall@20 and to the rank distribution but are never aggregated into a rank-1 threshold.

---

## 5. Adjudication rubrics

Two failure conditions are judged per probe by reading the returned records, and every
adjudication is recorded with the quoted text that supports it. The raw runner outputs are
retained.

- **Contradiction** — a returned record **asserts the negation of, or a superseded form of,**
  the oracle entry's *current* statement. That is: the top-K results include a record that says
  the opposite of, or an outdated version of, what the decision currently is. Any contradiction
  is a gate failure.
- **Stale-served-as-live** — a corrected or superseded record appears in the top-K **without
  its current form present at an equal-or-better rank**. That is: an outdated version is served
  as if live, and the record that corrects it is either absent from the top-K or ranked below
  it. Any such case is a gate failure.

Both conditions are recorded per probe with the quoted returned text; the retained raw outputs
let any reviewer re-check the judgment.

---

## 6. Rank-distribution reporting

For every probe the runner records **bestRank** — the position of the best-ranked target in the
returned list — and whether the probe hit at K and at rank 1. The following five definitions
make rank aggregation unambiguous and are fixed for this release:

1. **Relevant-item set** — a probe's targets are exactly the frozen `relevant` array in the
   manifest; nothing is added or removed at scoring time.
2. **Multiple valid results** — when a probe has more than one target, **bestRank is the
   minimum rank** achieved across the target set (the best single hit counts).
3. **Missing result** — if no target appears in the returned list, **bestRank is null and the
   probe counts as a miss at every K**. A coverage-gap probe (empty target set) is a missing
   result by construction.
4. **Ties** — impossible by construction: recall returns an **ordered** list and a probe's rank
   is its position in that list, so two results never share a rank.
5. **Superseded fragments** — only a record's **current** form counts as a target (the
   derivation strips `Formerly:` tails). A superseded form appearing in the results is scored
   under the stale-served-as-live rubric (§5), **never as a hit**.

A **bestRank histogram over all 51 probes** is reported. Ambiguous probes appear in the
histogram but are never aggregated into the rank-1 (Hit@1) threshold.

**Unambiguity-denominator note (2026-07-29; D5 disclosure).** The Hit@1 bullet says "no other
live record". At the v1 freeze the generator implemented that over the PROJECT ledger alone,
while `run-pilot` ranked against the merged global + project universe production recall actually
serves — so a global-scope near-duplicate was a real competitor the unambiguity test could not
see. C5.1 closure item 4 widened the generator's competitor set to every scope, which makes the
sentence above literally true rather than approximately so. **The v1 results are unaffected**,
and that is verified rather than asserted: the frozen snapshot holds 25 project rows against 1
global row, no probe flips either way, and both frozen manifests still regenerate
BYTE-IDENTICALLY (sha256 `452e3cee…` and `d5a2178f…`, reproduced 2026-07-29). Direction of the
correction, for the record: enlarging the competitor set can only move probes OUT of the
unambiguous subset, so it RELAXES the Hit@1 gate — fewer probes must rank 1 — and TIGHTENS O_67
qualifying-exposure accrual, which is scored over probes that are in-class AND base-Hit@1
eligible. Per `gate-decision-2026-07-22.md` D5 the revised rule validates on **new temporal cases
only**: the frozen corpus cannot demonstrate it, by construction.

---

## 7. Temporal holdout

The method freezes when this protocol commits. The pinned corpus grows: the project's
autonomous loop mints new decisions daily. Decisions committed to the corpus **after** the
method-freeze commit — identified by a ledger record whose transaction time (`tx`) is later than
the freeze commit's authored time — form the **temporal holdout**.

The holdout is enumerated, derived, and scored by the **identical** rules in §2–§6, and reported
**separately** from the frozen-corpus result. Because the holdout is small (a handful of
decisions across the release-preparation window), its unambiguous subset may be empty; if so,
**Hit@1 is labeled unexercised** on the holdout rather than reported as a trivial pass. The
holdout is the only part of this exercise that is forward-looking rather than correlated with
development.

**Holdout tooling (2026-07-29; C5.1 closure item 3).** The population above is ledger-only by
definition — oracle entries are not ledger records and carry no `tx`, so no cutoff can date them
— and the generator now enforces that structurally: the holdout invocation takes no oracle
arguments, and a cutoff supplied together with an oracle side is refused.

```
npx tsx scripts/pilot/generate-manifest.ts --after <tx> <snapshotDir> <out>
```

`<tx>` must be canonical UTC (`YYYY-MM-DDTHH:MM:SS.sssZ`) and the comparison is a strict string
`>`, so the cutoff instant itself is **not** in the holdout. Any other form — a shorter stamp, an
offset-bearing one, or a well-formed impossible date like `2026-02-30T…` — is refused rather than
coerced, because only the canonical form orders correctly under string comparison. A cutoff
narrows the probe SOURCE and never the competitor set: a record minted before the cutoff still
competes for rank at scoring time, so dropping it would flatter the holdout exactly where the
holdout is meant to be hardest.

A holdout manifest self-identifies by carrying `txAfter`. Probe ids and `side` keep their
ordinary ledger form (`L_<id>`, `side: "ledger"`) because holdout-ness is a property of the
manifest, not of a probe; the v1 holdout manifest was hand-made and used `H_<id>` / `side:
"holdout"`. The current tooling reproduces that manifest's SELECTION and its derived query
exactly — verified 2026-07-29 against the holdout-1 snapshot at cutoff
`2026-07-20T12:31:43.000Z`, yielding the same single record and the same eight query terms — but
not those two labels.

Deriving the cutoff has one trap worth recording, since the v2 preregistration must pin an exact
value: `git log --format=%ad --date=format:'…Z'` renders in the **commit's own** timezone, so
stamping a literal `Z` on it yields a time wrong by the author's UTC offset — here `+09:00`, a
nine-hour error that silently moves the holdout boundary. Use
`TZ=UTC git log -1 --format=%ad --date=format-local:'%Y-%m-%dT%H:%M:%S.000Z' <commit>`, or convert
`%aI` explicitly. The v1 method-freeze commit `0eae7dc` authored `2026-07-20T21:31:43+09:00` is
therefore `2026-07-20T12:31:43.000Z`.

---

## 8. Failure semantics and reuse

- A **failed run is preserved and reported**, not discarded. Its raw outputs are retained and
  the failure is described in the published evidence.
- A failure is fixed by changing the **system**, producing a **new candidate** commit, and
  **re-running the full pilot** against it — not by adjusting the frozen method to make a red
  result pass.
- Any change to the enumeration, derivation, manifest, mapping, or gate made **after** results
  are visible is labeled a **deviation** and described as such; it cannot be presented as part
  of the original preregistered method.
- Stronger, confirmatory claims require **new temporal cases** (§7), not re-scoring of the
  frozen corpus.
- After the release, the frozen probes become a **regression suite**: the same manifest is
  re-run against later candidates to detect recall regressions.
  **[Updated 2026-07-29 — see `gate-decision-2026-07-22.md` §D4.]** Non-gating **early reuse
  during development** has since been authorized: BOTH `pilot-manifest.json` AND
  `pilot-manifest-amended-1.json` are re-run against later candidates, and neither may be
  dropped (the amended overlay carries O_66's bound targets). Formal §8 conversion still
  occurs at release.

---

## 9. Frozen hashes and integrity mechanics

### 9a. Frozen hashes

All values are of the artifacts exactly as committed / pinned at the method freeze.

| artifact | hash / value |
|---|---|
| corpus memory ledger — sha256 | `7b43a82e517a765d7632cba6e76bd5a6a659152d696ce4f99c9d116bf90c1c5d` |
| oracle `STATE.md` — sha256 | `7d2455abb723c3ae539a09220beec2d7a71b7e02811c5ac4a85286dc6a3f8261` |
| query manifest `docs/release/pilot-manifest.json` — sha256 | `452e3cee02c7b70753d66cc165b1e518869ae4436cb99c28181b50281274525e` |
| oracle mapping `docs/release/pilot-oracle-mapping.json` — sha256 | `3311103b2905056855188df84c425c8cd620623635056852f6257f77cb2f8d58` |
| generator identity — `git hash-object scripts/pilot/derive.ts` | `68065a1b12d4b38655af432873d609a07c8d2070` |
| generator identity — `git hash-object scripts/pilot/segment-oracle.ts` | `76ce292307d781169b04012837d8ea6dfb32c95a` |
| generator identity — `git hash-object scripts/pilot/run-pilot.ts` | `f51b0bbc9167b350a447fe6b6495dd198f44cafc` |
| generator identity — `git hash-object scripts/pilot/generate-manifest.ts` | `400e9d97d99dffc068d34162daa6ea72c669da52` |
| corpus project repository commit | `3a4b86d5cd4476e4ab83fe36dcd08c3be2420ef6` (`3a4b86d`) |
| production recall bound K | **20** — `src/memory/retrieval.ts:267`, `opts.maxItems ?? 20`, the default the production recall path uses when no override is given |

sha256 values are produced by `sha256sum`; generator-identity values are Git blob object ids
(`git hash-object`), which equal the committed blob ids for those four files at this commit.

**Pin drift note (2026-07-28).** `scripts/pilot/generate-manifest.ts` no longer matches
`400e9d97…` at HEAD: C5.1 block 1–4 lifted its enumeration out of module top level into an
exported `buildProbes` behind a `main()` guard, so it could be imported by a test at all (it ran
its argv parsing on import) and so it would enter the typecheck program. The pin above stays a
true statement about the v1 freeze commit and reproduces there; it is not a claim about HEAD. The
v1 RESULTS are unaffected — the refactor is behaviour-invariant, verified by regenerating both
frozen manifests byte-for-byte. The v2 freeze pins its own identities (C5.1 item 9), which is
where the current blob id belongs.

**Extended 2026-07-29.** The same file has since taken C5.1 closure items 3 and 4 — the
transaction-time cutoff (§7) and the merged unambiguity denominator (§4) — so its blob has moved
again. Two behaviour changes ride along and are recorded here rather than left to a diff: `live`
now also treats an `invalidate` row as a closer, matching `src/memory/projection.ts:26` (the
frozen corpus contains no such row, so no v1 probe is affected), and a snapshot missing a scope's
ledger is now refused instead of read as empty, since a partially copied snapshot would otherwise
produce a well-formed manifest whose probes look unambiguous only because their competitors were
never read. Both frozen manifests were regenerated after these changes and remain byte-identical
to the pinned sha256 values above, which is the acceptance condition these items were held to.

**[Amended pre-execution — see pilot-amendment-1.md]** LOCAL, PATH-DEPENDENT audit value (not a
reproducible artifact hash): the rewritten snapshot `projects.json` (§9b) has sha256
`f74ba0bd97b354799cddecbe5dacaf90cfce405b04a2e11fe29a9204587fe582`. This value is specific to
this machine's snapshot path and the single-key rewrite, so it is not reproducible across
environments and is recorded for audit only. What a re-run must reproduce is the **procedure** in
§9b (rewrite the registry key to the snapshot's project directory, stamp/nonce preserved), not
this exact byte value.

### 9b. Snapshot layout and isolation

The pilot runs against a **read-only, isolated snapshot** of the corpus — its own copy of the
Helix home and the project ledger — never the live memory. The snapshot has two parts:

- `home/` — the global memory ledger (`memory.jsonl`), the ledger signing key, and the
  ownership registry (`projects.json`);
- `proj/.helix/` — the project memory ledger (`memory.jsonl`), its ownership stamp (`.owner`),
  and the project config.

The oracle `STATE.md` is the **scoring oracle only**. It is never placed inside the
system-under-test's context; recall never sees it. The runner constructs the memory store with
the same global-plus-owned-project wiring the production server uses, so ranks are measured
against the same merged candidate set production would serve.

**Registry-key requirement (verified at this freeze).** Ownership is keyed by the project
root's **absolute path**: the store treats the project ledger as live only when the ownership
registry has an entry for the snapshot's project directory whose stamp matches the project's
`.owner` file. A snapshot copied to a new absolute path therefore needs its `projects.json` key
to equal the snapshot's project directory path, or every project-scope query silently degrades
to a global-only recall. At this freeze that mismatch was confirmed and corrected: a one-probe
smoke against the snapshot as first copied returned **no** project records (degraded); after
the registry key was rewritten to the snapshot's project directory absolute path — stamp,
adoption time, and per-project signing nonce preserved byte-for-byte, only the key changed —
the same smoke
returned the target project record at **rank 1** among 20 project records. Any re-run of the
pilot must satisfy this registry-key match before generating or scoring the manifest.

**[Updated 2026-07-29.]** Post-freeze commit `e576ee4` (2026-07-23) changed ownership keying
from the absolute path to the **canonical realpath** of the project root
(`ownership.canonicalRoot`, `src/memory/ownership.ts`). The procedure above is unchanged, but a
re-run against current bytes must key `projects.json` by the snapshot directory's *realpath*; a
snapshot reached via a symlinked path degrades exactly as described here until the key matches
the realpath.

### 9c. Reproduction

Given the pinned snapshot (its bytes verified against §9a) and this repository at the
method-freeze commit:

1. Regenerate and verify the manifest is unchanged:
   `npx tsx scripts/pilot/generate-manifest.ts <snapshotDir> <oracleMd> docs/release/pilot-oracle-mapping.json <out>`
   then compare `<out>` to the frozen `docs/release/pilot-manifest.json` (sha256 in §9a). The
   generator prints the probe counts (`51 (ledger 25, oracle 26); unambiguous: 28`).
2. Execute the probes three times:
   `npx tsx scripts/pilot/run-pilot.ts docs/release/pilot-manifest.json <snapshotDir> <out>`
   and confirm the three outputs are byte-identical (stability, §4).
3. Score the outputs against §4–§6: Recall@20 over the 47 targeted probes, Hit@1 over the 28
   unambiguous probes, contradictions and stale-served-as-live by §5, and the bestRank
   histogram over all 51 probes; itemize any shortfall into coverage gaps versus retrieval
   misses per §4.

`<snapshotDir>` is the snapshot root containing `home/` and `proj/`; `<oracleMd>` is the frozen
oracle file.
