# O_67-class (superset competition) — frozen offline classification rule

Date: 2026-07-26 · Status: BINDING for the v2 evidence window (readiness C1.3) · Frozen
prospectively: this rule and its classifier are fixed BEFORE the v2 method freeze; the v2
freeze (C5.1) pins their identities (file hashes + commit) together with the system identity.
Governing texts: gate-decision D5 (`gate-decision-2026-07-22.md`), readiness C1.3/C5.1/C5.2/Q3
(`readiness-criteria-2026-07.md`), holdout independence spec (`pilot-amendment-1.md` §f).

## 1. Purpose

D5 documents the O_67 class — superset competition: the target is the short record defining a
contract that longer referencing records restate inline, so competitors cover a strict superset
of the matched query terms, and a monotone surface scorer structurally cannot rank the superset
match below. This rule makes the class MECHANICALLY decidable so the v2 window's
exercised/unexercised report is produced by a frozen procedure, not post-hoc judgment. The v1
manifest generator's unambiguity test could not see this class (it inspects only each
competitor's first-eight derived topic terms, project ledger only); this rule inspects what the
scorer inspects.

## 2. Membership (normative)

For probe p with query q, scored against snapshot S:

- Q = unique(meaningfulTokens(tokenize(q))) — the scorer's own query tokenization.
- For a candidate record r: M(r) = lexicalEvidence(Q, tokenize(r.content)).matched — direct
  exact/forward-prefix evidence plus the support-gated concat/inflection rescues, the exact
  per-term composition the deployed scorer counts as lexical coverage. Synonym-neighbor
  expansion, phrase, BM25/IDF, trust, and recency are EXCLUDED: they move scores, not
  structural membership. Sets contain query terms, never the evidencing document tokens.
- p is IN-CLASS iff p maps to exactly one target T, M(T) is non-empty, and some servable
  non-target candidate C has M(T) ⊊ M(C) (strict).
- Equal sets are NOT in-class (`equal-coverage-competition`, informational). M(T) = ∅ is NOT
  in-class (`target-zero-evidence`) — the empty set is a subset of everything and would inflate
  exposure. Multi-target and empty-relevance probes are out of domain. A missing/duplicate
  target identity or an empty Q is `unscorable` — a hard error, never a clean non-member.

## 3. Candidate universe and outcome-blindness

Candidates are the records the production MemoryStore would serve from S (global + owned
project scope, ownership/integrity/witness enforcement included), enumerated per probe as the
identity SET of a full-size recall; order is discarded and never recorded. Competitors are
never restricted to the holdout, one ledger, a top-K, or positive-report subsets. The
classifier is outcome-blind: inputs are manifest + mapping + snapshot only — never bestRank,
returned, hitAt1, scores, or any runner output. At window close its output is generated and
hashed BEFORE the pilot runner executes.

Servability interaction (explicit): recall's relevance filter drops zero-scoring records, so a
target with zero lexical signal is typically not servable at all and surfaces from the CLI as
`unscorable — target-not-servable`; `target-zero-evidence` is the pure-classification label
for candidate pools that do include such a target. Both statuses are non-member, non-exposure,
and fail-closed — the distinction is diagnostic labeling only.

## 4. Exposure and reporting (v2 window)

- CENSUS: every single-target probe is classified, including ambiguous/recall-only ones. The
  legacy `unambiguous` flag never gates whether classification runs.
- QUALIFYING EXPOSURE (Q3): in-class cases whose probe is base-Hit@1-eligible (eligible for the
  rank-1 gate BEFORE any O_67-class exclusion, under the v2 freeze's base eligibility
  definition). Exposure unit: distinct post-cutoff target identity (scope, record-id) —
  paraphrase probes of one target count once.
- With E = the Q3 minimum (fixed verbatim at the freeze) and n = qualifying exposures:
  `UNEXERCISED — 0/E` · `PARTIALLY EXERCISED — n/E (minimum not met)` · `EXERCISED — n/E`.
  Under Q3 as ratified, UNEXERCISED and PARTIALLY EXERCISED block release. The frozen stopping
  rule is never stretched after seeing n. Any classifier/mapping/snapshot error is
  `UNSCORABLE — GATE FAILURE`.
- Gate interaction — RECOMMENDED DEFAULT (owner, 2026-07-26; confirmed or replaced at the C5.1
  freeze): binding Hit@1 denominator excludes prospectively classified in-class members; a
  shadow Hit@1 over the pre-exclusion denominator is MANDATORY so the exclusion cannot hide
  observed ranks; the in-class subgroup reports each member's best rank, Hit@1, Recall@K and
  witness evidence descriptively; Recall@K remains binding for in-class probes. Rationale:
  under full-credit membership an in-class case is a structurally predicted rank-1 miss, so
  keeping members in the binding denominator makes exposure and gate-passing mutually
  exclusive — reproducing the v1 O_67 deadlock that the path-(b) policy exists to escape.

