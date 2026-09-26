# Helix v0.1.0 release record

Helix has never been released, and `v0.1.0` is its first release. This file is the whole release
record: it replaces the 25 files this directory held until 2026-09-26, which stay readable from git
(see *Artifacts and source records*). Two names are not versions of the product: `v0.2.0` was a
release attempt withdrawn in July 2026 before anything was published, and `v2` is protocol v2, a
recall-measurement method.

## Status on 2026-09-26

The last certification, 74 of 74 rows at candidate `8abd984` on 2026-09-24, is retired: the C3.1
corrections of 2026-09-25 rotated claim blocks that the candidate receipt pins, and this
consolidation changed the claim ledger again and one error message in `bin/helix-mcp.mjs`. What is
left, in order:

1. **Re-cut.** On a host with Node 24: `npm ci` and `npm test`. Set the `CHANGELOG.md` release date to
   the declaration day and classify the block that rotates in `data/inventory/claims.json`. Commit,
   run `npm run cut-candidate`, and commit the receipt it writes.
2. **Certify.** Run *Certifying a candidate* below from the top until `npm run certify-gate` exits 0.
3. **Declare.** Fast-forward `main` to the commit that records that certification, the one whose
   receipt and verdict ledger both name the certified candidate. Switch the GitHub default branch to
   `main` at the same time: `claude plugin marketplace add wlsgur073/helix` installs from the default
   branch, which is `feat/helix-v1` today. Then push an annotated `v0.1.0` tag (`origin` has no tags
   yet) and publish the release notes.
4. **Owner acts**, on the machine that holds the deployment and the archives:
   - the C4.6-Q4 encrypted backup, copied to a separate medium (it regressed to open on 2026-09-03,
     because the copy sat on the same physical disk as its source);
   - a durable off-machine copy of the non-secret close-run evidence, not on the Q4 medium;
   - an offline copy of `helix-snapshot-2026-08-31.tar.gz.gpg`, which holds the ledger signing key,
     on the same separate medium as the Q4 copy;
   - C5.1 closure item 12: an off-machine bundle of the release candidate and its tag, made last;
   - a reinstall from the tag there, reading `installed_plugins.json` for `gitCommitSha` first if
     that is not the machine the certification runs used.

Nothing on the list prepares a version after `v0.1.0`.

## What the release claims

The claim surface is `README.md`, `SECURITY.md`, `CHANGELOG.md` and this file. Every block of those
four files is classified as claim, procedure or non-normative in `data/inventory/claims.json`, which
the suite checks, and the certified rows (74 at the last cut) are in `data/inventory/verdicts.json`,
each bound to one candidate. Editing any of the four, this file included, rotates block ids that
`claims.json` must classify again before the suite passes.

**No recall-quality claim.** `v0.1.0` ships with no hit rate, no accuracy figure and no other claim
about how well recall ranks. Two measurements were meant to support one; neither did. On 2026-09-09
the owner ruled that this bars the claim, not the product (readiness criteria §14).

### The recall measurements

**The first-edition pilot, July.** Preregistered and frozen at `0eae7dc` on 2026-07-20 as the
acceptance test for `v0.2.0`, amended once before it ran, and executed on 2026-07-21/22 over 51
probes (25 from the ledger, 26 from an oracle). The registered 51-probe verdict is NOT MET,
permanently, and the conditional Hit@1 gate failed at 27/28 (O_67 ranked third on both manifests,
outside the pre-execution waiver). It was development evidence, not independent efficacy evidence,
and its failure produced the gate decision below.

**Protocol v2, August.** The registered method put every ledger record with cutoff < tx ≤ close in
the population, where the cutoff is the candidate commit's authored time and the close is fixed 28
days later rather than left to a stopping rule. The primary measurement was Hit@1 = m/m (every
eligible probe ranks first, K = 20), with a floor of two distinct eligible targets. A pass would have
licensed one process-integrity claim and never "Helix recall performs well". The window was frozen
on 2026-08-02, reset on 2026-08-13 because close-day tooling was built inside it, re-frozen on
2026-08-14 against candidate `94dd136`, and ended by the owner on 2026-08-31 (Abort A-2026-08-31,
T_abort 10:02:21Z, anchored at `ee35e41`), eleven days before its close. The primary measurement's
final state:

> Hit@1 — exposure 1 is below the minimum of 2, so the primary measurement did not happen
> (PARTIALLY EXERCISED — 1/2 (minimum not met))

and the abort record's statement, which travels with any number taken from that window:

> Nothing is released on this record: the gate blocked at sample sufficiency (eligible Hit@1
> exposure 1 against a minimum of 2), so the primary claim was not measured. These numbers are
> development evidence of an ABORTED window — Abort A-2026-08-31, T_abort 2026-08-31T10:02:21.000Z,
> eleven days before the derived close — and no pre-registered close claim attaches to them.

