# v2 close-day run-sheet — 2026-09-11T06:20:01.000Z

**This is a run-sheet, not an essay.** Tick boxes as you go, paste observed output next to the
step, and leave the file in the repository as the close-day log. The *why* behind every rule here
lives in `v2-close-procedure-2026-08.md` and `v2-preregistration-2026-07.md` §9/§9a — this
document does not repeat it, it executes it.

The deliverable is `docs/release/v2-close-report-2026-08.md` (§9a). Every step below either
produces evidence that report cites, or removes a control the freeze installed.

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
live units under a throwaway `HOME`, which proves the commands and not the close-day corpus. Two
steps are **UNREHEARSED by choice** and say so at the step: the 0.6 write freeze and its G6 reversal
(rehearsing would have taken the live dogfood run down mid-window). D1's `freeze-runtime-check.sh`
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
done at all (A1), or they stay open and the report says so (A2, A3) — with one exception: **A4 is a
ledger entry the report cites, and an unwritten entry blocks publication** rather than being
reported open.

- [ ] **A1. Home-machine pin verification** — prepared, needs a **transfer + one bash run** by the
  owner. Script: `docs/issues/2026-08-12-home-pin-check.sh` (strictly read-only: writes nothing,
  changes no git state, no heal/reset/pull; expected values are embedded so it needs neither the
  repository nor a network). Paired doc: `docs/issues/2026-08-03-freeze-pin-verification-home-machine.md`
  (**confirm the v2 banner** before running).

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

- [ ] **A3. Q4 helix-data backup — currently BLOCKED, do not tick it off with a plain tar.**
  Q4 (`c4-drills-2026-07.md`) owes *"one **encrypted**, physically separate snapshot of both
  units"*. `recovery-playbook.md` §6 ships **plain `tar -czf` commands only** — no encryption step
  anywhere in the section. The playbook therefore does not yet satisfy the drill it was supposed to
  carry the command for. Either add the encryption step to §6 and take the snapshot, or record Q4
  as open in the report. **Do not treat a plain-tar backup as discharging Q4.**

- [ ] **A4. The owner must RULE on the in-window producer's §8 disposition** — owed and **not yet
  made**, and the one Block A item that blocks publication rather than being reported open.
  `scripts/close/adjudication-skeleton.ts` was written 2026-08-13, inside the window, and the
  Reset paragraph of `v2-preregistration-2026-07.md` says building any of the method's tooling
  after the freeze **does** reset it — quote that sentence to the owner rather than summarising
  it, which is the discipline a first withdrawn ruling on this question established. Three courses
  are open: **RESET** (the main clause read as unconditional; this window ends); **DISCLOSURE**
  (the trailing clause read as limiting, so the rule does not reach a program that resolves no
  unspecified detail — report §4.6 sets out that case); or **do not use the producer at all** and
  hand-author the adjudication at C8, which removes the question rather than answering it and
  costs only the operator's time. Whatever is ruled is recorded in the ledger before publication.

  What is still owed is a new entry in `docs/release/v2-freeze-deviations-2026-08.md` recording the
  ruling, its date and its grounds — exactly as §4.4's pinned-src disclosure entry is owed and for
  the same reason: **§9a's deviation history cites the ledger rather than restating it**, so a
  report published without the entry cites nothing. Report §4.6's one remaining marker asks for
  that entry's id, so an unwritten entry is an unfilled marker, and H1 refuses to publish while any
  marker remains.

  This is the one Block A item that is not merely reported open if unexecuted. Deadline: **before
  the report is published**, which is earlier than close-day cleanup; H3 confirms it. Both owed
  ledger entries can be written in the same pass.

---

## Block B — Step 0: the tree the chain runs from

> The close chain runs from a **clean checkout of the candidate commit**, never from the
> development tree (`v2-close-procedure-2026-08.md`, "The rule").

