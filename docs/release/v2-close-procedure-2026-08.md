# v2 close procedure — the tree the close chain runs from

Written 2026-08-06, during the first v2 window. **Re-pointed 2026-08-14:** that window was reset
under §8 and its bounds are void; the open window is now `2026-08-14T06:20:01.000Z < tx ≤
2026-09-11T06:20:01.000Z`. The procedure itself did not change — only the identity it points at,
which is why this file names the receipt as the authority below instead of repeating a sha that a
future reset would silently falsify.

## What this document is, and what it is not

It **records an operating procedure that already governs this window**. It fixes no new method
choice, changes no measured rule, and adds no threshold, so it is prose in the sense
`v2-preregistration-2026-07.md` §8 means — "the measured surface is code, config and the frozen
rules — **not** prose" — and writing it neither resets nor amends the window.

It exists because that procedure was, until now, recorded in exactly one place: a comment inside
`scripts/freeze-guard.ts`. A procedure that only a code comment carries is a procedure that can be
forgotten on the one day it matters, and forgetting it produces a `method-drift` refusal that
looks identical to a real integrity failure.

This document is **not** in `PINNED_METHOD_DOCS` (`scripts/pilot/pin-hashes.ts`), which holds
exactly two entries — `o67-class-rule-2026-07.md` and `gate-decision-2026-07-22.md`. Method-doc
hashing iterates that fixed list and never scans the directory, so adding this file cannot perturb
the close-time comparison.

## The rule

> **The close chain runs from a clean checkout of the candidate commit — `payload.candidateCommit`
> in `v2-freeze-receipt-2026-08.json`, currently `94dd136925253be74c58df92392044c550aa6ec2` — not
> from the working tree.**

`scripts/freeze-guard.ts` states it in its header contract: working-tree divergence from the pins
is WARN-only before `txClose`, because *"Undeployed repo work during the window is legitimate; the
close chain runs from the candidate commit, not from this tree."* Its own HARD anchor check
re-hashes every pinned path from the **candidate commit's blob** (`git ls-tree` / `git show`),
never from the tree.

### Why it has to be said out loud

Two programs of the frozen method look at different trees, and only one of them says so:

| Program | When it runs | What it hashes |
|---|---|---|
| `scripts/freeze-guard.ts` | during the window (CI) | the **candidate commit's** blobs; the tree only for warnings |
| `scripts/pilot/input-pins.ts` | at the close | `process.cwd()` — whatever tree it is invoked in |

`input-pins.ts` re-derives `hashTools(process.cwd())` and `hashMethodDocs(process.cwd())` and
refuses with `method-drift` (exit 1) on any set-wise difference in either direction. Run it from a
tree carrying post-freeze work and it refuses — correctly, by its own contract. Run it from a
clean candidate checkout and every pin is satisfied by construction.

`input-pins.ts` is itself one of the 26 pinned tools, so this asymmetry cannot be resolved by
editing it during the window. It is resolved by **invoking the chain in the right tree**, which is
what this document fixes in writing.

### The consequence for ordinary development

Repository work during the window is legitimate and does not reset it, provided the deployed
runtime is untouched. That is the frozen method's own position, not a convenience: what the window
measures is the installed plugin that served recall plus the pinned method as of the candidate
commit. Neither is affected by commits that stay in the repository.

Two disciplines make that safe rather than merely true:

1. **Do not deploy to the measuring machine** until the close chain has completed.
2. **Prefer to leave the 9 pinned `src/memory` modules untouched** on the mainline branch —
   `retrieval`, `store`, `expansion`, `ownership`, `verified-read`, `verified-projection`,
   `witness-store`, `witness-read`, `witness-core`. As of this writing all 9 are byte-identical to
   the candidate commit. Keeping them so costs nothing and removes any dependence on this
   procedure being remembered correctly.

## Close-day sequence

`v2-preregistration-2026-07.md` §9 fixes the order; each step completes and is hashed before the
next begins:

```
freeze receipt → close-bounded snapshot → manifest / candidate universe / classifier
              → prepare → runner outputs → adjudication → score → release decision
```

Nothing that reads a rank may run before the prepare artifact exists and is hashed.

Operationally:

1. Materialise a clean checkout of the candidate commit (`git worktree add` to a scratch path, or
   a detached checkout in a separate clone). Do **not** run the chain from the development tree.
2. Confirm the checkout is clean and at the receipt's `payload.candidateCommit` — read it from the
   receipt rather than from this sentence, then compare (`94dd136925253be74c58df92392044c550aa6ec2`
   for the second window).