Two disclosures travel with it. On 2026-08-18 the frozen rules were re-coded in a throwaway script
inside the window (R-2026-08-18). The party that directed the work ruled it no reset, an independent
reviewer ruled it one, and the conduct findings stand; the abort record cannot prove the abort
decision independent of it. And of the eight deviations in the window's ledger, only
D-2026-08-13-in-window-tooling reset it; the rest (marketplace-clone drift from CLI auto-updates, an
in-window product rebuild, an edit to a pinned source file, two rehearsal slips) did not, and only
one broke byte continuity, for 1 h 32 m 27 s on 2026-08-19. The close-day checklist was never run as
a close (3 of its 112 boxes are ticked); its pinned chain ran once, on 2026-08-31, over the corpus
that ended at T_abort. That run's 14 evidence artifacts, listed in Appendix A of
`v2-close-report-2026-08.md`, are held outside the repository.

## Rules still in force

- **What the release notes may say (§14).** No Hit@1 or other recall-quality number and no
  inferential recall claim; a pilot number only together with the abort record's statement above;
  the unmade measurement reported as unmade, never as a pass and never by silence (D5). Do not
  write that every runtime identity pin held: on 2026-08-19 the marketplace clone served
  non-candidate bytes for 1 h 32 m 27 s.
- **A future recall-quality claim** needs a new preregistration, freeze and 28-day window under C5.2,
  bound by the pilot amendment's §f and the gate decision below. §f: freeze the system and config
  identity, the eligibility and mapping rules, K and every metric, the holdout cutoff and a minimum
  sample or stopping rule before the window opens; let nothing in the holdout inform a product or
  remediation decision, including when to stop; never count a fix's recheck as holdout evidence.
- **The gate decision of 2026-07-22 (D1–D5), unchanged.** D1: a preregistered protocol is the path,
  and a signed O_67 deviation stays rejected unless freshly authorized. D2: choosing a protocol is not
  a preregistration until every §f element is frozen. D3: the window opens at the freeze, any system,
  config, rule or metric change resets it, and a starved window is reported unexercised. D4: both v1
  manifests may be reused early without gating (not done for `v0.1.0`). D5: a successor discloses
  how v1's O_67 result shaped it, validates a revised rule on new temporal cases only, and reports an
  absent class as unexercised, never as silently validated. One known slip: it gives the second
  window's instants as 06:12:55, and the freeze receipt's 06:20:01 is authoritative.
- **Receipts are immutable.** The freeze receipts and the candidate receipt are sealed: never edit
  them, and never delete the void one. A moved window is a new receipt against a new candidate.
- **Accepted limitations.** L1: the trust tier's effect on decisions is unevaluated. L2: there is no
  one-step undo for a permanent erase or a wrong supersede; the recovery playbook is the remedy. L3:
  the line between user-relayed and agent-inferred provenance can read ambiguously.

## How the release got here

| when | what happened |
|---|---|
| June 2026 | `main` and an annotated `v0.1.0` tag were cut and bundled off-machine; on 2026-06-21 the owner deferred the public push. That tag was never pushed, and the tag cut at the declaration supersedes it. |
| July 2026 | A `v0.2.0` cycle opened with a release audit and a preregistered recall pilot, which failed on 2026-07-21/22. Nothing was published, the version returned to `0.1.0` on 2026-07-22, and that day's gate decision still binds. |
| 2026-07-24 → 07-31 | Readiness criteria ratified, the C3 audit and C4 drills run, C5.2 turned into a fixed 28-day window, protocol v2 drafted. |
| 2026-08-02 → 08-31 | Protocol v2 frozen, reset, re-frozen and aborted before its primary measurement happened. |
| 2026-08-19 | First certification run: blocks A–D pass, E blocked. |
| 2026-09-02 → 09-24 | Certified 74 of 74 five times; each rebuild of `bin/` retired the run before it. |
| 2026-09-09 | The owner's §14 ruling, the first C3.1 re-run, and five records with nothing left to do removed. |
| 2026-09-25 | The C3.1 delta at `8abd984`; its corrections (`be0174e`) retired the 2026-09-24 certification. |
| 2026-09-26 | This directory became this file. |

## Audits and drills

| record | when, at | outcome |
|---|---|---|
| Release audit | 2026-07, `8784565`, the withdrawn `v0.2.0` | A secret scan of all 310 commits, licences, shipped files and the version baseline: no blocker-class finding, nothing to rotate or disclose. |
| Readiness criteria | ratified 2026-07-24 | C1–C4 done (§14). C5 governed the recall measurement: C5.1's item 12 is owed, and C5.2 governs any future claim. |
| C3, claim honesty | 2026-07-26, `18bee14` | 60 claims, 56 accurate as written. Three overclaims fixed (one in code, so `audit.jsonl` stays content-free), one unverifiable observation accepted, `dualVerify.timeoutMs` raised to 1,500,000 ms, the disclosure channel exercised with a test advisory. |
| C4 drills | 2026-07-27, `afc29c4`, installed artifact | C4.1–C4.6 pass: the same-version cache trap reproduced; data files survive disable, enable and reinstall; restore, damage and key loss behave as documented. F1 and O5 fixed in `d481893`, Q1 and Q2 closed 2026-09-01, Q3 and Q4 owed (see *Status*), Q5 and Q6 accepted, O2 and O3 tracked for after `v0.1.0`. |
| C3.1 re-runs | 2026-09-09 `0bcd4d7`, 2026-09-13–17 `abbf7b4`, 2026-09-25 `8abd984` (delta) | 121 claims (1 FALSE, 1 imprecise), then 311 (5 FALSE, 50 imprecise), each corrected before the next certification. The delta audited 280: 258 accurate, 12 empirical, 9 imprecise and 1 FALSE (Δ5-13: fsync failures have four exceptions, not two), corrected in `be0174e`. |
| C3.3, defaults | 2026-09-25, `8abd984` | 28 defaults, 26 sound. Two gaps disclosed, not fixed: `metrics.jsonl` is on by default and uncapped, and an empty `HELIX_HOME` lets a project's files stand in for the global ones. |
| Dependencies | 2026-09-09 | Advisories 10 → 5: `fast-uri` overridden to 3.1.7, vitest and esbuild upgraded. The five left (`ip-address` high; `hono`, `@hono/node-server`, `qs` moderate; `body-parser` low) come with the MCP SDK's HTTP transports, and `bin/helix-mcp.mjs` holds 0 module paths from any of them. Accepted as unreachable; recount at the next SDK upgrade. |

