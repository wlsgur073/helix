# Helix release record — the first release

**Helix has never been released. `v0.1.0` is its first release.** Everything in this directory is
preparation for that one event. There is no second release planned, no earlier release to maintain,
and the version string has read `0.1.0` at every site continuously except for one day in July 2026.

Read this file first, then open only the document that answers the question you actually have. It is
a map and a narrative, not a replacement: every other file here stays authoritative for its own
subject, and several are read by literal path from scripts and tests, so they cannot be folded into
prose.

---

## 1. One release, two names that are not it, and one ruling

**`v0.2.0` is a past event, not a plan.** A release cycle opened under that number in July 2026 and
was withdrawn when it failed its own gate. Nothing was published, the version identity reverted to
`0.1.0` on 2026-07-22, and the number is not scheduled to return.

**`v2` is a measurement method, not a version of the product.** After the July gate failed, the
recall *pilot protocol* was rewritten, and the rewritten method is called protocol v2. Every `v2-*`
filename here is that method.

**The ruling that closes this directory's one open question.** The protocol v2 window was frozen on
2026-08-14 and ended early, by the owner, on 2026-08-31 (`Abort A-2026-08-31`), with its primary
measurement unmade: `Hit@1 — exposure 1 is below the minimum of 2 … (PARTIALLY EXERCISED — 1/2
(minimum not met))`. Whether that barred the product or only the claim was left open until
**2026-09-09, when the owner ruled that it bars the claim** — `readiness-criteria-2026-07.md` §14.
`v0.1.0` ships carrying **no Hit@1 claim and no recall-quality claim of any kind**, and the aborted
window is disclosed as a measurement that did not happen. C5.2 is unchanged and still governs any
future recall-quality claim, which would require a new freeze and a new window.

*One inconsistency, recorded here rather than fixed, because the file that carries it must not be
edited: `gate-decision-2026-07-22.md`'s last update states the second window's instants as
`06:12:55`, taken from a candidate that was re-cut within the hour. The freeze receipt's `06:20:01`
is authoritative. That document is the last receipt-pinned file whose tracked bytes still equal
their pin, and that equality is the only live evidence of what the receipt pinned.*

## 2. What has happened

**June 2026 — the candidate exists, publication is deferred.** `main` and an annotated `v0.1.0` tag
were cut and bundled off-machine so the publish decision could not be lost with a disk. The owner
deferred the public push on 2026-06-21. That June tag was never pushed and is superseded by the tag
cut at this release.

**July 2026 — a release attempt, and its withdrawal.** A `v0.2.0` cycle opened with a full audit
sweep (`audit-2026-07.md`) and a preregistered recall pilot (`pilot-protocol.md` and its frozen
inputs). The pilot ran on 2026-07-21/22 and did not pass: the registered 51-probe verdict is NOT MET
permanently, and the conditional frozen-method gate failed at 27/28. The candidate was stood down.
That failure produced the governance the project still runs under, in `gate-decision-2026-07-22.md`,
which is binding.

**Late July 2026 — deciding what "ready" means.** `readiness-criteria-2026-07.md` was ratified on
2026-07-24 and drove the audits and drills that followed: `c3-audit-2026-07.md` (security-claim
honesty) and `c4-drills-2026-07.md` (install identity, data durability, maintainer recovery,
executed against the installed artifact).

**August 2026 — protocol v2 under a real freeze, and its abort.** The method was frozen on
2026-08-02, reset on 2026-08-13 under the preregistration's own reset clause because close-day
tooling was built inside the window, and re-frozen on 2026-08-14 against a new candidate. The
superseded receipt is kept, marked void by its filename and by every record that cites it — nothing
inside that file says so — and must never be edited or deleted. The second window ended by owner
abort on 2026-08-31, eleven days before its derived close.