> **Amendment 2026-07-30 (owner decisions D-a and D-b; §4's text above is unchanged and remains
> the record of what this rule said from 2026-07-26).** Two of the four bullets above are
> superseded. §1–§3 — purpose, normative membership, candidate universe and outcome-blindness —
> are untouched, as are the CENSUS bullet and the `UNSCORABLE — GATE FAILURE` rule.
>
> **D-a. The O_67 component no longer blocks release.** The third bullet's `E` denominator, its
> `PARTIALLY EXERCISED` state and its blocking consequence all fall with it: they are defined only
> relative to a blocking minimum, and there is none. The component reports, threshold-free:
> the single-target census, the number of distinct in-class target identities, how many of those
> are Hit@1 eligible, and per case the witnesses, best rank, Hit@1 and Recall@K — labelled
> `UNEXERCISED — 0 distinct cases observed (reporting only, non-blocking)` or
> `EXERCISED — n distinct cases observed (reporting only, non-blocking)`. It also does not
> participate in the window-close rule; if it did, a window with zero in-class cases could never
> close. D5's duty is unaffected: an absent class is still reported unexercised, never silently
> validated.
>
> **D-b. The gate-interaction default is REPLACED, not confirmed** — which the fourth bullet
> anticipated in its own parenthetical. In-class members REMAIN in the binding Hit@1 denominator;
> there is no exclusion and therefore no shadow Hit@1. The in-class subgroup is still reported
> descriptively, which under D-a is now the sole mechanism by which the class stays visible.
> In-class membership grants no exemption from any other gate condition. The bullet's deadlock
> rationale lapsed rather than being refuted: it held only while exposure was mandatory, and D-a
> removed that half.
>
> **Consequences for the second bullet.** "base-Hit@1-eligible … BEFORE any O_67-class exclusion"
> loses its subject: with no exclusion there is one eligibility tier, not two. Read it as plain
> Hit@1 eligibility. The exposure UNIT is unchanged — distinct post-cutoff target identity
> `(scope, record-id)`, paraphrase probes of one target counting once.
>
> Why this is recorded here rather than only in the v2 preregistration: this document is BINDING
> for the v2 evidence window and is cited as the normative source by
> `readiness-criteria-2026-07.md` and `gate-decision-2026-07-22.md`, so a reader arriving at §4
> must not leave with the repealed rule. The full reasoning, the three-round peer reconciliation
> behind it and the measurements that forced it are in the working design record
> `docs/superpowers/specs/2026-07-29-v2-gate-composition-design.md` (a local operating doc);
> C5.1 closure item 9 carries the decisions into the tracked v2 preregistration.

## 5. Retrodiction evidence (frozen corpus)

Label: RETROSPECTIVE, OUTCOME-INFORMED METHOD DEVELOPMENT — not prospective validation;
contributes zero Q3 exposure (authorized by gate-decision D4, non-gating reuse). Anchor
REQUIRED and MET: the general rule, with no O_67 special-case, classifies O_67 in-class.

Classifier runs, 2026-07-26, snapshot-frozen, both manifests (identical results); re-baselined
2026-07-28 when C5.1 closure item 1 made every emitted identity scope-qualified. The membership
OUTCOME is unchanged — the anchor below is what C1.3 asserts, and it is invariant across that
change; only the serialization moved, so the run's byte hashes were re-recorded.

Re-verified 2026-07-30 after the eligibility-field change enacting owner decision D-b (§4
amendment): the anchor below reproduces **verbatim** on both manifests, needing no re-baseline
at all. That is the point of anchoring on the summary rather than on a file hash — the change
rewrote per-probe verdict fields, which a hash pin would have flagged as a broken anchor while
the membership rule it is supposed to guard never moved.

| probe | status | target matched (direct + rescued) | witnesses (extra terms) |
|---|---|---|---|
| O_67 (unambiguous, target scope `project`) | IN-CLASS | cli, id, store, throw, unknown + completetask, mutators | project:m_02fd751a… (+add), project:m_e7787d10… (+add) |
| all other single-target probes (46) | not-in-class / labeled statuses | — | — |

```
/tmp/o67-v1.json {"census":47,"inClass":["O_67"],"targetZeroEvidence":[],"unscorable":[],"outOfDomain":["O_66","O_75","O_76","O_77"]}
/tmp/o67-amended.json {"census":47,"inClass":["O_67"],"targetZeroEvidence":[],"unscorable":[],"outOfDomain":["O_66","O_75","O_76","O_77"]}
```

Diagnostic note: under a direct-evidence-only variant (no rescues) O_10 would also classify
in-class; its rescue-repaired target (rank 8→1 at d912414) drops out under full credit —
evidence that full-credit membership isolates the OPEN limitation class rather than cases the
shipped scorer already handles.

## 6. Freeze and window-close procedure

At the v2 freeze (C5.1): pin the candidate commit + configuration identity, plus sha256 of this
document, `scripts/pilot/classify-o67.ts`, `src/memory/retrieval.ts` (primitive + tokenizer),
the enumeration/derivation/mapping scripts, the runner, and the output schema. At window close,
BEFORE scoring: snapshot the cutoff corpus; generate and hash the candidate-universe artifact,
the holdout manifest, and this classifier's output; only then run and hash the pilot outputs.
Any intervening code/rule/metric/config change resets the window (§f).

## 7. Why-log pointer

Design provenance (independent draft → symmetric Codex compare → measurement-decided
divergences → owner approval) is recorded in the working spec
`docs/superpowers/specs/2026-07-26-o67-class-rule-design.md` §8 (local operating doc). The
substantive decisions: full-credit membership decided by dual-variant retrodiction (the anchor
survives full credit; a direct-only variant misclassifies the repaired O_10); candidate
universe = MemoryStore's servable view; census vs qualifying exposure split; fail-closed
unscorable statuses; exclusion-plus-shadow gate recommendation with the deadlock rationale.

The last of those — the exclusion-plus-shadow recommendation — was REPLACED on 2026-07-30, and the
blocking consequence of qualifying exposure was withdrawn the same day; see the §4 amendment above.
Its own provenance (three symmetric peer rounds, then a fourth on the gate composition, plus the
measurements that showed a ledger-only window cannot produce the class) is in
`docs/superpowers/specs/2026-07-29-v2-gate-composition-design.md` §9.
