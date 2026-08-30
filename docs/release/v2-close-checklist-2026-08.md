# v2 close-day run-sheet — 2026-09-11T06:20:01.000Z

**This is a run-sheet, not an essay.** Tick boxes as you go, paste observed output next to the
step, and leave the file in the repository as the close-day log. The *why* behind every rule here
lives in `v2-close-procedure-2026-08.md` and `v2-preregistration-2026-07.md` §9/§9a — this
document does not repeat it, it executes it.

The deliverable is `docs/release/v2-close-report-2026-08.md` (§9a). Every step below either
produces evidence that report cites, or removes a control the freeze installed.

**Provenance of the 2026-08-25 corrections.** Five steps were re-anchored to measurement that day
(0.5, 0.6, Block B's intersection claim and its three echoes, E3, E4) after four of this sheet's
predictions were found false and two of them inverted. The reasoning, including the points where a
symmetric peer consultation corrected this sheet's author rather than confirming him, is the
`### Why-log — the peer reconciliation behind this corrigendum and the close-sheet corrections`
section of `v2-freeze-deviations-2026-08.md`. It is recorded there rather than here because a
run-sheet executes and a ledger explains.

**Read "Which tree runs what" (after Block B) before you run anything.** Not every command here
runs from the same directory, and one of them *cannot* run from the candidate checkout. The rule
has four parts and every step below is tagged with the part that applies. *(Was two under the first
window; the re-freeze moved the adjudication skeleton into the candidate. The one that remains is
structural and no re-freeze can move it — see R2.)*

**Rehearsal status.** Steps marked *(rehearsed 2026-08-13)* were actually run on this machine
before close day and their observed output is recorded inline — including every python block, which
is pasted here in the form that was executed. Everything that needs the close-bounded snapshot is
**UNREHEARSED** and marked so — the snapshot cannot exist before the close, so nothing downstream of
it has ever been executed end to end; the C1 blocks were nonetheless driven against a *copy* of the
live units under a throwaway `HOME`, which proves the commands and not the close-day corpus.

**0.6 and its G6 reversal are NO LONGER "unrehearsed by choice" — both were rehearsed 2026-08-25,
and both were BROKEN.** The stated reason for not rehearsing them (it would take the live dogfood
run down mid-window) does not survive measurement: between a completed run and the next elapse there
is no run to suppress, and on 2026-08-25 that interval was hours long. Rehearsing found that 0.6's
`mask` fails outright, that `mask --runtime` looks like a fix and is not one, and that G6's `unmask`
exits 0 while reversing nothing. **Every one of those would have been discovered for the first time
on the single irreversible day, at the step that guards the only unrecoverable failure.** Corrected
blocks with observed output are at both steps. D1's `freeze-runtime-check.sh`
line used to be listed here as a third; it no longer is, because the script's `FRC_*` env seams
drive both of its branches against a throwaway receipt — only the unseamed live invocation retires
the guard, and that single act is what stays irreversible.

**Values are copied, never typed.** Load them once, from the receipt:

```bash
cd ~/dev/helix
eval "$(python3 -c "
import json
p=json.load(open('docs/release/v2-freeze-receipt-2026-08.json'))['payload']
print('CANDIDATE=%s'%p['candidateCommit']); print('K=%s'%p['k'])
print('TX_AFTER=%s'%p['txAfter']); print('TX_CLOSE=%s'%p['txClose'])
print('FREEZE_PAYLOAD_SHA=%s'%json.load(open('docs/release/v2-freeze-receipt-2026-08.json'))['payloadSha256'])")"
export CANDIDATE K TX_AFTER TX_CLOSE FREEZE_PAYLOAD_SHA
echo "$CANDIDATE $K $TX_AFTER $TX_CLOSE $FREEZE_PAYLOAD_SHA"
```

**`eval` + `export`, not a bare print — and this changed at the second freeze.** The first window's
form printed the five values for the operator to read and retype, which is what "values are copied,
never typed" was meant to prevent and did not. Steps below now REFERENCE `$CANDIDATE`, `$TX_AFTER`
and `$TX_CLOSE` directly, so they must be set and exported in the transcript shell or those commands
silently expand to nothing — `git worktree add --detach ~/close-candidate` with an empty sha checks
out HEAD, which is the wrong tree with no error. Run this in the **same shell as 0.1's transcript**,
for the same reason `$TSX` must be (0.3), and re-run it in any new shell.

*(re-run 2026-08-14, against the re-issued receipt)* →
`CANDIDATE=94dd136925253be74c58df92392044c550aa6ec2`, `K=20`,
`TX_AFTER=2026-08-14T06:20:01.000Z`, `TX_CLOSE=2026-09-11T06:20:01.000Z`,
`FREEZE_PAYLOAD_SHA=360ffe80f6baf853fdc5acb4bc949a14b84838c3827cbeb56832da56bfcc7332`.
The command needed no edit — it reads the receipt — which is the whole reason it is written this
way; the 2026-08-13 rehearsal printed the FIRST window's values and they are void.
`jq` is **not installed on this box** — the `python3` forms above and below are the tested ones.

---

## Block A — owner-owed BEFORE close day

These are not close-day steps. If they are not done before the window closes they either cannot be
done at all (A1), or they stay open and the report says so (A2, A3). **A4 is discharged** — it is
retained below as the record of a question that was ruled and does not recur in this window.
*(Until 2026-08-17 this paragraph named A4 as an exception whose unwritten ledger entry blocked
publication. The entry was written 2026-08-14 at `3bd63d0`; see A4.)*

- [ ] **A1. Home-machine pin verification** — prepared, needs a **transfer + one bash run** by the
  owner. Script: `docs/issues/2026-08-12-home-pin-check.sh` (strictly read-only: writes nothing,
  changes no git state, no heal/reset/pull; expected values are embedded so it needs neither the
  repository nor a network). Paired doc: `docs/issues/2026-08-03-freeze-pin-verification-home-machine.md`
  (**confirm the v3.4 banner** before running — the paired doc was re-anchored to this window as v3
  on 2026-08-14 and has been corrected four times since: v3.1 on 2026-08-17, when five first-window
  expected values were found still live in its manual path and judgment table; v3.2 the same day,
  aligning the Korean terminology with the script's own variable names; **v3.3 on 2026-08-22, the
  only revision that changed judgment behaviour** — it narrowed the runtime-tree comparison to
  `data/semantic-neighbors.json`, which removed three false `POISONED` verdicts caused by
  `data/inventory/*`, and it turned the pin ∩ changed-set line from an assertion into an
  observation; and v3.4 on 2026-08-23, aligning the script's self-identifying banner, which v3.3 had
  left saying v3.2. **Any copy labelled v2, v3, v3.1, v3.2 or v3.3 will mis-verify the transfer or
  mis-judge a correct machine** — and a *matched* old pair, an old script beside the document of the
  same vintage, passes that document's own §2 sha256 check, so the check does not reject it. The
  banner label is what rejects it; confirm it on both files).
  *(Corrected 2026-08-24. This line asked for the v3.1 banner until then, so an operator following it
  would have met a mismatch that was not real — the same defect the v3.4 revision fixed one level
  down, left uncorrected here because the 2026-08-23 pass never traced the citation upstream.)*

  Both files must be **transferred to the home machine first** — it has no copy of this repository,
  so the repo-relative paths above name them only on the box you are reading this on. Put them in
  one directory there, and run from inside it:

  ```bash
  DEST=PASTE_THE_DIRECTORY_YOU_TRANSFERRED_IT_INTO   # e.g. the home machine's ~/Downloads
  [[ "$DEST" != PASTE_* ]] && cd "$DEST" || echo "STOP: replace DEST with the transfer directory"
  ls 2026-08-12-home-pin-check.sh                           # confirm you are in the right place
  bash ./2026-08-12-home-pin-check.sh > pin-report-$(date +%Y%m%d).txt 2>&1
  echo "exit=$?"; cat pin-report-$(date +%Y%m%d).txt
  ```

  *(The directory is a guarded variable for the same reason C10's decision is: `cd <the directory…>`
  pasted verbatim is shell redirection, and measured 2026-08-13 it died with
  `bash: syntax error near unexpected token 'newline'` — harmless, but it tells a reader on an
  unfamiliar machine nothing about what to do next.)*

  A bare `bash 2026-08-12-home-pin-check.sh` with no `cd` is what the earlier draft said, and on a
  machine the file was just transferred to it fails `No such file or directory` from whatever
  directory the shell happened to open in. The script is self-contained (expected values embedded),
  so the directory only has to contain the script itself.

  Success: the report file is returned to the owner in full — **that output IS the §4 report**.
  On failure / not run: the §9a report must state that the second machine's pins were never
  observed. It cannot be reconstructed after the close.

- [ ] **A2. Q1 / Q2 account-and-credential inventory** ([REAL-OP], owner, read-only) — separate
  owner items, tracked in `c4-drills-2026-07.md` §Q1 (unused GitHub recovery codes exist and are
  reachable **without** the GitHub account) and §Q2 (push-capable credential inventory beyond the
  active box). Neither is a close blocker; both are reported as open if unexecuted.

- [ ] **A3. Q4 helix-data backup — owner-executable; the "BLOCKED" premise is stale.**
  Q4 (`c4-drills-2026-07.md`) owes *"one **encrypted**, physically separate snapshot of both
  units"*. *(Corrected 2026-08-27: this item said `recovery-playbook.md` §6 "ships plain `tar -czf`
  commands only — no encryption step anywhere in the section". That was true until `fba205e`
  (2026-08-24), which gave §6 the `tar -czf - … | gpg --symmetric --cipher-algo AES256` step
  (`recovery-playbook.md:185`), the verify-without-extract line (`:201`) and the two-step restore
  (`:208`), and recorded why `gpg -d` must never be piped into `tar -x`. The close report's §10
  marker carried the same stale sentence and is corrected with this one.)* What remains is the real
  snapshot, which is the owner's: the passphrase, the archive that carries `ledger-mac-master.key`,
  and the physically separate medium. Precondition, from the drill's own text (*"while no session
  runs and the dogfood timer is not due"*): `ps -eo pid,args | grep '[h]elix-mcp\.mjs'` prints
  nothing (every Claude Code session closed — the one editing this sheet included; `pgrep -af`
  over-counts by matching its own shell, see C1.1), `systemctl --user is-active
  helix-dogfood.service` prints `inactive`, and `list-timers` shows the next elapse hours away.
  Success: `~/backups/helix-<date>.tar.gz.gpg` exists, `gpg -d … | tar -tvzf -` lists
  `.helix/ledger-mac-master.key` with mode `-rw-------`, no plain `.tar.gz` anywhere, and the copy
  is on the separate medium. **Do not treat a plain-tar backup as discharging Q4.**

- [x] **A4. The in-window producer's §8 disposition — RULED, and it does not arise again in this
  window. Nothing is owed here.** *(Corrected 2026-08-17. This item read "the owner must RULE …
  owed and **not yet made**" until then, and that was false when written: the ruling was made
  2026-08-13 and its ledger entry was committed 2026-08-14 at `3bd63d0`, two days before `21b47b4`
  authored this paragraph.)*

  **What was ruled.** `scripts/close/adjudication-skeleton.ts` was written 2026-08-13 inside the
  FIRST window. The owner ruled **RESET**, and the reset was executed: the window ended, a new
  candidate `94dd136` was cut, and the re-freeze put the producer INSIDE that candidate and pinned
  it as the 26th entry of `payload.tools`. The ruling and its grounds are recorded in
  `docs/release/v2-freeze-deviations-2026-08.md` (`D-2026-08-13-in-window-tooling`) and in report
  §4.6; report §4.6 carries **zero** markers.

  **Why no second-window instance exists.** §8 reaches tooling built AFTER the freeze it governs.
  This window's freeze is `3bd63d0` and its candidate already contains the producer and its test
  (`git ls-tree -r --name-only 94dd136 -- scripts/close test/close` → 2 files), so no post-freeze
  build occurred inside it. The question is answered, not deferred, and there is nothing for the
  owner to rule before publication.

  **What C8 must therefore check** is not a ruling. The producer is a pinned path, and step 0.5
  does compare it against its candidate blob — but 0.5 hashes the DEVELOPMENT tree and reaches only
  17 of the 26 `payload.tools` paths, so it says nothing about the checkout C8 now runs in. C8
  therefore carries its own preflight over the checkout. See C8.

---

## Block B — Step 0: the tree the chain runs from

> The close chain runs from a **clean checkout of the candidate commit**, never from the
> development tree (`v2-close-procedure-2026-08.md`, "The rule").

That is the procedure doc's rule, quoted. It holds for every step that **measures** anything and
cannot hold for one pre-chain check whose input cannot exist at the candidate commit — read "Which
tree runs what" (after this block) before running anything, and never restate the rule without its
exception. The report's §2.3 carries the scoped version.

This is not ceremony — but the reason it is not has CHANGED, and the change removed a guard rather
than the need for one. Read both measurements; the second is the one that governs today.

**As measured at HEAD on 2026-08-13** (first window, retained as dated fact): the development tree
diverged from the pins —
`src/memory/{ownership,retrieval,store,verified-projection,witness-core,witness-store}.ts` (6 of the
9 pinned memory modules) and `docs/release/gate-decision-2026-07-22.md` all differed from the
candidate blob. `scripts/pilot/input-pins.ts` re-hashes `process.cwd()`, so invoked in this tree it
refused **`method-drift`** (exit 1) — correctly, by its own contract. That refusal was, in effect,
a fail-closed guard against running the chain from the wrong tree.

**As measured on 2026-08-17** (second window): the re-freeze re-pinned all seven of those paths at
their current bytes. `git diff --name-only 94dd136 HEAD` listed 12 changed paths and its
intersection with the 28 pinned paths was **empty**. So `input-pins.ts` invoked in the development
tree would **NOT** have refused that day — it would have proceeded, and produced an artifact
indistinguishable from one produced in the checkout.

**RE-MEASURED 2026-08-25, and the conclusion above INVERTS. This paragraph, not the one above, is
the operative state.** `git diff --name-only 94dd136 HEAD` now lists 103 changed paths and the
intersection with the 28 pins is **NOT empty**: it is `src/memory/ownership.ts` and
`src/memory/store.ts`, both members of `payload.tools`. Four in-window commits moved them —
`7c22bfc`, `c3456ec`, `08bc3da` (all 2026-08-18) and `95c65e7` (2026-08-20) — and that drift is
adjudicated NOT A RESET at `R-2026-08-18` in the deviations ledger, so it is a known state and not
a new finding. What changes here is only the prediction: `input-pins.ts` re-hashes
`PINNED_TOOL_PATHS` under `process.cwd()` (`input-pins.ts:290`, `hashTools(process.cwd())`), and
two of those paths now differ in the development tree, **so invoked there it WOULD refuse
`method-drift` today.**

**The consequence, restated: the mechanical protection is back, but only by accident, and it must
not be leant on.** It exists because two pinned files happen to have drifted, not because anything
guarantees they will still differ on close day; a revert, a merge, or a checkout removes it
silently. Treat the rule as enforced by the operator, and read a `method-drift` refusal in the
development tree as the expected consequence of that known drift rather than as an integrity
finding. C8 therefore carries an inline
fail-closed preflight that asserts the execution tree directly rather than inferring it from
content drift — content identity and tree identity are different properties, and only the second
is what "run from the candidate checkout" asserts. *(This paragraph stated the 08-13 divergence
alone until 2026-08-17 and so promised a refusal that can no longer fire.)*

- [ ] **0.1 Capture the terminal transcript — FIRST, before any other command.** The report's §6
  execution log and §11 refusal record are sourced from this file, and nothing else captures one.
  The report's §6 marker asks for the commands "from checkout creation through the release record",
  so the capture has to be running before 0.2 creates the checkout; started later it cannot carry
  what it is cited for.

  ```bash
  mkdir -p ~/close-run && script -f ~/close-run/close-day-transcript.log
  ```

  *(rehearsed 2026-08-13)* → `script -q -f -c 'echo hello-from-transcript' <log>` exit 0; the log
  carried `Script started on …`, the command output, and `Script done on … [COMMAND_EXIT_CODE="0"]`.

  **`script` spawns a NEW shell, and this is the shell every later step means.** Nothing exported in
  the shell you started from crosses into it, which is why 0.3 binds `$TSX` *inside* here and R3
  tells you to re-print it at the top of any further shell. Run every remaining block in this shell;
  `exit` closes the transcript. The transcript is a **verbatim capture**, which is why §6 may cite it
  while §13 still says nothing was reconstructed from memory — record that distinction in the report.

  **Where it ends: step H7, and nowhere earlier.** The capture stays open through Blocks C–H6, and
  H7 is the step that types `exit` and hashes the finished file from the outer shell. Report §6 asks
  for the transcript's path *and* its sha256, and that hash cannot be taken from inside the capture —
  H7 records the measurement showing why. Do not close the transcript before H7 and do not try to
  hash it in place.

- [ ] **0.2 Materialise the candidate checkout, outside the working tree.**

  ```bash
  cd ~/dev/helix
  git worktree add --detach ~/close-candidate $CANDIDATE
  git -C ~/close-candidate rev-parse HEAD
  git -C ~/close-candidate status --porcelain
  ```

  *(rehearsed 2026-08-13 against the FIRST candidate, into a scratch path)* → `Preparing worktree
  (detached HEAD 27b4373)`; `rev-parse` printed that sha; `status --porcelain` printed **nothing**
  (clean). **That output is void — it names the void candidate.** The command now takes
  `$CANDIDATE` from the loader block at the top, so it needs no edit between windows; re-run it and
  paste the real output. Expect `HEAD is now at 94dd136 docs(freeze): void the first window inside
  the pinned decision record`.

  Success: HEAD equals the candidate and `status --porcelain` is empty.
  Refusal: any output from `status --porcelain` → stop; the checkout is not the candidate and every
  hash derived from it is worthless.

- [ ] **0.3 Install dependencies in the checkout, then fix the interpreter.** A fresh worktree has
  **no `node_modules`** (verified: the rehearsed checkout listed `bin data docs hooks scripts src
  test package.json …` and nothing else).

  ```bash
  cd ~/close-candidate && npm ci
  ```

  Success: exit 0. Refusal: a failing `npm ci` — do **not** work around it by running the pilot
  tools from `~/dev/helix`; that is the one thing Step 0 exists to prevent.

  **`npm ci` here DOES give you `tsx`, and that is a change from the first window.** Under the
  first candidate `tsx` post-dated the freeze, so the checkout had none and `$TSX` had to be bound
  to the development tree's copy. The second candidate carries `tsx@4.23.5` as a devDependency
  (`git show 94dd136:package.json` → `devDependencies.tsx` = `4.23.5`; the lockfile pins it), so the
  interpreter is now inside the measured commit rather than borrowed from beside it. **Bind `$TSX`
  to the CHECKOUT's copy**, which is strictly better provenance — the interpreter that ran the
  measurement is then itself named by the candidate:

  ```bash
  export TSX=~/close-candidate/node_modules/.bin/tsx
  $TSX --version && node --version
  ```

  *(UNREHEARSED against the checkout — the 2026-08-13 rehearsal bound the dev-tree copy, which was
  the only option then. The dev tree's pinned binary printed `tsx v4.23.5` / `node v24.17.0` on
  2026-08-14 and the checkout installs the same pinned version, so the expected output is that pair
  — but it is expected, not observed, and must be pasted from the real run.)*
  **Record both lines in the report: they are the close-day interpreter** — report §2.3 carries a
  marker for exactly this pair. Every `$TSX` below is this binary. Do not substitute `npx tsx`:
  there is no global `tsx` on this box (`which tsx` → empty), so `npx` would resolve an **unpinned**
  version from its cache or the network — an unrecorded interpreter on the one day the interpreter
  is provenance, and a hard failure if the box is offline. The interpreter's location does not
  affect which method bytes run — see R1 below.

  **`export`, not a bare assignment, and run it inside 0.1's transcript shell.** A plain `TSX=…` is
  not inherited by any child shell, and `script` starts one: assign it outside the transcript and
  every chain command inside runs with `$TSX` empty. *(measured 2026-08-13:
  `TSX=…; script -q -f -c 'echo "TSX=[$TSX]"; $TSX --version' log` wrote `TSX=[]` and
  `bash: line 1: --version: command not found` into the log; with `export` the same line printed the
  path and `tsx v4.23.5` / `node v24.17.0`.)*