Two defects stay open in code and are disclosed in `SECURITY.md` for `v0.1.0`: ALIAS-DOTDOT (Δ4-46,
`..` after a symlinked directory is collapsed as text) and the pre-adopt alias gap (Δ4-37).

**Recall latency (readiness §6).** The Stage-1 index trigger's latency arm fired in dogfood from
2026-08-26. The cause was a fixed first-recall cost, loading the 1.35 MB semantic-neighbour asset,
not scale. Preloading it at server start (`cdb4628`) took a cold first recall from 107.3 ms to 60.1 ms
against the 100 ms bar (2026-09-23), so Stage 1 stays unbuilt, and `helix-trigger --acknowledge`
quiets a fire that has been dispositioned.

## Certifying a candidate

A certification binds 74 verdict rows to one candidate, named by
`data/release/v0.1-candidate-receipt.json`. Its rules:

- A commit that moves `bin/` or any other receipt-pinned artifact, the claim set included, retires
  every row. No row is carried across changed bytes: fix, re-cut, and start again from the top.
- A ledger holds rows for one candidate only, and the receipt's `rowIds` catches a deleted row.
- Nothing reconstructed counts as an observation. A row without evidence is `UNEVIDENCED`, and runs
  are appended, never rewritten.
- Cheap automated blocks run first, manual ones last.

The run, after `npm run cut-candidate` (clean tree; it measures typecheck and the suite, then seals
the receipt) and a commit of the receipt:

- **Block 0**, first and last: `npm run certify-gate`. The first run exits 1 with one
  `observation is bound to` line per row and no other `FAIL` line. The last must print
  `certify-gate: the release is certified against its receipt` and exit 0.
- **Block A**, automated, with zero silent skips: `npx vitest run` exits 0 and skips only the two
  real-Codex files in `test/acceptance/`; `npx vitest run test/inventory/`; `npm run typecheck`;
  `npm run build && git status --short` (empty); `npm run inventory && git status --short` (empty);
  `npm run freeze-guard` (`anchors verified`); `node scripts/smoke-runtime-floor.mjs` (eight `ok`).
  CI's `runtime-floor` job runs the last one on Node 20 without an install; that is row `r058`.
- **Block B**, the install journey, by the deploy runbook below at both scopes and with no
  `npm install`: every `helix@helix` entry, the marketplace clone and the branch name one sha; the
  receipt's 6 bundles and 3 manifests hash identically in the checkout and in
  `~/.claude/plugins/cache/helix/helix/0.1.0`; `~/.helix` is untouched. Rows `r004`, `r007`, `r008`,
  `r030`, `r036`, `r043`, `r045`, `r048`, `r051` and `r059` come from a new session and the installed
  SessionStart hook, whose payload needs `cwd`. What `/mcp` shows is transcribed, not attested.
- **Block C**, the recovery playbook's journeys (backup and restore, a damaged line, key loss, the
  soft-erase undo through `asOf`, the project layer) and the R, U and D failure drills, each in a
  fresh process against the installed bundle with its own temporary `HELIX_HOME` and every `HELIX_*`
  variable stripped, from throwaway drivers. A command that does not run is `FAILED`. Pass: no
  `isError=true`, and the only non-zero exits are the two negative controls.
- **Block D**: `node bin/helix-rebaseline.mjs --scope global` exits 2 without a terminal; under a pty,
  `yes` answers `confirmation not given -- nothing written` and `bless` answers
  `re-baselined global at epoch 2`. Then, metered and last,
  `HELIX_REAL_CODEX=1 npx vitest run test/acceptance/` passes 40 of 40 with nothing skipped.
- **Block E**, from a Claude Code process started AFTER the reinstall, because the reinstalling
  session still serves old bytes and `/clear` does not restart its MCP server. Prove it first: a
  schema trait only the new bundle declares, and a running `helix-mcp.mjs` whose sha256 equals the
  receipt's. Call `helix_codex_status`, `helix_memory_inspect` and an owner-approved
  `helix_dual_verify` through the host. Rebind `data/inventory/verdicts.json` so that only `evidence`
  and `candidate` change and all 74 rows read `MET`. Run the tests, then Block 0.

