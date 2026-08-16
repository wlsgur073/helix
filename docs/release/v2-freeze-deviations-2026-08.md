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
