# v2 close procedure — the tree the close chain runs from

Written 2026-08-06, during the open v2 window (`2026-08-02T11:35:05.000Z < tx ≤
2026-08-30T11:35:05.000Z`).

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

> **The close chain runs from a clean checkout of the candidate commit
> `27b4373d64d13c7b258aab011570be2d973c34da`, not from the working tree.**

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

`input-pins.ts` is itself one of the 25 pinned tools, so this asymmetry cannot be resolved by
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
2. Confirm the checkout is clean and at `27b4373d64d13c7b258aab011570be2d973c34da`.
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

### 1. `gate-decision-2026-07-22.md` differs from the receipt in the working tree

The freeze receipt pins `ebdbb307e13310a9…`; the working tree holds `400d586565665ec1…`. The
freeze commit itself appended the `**Update (2026-08-02; D1–D5 still unchanged).**` block to that
document in the same commit that issued the receipt against the preceding candidate commit, so the
receipt and the tree disagree by construction from minute zero.

Under the rule above this is a **non-event**: the candidate-commit checkout carries the pinned
bytes, so `refuseMethodDrift` sees no divergence. It is recorded here because it is the single
most likely thing to be misread as an integrity failure, and because the alternative treatment —
reverting the file — would restore a sentence (`NOT YET IN FORCE`) that is now false in a BINDING
document.

`o67-class-rule-2026-07.md` is clean: pinned `c1fe768ca0ec2b11…`, tree identical.

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
- If any of the 25 pinned tool paths or 2 pinned method docs differs between the candidate commit
  and the receipt, the anchor set itself is broken and no checkout rescues it. `npm run
  freeze-guard` checks exactly this and is HARD-failing on it.
