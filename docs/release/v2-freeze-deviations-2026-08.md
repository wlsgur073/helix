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
> is appended here, and several have been, so the statement below describes the FIRST instance only.
> Read the whole entry before quoting a count from its opening; the close report's §4.7 marker asks
> for the list, not for this heading. **Count the `### Instance` headings — this line does not name
> them any more, because naming them is what made it stale twice.** It named two while instance 4
> existed (corrected 2026-08-17 and stale again by 2026-08-19), and instances 5, 6 and 7 were
> appended 2026-08-22. Instance 1 has no `### Instance` heading of its own: it is the Statement
> immediately below, so the instance count is the heading count plus one.

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

### Instance 4 — 2026-08-19, and the byte-continuity bound finally broke on one load path

**Statement.** The clone fast-forwarded off the candidate again on 2026-08-19 11:55:31Z
(20:55:31 KST): `pull origin HEAD: Fast-forward`, HEAD `94dd136 -> 19b4746`. Flags and environment
unchanged and still not consulted (`autoUpdate` `false` in both files, `DISABLE_AUTOUPDATER=1`).
One corroboration detail differs from instances 1-3: `known_marketplaces.json`'s `helix.lastUpdated`
reads `2026-08-19T12:38:29.301Z` — NOT the pull second. It coincides instead, to within 4 seconds,
with a session resume that spawned the live cache-path server at 21:38:25 KST (`ps lstart`), so the
lastUpdated stamp recorded a later no-op check, not the pull. Recorded as observed rather than
forced into the earlier pattern.

