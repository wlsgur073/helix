# v2 freeze window — deviation ledger (2026-08)

Every entry in this ledger is REQUIRED content for the §9a close report's reset-and-deviation
history (`v2-close-procedure-2026-08.md` links here). The freeze receipt itself
(`v2-freeze-receipt-2026-08.json`) is immutable evidence and is never edited.

## Deviation D-2026-08-09-autoupdate

**Statement.** The marketplace `autoUpdate` control regressed during the measurement window, and
the helix marketplace clone — a pinned runtime load path
(`~/.claude/plugins/marketplaces/helix`) — fast-forwarded in-window. Per the clone reflog:
08-02 20:48 KST -> `27b4373` (the candidate itself, pre-window edge), then in-window
08-03 21:12 KST -> `324dbbb`, 08-06 18:18:46 KST -> `e66384c`,
08-07 21:39:56 KST (12:39:56Z) -> `dc64f6e`. The 08-09 11:29:47Z event touched FETCH_HEAD and
registry `lastUpdated` only (HEAD unmoved). Detected 2026-08-09 during a docs-wide status audit;
no document recorded it before this ledger.

**Byte-continuity evidence.** The `bin/`, `.claude-plugin/`, `hooks/`, and `data/` git trees are
identical across `27b4373`, `324dbbb`, `e66384c`, `dc64f6e`
(bin `8ed67526…`, .claude-plugin `e47c958f…`, hooks `3e1b6a4a…`, data `c2732f2f…`), and both
load-path bundles byte-matched the candidate throughout (verified by cmp and by the pin list
below against both roots). **Wording bound:** this is a *control/provenance deviation with
continuous runtime bytes*. The clone-HEAD identity pin FAILED for most of the window; do not
write "all runtime identity pins held" anywhere in the close report.

**Root cause (probable, not proven).** Claude Code's post-startup randomized (0–10 min) plugin
update check, running with `autoUpdate: true`, pulled the marketplace after session starts: the
08-07 pull landed ~2m19s after that day's dogfood session start, the 08-09 refresh ~8m14s after
the 11:21:33Z session start. The 08-09 tinytask local-scope registry entry (same candidate sha,
same cache path, no new bytes) is same-startup scope registration, not the cause. File-history
verdict (settings.json id `4be465da75fd64fd`): v1 08-05 22:48 KST = true; v2 08-06 00:08 KST =
**false** — the CLAUDE.md-recorded guard WAS persisted; v3 08-06 18:19:09 KST = true again,
23 seconds after the 18:18:46 e66384c pull — the reversion coincides with the update cycle
itself. No known_marketplaces.json history survives. Raw captures are held in a local, gitignored
evidence directory for this deviation, alongside the working-tree design notes; they are not part
of this repository and a clone will not contain them.

**Remediation (2026-08-09, all verified same day).**
- Both flags set explicitly false: `~/.claude/settings.json`
  `.extraKnownMarketplaces.helix.autoUpdate` and `~/.claude/plugins/known_marketplaces.json`
  `.helix.autoUpdate` (official-marketplace entry left untouched — out of freeze scope).
- Env kill switch, defense in depth: `DISABLE_AUTOUPDATER=1` exported in `~/.bashrc` and set in
  the systemd drop-in `~/.config/systemd/user/helix-dogfood.service.d/freeze-guard.conf`
  together with `UnsetEnvironment=FORCE_AUTOUPDATE_PLUGINS` (that variable has OVERRIDE
  polarity — it must be absent). The unit file itself is untouched (its checksum is pinned by
  the 2026-07-17 runner-install record); the drop-in is additive and removed at close.
- Clone restored: evidence preserved first, then `git reset --hard` to `27b4373` ON branch
  `feat/helix-v1` (symbolic-ref verified; never detached). 3-sha agreement re-verified after:
  installed_plugins entries (user + tinytask local) = clone HEAD = candidate; bundles
  byte-identical across both load paths.
- Recurrence watch: `scripts/freeze-runtime-check.sh`, wired at interactive shell start
  (`~/.bashrc`) and as a hard `ExecStartPre=` on `helix-dogfood.service`. Checks: receipt anchor
  (known payload sha `55720757…`), both flags, clone HEAD, every registry entry, both load-path
  runtime surfaces vs `v2-freeze-runtime-pins-2026-08.txt` (9 files derived from the candidate
  commit), and the pinned `~/.helix/config.json` hash. Silent when healthy; unthrottled stderr
  banner per invocation while violated; nonzero exit in automation. **Accepted trade-off:** a
  standing violation blocks the daily dogfood run (conservative freeze protection); the shell
  banner plus dogfood-watch's completion-gap banner surface it, and catch-up resumes runs after
  the fix. 9 fixture drills + corruption drill green; real-state run silent.

