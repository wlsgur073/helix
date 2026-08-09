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
itself. No known_marketplaces.json history survives. Raw captures: the local (gitignored)
evidence dir `docs/superpowers/evidence/2026-08-09-autoupdate-deviation/`.

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

**Method note.** The remediation design was cross-checked with Codex (compare mode, 2 rounds,
convergence declared); the divergence why-log lives in the local design spec
(`docs/superpowers/specs/2026-08-09-autoupdate-guard-restore-design.md`).