| run | candidate | rows | retired by |
|---|---|---|---|
| 2026-08-19 | `01483ce` | A–D pass; E blocked at 56 MET, 19 UNEVIDENCED of 75 | narrowing to 74 rows, then a rebuild |
| 2026-09-02 | `2d8dde1` | 74 of 74 | rebuilds `fa03865` and `2baf9c7` |
| 2026-09-10 | `6110acb` | 74 of 74 | the `cf8aed9` rebuild |
| 2026-09-17 | `c181b3d` | 74 of 74 | item 6's rebuild |
| 2026-09-23 | `edeb57f7` | 74 of 74 | item 7's rebuild |
| 2026-09-24 | `8abd984` | 74 of 74 | the 2026-09-25 C3.1 corrections |

## Deploy runbook

How a maintainer makes installed bytes equal intended bytes (C4.8). Every rule here was learned from
a live deploy failure.

**Two failure classes.**

1. **Version-keyed cache.** The plugin cache is keyed by version string
   (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`). A same-version
   `claude plugin update` finds that directory present and skips the install, so the old bytes keep
   serving while the marketplace clone advances.
2. **Launch barrier.** New bytes serve new Claude Code processes only. A running session's MCP
   server keeps the bytes it loaded, and `/clear` does not restart it.

**Staleness is `gitCommitSha`, never `version`.** Every `helix@helix` entry in
`~/.claude/plugins/installed_plugins.json` (an array per plugin id: enumerate it, never read `[0]`),
the marketplace clone's HEAD and the commit you meant to deploy must all be equal. For a change with a
greppable marker, grep both load paths, the marketplace clone and the cache directory; they have
disagreed in practice. `gitCommitSha` records the marketplace source's HEAD, not the bytes copied, so
installing from a local checkout (`claude plugin marketplace add <path>`) with uncommitted changes
records the previous commit beside the new bytes. Commit first.

```bash
# 0. Push (or, for a local-checkout marketplace, commit) the commit you intend to serve.
claude plugin uninstall helix
claude plugin marketplace update helix
claude plugin install helix@helix

# Verify: all shas equal, the marker in both load paths. node, not jq (jq is absent on at least one
# real deploy box). Print EVERY entry, user and local scope:
node -p "require(process.env.HOME+'/.claude/plugins/installed_plugins.json').plugins['helix@helix'].map(e =>
[e.scope, e.projectPath ?? '', e.gitCommitSha].join(' ')).join('\n')"
git -C ~/.claude/plugins/marketplaces/helix rev-parse HEAD
grep -rl "<marker>" ~/.claude/plugins/marketplaces/helix ~/.claude/plugins/cache/helix
```

If a sha is stale (an install right after a push can capture pre-push bytes), repeat uninstall →
marketplace update → install.

- **Two scopes.** `claude plugin uninstall helix` acts on the user scope only. A local-scope entry,
  from an explicit `--scope local` install or registered by a CLI start inside a project, keeps the
  old sha until it is uninstalled and reinstalled from that project root with `--scope local`.
- **CLI drift.** Since CLI 2.1.232, `install` refreshes the marketplace first (skipped within 30 s of
  a refresh); keep the three-line order anyway. The CLI also installed new versions of itself three
  times within 66 s of a scheduled run's start despite `DISABLE_AUTOUPDATER=1` (a correlation; the
  mechanism is untraced), so record `readlink -f "$(type -P claude)"` and its `sha256sum` before
  and after a deploy, and repeat the sequence if they differ.
- **Manifest schema.** The manifest is validated at install time. `repository` must be a plain URL
  string: an npm-style `{ type, url }` object was refused and took the whole plugin down.
  `test/plugin/packaging.test.ts` pins the shapes.

Then honour the launch barrier: start a NEW Claude Code process and live-verify one helix tool call
from it. A headless check (`claude -p '…' --permission-mode acceptEdits --disable-slash-commands`)
must also pass `--allowedTools "mcp__plugin_helix_helix__helix_memory_inspect"`, or the call is
blocked. Sessions elsewhere keep serving old bytes until they restart; that is expected.

**Mixed windows.** Deploy a change to what the ledger accepts in the same window as the plugin,
install first, and let only new processes write. The ownership-registry hardening is the same case:
pre-hardening bytes write `~/.helix/projects.json` without a lock and rotate a project's MAC nonce on
every re-adopt, so after installing, restart every live session and avoid concurrent adopts until all
of them run the new bytes.

**Version-bumped releases (end users).** A new version installs into a fresh cache directory, so the
cache trap does not apply: `claude plugin update helix@helix`. The full `plugin@marketplace` id is
required there, while `uninstall`, `disable` and `enable` accept the bare name. Users still restart
Claude Code to get the new server.

## Recovery playbook

What to do when a lifecycle operation needs undoing (accepted limitation L2). Every recipe was
executed against the shipped bundle, and Block C of the certification re-runs them. Section signs
(§) in this part refer to its own numbered subsections.

**There is no undo command.** Helix has no `unerase`, no `restore`, no inverse of a supersede at
the tool surface or in its API. Recovery means: *retrieve the old content, then re-commit it*.
What you get back is the text — not the identity, not the grade, not the history. Read §4 before
you decide the recovery is complete.

### 1. Which operation are you undoing?

| What happened | What it did | Content still on disk? |
|---|---|---|
| `helix_memory_erase` (the tool) | **Soft erase only.** Appends a content-free tombstone; the fact leaves the live view. The tool has no `permanent` option and cannot physically destroy anything. | **Yes** — until a compaction |
| Permanent erase (operator-only: `store.erase(id, { permanent: true })` from a script/REPL, never from a conversation) | Rewrites the ledger without the record | **No** — restore from backup is the only route |
| Wrong `supersedes` on a commit | Appends the replacement; the old row leaves the live view | **Yes** — until a compaction |

If an agent erased something on your behalf, it used the tool, so it was a **soft** erase.

**The flip side: a soft erase does not destroy anything.** If you erased a fact *because it was
sensitive*, the text is still sitting in the ledger file in plaintext — that is the same property
this playbook exploits for recovery, and with stock config (auto-compaction off) nothing ever
removes it. To actually destroy it you must either enable compaction deliberately (README,
"Automatic compaction") or run the operator-only permanent path. And even then, erasure is
namespace removal, not media sanitization: copies, snapshots and backups you already took still
hold the text.

One of those copies can be Helix's own. If `dualVerify.logContent` was on when a dual-verify call
carried the fact's text, that text was written to `~/.helix/codex-log.jsonl`, and no erase reaches
it — neither the tool's soft erase nor the operator-only permanent path, both of which act on the
ledger. Deleting the file is the remedy.

A caveat worth knowing before you panic or relax: `helix_memory_erase` answers `erased <id>`
even for an id that does not exist or is already dead. A success message is not proof that
anything was erased. It can also answer with a refusal instead. When the id is present in both
scopes (global and an adopted project whose ledger does not resolve to another adopted project's
file), the tool refuses unless exactly one of them holds it as a record, and only an operator call to `store.erase(id, { scope })` from a script or REPL can then
pick the scope; that call with `scope: 'project'` refuses in turn when no project memory layer is
active, rather than falling back to the global ledger. Erasing a record is also refused, like a
commit or a confirm, while its scope has an interrupted rewrite pending (see the interrupted-rewrite
entry under *Other cheap protections* in §6).

### 2. Is the undo window still open?

The window closes only when a **compaction** physically rewrites the ledger. Check, in order:

1. **Is auto-compaction even on?** It is **off by default**. Look for a `compaction` block with
   `"auto": true` in `~/.helix/config.json` — and nowhere else: a project `.helix/config.json`
   cannot enable it. With stock config the window never closes on its own.
2. **Ask the ledger for the truncation signal.** Run `helix_memory_inspect` with `history: true`.
   If the output carries
   `(history may be truncated by a past compaction — older closed entries are not retained)`,
   a compaction has already run — treat that as "the window may have closed" and go to backups.
3. **Check the rewrite log.** `~/.helix/witness-log.jsonl` gets one line per ledger rewrite,
   e.g. `{"v":1,"scope":"@global","epoch":2,"kind":"compaction","tx":"…"}`. This file is written
   whether or not metrics are enabled, so it is the most reliable answer to "did something
   rewrite my ledger, and when?". If no line for your scope is dated after the erase, the window
   is still open.
4. **Look at the file.** The ledger is plain JSONL: `~/.helix/memory.jsonl` (global) or
   `<project-root>/.helix/memory.jsonl` (project). If you can still `grep` your text there, the
   content exists and §3 will work.

### 3. Retrieve the content

**The trap: `history` will not give you erased text back — `asOf` will.** An erase-closed row is
rendered with its content blanked; a supersede-closed row keeps its content. Verified side by
side on 2026-07-27:

```
DATA[erase:global:…T14:21:20.670Z..…T14:21:21.966Z]| m_94c548dc-…
DATA[supersede:global:…T14:21:52.511Z..…T14:21:52.639Z]| m_2547c959-… l2 supersede probe: original wording kept for history
```

- **After a soft erase** — use the point-in-time snapshot, not history. Two steps:

  1. `helix_memory_inspect` with `history: true`, and read the interval off the erased id's row:
     `DATA[erase:global:2026-07-27T14:21:20.670Z..2026-07-27T14:21:21.966Z]| m_94c548dc-…`
     The **first** timestamp is when the fact was written; the second is when it was erased.
  2. `helix_memory_inspect` with `asOf` set to that **first** timestamp, copied verbatim. The
     content comes back in full.

  Any instant in `[tx, txTo)` works; the closing timestamp does not (at that instant the erase
  is already in the snapshot and the fact is gone). The instant must be canonical to the
  millisecond with a trailing `Z` — anything else is refused. Note that the snapshot shows the
  grade **as of that instant**: if you pass the fact's own `tx`, a confirmation that happened
  later has not occurred yet, so it renders `Fresh` even for an item that was `Verified` when
  you erased it. That is the snapshot being honest about time, not a lost grade — and it makes
  no difference to recovery, since a re-commit starts at `Fresh` regardless (§4). To see the
  grade the fact actually held when you erased it (so you know whether to re-confirm in §5),
  pass an instant just *before* the closing timestamp instead.
- **After a wrong supersede** — either mode works: `history: true` shows the old row with its
  content intact, and `asOf` before the replacement's tx shows it live.
- **Either case, fastest route** — `grep` the ledger file directly. The old row is the
  `"type":"assert"` (or `"supersede"`) line whose `id` is quoted in the tombstone's
  `supersedes` field.
- **After a permanent erase** — none of the above exist. Restore from backup (§6), knowing that
  restoring an older ledger trips the rollback witness by design.

`history` and `asOf` are mutually exclusive, and `ids` — which renders only the records you name,
with their `contentDigest` proof lines — excludes both in turn; passing any two of the three is
refused.

**Which ledger was it in?** The rendered rows tell you: `DATA[erase:global:…]` versus
`DATA[erase:project:…]`. Both scopes are searched together, so run these calls from the same
project directory you were working in when the fact was written — otherwise the project layer
is not active and a project-scope fact will not appear at all. When you re-commit (§4), a
commit made from that directory lands in the project ledger by default; pass
`scope: "global"` or `scope: "project"` to be explicit. Note that `scope: "project"` is
**refused** when no project layer is active, rather than silently falling back to the global
ledger — so if you get that refusal, you are in the wrong directory, which is exactly the
condition that would otherwise have written your repair into the wrong ledger.

### 4. Re-commit — and know what you are NOT getting back

Re-commit the retrieved text with `helix_memory_commit`. For a wrong supersede, pass
`supersedes: <the wrong replacement's id>` so the chain stays coherent (superseding the wrong row
is better than erasing it — an erase leaves a content-blank history row, a supersede leaves a
readable one).

