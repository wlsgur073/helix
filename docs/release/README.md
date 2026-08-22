# Helix release record — the road to the first release

**Helix has never been released. `v0.1.0` will be its first release, and it has not happened yet.**

Everything in this directory is preparation for that one event. There is no second release to plan
for and no earlier release to maintain: the version string has read `0.1.0` at every site
(`package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) continuously,
except for one day in July described below. The `v0.1.0` tag exists only as a local ref in a
separate clone; the public push was deferred by the owner on 2026-06-21 and remains deferred.

This file is the single entry point. Read it first, then open only the document that answers the
question you actually have. **It is a map and a narrative, not a replacement**: every other file
here stays authoritative for its own subject, and several of them are read at runtime by source
code, by tests, and by the freeze guard, so they cannot be folded into prose.

---

## 1. One release, and two names that are not it

**There is exactly one release in this project's plan: `v0.1.0`, the first one. Nothing is planned
after it.** There is no `v0.2.0` on the roadmap, no later version, and no maintenance line. When a
file here names a version other than `0.1.0`, it is naming a past event or a measurement method —
never a future release.

Two other version-shaped names appear in this directory, and neither is a release:

**`v0.2.0` — a past event, not a plan.** A release cycle opened under that number in July 2026 and
was withdrawn when it failed its own gate. Nothing was published under it, the version identity was
reverted to `0.1.0` on 2026-07-22, and the number is not scheduled to return. The next release is
still the first one.

**`v2` — a gate on the way to `v0.1.0`, not a version of the product.** After the July gate failed,
the recall *pilot protocol* was rewritten, and the rewritten method is called protocol v2. Every
`v2-*` filename here is that method, not a product version.

It is also not a parallel track that could be dropped. `gate-decision-2026-07-22.md` is binding and
states that a future release requires **one of**: (a) an explicit user-signed deviation for the
failing probe with mechanism evidence attached, or (b) a prospectively preregistered protocol v2 —
and its D1 chose path (b) as policy. **The v2 pilot is therefore a precondition of shipping
`v0.1.0`, not a separate release and not an alternative to it.** Its window closing is a step in
the first release, which is why the certification run-sheet schedules its remaining work after that
close.

So: one release, one withdrawn attempt that is over, and one gate standing between the code and
that release.

## 2. What has happened so far

The work has proceeded as a sequence of updates toward the first release, each one triggered by
what the previous one measured.

**June 2026 — the candidate exists, publication is deferred.** `main` and the annotated `v0.1.0`
tag were cut and bundled off-machine so that the publish decision could not be lost with a disk.
The owner deferred the public push on 2026-06-21. That decision has not been revisited, and it is
still the last step of the first release.

**July 2026 — a release attempt, and its withdrawal.** A `v0.2.0` cycle opened with a full audit
sweep (`audit-2026-07.md`: secret scan over the public history, dependency licence check,
marketplace file review, version-string baseline) and a preregistered recall pilot
(`pilot-protocol.md`, with `pilot-manifest.json`, `pilot-oracle-mapping.json`, and the
pre-execution `pilot-amendment-1.md` plus its two overlay artifacts). The pilot ran on 2026-07-21
and 07-22. **It did not pass.** The registered 51-probe verdict is NOT MET permanently, and the
conditional frozen-method Hit@1 gate failed at 27/28. The candidate was stood down on 2026-07-22
and the identity reverted to `0.1.0`.

That failure produced the governance the project still runs under. `gate-decision-2026-07-22.md`
is **binding**, and in its own words *a future release* requires a prospectively preregistered
protocol v2 (its chosen path (b)); the earlier protocol cannot be reused to make a recall-quality
claim. The release that clause governs is the first one — `v0.1.0` — because that is the next
release there is.

**Late July 2026 — deciding what "ready" means.** `readiness-criteria-2026-07.md` was ratified on
2026-07-24 after every owner decision closed, including a domain-by-domain interview that mapped
13 felt gaps onto criteria or accepted limitations. Its criteria drove the audits and drills that
followed: `c3-audit-2026-07.md` (security-claim honesty, three independent auditors over disjoint
`SECURITY.md` sections) and `c4-drills-2026-07.md` (install identity, data durability, maintainer
recovery, executed against the installed artifact rather than the source).

**August 2026 — protocol v2 under a real freeze.** `v2-preregistration-2026-07.md` registers the
second-edition method, and it is in force from the commit that carries its filled pin table. The
method is frozen: a receipt pins the bytes, and the window is real-use verification of exactly
those bytes.

The first window was **reset** on 2026-08-13 under the preregistration's own reset clause, because
close-day tooling was built inside it, and the method was re-frozen on 2026-08-14. The superseded
receipt is kept, marked void, and must never be edited or deleted — a voided record that
disappears is worse than no record. The open window runs to `2026-09-11T06:20:01.000Z`.

**August 2026 — certifying the first release candidate.** `v0.1-certification-runsheet.md` is the
execution record for certifying the release candidate itself, bound to the candidate named in
`v0.1-candidate-receipt.json`. It is currently marked stale by design: the candidate moved on
2026-08-20, and the run-sheet's own rule is that no verdict row survives changed bundle bytes. Its
remaining blocks are now fixed to run *after* the post-close rebuild, because that rebuild moves
the bundles again and would discard an earlier run.

## 3. Where each document sits

**Governing the first release**

- `gate-decision-2026-07-22.md` — binding gate-path decision. Any recall-quality claim is governed
  by it. Byte-pinned by the freeze receipt; do not edit while the window is open.
- `readiness-criteria-2026-07.md` — ratified service-readiness criteria and the roadmap its own
  title calls a "redo roadmap". Read *redo* as redoing the release **attempt** that was withdrawn
  in July, not as a second product version: its target is `v0.1.0`.
- `o67-class-rule-2026-07.md` — the frozen offline classification rule for superset-competition
  cases, without which the exercised/unexercised report the gate decision requires cannot be
  produced. Byte-pinned by the freeze receipt; also read at runtime by `src/memory/retrieval.ts`.

**The withdrawn July attempt — kept because the first release inherits its governance**

- `pilot-protocol.md` (historical), `pilot-amendment-1.md`, `pilot-manifest.json`,
  `pilot-manifest-amended-1.json`, `pilot-oracle-mapping.json`,
  `pilot-oracle-mapping-amended-1.json` — the first-edition method and its frozen inputs.
- `audit-2026-07.md` (historical) — the point-in-time release audit. Its findings stand; its
  forward-looking statements describe the abandoned cycle.

**Protocol v2 — the measurement now running**

- `v2-preregistration-2026-07.md` — the registered method, in force.
- `v2-freeze-receipt-2026-08.json` — the signed pin set. Read by `src/memory/firewall.ts`, by the
  freeze guard, and by tests, all by literal path.
- `v2-freeze-runtime-pins-2026-08.txt` — the runtime pin list the guard compares against.
- `v2-freeze-receipt-2026-08-02-void.json` — the superseded first-window receipt. **Never edit or
  delete.**
- `v2-freeze-deviations-2026-08.md` — the deviation ledger: every departure from the frozen
  procedure, with its remediation and its disposition.
- `v2-close-procedure-2026-08.md` — why the close chain runs from the tree it runs from.
- `v2-close-checklist-2026-08.md` — the close-day run-sheet. Ticked and pasted into on the day.
- `v2-close-report-2026-08.md` — the final report, pre-drafted so that close day is transcription
  rather than authorship. Values that can only exist at the close are marked as fill sites.

**Certifying and shipping the release itself**

- `v0.1-candidate-receipt.json` — the candidate's identity: commit, tree, bundle hashes, manifest
  hashes, claim-set hashes, and the gate state at the cut.
- `v0.1-certification-runsheet.md` — the certification execution record.
- `deploy-runbook.md` — how to make installed bytes equal intended bytes. Every rule in it was
  learned from a live deploy failure.
- `recovery-playbook.md` — what to do when a lifecycle operation needs undoing. There is no undo
  command; these are the recipes, each executed against the shipped bundle rather than inferred.
- `deps-audit-2026-08.md` — dependency advisory triage, with counts before and after the fix it
  records.

## 4. What is still owed before the first release

- **The public push.** Deferred 2026-06-21 and still the owner's decision. It is the last step.
- **The pilot window closes 2026-09-11.** Until then the frozen bytes must not move.
- **Certification blocks re-run after the post-close rebuild**, per the run-sheet's own staleness
  rule.
- **A post-close rebuild and redeploy.** Several fixes are complete in source but deliberately not
  built, because rebuilding would move the frozen bytes. They ship together after the close.
- **A validated close receipt** that retires the freeze guard and restores the settings the freeze
  turned off.

**And then the list ends.** Nothing on it is preparation for a version after `v0.1.0`, because no
such version is planned. When the public push happens, the work this directory records is done,
and what follows is whatever the first release turns out to need — not a queued `v0.2.0`.

## 5. Why this directory is not yet one file

It should end as one release record, and it will. It cannot be collapsed today, for reasons that
are mechanical rather than editorial:

1. **Two files are byte-pinned by the freeze receipt.** Editing either one during the open window
   resets the window and discards the real-use verification accumulated so far — which has already
   cost this project one window.
2. **Eleven files are read by literal path** from source, tests, and the freeze guard. Merging them
   breaks the build, not just the prose.
3. **Three files are close-day instruments**, not narrative: a run-sheet that gets ticked, a report
   with fill sites, and a pin list a shell script compares against.

The consolidation therefore belongs to the post-close cleanup, together with the citation cleanup
that the vocabulary test already schedules for the same moment. Until then, this file carries the
single narrative and each document keeps its own authority.