3. Run the chain from inside that checkout, in the §9 order above.
4. Record in the final report that the chain was run from a candidate-commit checkout, per §9a's
   requirement to carry "the pins re-verified at the close".

Deviation ledger: every entry in `v2-freeze-deviations-2026-08.md` (same directory) is REQUIRED
content for the §9a report's reset-and-deviation history — including the 2026-08 autoUpdate
deviation and its no-reset determination. The freeze-runtime guard
(`scripts/freeze-runtime-check.sh`) retires only when the close checklist writes the validated
close receipt (`v2-close-receipt-2026-08.json`) after release-record validation; writing that
file is part of this §9a step, and the close also removes the bashrc/systemd freeze-guard wiring
and restores both marketplace `autoUpdate` flags to true.

## Conditions to expect at the close

These are known now. Meeting them for the first time on close day, when they cannot be
distinguished from a genuine failure, is the outcome this section prevents.

### 1. Both pinned method docs MATCH the receipt — expect no divergence, and treat one as a finding

**This condition INVERTED at the second freeze and the old text would now send an operator hunting
for a mismatch that is not there.** In the first window the receipt pinned
`ebdbb307e13310a9…` while the tree held `400d586565665ec1…`, because that freeze commit appended its
update block to `gate-decision-2026-07-22.md` in the same commit that issued the receipt against the
preceding candidate — receipt and tree disagreed by construction from minute zero.

The reset forced the ordering to be got right: a pinned method document must be final BEFORE the
candidate commit, since the receipt hashes the working tree and refuses any pinned path that
diverges from `--commit`. The 2026-08-14 update recording the first window as void therefore lands
INSIDE candidate `94dd136`. Measured 2026-08-14 and re-measured 2026-08-16:

- `gate-decision-2026-07-22.md` — pinned `e51e29373d73f50e…`, tree identical.
- `o67-class-rule-2026-07.md` — pinned `c1fe768ca0ec2b11…`, tree identical.

⇒ At the close, expect **both to match**. A divergence in either is no longer the known non-event
it was in the first window; it is a finding to record and report. The one legitimate exception is
`o67-class-rule-2026-07.md` after run-sheet step D2, which deliberately removes three citations
AFTER the validated close receipt is written — see the close report §2.2.

### 2. The close chain is bound to the deployment machine

`scripts/pilot/input-pins.ts` unconditionally reads the configuration path recorded in the receipt
(`config.path`) with no flag to skip it. An unreadable path is an invocation
error (exit 2), not a refusal of the pins. The chain therefore cannot be run to completion on any
machine that lacks that file, whatever tree it is invoked from.

The configuration bytes must equal the pinned `16f6d97f…` at the close, or the run fails
`method-drift`. Any live tuning of that file during the window converts silently into a close-time
refusal.

### 3. The runtime pin is declared, not re-derived

`input-pins.ts` states it plainly: *"The runtime identity is declared, not derivable from bytes,
and is NOT re-verified here — the deploy runbook's load-path check is its counterparty."*

`v2-preregistration-2026-07.md` §10 says of the runtime and candidate pins that "both are verified
again at the close". **The implementation does not do this for the runtime half.** The gap is
closed only by executing the load-path check in `deploy-runbook.md` ("Staleness is `gitCommitSha`,
never `version`") on the deployment machine: three `gitCommitSha` values equal, and the bundle
bytes identical across **both** load paths — the marketplace clone and the version-keyed cache
directory.

That check has not been executed on the deployment machine during this window. Until it is, the
receipt's runtime declaration is unverified, and §1's claim — that the release decision was
governed by a rule frozen before the window — rests on it. §10 already warns that "a repository
commit is not proof of what is installed, and this deployment has already produced a window where
the two disagreed."

## What would invalidate this procedure

State it here so a future reader does not have to reconstruct it:

- If the deployment machine's load paths did **not** both carry the candidate commit's bundle for
  the whole window, the window did not open under the identity the receipt declares. Whether that
  is a reset (drift after a correct freeze, with dated evidence) or an abort (never correct) turns
  on when the divergence began, and current file mtimes cannot establish that retroactively.
- If any of the **26** pinned tool paths or 2 pinned method docs differs between the candidate
  commit and the receipt, the anchor set itself is broken and no checkout rescues it. *(26, not the
  25 this line carried until 2026-08-16: the second freeze added
  `scripts/close/adjudication-skeleton.ts`. Read the count from
  `PINNED_TOOL_PATHS` rather than from this sentence — a cardinality that only prose records is one
  a value-by-value sweep cannot correct, and this sentence is the operative HARD-fail judgment.)* `npm run
  freeze-guard` checks exactly this and is HARD-failing on it.