**No-reset determination.** A measurement-window reset is NOT required: runtime bytes were
continuous for the whole window (evidence above), so the system under measurement never changed.
Approved by the owner 2026-08-09 via the reconciled remediation design (2-round Codex compare,
converged). The alternative reading — commit identity itself as measured system identity, which
would reset from 08-03 — was considered and not adopted.

**Close-report duties.** (1) This entry appears in the §9a reset-and-deviation history in full.
(2) The deploy-runbook 3-sha load-path check still runs at close as scheduled (this ledger is
evidence of the mid-window re-verification, not a substitute). (3) Guard retirement happens ONLY
via the validated close receipt (`v2-close-receipt-2026-08.json`), written by the close
checklist after release-record validation — never by the passing of `txClose` alone. (4) At
close, also remove the two freeze-guard lines + export from `~/.bashrc` and the systemd drop-in,
and restore both `autoUpdate` flags to true.

**Method note.** The remediation design was cross-checked with a second reviewing model (compare
mode, 2 rounds, convergence declared); the divergence why-log lives in the local, gitignored design
notes for this remediation, not in this repository. Every conclusion that binds this ledger is
restated above, so a fresh-clone reader needs none of those local files.

## Deviation D-2026-08-10-autoupdate-recurrence

**Statement.** One day after D-2026-08-09's remediation, the clone fast-forwarded again:
`pull origin HEAD` at 2026-08-10 21:02:02 KST (12:02:02Z) moved HEAD `27b4373 -> 2fdc1ca`
(the previous day's pushed docs/scripts commit). Detected the same evening by
`freeze-runtime-check.sh` on its first post-drift invocation — the guard worked as designed,
under 24 h from wiring to first catch.

**Why this entry matters — both preventive controls are FALSIFIED.** At pull time BOTH
`autoUpdate` flags were `false` (set 08-09 21:5x, still false when checked 21:1x on 08-10),
AND the Claude process that triggered the refresh (started 21:01:46 KST, 16 s before the pull)
carried `DISABLE_AUTOUPDATER=1` in its environment (verified via /proc). Conclusion for CLI
2.1.226: the startup marketplace-clone refresh runs regardless of the per-marketplace
`autoUpdate:false` and regardless of `DISABLE_AUTOUPDATER=1`. The 08-09 root-cause section's
"probable" mechanism stands (post-startup refresh), but its assumed controls do not control it.
Prevention is currently NOT achievable with documented configuration; detection + reset is the
operating mode for the rest of the window.

**Byte continuity.** Unbroken: `2fdc1ca` touches `docs/release/` and `scripts/` only —
`git diff 27b4373..2fdc1ca -- bin/ .claude-plugin/ hooks/ data/` is empty — and the guard's
pin-list checks passed against both load paths throughout. Same wording bound as before:
control/provenance deviation with continuous runtime bytes.

**Remediation.** Clone `reset --hard` to `27b4373` on `feat/helix-v1` (same owner-approved
action as D-2026-08-09), re-verified 2026-08-10: symbolic-ref intact, HEAD = candidate, guard
exit 0. Standing exposure until close: every Claude startup may move the clone again.

**CORRECTION 2026-08-13 — what the window's byte-safety actually rests on.** This paragraph
previously named "(a) the standing discipline that no in-window commit rebuilds `bin/`" as one of
two supports. **That clause is false and is withdrawn.** One in-window commit did rebuild the
bundles: `d701735`, *build: rebuild the committed bundles so this branch verifies what it ships*,
2026-08-06T05:46:34Z, four files under `bin/` — `git diff --stat 27b4373 d701735 -- bin/` reports
167 insertions and 56 deletions against the candidate. Those bytes reached the mainline through
merge `02c7c9d` (2026-08-10T05:29:35Z) and stood for about 26 hours, until `b4997cd`,
*freeze(pilot): return `bin/` to the candidate bytes* (2026-08-11T07:30:00Z), restored them. The
non-identical interval is exactly 15 first-parent commits, `02c7c9d` through `2c2d1d2`, all carrying
`bin/` tree `abd4f14f`; the candidate and the branch tip both carry `8ed67526`.

The supports that do hold, each checkable from the repository:
- **No clone HEAD the runtime ever reached carried non-candidate bundles.** Every head recorded in
  this ledger — the in-window auto-pull targets `324dbbb`, `e66384c`, `dc64f6e`, the recurrence
  target `2fdc1ca`, and the auto-heal heads `b4997cd` and `0bbb000` — has `bin/` tree `8ed67526`,
  identical to the candidate's. The rebuilt bytes existed only on the development mainline, which is
  not a runtime load path.
- **The guard's byte check, not a discipline.** `freeze-runtime-check.sh` compares the runtime
  surface bytes under **both** load paths against the pin list and hard-fails on any mismatch. It
  never did, across the whole interval above.

The close report's §4.4 carries the same correction, and cites this entry for the evidence rather
than restating it; the two must not drift apart. **Recurrence handling DECIDED by the owner
2026-08-10: guard auto-heal.** `freeze-runtime-check.sh` now mechanizes the twice-approved
remediation under a strict condition — the SOLE violation is clone-HEAD drift and every
byte/pin/flag/receipt check passed — resetting the clone to the candidate, appending to
`~/.cache/freeze-guard-heals.log` (the close report counts heals from it), printing a one-line
stderr notice, and exiting healthy. Any other violation combination (byte drift, flag drift,
past-close, dirty clone) still hard-fails, so the dogfood `ExecStartPre` blocks only on real
incidents. Verified by fixture drills (12/12 incl. the heal path) on 2026-08-10.

---

## Deviation D-2026-08-13-in-window-tooling — WINDOW RESET

**Status: the window is RESET.** This entry records the trigger, the owner's ruling and the
reading it rests on. The reset's execution — new candidate, re-issued receipt, new freeze commit —
is a separate act and is recorded where it lands, not here.

**What happened.** On 2026-08-13, inside the window, a program was written to produce one close-day
input: `scripts/close/adjudication-skeleton.ts`, with its test. It stamps the adjudication file
that the pinned scorer requires through its `--adjudication` flag. It was written because a
verification pass found the close chain had no producer, no template and no example for that
artifact, and would have dead-ended on close day between the runs and the score.

**The governing sentence**, quoted rather than paraphrased:

> Any intervening **system, config, rule, or metric** change resets the window, which restarts from
> the change. … Building any of the method's tooling *after* the freeze **does** reset it, because
> implementing an unspecified detail resolves a method choice.
> — `v2-preregistration-2026-07.md`, the Reset paragraph

**Three readings were put to the owner, each with its measured cost.** (1) The trailing clause
limits the rule, so a program that resolves no unspecified detail is not reached — the pinned
scorer already specifies completeness, non-duplication and both hash bindings, and every judgment
is stamped `UNJUDGED` and refused until a human replaces it. (2) The program is kept out of the
chain and the adjudication is hand-authored — measured at 10 real probe ids, the file is 1,134
bytes, ≈2.9 KB at the ~26 probes expected at close, and all five hand-authoring mistake classes are
refused by the pinned scorer rather than silently accepted. (3) Building the tooling is itself the
trigger, whatever is done with it afterwards.

**The owner ruled reading (3) on 2026-08-13: the window RESETS.** Building alone triggers it, so
keeping the program out of the chain does not answer the question, and the disclosure reading is
not taken.

**A first ruling, taken earlier the same day, was withdrawn.** It was taken on a paraphrase of the
rule that omitted the word **does**, and it went the other way. The paraphrase was mine. It is
recorded here because a pilot whose claim is process integrity cannot keep the one place where its
own rule was nearly read too lightly out of its own ledger — and because the correction is the
evidence that the rule was read, in the end, as written.

**Measured consequences, as of the ruling.** The close instant moves from 2026-08-30T11:35:05Z to
28 days after the new cutoff. The 10 probe rows accrued so far (one per day, 08-03 through 08-13)
fall below the new cutoff and leave the probe population permanently, while remaining live
competitors; the sample-sufficiency clock restarts at zero against a measured accrual of about
0.87 rows per day. Mechanically the reset is indistinguishable from a re-freeze: the receipt's
close instant is derived, not supplied, and its cutoff must equal the candidate commit's authored
time, so a moved window requires a new candidate commit, a re-issued receipt and a new freeze
commit. The difference the ledger preserves is that no defect in the frozen method is asserted and
nothing had to be fixed first.

**Remediation EXECUTED 2026-08-14.** Recorded here in the order the dependencies force, because the
order is the part that is easy to get wrong: pinned bytes must be final before the candidate commit
(the receipt hashes the working tree and refuses any pinned path that diverges from `--commit`),
and everything that quotes the receipt's own values must come after it.

1. Candidate `d581e7e` — the producer and its test committed, `PINNED_TOOL_PATHS` widened 25 → 26 to
   include `scripts/close/adjudication-skeleton.ts`, and `bin/` rebuilt from source. The rebuild was
   pulled forward from close day deliberately: 62 source commits had accumulated behind the first
   candidate's bundles, and activating them all at once on a one-shot day was the larger risk. The
   full suite was the gate rather than the packaging test alone — 2215 pass, and the
   packaging-freshness test, red BY DESIGN for the whole first window, went green.
2. Candidate `94dd136` — superseded `d581e7e` within the hour. `gate-decision-2026-07-22.md` is a
   PINNED method document and its 2026-08-02 addendum asserted the void window in the present
   tense; correcting it after the receipt was issued would have been the violation, so it was
   corrected first and the candidate re-cut. `src/memory/firewall.ts` lost a hard-coded
   `2026-08-30` in the same commit — it told a future maintainer when a field on a pinned file
   becomes deletable, and the reset would have made that instruction fire four weeks early.
3. Runtime redeployed to `94dd136` per `deploy-runbook.md` (uninstall + marketplace update +
   install, at BOTH registry scopes — the `user`-scope uninstall does not touch a `local`-scope
   entry, which left one entry on the old sha until it was reinstalled from its own project root).
   Three shas equal; all nine runtime surfaces byte-identical in both load paths.
4. Receipt re-issued: payload `360ffe80f6baf853fdc5acb4bc949a14b84838c3827cbeb56832da56bfcc7332`,
   window `2026-08-14T06:20:01.000Z .. 2026-09-11T06:20:01.000Z`, 26 tools + 2 method docs, anchors
   verified by `freeze-guard`. The superseded receipt is retained unedited as
   `v2-freeze-receipt-2026-08-02-void.json`.
5. `scripts/freeze-runtime-check.sh` re-anchored (CANDIDATE / PAYLOAD_SHA / TX_CLOSE; CONFIG_SHA
   unchanged) and the runtime pin list regenerated — exactly the five `bin/` entries moved, the
   four non-build surfaces did not. **Leaving TX_CLOSE alone would have hard-failed the guard from
   2026-08-30 and blocked the daily dogfood run through its `ExecStartPre`.**

**Two things the reset paid for rather than cost.** The pinned-source disclosure question the first
window carried — six `src/memory` files whose bytes had moved past the candidate they were pinned
against — does not exist in the second window, because the new candidate contains them and the
re-freeze re-pins them where they are. And the 28 days ahead are now real-use verification of the
rebuilt bundles instead of a close-day activation of 62 unverified commits.

## Deviation D-2026-08-15-autoupdate-second-window

**This is the SECOND window's first deviation, and it is not a new failure — it is the standing
exposure D-2026-08-10 predicted, arriving on schedule.** That entry closed with "every Claude
startup may move the clone again", having falsified both preventive controls. It did.

> **This entry carries MORE THAN ONE instance.** Its closing paragraph says each further instance
> is appended here, and two have been — *Instance 2* (2026-08-17) and *Instance 3* (2026-08-18) —
> so the statement below describes the FIRST instance only. Read the whole entry before quoting a
> count from its opening; the close report's §4.7 marker asks for the list, not for this heading.
> Count the `### Instance` headings rather than trusting this line, which has already been stale
> once.

**Statement.** The marketplace clone fast-forwarded off the candidate on 2026-08-15 20:26:24 KST
(11:26:24Z): `pull origin HEAD: Fast-forward`, HEAD `94dd136 -> 3bd63d0`. Corroborated
independently of the reflog by `known_marketplaces.json`'s `helix.lastUpdated`, which reads
`2026-08-15T11:26:24.026Z` — the same instant to the second. Both `autoUpdate` flags were `false`
at the time and remain so, and `DISABLE_AUTOUPDATER=1` is exported and verifiably inherited by
non-interactive shells. Nothing in the documented configuration surface was misconfigured; the
refresh simply does not consult it (D-2026-08-10's conclusion for CLI 2.1.226, unchanged).

**Byte continuity.** Unbroken. `git diff 94dd136 3bd63d0 -- bin/ .claude-plugin/ hooks/ data/` is
empty — the freeze commit touches only `docs/release/`, `scripts/` and `test/`. All nine runtime
surfaces verified byte-identical against the pin list under BOTH load paths after the heal. Same
wording bound as before: **control/provenance deviation with continuous runtime bytes**; the
clone-HEAD identity pin FAILED for the interval below, and no report may say "all runtime identity
pins held".

**A wrinkle worth naming, because it makes the deviation look harmless and is not the reason it is
harmless.** The commit the clone drifted TO is the freeze commit itself — the very commit that
opened this window. That is a coincidence of ordering, not a safety property: the guard compares
clone HEAD against the CANDIDATE, and the freeze commit is one commit past it by construction, so
the freeze commit is precisely the drift target most likely to occur and least likely to alarm a
reader. What actually makes it safe is the measured byte identity above.

**Remediation — automatic, and the first exercise of the auto-heal inside this window.** Healed
2026-08-16 01:43:44Z back to `94dd136`, logged to `~/.cache/freeze-guard-heals.log`. That is the
**fourth** heal overall and the first of the second window; §4.3 of the close report carries the
first window's three.

**Detection latency: 14 h 17 m 20 s**, and it is a property of the design rather than a failure of
it. `freeze-runtime-check.sh` is point-in-time, not continuous — it fires on interactive shell
start and on the dogfood unit's `ExecStartPre`. Between the pull and the next such invocation the
clone stood off-pin, undetected. The window survives this because runtime BYTES are what serve
recall and they never moved; a drift that also moved bytes would have stood for the same interval.
Recorded so the close report states the exposure rather than implying continuous monitoring.

**No action taken beyond the heal**, and none is available: prevention remains unachievable with
documented configuration, so detection + reset stays the operating mode for the rest of this window
too. Expect further instances; each is appended here.

### Instance 2 — 2026-08-17, and the shape of the healer's daily coverage became visible

**Statement.** The clone fast-forwarded off the candidate again on 2026-08-17 05:32:54Z
(14:32:54 KST): `pull origin HEAD: Fast-forward`, HEAD `94dd136 -> 0d2e55f`. Corroborated
independently of the reflog by `known_marketplaces.json`'s `helix.lastUpdated`, which reads
`2026-08-17T05:32:54.068Z` with `autoUpdate` `false`. The pull landed 16 seconds after a Claude
Code session start — the same signature as instance 1, on CLI `2.1.233`.

**Runtime bytes never moved, and this was measured rather than assumed.** Against the drifted
commit `0d2e55f`, all four runtime trees are git-identical to the candidate's — `bin/` `e6bd010a`,
`.claude-plugin/` `e47c958f`, `hooks/` `3e1b6a4a`, `data/` `c2732f2f` — and each of the nine files
in `v2-freeze-runtime-pins-2026-08.txt` hashes to its pinned value at that commit. The 12 paths
that differ between the two commits are `.github/workflows/ci.yml`, `src/verify/agreement-map.ts`,
`scripts/freeze-runtime-check.sh` and nine `docs/`-and-receipt paths, none of which is loaded by
the plugin. So this is the same control-and-provenance class as instance 1, not a measurement
exposure.

**Healed 2026-08-17 06:55:31Z** (15:55:31 KST) back to `94dd136`, logged as the fifth line of
`~/.cache/freeze-guard-heals.log`. **Detection latency: 1 h 22 m 37 s.**

**What is new, and it is the reason this instance is worth more than a tally mark: the automatic
healing opportunity is a single instant per day, and it precedes the run.** The guard is wired as
the dogfood unit's `ExecStartPre` (drop-in `freeze-guard.conf`), so it completes before
`ExecStart`; a run that later dies has already taken its healing pass, and run failure therefore
costs no heal. Two measurements on consecutive days show both sides of this. On 2026-08-16 the unit
started 10:43:44 KST and its `ExecStartPre` healed `3bd63d0` back to the candidate, logged as the
fourth line of the heal log (`2026-08-16T01:43:44Z`) — the dogfood path doing the work. On
2026-08-17 the unit started 14:31:55 KST and its `ExecStartPre` logged nothing, because the clone
was still on the candidate; the drift arrived 14:32:54 KST, **59 seconds later**, and so stood
until an interactive shell start healed it 1 h 22 m on.

**The dependency is therefore on WHEN the unit starts, not on whether the run succeeds** — a
distinction this ledger had not drawn, and one that changes what the latency numbers mean. Coverage
is one instant per day at a start time that has ranged 10:43–20:01 KST across the four scheduled
runs since 2026-08-14, because catch-up scheduling places the run wherever the machine was first
awake. Any drift landing after that instant waits for a human. That is what raises the expected
off-pin interval for later instances in this window, and it is why instance 2's 1 h 22 m and
instance 1's 14 h 17 m are not comparable as evidence about the guard: they measure how soon a
shell happened to open, not how well the check works.

**The runner's own failures are recorded here, but they belong to §5, not to this control.** Of the
three scheduled runs inside the window, 2026-08-15 stopped on a weekly quota limit, 2026-08-16
completed, and 2026-08-17 stopped at its `claude -p` step on an entitlement refusal — `ISSUE-0006`,
`Your organization has disabled Claude subscription access for Claude Code`, distinct from the
08-15 quota stall. Two of the three failed, for unrelated reasons. That bears on sample accrual and
is treated there; it does not reduce this control's coverage, for the reason just given.

**Ordering note, so the heal's provenance is not overstated.** The heal was not an operator
decision taken in response to an observation: it fired from a subagent's shell start during an
unrelated verification pass, under the auto-heal mode the owner approved 2026-08-10 and which is
gated to the case where clone-HEAD drift is the sole violation and every byte check passes. Both
conditions held. It is recorded here as what it was — the standing mechanism working — rather than
as remediation anyone chose.

### Instance 3 — 2026-08-18, and the drift target stopped being our own commit

**Statement.** The clone fast-forwarded off the candidate again on 2026-08-18 10:24:57Z
(19:24:57 KST): `pull origin HEAD: Fast-forward`, HEAD `94dd136 -> 5c6e1c7`. Corroborated
independently of the reflog by `known_marketplaces.json`'s `helix.lastUpdated`, which reads
`2026-08-18T10:24:57.399Z` — the same second. Flags and environment unchanged and still not
consulted, exactly as instances 1 and 2.

**Byte continuity.** Unbroken, and MEASURED rather than assumed:
`git diff 94dd136 5c6e1c7 -- bin/ .claude-plugin/ hooks/ data/` is empty, and all nine runtime
surfaces verified byte-identical against the pin list under BOTH load paths before the heal. Same
wording bound as before: **control/provenance deviation with continuous runtime bytes**.

**What is new, and it widens the class rather than repeating it.** `5c6e1c7` is a MERGE COMMIT
PUSHED BY THE SECOND CLONE (authored 2026-08-18 09:43:18 KST on the other machine). Instances 1 and
2 drifted to commits this machine had itself pushed minutes or hours earlier, so their byte
continuity could be reasoned about from what we had just written. This one drifted to a commit this
machine had not yet fetched — at the moment of the pull, the development tree here was nine commits
behind it. **So the marketplace clone can carry bytes onto a measured load path that no one on this
box has seen**, and the continuity check stops being a formality: it is the only thing standing
between another machine's push and the runtime under measurement. It held here — the nine commits
touch `scripts/mutation-sweep.sh` and three test files and nothing else — but that is a fact about
what the other clone happened to be doing, not a property of the control.

**Healed** 2026-08-18 10:59:42Z, the sixth heal overall and the third of this window; off-pin
interval 34 m 45 s. Per the note under instance 2, that number is not evidence the guard improved:
the heal fired because an interactive session ran `freeze-runtime-check.sh` by hand while
investigating, so it measures session activity, not detection latency. The three in-window
intervals — 14 h 17 m, 1 h 22 m, 34 m 45 s — are a record of when a shell happened to open.

## Ruling R-2026-08-16 — two in-window edit classes ruled NOT a reset

Recorded here because this ledger is the §9a report's source for reset history, and "this was
considered and ruled not a reset" is part of that history. Neither item is a deviation; both are
edits made after the ruling.

**The clause was put to the owner verbatim**, not paraphrased — a paraphrase that dropped the word
*does* is what produced the withdrawn first ruling on 2026-08-13, and the same mistake here would
cost the same thing.

**(a) `.github/workflows/ci.yml` — `npm run typecheck` moved from a step of the `test` job into its
own job.** Ruled NOT a reset. Two grounds, and the second is the stronger one.

- *Scope.* The Reset clause's measured surface is "code, config and the frozen rules", and this
  receipt enumerates it in four maps — `payload.tools` (26), `payload.methodDocs` (2),
  `payload.config` (`~/.helix/config.json`), `payload.runtime`. A CI workflow is in none of them and
  no close step reads a CI result. Nothing is *built* either: `npm run typecheck` already existed in
  `package.json` and was already invoked by this file; only when it runs changed.
- *Precedent, which is on record rather than argued.* `git log -- .github/workflows/ci.yml` returns
  exactly four commits, all 2026-08-03 — `53feba4`, `3efb94e`, `61a42dd`, `315322a` — every one of
  them inside the FIRST window, one of which (`3efb94e`) added the `freeze-guard` job that reads the
  receipt. That window then ran ten more days and was reset on 08-13 for the adjudication producer,
  not for any of these.

**Why it was worth doing at all.** For the whole first window `test/plugin/packaging.test.ts` was
red BY DESIGN, so `npm test` exited non-zero on every push and `npm run typecheck` — the next step
in the same job — NEVER RAN. The compile-time protection that is the entire point of the
`CompactOptions` discriminated union went unenforced for the window that most needed it. The
pre-window rebuild made packaging green, so typecheck currently runs *by accident*; splitting the
job is what makes it independent of whether some other test happens to be failing.

**(b) A comment-only edit to `src/verify/agreement-map.ts`.** Ruled prose, NOT a reset. Settled by
measurement rather than by categorisation: `build.mjs:17` sets `legalComments: 'none'`, so no source
comment reaches `bin/`, and the packaging test — which rebuilds from `src/` and byte-compares
against the committed bundles — stayed 7/7 green across the edit. `src/verify/` is also absent from
all 26 pinned tool paths and is not on the recall rank path the pilot measures.

**Standing scope of both rulings.** They cover these two edit classes and nothing wider. In
particular they do NOT license: editing any of the 28 pinned paths; rebuilding `bin/`; or
re-measuring a metric that a §9a-mandatory report section is then rewritten around — that last one
lands on the clause's first limb and was refused on 2026-08-16 for exactly that reason (see the
close report §4.5).

## Disclosure R-2026-08-18 — in-window computation of the eligible-probe count

**Disposition REQUESTED, not asserted.** This entry exists so the act is on the record whichever
way it is ruled, and so the instant a reset reading would need is fixed before it evaporates.

**What happened.** On 2026-08-18, six analysis passes computed the §5 eligible-probe count for this
window by REIMPLEMENTING two frozen rules — `topicTerms` (`scripts/pilot/derive.ts`) and
`unambiguous` (`scripts/pilot/generate-manifest.ts:161-165`) — in ephemeral Python over
`~/dev/helix-dogfood/tinytask/.helix/memory.jsonl` and `~/.helix/memory.jsonl`. All six ran inside
one orchestration, between **2026-08-18T10:51:48Z and 2026-08-18T10:58:05Z**; the last of them is
therefore no later than `10:58:05Z`. No file was written into the repository, no program under
`scripts/pilot/` was executed by them, and nothing derived from a rank, hit or ordering was read.

**The same number, then taken by the authorised path.** At **2026-08-18T11:05:39Z** — after the
last reimplementation — the FROZEN program was run in its holdout form,
`generate-manifest --after <cutoff> --close <close> <snapshotDir> <out>`, against copies of the two
ledgers staged in a scratch directory, with `--out` outside every close-chain path. It printed:

```
probes: 2 (ledger 2, oracle 0); unambiguous: 0
```

so the reimplementations produced no information the permitted path withholds.

**One question a reviewer raised and the record can settle.** Whether that run was the forbidden
act — §8 forbids "running the pilot runner over window records" — turns on which program the
"pilot runner" is. It is `scripts/pilot/run-pilot.ts`, whose header reads *"Pilot runner (protocol
§execution, preregistration §9 item 5) … probes MemoryStore.recall at the manifest K"*. That
program was NOT run. `generate-manifest.ts` is a different pinned tool and touches no recall.