**If the row you are superseding is `Verified`, you also need `supersedesDigest`** — the digest of
the content you are replacing, which the tool requires as proof that you read the fact before
overwriting it. `helix_memory_inspect` renders it beside the row. It is a proof of read, not an
authorization: it stops an accidental blind overwrite of a human-attested fact, and nothing more.

Pass `source: "user"` if you are authoring the correction — it is also the only source that can
be re-confirmed later (§5).

Pass `scope` matching the ledger the old row lived in — the `global`/`project` tag you read in
§3. This is not cosmetic when you are superseding: a supersede whose target lives in the *other*
ledger is refused with
`commit: cannot supersede across scopes (target lives in a different ledger)`. Working inside any
project directory that has a `.helix/` folder, a commit defaults to the **project** ledger, so
repairing a *global* fact from there needs `scope: "global"` explicitly.

| Property | Comes back? |
|---|---|
| The text | Yes (the secret scanner runs again on it) |
| Item id | **No — a new `m_<uuid>`.** Anything referencing the old id now dangles |
| Trust grade | **No — the new item is `Fresh`**, whatever the old one was |
| Signed verifications | **No.** A verify is bound to the old id *and* the old content digest; it cannot be replayed onto the new item |
| Transaction time / bitemporal interval | **No.** The new row starts today; the old interval stays in history under the old id |
| Provenance source / session | Only what you pass now |
| `blastRadius`, `classification` | Only if you re-pass them |

