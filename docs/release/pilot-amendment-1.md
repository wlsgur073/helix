# Pilot amendment 1 (pre-execution)

This document amends the recall pilot defined in `pilot-protocol.md`. It is committed **after the
relevance mapping was adjudicated but before any retrieval has run**. It informed an independent
design cross-check and was ratified by the release maintainer. The frozen originals
(`pilot-manifest.json`, `pilot-oracle-mapping.json`) are **unchanged and remain the registered
method**; this amendment adds overlay artifacts (`pilot-manifest-amended-1.json`,
`pilot-oracle-mapping-amended-1.json`) and clearly-labeled protocol notes.

---

## (a) What is amended, and why — with an honest timeline

**Timeline.** The method-freeze commit registered the enumeration, derivation, manifest, mapping,
and gate. During that adjudication the mapping of oracle entries to memory records was completed,
so this amendment is **outcome-informed with respect to the coverage mapping** — it was written
knowing which eligible entries had no corresponding record. It is **prospective with respect to
retrieval outputs**: no recall query has been executed, and no probe's hit/miss/rank is known.

Because it is outcome-informed about the mapping, this amendment **does not retroactively join the
original preregistration** and **does not revise the registered v1 verdict** (§b). It changes what
an *additional, clearly-labeled conditional* gate measures, and it locks the reporting and waiver
rules before any result can bias them.

**Why.** Two points were raised in the cross-check and ratified:

1. The seed entry (`O_66`) had been mapped to the empty set in v1 under a strict reading ("the
   seed act has no *dedicated* record"). The mapping's own semantic rule elsewhere maps an entry
   to the record(s) that record its *substance* — including several two-to-one cases where two
   entries map to one record. Applied consistently, the seed entry's substance is the day-one
   conventions it establishes, which **are** recorded. Leaving it empty under-applied the mapping's
   own rule (§c).
2. The reporting posture, the conditional gate, and the release waiver's scope needed to be fixed
   **now**, before execution, so that no post-result choice can widen a waiver or re-label a gap
   (§d, §e).

This amendment does none of the following: it does not touch the frozen originals, does not change
the derivation rule or the scripts, does not re-segment the oracle, and does not alter K or any
metric definition.

---

## (b) V1 preservation — the registered verdict is permanent

The originally registered gate is over all **51** probes, and 4 of them (`O_66`, `O_75`, `O_76`,
`O_77`) have an empty relevance set. Under the registered method those 4 are misses at every K, so
the registered **Recall gate cannot be met**.

**The registered 51-probe gate's verdict is, and will always be reported as, NOT MET.** This is
permanent. In every report, release note, and summary, the **registered verdict leads or shares the
headline**; the amended conditional result (§d) **never precedes it**. The amendment adds a
conditional reading; it does not convert the registered verdict into a pass, and nothing downstream
may present it as one.

---

## (c) Seed remap (`O_66`) — rule application, per record

Applying the mapping's substance rule (an entry maps to the record(s) that record its substance;
precedents where distinct entries share one record: `O_8`&`O_63`, `O_19`&`O_64`, `O_5`&`O_67`,
`O_6`&`O_73`), the seed entry — *"seed (add/list); conventions above established"* — has as its
substance the five conventions established on day one. It therefore targets these five records, one
line of justification each:

- `m_e15e4482-8f83-4d0d-8132-59be1ab792a7` — the local-JSON **storage-location** convention, one of
  the "conventions above established".
- `m_1f47dd11-3a5c-454d-a727-e49511287564` — the **ISO-8601 timestamp** convention, one of the
  "conventions above established".
- `m_59de9c29-b142-43ad-9c3c-f709543f2533` — the **verb-first `add`/`list`** convention; this is the
  record that carries the seed line's explicit "(add/list)" substance directly, and also a
  "conventions above established" item.
- `m_44415eb8-2f7d-4c33-a373-3933efd09c7b` — the **no-runtime-dependencies / test-framework**
  convention, one of the "conventions above established".
- `m_b9ac6e35-1051-49c4-a4a8-fe954d954822` — the **exit-code-2-on-usage-error** convention, one of
  the "conventions above established".

`O_66` therefore becomes a **targeted** probe in the amended gate, with these five records as its
relevance set (best-rank is the minimum rank across the five, per the protocol's multiple-valid
rule). Because it has more than one target it is **not** in the unambiguous (Hit@1) subset.

**BINDING.** This remap is fixed now. If `O_66` **misses at K=20** (none of the five records appears
in its top-20), the **amended gate fails and the release blocks**. `O_66` **cannot** be reverted to
an empty relevance set after any result is visible; the choice to make it targeted is locked before
execution precisely so it carries real downside.

---

## (d) Amended conditional gate

The amended gate is identical to the registered gate except that `O_66` is targeted:

- **48 targeted probes** (the 47 originally targeted + the remapped `O_66`).
- **3 remaining relevance gaps** (`O_75`, `O_76`, `O_77`) — all development-harness process notes
  (see §e), with no corresponding memory record.
