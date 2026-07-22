# Gate-path decision — frozen-method Hit@1 (probe O_67)

Date: 2026-07-22 · Approver: wlsgur073 (in-session decision, after one collaborative
cross-review round) · Status: **BINDING governance decision** for the eventual release redo.

## Mandated posture (locked claim template, instantiated)

1. The registered 51-probe verdict remains **NOT MET, permanently**.
2. The conditional Hit@1 gate under the frozen v1 method remains **FAILED at 27/28** — O_67 at
   rank 3 on both manifests; the pre-execution waiver (O_75/O_76/O_77) does not cover O_67.
3. A future release requires ONE of: **(a)** an explicit user-signed deviation for O_67 with
   mechanism evidence attached, or **(b)** a prospectively preregistered protocol v2.
4. Only then: the official pilot re-run on the implemented candidate (`d912414`) confirmed the
   offline sweep exactly — 25/28 → 27/28 on both manifests, zero rank-1 regressions, O_66
   4 → 5 (amended manifest only, within its binding Recall@20), temporal holdout regression
   check unaffected (bestRank 1), zero contradictions, zero stale-served-as-live.

## D1 — path (b), chosen today as policy

The repair design spec deferred this choice to release time ("User decision at release time;
this spec deliberately does not choose"). This document explicitly moves that decision forward;
recording the move is itself part of the decision (a governance change, not a silent one).

Path **(a) is REJECTED now**: no O_67 deviation is signed. It is retained only as a fallback
that would require fresh, explicit re-authorization at release time — it is not a standing
option that can be exercised silently.

## D2 — this is NOT a preregistration

Choosing the v2 path is a policy decision. v2 becomes *prospective* only when its actual method
is frozen, per `pilot-amendment-1.md` §f (Holdout independence spec): system and configuration
identity; eligibility rules; query-derivation and mapping rules; K and every metric definition;
the holdout cutoff; and a minimum sample size or explicit stopping rule — all fixed in advance.
Until that freeze exists, the only permissible claims about this work remain the locked
template above.

## D3 — operational constraint the redo schedule must honor

The untouched holdout window opens at the v2 freeze, and **any intervening system, config,
rule, or metric change resets it** (`pilot-amendment-1.md` §f). The freeze must therefore
precede the intended release by enough calendar room to accrue the pre-fixed minimum sample.
A starved window is reported **unexercised** (protocol §7 precedent), never as a trivial pass.
A post-gap fix plus its immediate recheck is remediation verification, never independent
forward evidence.

## D4 — early regression reuse (newly authorized here)

Protocol §8 converts the frozen probes into a regression suite only **after a release**, which
has not happened. This document newly authorizes **non-gating early reuse** during development:
BOTH `pilot-manifest.json` AND `pilot-manifest-amended-1.json` may be re-run against later
candidates as a regression signal. Both artifacts are load-bearing — the amended overlay
carries O_66's five bound targets, while the original scores O_66 target-less — so neither may
be dropped. Formal §8 conversion still occurs at release.

## D5 — disclosure duties for v2 design

v2's gate design is informed by v1's O_67 outcome and must say so wherever v2 is described.
Any revised unambiguity/subset rule validates on **new temporal cases only** (repair design
§5). The O_67 class is superset competition: the target is the short record that *defines* a
contract which longer referencing records restate inline, so competitors cover a strict
superset of the matched query terms; a monotone surface scorer structurally cannot rank the
superset match below. This is a documented limitation **class** of the scoring family, not an
instance bug. If no new case of the class appears inside the v2 window, that component is
reported unexercised — not silently validated.

## Why-log (decision provenance)

- **Pre-registered position** (assistant, before external review): choose (b); no third
  waiver; drift, waiver-credibility, and class-not-instance arguments; a self-registered
  objection on v2's informed-by-v1 taint.
- **External cross-review** (one collaborative round, 8 findings — all verified against the
  local artifacts and **accepted; none rejected**): decision ≠ preregistration plus the
  release-time-clause amendment (→ D1, D2); the holdout-window reset/scheduling blocker
  (→ D3, the round's largest addition); early-reuse authorization with both-manifests
  preservation (→ D4); taint-disclosure and unexercised-reporting duties (→ D5); a logic
  correction that drift *favors* but does not *force* (b) — adopted, with the deferred-(a)
  middle path surviving only as D1's re-authorization fallback; confirmation that releasing
  with a failed gate and no waiver would be an unapproved deviation under current governance;
  and the requirement that binding decisions live in this tracked directory rather than in
  ignored working docs.
- **Convergence:** declared after one round — the findings refined execution; none reversed
  the recommendation.

## Evidence pointers

- Frozen protocol and amendment: `docs/release/pilot-protocol.md` (§4, §7, §8),
  `docs/release/pilot-amendment-1.md` (§f).
- Official parity re-run, 2026-07-22: three byte-identical runs per manifest; run file sha256
  `01e43499…` (v1 manifest) and `b92447d3…` (amended manifest); archived with the parity note
  in the project's development-evidence tree (untracked working docs).
- Implemented candidate: `d912414` (four-commit matcher-repair sequence).