That is the procedure doc's rule, quoted. It holds for every step that **measures** anything and
cannot hold for one pre-chain check whose input cannot exist at the candidate commit — read "Which
tree runs what" (after this block) before running anything, and never restate the rule without its
exception. The report's §2.3 carries the scoped version.

This is not ceremony. Measured at HEAD on 2026-08-13, the development tree **diverges from the
pins**: `src/memory/{ownership,retrieval,store,verified-projection,witness-core,witness-store}.ts`
(6 of the 9 pinned memory modules) and `docs/release/gate-decision-2026-07-22.md` all differ from
the candidate blob. `scripts/pilot/input-pins.ts` re-hashes `process.cwd()`, so invoked in this
tree it refuses **`method-drift`** (exit 1) — correctly, by its own contract.

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

  On close day those 7 warnings are **gone**: the worktree-divergence loop is guarded by
  `if (now <= p.txClose)` (freeze-guard.ts:90). Their absence is expected and is not a change of
  state.

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
  Success: no `DIFFERS` line. Refusal: **any** `DIFFERS` line — stop. The dev-tree exception is no
  longer safe and C8's producer must not be run until the divergence is understood. **Paste this
  output into the report**: it is what makes the exception defensible rather than convenient.

  **Run this check TWICE and paste both readings — here, and again immediately before C8.** The
  licence it issues is point-in-time, not standing: `~/dev/helix` is written by a second clone, and
  during the 2026-08-13 rehearsal alone the tree advanced five commits (`c744266`, `5320bb4`,
  `c843e77`, `f8e2bf0`, `a8f07b7`) from another session while the sheet was being written, with
  three matching clone drifts in `~/.cache/freeze-guard-heals.log`. A reading taken at the top of
  Block B says nothing about the bytes C8 will actually load hours later. If the second reading
  differs from the first, C8 does not run: hand-author the adjudication instead (C8 says how).

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

  ```bash
  systemctl --user stop helix-dogfood.timer helix-dogfood.service
  systemctl --user mask helix-dogfood.timer helix-dogfood.service
  systemctl --user is-enabled helix-dogfood.timer helix-dogfood.service
  systemctl --user list-timers --all | grep helix-dogfood || echo "no helix-dogfood timer scheduled"
  ```

  Success: `is-enabled` prints `masked` twice and the `list-timers` grep finds nothing.
  *(unit names verified 2026-08-13 — `systemctl --user list-timers --all` shows
  `helix-dogfood.timer` → `helix-dogfood.service`, NEXT `Fri 2026-08-14 09:00:00 KST`, and
  `list-unit-files` shows `helix-dogfood.timer enabled` / `helix-dogfood.service static`. The
  stop/mask pair itself is **UNREHEARSED**: rehearsing it would have taken the live dogfood run
  down during the window.)*

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
  path; the probe was removed and `git status --porcelain` was empty again.)* The development
  tree's `src/memory` diverges from the pins on 6 files, so its copies would measure a method the
  receipt does not describe. This is also why R3's dev-tree interpreter is harmless: `$TSX` chooses
  nothing about module resolution.