**Byte continuity BROKE — the first time on either window, and it was measured.** `19b4746` carries
the second clone's in-window `bin/` rebuild (deviation `D-2026-08-18-in-window-product-rebuild`,
below — pending when this instance was written on 2026-08-19, RULED NOT A RESET later the same day): seven commits touch `bin/` in `94dd136..19b4746` (`8ca8a2f`, `08bc3da`,
`535de65`, `c3456ec`, `e5a3f3d`, `9f0ca5a`, `7c22bfc`). FOUR of the nine files in
`v2-freeze-runtime-pins-2026-08.txt` failed the pin list on the marketplace load path —
`bin/helix-mcp.mjs` (`e04a0164…`, 936,649 B vs the candidate's `075fc39e…`, 933,389 B),
`bin/helix-rebaseline.mjs`, `bin/helix-trigger.mjs`, `bin/hooks/session-start.mjs`; only
`bin/hooks/session-end.mjs` still matched. The guard banner named three of the four:
`freeze-runtime-check.sh:94` pipes the failure list through `head -3`, a display truncation that
under-reported this incident by one file and will hide any fourth-and-later failure in future ones.
Fixing it in-window would change the live guard (the script runs from the working tree), so the fix
is queued for post-close instead and the full four-file measurement is recorded here.

**Exposure, measured not assumed.** The install cache — the other pinned load path — stayed
candidate-identical throughout (all five bundle files byte-verified). The only `helix-mcp` process
alive during the interval binds the cache path (started 21:38:25 KST), and the daily dogfood run
(09:00 KST) predates the pull, so no measured run executed against the drifted bytes. What cannot
be claimed: that no short-lived process bound the marketplace bundle inside the interval. **The
close report may therefore no longer say byte continuity held at both load paths for the whole
window** — the marketplace path carried non-candidate bytes for 1 h 32 m 27 s.

**Auto-heal correctly declined; first MANUAL remediation of the window.** The healer requires
exactly one failure and it must be the HEAD-drift line (`freeze-runtime-check.sh:116-117`); this
incident presented two (HEAD drift + bytes off-pin), so the conservative gate held — by design,
since resetting over unexplained byte drift is precisely what it exists to refuse. Guard exit 1;
left standing, the 08-20 09:00 KST `ExecStartPre` would have blocked the run and cost a §5 accrual
day. The owner approved manual remediation in-session; `reset --hard` to the candidate at
2026-08-19 13:27:58Z (22:27:58 KST), all nine pin-list files re-verified, guard exit 0. Off-pin
interval 1 h 32 m 27 s — with the same caveat as instances 2-3: detection happened because a
documentation sweep re-ran the guard by hand, so the number measures session activity, not the
control's latency.

### Instance 5 — 2026-08-20, and the byte-continuity sentence the earlier instances used stopped being true

**Statement.** The clone fast-forwarded off the candidate on 2026-08-20 12:00:55Z (21:00:55 KST):
`pull origin HEAD: Fast-forward`, HEAD `94dd136 -> 92d5d0a`. Both `autoUpdate` flags were `false`
and `DISABLE_AUTOUPDATER=1` was exported, unchanged since instance 1. **This instance has no
independent corroboration and that is stated rather than papered over**: `known_marketplaces.json`
holds one `helix.lastUpdated` value, which instances 6 and 7 have since overwritten, so the reflog
is the only witness for the instant. The pattern of instances 1-4 makes a session-start pull the
likely mechanism, but nothing here measures it.

**Byte continuity. Unbroken — and the four-tree test the earlier instances used no longer states
it correctly.** Instances 1-3 read `git diff 94dd136 <target> -- bin/ .claude-plugin/ hooks/ data/`
and found it empty. At `92d5d0a` it is NOT empty: `data/inventory/claims.json`,
`data/inventory/surface.json` and `data/inventory/verdicts.json` differ, because the inventory
subsystem built on 2026-08-19 writes generated artefacts under `data/`. None of the three is on the
nine-file pin list (`v2-freeze-runtime-pins-2026-08.txt` names exactly one `data/` path,
`semantic-neighbors.json`) and none is read by the plugin — the readers are `scripts/inventory/*`
and their tests. The measurement that carries the verdict is therefore the pin list itself: **all
nine pinned runtime files hash to their pinned values at `92d5d0a`**, and `bin/`,
`.claude-plugin/` and `hooks/` are git-identical to the candidate's. Anyone writing a further
instance should measure the nine and name the `data/` divergence, not reuse the four-tree sentence.

**A class no earlier entry recorded: the drift carried PINNED TOOL SOURCE onto a pinned load path.**
Of the 67 paths that differ between `94dd136` and `92d5d0a`, two are among the receipt's 28 pins —
`src/memory/ownership.ts` and `src/memory/store.ts`. Instances 1-3 had a pin intersection of exactly
∅; instance 4's target `19b4746` had the same two and its entry does not say so. The underlying
edits are already adjudicated (`Ruling R-2026-08-19` and
`D-2026-08-22-in-window-pinned-source-edit`), so what is new is not the edits but the fact that they
RODE onto the marketplace clone, which is a pinned runtime load path. **The guard cannot see this
and did not object**: `scripts/freeze-runtime-check.sh` step 5 verifies the nine runtime-surface
files under both roots and nothing checks the 26 `payload.tools` in the clone. This does not change
the runtime verdict — source files are not loaded by the plugin — but it does mean the automated
control's coverage of the clone is the nine, not the twenty-eight. Widening it is queued for after
`txClose`, on the same grounds as the `head -3` fix above: it is the live guard.

**Healed 2026-08-20 12:36:06Z** (21:36:06 KST) back to `94dd136`, the seventh line of
`~/.cache/freeze-guard-heals.log` and the fourth automatic heal of this window. **Detection latency:
35 m 11 s** — with the standing caveat from instances 2-4 that the figure measures when a shell
happened to open, not how well the check works.

**The daily automatic opportunity was missed by 1 m 47 s.** The dogfood unit started 2026-08-20
11:59:08Z (20:59:08 KST) and its `ExecStartPre` found nothing to heal; the pull landed 107 seconds
later. This is instance 2's finding holding a fourth time, now from the near side of the margin.

### Instance 6 — 2026-08-21, and a run that DIED still spent its healing pass before dying

**Statement.** The clone fast-forwarded again on 2026-08-21 11:52:40Z (20:52:40 KST):
`pull origin HEAD: Fast-forward`, HEAD `94dd136 -> d93cb19`. Flags and environment unchanged. As
with instance 5, `helix.lastUpdated` has since been overwritten and the reflog is the only witness.

**Byte continuity. Unbroken**, measured the way instance 5 sets out: nine of nine pinned runtime
files at their pinned values at `d93cb19`; `bin/`, `.claude-plugin/` and `hooks/` git-identical; the
same three `data/inventory/*` files divergent and neither pinned nor plugin-loaded. Of the 90
differing paths the pin intersection is again `src/memory/ownership.ts` and `src/memory/store.ts`.

**Healed 2026-08-21 12:51:35Z** (21:51:35 KST), the eighth heal-log line and the fifth of this
window. **Detection latency: 58 m 55 s.**

**What this one adds.** Instance 2 established that a run which later dies has already taken its
healing pass, so run failure costs no heal. Today shows the other half of that claim and confirms
it: the unit started 11:15:11Z, its `ExecStartPre` healed nothing because there was nothing to heal,
and the run was then killed at 11:21:04Z (`code=killed, status=15/TERM`). The pull arrived 31 m 36 s
AFTER the unit had already exited. So the run's death is again not what left the clone off-pin —
the ordering is. The healing opportunity is one instant per day and it is spent whether the run
succeeds or not.

### Instance 7 — 2026-08-22, the clone returned to the commit it had just been healed away from

**Statement.** The clone fast-forwarded on 2026-08-22 04:03:43Z (13:03:43 KST):
`pull origin HEAD: Fast-forward`, HEAD `94dd136 -> d93cb19` — the SAME target instance 6 was healed
away from seventeen hours earlier. Corroborated independently of the reflog:
`known_marketplaces.json`'s `helix.lastUpdated` reads `2026-08-22T04:03:43.869Z`, the same instant
to the second, with `autoUpdate` `false`. CLI `2.1.239`.

**Byte continuity. Unbroken**, on the same measurement as instances 5 and 6 and against the same
target commit, so the readings are identical: nine of nine pins, three runtime trees git-identical,
`data/inventory/*` divergent and out of scope, pin intersection `src/memory/ownership.ts` and
`src/memory/store.ts`.

**Healed 2026-08-22 06:33:35Z** (15:33:35 KST), the ninth heal-log line and the sixth of this
window. **Detection latency: 2 h 29 m 52 s**, the longest of this window apart from instance 1's
14 h 17 m 20 s. The dogfood unit had started 01:19:23Z and finished 01:28:20Z, so the pull arrived
2 h 35 m after the unit exited and the automatic opportunity was again spent before the drift.

**What the three together establish, which no single one of them does.** Drift has gone from
intermittent to daily: 08-15, 08-17, 08-18, 08-19, then 08-20, 08-21 and 08-22 without a gap. Every
one of the last three was healed by a human opening a shell, never by the unit, and the unit's start
time now ranges 10:19-20:59 KST rather than the 10:43-20:01 recorded at instance 2 — a wider window
in which the one daily opportunity can fall on the wrong side of a pull. Instance 7 also shows that
healing restores state without fixing it: the clone returned to the same commit it had been reset
away from the previous day, because the refresh does not consult anything the reset changed. None of
this alters `D-2026-08-10`'s conclusion that prevention is unavailable; it raises the expected
number of remaining instances before `txClose`.

### Instance 8 — 2026-08-23, and a run that SUCCEEDED spent its healing pass 40 seconds too early

**Statement.** The clone fast-forwarded again on 2026-08-23 11:34:29Z (20:34:29 KST):
`pull origin HEAD: Fast-forward`, HEAD `94dd136 -> 7454033`. Both `autoUpdate` flags were `false`
and `DISABLE_AUTOUPDATER=1` was exported, unchanged since instance 1. Corroborated independently of
the reflog by `known_marketplaces.json`'s `helix.lastUpdated`, which reads
`2026-08-23T11:34:29.744Z` — the same second, with `autoUpdate` `false`. CLI `2.1.241`, read from
`/proc/<pid>/exe` of the session process that started two seconds after the pull.

**One ordering detail differs from instances 1-2 and is recorded as observed rather than forced into
their pattern.** There the pull landed 16 seconds AFTER a Claude Code session start. Here it
PRECEDES the live `claude` process's own start (`ps lstart` 20:34:31 KST) by two seconds, and
follows a refresh of two official-marketplace entries in `installed_plugins.json`
(`lastUpdated 2026-08-23T11:34:19.661Z`) by ten. The pull sits inside a startup refresh sequence
that begins before `ps` reports the process; nothing measured here names what issued it.

**Byte continuity. Unbroken**, measured the way instance 5 sets out rather than by the four-tree
sentence it retired: all nine pinned runtime files hash to their pinned values at `7454033`, and
`bin/` (`e6bd010a`), `.claude-plugin/` (`e47c958f`) and `hooks/` (`3e1b6a4a`) are git-identical to
the candidate's; the same three `data/inventory/*` files are divergent and neither pinned nor
plugin-loaded. Of the 97 differing paths the pin intersection is again `src/memory/ownership.ts` and
`src/memory/store.ts`, carried by four already-adjudicated commits — `7c22bfc`, `c3456ec`, `08bc3da`
(`R-2026-08-19`) and `95c65e7` (`D-2026-08-22`). **Runtime verdict: control/provenance deviation
with continuous runtime bytes**, on that pin-list measurement and nothing weaker. One difference
from instances 3-7, whose targets all reached this clone by `pull`: `7454033` was committed HERE
(2026-08-22 14:03:33Z) and pushed at 14:03:41Z, so instance 3's other-machine exposure is not in
play — this is the first locally-authored drift target since instance 2.

**Healed 2026-08-23 11:42:33Z** (20:42:33 KST), the tenth heal-log line and the seventh automatic
heal of this window. **Detection latency: 8 m 4 s**, the shortest of this window — and the standing
caveat from instances 2-7 holds undiminished: it measures when a shell happened to open, not how
well the check works. A shell again, and not the unit, for the fourth consecutive instance.

**What this one adds — it closes the pair instance 6 left half-measured.** Instance 2 established
that the healing opportunity is one instant per day and precedes the run; instance 6 showed a run
that was KILLED had already spent it. Today is the other side: the dogfood unit's `ExecStartPre` ran
11:33:49Z and exited 0 with nothing to heal, `ExecStart` then ran to completion at 11:45:51Z
(`Result=success`), and the pull landed **40 seconds** after that `ExecStartPre`. A successful run
therefore buys no more coverage than a dead one — the pass is spent at unit start and the run's
outcome does not touch it. Three of the eight instances have now landed within two minutes of the
daily opportunity: 59 s at instance 2, 1 m 47 s at instance 5, and 40 s here, the tightest recorded.

**And a push does not move the clone, which the two reflogs settle.** After `7454033` was pushed at
2026-08-22 14:03:41Z the clone did not move for **21 h 30 m 48 s**. Across the 29 h 0 m 54 s between
instance 7's heal and this pull, origin advanced five commits — `bc0614e`, `03af698`, `0f8b304`,
`337690a`, `7454033` — the clone stayed on the candidate throughout, and the pull then took all five
in one fast-forward. This bounds the trigger from one side only, and the other side is NOT measured
here: whether a session started inside that gap without pulling.

**Nothing here changes the operating mode.** Prevention remains unachievable with documented
configuration (`D-2026-08-10`), detection plus reset stays the mode, and this is the eighth instance
in the nine days since 2026-08-15, with 08-16 still the only gap. Expect further instances before
`txClose`; each is appended here.

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

## Deviation D-2026-08-18-in-window-product-rebuild — RULED 2026-08-19: NOT A RESET

**Status: RULED 2026-08-19 — NOT A RESET (Ruling R-2026-08-19 below).** As first written this line
read: the ruling is the owner's and has not been taken. The HEADING above carried the same stale
word until 2026-08-22; it read `— RULING PENDING`, which this line had contradicted since 08-19. This entry records the facts, the rule
they land on, and the readings, in the shape D-2026-08-13 established. Nothing here asserts a reset;
nothing here asserts the window continues.

**What happened.** On 2026-08-18, inside the second window, a dogfooding session drove the shipped
bundle to verify claims the documents make, found defects, and fixed them under TDD. Six of the ten
commits edited `src/` and rebuilt `bin/`; `npm run build` ran eight times. At session start `bin/`
was byte-identical to the candidate — `git diff 94dd136 a59e3ad -- bin/` is empty — and it is not
now: `git diff a59e3ad HEAD -- bin/` reports four bundles changed, 92 insertions, 25 deletions. The
rebuild was not incidental to the fixes: `test/plugin/packaging.test.ts` rebuilds from `src/` and
byte-compares against the committed bundles, so any `src/` edit turns it red until `bin/` follows.

**Detected** the same day, by reading `test/acceptance/trust-store-home.e2e.test.ts` while extending
it. The constraint lives in that file's own comment ("the window forbids rebuilding `bin/`") and in
the standing-scope paragraph of this ledger. No document outside the test tree states it, and it was
not checked before the first commit. That is the process failure this entry is primarily about.

**Byte continuity: BROKEN in the repo tree.** Every prior entry in this ledger could record unbroken
runtime bytes. This one cannot. What bounds it instead is reach:

- Nothing was pushed. 20 local commits sit ahead of `origin/feat/helix-v1`, which is still `5c6e1c7`.
- The marketplace clone — a pinned runtime load path — is still `5c6e1c7` carrying the candidate
  bundle (`md5 c18253ee…`), unchanged by any of this.
- The measuring host is not this machine. The receipt's `runtime.loadPaths` are rooted in a
  different account's home directory; that account does not exist on this box, and the local
  `~/.helix` holds no ledger at all. The only route from this box to the pinned load paths is
  `git push`, and it was not taken.
- This box's own plugin cache WAS hand-replaced with each rebuilt bundle (five `rsync` runs), so the
  local runtime is off-candidate. That path is not among the receipt's pinned load paths.

**Consequence already realised regardless of the ruling.** The three `itUnlessFrozenBundle` cases in
`test/acceptance/trust-store-home.e2e.test.ts` were skipped throughout, as designed. Every "N tests
passed" figure reported during the session excluded them, and none of those reports said so.

**Three readings, for the owner.** (1) The Reset paragraph's FIRST limb is reached directly: "any
intervening **system**, config, rule, or metric change resets the window", and the system under
measurement is exactly what was edited and rebuilt — a stronger fit than the tooling clause that
triggered D-2026-08-13, where the artifact was method tooling rather than the product. (2) The
tooling clause is NOT reached — `src/` and `bin/` are the measured product, not the method's tooling
— and this ledger's standing-scope paragraph says only that the two prior rulings do not *license* a
rebuild, which is not itself a ruling that one resets. A fresh ruling is required either way. (3)
Reach bounds it: no pinned load path moved, nothing was pushed, and the measuring host cannot see
this tree, so the window continues with this entry as the record and the local rebuild treated as
off-instrument work.

**Measured cost if the window resets, as of this entry.** The second window opened
2026-08-14T06:20:01Z; 4.1 days have elapsed against a measured accrual of about 0.87 rows per day,
so roughly 3.5 of the required `k = 20` rows fall below a new cutoff and leave the probe population
permanently. The close instant moves from 2026-09-11T06:20:01Z to 28 days after the new cutoff.
Mechanically a reset is indistinguishable from a re-freeze — new candidate commit, re-issued
receipt, new freeze commit — for the reasons D-2026-08-13 records.

**Owner decisions already taken 2026-08-18**, which do not settle the reading above: the ten commits
are kept on `feat/helix-v1` rather than moved to a branch; this box's plugin cache stays on the
rebuilt bundle rather than being restored to the candidate, because it is not a pinned load path and
restoring it would reopen the defects the session closed; and no push is made while the window is
open.

**What the session produced, for the reset-and-deviation history.** Ten commits: six defect fixes
(an adopt argument that named nothing being accepted; a config file discarded whole in silence; a
written `egressPolicy` `block` never applied; a project store relocatable behind a symlinked `.owner`
and then behind a symlinked `.helix`; the effective egress legs shown nowhere) and four documentation
corrections where the shipped prose asserted the opposite of shipped behaviour. Each carries a test
that drives the behaviour rather than reading the prose.

**Addendum 2026-08-19 — the reach bounds above are falsified; the branch's `bin/` returned to the
candidate bytes.** All three containment bounds this entry relied on have since failed, in order:
the commits WERE pushed (origin reached `19b4746` by 2026-08-19 17:33 KST), the marketplace clone —
a pinned runtime load path — pulled them at 20:55:31 KST (Instance 4 of D-2026-08-15, four of nine
pin-list files off-pin, first byte-discontinuous drift of either window), and so the "only route"
this entry said was not taken was taken. The 2026-08-18 owner decision recorded above ("no push is
made while the window is open") and the observed push therefore diverge; this addendum records the
fact and asserts nothing about intent. Reading (3) as written is no longer available — the ruling
between readings (1) and (2) remains the owner's and has become more urgent, not less.

Operational remediation, owner-approved in-session 2026-08-19: the four divergent bundles
(`bin/helix-mcp.mjs`, `bin/helix-rebaseline.mjs`, `bin/helix-trigger.mjs`,
`bin/hooks/session-start.mjs`) were returned to the candidate bytes on this branch — precedent
`b4997cd`, the first window's identical operation — and all nine pin-list files re-verified OK.
Measured consequence, disclosed rather than implied: `test/plugin/packaging.test.ts` reports
**1 failed / 6 passed** (the rebuild-and-byte-compare case; the six manifest checks stay green).
That is the first window's by-design state, and R-2026-08-16(a) split typecheck into its own CI job
precisely so this red silences nothing. **Standing instruction until `txClose`
(2026-09-11T06:20:01Z): `bin/` on this branch stays at the candidate bytes — `src/` work rides
WITHOUT rebuilding `bin/`, and packaging-red is the expected state, not a defect to fix.** This
ledger is on the branch both clones pull, so the instruction travels with the bytes it protects.
This addendum takes no position on the §8 reading; it restores the load-path premise the window's
continuation arguments assume.

## Ruling R-2026-08-19 — the in-window product rebuild is ruled NOT a reset

Recorded in the shape R-2026-08-16 established, because this ledger is the §9a report's source for
reset history.

**The clause was put to the owner verbatim** on 2026-08-19 — both limbs of §8 Reset, the three
readings of the entry above (with reading (3) already falsified by the push and Instance 4), the
measured cost of each outcome, and one fact the entry as first written did not carry: of the 81
commits in `94dd136..19b4746`, THREE edited pinned paths — `src/memory/ownership.ts` (`08bc3da`,
`c3456ec`, `7c22bfc`) and `src/memory/store.ts` (`7c22bfc`). The owner ruled with all of that in
front of them.

**Ruled NOT A RESET, on reading (2)'s grounds:**

- *The tooling limb is not reached.* `src/` and `bin/` are the measured PRODUCT, not the method's
  tooling; fixing product defects resolved no unspecified METHOD detail, which is the harm that
  limb exists to prevent.
- *The first limb is not reached on the surface the window measures.* Every pinned measurement of
  the close chain runs from a clean checkout of the CANDIDATE commit
  (`v2-close-procedure-2026-08.md`, "The rule"), and the runtime load paths were restored to the
  candidate bytes the same day the drift reached them (Instance 4 heal; branch `bin/` returned at
  `506e2fc`). Branch-tip edits — including the three pinned-path edits, whose pins bind the
  CANDIDATE's hashes, not the branch's — change nothing the window measures.
  `scripts/freeze-guard.ts:17-19` records the same doctrine: undeployed repo work during the window
  is legitimate; the close chain runs from the candidate commit, not from this tree.

**What this ruling does NOT do.** It licenses nothing: no further in-window rebuild of `bin/`, no
further pinned-path edits, no redeploy. The standing instruction of Instance 4's addendum — `bin/`
on this branch stays at the candidate bytes until `txClose` — remains in force, and a recurrence
lands back on the clause with this ruling as precedent to DISTINGUISH, not to extend: what was
ruled is one remediated incident, not a class permission.

**Consequence accepted with the ruling.** The window runs to its scheduled close,
`txClose 2026-09-11T06:20:01.000Z`, carrying the §5 sample state as measured (0 eligible against a
floor of 2 at the 2026-08-18 measurement); declining the reset declines the restart vehicle for
that starvation. The separate Disclosure R-2026-08-18 below (in-window computation of the
eligible-probe count) is NOT covered by this ruling; its own disposition — NOT A RESET, ruled
2026-08-18 — is recorded below, together with R-2026-08-18b.

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

**The grounding for that run, corrected.** An earlier form of this entry rested it on §8's "the
prepare phase … may be run at any time". That is imprecise: §9's ordering lists "manifest /
candidate universe / classifier" and "prepare" as SEPARATE steps, so the phrase does not literally
name `generate-manifest`. The run is still permitted, on the stronger and more direct ground —
§8's positive permission ("Permitted: nothing derived from ranks") together with its closed
forbidden list, none of whose three members occurred.

**One question a reviewer raised and the record can settle.** Whether that run was the forbidden
act — §8 forbids "running the pilot runner over window records" — turns on which program the
"pilot runner" is. It is `scripts/pilot/run-pilot.ts`, whose header reads *"Pilot runner (protocol
§execution, preregistration §9 item 5) … probes MemoryStore.recall at the manifest K"*. That
program was NOT run. `generate-manifest.ts` is a different pinned tool and touches no recall.

**The two readings, each with its best support.**

*Not a reset.* §8's own usage of "the method's tooling" is visible in §9b, which names what it
meant: the runner's payload/receipts split, and the freeze receipt, ordering receipt and release
record, which "have no producer yet" — and says they must land before the freeze "since building
them afterwards would resolve method choices". **Corrected 2026-08-18:** an earlier form of this
sentence said every instance was a producer that DID NOT EXIST, and that is false for the first of
the two bullets — the runner already existed ("It currently writes `{ k, results }`") and §9b
requires modifying it. The surviving common property is narrower and is the one that matters: every
instance ISSUES AN ARTIFACT OF THE §9 CHAIN. A disposable recomputation of an already-frozen rule
issues no such artifact and resolves no choice. §8 additionally states that "Counting qualifying exposures during the window
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
what the document itself calls the method's tooling, all of which issue artifacts of the §9 chain.
(An earlier form said "did not exist"; that is false for the runner bullet — see the correction in
the disclosure above.)

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

### DISPOSITION of R-2026-08-18 — NOT A RESET, ruled 2026-08-18

**The ruling.** The six passes reimplemented two frozen RULES but built none of THE METHOD'S
TOOLING, which in this document's own uses of the term denotes the programs that execute or issue
evidence for the measured chain. The act produced no input to any chain step and changed nothing on
the measured surface. The window stands; the close remains `2026-09-11T06:20:01.000Z`.

**Who ruled, and the conflict, stated first because it is the reason to read the rest sceptically.**
The party recording this disposition is the party that directed the work which performed the
reimplementation. No clause of the frozen method names a determiner, creates recusal, or provides
external adjudication — searched for, and there is none. Single-party operation is a PRE-REGISTERED
standing condition of this pilot rather than a new defect: `pilot-protocol.md:38-43` already caps
the exercise as "development evidence, not independent efficacy evidence… the same author and
development process". The integrity claim therefore rests on procedure and record, not on an
independent adjudicator — which is why everything below is written to be checked rather than
believed.

**The reasoning, and it turns on a distinction the 2026-08-13 ruling left open.** That ruling
settled the sentence's MODALITY — "building alone triggers the reset whether or not the program is
ever run". It did not settle its SCOPE: what the definite description "the method's tooling"
denotes. The ruling itself shows the axis it closed, by naming the three arguments it rejected —
the placement argument, the cannot-move-the-gate argument, and the chain-runs-without-it argument
(close report §4.6). **All three concede the program IS the method's tooling and argue it is
harmless.** This disposition denies class membership instead, which is the axis left open.

The document answers the scope question itself. Every use of "tooling" in the preregistration
denotes a program of the pinned measured or reporting chain, and the frozen surface carries its own
gloss in a PINNED file — `pin-hashes.ts:145` "Every program the measured method runs", and `:162`
"the boundary is 'decides a rank or issues the evidence'". Against that boundary the two acts
separate, and the separator is not persistence:

- `adjudication-skeleton.ts` wrote `--adjudication`, an input `score-gate.ts` REQUIRES and refuses
  without. It was destined for the chain and now IS the chain, pinned as the 26th tool.
- The Python produced a console number. No chain step takes it as input and none could. That would
  remain true if the files were still on disk.

**The cost of the wider reading, measured rather than asserted.** Read "the method's tooling" as any
implementation of any frozen rule, however brief, and it reaches `test/pilot/derive.test.ts:7`,
where a human executed the frozen rule by hand and wrote the expected list into an assertion. That
collides head-on with the pinned file's own statement that a program which neither decides a rank
nor issues evidence is "ordinary in-window test work" which criminalising "would protect nothing"
(`pin-hashes.ts:176-179`). A reading that makes a pinned file's stated position unlawful is not the
plain reading; it is a wider one.

**The first limb disposed of separately, mechanically.** All 26 `payload.tools` blob ids and both
`payload.methodDocs` sha256 values were recomputed against the receipt: 0 mismatches. The config
hash equals `payload.config.sha256`. No metric changed, and no §9a-mandatory section was rewritten
around a number — which is the exact condition under which the first limb WAS applied on 2026-08-16.

**The dissent, answered rather than noted.** An independent reviewer ruled RESET on §8's unqualified
"any" plus the 2026-08-13 precedent. That is rejected on the modality/scope distinction above: "any"
quantifies over the method's tooling, and the question is what falls inside that noun. Its two
supporting facts are UPHELD, as findings of conduct, and appear below.

**Conduct findings, which the disposition does NOT clear.** The rule is cleared; the conduct is not,
and the entry must not let the first do the work of the second.

1. **The permitted path existed throughout and was not taken first.** `generate-manifest --after
   <tx> --close <tx>` is the documented holdout form and produced the same count seven minutes
   later. Building a second implementation was never necessary to exercise what §8 grants. The
   ORDER was wrong: the auditable instrument should have run first.
2. **This is the class this codebase flags as hazardous, done without the lock the codebase
   requires.** Where a frozen rule is restated here the restatement is declared and its equivalence
   pinned by a named test — `liveRows` (`generate-manifest.ts:70-75`) and `gitHashObject`
   (`pin-hashes.ts:130-143`, "A blob id that only this program can reproduce would pin nothing an
   outside reader could check"). Neither was done. And the port necessarily transcribed pinned
   bytes: `pilot-protocol.md:127` specifies only "a fixed stopword list"; the 41 terms exist solely
   in `derive.ts`.
3. **It left an act no outside reader can audit.** Nothing persisted, so nothing can be checked.
   By this project's own standard, non-persistence is WORSE for the record than persistence — the
   2026-08-13 program at least left a blob that is now pinned. This disposition deliberately does
   not rest on the throwaway property, because a reader cannot verify it.
4. **The permitted run minted a manifest-shaped artifact out of chain order.** It carries this
   window's bounds and is dated 2026-08-18. It lives in a session scratch directory outside the
   repository and outside every close-chain path; its sha256 is
   `d749286e8574776d803f1f58d5a53bd45627b5dc24a59131a73d8aa3ee8f4666`. Recorded so it can never be
   confused at the close with the chain's manifest — §9 names exactly this shape in its threat
   model.
5. **Stated in the plainest available words:** the rule was read narrowly on one axis and the
   window kept, by the party that would benefit.

**What a stranger can check without trusting the ruler**, kept separate from the characterisation:
the bounds `10:51:48Z`–`10:58:05Z`; that no file entered the repository (`4747b9b` touches two
`docs/release/*.md` and nothing else, tree clean); that the forbidden act is `run-pilot.ts` and it
did not run; the 11:05:39Z invocation and the sha256 above; and the 28-pin plus config verification
with its 0-mismatch result. **Not reader-checkable, and said so:** the passes' internals and the
non-persistence claim are attested, not auditable.

**The anchor was fixed BEFORE the ruling, and that is the record's strongest feature.**
`2026-08-18T10:58:05Z` was committed at `4747b9b` and pushed while the disposition was still open,
so the reset reading's own restart point cannot have been chosen to suit the outcome.

**Standing scope.** This covers an ad-hoc recomputation of an already-frozen rule that produces no
input to any chain step. It does NOT license: editing any of the 28 pinned paths; rebuilding
`bin/`; re-measuring a metric a §9a-mandatory section is then rewritten around; or **authoring a
producer for any §9-chain artifact that lacks one — and one such gap is LIVE.** The close-bounded
snapshot has no producer script (the run-sheet's C1 says "BY HAND. There is no producer script"), so
writing a snapshot builder today resets this window under this very reading.

**A second instance of the same class — ADJUDICATED the same day as `R-2026-08-18b` below, NOT left
for the close.** `docs/issues/2026-08-12-home-pin-check.sh`
was rewritten to v3 inside this window (its banner records that every expected value was replaced
after the 2026-08-14 re-freeze; mtime 2026-08-17T14:05:10Z), and it is a hand-written second
implementation of freeze-pin verification. It has never been put as an §8 question. The same rule
must be applied to it and the answer recorded, or this ledger's reset history is incomplete. It does
not move the anchor under a reset reading — `10:58:05Z` is later. Recorded here, against the ruler's
interest, in the same breath as the narrowing, and disposed of in `R-2026-08-18b` — also NOT a
reset, on the `D-2026-08-09` precedent rather than on argument.

**Barred reasoning.** No part of this disposition leans on the VALUE of the eligible count. The
grounds are the scope of a noun across the document's uses, §8's express permission and closed
forbidden list, and a 0-mismatch measured-surface check — each identical whether the count is 0, 2
or 20. The available argument "the two runs agreed, so no information was withheld" was DECLINED,
because it is retrospective and contingent on holdout content; the prospective form is used instead:
the information sought was information §8 permits obtaining at any time by an outcome-blind path,
whatever it turned out to be. One passage in the supporting analysis did lean on the value (it
argued the agreement is weak because 0 is a boundary value); it is discarded, and its conclusion is
accepted only on the independent ground that the frozen run came second.

### DISPOSITION R-2026-08-18b — the home-machine pin script's in-window rewrite, NOT A RESET

**Raised against the ruler's own interest.** The disposition of `R-2026-08-18` named this as a
second, unadjudicated instance of the same class. It is adjudicated here rather than left for the
close, and by the same party, with the same conflict: the v3 re-anchoring was mine.

**What it is.** `docs/issues/2026-08-12-home-pin-check.sh` — machine-local, gitignored, never
tracked, 18,768 bytes, banner v3.2 dated 2026-08-17, sha256 `0b5b11b5f59586985f0ec5952b974c213e5c94dcb692645fe0fa2681d8c50ef2`.
It is the operator's read-only verification of the SECOND machine's deployment: the one surface the
close report says it "cannot re-derive from the measuring box" (§2.3). It was created 2026-08-12 —
inside the FIRST window — and rewritten to v3 inside this one, because the re-freeze replaced every
expected value it carries.

**Read-only, measured rather than asserted.** The file contains no write, no `tee`, no `mkdir`,
`rm`, `cp` or `mv`, and no `git reset`/`pull`/`checkout`/`clean`/`fetch`. Every redirection in it
is `>/dev/null`. It reports to stdout and changes nothing.

**Ruled NOT A RESET, on precedent rather than on argument.** `scripts/freeze-runtime-check.sh` was
**created 2026-08-09, inside the first window** (commit `2fdc1ca`), is a verification program
written from scratch during a measurement window, and its output — the heal log — is cited FOUR
times by the §9a close report. This ledger's own `D-2026-08-09` entry disposed of it: "**No-reset
determination.** A measurement-window reset is NOT required". That first window then ran four more
days and was reset for the adjudication producer, **not** for the guard.

The home-machine script is the same class and a weaker case for reset on every axis: it is
read-only where the guard mutates a clone; it is untracked where the guard is committed; and it runs
on a machine that executes no step of the chain. Applying the `R-2026-08-18` test directly — does it
decide a rank, or issue an artifact of the §9 chain? — it decides no rank, and what it issues is an
operator observation report, which stands to the §9a report exactly as the heal log does. That
relationship was already ruled outside the clause.

**Conduct findings, and they differ from the Python's — the two must not be lumped.**

1. **This one is auditable, and that is the material difference.** `R-2026-08-18`'s heaviest conduct
   finding was that nothing persisted, so no outside reader could check the act. Here the artifact
   persists, carries a version banner, a recorded sha256 and a companion document, and can be
   re-read by anyone the file is transferred to. By this project's own standard that is the right
   shape, not the wrong one.
2. **The v3 edit was not only a re-anchoring, and the record should not imply it was.** Beyond
   replacing the candidate, window bounds, runtime pin hashes and the pin path list, it **removed a
   decision branch** — the comparison of the pin ∩ changed set against a "known acceptable" set.
   The reason is that the second window's known set is empty, so a branch comparing against an empty
   expectation can only manufacture reassurance; the two remaining outcomes are "none" and "new
   finding". That reasoning is the ruler's own and a reader should check it rather than accept it.
3. **`R-2026-08-18`'s conduct finding 1 does NOT transfer.** There, a permitted frozen path existed
   and was not taken first. Here there is none: no frozen tool verifies a second machine's
   deployment, which is precisely why the report calls that surface non-re-derivable.

**Standing scope.** This covers a read-only observation script, outside the repository, whose output
the §9a report cites as verification evidence. It does not license writing a producer for any §9
chain artifact — the close-bounded snapshot still has none, and writing one today would reset this
window under the reading applied here.

## Deviation D-2026-08-22-in-window-pinned-source-edit — RULED NOT A RESET

Recorded in the shape R-2026-08-16 established, because this ledger is the §9a report's source for
reset history.

### The facts, measured

| | |
|---|---|
| Commit | `95c65e7` *"fix(memory): cap commit content at the schema AND the store, so one oversized fact cannot become a permanent per-read cost (H3)"* |
| Author date | 2026-08-20T09:00:28Z — **inside** the window (`2026-08-14T06:20:01Z < tx ≤ 2026-09-11T06:20:01Z`) |
| Path | `src/memory/store.ts` — **one of the 28 pins** (`payload.tools`) |
| Change | 8 lines: a 6-line comment and a 2-line length check at the head of `commit()` |
| Origin | the second clone, which owns v0.1 certification. It reached this clone by a `pull` at 2026-08-21T11:52Z together with 26 other commits |
| `bin/` | **unchanged.** The deployed runtime is still the candidate bytes; `scripts/freeze-runtime-check.sh` exits 0 |
| Detection | manual. The guard compares the deployed cache and the marketplace clone, not the worktree, so a pinned *source* edit is invisible to it |

### A fact the first draft of this entry did not carry, measured 2026-08-22

`95c65e7` is the store half of finding H3. Its **schema half is `1cf487f`** (2026-08-20, *"one
authoritative table for input and response caps (H3/M1)"*), which arrived in the same pull and added
input-size caps to four tool schemas — `maxLength` 65536 on the dual-verify `question`/`helixAnswer`,
16384 on `helix_memory_commit.content`, `maximum` 200 and 10000 on two recall parameters, and 4096
and 2048 on the two recheck parameters.

That desynchronized the SOURCE tool registry from the shipped bundle, and
`scripts/inventory/extract-tools.ts:112` (`compareSurfaces`) asserts the two are equal. The
consequence is **three suite failures that no status document records**: `extract-tools` twice and
`inventory-drift`. The project's recorded baseline of 3 pre-existing failures is therefore stale;
the measured baseline on 2026-08-22 is **6**, and all six are one class — source ahead of the frozen
bundle. `compareSurfaces` prints only tool NAMES on a disagreement, and the names are identical
here, which is why the cause stayed unidentified: it was found by diffing the two surfaces directly.

This does not move the measured surface — the deployed bytes are unchanged — but an entry that said
"no source-side consequence" would have been false, and the recorded failure baseline needs
correcting independently of this ruling.

**Corrected 2026-08-22: the sentence above named the wrong document.** It read "the §9a report's
failure baseline". The §9a report carries no failure baseline — the word does not occur in it — and
the close run sheet does not ask for one, because §9a content is the measured chain rather than the
development suite. The stale baseline lives in the untracked defect ledger, where the 2026-08-20
reading of "3 failed" was TRUE when taken: the two commits that added the other three arrived in
this clone by the 2026-08-21T11:52Z pull, after that measurement. It has now been superseded in
place, with all six failures named individually and an instruction to gate on the names rather than
the count, since gating on the count is what hid these three for two days.

### The write-path point, stated rather than buried

The change is on the **write path**. The W-CITE analysis established that `buildRankArtifacts`
tokenizes persisted `record.content`, so write-path changes move the measured *corpus* — pinning
protects the algorithm, not the data. A commit-length cap can in principle change which records
exist. Against this: the cap is not in the deployed bytes, so no record minted in this window was
affected by it. That is checkable, and it is true as of 2026-08-22.

### DISPOSITION — NOT A RESET, ruled 2026-08-22

The owner ruled with the facts above in front of them, including the `1cf487f` consequence and the
write-path point. **Ruled NOT A RESET, on R-2026-08-19's grounds:**

- *The tooling limb is not reached.* `src/` and `bin/` are the measured PRODUCT, not the method's
  tooling. A commit-length cap resolves no unspecified METHOD detail, which is the harm that limb
  exists to prevent.
- *The first limb is not reached on the surface the window measures.* Every pinned measurement of
  the close chain runs from a clean checkout of the CANDIDATE commit
  (`v2-close-procedure-2026-08.md`, "The rule"), and `94dd136` does not contain this commit. `bin/`
  is unchanged, the deployed cache and marketplace clone remain candidate-identical, and
  `scripts/freeze-guard.ts:17-19` records the doctrine directly: undeployed repo work during the
  window is legitimate.

**Precedent.** Both prior instances of this exact shape were disposed of the same way —
`D-2026-08-09` (in-window marketplace drift) and `R-2026-08-19` (the second clone's in-window `bin/`
rebuild, which hit three commits across `ownership.ts` and `store.ts`). `R-2026-08-19` is the
closest: the **same file** and the **same clone**. The only candidate difference is the write-path
point above, and it does not survive the fact that the cap never reached the deployed bytes.

**What this ruling does NOT do.** It licenses nothing: no further pinned-path edits, no in-window
`bin/` rebuild, no redeploy. A recurrence lands back on the clause with this ruling as precedent to
DISTINGUISH, not to extend — what is ruled is one disclosed incident, not a class permission. It
also does not clear the detection gap: a pinned *source* edit remains invisible to the automated
guard, and the only thing that caught this one was a manual edit-set check.

**Consequence accepted with the ruling.** The window runs to its scheduled close,
`txClose 2026-09-11T06:20:01.000Z`, carrying the §5 sample state as measured — 4 in-window probes
and **0 eligible** against a floor of 2 at the 2026-08-21 measurement. Declining the reset declines
the restart vehicle for that starvation, and the owner declined it knowing so. The disposition of
the resulting shortfall is deferred to the close instant, when eligibility is recomputed against
every live competitor, rather than settled now: amending the pass rule while its outcome is pending
is what the fixed-close architecture of §5 exists to prevent, and it would buy no schedule in any
case, since the close instant and the post-close `bin/` rebuild are fixed independently of it.