**September 2026 — certified, retired, and certified again.** The candidate was re-cut and the
certification run-sheet executed from the top: on 2026-09-02 all 74 verdict rows read MET and
`npm run certify-gate` exited 0. Two rebuilds — `fa03865` and `2baf9c7` — then moved `bin/`, which
under the run-sheet's own staleness rule retired that certification. After the cleanup this directory
records, the candidate was re-cut at `6110acb` and certified 74 of 74 on 2026-09-10; a further rebuild
for the erase-routing fixes moved `bin/` again and retired that certification in turn, and the run was
repeated at candidate `c181b3d`, 74 of 74, on 2026-09-17. Item 6's batch — the echo diagnosis, the
compare verdict and the C3.1 follow-ups — moved `bin/` once more and retired that certification too;
the candidate was re-cut at `edeb57f7` and certified 74 of 74 on 2026-09-23. That run is the first to
span two days on purpose: its verdict rows include observations made through the host's own MCP
connection, and the launch barrier means a session started before the reinstall still serves the old
bytes, so the rebinding waited for a restarted session rather than carrying evidence the run had not
produced. Item 7's batch — the compare verdict words, the aliased project ledger check, the 32-id
`inspect` cap and the trigger acknowledgement — moved `bin/` again and retired that certification;
the candidate was re-cut at `8abd984` and certified 74 of 74 on 2026-09-24, its Block E again run
from a Claude Code process started after the reinstall. Declaring the release is the step after it.

## 3. Where each document sits

**Governing the release**

- `gate-decision-2026-07-22.md` — binding gate-path decision (D1–D5). Any recall-quality claim is
  governed by it. Byte-pinned by the freeze receipt, and its tracked bytes still equal that pin.
  **Do not edit this file.**
- `readiness-criteria-2026-07.md` — the ratified criteria, with the amendment record that carries the
  2026-09-09 ruling in §14.
- `o67-class-rule-2026-07.md` — the frozen offline classification rule for superset-competition
  cases. Byte-pinned by the freeze receipt, and **cited in a comment** by `src/memory/retrieval.ts`;
  the code that reads it by literal path is `scripts/pilot/` and its tests. Its tracked bytes diverge
  from the pin permanently and by intent since 2026-09-02, when three private-workspace citations
  were de-pathed; the blob the pin was taken from, at candidate `94dd136`, is untouched, and that is
  what the freeze guard re-hashes.

**The withdrawn July attempt — kept because the release inherits its governance**

- `pilot-protocol.md` (historical), `pilot-amendment-1.md` (§a–§e historical, §f still normative),
  `pilot-manifest.json`, `pilot-manifest-amended-1.json`, `pilot-oracle-mapping.json`,
  `pilot-oracle-mapping-amended-1.json` — the first-edition method and its frozen, hash-pinned
  inputs. No code consumes the four JSON artifacts today.
- `audit-2026-07.md` (historical) — the point-in-time release audit. Its findings stand; its
  forward-looking statements describe the abandoned cycle. Its exact path is allow-listed by
  `scripts/scan-history-secrets.ts`, so it must not be moved.

**Protocol v2 — the measurement, aborted 2026-08-31**

- `v2-preregistration-2026-07.md` — the registered method. Historical: the registration stands, the
  window does not.
- `v2-freeze-receipt-2026-08.json` — the signed pin set, read by `scripts/freeze-guard.ts` and its
  test by literal path. Never edit.
- `v2-freeze-receipt-2026-08-02-void.json` — the superseded first-window receipt. **Void by filename
  and by external record only; nothing inside the file marks it.** Never edit or delete.
- `v2-freeze-deviations-2026-08.md` — the deviation ledger: every departure from the frozen
  procedure, with its remediation and its disposition.
- `v2-close-report-2026-08.md` — the abort record, and the disposition of the window. Its appendices
  carry the close-run evidence index and what moved after it was written.
- `v2-close-checklist-2026-08.md` — the close-day run-sheet. It was **never executed**: 3 of its 112
  boxes are ticked, and its banners say why. It survives as the record of the rehearsal measurements
  the ledger and the abort record cite by line.