**The two readings, each with its best support.**

*Not a reset.* §8's own usage of "the method's tooling" is visible in §9b, which names what it
meant: the runner's payload/receipts split, and the freeze receipt, ordering receipt and release
record, which "have no producer yet" — and says they must land before the freeze "since building
them afterwards would resolve method choices". Every instance is a producer of an evidence-chain
artifact that did not exist. A disposable recomputation of an already-frozen rule fills no gap and
resolves no choice; it produced no artifact, and the frozen program has since produced the
identical number. §8 additionally states that "Counting qualifying exposures during the window
needs no special procedure", and the forbidden list is closed and was not touched.

*A reset.* §8 says "Building **any** of the method's tooling after the freeze **does** reset it",
without qualification. The Python implemented the actual eligibility metric and the actual
topic-term rule, so it was the method's tooling on the plain reading; persistence, artifact
production and execution in the close chain are not conditions the sentence states. The
2026-08-13 ruling read that main clause as unconditional — the act of building triggers it whether
or not the program is ever run — and the argument from the trailing clause ("because implementing
an unspecified detail…") is the reading that ruling already rejected. Under this reading each
separate reimplementation restarts the clock, and the anchor is the last one, `10:58:05Z` above.

**Recorded because it is uncomfortable, not despite it:** an independent peer review of this
question reached the *reset* conclusion, while the analysis that raised the disclosure reached the
opposite. Both are set out above rather than one being presented as settled.

**No operational change was made on the strength of the count.** The count is holdout content, and
`pilot-amendment-1.md` forbids any product or remediation decision informed by the holdout's
contents. The workload driver, its systemd units and the frozen rules are all untouched; the
driver's sha256 is unchanged from before either window.

### Why-log — the peer reconciliation behind this entry

Recorded because the disagreements and how they resolved are the part no code or changelog keeps.
The consultation was symmetric: one neutral question, an answer published before the call so the two
were provably independent, then reconciliation against local evidence rather than by authorship.

**Process note first, because it cost a call.** The initial question addressed files by
repository-relative path. The external reasoner runs confined in an empty scratch directory with no
project root, so those paths resolved to nothing and it declined to rule — *"the referenced files
were not found… please remount the workspace"* — rather than guessing. That refusal is a correct
response to bad addressing and is the only reason the addressing defect became visible. The question
was re-sent with the governing text quoted verbatim and the predicate's source inlined.

**Divergence 1 — the disposition itself. NOT RESOLVED, and it should not be.** The reviewer ruled
RESET, on §8's unqualified "any" plus the 2026-08-13 unconditional reading. The analysis that raised
the disclosure ruled NOT a reset, on §9b's own usage of "the method's tooling" and §8's express
permission to count. Both readings are set out above with their evidence. This is a ruling, not a
factual dispute, and no further exchange settles it — the owner does.

**Divergence 2 — my argument, withdrawn.** The original no-reset case leaned on the trailing clause
("because implementing an unspecified detail resolves a method choice") as a LIMITER on the main
clause. The reviewer identified that as the reading the 2026-08-13 ruling had already rejected, and
that is correct. The argument in this entry is therefore different: it rests on §9b's enumeration of
what the document itself calls the method's tooling, all of which are producers of evidence-chain
artifacts that did not exist.

**Divergence 3 — "more rows cannot help". RESOLVED AGAINST ME.** The analysis claimed added rows
could not raise eligibility, since each new row is also a new competitor. The reviewer pointed out
that a new row is ALSO a candidate probe in its own right, so a topically distinct one can be
eligible even though it cannot rescue an existing probe. Checked against the predicate, which is
evaluated per probe: correct. Nine consecutive ineligible rows are evidence, not proof, and §5
forbids turning such evidence into an accrual forecast in terms. The claim is withdrawn; the count
is still to be evaluated at the close, from the close-day chain.

**Divergence 4 — an open question the record could close.** The reviewer could not tell from the
text whether the holdout-form run was the forbidden act, since §8 forbids "running the pilot runner
over window records". Resolved locally: the pilot runner is `scripts/pilot/run-pilot.ts`, whose
header reads *"Pilot runner … probes MemoryStore.recall at the manifest K"*, and it was not run.

**Divergence 5 — why the workload driver may not be touched. CONVERGED BY DIFFERENT ROUTES.** The
analysis reached it through the independence bullet (acting on holdout contents); the reviewer added
that §8's first limb reaches it too, since "system" is not limited to what the receipt happens to
map and the script functionally controls exposure accrual. The exemption question is moot: the
action is barred on either route, and both agree it is barred.

**Contributed by the reviewer and adopted:** under the reset reading each separate reimplementation
restarts the clock, so the anchor is the LAST one — which is why this entry fixes that instant
(`2026-08-18T10:58:05Z`) rather than leaving it to be reconstructed later.

**Converged, independently, on the point that decides conduct:** permission to inspect is not
permission to act. §8 allows the count; `pilot-amendment-1.md` forbids a remediation decision
informed by holdout contents. Every candidate intervention — repairing the driver, changing its
schedule or prompt, lowering the floor, hand-minting rows, or resetting because the number is
unwelcome — fails on that, independently of how the disposition above is ruled.