- *The CWD decides what `input-pins` hashes.* `input-pins.ts:290-291` calls
  `hashTools(process.cwd())` and `hashMethodDocs(process.cwd())`. Run it anywhere else and it
  refuses **`method-drift`** — correctly, by its own contract.

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
paste it into the report.

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
checkout. Two steps did not, by necessity, and the honest claim is "every pinned measurement step
(C2–C7, C9, C9b, C10) ran from the candidate checkout; the two post-candidate helpers ran from the
development tree under the byte-identity check of step 0.5". The report's §2.3 bullet that opens
**"Where the chain ran from"** is written in exactly those words, and its §4.6 paragraph
**"Which tree it runs from, and why that is not the checkout"** names the dev-tree invocation; if
either ever reads otherwise, this section is the one that is right. *(Both are named by their
heading text rather than by position: §2.3 has five bullets and §4.6 four bold paragraphs, and an
ordinal pointer silently rots the next time one is inserted — this pair had already rotted once,
naming §2.3's third bullet, which is the runtime-pin one, and §4.6's "Where it lives", which is
about the file's location outside the pinned surface.)*

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
  `~/dev/helix`** — that would trip `method-drift` on the very next line, and it is exactly what
  Block B exists to prevent. The receipt is an input handed to the checkout, not a file of it.
- [ ] **K and both window bounds are copied from the receipt and cannot be passed** — there is no
  flag for them. That is the mechanism that keeps close day from re-deciding the method.
- [ ] Success: `pins.json` written, bound back to the freeze by `freezeSha256`.
- [ ] Refusals to expect and what each means:
  - `method-drift` → you are in the wrong tree (Block B) **or** `~/.helix/config.json` no longer
    hashes to `16f6d97f…`. Live tuning of that file during the window converts silently into this.
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

The producer is **`scripts/close/adjudication-skeleton.ts`** (new, deliberately outside
`scripts/pilot/` so the pinned surface stays untouched; test:
`test/close/adjudication-skeleton.test.ts`).

> **R1 — THIS STEP RUNS FROM `~/close-candidate`, LIKE THE REST OF THE CHAIN.** Under the first
> window it was an R2 dev-tree exception, because `scripts/close/` did not exist at that candidate.
> It does now (`git ls-tree -r --name-only $CANDIDATE -- scripts/close test/close | wc -l` → **2**),
> so the producer runs from the checkout with `$TSX`, its imports resolve to the checkout's own
> pinned modules, and no exception is claimed for it at all. **Its inputs are still named by
> ABSOLUTE paths (R4)** — they live under `~/close-run/`, not in the checkout — and its `--out` must
> too, so the checkout stays clean for 0.2's `git status --porcelain` evidence.
>
> **Re-run step 0.5 NOW, immediately before the command below, and paste this second reading too.**
> The licence is point-in-time: `~/dev/helix` is written by a second clone, and hours will have
> passed since Block B. A `DIFFERS` line here means the exception no longer holds — do not run the
> producer; hand-author the adjudication instead (the shape is the one this step describes, and the
> report's §4.6 already records hand-authoring as the equally valid route).

```bash
cd ~/dev/helix
$TSX scripts/close/adjudication-skeleton.ts \
  --gate-set ~/close-run/gate-set.json \
  --run ~/close-run/run1.json \
  --out ~/close-run/adjudication.json
```

**§8 disposition — the producer was written INSIDE the window (2026-08-13) and that must be
disclosed, not hidden.** `v2-preregistration-2026-07.md:344` resets the window for tooling built
after the freeze, "because implementing an unspecified detail resolves a method choice". **The
owner RULED on 2026-08-13: DISCLOSURE, not reset** — made after both outcomes were put explicitly,
including that RESET was a real alternative that would have cost this window. The ruling is
recorded in report §4.6 under "Owner ruling"; what is still owed is its **ledger entry** (Block
A4), not the decision. The grounds it was made on: the program decides no
verdict (every entry is stamped `UNJUDGED`, which the pinned scorer refuses), it selects no probe
(the entry set is the frozen gate set's `recallDenominator`), and it emits only the fields
`score-gate.ts:430,433,437,473-480` already demands — so it resolves no unspecified method detail,
it saves the operator from hand-typing a file whose shape the pinned scorer already fixes. The one
thing it does decide is the **emission order** of `contradictions` / `staleViolations`, and
`adjudicationSha256` is order-sensitive by design (score-gate.ts:497). That is a provenance fact
about one artifact's bytes, not a measurement choice: any ordering yields the same verdicts.
**Where the report carries this:** §4.6 in full (the producer, its authoring date, its unpinned
location, the four-point reasoning, the honest residue, and the owner's ruling of 2026-08-13) and
§5's element 6 marker in one sentence. §4.6 records the ruling as **made**, and its one remaining
marker asks for the ledger entry id alone; this sheet says the same thing in the same words, and if
the two ever diverge the report is the one that is right. A close report whose §1 claim is "the
method was frozen before the window" cannot leave an in-window build unnamed.

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

- [ ] **STOP unless A4 has been ruled.** Running this producer is what puts a post-freeze program
  into the method, so the §8 question must be answered before this step, not after it. If the
  ruling was RESET, you are not here. If it was DISCLOSURE, run it and make sure A4's ledger entry
  is written before publication. If the ruling was to keep the producer out of the chain,
  **skip this step and hand-author the adjudication** from the frozen probe list — the gate treats
  a hand-authored file and a stamped one identically, so nothing downstream changes.
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

*(R1 — **back to `cd ~/close-candidate`** after C8's dev-tree step.)*

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
the project unit whose ledger C1.2 copies as the measured project corpus.)* Reading index 0 alone
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
`method-drift` for a *second*, unrelated reason, and the receipt chain's final link is written
about a state that no longer exists.

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
  second window opened with `bin/` rebuilt and deployed, so measure before predicting:
  `git log --oneline $CANDIDATE..HEAD -- src/ | wc -l` → **0 as of 2026-08-16**, packaging **7/7
  green**. If that count is still 0 at close, E1 is GREEN, this is not a failure to explain, and
  Block F's rebuild is a no-op that must reproduce `bin/` byte-for-byte.
  *(rehearsed 2026-08-13, under the first window)* → `Tests 1 failed | 6 passed (7)`, failing at
  `packaging.test.ts:74` with `bin/helix-mcp.mjs is stale — run npm run build and commit bin/`.
  **This test is what proves the rebuild reproduced** — in either direction.

- [ ] **E2. `test/output-vocabulary.test.ts` — flips red AT `txClose`.**
  `expected = Date.now() > freezeWindowClosesAt() ? {} : ALLOW`, with
  `ALLOW = { 'docs/release/o67-class-rule-2026-07.md': 3 }` and the instant read from the signed
  receipt's own `payload.txClose` rather than typed in. Green today
  *(rehearsed 2026-08-13 → `Tests 2 passed (2)`)*; red from the close instant until D2 removes the
  3 citations. **The fix is the removal, not the date.**

- [ ] **E3. `test/acceptance/trust-store-home.e2e.test.ts` — auto-RESUMES at `txClose`.**
  `itUnlessFrozenBundle = frozenBundleWindowOpen() ? it.skip : it`, and `frozenBundleWindowOpen()`
  reads the same `payload.txClose` from the receipt. **3** `itUnlessFrozenBundle` sites expand to
  **5** skipped cases (one sits inside a per-adversary loop).
  *(rehearsed 2026-08-13)* → `Tests 3 passed | 5 skipped (8)`.
  These cases drive the **shipped bundle** `bin/helix-mcp.mjs`, so at `txClose` they un-skip
  against a *stale* bundle and will fail until Block F rebuilds it. Expect: skip → red → green, in
  that order. The source-level cases in `test/memory/trust-store-layout.test.ts` carried the
  behaviour throughout; nothing was unguarded.

- [ ] **E4.** Run the full suite once and confirm the failure set is exactly the one this block
  predicts: `cd ~/dev/helix && npm test`.
  **Which set depends on whether D2 has run**, and in this sheet's order it has: D2 removes the 3
  citations, so `test/output-vocabulary.test.ts` is already green again by the time you get here.
  **E1 is now conditional** — it appears only if a post-candidate `src/` commit landed (see E1;
  measured 0 on 2026-08-16). So:
  - after D2 (the normal path): **E3, plus E1 only if that count is non-zero**;
  - before D2 (if you are running Block E early): **E2 + E3, plus E1 on the same condition**.

  Any failure outside that set is a real one — and so is E1 appearing when the count is 0, or
  failing to appear when it is not.

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
  Measured 2026-08-14 on the pre-window rebuild: 2217 pass, 0 fail. A failure here stops the
  redeploy — the close receipt is already written by then, so the measurement is safe either way,
  and shipping is the part that waits.

  Success: `bin/*.mjs` regenerated. `npm run build` does **not** typecheck — run both.

- [ ] **F2. Prove the rebuild reproduced.**

  ```bash
  npx vitest run test/plugin/packaging.test.ts
  ```

  Success: **7 passed** (E1 clears). Refusal: still failing at `:74` → the bundle does not
  reproduce; do not deploy it.

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

- [ ] **G6. Unmask and restart the dogfood units** — the other half of step 0.6's write freeze.
  Run this **after F4/F5** have redeployed, so the first run after the close serves current bytes.

  ```bash
  systemctl --user unmask helix-dogfood.timer helix-dogfood.service
  systemctl --user enable --now helix-dogfood.timer
  systemctl --user is-enabled helix-dogfood.timer
  systemctl --user list-timers --all | grep helix-dogfood
  ```

  Success: `is-enabled` prints `enabled` and `list-timers` shows a NEXT at the following
  09:00 KST. **UNREHEARSED** (the mask it reverses was never applied during the window).
  The daily run is a freeze-era control's *victim*, not the control: leaving it masked would be a
  silent, permanent change made by the close. `Persistent=true` means the first firing after the
  unmask may be an immediate catch-up — that is expected, and it is now safely after C1.2.

- [ ] **G7. Delete the ACTIVE FREEZE section from `CLAUDE.md`** (local-only, never committed).

- [ ] **G8. Pinned-src disposition = DISCLOSURE.** The owner has decided: the 6 pinned
  `src/memory` files modified in-window (`ownership`, `retrieval`, `store`, `verified-projection`,
  `witness-core`, `witness-store` — the divergence measured in Block B) are **disclosed as a new
  entry in `docs/release/v2-freeze-deviations-2026-08.md`**, cited from the §9a report. **Revert
  was rejected**: it would reopen two verified fixes — witness-laundering (`witness-core.ts`) and
  the rename-witness metric (`store.ts`). Write the entry; do not revert.

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
  them by exactly **1**, the front-matter line at report:14 that H2 deletes. Measured 60 / 60 / 61
  at the last reading; the absolute count moves with every edit to the draft, so re-measure rather
  than compare against a number written here.)*
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
  the ordering evidence; the full reset-and-deviation history (including G5's heal count, G8's
  pinned-src disclosure and **C8's §8 disposition for the in-window producer**); evidence the
  declared consequence was actually applied; the D5 disclosures in full, not by reference; and the
  §1 claim + coverage statement **verbatim alongside every reported number**.
  Also confirm the report carries **Block A's outcomes**: the home-machine pin report or the
  explicit statement that the second machine's pins were never observed (A1 — it cannot be
  reconstructed after the close), the open/closed status of Q1, Q2 and Q4 (A2, A3), and **the
  ledger entry id for the owner's §8 ruling on the in-window producer (A4)**, which report §4.6's
  one remaining marker asks for — the ruling itself is already recorded there as made on
  2026-08-13. A4 is the one Block A item that cannot be reported open: an unwritten entry is an
  unfilled marker, and H1 refuses to publish while any remain.
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

- [ ] **H5. Record where the chain ran from — with the exception, not without it.** The claim that
  survives scrutiny is: *every pinned measurement step (C2–C7, C9, C9b, C10) ran from a clean
  checkout of the candidate commit; two post-candidate helpers — `npm run freeze-guard` (0.4) and
  the adjudication skeleton (C8) — ran from the development tree because they do not exist at the
  candidate, under the byte-identity check of step 0.5, whose output is recorded.* Do **not** write
  "the whole chain ran from the candidate checkout": it is false, and a false clause in the
  clean-checkout evidence is worse than the exception it hides. Paste step 0.5's output and step
  0.2's `rev-parse` + empty `status --porcelain`.

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
| `method-drift` | `input-pins` | wrong tree (Block B) or `~/.helix/config.json` bytes |
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