`npm run freeze-guard` — `scripts/freeze-guard.ts`, which is neither the deleted shell script nor
part of it — still runs in CI on every push. It re-hashes every pinned path out of the candidate
commit and fails on a payload-seal mismatch, a missing candidate commit, a trimmed pin map, or a
changed anchor, so it remains the standing check that this repository's history still holds what the
receipt says it pinned. Its second output is warn-only working-tree divergence: more paths than the
five some records name, and suppressed entirely once the receipt's `txClose` instant passes. Run it
for the current list rather than quoting a number.

**Certifying and shipping**

- `v0.1-candidate-receipt.json` — the candidate's identity: commit, tree, bundle hashes, manifest
  hashes, claim-set hashes, the certified row inventory, and the gate state at the cut. Produced and
  verified by `npm run cut-candidate`; read by `npm run certify-gate`. Never hand-edit: the payload
  is sha256-sealed, so an edit either fails its own verifier or has to forge the seal.
- `v0.1-certification-runsheet.md` — the certification execution record. Its staleness rule governs:
  the next commit that moves `bin/` retires every verdict row.
- `deploy-runbook.md` — how to make installed bytes equal intended bytes. Every rule in it was
  learned from a live deploy failure.
- `recovery-playbook.md` — what to do when a lifecycle operation needs undoing. Its path appears in a
  user-visible tool response (`src/server/handlers.ts`) and is read by literal path in
  `test/docs/shipped-claims.doc.test.ts`, and its blocks are claim-classified, so it cannot be
  renamed without moving code, tests and the ledger together.
- `deps-audit-2026-09.md` — dependency advisory triage at the release, with a measured
  reachability verdict for every production advisory.
- `c3-audit-2026-09.md` — the C3.1 security-claim sweep at the release candidate.

**Removed files.** These were deleted on 2026-09-09 because nothing was left for them to do. Records
that cite them are correct about the past; recover the bytes with
`git log --diff-filter=D --oneline -- <path>` and then `git show <commit>^:<path>`.

| file | why it went |
|---|---|
| `v2-close-procedure-2026-08.md` | described why a close chain runs from the tree it runs from; no close chain will run |
| `v2-close-evidence-index-2026-08.md` | its artifact table and its one open item moved into `v2-close-report-2026-08.md`, Appendix A |
| `v2-freeze-runtime-pins-2026-08.txt` | the `sha256sum -c` input of the retired guard script |
| `scripts/freeze-runtime-check.sh` | retired in place 2026-09-05, inert by default, anchored to a retired candidate, and citing a close receipt that will never exist |
| `deps-audit-2026-08.md` | superseded by `deps-audit-2026-09.md`, which carries its dispositions forward |

## 4. What is still owed

- **The declaration.** Fast-forward `main` to the certified commit, cut and push an annotated
  `v0.1.0` tag, publish the release notes. `origin` carries no tags today.
- **Owner acts, on the machine that holds the deployment and the archives:**
  - C4.6-Q4's separate-medium copy, which regressed to open on 2026-09-03 because the copy sits on
    the same physical disk as its source.
  - The durable second copy of the non-secret evidence chain (`v2-close-report-2026-08.md`,
    Appendix A). It must not be discharged against the Q4 location, which has the same defect.
  - C5.1 closure item 12, re-scoped: an off-machine bundle holding the release candidate and its tag.
    Minted last, after certification, so a failed check cannot leave it stale.
  - Redeploy the release there; that machine runs the `263f2a9` build.

**And then the list ends.** Nothing on it is preparation for a version after `v0.1.0`.

## 5. Why this directory is not yet one file

It should end as one release record, and it will. Two reasons still hold, both mechanical:

1. **Files are read by literal path** from scripts and tests — the two receipts, the o67 class rule,
   the candidate receipt, the recovery playbook, and `audit-2026-07.md`'s allow-listed path. Merging
   them breaks the build, not just the prose.
2. **The run-sheet is an instrument**, ticked and pasted into as it runs.

The first reason the earlier version of this file gave — an open freeze window that a merge would
reset — lapsed with the abort. Consolidation belongs to the post-release cleanup.