### 5. Re-establish trust

- Was it **`Verified`**? Call `helix_memory_confirm` on the NEW id. This requires that you
  re-committed with `source: "user"` — otherwise it is refused with
  `confirm: only a source=user item is eligible (re-commit as source=user to take authorship first)`.
- Was it **`Corroborated`**? Re-run `helix_memory_recheck` with the same file check. Both the
  path and the pattern must literally appear in the new content, or the call is rejected.
- Anything else that pointed at the old id — your notes, another fact's text — needs updating by
  hand. Nothing rewrites references for you.

### 6. Prevention (cheaper than every recipe above)

**Back up both units, quiesced.** Close Claude Code sessions first (an external copy is not
covered by Helix's own file lock, so a copy taken mid-rewrite can catch an inconsistent instant),
and make sure no scheduled run is due. Then, with the project under `$HOME`:

```bash
mkdir -p ~/backups
tar -czf ~/backups/helix-$(date +%F).tar.gz -C ~ .helix dev/<project>/.helix
```

For a project **outside** `$HOME`, either take one archive per unit:

```bash
tar -czf ~/backups/helix-global-$(date +%F).tar.gz -C ~ .helix
tar -czf ~/backups/helix-app-$(date +%F).tar.gz -C /srv/code/app .helix
```

or keep one archive by anchoring the second unit at `/` (note the leading slash is dropped from
the member path, which is what keeps it distinct):

```bash
tar -czf ~/backups/helix-$(date +%F).tar.gz -C ~ .helix -C / srv/code/app/.helix
```

⚠️ **Do not** write it as `tar -czf out.tgz -C ~ .helix -C /srv/code/app .helix`. Both units then
archive under the same `.helix/` member path, and on extraction the project ledger **overwrites
your global one** — verified by hash on 2026-07-27, GNU tar 1.35. Verify any archive before trusting
it — `tar -tvzf <archive>` for a plain one, and the two-step form below for an encrypted one. File
modes, including the key's `0600`, survive both.

Back up: `~/.helix/` entirely (ledger, `ledger-mac-master.key`, `projects.json`, `witness.json`,
`witness-log.jsonl`, config, audit, metrics) **and** each project's `<root>/.helix/` (ledger +
`.owner`). Enumerate adopted projects from the keys of `~/.helix/projects.json` — every key
except the reserved `@global` entry. Copy — never `ln`: a hard-linked ledger is refused by every
write path.

