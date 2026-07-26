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

## 5. Retrodiction evidence (frozen corpus)

Label: RETROSPECTIVE, OUTCOME-INFORMED METHOD DEVELOPMENT — not prospective validation;
contributes zero Q3 exposure (authorized by gate-decision D4, non-gating reuse). Anchor
REQUIRED and MET: the general rule, with no O_67 special-case, classifies O_67 in-class.

Classifier runs, 2026-07-26, snapshot-frozen, both manifests (identical results):

| probe | status | target matched (direct + rescued) | witnesses (extra terms) |
|---|---|---|---|
| O_67 (unambiguous) | IN-CLASS | cli, id, store, throw, unknown + completetask, mutators | m_02fd751a… (+add), m_e7787d10… (+add) |
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