- [ ] **0.4 Confirm the anchor set is intact before anything is measured — from `~/dev/helix`.**
  **The first window's reason for this was wrong and the corrected one is stronger.** It used to say
  the script and its npm entry post-dated the candidate; both are now IN the candidate
  (`git cat-file -e 94dd136:scripts/freeze-guard.ts` succeeds; the scripts block is `build`, `test`,
  `test:watch`, `typecheck`, `freeze-guard`, `scan:history`). The step still cannot run from the
  checkout, for a reason no re-freeze can remove: **the guard reads the freeze receipt, and the
  receipt is issued AGAINST the candidate, so it lives in a later commit and can never be inside
  the tree the chain checks out.** The entrypoint also hard-codes
  `join(process.cwd(), 'docs/release/v2-freeze-receipt-2026-08.json')` and **ignores `argv`**
  (`freeze-guard.ts:109-110`) — so passing a path after `--` does nothing, and a run inside the
  checkout fails to find its receipt rather than checking anything.
  The development tree is the correct **and only possible** host, and it is sound: the guard
  re-hashes every pin from the **candidate commit's blobs** (`git ls-tree` / `git show`,
  freeze-guard.ts:78-86), never from the tree it happens to run in. Expect WARN-only worktree-
  divergence lines here whenever the dev tree has moved past the candidate; they are informational
  before `txClose` by design, and the HARD check is the anchor comparison.

  ```bash
  cd ~/dev/helix && npm run freeze-guard; echo "exit=$?"
  ```

  *(rehearsed 2026-08-13)* → 7 `::warning::worktree diverges from pin (pre-close, informational):`
  lines — `src/memory/{retrieval,store,ownership,verified-projection,witness-store,witness-core}.ts`
  and `docs/release/gate-decision-2026-07-22.md` — then
  `note: out of scope (deploy-machine state): payload.config sha256, payload.runtime identity`,
  then `freeze-guard: anchors verified`, `exit=0`.

  **Expect ZERO warnings today, and for a reason that is NOT the txClose guard.** *(Corrected
  2026-08-17.)* The 7 warnings above were the FIRST window's; the re-freeze re-pinned all seven
  paths at their current bytes, so the worktree-divergence loop found nothing to warn about —
  measured 2026-08-17, the intersection of the changed set with the 28 pins was empty.
  **CORRECTED 2026-08-25: that intersection is no longer empty** (`src/memory/ownership.ts`,
  `src/memory/store.ts` — see Block B), so **expect TWO worktree-divergence warnings here, not
  zero.** Those two are the known, adjudicated drift; a third is a finding. Their absence
  before `txClose` therefore no longer says the tree matches the pins. Their absence
  AFTER `txClose` says only that the loop is guarded by `if (now <= p.txClose)`
  (freeze-guard.ts:90) and says nothing about the tree. **On close day you are past `txClose`, so
  read no reassurance from a quiet run**; the pre-close readings are where that evidence lives.
  Note also that this loop's findings go to `warnings` and are excluded from `ok`, so
  `npm run freeze-guard` exits 0 on a drifted pin either way — it is the ANCHOR loop, not this one,
  that hard-fails.

  Success: exit 0 with a final `freeze-guard: anchors verified`.
  Refusal: any `anchor:` / `pin-omitted:` / `payload-sha256:` line, or a final
  `freeze-guard: ANCHOR FAILURE`, is HARD — the anchor set itself is broken and no checkout rescues
  it (`v2-close-procedure-2026-08.md`, "What would invalidate this procedure"). Stop and escalate;
  do not proceed to Block C.