**Encrypt it — the archive carries the key that makes grades unforgeable.** `~/.helix/` holds
`ledger-mac-master.key` at `0600`, and that key is what stands between someone holding a copy of the
archive and a forged `Verified` or `Corroborated` grade. A plain `tar.gz` hands it over intact, so an
unencrypted backup trades one exposure for another. Pipe `tar` into `gpg` so the plaintext archive
never reaches the disk at all:

```bash
mkdir -p ~/backups
tar -czf - -C ~ .helix dev/<project>/.helix \
  | gpg --symmetric --cipher-algo AES256 -o ~/backups/helix-$(date +%F).tar.gz.gpg
```

`gpg` prompts for the passphrase, and on a machine that has never run it the command also creates
`~/.gnupg` (observed 2026-08-24). Symmetric is deliberate: there is no private key to lose, and the
file describes its own format, so it opens years later on any machine with GnuPG. (Without a TTY, add
`--batch --pinentry-mode loopback --passphrase-file <file>` — never `--passphrase` on the command
line, which puts the secret in the process table.)

**The passphrase has to be reachable without the machine you are backing up.** If it lives only in
that machine's password store, the archive is unopenable in the exact situation it exists for. The
same holds for the archive: `~/backups` sits on the disk you are backing up, so copy the `.gpg` file
onto a separate medium — an external drive or another machine — and keep that copy detached; a second
copy on the same physical disk fails with it.

**Verify without extracting**, and confirm the key's mode survived:

```bash
gpg -d ~/backups/helix-<date>.tar.gz.gpg | tar -tvzf -   # expect -rw------- on ledger-mac-master.key
```

**To restore, decrypt to a file FIRST and check the exit status — never pipe decryption straight
into `tar -x`:**

```bash
gpg -d -o /tmp/helix-restore.tar.gz ~/backups/helix-<date>.tar.gz.gpg \
  && tar -xzf /tmp/helix-restore.tar.gz -C <destination>
```

⚠️ **Why two steps (measured 2026-08-24, GnuPG 2.4.4).** GnuPG checks the archive's integrity at
the END of the stream, so it emits plaintext first and only then discovers a modification. Against a
one-bit-flipped archive it printed `WARNING: encrypted message has been manipulated!` and exited 2,
but the entire plaintext had already reached stdout, and `gpg -d … | tar -xzf -` left
`.helix/witness.json` in the destination. **Without `set -o pipefail` that pipeline reported exit
`0`.** Only the `&&` form above protects the destination, because nothing is extracted until `gpg`
has finished and succeeded.

**What this does not undo.** It protects archives written from here on. Any plain `tar.gz` an
earlier command already wrote still carries the key in the clear — delete those, and if one ever
left the machine, treat the key as exposed and re-key rather than re-encrypt.

Cadence that fits a personal-scale install: before any upgrade or destructive operation, plus one
fixed quiet slot per week.

**Other cheap protections**

- Leave `compaction.auto` **off** unless you need it. If you turn it on, keep `graceMs`
  generous — once the size and dirtiness gates are met it is the last barrier between a soft
  erase and physical destruction, and a forward clock jump of at least `graceMs` can fire
  compaction early.
- Keep `metrics.enabled` on (the default) if compaction is on: it is what records *how much* a
  compaction reclaimed and whether it failed. (That a rewrite happened at all is recorded in
  `~/.helix/witness-log.jsonl` regardless of the metrics setting — §2.)
- Restoring an older ledger clamps that scope's elevated grades to `Fresh` on the live views,
  with a disclosure note — by design. (A point-in-time `asOf` snapshot is not clamped; it reports
  what was true then, and says so in its own note.) **While that alarm stands you also cannot
  promote anything in that scope:** `helix_memory_confirm` and a passing `helix_memory_recheck` are
  refused, because a grade minted during an alarm is indistinguishable afterwards from an honest
  one and the re-baseline below would adopt it wholesale. Ordinary commits, soft erases and
  *demotions* still work — a scope under suspicion must stay able to record that something failed.
  Establish that the current bytes are the ones you want before re-baselining; the refusal is there
  to stop the recovery from blessing whatever is in the file. The sanctioned way to adopt an old backup deliberately is the re-baseline
  ceremony: `node bin/helix-rebaseline.mjs --scope global` (or `--scope <absoluteProjectRoot>`),
  which is interactive and TTY-only — it prints the scope, byte count and hash, and waits for you
  to type `bless`. It cannot be scripted away with a flag.