- **Recall@20 = n/n over the 48 targeted probes** (n = 48).
- **Hit@1 = m/m over the unambiguous subset**, recomputed mechanically by the committed generator
  on the amended manifest. The subset is **28** probes (unchanged from v1: `O_66` was empty and is
  now five-targeted, so it is not unambiguous either way; no other probe's mechanical flag depends
  on `O_66`'s relevance). Non-empty ⇒ Hit@1 is **exercised**.
- **contradictions 0; stale-served-as-live 0; errors/unscorable 0.**
- **Stability:** three repeated `run-pilot` runs byte-identical.

**Reporting rule.** All results are **probe-level coverage**, never described as independent
observations. Two-to-one mappings exist (multiple entries share one record; `O_66` shares its five
records with `O_0`–`O_4`), so a count of passing probes is a count of *probes covered*, not a count
of *independent evidence points*.

---

## (e) Waiver scope and decision rule — locked now

The release may proceed under a **waiver** that is scoped, before any result, to **exactly the three
remaining relevance gaps `O_75`, `O_76`, `O_77`** — and nothing else. These three are notes about
the development/review harness that exercises the tool (its run schedule, a watchdog script, a
weekly feedback-review step); none is a decision *about the tool*, so no memory record is expected
for them.

Locked rules:

- The **seed probe `O_66` is OUTSIDE the waiver.** It is a binding targeted probe (§c); a miss there
  blocks release and cannot be waived.
- **Post-result approval may confirm but never expand this scope.** At publish time the release
  approver may confirm the waiver covers `O_75`/`O_76`/`O_77`; the approver may **not** add any probe
  to the waiver, re-label a targeted miss as a gap, or narrow the binding on `O_66`.
- The waiver **authorizes release despite the registered NOT-MET verdict (§b); it does not convert
  the registered verdict into a pass.**

**Recommended release wording (fill placeholders; do not reorder — the registered verdict leads):**

> As of `<date>`, against the frozen pilot corpus at commit `<commit>`, the originally registered
> 51-probe recall gate is reported **NOT MET**: four eligible probes have no corresponding memory
> record and score as misses under the registered method. Under pre-execution amendment 1
> (committed before any retrieval ran), the seed probe was remapped to its five underlying
> convention records, yielding a 48-probe conditional gate; the probes achieved **`<X>` of 48 at
> K=20** (Hit@1 `<m>`/`<m>` on the 28-probe unambiguous subset; contradictions 0;
> stale-served-as-live 0; three runs byte-identical). Release was authorized by `<approver>` under a
> waiver scoped to exactly the three remaining coverage gaps — all development-harness process notes
> with no product decision behind them. The waiver does not convert the registered NOT-MET verdict
> into a pass. Results are probe-level coverage, not independent observations.

---

## (f) Future-runs appendix (v2 additions — not retroactive)

These are recorded for a future, cleanly preregistered run (**v2**). They do **not** apply to the
current frozen corpus or its verdict.

**Eligibility — positive scope rule.** v2 segmentation should exclude **development-infrastructure /
process notes** (schedule, watchdog, review-cadence, and similar operational meta about the harness
rather than decisions about the product) from oracle eligibility, so that such notes are not scored
as recall targets at all. This is the general form of the three gaps waived in §e.

**Mapping — explicit duplicate/seed-entry rule.** v2 mapping should state explicitly that (i) a
changelog line and the standing convention it restates map to the same record(s) (the two-to-one
pattern), and (ii) a **seed / summary entry maps to the union of the records whose substance it
establishes or restates**, rather than to the empty set — the rule applied to `O_66` in §c, written
down in advance instead of adjudicated after the fact.

**Holdout independence spec.** For the temporal holdout to be genuine forward evidence, the
following must be **frozen prospectively**, before the holdout window opens:

- system and configuration identity (the exact build/commit and settings under test);
- eligibility rules (segmentation and exclusion classes);
- query-derivation and mapping rules;
- K and every metric definition;
- the holdout **cutoff** (the transaction-time boundary);
- a **minimum sample size or an explicit stopping rule** fixed in advance.

Then:

- **No product or remediation decision may be informed by the holdout's contents or outcomes.**
  Reading the holdout records to guide a fix, or choosing when to stop by looking at results,
  destroys its independence.
- **Any intervening change resets the untouched window.** If the system, config, rules, or metrics
  change during the window, the clean holdout restarts from the change.
- **A post-gap fix and its immediate recheck are REMEDIATION VERIFICATION, never independent holdout
  evidence.** Fixing a discovered miss and re-running the same probes confirms the fix; it does not
  count as new, independent forward evidence — only genuinely subsequent, unseen decisions do.

---

## (g) Amended-artifact hashes

sha256 of the two new overlay files at this commit:

| artifact | sha256 |
|---|---|
| `docs/release/pilot-oracle-mapping-amended-1.json` | `2b7be1660d69356b7e62805f26ae7c10d3b678044d8b34963830f2d97dca30de` |
| `docs/release/pilot-manifest-amended-1.json` | `d5a2178f56ad016e2899f9a9ced670917f8e4dc5311164b9dbbfc258e1d88197` |

No script was touched by this amendment, so there is no generator-identity change: the amended
manifest was produced by running the already-frozen generator (identities in `pilot-protocol.md`
§9a) over the same frozen inputs with the amended mapping. The frozen originals
`pilot-manifest.json` and `pilot-oracle-mapping.json` are byte-identical to the method-freeze commit
(their hashes in `pilot-protocol.md` §9a are unchanged and still valid).