- [ ] **0.5 Measure the dev-tree exception before relying on it** (see "Which tree runs what"
  below). One program in this run-sheet must run from `~/dev/helix` — the pre-chain `freeze-guard`
  check, whose input cannot exist at the candidate. That is safe only while every **pinned** module
  it reaches is byte-identical to the candidate's. Measure it; do not assume it. Keep running this
  step even though the exception shrank: it is also what catches the development tree drifting away
  from the candidate under you mid-close, which is a finding about the whole chain.

  **THE LOOP BELOW DOES NOT ESTABLISH THAT CLAIM, and as of 2026-08-25 the claim is false.**
  *(Correction 2026-08-25. The loop is left exactly as it was — rewriting it to follow imports would
  be authoring close-day tooling inside the window, which is the act that reset the first one. What
  is corrected is the sentence it was licensing.)* The loop walks `scripts/pilot`, `scripts/close`
  and `src/entry-point.ts`. It never reaches `src/memory`. But `freeze-guard.ts:26` imports
  `PINNED_TOOL_PATHS` and friends from `./pilot/pin-hashes.js`, and `pin-hashes.ts:22` imports
  `projectLedgerPath` from `../../src/memory/ownership.js`, which it calls at `:296`. That module is
  **pinned**, and measured today it **differs from the candidate**:

  | pinned module reached by `freeze-guard` | blob at `94dd136` | blob in `~/dev/helix` |
  |---|---|---|
  | `src/memory/ownership.ts` | `8906b3f2111d` | `6b07743b31e8` |

  (`src/memory/store.ts` is pinned and also differs — `89219c6b3a75` vs `f96aa9e95560` — but
  `freeze-guard` does not reach it, so it is not part of this step's question.) Both are the
  in-window drift adjudicated NOT A RESET at `R-2026-08-18`; neither is a new finding. **What is
  new is only that this step's success line cannot be read as the licence it claims to be.**

  So: run the loop for what it does cover, and read `byte-identity check done` as covering the
  script directories and the entry point ONLY. Do not read it as "every pinned module `freeze-guard`
  reaches is candidate-identical" — that sentence is false today, and the exception now rests on the
  narrower ground that `ownership.ts`'s drift is known, recorded and confined to a path-resolution
  helper the guard calls once.

  ```bash
  cd ~/dev/helix
  for f in $(git ls-tree -r --name-only $CANDIDATE -- scripts/pilot scripts/close) src/entry-point.ts; do
    a=$(git rev-parse $CANDIDATE:$f); b=$(git hash-object $f 2>/dev/null)
    [ "$a" = "$b" ] || echo "DIFFERS $f"
  done; echo "byte-identity check done"
  ```

  *(rehearsed 2026-08-13 against the FIRST candidate, before `scripts/close` was in scope)* → no
  `DIFFERS` line, then `byte-identity check done`. **Re-run it: the loop now reads `$CANDIDATE`
  rather than a literal sha, and walks `scripts/close` as well, so the 2026-08-13 output does not
  cover what it now checks.**
  **17 here versus the "sixteen pilot tools" the freeze pins is not a discrepancy.** The loop walks
  everything `git ls-tree` reports under `scripts/pilot` at the candidate — 17 files — while
  `PINNED_TOOL_PATHS` names 16 of them; the odd one out is `segment-oracle.ts`, which v2's
  ledger-only population never invokes. Checking a superset of the pinned list is deliberate: this
  step is about what the dev-tree helpers might *reach*, not about what the receipt pins.
  Success: no `DIFFERS` line. Refusal: **any** `DIFFERS` line — stop, and diagnose before Blocks
  D–F edit the repository; a pinned path that moved in the development tree is a finding about the
  chain whatever else is true. *(Corrected 2026-08-17: this line used to continue "…and C8's
  producer must not be run until the divergence is understood." That coupling was the first
  window's, when C8 loaded its modules from this tree. C8 now runs in the candidate checkout behind
  its own preflight, so a `DIFFERS` line here is not a verdict on C8. Do not reinstate the coupling
  — and note the paragraph below, which says the same thing 20 lines later.)* **Paste this output
  into the report**: it is what makes the remaining 0.4 exception defensible rather than convenient.

  **Run this check TWICE and paste both readings — here, and again immediately before C8.** The
  licence it issues is point-in-time, not standing: `~/dev/helix` is written by a second clone, and
  during the 2026-08-13 rehearsal alone the tree advanced five commits (`c744266`, `5320bb4`,
  `c843e77`, `f8e2bf0`, `a8f07b7`) from another session while the sheet was being written, with
  three matching clone drifts in `~/.cache/freeze-guard-heals.log`.

  **What the second reading is FOR has changed, and the C8 framing is retained only as a
  convenient point in the sequence.** *(Corrected 2026-08-17.)* It used to be C8's licence: under
  the first window C8 loaded its modules out of `~/dev/helix` — `../../src/entry-point.js` and
  `../pilot/artifact-io.js`, both covered by 0.5's loop; it imports nothing from `src/memory` —
  so "a reading taken at the top of
  Block B says nothing about the bytes C8 will actually load hours later" was the whole argument.
  C8 now runs from the candidate checkout, whose bytes are fixed by the commit and asserted
  directly by C8's own preflight, so **the second reading no longer licenses C8**. It survives for
  its other stated purpose — catching the development tree drifting away from the candidate
  mid-close, which is a finding about the whole chain and about 0.4's dev-tree invocation — and
  "immediately before C8" is kept as a defined, roughly mid-run point rather than renumbering the
  sheet. A second reading that DIFFERS from the first is therefore no longer a reason to skip C8;
  it is a finding to record, and to diagnose before Blocks D–F edit the repository.

- [ ] **0.6 THE WRITE FREEZE — stop the dogfood timer BEFORE the close instant.**
  *(close day, before `2026-09-11T06:20:01.000Z` = 15:20:01 KST)*

  > **INVARIANT: after `2026-09-11T06:20:01.000Z` no process may write either ledger until C1.2 has
  > finished copying them. A single later row is an unrecoverable `snapshot-after-close`.**

  `prepare-gate` refuses on any row with `tx > txClose` (prepare-gate.ts:274-278) and the snapshot
  is a *copy* of the live append-only ledgers, so no re-run yields a clean one — and the refusal
  surfaces at C5, after the manifest (C2) and classifier (C3) have already been produced against a
  corpus that was never eligible. This is the one step of the close whose failure cannot be undone.

  The live writer is the daily dogfood run, and it has a **catch-up** path: the timer is
  `OnCalendar=*-*-* 09:00:00 Asia/Seoul` with `Persistent=true`, so a missed firing runs whenever
  the timer next becomes active — measured 2026-08-13, `LAST` was 11:48:03 KST, not 09:00. Stopping
  is therefore not enough; **mask**, so nothing can activate it.

  **The mask has to be typed from a session that is ALREADY UP, and that — not forgetting the
  command — is this step's real failure mode.** *(Added 2026-08-25.)* The catch-up fires when the
  user session becomes active, and on this box that is boot: today's run started 21:18:12 KST
  against a boot at 21:18:41, so the interval between power-on and the ledger write is seconds.
  Sixteen consecutive daily firings, 2026-08-10 through 2026-08-25, read from `journalctl --user -u
  helix-dogfood.service`, land like this against the close instant of 15:20:01 KST: **none of the
  sixteen fired at the nominal 09:00**, and **ten of the sixteen fired after 15:20:01** — 08-10
  20:43, 08-11 23:07, 08-12 20:58, 08-15 20:01, 08-18 19:18, 08-19 20:54, 08-20 20:59, 08-21 20:15,
  08-23 20:33, 08-25 21:18. If the box is first booted on close day after 15:20:01 KST, the pending
  catch-up writes the unrecoverable row before any command can be typed, and nothing in this step
  reaches it.

  > **PRECONDITION: boot the box BEFORE `2026-09-11T06:20:01.000Z` = 15:20:01 KST, and run 0.6 in
  > that same session.** A firing that lands before the close instant is a row inside the window and
  > is harmless; the mask then holds the post-close silence.

  Set that alarm outside this repository — nothing here can wake a machine that is off. *(The one
  measurement this step used to cite, `LAST` 11:48:03 KST on 2026-08-13, is one of the six that
  happened to land early. It is not the distribution, and it read as reassurance.)*

  ```bash
  systemctl --user stop helix-dogfood.timer helix-dogfood.service
  systemctl --user mask helix-dogfood.timer helix-dogfood.service
  systemctl --user is-enabled helix-dogfood.timer helix-dogfood.service
  systemctl --user list-timers --all | grep helix-dogfood || echo "no helix-dogfood timer scheduled"
  ```

  Success: `is-enabled` prints `masked` twice and the `list-timers` grep finds nothing.
  *(unit names verified 2026-08-13 — `systemctl --user list-timers --all` shows
  `helix-dogfood.timer` → `helix-dogfood.service`, NEXT `Fri 2026-08-14 09:00:00 KST`, and
  `list-unit-files` shows `helix-dogfood.timer enabled` / `helix-dogfood.service static`.)*

  > ### REHEARSED 2026-08-25 — THE BLOCK ABOVE DOES NOT WORK. Use the corrected one below.
  >
  > The block above is left byte-identical because what it does is a finding. It was rehearsed on
  > 2026-08-25 — safely, because the day's run had already fired and the next elapse was the
  > following 09:00, so no run could be suppressed — and **`mask` failed**:
  >
  > ```
  > Failed to mask unit: File ~/.config/systemd/user/helix-dogfood.timer already exists.
  > exit=1
  > ```
  >
  > *(rendered with `~`; the real message prints the path absolutely, which
  > `test/output-vocabulary.test.ts` reserves to the receipt.)* Both unit fragments live in
  > `~/.config/systemd/user/`, which is exactly where `systemctl --user mask` wants to put its
  > `/dev/null` symlink, and systemd will not overwrite a regular file. **`--force` would, by
  > destroying the unit file — do not use it.**
  >
  > **What is left after the failure is the danger.** `stop` exits 0, so the timer stops and
  > `list-timers` shows no NEXT — which reads like success. But the unit is still `enabled`, so
  > `timers.target` re-activates it at the next boot and `Persistent=yes` fires the missed run
  > immediately. That is the `snapshot-after-close` row, arriving with no keystroke.
  >
  > **`mask --runtime` is a TRAP and was measured to be one.** It exits 0 and prints
  > `Created symlink /run/user/<uid>/systemd/user/helix-dogfood.timer → /dev/null`, so it looks
  > like it worked. It does not: `systemd-analyze --user unit-paths` puts
  > `~/.config/systemd/user` ABOVE `/run/user/<uid>/systemd/user`, so the real fragment shadows the
  > mask. Measured after it: `LoadState=loaded`, `FragmentPath` still the real file, and a
  > `systemctl --user start helix-dogfood.service` **went straight through and launched a live
  > autonomous run** (2026-08-25T22:38:13+09:00, killed at 22:41:39 before it wrote; recorded in
  > `v2-freeze-deviations-2026-08.md`). A daemon-reload does not rescue it — the path order does not
  > change.

  **THE CORRECTED BLOCK — rehearsed end to end 2026-08-25, and reversed cleanly.** It masks from
  `~/.config/systemd/user.control/`, the HIGHEST-priority entry in the user unit path, so the real
  fragments are shadowed rather than replaced and both unit files survive byte-identical.

  ```bash
  systemctl --user stop helix-dogfood.timer helix-dogfood.service
  mkdir -p ~/.config/systemd/user.control
  ln -sfn /dev/null ~/.config/systemd/user.control/helix-dogfood.timer
  ln -sfn /dev/null ~/.config/systemd/user.control/helix-dogfood.service
  systemctl --user daemon-reload
  systemctl --user is-enabled helix-dogfood.timer helix-dogfood.service
  systemctl --user list-timers --all | grep helix-dogfood || echo "no helix-dogfood timer scheduled"
  ```

  Success, and it is the SAME criterion the original block stated: `is-enabled` prints `masked`
  twice and the `list-timers` grep finds nothing. *(Observed 2026-08-25: `masked` / `masked`, then
  `no helix-dogfood timer scheduled`. `LoadState=masked` and `FragmentPath` pointing into
  `user.control` for both units. The two fragments in `~/.config/systemd/user/` hashed identically
  before and after.)*

  **`disable` is deliberately NOT in the block, and that is measured rather than assumed.** While
  masked, every activation route is refused — `systemctl --user enable helix-dogfood.timer` →
  *"Failed to enable unit: Unit file … is masked"*; `start` on the timer → *"Unit
  helix-dogfood.timer is masked"*; `start` on the service → *"Unit helix-dogfood.service is
  masked"*. So the mask alone closes the boot path, the timer path and the hand path, and it
  survives a reboot because `user.control` is a config directory rather than a runtime one. Adding
  `disable` would only create a second piece of state for G6 to remember to restore, and forgetting
  it is the silent permanent change G6 warns about.

  Mask **both** units, not only the timer: the service is `static` but still reachable by hand and
  by `systemctl --user start`, and masking the timer alone leaves that door open.

  - [ ] The other writer is **you**. Close every Claude Code session (C1.1) — one `helix_memory_*`
    commit from a live session appends a post-close row exactly as the timer would.
  - [ ] After the mask an interactive shell prints a dogfood-watch banner saying the timer is not
    enabled (`scripts/dogfood-watch.sh:38`). That is this step working, not a fault.
  - [ ] **Unmask in Block G6.** The mask is a freeze control like any other, and the close is not
    finished while it stands.

  Take the snapshot (C1.2) **at or after** the close instant, and before anything else runs.

- [ ] **0.7 Cleanup (only after Block H is finished — the checkout is evidence until then).**

  ```bash
  git -C ~/close-candidate status --porcelain          # expect empty; anything listed explains the next line
  cd ~/dev/helix && git worktree remove ~/close-candidate && git worktree prune
  ```

  *(rehearsed 2026-08-13, on a scratch checkout at the FIRST candidate: `worktree add --detach` →
  `HEAD is now at 27b4373`, `status --porcelain` empty; `worktree remove` + `prune` returned it
  cleanly. The mechanism is candidate-independent, so this rehearsal still covers the STEP; only
  the sha in its output is stale.)*

  **A `fatal:` here is anticipated, not alarming.** `git worktree remove` refuses a checkout holding
  modified or untracked files: *(measured 2026-08-13, by touching one file in a scratch checkout)*
  → `fatal: '<path>' contains modified or untracked files, use --force to delete it`, **exit 128**.
  The `status --porcelain` line above names what it found — `node_modules/` is not it, that is
  gitignored and invisible to both commands. If the listing is only debris you recognise (a stray
  probe file, an artifact written into the checkout by mistake), finish with:

  ```bash
  cd ~/dev/helix && git worktree remove --force ~/close-candidate && git worktree prune
  ```

  *(measured: `--force` returned exit 0 on the same refusing checkout.)* If the listing is a
  **modified tracked file**, do not force it away — copy the diff into the report first. It means
  the tree that produced the measurement was not the tree 0.2 verified clean, which is a finding
  about the whole chain and not a cleanup problem.

---

## Which tree runs what — READ THIS ONCE, THEN OBEY IT AT EVERY STEP

The procedure doc's rule ("the chain runs from a clean checkout of the candidate commit") is right
about the **measurement** and silent about the **helpers**. One step this run-sheet invokes reads an
input that cannot exist in the checkout — the freeze receipt, which is issued against the candidate
and therefore lives in a later commit — so "everything runs from the checkout" is not a rule that
can be obeyed without qualification. The rule that actually holds has four parts, and every command
below is tagged with the one that applies. *(Under the first window this paragraph said TWO
programs, both because they post-dated the candidate. The second freeze moved one of them into the
candidate and showed the other's real reason was different; see R2.)*

**R1 — the pinned pilot tools: the CHECKOUT's file, with `cd ~/close-candidate`.**
`generate-manifest`, `classify-o67`, `input-pins`, `prepare-gate`, `ordering-receipt`, `run-pilot`,
`score-gate`, `release-record`. Two independent reasons, and both must hold:

- *The script FILE decides which method bytes execute.* Each imports `../../src/memory/…` by a
  module-relative specifier, so `~/close-candidate/scripts/pilot/<tool>.ts` loads
  `~/close-candidate/src/memory/…` — the candidate's bytes — whatever the cwd is and whichever
  `tsx` drives it. *(rehearsed 2026-08-13: a probe placed in the checkout printed
  `resolves to: …/close-candidate/src/memory/expansion.ts` and `expansion available: true` both
  when run with cwd = the checkout and when run with cwd = `~/dev/helix` via an absolute script
  path; the probe was removed and `git status --porcelain` was empty again.)* *(Corrected
  2026-08-17: this passage continued "The development tree's `src/memory` diverges from the pins on
  6 files, so its copies would measure a method the receipt does not describe." That was the FIRST
  window's state. The re-freeze re-pinned those files at their current bytes and the divergence is
  now zero — so the rule below stands on the FILE-decides-the-bytes property alone, which is
  structural, and not on a divergence that would make a wrong-tree run visible. Run from the
  checkout because the rule says so, not because you expect a refusal.)* This is also why R3's
  dev-tree interpreter is harmless: `$TSX` chooses
  nothing about module resolution.
  *(Corrected 2026-08-27: "the divergence is now zero" was true at the re-freeze and has been false
  since 2026-08-18 — measured 2026-08-27, pin ∩ (candidate → HEAD) = `src/memory/ownership.ts`,
  `src/memory/store.ts`, both adjudicated (`R-2026-08-19`, `D-2026-08-22`; Block B's 2026-08-25
  paragraph). The rule stands on the FILE-decides-the-bytes property regardless; what the drift
  changes is that a wrong-tree run of any tool importing either module would today load different
  bytes — and nothing in this rule detects that, so the instruction is the only protection.)*
- *The CWD decides what `input-pins` hashes.* `input-pins.ts:290-291` calls
  `hashTools(process.cwd())` and `hashMethodDocs(process.cwd())`, so the cwd decides which bytes
  become the pins of record. **It refuses `method-drift` only when those bytes DIFFER from the
  receipt** — and measured 2026-08-17 they do not differ in the development tree either, so today
  the wrong cwd produces a wrong-provenance artifact SILENTLY rather than a refusal. *(Corrected
  2026-08-17: this bullet read "Run it anywhere else and it refuses `method-drift` — correctly, by
  its own contract." The contract is unchanged; what changed is that the condition triggering it no
  longer holds.)* *(Re-measured 2026-08-25 and 2026-08-27: they DO differ again — the two files named
  in Block B — so today the wrong cwd would refuse `method-drift`; C4 records the refusal as observed
  and says why that protection is accidental and must not be leant on.)*

**R2 — the one step whose INPUT cannot exist in the checkout: the DEV TREE, with `cd ~/dev/helix`.**
Exactly one: `npm run freeze-guard` (step 0.4). It reads the freeze receipt, and a freeze receipt is
issued against the candidate — so it is created in a later commit and is **never** present at the
candidate. `git cat-file -e 94dd136:docs/release/v2-freeze-receipt-2026-08.json` → absent;
`git cat-file -e 3bd63d0:…` → present. The entrypoint hard-codes the receipt path relative to
`process.cwd()` and ignores `argv` (`freeze-guard.ts:109-110`), so there is no override to reach
past it either. **Do not copy the receipt into the checkout**: an untracked file there breaks step
0.2's `git status --porcelain` = empty, which is the evidence the report cites. The exception is
safe because the guard reads the tree it runs in for nothing measured — it anchors on the candidate
commit's blobs — and because **step 0.5 measures** that every pinned module it imports is
byte-identical to the candidate's. Step 0.5's output is the licence for this rule; run it, and
paste it into the report. *(Corrected 2026-08-27: 0.5 does not walk `src/memory`, and
`src/memory/ownership.ts`, which the guard reaches through `pin-hashes.ts:22`, differs from its pin
in this window — see 0.5's 2026-08-25 correction and H5. The exception rests on the guard re-hashing
the candidate's own blobs through git and on that drift being adjudicated at `R-2026-08-19`; 0.5's
output is evidence of what it does cover, not the licence.)*

*(Under the first window R2 covered two steps. The adjudication skeleton (C8) left it when the
re-freeze put `scripts/close/` inside the candidate, and it now runs under **R1** with the rest of
the chain. The freeze-guard step did not leave, and re-examining it showed the first window's
diagnosis — "the script post-dates the candidate" — was the wrong one: it implied a re-cut candidate
would dissolve the exception, and a re-cut candidate did not.)*

**R3 — the interpreter is `$TSX`, never `npx tsx`** (step 0.3), fixed once and recorded in the
report. `tsx` is not part of the pinned surface, but *which interpreter ran the measurement* is
close-day provenance, and an unpinned `npx` resolution answers that question with a shrug.
`$TSX` must be set in the **same shell** as every chain command — the 0.1 transcript shell — and it
must be `export`ed there (0.3), because `script` spawns a fresh shell that inherits nothing else.
An unset `$TSX` has **two different signatures**, and neither names the real cause:

- `$TSX scripts/pilot/<tool>.ts` → the `.ts` file is executed directly:
  `Permission denied`, **exit 126**.
- `$TSX --version` — the re-check line this rule prescribes → `--version` is run as a command:
  `bash: line N: --version: command not found`, **exit 127**.

*(both measured 2026-08-13.)* Re-run `$TSX --version` at the top of any new shell and read the
version, not just the exit code: exit 127 with no version line means the binding did not cross.

**R4 — anything that crosses the boundary is named by an ABSOLUTE path.** Artifacts are written
under `~/close-run/` so the checkout stays clean, and **any file that post-dates the candidate is
addressed absolutely, never checkout-relative** — the freeze receipt in C4 is the case that bites.

| step | runs from | rule |
|---|---|---|
| 0.1 transcript | anywhere | cwd-independent; **every row below runs inside its shell — except H7, which closes that shell and then hashes the finished log from outside it** |
| 0.2, 0.5 | `~/dev/helix` | git plumbing over the candidate commit |
| 0.3 | `~/close-candidate` | installs the checkout's deps, `tsx` among them; **`export TSX=` belongs here, bound to the CHECKOUT's copy** |
| 0.4 freeze-guard | `~/dev/helix` | **R2** — its INPUT, the receipt, cannot exist at the candidate |
| 0.6 write freeze | anywhere | cwd-independent |
| 0.7 cleanup | `~/dev/helix` | `git worktree` acts from the main tree |
| C1 snapshot (`cp`, `python3`) | anywhere | cwd-independent; all paths absolute |
| C2–C8, C9, C9b, C10 | `~/close-candidate` | **R1** — C8 joined this row at the second freeze |
| C11 runtime pin | anywhere | reads the deployment, not a tree; the candidate it compares against is read from the freeze receipt by ABSOLUTE path (**R4**) |
| D1, D2, Blocks E–H6 | `~/dev/helix` | they edit and test the repository |
| H7 transcript close | anywhere | cwd-independent; the one step that must NOT run inside 0.1's shell |

**Where the report carries this.** §2.3 and H5 must NOT claim the whole chain ran from the candidate
checkout. **ONE step does not, by necessity** — and naming it precisely is the point, because
forcing the count to zero would be as false as leaving it at two. The honest claim is "every chain
step that runs a pinned tool (C2–C8, C9, C9b, C10) ran from the candidate checkout; the ONE
pre-chain helper — `npm run freeze-guard` (0.4) — ran from the development tree, because the
receipt it reads is issued AGAINST the candidate and so can never exist inside it". *(Phrased as
"runs a pinned tool", not "pinned measurement step": C8 belongs in this row because it executes a
pinned program, but it measures nothing — it stamps `UNJUDGED` and the pinned scorer refuses that
over a non-empty denominator. Calling it a measurement step would contradict §5 element 6.)* The report's §2.3 bullet that opens
**"Where the chain ran from"** is the one that must say this; if it and this section ever disagree,
this section is the one that is right. *(Corrected 2026-08-17. This paragraph said "two
post-candidate helpers" until then, which was the FIRST window's count: the re-freeze moved
`scripts/close/adjudication-skeleton.ts` into the candidate, so C8 now runs in the checkout with
the rest of the chain and only the structural freeze-guard exception remains — as the run-sheet
header at the top of this file already said.)* *(The report bullet above is named by its **heading
text**, never by position: §2.3 has five bullets and §4.6 thirteen bold-opening paragraphs
(measured 2026-08-17 — the older "four" was itself an ordinal that had rotted), and an ordinal
pointer silently rots the next time one is inserted. This pointer had already rotted once, naming
§2.3's third bullet, which is the runtime-pin one. **It named a §4.6 paragraph too until
2026-08-17**; that half was dropped, because §4.6's "Which tree it runs from" now records the
producer running in the CHECKOUT and is no longer the place that carries a dev-tree claim.)*

---

## Block C — the evidence chain (§9 order)

```
freeze receipt → close-bounded snapshot → manifest / classifier+universe
              → input pins → prepare → ordering → runner ×3 → adjudication
              → score → re-score → release record → runtime-pin observation
```

Each step completes and is hashed before the next begins. Nothing that reads a rank may run before
the prepare artifact exists and is hashed.

**Everything in Blocks C and D runs with `cd ~/close-candidate` EXCEPT the steps R2 and the tagged
lines name** — C11 (cwd-independent) and D1/D2 (dev tree). C8's producer was on this list under the
first window and no longer is: it is in the candidate now and runs under R1. Artifacts are written
under `~/close-run/` so the checkout stays clean.

### C1. The close-bounded snapshot — **BY HAND. There is no producer script.**

**UNREHEARSED.** `scripts/pilot/snapshot.ts` is a *reader*, not a builder (no `main()`, by design).
The snapshot is assembled by the operator per `pilot-protocol.md` §9b.

- [ ] **C1.1 Quiesce first.** Step 0.6 has already stopped and masked both dogfood units; confirm
  it (`systemctl --user is-enabled helix-dogfood.timer helix-dogfood.service` → `masked masked`).
  Then close every Claude Code session: an external copy is not covered by Helix's file lock, a
  copy taken mid-rewrite catches an inconsistent instant, and any `helix_memory_*` commit from a
  live session is itself a post-close write. **The 0.6 invariant governs from here to C1.2.**

- [ ] **C1.2 Copy both units, read-only, into the two-part layout.** The layout is not a convention
  this sheet invented — it is the one `snapshot.ts:61-64` reads (`home/memory.jsonl`,
  `proj/.helix/memory.jsonl`) and `pin-hashes.ts:110-115` pins the trust files at.

  ```bash
  mkdir -p ~/close-run/snapshot/home ~/close-run/snapshot/proj/.helix

  # The project unit's location is whatever projects.json says it is — read it, do not type it.
  # One line on purpose: a multi-line `python3 -c` string inside an indented block pastes its own
  # indentation into the program and dies on IndentationError.
  PROJ=$(python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.helix/projects.json')));ks=[k for k in d if k!='@global'];print(ks[0] if len(ks)==1 else 'AMBIGUOUS')")
  echo "project unit: $PROJ"

  cp ~/.helix/memory.jsonl ~/.helix/projects.json ~/.helix/witness.json \
     ~/.helix/ledger-mac-master.key ~/.helix/config.json ~/close-run/snapshot/home/
  cp "$PROJ"/.helix/memory.jsonl "$PROJ"/.helix/.owner "$PROJ"/.helix/config.json \
     ~/close-run/snapshot/proj/.helix/

  # Optional and currently ABSENT on this deployment — copy it only if it exists.
  [ -f ~/.helix/witness-log.jsonl ] && cp ~/.helix/witness-log.jsonl ~/close-run/snapshot/home/ \
    || echo "no ~/.helix/witness-log.jsonl — not a pinned file, absence is fine"

  find ~/close-run/snapshot -type f | sort
  ```

  *(rehearsed 2026-08-13 against a copy of the live home unit under a throwaway `HOME`, with the
  signing key stubbed so no key left `~/.helix`)* → `PROJ` resolved to the single registered project
  root, and `find` listed the eight files below. **If `PROJ` prints `AMBIGUOUS`** the registry holds
  more than one project: stop and decide by hand which unit the pilot measured — the freeze receipt
  pins one project ledger, not a set.

  The files that must land — eight on this deployment, nine if `witness-log.jsonl` has appeared by
  close day: `home/{memory.jsonl,projects.json,witness.json,ledger-mac-master.key,config.json}` and
  `proj/.helix/{memory.jsonl,.owner,config.json}`. **An earlier draft listed `witness-log.jsonl`
  among the required home files; it is not required and does not exist here** (`cp` of it fails
  `No such file or directory`, which is why the line above is guarded). The pinned trust set is only
  `projects.json`, `.owner`, `ledger-mac-master.key` and `witness.json` (`pin-hashes.ts:110-115`),
  and those pins accept a literal `absent` sentinel where the file is missing — so an absent optional
  file is a recorded state, not a broken snapshot. A missing **required** file is different: if any
  of the eight above fails to copy, stop.

  Copy, **never `ln`** — a hard-linked ledger is refused by every write path.

- [ ] **C1.3 THE TRAP: re-key `projects.json` to the snapshot project directory's `realpath`.**
  Ownership is keyed by the project root's **canonical realpath** since commit `e576ee4`
  (`ownership.canonicalRoot`, `src/memory/ownership.ts`). That commit is dated **2026-07-23**,
  three weeks *before* the freeze and before the candidate, and `git merge-base --is-ancestor
  e576ee4 $CANDIDATE` confirms it is an **ancestor of the candidate** *(re-measured 2026-08-14
  against `94dd136`: YES)* — so `canonicalRoot` is in the measured code, and
  `git show $CANDIDATE:src/memory/ownership.ts` shows it at `:12`, used at `:123`, `:164`
  and `:208`. *(An earlier draft called it a post-freeze commit. It is not, and the difference
  matters in the reader's direction: post-freeze would have meant the trap belonged to code the
  chain does not run, and therefore that this step could be skipped. It cannot.)* A snapshot copied
  to a new
  absolute path — or reached through a symlink — keeps the *old* key, the store then treats the
  project ledger as not-live, and **every project-scope query silently degrades to a global-only
  recall**. Rewrite the key only; preserve the stamp, the adoption time and the per-project signing
  nonce byte-for-byte.

  ```bash
  realpath ~/close-run/snapshot/proj      # this exact string must be the projects.json key
  python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/close-run/snapshot/home/projects.json')));print(list(d))"
  ```

  The copy carries the LIVE key, so this prints the wrong one — that is the trap, and the rewrite
  below is what closes it. **Paste it from column 0**, heredoc terminator and all:

```bash
SNAP_PROJ=$(realpath ~/close-run/snapshot/proj)
python3 - "$SNAP_PROJ" <<'PY'
import json, os, sys
p = os.path.expanduser('~/close-run/snapshot/home/projects.json')
new = sys.argv[1]
d = json.load(open(p))
keys = [k for k in d if k != '@global']
if len(keys) != 1:
    raise SystemExit(f'expected exactly one project key, found {keys!r} — rekey by hand')
d[new] = d.pop(keys[0])          # the VALUE moves whole: stamp, adoptedAt and macNonce are preserved
tmp = p + '.tmp'
json.dump(d, open(tmp, 'w'), indent=1)
os.replace(tmp, p)               # atomic: a crash mid-write leaves the original registry intact
print('rekeyed to:', new)
PY
```

  *(rehearsed 2026-08-13 against a copy of the live registry under a throwaway `HOME`)* → printed
  `rekeyed to: <the snapshot realpath>`; re-reading the file showed keys `['@global', <snapshot
  realpath>]` and the moved entry still carrying all three of `adoptedAt`, `macNonce`, `stamp`.
  **The three fields are moved, never regenerated**: `stamp` is the value `.owner` must equal
  (`ownership.ts:120-126`) and `macNonce` derives the ledger MAC subkey, so minting either one
  invalidates every signed verify row in the snapshot.

  Success: the key set contains the realpath printed above (plus the reserved `@global` entry).
  Refusal, and this is why it matters: the degradation is **silent at copy time** and surfaces
  three steps later as **`scope-did-not-participate`** (`scripts/pilot/candidate-universe.ts:137`,
  raised through `classify-o67`) or **`degraded-run`** (`prepare-gate.ts` / `run-pilot.ts`) — after
  the manifest is already generated. Verify the key before generating anything.

- [ ] **C1.4 Prove the rekey took, before anything is generated from the snapshot.** §9b's own
  acceptance was a one-probe recall (pre-rekey it returned **no** project records; post-rekey the
  target at rank 1 among 20). **No program in this repository runs that probe against a snapshot
  directory** — `snapshot.ts` is a reader with no `main()`, and the first tool that touches a
  snapshot is C3's classifier. Writing a prober on close day would be a second in-window program
  needing its own §8 disposition, which is a bad trade for a smoke test. So check the mechanical
  property the probe was testing for — ownership agreement, which is what decides whether the
  project scope participates at all (`ownership.ts:120-126`). **Paste from column 0:**

```bash
python3 - "$(realpath ~/close-run/snapshot/proj)" <<'PY'
import json, os, sys
root = sys.argv[1]
reg = json.load(open(os.path.expanduser('~/close-run/snapshot/home/projects.json')))
entry = reg.get(root)
owner = open(os.path.join(root, '.helix', '.owner')).read()
rows = sum(1 for _ in open(os.path.join(root, '.helix', 'memory.jsonl')))
print('registry entry for the snapshot root:', 'present' if entry else 'MISSING')
print('owner stamp == registry stamp:', bool(entry) and owner == entry['stamp'])
print('macNonce carried over:', bool(entry) and bool(entry.get('macNonce')))
print('project ledger rows in the snapshot:', rows)
PY
```

  *(rehearsed 2026-08-13 on the rehearsed snapshot)* → `present` / `True` / `True` / a non-zero row
  count. Success: all three plus rows > 0. Refusal: `MISSING`, or `False` on the stamp — C1.3 did not
  take; fix it now. Re-running the same check against the un-rekeyed registry printed
  `MISSING`, which is the state that becomes `scope-did-not-participate` at C3.

  **This is a necessary condition, not the full probe.** Recall is exercised for real at C3, whose
  `scope-did-not-participate` refusal (`candidate-universe.ts:136-140`) is the tooling-backed
  acceptance — it fires when the project ledger contributed rows to the recall bound but its
  disposition is not `owned`. C1.4 exists to catch that one step earlier, before C2 has generated a
  manifest against a corpus half of which cannot be served.

- [ ] **C1.5 Hash the snapshot** and record the value for §9a evidence element 2. There is no
  snapshot-wide hash tool, so the value is a defined composition rather than a mystery:

```bash
cd ~/close-run/snapshot && find . -type f | sort | xargs sha256sum | tee ~/close-run/snapshot-hashes.txt \
  | sha256sum | sed 's/-$/= the snapshot hash (sha256 over the sorted per-file sha256 listing)/'
```

  Record **both**: the per-file listing (it is what §9 element 2 is reconstructed from) and the
  single composed value. The report's element-2 bullet carries this alongside the `ledger:global` /
  `ledger:project` pins that C4's `input-pins` derives independently — the two are different
  measurements of the same directory and neither replaces the other. `snapshot-hashes.txt` is
  written OUTSIDE the snapshot directory on purpose: a listing written inside it would change what
  it is a listing of.

### C2. Manifest — ledger-only, both bounds required

**v2's population is structurally ledger-only**, so the manifest takes the holdout form and **no
oracle arguments**; a cutoff supplied together with an oracle side is refused by construction.

*(R1 — the checkout's script, `cd ~/close-candidate`, `$TSX` from step 0.3.)*

```bash
cd ~/close-candidate
$TSX scripts/pilot/generate-manifest.ts \
  --after $TX_AFTER --close $TX_CLOSE \
  ~/close-run/snapshot ~/close-run/manifest.json
```

- [ ] Both bounds come from the receipt (`txAfter` / `txClose` above), not from a keyboard. The
  window is `cutoff < tx ≤ close`: lower bound strict, upper bound inclusive.
- [ ] Success: the generator prints its probe counts and writes a manifest carrying **both**
  `txAfter` and `txClose`.
- [ ] Refusal: a non-canonical stamp (`YYYY-MM-DDTHH:MM:SS.sssZ` only) is refused rather than
  coerced; a close at or before the cutoff is refused rather than yielding an empty manifest
  indistinguishable from a starved window. If the manifest is **empty**, that is a result, not a
  failure — record it and do not re-run to obtain a different one.

### C3. Classifier + its `.universe.json` sibling

*(R1 — still `cd ~/close-candidate`.)*

```bash
$TSX scripts/pilot/classify-o67.ts \
  ~/close-run/manifest.json ~/close-run/snapshot ~/close-run/classifier.json
```

- [ ] Two files land: `classifier.json` and the **derived sibling** `classifier.universe.json`
  (`classify-o67.ts:114` derives it from `<out>`). Both are inputs to the next two steps.
- [ ] Refusal: `reserved-output-suffix` if `<out>` itself ends in `.universe.json` (it would let a
  later run overwrite this run's verdicts); `scope-did-not-participate` if C1.3 was skipped.

### C4. Input pins — the close-time half of the freeze receipt

*(R1 for the tool and the cwd; **R4 for the receipt path** — read the paragraph under the block
before you type it.)*

```bash
$TSX scripts/pilot/input-pins.ts \
  --freeze ~/dev/helix/docs/release/v2-freeze-receipt-2026-08.json \
  --manifest ~/close-run/manifest.json \
  --classifier ~/close-run/classifier.json \
  --universe ~/close-run/classifier.universe.json \
  --snapshot ~/close-run/snapshot \
  --out ~/close-run/pins.json
```

*(usage rehearsed 2026-08-13)* → `missing-input: --freeze is required` /
`usage: input-pins --freeze <path> --manifest <path> --classifier <path> --universe <path> --snapshot <path> --out <path>` /
`k and the window bounds are COPIED from the freeze receipt and cannot be supplied.`

- [ ] **`--freeze` is ABSOLUTE and points into `~/dev/helix`, on purpose.** The freeze receipt
  **does not exist in the checkout** and never can: it was issued against the preceding candidate
  and committed later, at `3bd63d0`, so `git ls-tree --name-only $CANDIDATE docs/release/` lists 20
  files and none of them is `v2-freeze-receipt-2026-08.json`. **This is the same structural fact
  R2 turns on** — one input, two steps that need it (`input-pins` here, `freeze-guard` at 0.4), and
  it survives every re-freeze because a receipt is always issued against the candidate it pins. A `worktree add --detach`
  materialises only the commit's tracked tree. A checkout-relative `--freeze` therefore exits **2**
  on an unreadable input before a single pin is derived. **Do not "fix" that by moving the chain to
  `~/dev/helix`.** The receipt is an input handed to the checkout, not a file of it. *(Corrected
  2026-08-17: this warning used to promise that moving the chain "would trip `method-drift` on the
  very next line". Measured 2026-08-17 it would not have — the intersection of the changed set with
  the 28 pins was empty then, so `input-pins` invoked in the development tree satisfied every pin
  and exited 0.)* **Re-measured 2026-08-25, that correction itself inverts: the intersection is now
  `src/memory/ownership.ts` + `src/memory/store.ts`, so a chain moved to `~/dev/helix` WOULD trip
  `method-drift` again.** Do not read that as protection — it holds only while those two files
  happen to differ, and a revert or a merge removes it without notice. The instruction, not the
  mechanism, is what stops a moved chain. See Block B, and C8's preflight for the one step that
  asserts its own tree.
- [ ] **K and both window bounds are copied from the receipt and cannot be passed** — there is no
  flag for them. That is the mechanism that keeps close day from re-deciding the method.
- [ ] Success: `pins.json` written, bound back to the freeze by `freezeSha256`.
- [ ] Refusals to expect and what each means:
  - `method-drift` → the tools or method docs under the cwd differ from the receipt, **or**
    `~/.helix/config.json` no longer hashes to `16f6d97f…`. Live tuning of that file during the
    window converts silently into this. *(Corrected 2026-08-17: this line read "you are in the
    wrong tree (Block B)". The wrong tree only produces this refusal while that tree diverges from
    the pins, and as of the re-freeze it does not — so absence of `method-drift` is NOT evidence
    that you are in the right tree.)*
  - `freeze-receipt-tampered` / `freeze-receipt-incomplete` / `not-a-freeze-receipt` → the receipt
    itself; stop.
  - `manifest-not-the-pinned-file` / `manifest-method-mismatch` → the manifest is not the one C2
    produced.
  - exit **2** (invocation) if `config.path` is unreadable: the chain is bound to the deployment
    machine and there is no flag to skip it.
- [ ] **The runtime half is declared, not re-derived.** `input-pins.ts` says so itself. §10's "both
  are verified again at the close" is therefore discharged by **C11**, which must be observed
  **before D1 and before Block F** — not by Block F's post-redeploy check, which by then can only
  describe the *new* build (F5 says so at length). Record that dependency in the report: its §2.3
  runtime-pin marker is sourced from C11.

### C5. Prepare — outcome-blind

*(R1 — still `cd ~/close-candidate`.)*

```bash
$TSX scripts/pilot/prepare-gate.ts \
  --manifest ~/close-run/manifest.json \
  --classifier ~/close-run/classifier.json \
  --universe ~/close-run/classifier.universe.json \
  --snapshot ~/close-run/snapshot \
  --pins ~/close-run/pins.json \
  --out ~/close-run/gate-set.json
```

- [ ] Success: stdout prints `gate-set prepared: <eligible>; O_67 <label>; stale <label>` and
  **`payload sha256: <hex>`**. **Copy that hash and assign it in the shell** — it is `PREPARE_SHA`,
  and C6, C7, C9, C9b and C10 all expand it. An unassigned variable expands to the empty string and
  the ordering appends record nothing:

  ```bash
  PREPARE_SHA=PASTE_THE_PAYLOAD_SHA256_HERE
  [[ "$PREPARE_SHA" =~ ^[0-9a-f]{64}$ ]] && echo "PREPARE_SHA ok" || echo "NOT a 64-hex sha256 — go back to C5"
  ```

  *(rehearsed 2026-08-13: pasted unchanged it prints `NOT a 64-hex sha256`; with a 64-hex value it
  prints `PREPARE_SHA ok`.)*

  Keep it in the same shell as `$TSX` (the transcript shell of 0.1).
- [ ] Refusals: **`snapshot-after-close`** (a row later than `txClose` reached the corpus — the §2
  bound and §9 item 2's demonstration; if you see it, the 0.6 write freeze failed and the close
  cannot be repaired by re-running: record it and escalate), `degraded-run` (C1.3 again),
  `pin-mismatch` /
  `input-hash-mismatch` / `input-set-mismatch`, `eligibility-disagreement`,
  `universe-probe-mismatch`, `ledger-tx-non-canonical`, `dangling-closer`.
- [ ] This phase takes **no runner output and never will**. If you are tempted to re-run it after
  seeing a rank, stop: that is the ordering violation the whole chain exists to exclude.

### C6. Ordering receipt — `prepare-finished` BEFORE any run

*(R1 — still `cd ~/close-candidate`.)*

```bash
$TSX scripts/pilot/ordering-receipt.ts --mode append \
  --log ~/close-run/ordering.jsonl --event prepare-finished --payload-sha "$PREPARE_SHA"
```

- [ ] `--run-id` is **REFUSED** for `prepare-finished` and **REQUIRED** for the runner events.
- [ ] This append must happen **before** C7. It is §9 evidence element 4 and nothing else in the
  chain records it.

### C7. Runner ×3 — stability

Three appends bracket one execution, and the block below is run **three times** — once with
`RUN_N=1`, once with `2`, once with `3`. *(R1 — still `cd ~/close-candidate`.)*

> **There is no `for` loop here on purpose, and no bare `$i`.** The middle step's output is what the
> third step's `--payload-sha` carries, so a human has to read a hash off the terminal between them;
> a loop cannot do that. An earlier draft of this sheet wrote `RUN_ID=run$i` in prose that said "for
> each run *i* in 1..3" — with `$i` never assigned, a literal paste yields `RUN_ID=run` and
> `~/close-run/run.json` *(measured 2026-08-13)*, and the ordering log is **hash-chained**: that
> bogus `runner-started` line cannot be removed, and the second iteration is then refused
> `duplicate-run-id`, in a chain the sheet's own rule forbids re-running past. So the label is a
> PASTE_ placeholder with a guard, exactly as C5 does for `PREPARE_SHA`.

**Paste each fenced block from column 0.** Set `RUN_N` first:

```bash
RUN_N=PASTE_1_OR_2_OR_3
RUN_ID=run$RUN_N
if [[ "$RUN_ID" =~ ^run[123]$ ]]; then echo "RUN_ID=$RUN_ID  → ~/close-run/run$RUN_N.json"
else echo "STOP: RUN_ID is '$RUN_ID', not run1/run2/run3. Fix RUN_N before running anything below."; fi
```

Then the three steps. The guard is repeated **inside** the two append commands, not merely before
them, because those are the two that write the unrepairable file:

```bash
if [[ "$RUN_ID" =~ ^run[123]$ ]]; then
  $TSX scripts/pilot/ordering-receipt.ts --mode append --log ~/close-run/ordering.jsonl \
    --event runner-started --run-id "$RUN_ID" --payload-sha "$PREPARE_SHA"
else echo "REFUSED locally — RUN_ID is '$RUN_ID'. NOTHING was appended."; fi
```

```bash
if [[ "$RUN_N" =~ ^[123]$ ]]; then
  $TSX scripts/pilot/run-pilot.ts \
    --manifest ~/close-run/manifest.json \
    --snapshot ~/close-run/snapshot \
    --gate-set ~/close-run/gate-set.json \
    --out ~/close-run/run$RUN_N.json
else echo "REFUSED locally — RUN_N is '$RUN_N'. No run artifact was written."; fi
```

```bash
RUN_PAYLOAD_SHA=PASTE_THE_RUN_PAYLOAD_SHA256_HERE     # from the run-pilot line above: `payload sha256: …`
if [[ "$RUN_ID" =~ ^run[123]$ && "$RUN_PAYLOAD_SHA" =~ ^[0-9a-f]{64}$ ]]; then
  $TSX scripts/pilot/ordering-receipt.ts --mode append --log ~/close-run/ordering.jsonl \
    --event runner-finished --run-id "$RUN_ID" --payload-sha "$RUN_PAYLOAD_SHA"
else echo "REFUSED locally — RUN_ID '$RUN_ID' / payload sha '$RUN_PAYLOAD_SHA'. NOTHING was appended."; fi
```

*(rehearsed 2026-08-13 against a scratch ordering log. With `RUN_N` left as the placeholder,
`RUN_ID` became `runPASTE_1_OR_2_OR_3`, the guard printed `STOP:` then `REFUSED locally — … NOTHING
was appended`, and the log stayed at **0 lines**. With `RUN_N=1` the `runner-started` append landed;
the `runner-finished` block, still carrying its unreplaced `PASTE_…` sha, printed `REFUSED locally`
and appended nothing; with a real 64-hex value it landed as the next line. The unguarded original,
on the identical input, printed `appended seq 0 runner-started (run 'run')` — into a hash-chained
file.)*

- [ ] The sha side needs no shell guard — `ordering-receipt` itself refuses any `--payload-sha`
  that is not 64 lowercase hex (`requireHex('payload-sha')`, before anything is written), so an
  unset `$PREPARE_SHA` or an unreplaced `PASTE_…` is rejected by the tool. **`--run-id` is the one
  input it cannot check**: it validates only that the label is non-empty, so `run` — the string an
  unset loop variable produces — is a perfectly acceptable id to it. That asymmetry is why the guard
  above exists and why it wraps the label, not the hash.

- [ ] **`--run-id` is an operator LABEL and is NOT the runner's run id.** `run-pilot` accepts no
  `--run-id` (`INPUTS = ['manifest','snapshot','gate-set','out']`, run-pilot.ts:293; anything else
  is refused `unknown-input`) and mints its own `randomUUID()` into the receipts half
  (run-pilot.ts:344), which it then prints as `run <uuid> …`. **Do not paste that UUID into
  `runner-finished`.** The only requirement is that the *same* label brackets one execution: a
  `runner-finished` whose id no earlier `runner-started` opened is refused `finish-without-start`
  (ordering-receipt.ts:408-410). **A reused label is not refused when you append it.** `--mode append`
  writes each line without consulting the ones before it; `duplicate-run-id` (`:399`) is raised only
  by `--mode verify`, which C10 runs — *(measured 2026-08-13: two `runner-started` appends with the
  same id both succeeded, and the verify then failed with `run id 'run1' is claimed by seq 1 and
  again by seq 2`)*. So a mistyped `RUN_N` surfaces at the end of the chain, not at the step that
  caused it. The log is hash-chained, so the wrong line **cannot be deleted**
  without invalidating §9 evidence element 4. At `runner-started` the UUID does not exist yet, so
  the label is the only thing that can be written there.
- [ ] **Element 4 ↔ element 5 is bound by the payload hash, not by the id.** The ordering log's
  three labels (`run1`, `run2`, `run3`) appear in no run artifact, and the run artifacts' three
  UUIDs (`receipts.runIds` in the score) appear in no log line: they are two disjoint id spaces
  **by construction**. The real binding is `runner-finished --payload-sha "$RUN_PAYLOAD_SHA"`, which
  is why that value is transcribed from the runner's own stdout. **Where the report carries this:**
  §5's element 4 and element 5 markers both state the disjointness in one sentence — without it a
  reader will try to match ids that cannot match.
- [ ] `runner-started` carries the **PREPARE** hash, not the run's own — the run artifact does not
  exist yet. That asymmetry is deliberate; do not "fix" it.
- [ ] Success: each run prints `run <id> over <n> probe(s) at K=20`, `prepare sha256: …`,
  `manifest sha256: …`, `payload sha256: …`. The three **payload** hashes must be identical;
  the whole files will not be (the receipts half carries a fresh run id and wall clocks).
- [ ] Refusals: `gate-set-tampered`, `manifest-not-pinned`, `snapshot-not-pinned`,
  `snapshot-registry-incomplete`, `expansion-not-pinned`, `degraded-run`.

### C8. Adjudication — skeleton, then the human pass

The producer is **`scripts/close/adjudication-skeleton.ts`** — a **PINNED** path, the 26th entry of
the receipt's `payload.tools`; its test `test/close/adjudication-skeleton.test.ts` is deliberately
not pinned, as no test is for any of the other 25 tools. *(Corrected 2026-08-17. This sentence read
"new, deliberately outside `scripts/pilot/` so the pinned surface stays untouched" until then. That
was the FIRST window's rationale, and report §4.6 records that the §8 ruling **destroyed** it —
"§8 turns on the ACT of building the method's tooling, not on which directory receives it". It was
also, by then, factually false: the second freeze added the path to `PINNED_TOOL_PATHS` precisely
so the edit class that cost a window is caught mechanically rather than by anyone remembering the
rule.)*

> **R1 — THIS STEP RUNS FROM `~/close-candidate`, LIKE THE REST OF THE CHAIN.** Under the first
> window it was an R2 dev-tree exception, because `scripts/close/` did not exist at that candidate.
> It does now (`git ls-tree -r --name-only $CANDIDATE -- scripts/close test/close | wc -l` → **2**),
> so the producer runs from the checkout with `$TSX`, its imports resolve to the checkout's own
> pinned modules, and no exception is claimed for it at all. **Its inputs are still named by
> ABSOLUTE paths (R4)** — they live under `~/close-run/`, not in the checkout — and its `--out` must
> too, so the checkout stays clean for 0.2's `git status --porcelain` evidence.
>
> **Re-run step 0.5 NOW, immediately before the command below, and paste this second reading too.**
> `~/dev/helix` is written by a second clone and hours will have passed since Block B. *(Corrected
> 2026-08-17: this reading no longer gates C8 and a `DIFFERS` line here is no longer a reason to
> skip it. C8 runs from the checkout, so the development tree's bytes are not what it loads; the
> preflight below asserts what C8 actually depends on. The reading is still taken and pasted
> because dev-tree drift mid-close is a finding about the chain and about 0.4's invocation —
> record it, diagnose it before Blocks D–F edit the repository, and do not let it silently
> redirect this step.)*

**The whole block runs inside `( … )`, and that is not cosmetic.** Almost every step of this
run-sheet executes inside the `script` capture shell opened at 0.1 — H7 is the documented exception
and must not. A bare `exit` in a pasted block would terminate THAT shell, ending the close-day
transcript H7 closes and hashes and that §6 and §11 of the report are sourced from. Inside a
subshell a failed check exits the subshell and leaves the capture running.

```bash
( set -u
  # --- preflight: assert the EXECUTION TREE, fail closed -------------------
  # Step 0.5 hashes the dev tree; this block runs in the checkout, so 0.5 says
  # nothing about what executes here. These four arms are what does.
  expected_candidate=94dd136925253be74c58df92392044c550aa6ec2
  [ ! -L ~/close-candidate ] || { echo "PREFLIGHT: ~/close-candidate is a symlink — 0.2 creates a real worktree; refusing to run somewhere else under its name" >&2; exit 1; }
  candidate_root="$(cd -P ~/close-candidate 2>/dev/null && pwd -P)"
  [ -n "$candidate_root" ] || { echo "PREFLIGHT: ~/close-candidate is absent or unreadable" >&2; exit 1; }
  cd -P "$candidate_root" || { echo "PREFLIGHT: cannot enter $candidate_root" >&2; exit 1; }
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "PREFLIGHT: not a git repository" >&2; exit 1; }
  actual_root="$(cd -P "$top" && pwd -P)" || exit 1
  [ "$actual_root" = "$candidate_root" ] || { echo "PREFLIGHT: wrong execution tree ($actual_root)" >&2; exit 1; }
  [ "$(git rev-parse --verify 'HEAD^{commit}')" = "$expected_candidate" ] || { echo "PREFLIGHT: wrong candidate commit" >&2; exit 1; }
  # tracked drift, content-true: --no-optional-locks + re-stat defeats assume-unchanged
  git update-index -q --really-refresh 2>/dev/null || true
  git diff --quiet --exit-code "$expected_candidate" -- || { echo "PREFLIGHT: candidate worktree has tracked changes" >&2; exit 1; }
  # untracked files too: 0.2's evidence is `git status --porcelain` EMPTY, not `git diff` quiet
  [ -z "$(git status --porcelain)" ] || { echo "PREFLIGHT: candidate worktree is not clean:" >&2; git status --porcelain >&2; exit 1; }
  [ -n "${TSX:-}" ] || { echo "PREFLIGHT: \$TSX is unset — bind it at 0.3, in THIS shell" >&2; exit 1; }
  echo "PREFLIGHT OK: $actual_root @ $expected_candidate, status --porcelain empty"

  # --- the step itself ------------------------------------------------------
  "$TSX" scripts/close/adjudication-skeleton.ts \
    --gate-set ~/close-run/gate-set.json \
    --run ~/close-run/run1.json \
    --out ~/close-run/adjudication.json
)
```

*(The candidate id is a full literal rather than `$CANDIDATE`, so this block refuses on its own
terms even in a shell where the loader was never run. Both variable failure modes would in fact
also fail closed — `set -u` aborts on unset, and an empty value fails the string comparison — so
the literal is a belt-and-braces choice, not a repair of a hole. **The explicit `-L` test is there
because `cd -P` did NOT fix what it appeared to fix.** `cd -P` resolves a symlinked
`~/close-candidate` to its target and `git rev-parse --show-toplevel` then reports that same target,
so the two agree and the root arm passes — measured after the `-P` hardening, still `PREFLIGHT OK`.
Only refusing the symlink outright catches it. Similarly `git diff` never reports untracked files,
so a stray `adjudication.json` in the checkout passed a check that printed the word "clean"; the
`status --porcelain` arm is what makes the printed claim equal 0.2's own cleanliness evidence.
Corrected 2026-08-17 — this block read `cd ~/dev/helix` until then, contradicting the R1 banner
immediately above it and sending the one step the re-freeze MOVED into the candidate back to the
tree it was moved out of. Hardened the same day after an adversarial review reproduced the symlink,
untracked-file, empty-`cd`, `assume-unchanged` and unquoted-`$TSX` cases.)*

*(preflight drilled 2026-08-17, **8/8**. The first pass was 5/5 against a throwaway *clone*;
it was re-drilled against a real `git worktree add --detach`, which is what step 0.2 actually
creates — a clone and a linked worktree are different objects and the first drill tested the wrong
one. All drills ran under a throwaway `HOME` in the session scratchpad; the development tree and its
`.git` were not written to. `bash -n` clean. **Positive**: real worktree, correct commit, clean →
`PREFLIGHT OK: <root> @ 94dd136925253be74c58df92392044c550aa6ec2, status --porcelain empty`, exit 0,
producer invoked. **Negatives, each exit 1 with the producer NOT invoked**:
(1) absent → `~/close-candidate is absent or unreadable`;
(2) HEAD at the freeze commit → `wrong candidate commit`;
(3) one tracked file modified → `candidate worktree has tracked changes`;
(4) `~/close-candidate` → the DEVELOPMENT tree → `wrong candidate commit`;
(5) untracked stray in an otherwise clean checkout → `candidate worktree is not clean:` followed by
`?? adjudication.json`;
(6) symlink to another checkout at the same commit → `~/close-candidate is a symlink …`;
(7) `assume-unchanged` + tampered `package.json` → `candidate worktree has tracked changes` (the
`--really-refresh` is what makes this one fire; a plain `git diff --quiet` returns clean);
(8) `$TSX` unset → `$TSX is unset — bind it at 0.3, in THIS shell`, instead of R3's two unhelpful
signatures. Note which arm catches case 4: the dev tree is its own toplevel, so the root comparison
passes and the COMMIT check is what refuses. Both arms are needed — the root check catches a
`~/close-candidate` lying inside another repository, where the commit could legitimately match.)*

**§8 disposition — RULED RESET for the first window, and it does not arise in this one.**
*(Corrected 2026-08-17. This paragraph asserted "**The owner RULED on 2026-08-13: DISCLOSURE, not
reset**" until then. That is the opposite of what happened: the owner ruled **RESET**, the first
window ended, and this window exists because of that ruling. An operator reading the old text would
have run the producer on the strength of a disposition that was never given.)*

The producer was written 2026-08-13, inside the FIRST window. `v2-preregistration-2026-07.md:344`
*(**candidate-relative, like every preregistration citation in this sheet** — measured 2026-08-17:
the quoted sentence is at `:344` in `94dd136` and at `:354` at HEAD, and the Reset paragraph opens
at `:340` / `:350` respectively. The preregistration is NOT among the 28 pinned paths, so nothing
mechanically holds its line numbers and the working copy has already drifted ten lines; read these
citations against the candidate, and re-measure rather than assume if a citation misses.)*
resets the window for tooling built after the freeze, "because implementing an unspecified detail
resolves a method choice"; the owner read the main clause as governing and ruled **RESET**. Report
§4.6 carries the ruling, the DISCLOSURE case that was put and not taken, and the reasoning behind
both — it is the record, and if this sheet and the report ever disagree the report is right.

**Why nothing is owed here now.** The reset was executed: candidate `94dd136` was cut on 2026-08-14
and the re-freeze put this producer INSIDE it, pinned as the 26th `payload.tools` entry. §8 reaches
tooling built after the freeze it governs, and no such build happened inside this window
(`git ls-tree -r --name-only 94dd136 -- scripts/close test/close` → 2 files). So this step needs no
ruling, no ledger entry and no disclosure of an in-window build. What it needs is the pin check
below, which is mechanical.

**Where the report carries this step:** §4.6 in full (the producer, its authoring date, its pin
status, the reasoning, the honest residue, the RESET ruling, and the paragraph recording that the
question does not recur in this window) and **§5's element 6**, in one sentence.

**What the producer does and does not decide**, retained because §9a must state it: it stamps no
verdict (every entry is `UNJUDGED`, which the pinned scorer refuses), selects no probe (the entry
set is the frozen gate set's `recallDenominator`), and emits only fields
`score-gate.ts:430,433,437,473-480` already demands. The one thing it decides is the **emission
order** of `contradictions` / `staleViolations`, and `adjudicationSha256` is order-sensitive by
design (score-gate.ts:497) — a provenance fact about one artifact's bytes, not a measurement
choice: any ordering yields the same verdicts.

**The fail-closed claim has a boundary and the report states it too:** `adjudication-uncertain` is
raised by a LOOP over the contradiction calls (`score-gate.ts:437`), so it holds over a **non-empty**
frozen denominator. If C5 prepared an empty one, the skeleton is empty, the loop iterates nothing
and the gate ACCEPTS the unfilled file — the release is still blocked, but by the Hit@1 exposure
floor rather than by any judgment. The producer prints a `NO JUDGMENTS` block saying exactly that;
read it as a signal to go back and check C2 and C5, not as a clean file.

*(usage rehearsed 2026-08-13)* → `missing-input: --gate-set is required` /
`usage: adjudication-skeleton --gate-set <path> --run <path> --out <path>` /
`--run is the run whose payload the adjudication binds: pass the SAME file you will pass to
score-gate as --run1, which is the run its adjudication check reads (score-gate.ts:425).`

- [ ] **STOP unless the producer's PIN still holds.** *(Corrected 2026-08-17. This gate read "STOP
  unless A4 has been ruled … If the ruling was RESET, you are not here" until then — and since the
  ruling WAS reset, the gate as written halts the close chain of the window that ruling produced.
  It was a first-window gate on an open question; the question is closed and the producer is now a
  pinned path, so the thing worth checking here is drift, not disposition.)*

  The producer is the 26th pinned tool. **What actually guarantees the bytes it runs is the
  preflight above, not step 0.5** — measured 2026-08-17, 0.5 iterates 19 paths
  (`git ls-tree … -- scripts/pilot scripts/close` = 18, plus `src/entry-point.ts`) of which 17 are
  pinned tools, and it hashes them in `~/dev/helix`, which is not the tree this step runs in. The
  preflight asserts the checkout's identity, its commit and its cleanliness directly, so a producer
  whose bytes had moved could not be at that commit with a clean tree.

  0.5 still matters here for a different reason: **a `DIFFERS` line naming
  `scripts/close/adjudication-skeleton.ts` is a finding about the DEVELOPMENT tree** — the pinned
  surface moved there — and it must be reported, not repaired. It is not a reason to skip this step,
  which no longer loads anything from that tree. If for any other reason you choose not to run the
  producer, **hand-author the adjudication** from the frozen probe list: the gate treats a
  hand-authored file and a stamped one identically, so nothing downstream changes.
- [ ] **Pass `run1.json` here and as `--run1` to `score-gate`.** They must be the same file.
- [ ] Success: the skeleton lands with one entry per frozen probe, complete and unduplicated by
  construction, both hashes recomputed from bytes, and the program prints how many judgments are
  outstanding.
- [ ] **THE HUMAN PASS — this is the part no program can do.** Every verdict is stamped
  `UNJUDGED`, which the score phase does **not** accept. Replace each contradiction verdict with
  `none` or `contradiction`; a `contradiction` call must **quote both sides** (§5a) — replace
  `targetText` and `returnedText` with the actual row texts, which cannot be pre-filled because a
  run artifact carries ids and ranks, not row content (`RunResult` is
  `id, query, unambiguous, bestRank, hitAtK, hitAt1, returned[]`, gate-set.ts:98-101). An
  unreplaced `UNQUOTED — …` placeholder is carried verbatim into the signed score payload.
- [ ] **The judgment covers EVERY returned record in the top-K, not just rank 1.** §5a's rubric is
  "**a** returned live record that addresses the same proposition asserts the negation…"
  (`v2-preregistration-2026-07.md:142`) — any of the up-to-K=20 returned rows, not the top-ranked
  one. `returnedId` is only **pre-filled** with the rank-1 id as a starting point; when the
  contradicting record sits at rank 2–20, **replace `returnedId` with that record's id** and quote
  that row. The probe's full `returned` list is in `~/close-run/run1.json`; read it there.
- [ ] **How to resolve an id to its text.** `jq` is not on this box. Read the **snapshot copy**,
  never the live ledger — the judgment must be bound to the measured corpus. The ids go in a
  **guarded variable**, not inline: `<id>` written literally is shell redirection, exactly as
  C10's `--decision` is. *(Measured 2026-08-13, pasting the earlier inline form verbatim:
  `bash: id: No such file or directory` — the command never ran, and the message names nothing in
  this run-sheet.)* **Paste both blocks below from column 0** (indented, the heredoc terminator
  stops delimiting):

```bash
IDS="PASTE_THE_RECORD_IDS_SPACE_SEPARATED"
[[ "$IDS" != PASTE_* ]] && echo "IDS ok: $IDS" || echo "STOP: replace IDS with the ids you are resolving"
```

```bash
if [[ "$IDS" != PASTE_* ]]; then
python3 - ~/close-run/snapshot/home/memory.jsonl $IDS <<'PY'
import json, sys
want = set(sys.argv[2:])
for line in open(sys.argv[1]):
    r = json.loads(line)
    if r['id'] in want:
        print(r['id'], '|', r['tx'], '|', r['state'], '|', r['content'])
PY
else echo "REFUSED locally — IDS is still the placeholder. Nothing was read."; fi
```

  **`$IDS` is deliberately unquoted inside the command** — it must word-split into one argument per
  id, which is how the program takes more than one. That is also why the guard matters: an
  unreplaced `IDS` would otherwise be searched for as though it were an id, print nothing, and read
  exactly like the "id appears in neither file" finding described below — a false finding, silently.
  *(rehearsed 2026-08-13 both ways: unreplaced it printed `REFUSED locally` and read nothing; with
  two real ids it printed both rows.)*

  *(rehearsed 2026-08-13 against a real ledger, exit 0. The field is `content` — `MemoryRecord`,
  `src/types.ts:47` in the candidate checkout, `:50` in the development tree; `:43` is `validFrom`,
  so read the candidate's numbering here — not `text`.)* Run it a second time against the project
  twin, `~/close-run/snapshot/proj/.helix/memory.jsonl` — a probe's rows may live in either unit.
  An id that appears in neither file is itself a finding: record it and stop.
- [ ] **Do not retype the quotes — the rows are large.** The `<id> | <tx> | <state> | <content>`
  line is a *format*, not a size: measured over the 45 project rows on 2026-08-13, `content` ran
  **24 to 5004 characters** (median 2876), and **17 of 45 rows contain embedded newlines**, one of
  them 15 lines long. §5a requires both sides quoted verbatim, so hand-transcription is both slow
  and the likeliest place to corrupt evidence. The block below reads the two rows out of the
  snapshot and writes them straight into one entry's `targetText` / `returnedText`. It sets
  `returnedId` to the record you actually judged, **leaves the verdict alone**, preserves key order
  (which `adjudicationSha256` is sensitive to, `score-gate.ts:494-497`) and replaces the file
  atomically.

  **The three ids go in guarded variables, and this block is the one where an inline `<…>` did real
  damage.** *(Measured 2026-08-13, pasting the earlier inline form verbatim into an interactive
  shell: the first line died with `bash: syntax error near unexpected token '<'` — so the heredoc
  was never opened, and bash then read the **~20 following python lines as commands**, printing
  `Command 'import' not found`, `adj_path,: command not found`, `Command 'rows' not found` and a
  run of `syntax error near unexpected token '('`. All of it landed in the transcript the report
  cites as its §6 execution log.)*

  **Paste both blocks from column 0**, once per positive call:

```bash
PROBE_ID=PASTE_THE_PROBE_ID
TARGET_ROW_ID=PASTE_THE_TARGET_ROW_ID
RETURNED_ROW_ID=PASTE_THE_RETURNED_ROW_ID
[[ "$PROBE_ID$TARGET_ROW_ID$RETURNED_ROW_ID" != *PASTE_* ]] \
  && echo "ids ok: $PROBE_ID / $TARGET_ROW_ID / $RETURNED_ROW_ID" \
  || echo "STOP: one of the three is still a placeholder"
```

```bash
if [[ "$PROBE_ID$TARGET_ROW_ID$RETURNED_ROW_ID" != *PASTE_* ]]; then
python3 - ~/close-run/adjudication.json "$PROBE_ID" "$TARGET_ROW_ID" "$RETURNED_ROW_ID" <<'PY'
import json, os, sys
adj_path, probe_id, target_id, returned_id = sys.argv[1:5]
rows = {}
for L in ('home/memory.jsonl', 'proj/.helix/memory.jsonl'):
    for line in open(os.path.expanduser('~/close-run/snapshot/' + L)):
        r = json.loads(line)
        rows[r['id']] = r
missing = [i for i in (target_id, returned_id) if i not in rows]
if missing:
    raise SystemExit(f'not in either snapshot ledger: {missing} — that is a finding; stop')
adj = json.load(open(adj_path))
hit = [c for c in adj['contradictions'] if c['probeId'] == probe_id]
if len(hit) != 1:
    raise SystemExit(f'{len(hit)} entries for probe {probe_id} — refusing to guess')
c = hit[0]
c['returnedId'] = returned_id
c['targetText'] = rows[target_id]['content']
c['returnedText'] = rows[returned_id]['content']
tmp = adj_path + '.tmp'
json.dump(adj, open(tmp, 'w'), indent=1)
os.replace(tmp, adj_path)
print(f'{probe_id}: quoted both sides ({len(c["targetText"])} / {len(c["returnedText"])} chars); '
      f'verdict is still {c["verdict"]!r} — set it by hand.')
PY
else echo "REFUSED locally — one of PROBE_ID / TARGET_ROW_ID / RETURNED_ROW_ID is still a placeholder. The adjudication was NOT touched."; fi
```

  *(rehearsed 2026-08-13 against the rehearsed snapshot and a skeleton-shaped file)* → printed
  `L_p1: quoted both sides (55 / 24 chars); verdict is still 'UNJUDGED' — set it by hand.`, and
  re-reading the file showed both texts in place with the top-level and per-entry key order
  unchanged. It touches neither hash. *(The guarded form re-rehearsed 2026-08-13 both ways: pasted
  unreplaced it printed `REFUSED locally` and the adjudication's `targetText` was still its
  `UNQUOTED — …` placeholder afterwards; with three real ids it quoted both sides, set `returnedId`
  and left the verdict `UNJUDGED`.)* Use it only for calls you have judged `contradiction`: a
  `none` verdict needs no quotes, and filling them anyway records evidence for a call nobody made.
- [ ] **The fail-closed property is NOT symmetric.** The gate validates contradiction verdicts and
  ignores any stale verdict that is not `violation`. An unfilled skeleton is refused because of its
  *contradictions*; judge those and leave a stale entry `UNJUDGED` and it is silently counted as
  "no violation". **Judge both sets.**
- [ ] **A stale `violation` must also name its pair.** Add `closedId` (the closed record that was
  served) and `currentId` (its current form) to the entry — both are optional keys of the pinned
  `StaleCall` (`score-gate.ts:60-65`) and nothing pre-fills them, because a run artifact carries
  ranks, not closer relationships. The scorer copies each violation **verbatim** into the signed
  payload (`score-gate.ts:481-483`), and report §7.4's marker reads those two ids back out of it, so
  a violation recorded without them is one the report cannot describe. A `none` verdict needs
  neither. The producer's printed instructions say the same thing whenever a stale set is emitted.
- [ ] Do not hand-edit the two hashes. If either input is replaced, **re-stamp to a NEW `--out`
  path** — e.g. `~/close-run/adjudication-2.json` — and pass that path to `score-gate`'s
  `--adjudication`. The producer refuses a pre-existing destination (`output-exists`, exit 2) and
  its refusal text says the existing file must not be moved or deleted, so re-stamping over the old
  path is not available. That is deliberate: if judgments have already been entered, deleting the
  file to make room destroys them.
- [ ] Refusals from the producer: `gate-set-tampered`, `run-tampered`,
  `run-not-bound-to-gate-set`, `run-probe-mismatch`, `gate-set-malformed`, `not-a-run`.

### C9. Score

*(R1 — `cd ~/close-candidate`, unchanged: C8 runs there too since the re-freeze. This line read
"**back to** `cd ~/close-candidate` after C8's dev-tree step" until 2026-08-17, which described the
first window's routing.)*

```bash
cd ~/close-candidate
$TSX scripts/pilot/score-gate.ts \
  --gate-set ~/close-run/gate-set.json \
  --expect-payload "$PREPARE_SHA" \
  --run1 ~/close-run/run1.json --run2 ~/close-run/run2.json --run3 ~/close-run/run3.json \
  --adjudication ~/close-run/adjudication.json \
  --out ~/close-run/score.json
```

- [ ] `--expect-payload` is `PREPARE_SHA` **as recorded in C5**, transcribed from that step's
  stdout — not re-read out of `gate-set.json` (a self-consistent forged artifact would satisfy
  that).
- [ ] Refusals worth recognising on sight: `adjudication-uncertain` (a verdict still `UNJUDGED` —
  go back to C8), `adjudication-incomplete` / `adjudication-duplicate` / `adjudication-unbound`,
  `runs-not-distinct` / `stability-needs-three-runs`, `run-inconsistent`,
  `gate-set-unpinned-*` (ledger / trust / manifest / expansion / disposition).
- [ ] **A refusal is a result.** Record it verbatim in the report's §11 and do not re-run to obtain
  a different one.

### C9b. Re-score — the SECOND half of the Stability condition

Stability is two requirements, not one: *"run the runner three times and require `h1 = h2` and
`h1 = h3`; **then re-run deterministic scoring against the same adjudication input and require the
same equality**"* (`v2-preregistration-2026-07.md:204-206`). C7 discharges the first half; this
step is the second, and without it a blocking gate condition goes half-performed.

*(R1 — `cd ~/close-candidate`.)*

```bash
$TSX scripts/pilot/score-gate.ts \
  --gate-set ~/close-run/gate-set.json \
  --expect-payload "$PREPARE_SHA" \
  --run1 ~/close-run/run1.json --run2 ~/close-run/run2.json --run3 ~/close-run/run3.json \
  --adjudication ~/close-run/adjudication.json \
  --out ~/close-run/score2.json
```

- [ ] **Identical to C9 in every argument except `--out`.** A fresh `--out` is mandatory —
  `score-gate` refuses `output-exists` on a destination that already exists, and the C9 artifact
  must not be moved or deleted.
- [ ] If C8 was re-stamped, `--adjudication` is the **same file C9 used**, not a newer one. "The
  same adjudication input" is the whole point of the check.
- [ ] Success: `score2.json`'s **`payloadSha256` equals `score.json`'s**. Compare them, do not
  eyeball them — **paste from column 0**:

```bash
python3 -c "
import json
a=json.load(open('$HOME/close-run/score.json'))['payloadSha256']
b=json.load(open('$HOME/close-run/score2.json'))['payloadSha256']
print(a); print(b); print('EQUAL' if a==b else 'DIFFERENT — stability FAILS')"
```

- [ ] Record **both** hashes in report §7.6. A difference is a **failed Stability condition**, not
  a tooling problem: record it and do not re-run for a third opinion.
- [ ] C10 uses **`score.json`** (the C9 artifact). `score2.json` is evidence for §7.6 only and is
  never the release record's input.

### C10. Release record

*(R1 — `cd ~/close-candidate`.)*

```bash
$TSX scripts/pilot/ordering-receipt.ts --mode verify --log ~/close-run/ordering.jsonl \
  --expect-prepare "$PREPARE_SHA"
```

Assign and check **all four** pasted values before the record command — the decision, the ordering
head, and the two prose fields. None of them may go in inline, and the two reasons are different.

`--decision <released|blocked>` written literally is shell **redirection**, not an argument. A
verbatim paste dies with `released: No such file or directory` / `blocked: command not found`,
exit 127, before `release-record.ts` runs at all — an error that names nothing in this run-sheet.

**And it leaves debris.** The `|blocked>` half redirects that failed command's output into a file
named `--out`, created in the current directory *(measured 2026-08-13: an empty file literally
called `--out` appeared in the cwd)*. At this step the cwd is `~/close-candidate`, so the paste
would plant an untracked file inside the candidate checkout and quietly falsify step 0.2's
`git status --porcelain` = empty — the evidence report §2.3 cites. If you ever see a file named
`--out`, delete it (`rm -- --out`) and re-check `git status --porcelain` in the checkout before
going on.

`--consequence` / `--evidence` fail the **opposite** way, and it is the worse of the two: quoted,
an unreplaced placeholder is **accepted**. `release-record` refuses only a field with *no content*
— empty, or made only of whitespace, zero-width and control characters (`hasContent`,
release-record.ts:88,230-237) — and template prose has content. *(Measured 2026-08-13: the earlier
form of this block, pasted verbatim with both `<…>` texts unreplaced and only `DECISION` /
`ORDERING_HEAD` filled in, printed `release record written: gate BLOCKED (1 reason(s))` at **exit
0** and wrote `release-record.json` with `consequence` =
`'<if BLOCKED: what was NOT released; if not: the release that followed and its record>'` inside
its signed payload.)* That file is §9 evidence element 8, and it **cannot be corrected in place**:
re-running with real prose over the same `--out` is refused `output-exists` (exit 2) and the
refusal text forbids moving or deleting the existing file. The guard below is therefore the only
thing standing between a slip and a permanently placeholder-worded release record.

```bash
ORDERING_HEAD=PASTE_THE_PRINTED_CHAIN_HEAD_HERE
DECISION=PASTE_released_OR_blocked
CONSEQUENCE="PASTE_THE_CONSEQUENCE_TEXT"
EVIDENCE="PASTE_THE_EVIDENCE_TEXT"
[[ "$ORDERING_HEAD" =~ ^[0-9a-f]{64}$ ]] && echo "ORDERING_HEAD ok" || echo "NOT a 64-hex chain head — re-read the verify output"
[[ "$DECISION" =~ ^(released|blocked)$ ]] && echo "DECISION ok: $DECISION" || echo "NOT released|blocked — the gate's verdict decides this word, not you"
[[ "$CONSEQUENCE" != PASTE_* ]] && echo "CONSEQUENCE ok: $CONSEQUENCE" || echo "STOP: --consequence is still the placeholder — release-record would SIGN it into the record"
[[ "$EVIDENCE" != PASTE_* ]] && echo "EVIDENCE ok: $EVIDENCE" || echo "STOP: --evidence is still the placeholder — release-record would SIGN it into the record"
```

**Keep the double quotes on the two prose assignments and write inside them.** Real consequence
text contains spaces, colons and apostrophes; a bare `CONSEQUENCE=Nothing shipped: …` would run
`shipped:` as a command, and single quotes would break on the first apostrophe. Read the two `ok:`
lines back — what they echo is what lands in the signed payload, verbatim.

*(rehearsed 2026-08-13: pasted unchanged, all four print their failure line; with a 64-hex head,
`DECISION=blocked` and real prose in both fields — apostrophe and colon included — all four print
`ok`.)*

```bash
if [[ "$CONSEQUENCE" != PASTE_* && "$EVIDENCE" != PASTE_* ]]; then
  $TSX scripts/pilot/release-record.ts \
    --score ~/close-run/score.json \
    --decision "$DECISION" \
    --consequence "$CONSEQUENCE" \
    --evidence "$EVIDENCE" \
    --ordering-head "$ORDERING_HEAD" \
    --out ~/close-run/release-record.json
else echo "REFUSED locally — placeholder text still in \$CONSEQUENCE / \$EVIDENCE. NOTHING was written."; fi
```

*(rehearsed 2026-08-13 against a stand-in score under a throwaway `HOME`: unreplaced, it printed
`REFUSED locally` and no `release-record.json` existed afterwards; with real prose it wrote the
record and the signed payload carried that prose.)*

- [ ] The guard is repeated **inside** the record command, not merely before it, for the same
  reason C7 wraps its two ordering appends: this is the step that writes a file no re-run can
  repair. `--decision` and `--ordering-head` need no such wrapper — the program itself refuses a
  malformed decision (`decision-unrecognised`) and a malformed head (`ordering-head-malformed`)
  before writing anything. **`--consequence` and `--evidence` are the two inputs it cannot check**,
  because "is this text the operator's real statement or a leftover template" is not a property any
  program reading a score file can decide. That asymmetry is why the guard exists and why it wraps
  the prose, not the decision.
- [ ] `--decision` takes exactly `released` or `blocked` (`DECISIONS`, release-record.ts:68) and is
  checked against the score in **both** directions. The gate's verdict decides which word this is;
  the guard above only stops a placeholder reaching the program.
- [ ] `--ordering-head` is REQUIRED: it anchors the ordering log's tail, which nothing else in the
  chain does. Supply `--expect-head` on the verify call too if you want the verdict to bound the
  log's **length** — without it the verdict says so itself.
- [ ] Refusals: `score-tampered`, `score-self-contradictory`, `decision-unrecognised`,
  `consequence-not-applied` / `consequence-overstated` / `consequence-unevidenced`,
  `ordering-head-malformed`. The decision is compared against the score and must agree **in both
  directions** — you cannot record a release the gate blocked, nor a block the gate passed.
- [ ] Record `release-record.json`'s **payload sha256**; Block D needs it.

### C11. THE RUNTIME PIN — observe it NOW, while the measured deployment still exists

> **This step is unrecoverable if skipped.** It must run **before D1** and certainly before Block F.

`input-pins` derives the *input* half of the pins and says itself that the **runtime** half is
declared, not re-derived (C4). §10's "both pins are verified again at the close"
(`v2-preregistration-2026-07.md:472,527`) is therefore discharged only by a load-path observation
of the running deployment — and **Block F's uninstall+install replaces that deployment**. Observed
after F4, all three values name the *new* build, which answers a different question than the one
§10 asks and destroys the evidence for the original: the load paths hold bytes, not history, and
`scripts/freeze-runtime-check.sh` cannot substitute (it exits silently when healthy, logs only
heals, and after D1 writes the close receipt it exits at step 0 and stops checking altogether).

*(cwd-independent — this reads the deployment, not a tree.)*

**`installed_plugins.json` holds MORE THAN ONE entry for `helix@helix`, and every one of them is
part of the observation.** An earlier form of this step read `plugins['helix@helix'][0]` and
reported that single value. *(Measured 2026-08-13: this deployment carries **two** entries — a
`user`-scope one installed 2026-08-02T11:48:02.518Z, and a `local`-scope one installed
2026-08-09T11:21:33.082Z whose `projectPath` is the single registered project root, i.e. exactly
the project unit whose ledger C1.2 copies as the measured project corpus.)* *(Corrected 2026-08-27:
those two `installedAt` values described entries the 2026-08-14 redeploy REPLACED; measured
2026-08-27 the two entries carry `lastUpdated` `2026-08-14T06:20:16.525Z` (user) and
`2026-08-14T06:20:20.094Z` (local). The structure — two entries, the local one's `projectPath` at
the project unit — is unchanged.)* Reading index 0 alone
would have observed the runtime pin of the user scope and said nothing about the scope the
measurement actually ran under. Enumerate them. **Paste from column 0:**

```bash
python3 - <<'PY'
import json, os
CAND = json.load(open(os.path.expanduser(
    '~/dev/helix/docs/release/v2-freeze-receipt-2026-08.json')))['payload']['candidateCommit']
entries = json.load(open(os.path.expanduser(
    '~/.claude/plugins/installed_plugins.json')))['plugins']['helix@helix']
print('candidate (from the receipt):', CAND)
print('installed entries for helix@helix:', len(entries))
bad = 0
for e in entries:
    ok = e.get('gitCommitSha') == CAND
    bad += 0 if ok else 1
    print('  scope=%-6s project=%-40s sha=%s  %s'
          % (e.get('scope'), e.get('projectPath', '(none — user scope)'),
             e.get('gitCommitSha'), 'OK' if ok else 'MISMATCH'))
print('ALL ENTRIES EQUAL THE CANDIDATE' if bad == 0
      else '%d ENTRY/ENTRIES DIVERGE — a deviation; record the values verbatim' % bad)
PY
git -C ~/.claude/plugins/marketplaces/helix rev-parse HEAD
sha256sum ~/.claude/plugins/marketplaces/helix/bin/helix-mcp.mjs \
          ~/.claude/plugins/cache/helix/helix/0.1.0/bin/helix-mcp.mjs
cd ~/dev/helix && git show $CANDIDATE:bin/helix-mcp.mjs | sha256sum
```

The candidate is **read from the receipt, not typed** — the same discipline as the values block at
the top of this sheet, and it is why the enumeration can print its own verdict.

*(the enumeration run live, read-only, 2026-08-13)* →

```
candidate (from the receipt): 94dd136925253be74c58df92392044c550aa6ec2
installed entries for helix@helix: 2
  scope=user   project=(none — user scope)                      sha=94dd136925253be74c58df92392044c550aa6ec2  OK
  scope=local  project=(elided — the registered project root)   sha=94dd136925253be74c58df92392044c550aa6ec2  OK
ALL ENTRIES EQUAL THE CANDIDATE
```

**The `local` row's `projectPath` is elided above and must be elided when you paste close day's
output too** — this file is tracked, and `test/output-vocabulary.test.ts` fails on a literal
`/home/<user>` path in `docs/release/`. Elide the path, never the row: which scopes exist is the
finding, and the path itself is already described in the report's retention bullet.

*(re-observed 2026-08-14, immediately after the second window's redeploy — all four green)* →
marketplace clone HEAD `94dd136925253be74c58df92392044c550aa6ec2`; both load paths
`075fc39e16bf3aea613c8d0a7538bc29b871f6f544eb314fa3d35051486b6db3`; the candidate blob the same
hash. That is a FREEZE-DAY reading, not a close-day one — it shows the deployment started the
window on-pin, which is a different claim from ending it on-pin. Re-run on close day and record the
observed values, whatever they are.

*(re-observed 2026-08-27, read-only — all four green)* → `installed entries for helix@helix: 2`,
both rows `OK`, `ALL ENTRIES EQUAL THE CANDIDATE`; clone HEAD
`94dd136925253be74c58df92392044c550aa6ec2` — healed at that morning's boot (10:59 KST) from
`eddf313`, the 2026-08-26 evening auto-pull (deviations ledger, Instance 10); both load paths and the
candidate blob `075fc39e16bf3aea613c8d0a7538bc29b871f6f544eb314fa3d35051486b6db3`. The MISMATCH
branch, on a COPY of `installed_plugins.json` with the second entry's `gitCommitSha` set to forty
zeros: `scope=local … sha=0000… MISMATCH` and `1 ENTRY/ENTRIES DIVERGE — a deviation; record the
values verbatim` — the verdict is a printed line, not an exit code (the heredoc exits 0 either way),
so it has to be READ. **HAZARD, measured the same day: the block's last line, `git show
$CANDIDATE:bin/helix-mcp.mjs`, degrades silently when `$CANDIDATE` is unset** — it becomes `git show
:bin/helix-mcp.mjs`, the INDEX blob, and today that prints the SAME `075fc39e…`, so a shell that
never sourced the loader produces an indistinguishable success. Source the loader in the transcript
shell first, and keep its echo line in the same transcript segment as this block's output.

- [ ] Success: **every** `installed_plugins.json` entry's `gitCommitSha` equals the candidate — not
  just the first — and the marketplace clone's HEAD equals it too; and the two bundle hashes equal
  each other **and** equal the candidate's `bin/helix-mcp.mjs`.
  That set is what §10 asks for: the runtime that produced the measurement was the frozen one.
  Record the entry **count** alongside the values: "all entries matched" is only checkable by a
  reader who knows how many there were.
- [ ] Refusal: any mismatch is a **deviation**, not a step to retry — record the observed values
  verbatim in the report's deviation history and in §11 before touching anything. Do not heal,
  reset or redeploy first; the observation is the evidence.
- [ ] **Where the report carries this:** §2.3's bullet opening **"Runtime identity re-verification"**
  — the runtime-pin marker — is sourced from **this** step and names it, not F5; F5's separate result lands in report §10's "Deployment
  brought current" bullet. C4's closing bullet points here too. If any of the three ever reads as
  though Block F discharges §10, this step is the one that is right.

---

## Block D — THE ORDERING CONSTRAINT THAT WILL BITE

> **Write the validated close receipt BEFORE editing `docs/release/o67-class-rule-2026-07.md`.**

`o67-class-rule-2026-07.md` is one of the **two** receipt-pinned method docs
(`PINNED_METHOD_DOCS`, `scripts/pilot/pin-hashes.ts`; pinned `c1fe768ca0ec2b11…`, and the tree is
currently identical — verified 2026-08-13). The instant `txClose` passes,
`test/output-vocabulary.test.ts` stops allowing its **3** private-workspace citations (lines 109,
157, 167) and demands their removal — see Block E2. Removing them changes that file's sha256.

Do it in the wrong order and you have edited a pinned method doc while the close receipt that
records "the pins were re-verified at the close" does not yet exist: the re-verification can no
longer be performed in this tree, any chain step re-run from `~/dev/helix` now refuses
`method-drift` — for THIS reason, the edited method doc, which as of the re-freeze is the only
reason it would refuse there — and the receipt chain's final link is written about a state that no
longer exists. *(Corrected 2026-08-17: "a *second*, unrelated reason" presupposed a first, Block
B's pin divergence, which the re-freeze removed.)*

- [ ] **D1. Write the validated close receipt** — only **after** `release-record.json` validated,
  and only **after C11** has observed the runtime pin. Its existence alone is nothing;
  `scripts/freeze-runtime-check.sh` (step 0) validates the shape.

**The two blocks below start at column 0 and must be pasted that way** — indented, the heredoc
terminator stops delimiting and the whole thing dies on `IndentationError` with the guard line
swallowed into the heredoc. (Measured: the indented form printed `warning: here-document …
delimited by end-of-file (wanted 'PY')` and `IndentationError: unexpected indent`, and no guard
verdict at all.) Paste each fenced block as a unit, from column 0.

```bash
python3 - <<'PY'
import json, os
h = os.path.expanduser('~')
rr = json.load(open(h + '/close-run/release-record.json'))
json.dump({
  "artifact": "close-receipt",
  "freezePayloadSha256": "360ffe80f6baf853fdc5acb4bc949a14b84838c3827cbeb56832da56bfcc7332",
  "releaseRecordPayloadSha256": rr["payloadSha256"],
}, open(h + '/dev/helix/docs/release/v2-close-receipt-2026-08.json','w'), indent=1)
PY
bash ~/dev/helix/scripts/freeze-runtime-check.sh; echo "exit=$?"
```

  *(the python block rehearsed 2026-08-13, pasted verbatim against a throwaway `HOME` so nothing
  live was written)* → exit 0 and a 4-line receipt carrying `artifact`, `freezePayloadSha256` and
  `releaseRecordPayloadSha256`.

  **The guard line is rehearsable — do it, and only the live invocation stays irreversible.**
  `freeze-runtime-check.sh` reads its close-receipt path from the `FRC_CLOSE_RECEIPT` env seam
  (`freeze-runtime-check.sh:22`; the whole `FRC_*` family exists so drills never touch live state),
  so both branches can be exercised against the throwaway receipt without retiring anything:

  ```bash
  GOOD=PASTE_THE_PATH_OF_THE_THROWAWAY_RECEIPT
  BAD=PASTE_THE_PATH_OF_A_DELIBERATELY_MALFORMED_ONE
  [[ "$GOOD$BAD" != *PASTE_* ]] || echo "STOP: both paths are still placeholders — the two lines below would not test the guard"
  FRC_HEAL=0 FRC_CLOSE_RECEIPT="$GOOD" bash ~/dev/helix/scripts/freeze-runtime-check.sh; echo "exit=$?"
  FRC_HEAL=0 FRC_CLOSE_RECEIPT="$BAD" bash ~/dev/helix/scripts/freeze-runtime-check.sh; echo "exit=$?"
  ```

  *(The paths are variables because the inline `<…>` form here was the most misleading of the
  placeholder sites: measured 2026-08-13, pasting it verbatim printed `bash: the: No such file or
  directory` and then **`exit=1`** — the guard never ran, but `exit=1` is precisely the signature
  the second line is supposed to produce when the guard correctly rejects a malformed receipt. A
  reader checking exit codes would have read a redirection failure as a passing drill.)*

  *(rehearsed 2026-08-13)* → the valid receipt gave **exit 0 and silence** (step 0 accepted it and
  the guard returned without reaching any other check); the malformed one printed
  `[freeze-guard] v2 freeze runtime-pin VIOLATION (1):` / `- close receipt present but INVALID: …`
  and **exit 1**. `FRC_HEAL=0` is belt-and-braces: the heal path only fires when clone-HEAD drift is
  the *sole* violation, which an invalid receipt already prevents. The receipt written by the python
  block above satisfies the same validator, field for field (`freeze-runtime-check.sh:29-40`).

  What remains **irreversible is only the unseamed line in the fence above**: run against the real
  close receipt it retires the guard for good, and that is the act to leave until the receipt is
  final.

  Success: **exit 0 and silence** — the guard's step 0 accepts the receipt and retires itself.
  Refusal: `close receipt present but INVALID` on stderr means `artifact`,
  `freezePayloadSha256` or `releaseRecordPayloadSha256` is wrong; the guard then continues to
  hard-fail on every other check. Fix the receipt, do not delete it.

- [ ] **D2. Only now** remove the 3 private-workspace citations from
  `docs/release/o67-class-rule-2026-07.md` (lines 109, 157, 167 — they name spec files under the
  gitignored local workspace; the fix is to remove the citations, **never to move the date**).

  ```bash
  # NEEDLE is split so this run-sheet does not itself become a citation site — the same trick
  # test/output-vocabulary.test.ts uses on itself.
  N="docs"/"superpowers"
  cd ~/dev/helix && git grep -c "$N" -- ':!docs/issues' ':!docs/plans'
  ```

  *(rehearsed 2026-08-13)* → `docs/release/o67-class-rule-2026-07.md:3`.
  Success after the edit: the command prints **nothing** (exit 1, no matches).

---

## Block E — THE THREE SIMULTANEOUS RED FLIPS

At and just after `txClose` the suite changes in three places at once. **This is designed
behaviour, not a failed close.** Read this block before running `npm test` on close day.

- [ ] **E1. `test/plugin/packaging.test.ts` — red ONLY IF a post-candidate `src/` commit landed.**
  Case: *"rebuilding from src reproduces bin/ byte-for-byte (else: run npm run build)"*
  (`packaging.test.ts:65-75`). It rebuilds from `src/` into a temp dir (`HELIX_BUILD_OUT`) and
  byte-compares against the committed `bin/`. It is **not** date-driven — it goes red the moment
  the first post-candidate `src/` commit lands and clears **only** after the rebuild in Block F.
  **This line said "already red, and has been for the window" until 2026-08-16, and that is now
  false.** It described the FIRST window, where `bin/` sat 62 commits behind the candidate. The
  second window opened with `bin/` rebuilt and deployed, so measure before predicting — and measure
  the right thing:

  ```bash
  git diff --quiet $CANDIDATE HEAD -- bin/ && echo "E1 GREEN expected" || echo "E1 RED expected"
  ```

  **Predict from `bin/`, NOT from a commit count.** A first draft of this line used
  `git log $CANDIDATE..HEAD -- src/ | wc -l` and that predictor is wrong: a comment-only `src/`
  commit increments it while `build.mjs` (`legalComments: 'none'`) strips the comment, so the
  rebuild still reproduces `bin/` and E1 stays GREEN. That exact case landed the same day
  (`5797346`, the aligner limits header) — the count is 1 and packaging is 7/7 green. Predicting
  from the count would have shown the close-day operator a failure that never comes and sent them
  looking for a cause. If `git diff --quiet` succeeds at close, E1 is GREEN, that is not a failure
  to explain, and Block F's rebuild is a no-op that must reproduce `bin/` byte-for-byte.
  *(rehearsed 2026-08-13, under the first window)* → `Tests 1 failed | 6 passed (7)`, failing at
  `packaging.test.ts:74` with `bin/helix-mcp.mjs is stale — run npm run build and commit bin/`.
  **This test is what proves the rebuild reproduced** — in either direction.

  > ### MEASURED 2026-08-27 — THE PREDICTOR ABOVE IS INVERTED. Use the corrected line below.
  >
  > The block above is left byte-identical because what it predicts is the finding. On 2026-08-27,
  > `git diff --quiet $CANDIDATE HEAD -- bin/` succeeded and printed `E1 GREEN expected` — `bin/`
  > has not moved since the candidate and cannot, inside the window — while the test itself was
  > RED: `Tests 1 failed | 6 passed (7)`, the failing case at `packaging.test.ts:70:81` with `bin/ is
  > stale — run npm run build and commit bin/` and all five bundles listed as stale. The test
  > rebuilds `src/` and compares the REBUILD against `bin/`; the predictor compares `bin/` against
  > the candidate. Those agree only while `src/` has not moved, and it has — 37 post-candidate
  > `src/` commits, 21 files, +1142/−217, and `package-lock.json` too. So this predictor says GREEN
  > for the whole window whatever the test does, which is the direction that sends an operator
  > hunting for a cause that is on this sheet.
  >
  > ```bash
  > git diff --quiet $CANDIDATE HEAD -- src/ build.mjs package-lock.json && echo "E1 GREEN expected" || echo "E1 RED expected"
  > ```
  >
  > *(observed 2026-08-27: `E1 RED expected`, agreeing with the test.)* The three paths are the
  > rebuild's inputs — the source, the bundler script, and the lockfile that decides the dependency
  > bytes (`62a3c67` pinned `fast-uri` 3.1.5 through it). This line errs only in the harmless
  > direction: a comment-only `src/` commit makes it say RED while `legalComments: 'none'` keeps the
  > test GREEN — the `5797346` case the paragraph above describes — and a green E1 needs no
  > explanation. It predicts a test's colour and produces nothing the chain consumes, so it is a
  > sheet correction and not method tooling. The rehearsal note above is corrected the same day:
  > the failing case now sits at `packaging.test.ts:70` (the rebuild-and-compare moved to
  > `test/helpers/bundle-freshness.ts:32-44`, `staleBundles`, imported at `:5`), and its message is
  > `bin/ is stale — run npm run build and commit bin/`, listing every stale bundle, not
  > `bin/helix-mcp.mjs is stale …`.

- [ ] **E2. `test/output-vocabulary.test.ts` — flips red AT `txClose`.**
  `expected = Date.now() > freezeWindowClosesAt() ? {} : ALLOW`, with
  `ALLOW = { 'docs/release/o67-class-rule-2026-07.md': 3 }` and the instant read from the signed
  receipt's own `payload.txClose` rather than typed in. Green today
  *(rehearsed 2026-08-13 → `Tests 2 passed (2)`)*; red from the close instant until D2 removes the
  3 citations. **The fix is the removal, not the date.**

- [ ] **E3. WITHDRAWN 2026-08-25 — the gate this step describes no longer exists. Do not expect
  a red flip here.**

  **What it used to say, and why it is unsupported now.** The step read:
  "`test/acceptance/trust-store-home.e2e.test.ts` — auto-RESUMES at `txClose`.
  `itUnlessFrozenBundle = frozenBundleWindowOpen() ? it.skip : it`, and `frozenBundleWindowOpen()`
  reads the same `payload.txClose` from the receipt. **3** `itUnlessFrozenBundle` sites expand to
  **5** skipped cases (one sits inside a per-adversary loop). *(rehearsed 2026-08-13)* →
  `Tests 3 passed | 5 skipped (8)`. These cases drive the **shipped bundle** `bin/helix-mcp.mjs`,
  so at `txClose` they un-skip against a *stale* bundle and will fail until Block F rebuilds it.
  Expect: skip → red → green, in that order."

  **Measured 2026-08-25.** `itUnlessFrozenBundle` and `frozenBundleWindowOpen` have **zero**
  occurrences anywhere in `src/`, `test/` or `scripts/`. Commit `ea2dc1e`
  (2026-08-19T15:21:01+09:00, *"retire the frozen-bundle gate, and restore the five startup cases
  it suspended"*) removed the gate **inside this window** and un-suspended the five cases. The file
  runs today and reports `Tests 8 passed (8)` — no skips, and nothing waiting on `txClose`.

  **Consequence for close day: there is no third red flip.** Block E is headed "THE THREE
  SIMULTANEOUS RED FLIPS"; on the measured state it is two. A red in this file on close day is a
  **real** failure, not a scheduled one, because nothing here is gated on the close instant any
  more.

  **Nothing is being restored.** Reinstating the gate would be a code change inside the window for
  no measurement benefit; the five cases have run green since `ea2dc1e`, which is more coverage
  than the gate allowed, and the source-level cases in `test/memory/trust-store-layout.test.ts`
  carried the behaviour throughout in either case.

- [ ] **E4.** Run the full suite once and compare the failure set against the DATED MEASUREMENT
  below: `cd ~/dev/helix && npm test`.

  **Compare against a measurement, not against a prediction.** *(Reworked 2026-08-25, after E3's
  prediction was found unsupported and Block B's was found inverted. A predicted set authored now
  for a suite run three weeks from now is a guess; a dated measurement plus a re-measurement is
  evidence.)* The instruction is therefore: **re-run the suite immediately BEFORE close day and
  record that result too**, then compare close day's set against the most recent recorded one. A
  set that matches is uninformative on its own; a set that DIFFERS is the finding.

  **Measured 2026-08-25 at `742b096`, on the development tree:**
  `Test Files 5 failed | 185 passed | 2 skipped (192)` / `Tests 6 failed | 2479 passed | 2 skipped
  (2487)`. The six, by name — count them by name, never by number:

  1. `test/acceptance/project-ledger.e2e.test.ts` › *a projectRoot that names nothing is refused, so
     the prompt always has a target to show*
  2. `test/docs/shipped-claims.doc.test.ts` › *the shipped bundle is a byte-identical rebuild of the
     source these pins execute*
  3. `test/inventory/extract-tools.test.ts` › *carries description and input schema, not just names*
  4. `test/inventory/extract-tools.test.ts` › *removes the temporary home it created, so a run
     outside vitest does not accumulate them*
  5. `test/inventory/inventory-drift.test.ts` › *matches the committed snapshot exactly*
  6. `test/plugin/packaging.test.ts` › *rebuilding from src reproduces bin/ byte-for-byte*

  **All six share ONE cause, and that is what makes the set readable.** `bin/` is pinned to the
  candidate and must not be rebuilt during the window, while `src/` has moved; every one of these
  compares the shipped bundle against the source (`compareSurfaces` at
  `scripts/inventory/extract-tools.ts:141` throws `tool-surface-disagreement` when the two differ,
  and 1/2/6 compare bundle to source directly). **They are the freeze's own signature, and Block F's
  rebuild is what clears them.** So the operative test on close day is not "are there six" but:
  *does every failure trace to bundle-versus-source?* One that does not is real.

  **Re-measured 2026-08-27 at `eddf313`, on the development tree:** identical totals — `Test Files
  5 failed | 185 passed | 2 skipped (192)` / `Tests 6 failed | 2479 passed | 2 skipped (2487)` — and
  the same six by name; `inspect-asof` did not flake; `/tmp/helix-testrun-*` counted 0 before and 0
  after. One residue the suite leaves BY DESIGN, which this sheet had not named:
  `/tmp/helix-demote-probe/probe.txt` (35 bytes, created by `test/memory/compaction.test.ts:401`,
  never swept — boot-wiped).

  **E1 is conditional** — it appears only if `git diff --quiet $CANDIDATE HEAD -- bin/` FAILS (see
  E1; measured 2026-08-25 that diff is still empty, so E1 is green and #6 above is the source-side
  form of the same fact). E1 disagreeing with the `git diff` in either direction is a real failure,
  and would mean the rebuild is not reproducing what the committed bundles contain.
  *(Corrected 2026-08-27: the paragraph above repeats E1's inverted predictor. #6 IS E1's case —
  one test, `packaging.test.ts:70` — and on 2026-08-25 and 2026-08-27 it was RED with that `bin/`
  diff EMPTY, so "E1 is green" was false on the day it was written. Read E1's corrected predictor;
  the operative test is unchanged — every failure must trace to bundle-versus-source.)*

  **D2's effect on the set:** D2 removes the 3 citations, so `test/output-vocabulary.test.ts` is
  already green again by the time you get here on this sheet's order. Running Block E before D2 adds
  E2 to the set.

---

## Block F — REBUILD + REDEPLOY (absent from the procedure doc; do not skip)

**This block is much smaller than it was, and the reason is worth reading before you run it.**
Under the first window ~62 commits touching `src/` had piled up behind the candidate and would all
have reached the runtime here, in one step, on a one-shot day. The reset moved that rebuild to
BEFORE the window: `bin/` was rebuilt at `d581e7e` and deployed with the candidate, so the second
window's 28 days are real-use verification of exactly those bytes. Measured 2026-08-14:
`git log --oneline $CANDIDATE..HEAD -- src/ | wc -l` → **0**. Re-measure it at the close — this
block now carries only whatever source work accrued INSIDE the second window, and if that count is
still 0 the rebuild is a no-op that should reproduce `bin/` byte-for-byte.

**Re-measured 2026-08-27: the count is 37, and the rebuild is NOT a no-op.** `git log --oneline
$CANDIDATE..HEAD -- src/ | wc -l` → **37**; `git diff --stat` → 21 files, +1142/−217;
`package-lock.json` has moved as well; `bin/` has not. F1's build was rehearsed through its seam —
`npm run typecheck` (exit 0), then `HELIX_BUILD_OUT=<scratch> npm run build` (exit 0; `build.mjs`
reads that variable as its only output root) — and all five bundles it produced DIFFER from the
committed `bin/` (`cmp`), while the committed `bin/` stayed byte-identical (`sha256sum -c` OK,
porcelain empty). Close day's F1 will rewrite all five files; F2 is what proves the rewrite
reproduces from the source it shipped. `npm ci` and `npm test` were not rehearsed in the
development tree: the first rewrites its `node_modules`, which a rehearsal inside the window may not
do, and the second is E4's own full run, taken once above.

Until this block runs, any second-window source fix is **FIXED IN SOURCE, OPEN IN DEPLOYMENT**.

Do not start Block F before the close receipt exists (D1) — a rebuilt `bin/` reaches the running
runtime through the marketplace clone, which is exactly what the window forbade.

- [ ] **F1. Rebuild, gated on the FULL suite.**

  ```bash
  cd ~/dev/helix && npm ci && npm run typecheck && npm run build && npm test
  ```

  **`npm test`, not the packaging test alone.** The first window's draft gated this step on
  packaging-freshness only, which answers "does `bin/` match `src/`" and nothing about whether the
  code works; the suite is what stands between an accumulated source backlog and the live runtime.
  Measured 2026-08-14 on the pre-window rebuild: 2215 pass, 0 fail *(corrected 2026-08-27 — this
  line said 2217; the deviations ledger's `D-2026-08-13-in-window-tooling` entry and the close report
  both record 2215 for that gate, and this sheet was the lone dissenter)*. A failure here stops the
  redeploy — the close receipt is already written by then, so the measurement is safe either way,
  and shipping is the part that waits.

  Success: `bin/*.mjs` regenerated. `npm run build` does **not** typecheck — run both.

- [ ] **F2. Prove the rebuild reproduced.**

  ```bash
  npx vitest run test/plugin/packaging.test.ts
  ```

  Success: **7 passed** (E1 clears). Refusal: still failing at `:74` → the bundle does not
  reproduce; do not deploy it.
  *(Corrected 2026-08-27: the case is at `packaging.test.ts:70` now and its message names every
  stale bundle — see E1. Success branch rehearsed 2026-08-27 inside a candidate checkout with its
  own offline-installed `node_modules`: `Tests 7 passed (7)` in 515 ms, the freshness helper
  building into its own temp dir and `bin/` untouched — the branch where candidate `src/` equals
  candidate `bin/` by construction, which is the state F1 is meant to restore for HEAD.)*

- [ ] **F3. Commit `bin/` AND PUSH IT**, together with the source it was built from (owner approval
  required per the repo's git agreement — the controller commits, not the run-sheet). The push is
  not optional and not a later chore: `deploy-runbook.md:41-44` makes it **step 0** of the
  procedure, because the marketplace clone serves from `origin`. Install before pushing and you
  redeploy the old bytes, then spend F5 diagnosing a stale sha you created.

- [ ] **F4. Same-version redeploy = UNINSTALL + INSTALL.** Never `plugin update` for the same
  version — the version-keyed cache makes an update a no-op. The runbook's sequence is **three**
  commands and the middle one is easy to drop:

  ```bash
  # 0. F3 already pushed the commit you intend to serve; note its sha.
  claude plugin uninstall helix
  claude plugin marketplace update helix
  claude plugin install helix@helix
  ```

  Follow `docs/release/deploy-runbook.md` exactly. If the sha comes back stale (auto-update race),
  repeat all three.

- [ ] **F5. The 3-sha, both-load-path verification — of the NEW build.** *"Staleness is
  `gitCommitSha`, never `version`."* Confirm the installed entry's `gitCommitSha`, the marketplace
  clone's HEAD and the commit you intended to deploy are **all three equal**, and that the bundle
  bytes are **identical across both load paths** — the marketplace clone
  (`~/.claude/plugins/marketplaces/helix`) and the version-keyed cache directory
  (`~/.claude/plugins/cache/helix/helix/0.1.0`). Use C11's commands with the F3 commit as the
  expected value — in the enumeration that means assigning `CAND` the commit F3 pushed instead of
  reading it from the freeze receipt, since the receipt names the candidate and this check is about
  the new build. **Enumerate every entry here too**: the redeploy writes the user-scope entry, and
  a local-scope entry for another project can be left behind naming the old commit.
  **This step does NOT discharge §10.** It records that the *post-close* deployment was brought
  current, which is a different claim: by now both load paths carry the rebuilt bundle and
  `installed_plugins.json` names the new commit, so nothing here can show what the *measurement*
  ran against. §10's "the runtime pin is verified again at the close" is discharged by **C11**,
  observed before D1 while the measured deployment still existed. Record both results in the
  report, under their own headings, and do not let them merge.

- [ ] **F6. Launch barrier.** Config and plugin bytes bind at CLI process start; `/clear` does not
  restart the MCP server. Verify from a **new** CLI process.

---

## Block G — guard teardown

Every item here removes a control the freeze installed. `CLAUDE.md`'s ACTIVE FREEZE section
mandates the set; this block is its execution.

- [ ] **G1. Restore BOTH `autoUpdate` flags to `true`.** One is not enough — the guard checks both,
  and the 08-09 deviation was found because they disagreed.
  - `~/.claude/settings.json` → `.extraKnownMarketplaces.helix.autoUpdate`
  - `~/.claude/plugins/known_marketplaces.json` → `.helix.autoUpdate`

**These are the operator's own live settings files, not chain artifacts — back them up and write
them atomically.** The earlier form here passed `open(p,'w')` straight to `json.dump`, which
truncates the target *before* serialising: an exception mid-write leaves settings.json as invalid
JSON with its tail gone. *(measured 2026-08-13 on a copy: a serialisation error partway through left
the file ending at `"boom": ` — the original content after that point was simply gone.)* `os.replace`
onto a temp file cannot do that, because the original is only unlinked once the new file is complete.

**Paste this block from column 0** — indented, python takes the leading spaces as an indent and
dies on `IndentationError` before touching either file.

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.pre-close-bak
cp ~/.claude/plugins/known_marketplaces.json ~/.claude/plugins/known_marketplaces.json.pre-close-bak
python3 - <<'PY'
import json, os
for p, path in [(os.path.expanduser('~/.claude/settings.json'), ['extraKnownMarketplaces', 'helix']),
                (os.path.expanduser('~/.claude/plugins/known_marketplaces.json'), ['helix'])]:
    d = json.load(open(p)); n = d
    for k in path: n = n[k]
    n['autoUpdate'] = True
    tmp = p + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(d, f, indent=2)
        f.write('\n')
    os.replace(tmp, p)          # atomic: the original survives any failure above this line
    print(p, '->', n['autoUpdate'])
PY
python3 -c "import json,os;print('settings.json    :', json.load(open(os.path.expanduser('~/.claude/settings.json')))['extraKnownMarketplaces']['helix']['autoUpdate'])"
python3 -c "import json,os;print('known_marketplaces:', json.load(open(os.path.expanduser('~/.claude/plugins/known_marketplaces.json')))['helix']['autoUpdate'])"
```

  *(rehearsed 2026-08-13, pasted verbatim against copies of both files under a throwaway `HOME`)*
  → both paths printed `-> True`, and the two re-read lines printed `True` / `True`; the live files
  were confirmed still `False` afterwards. On close day it runs against the real pair.

  Success: the two re-read lines both print `True`. The backups are kept until G4 has confirmed the
  guard still passes; delete them only then. Note this rewrites both files with `indent=2` and a
  trailing newline regardless of how they were formatted before — cosmetic, but it will show up in
  any diff the owner takes afterwards.

- [ ] **G2. Remove the `~/.bashrc` freeze-guard wiring — lines 129-131** (verified 2026-08-13: the
  comment `# v2 freeze guard (remove after validated close — …)`, `export DISABLE_AUTOUPDATER=1`,
  and the interactive-shell `case $- in *i*) …` line that invokes
  `scripts/freeze-runtime-check.sh` by absolute path).
  Success: `grep -n "freeze\|DISABLE_AUTOUPDATER" ~/.bashrc` prints nothing.

- [ ] **G3. Remove the systemd drop-in and reload.** Verified present at
  `~/.config/systemd/user/helix-dogfood.service.d/freeze-guard.conf`, carrying
  `Environment=DISABLE_AUTOUPDATER=1`, `UnsetEnvironment=FORCE_AUTOUPDATE_PLUGINS` and the
  `ExecStartPre=… freeze-runtime-check.sh`.

  ```bash
  rm ~/.config/systemd/user/helix-dogfood.service.d/freeze-guard.conf
  rmdir ~/.config/systemd/user/helix-dogfood.service.d 2>/dev/null
  systemctl --user daemon-reload
  systemctl --user show helix-dogfood.service -p ExecStartPre -p Environment
  ```

  Success: no `freeze-runtime-check.sh` in `ExecStartPre`, no `DISABLE_AUTOUPDATER` in
  `Environment`.
  **A masked unit reports empty properties**, so while step 0.6's mask is still in force this
  check passes vacuously. **Re-run the `show` line after G6's unmask** and read it there; that
  reading is the one to record.

- [ ] **G4. Close receipt already written in D1** — confirm it still validates after G1–G3:
  `bash ~/dev/helix/scripts/freeze-runtime-check.sh; echo exit=$?` → **exit 0, silent**. (With the
  receipt valid the guard exits at step 0 and never reaches the flag checks, so G1 cannot make it
  red; if it *is* red, the receipt is the problem.)

- [ ] **G5. Count the auto-heals for the report.**

  ```bash
  cat ~/.cache/freeze-guard-heals.log
  ```

  *(rehearsed 2026-08-13)* → **3 heals**: `2026-08-11T15:08:16Z` (from `b4997cd9…`),
  `2026-08-12T14:41:24Z` and `2026-08-13T04:08:31Z` (both from `0bbb000a…`), each reset to the
  candidate. Re-read on close day — the count may have grown. The §9a report's deviation history
  must carry the final number and the lines verbatim.
  *(re-read 2026-08-27: **12 lines** — the three first-window heals above, to `27b4373…`, and nine
  second-window heals to `94dd136…`, 2026-08-16 through 2026-08-27; line 12,
  `2026-08-27T01:59:19Z healed eddf313… -> 94dd136…`, is the unit's boot heal — the first
  `ExecStartPre` heal since instance 1 (deviations ledger, Instance 10). The ledger's instance count
  runs one ahead of the second-window heal count, because instance 4 (2026-08-19) was remediated by
  hand and wrote no log line. Read the ledger for attribution; read this file for the count.)*

- [ ] **G6. Unmask and restart the dogfood units** — the other half of step 0.6's write freeze.
  Run this **after F4/F5** have redeployed, so the first run after the close serves current bytes.

  ```bash
  systemctl --user unmask helix-dogfood.timer helix-dogfood.service
  systemctl --user enable --now helix-dogfood.timer
  systemctl --user is-enabled helix-dogfood.timer
  systemctl --user list-timers --all | grep helix-dogfood
  ```

  Success: `is-enabled` prints `enabled` and `list-timers` shows a NEXT at the following
  09:00 KST.

  > ### REHEARSED 2026-08-25 — `systemctl --user unmask` DOES NOT REVERSE 0.6's corrected mask.
  >
  > The block above is left byte-identical, because its first line failing silently is the finding.
  > `systemctl --user unmask helix-dogfood.timer helix-dogfood.service` **exited 0 and removed
  > nothing** — neither the `user.control` symlinks 0.6 creates nor the `/run` ones a stray
  > `mask --runtime` would leave. `unmask` only looks where `mask` writes, and 0.6's corrected mask
  > does not live there. **An operator checking exit codes would read that as a successful
  > reversal, then leave the daily run dead.** Remove the symlinks by hand:
  >
  > ```bash
  > rm -f ~/.config/systemd/user.control/helix-dogfood.timer \
  >       ~/.config/systemd/user.control/helix-dogfood.service
  > rmdir ~/.config/systemd/user.control 2>/dev/null || true   # 0.6 created it; leave it only if other units live there
  > systemctl --user daemon-reload
  > systemctl --user enable --now helix-dogfood.timer
  > systemctl --user is-enabled helix-dogfood.timer
  > systemctl --user list-timers --all | grep helix-dogfood
  > ```
  >
  > **Order is forced, not stylistic:** `enable` is REFUSED while the unit is masked (*"Failed to
  > enable unit: Unit file … is masked"*), so the symlinks must go first. Observed 2026-08-25 after
  > this block: `is-enabled` → `enabled`, `list-timers` → NEXT at the following 09:00 KST,
  > `LoadState=loaded` with `FragmentPath` back on the real fragment, and the persistent stamp
  > unchanged, so **no catch-up fired on the restart** — the stamp was newer than the last elapse.
  > Verify against a state you captured BEFORE 0.6, field by field; that is what caught the
  > leftover `/run` symlink on the rehearsal.

  The daily run is a freeze-era control's *victim*, not the control: leaving it masked would be a
  silent, permanent change made by the close. `Persistent=true` means the first firing after the
  unmask may be an immediate catch-up — that is expected, and it is now safely after C1.2.

- [ ] **G7. Delete the ACTIVE FREEZE section from `CLAUDE.md`** (local-only, never committed).

- [x] **G8. Pinned-src disposition — DISSOLVED by the re-freeze. Write nothing.** *(Corrected
  2026-08-17. This step ordered a new deviation-ledger entry disclosing 6 pinned `src/memory` files
  modified in-window. That was a FIRST-window obligation and the re-freeze extinguished it: the new
  candidate contains those six files and re-pins them at their current bytes, so no in-window
  pinned-edit history remains to disclose.)*

  The dissolution is already recorded — `docs/release/v2-freeze-deviations-2026-08.md`,
  `D-2026-08-13-in-window-tooling`, under "Two things the reset paid for rather than cost":
  *"The pinned-source disclosure question the first window carried … does not exist in the second
  window, because the new candidate contains them and the re-freeze re-pins them where they are."*
  Report §4.4 carries the same measurement and is titled DISSOLVED. **Do not write a new entry**: a
  first-window disclosure dated after 2026-08-14 would be false history AND would be swept up by
  §4.7's marker, which asks for entries appended after that date.

  *(The old step also cited "the divergence measured in Block B" as its input. Block B's divergence
  was the first window's. **Corrected 2026-08-25:** the current intersection of changed paths with
  the 28 pins is not empty either — it is `src/memory/ownership.ts` + `src/memory/store.ts`, the
  drift adjudicated at `R-2026-08-18`. That is a SECOND-window fact, so it still does not belong in
  a first-window disclosure and the instruction not to write a new entry stands, on the corrected
  premise rather than on an empty intersection. This was the only step that consumed that
  measurement, so correcting Block B leaves no dangling reference.)*

---

## Block H — final sweep, then publish

- [ ] **H1. No unfilled markers survive.** Count the **opening delimiter**, not the bare phrase:
  the phrase also occurs in the report's own front-matter line explaining the grep, so a
  phrase-count can never reach 0 until H2 has run — an ordering trap in the final sweep.

  ```bash
  cd ~/dev/helix
  R=docs/release/v2-close-report-2026-08.md
  grep -n '<<FILL AT CLOSE' $R
  echo "openings=$(grep -c '<<FILL AT CLOSE' $R)  closings=$(grep -c '>>' $R)  bare-phrase=$(grep -c 'FILL AT CLOSE' $R)"
  ```

  *(rehearsed 2026-08-13, twice as the draft grew — the invariant, not the number, is what to
  check: openings `<<FILL AT CLOSE` and closings `>>` are **equal**, and the bare phrase exceeds
  them by exactly **1**, the front-matter line at report:14 that H2 deletes. Measured **59 / 59 /
  60** on 2026-08-17, after §4.4's dissolved marker was removed; it read 60 / 60 / 61 when
  rehearsed 2026-08-13. The absolute count moves with every edit to the draft, so re-measure rather
  than compare against a number written here — the two readings are given precisely to show that
  the NUMBER is not the invariant.)*

  *(One limitation of the command as written, so it is not mistaken for a stronger check: `grep -c`
  counts LINES, not occurrences. Today every marker is alone on its line and the two agree, but a
  close-day fill whose transcribed content itself contains `>>` would break the identity silently.
  If a filled value would contain `>>`, count with `grep -o … | wc -l` instead.)*
  **REFUSE TO PUBLISH while the opening count is above 0.** A report containing one of these
  markers is incomplete by construction. An opening count that differs from the `>>` count means a
  marker was half-deleted — find it before anything else.

- [ ] **H2. Delete the report's operator front-matter comment block and the 3-line DRAFT banner.**
  Then re-run H1's grep: with the front matter gone, the bare-phrase count and the delimiter count
  agree, and both must be 0.

- [ ] **H2b. Retain the chain — `~/close-run/` is NOT retention.** §9 makes reconstructability from
  **retained** evidence a gate condition (`v2-preregistration-2026-07.md:385`) and a failed run
  "is preserved and reported" (`:539`); `docs/` is gitignored except `docs/release/`, so leaving
  the artifacts in a home directory retains nothing an outside reader can check. Two dispositions,
  and they are different because one set contains key material:

  - **The non-secret chain** — `manifest.json`, `classifier.json`, `classifier.universe.json`,
    `pins.json`, `gate-set.json`, `ordering.jsonl`, `run1-3.json`, `adjudication.json`,
    `score.json`, `score2.json`, `release-record.json`, **`snapshot-hashes.txt`** and the 0.1
    transcript. Retain **two copies**: the working set stays in place, and a durable copy goes to
    the same off-machine location Q4's backup uses (name it in the report; do not write the literal
    path into a tracked file).
  - **`snapshot-hashes.txt` belongs to the NON-SECRET set, and it is the one file in it whose
    bucket needs saying out loud.** It is C1.5's per-file listing — the thing report §3 names as
    what §9 element 2 is reconstructed from — so retaining the composed hash without it leaves
    element 2 anchored to a value nobody can decompose. It lists the snapshot's *digests*, never
    its bytes: the ledger signing key appears in it only as a sha256 of itself, which discloses
    nothing the composed hash does not already. Its paths are relative (`./home/…`,
    `./proj/.helix/…`) because C1.5 runs `find .` from inside the snapshot, so it carries no
    private absolute path either. The **snapshot directory** stays offline; its **listing** travels
    with the chain.
  - **The snapshot is NOT retained in the open.** `~/close-run/snapshot/home/` holds the ledger
    signing key, `witness.json` and the config (C1.2). It is retained **offline only**, at a
    location named to the owner and not published; the report records its **sha256** (C1.5) as the
    reconstructable anchor, which is exactly what §9 element 2 asks for.
  - **Into the repository goes an INDEX, not the artifacts.** Write
    `docs/release/v2-close-evidence-index-2026-08.md`: one row per artifact — filename, byte size,
    `sha256`, and a described (not literal) location for each of the two copies.

  ```bash
  cd ~/close-run && sha256sum manifest.json classifier.json classifier.universe.json pins.json \
    gate-set.json ordering.jsonl run1.json run2.json run3.json adjudication.json \
    score.json score2.json release-record.json snapshot-hashes.txt
  ```

  **The 0.1 transcript is deliberately NOT in that command, and it is not an omission.** You are
  still inside the capture shell here, so the transcript is still being written — hashing it from
  in there does not describe the file anyone will retain. *(Measured 2026-08-13: `sha256sum` of the
  log from inside its own `script` session returned
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` — the sha256 of an **empty
  file** — while the same command after the capture closed returned a different, real digest, and a
  different one on each of two runs because the log ends with its own timestamp.)* **H7 closes the
  capture and hashes it there**; its value fills the transcript's row in the index and report §6's
  transcript marker. Leave the row in the index with its hash pending until H7, then fill it and
  re-run the lock — this is why H7 sits after the sweep rather than at the end of Block C.

  - [ ] **`git add` the index FIRST, then run the two locks.** Tracked files under `docs/release/`
    may not carry a literal `/home/<user>` or `/mnt/c/Users/<user>` path — the only allowlisted
    file is the freeze receipt itself (`PRIVATE_ALLOW`, `test/output-vocabulary.test.ts`). The
    chain artifacts DO contain absolute paths (snapshot directory, config path), which is the
    reason this step commits an index and not the artifacts.

    **Both locks shell out to `git grep`, which searches tracked content only** — run against a
    file git does not know about, they pass while seeing nothing. *(measured 2026-08-13:
    `git grep -c 'FILL AT CLOSE' -- docs/release/` exits 1 with no output, while `grep -c` on the
    still-untracked report counts **61** — the same bare-phrase reading H1 records for that day,
    and the point is the 61-versus-nothing gap, not the number, which moves with every edit to the
    draft.)* A lock run before `git add` proves nothing:

    ```bash
    cd ~/dev/helix
    git add docs/release/v2-close-evidence-index-2026-08.md \
            docs/release/v2-close-report-2026-08.md docs/release/v2-close-checklist-2026-08.md
    git ls-files --error-unmatch docs/release/v2-close-evidence-index-2026-08.md   # proves it is now visible
    npx vitest run test/output-vocabulary.test.ts
    ```

    Success: the `ls-files` line echoes the path (not `did not match`), then 2 passed. Refusal: a
    new file in the `got` map → strip the path from the index; do not extend the allowlist.
    (Staging is not committing — the commit itself still needs the owner's per-change approval.)
  - [ ] **UNREHEARSED** — every input needs the close-bounded snapshot. The `git grep`/`git add`
    ordering above, however, was measured on 2026-08-13 and is not.

- [ ] **H3. Confirm the report carries all of §9a's required content**: the freeze commit and every
  §10 pinned hash *plus the pins re-verified at the close*; cutoff and close with the
  `cutoff < tx ≤ close` demonstration; the prepared-artifact hash with its pre-run timestamp and
  the ordering evidence; the full reset-and-deviation history (including G5's heal count, the
  **first window's RESET over the in-window producer**, and the **dissolution** of both the
  pinned-src disclosure (G8, report §4.4); and — **corrected 2026-08-18, because the statement this
  line used to ask for is no longer available** — the DISPOSITION of `R-2026-08-18` rather than a
  blanket "no post-freeze method tooling was built inside the SECOND window". Something was: an
  in-window recomputation of two frozen rules, ruled NOT A RESET on 2026-08-18 on the ground that
  it issues no §9-chain artifact. Acquire the disposition, its conduct findings, and the second
  instance the entry names — the home-machine pin script's in-window v3 rewrite, **adjudicated at
  `R-2026-08-18b` the same day, NOT left for the close**, and carrying a 2026-08-24 amendment that
  re-measures that ruling's grounds against the script's current v3.4 bytes and corrects one of its
  conduct findings. *(Corrected 2026-08-24: this line called that instance "unadjudicated", which the
  deviations ledger's own text had already stopped saying.)* A blanket denial would now be false
  (A4)); evidence the declared
  consequence was actually applied; the D5 disclosures in full, not by reference; and the
  §1 claim + coverage statement **verbatim alongside every reported number**.
  Also confirm the report carries **Block A's outcomes**: the home-machine pin report or the
  explicit statement that the second machine's pins were never observed (A1 — it cannot be
  reconstructed after the close), and the open/closed status of Q1, Q2 and Q4 (A2, A3).
  *(Corrected 2026-08-17. This paragraph also demanded "the ledger entry id for the owner's §8
  ruling on the in-window producer (A4), which report §4.6's one remaining marker asks for", and
  called A4 the one Block A item that cannot be reported open. Three things in that were false:
  the ruling's ledger entry exists (`D-2026-08-13-in-window-tooling`, committed 2026-08-14 at
  `3bd63d0`); **report §4.6 contains ZERO markers** — the single marker in that neighbourhood was
  §4.4's, about the pinned-src disclosure, and it is removed as dissolved; and A4 is discharged
  rather than owed. Nothing in Block A now blocks publication.)*
  *(Corrected 2026-08-27: the 2026-08-24 amendment clause above was unsatisfiable as the report
  stood — measured 2026-08-27, the report contained ZERO occurrences of `2026-08-24`, and its
  `R-2026-08-18b` paragraph (§4.8) carried no marker that would pull the amendment in at the close.
  The amendment paragraph was folded into §4.8 the same day, so this confirmation now checks a
  paragraph that exists; the six one-marker-one-home checks below all passed on the same reading.)*
  And confirm these six, each of which has exactly one marker and no second home in the report:
  - the **close-day interpreter** (§2.3) — 0.3's two version lines;
  - **where the chain ran from, with the exception** (§2.3) — 0.2's `rev-parse` plus BOTH readings
    of 0.5, not a bare "ran from the checkout". The exception is now ONE step (0.4 freeze-guard),
    and the report states it as structural — the receipt cannot exist at the candidate — not as a
    file that happens to post-date it;
  - the **runtime-pin observation** (§2.3) — C11's four values, and separately §10's post-redeploy
    "brought current" record. Two headings, never merged;
  - **retention** (§10) — the described off-machine and offline locations, and the evidence-index
    filename (H2b);
  - the **transcript's path and sha256** (§6) — from H7, taken after the capture was closed, never
    from inside it;
  - `o67-class-rule-2026-07.md`'s **post-D2 sha256** (§2.2), alongside its pinned value.

- [ ] **H4. State the two structurally always-pass conditions in their own detail.** *Errors /
  unscorable* and the mechanical half of *Protocol and population integrity* cannot appear as
  failures in a report that exists at all, because every pipeline check fails closed. Name where
  their evidence actually lives: the freeze receipt, the as-of-close snapshot hash, and the
  append-only prepare-before-run receipt.

- [ ] **H5. Record where the chain ran from — with the exception, not without it, and not with one
  that no longer exists.** The claim that survives scrutiny is: *every pinned measurement step
  (C2–C8, C9, C9b, C10 — every step that runs a pinned tool; C8 executes one but measures nothing)
  ran from a clean checkout of the candidate commit; ONE pre-chain helper —
  `npm run freeze-guard` (0.4) — ran from the development tree, because the receipt it reads is
  issued against the candidate and so cannot exist inside it, under the byte-identity check of step
  0.5, whose output is recorded.* Do **not** write "the whole chain ran from the candidate
  checkout": it is false, and a false clause in the clean-checkout evidence is worse than the
  exception it hides. Equally, do **not** carry the old two-helper wording: the re-freeze moved the
  adjudication skeleton into the candidate, so C8 runs in the checkout and naming it as an
  exception overstates the departure. Paste step 0.5's output and step 0.2's `rev-parse` + empty
  `status --porcelain`. *(Corrected 2026-08-17 — this step said "two post-candidate helpers … C8 …
  because they do not exist at the candidate"; C8's files do exist at `94dd136`.)*
  *(Corrected 2026-08-27: the clause "under the byte-identity check of step 0.5, whose output is
  recorded" overstates what 0.5 licenses — 0.5 does not walk `src/memory`, and the guard reaches
  `src/memory/ownership.ts`, which differs from its pin in this window (0.5's 2026-08-25
  correction). The exception rests on the guard re-hashing the candidate's own blobs through git and
  on that drift being adjudicated at `R-2026-08-19`; paste 0.5's output as evidence of what it does
  cover, not as the licence. Rehearsed 2026-08-27 on a copy of the report: the line-174 marker
  replaced with 0.2's `rev-parse` + empty `status --porcelain` and 0.5's reading, the checkout
  written as `~/close-candidate`; 58 markers remained and `PRIVATE_RE` found 0.)*

- [ ] **H6. Remove the candidate worktree** (Block B, step 0.7) and run `npm test` once more:
  green except for anything genuinely open.

- [ ] **H7. CLOSE THE TRANSCRIPT, THEN HASH IT — the last command of the close, and the only one
  that must NOT run inside 0.1's shell.** Step 0.1 started `script` before anything else and every
  step since has run inside it; nothing until now has ended it. Report §6 asks for *"the path of
  the captured transcript file and its sha256"*, and that pair cannot be produced from within the
  capture: the file is still open, still being appended to, and the very command that hashes it is
  written into it afterwards.

  *(Measured 2026-08-13, twice: `sha256sum` run on the log from inside its own `script` session
  printed `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, which is the sha256
  of an **empty file**; run again from a plain shell after the session closed it printed a real
  digest, and a different one on each of the two runs — the log's last line is its own closing
  timestamp. An in-shell hash is not merely stale, it describes nothing.)*

  Type `exit` (or Ctrl-D) at the transcript shell's prompt. You land back in the shell that started
  0.1, `script` prints its `Script done on …` line, and the file is final. Then:

  ```bash
  ls -l ~/close-run/close-day-transcript.log
  sha256sum ~/close-run/close-day-transcript.log
  tail -2 ~/close-run/close-day-transcript.log
  ```

  Success: `tail` shows the `Script done on …` line — that is what proves the capture is closed and
  the digest describes a finished file. Record the path and the sha256 in **report §6's third
  marker** (the one asking for the transcript's path and sha256); the same value fills the
  transcript's row in the H2b evidence index. Re-`git add` the index after filling it and re-run
  `npx vitest run test/output-vocabulary.test.ts` — the row changed after the earlier lock ran.

  **If the capture was never started, or was lost:** say so in §6 and in the index, and label §6's
  execution log a reconstruction with weaker provenance — the report already provides for that
  wording. Do not reconstruct a transcript and present it as a capture.

  A note on scope: everything §6 cites — *"from checkout creation through the release record"* —
  happened inside the capture, and so did Blocks D through H6. Closing it here costs the record
  nothing and is the only way the report's own marker can be filled.

---

## Refusal-code quick index

| code | raised by | first thing to check |
|---|---|---|
| `method-drift` | `input-pins` | tools/method-docs under the cwd differ from the receipt, or `~/.helix/config.json` bytes. NOT a wrong-tree detector since the re-freeze — see Block B |
| `scope-did-not-participate` | `candidate-universe` via `classify-o67` | `projects.json` realpath key (C1.3) |
| `degraded-run` | `prepare-gate`, `run-pilot` | same — project scope contributed nothing |
| `snapshot-after-close` | `prepare-gate` | a row later than `txClose` reached the snapshot |
| `adjudication-uncertain` | `score-gate` | a verdict is still `UNJUDGED` (C8) |
| `adjudication-incomplete` / `-duplicate` / `-unbound` | `score-gate` | the skeleton was hand-edited; re-stamp |
| `runs-not-distinct` / `stability-needs-three-runs` | `score-gate` | three separate run files, three separate executions |
| `gate-set-tampered` / `run-tampered` | producer + `score-gate` | the file's `payloadSha256` no longer describes its bytes |
| `consequence-not-applied` / `-overstated` / `-unevidenced` | `release-record` | `--consequence` / `--evidence` text — but `-unevidenced` fires ONLY on a field with no content; placeholder prose is accepted and signed in (C10) |
| `close receipt present but INVALID` | `freeze-runtime-check.sh` | the three fields of D1 |
| `output-exists` (exit 2) | every producer, incl. the skeleton and `score-gate` | name a NEW `--out`; the existing file must not be moved or deleted (C8, C9b) |
| `finish-without-start` | `ordering-receipt` | the `--run-id` label of C7 differs between the started/finished pair — and the log is hash-chained, so the line cannot be removed |
| `unknown-input` | `run-pilot` | a flag it does not take — there is no `--run-id` on the runner (C7) |
| `missing-input` / `usage:` (exit 2) | every CLI | a required flag is absent, or a path that post-dates the candidate was given relative to the checkout (R4, C4) |
| `ERR_MODULE_NOT_FOUND` (exit 1) | node | wrong tree for the step. Since the second freeze only `freeze-guard` (0.4) is dev-tree-only, and it fails on a MISSING RECEIPT rather than a missing module — this signature now means a chain step was run outside `~/close-candidate` |

**A refusal is a result.** Record it verbatim in the report and do not re-run to obtain a
different one (`v2-preregistration-2026-07.md` §11).