- **A restored project ledger arrives unadopted.** Ownership lives in `~/.helix/projects.json`
  plus the in-repo `.owner` stamp, so a project ledger restored into a fresh clone (or at a new
  path) is treated as foreign: its rows are excluded from results and you get
  `(an unadopted project memory file is present and excluded from results; adoption requires
  explicit user approval)`. Call `helix_memory_adopt` with `projectRoot` set to that directory's
  absolute path — the tool requires it, and will not infer it from where the session happens to be
  — and expect its elevated grades to read `Fresh` afterwards (trust is machine- and scope-local).
- **What still works in a mismatch state:** reads keep serving with the disclosure note and
  clamped grades, and ordinary appends still land — so recovery by re-commit is available. What
  is refused is a *rewrite*: a permanent erase or a compaction on an alarmed scope, precisely so
  the alarm cannot be laundered away. Clear it with the re-baseline ceremony above.
- **An interrupted ledger rewrite.** A read that prints `(a ledger rewrite for this scope was
  interrupted; its records are excluded until the transition is re-driven or re-baselined)` means a
  compaction, permanent erase or re-baseline of that ledger stopped part-way, typically because its
  process was killed. The scope's records are withheld from every read, so it can look empty, but
  they are not lost; every memory write to that scope is refused with `has an interrupted transition
  pending — writes are blocked until it resolves`. Quit and restart Claude Code first (`/clear` is
  not a restart): at startup the server retracts a rewrite that stopped before its new file was
  renamed into place, provided its journal recorded the head it opened over and did not supersede an
  earlier unresolved rewrite; that leaves exactly the bytes on disk, and the records come back. If
  the note survives the restart, the server could not settle the interruption on its own — the
  ledger is on the post-rewrite lineage, the journal recorded no head to compare against, or it
  superseded an earlier unresolved rewrite — so it leaves that decision to you: run the re-baseline
  ceremony above, which adopts the bytes on disk.
  Do not edit the ledger by hand while the note stands.

Related: README — *Automatic compaction* (what closes the window, and `graceMs`), *Backup, restore &
recovery*, *Uninstall & data removal*; `SECURITY.md` — why permanent erase is off the tool surface,
the supersede guard's honest scope, and why erasure is namespace removal, not media sanitization.

## Artifacts and source records

Machine-read artifacts live in `data/`, beside the claim ledger:

| path | what it is |
|---|---|
| `data/release/v0.1-candidate-receipt.json` | the candidate identity, written and verified by `npm run cut-candidate`, read by `npm run certify-gate`. Sealed over a key-sorted payload; never hand-edit it. |
| `data/release/v2-freeze-receipt-2026-08.json` | the protocol v2 pin set, re-verified against history by `npm run freeze-guard` in CI. Never edit it. |
| `data/release/v2-freeze-receipt-2026-08-02-void.json` | the superseded first-window receipt. Void by filename only; nothing inside it says so. Never edit or delete it. |
| `data/inventory/claims.json`, `verdicts.json`, `surface.json` | the claim classification, the certified rows and the shipped surface. |

Until 2026-09-26 this directory held 25 files. The last commit with all of them is `04008c5`; read
any of them with `git show 04008c5:docs/release/<file>`. Code comments still cite some by name.

| file | what it was |
|---|---|
| `README.md` | the index and narrative this file replaces |
| `gate-decision-2026-07-22.md` | the binding gate-path decision, D1–D5 |
| `readiness-criteria-2026-07.md` | the ratified release criteria and their amendments |
| `o67-class-rule-2026-07.md` | the frozen offline rule for the O_67 class (C1.3), pinned by the v2 receipt; no measurement rests on it now |
| `pilot-protocol.md`, `pilot-amendment-1.md` | the first-edition recall pilot and its amendment |
| `pilot-manifest.json`, `pilot-manifest-amended-1.json`, `pilot-oracle-mapping.json`, `pilot-oracle-mapping-amended-1.json` | the pilot's frozen, hash-pinned inputs |
| `audit-2026-07.md` | the July release audit (its path stays allow-listed in `scripts/scan-history-secrets.ts`, which reads history) |
| `c3-audit-2026-07.md`, `c3-audit-2026-09.md` | the security-claim audits |
| `c4-drills-2026-07.md` | the install, durability and recovery drills |
| `v2-preregistration-2026-07.md`, `v2-freeze-deviations-2026-08.md`, `v2-close-report-2026-08.md`, `v2-close-checklist-2026-08.md` | protocol v2: method, deviation ledger, abort record, and the close checklist that never ran as a close |
| `v0.1-certification-runsheet.md` | the certification procedure and the log of every run |
| `deps-audit-2026-09.md` | the dependency advisory triage |
| `deploy-runbook.md`, `recovery-playbook.md` | folded into the two runbook sections above |
| the three `.json` receipts | moved to `data/release/`, bytes unchanged |

Five files removed earlier, on 2026-09-09 (`v2-close-procedure-2026-08.md`,
`v2-close-evidence-index-2026-08.md`, `v2-freeze-runtime-pins-2026-08.txt`,
`scripts/freeze-runtime-check.sh`, `deps-audit-2026-08.md`), come back with
`git log --diff-filter=D --oneline -- <path>` and then `git show <commit>^:<path>`.
