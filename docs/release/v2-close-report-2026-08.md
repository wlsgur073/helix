# Helix — preregistered recall pilot v2, final report (§9a) — ABORT RECORD (2026-08-31)

> **ABORT RECORD — read this first.** The second window did not run to its derived close. The owner
> ended it on 2026-08-31: `Abort A-2026-08-31`, T_abort `2026-08-31T10:02:21.000Z`, anchored at
> commit `ee35e41` before any consequent act, eleven days before `txClose`. **No §9a close claim is
> made by this document.** It is the pilot's ABORT RECORD, written in the close report's prepared
> form, with every close-day marker filled from the abort-run of 2026-08-31 — a full C1→C11
> execution of the pinned chain over a snapshot whose corpus ends at T_abort. The gate itself
> blocked at sample sufficiency (eligible Hit@1 exposure 1 against a pre-registered minimum of 2),
> so the primary measurement did not happen; the reference recall numbers herein are development
> evidence. The independence caveat is stated in the ledger entry rather than implied: the
> 2026-08-18 eligible-count inspection preceded the abort decision, and the record cannot prove the
> decision independent of it.

Status: **ABORT RECORD.** The window was ended by owner decision on 2026-08-31 (`Abort
A-2026-08-31`, T_abort `2026-08-31T10:02:21.000Z`, anchor `ee35e41`); the derived close
`2026-09-11T06:20:01.000Z` never arrived. Frozen identities, window bounds, disclosure duties and
the deviation history are as drafted; every measured number below is the abort-run's, filled
2026-08-31.

Governing texts: `v2-preregistration-2026-07.md` (the preregistration this report discharges),
`gate-decision-2026-07-22.md` (D1–D5, BINDING), `o67-class-rule-2026-07.md` (BINDING),
`v2-close-procedure-2026-08.md` (the tree the close chain runs from),
`v2-freeze-deviations-2026-08.md` (the deviation ledger).

**Terminology.** Throughout this report, "v2" names the second iteration of the pilot
verification protocol — the re-run that `gate-decision-2026-07-22.md` adopted as its path (b)
"protocol-v2 policy" and that `v2-preregistration-2026-07.md` preregistered. It is **not a
product version**: the product under verification carries `0.1.0` in both identity files, and the
first public release proceeds as **v0.1.0** (v0.2.0 was stood down 2026-07-22; the owner
reaffirmed v0.1.0-first on 2026-08-19).

---

## 1. The claim this report supports, and what it does not

The preregistration's §1 fixes the claim verbatim, and it is reproduced here rather than cited
because §9a requires it to travel with the result:

> **The release decision was governed by a rule frozen before the v2 window, and no method,
> product, or remediation decision was informed by the v2 holdout's contents or outcomes.**

**What v2 does NOT claim.** It does not support an inferential or general recall-performance claim.
Same author, same corpus, same process — therefore development evidence, not independent efficacy
evidence, and no sample size repairs that dependence. A realized `x / n` is weak *descriptive*
evidence about those specific cases and is reported as such; the inferential step to "Helix recall
performs well" is forbidden.

**Honest coverage statement (verbatim, §1):**

> v2 is a prospective, ledger-only temporal validation of self-derived decision queries. It is not
> a repetition or replacement of v1's two-sided pilot. v1 scored 25 ledger probes plus 26
> independently worded oracle probes with a manual semantic mapping and 4 preregistered coverage
> gaps; v2's population is structurally ledger-only, so coverage gaps cannot arise and the human
> oracle no longer independently checks what the memory failed to capture. **v2 does not validate**
> oracle segmentation, retrieval from an independent human restatement, the manual mapping, or
> resolution of the oracle-side O_67 failure.

This block is the **claim band**. §3, §7, §8 and §9 below repeat it where they report numbers,
because §9a requires the claim and the coverage statement to appear alongside every reported number
rather than once at the top of a document a reader may enter halfway. Those four are exactly the
sections that carry measured values: population and realized accrual (§3), the gate's seven
conditions (§7), the O_67 census (§8), and the release decision with its consequence (§9).

---

## 2. Frozen identities — §10, and their re-verification at the close

The freeze is the commit that carries §10's filled table.

| identity | value |
|---|---|
| freeze commit (carries §10 filled, opens the window) | `3bd63d008af19ac7c2fb513e55dbd1b4111428a9` — *freeze(pilot): re-fill §10 and put the SECOND v2 window in force*, authored 2026-08-14T06:25:41Z. The first window's freeze commit was `8ae8e35aebbfbd8bb08dc45b211cae66916cdf52` (2026-08-02T11:51:37Z); it is superseded, not deleted, and §9 carries why |
| candidate commit (protocol / classifier / tooling) | `94dd136925253be74c58df92392044c550aa6ec2` |
| runtime bytes serving recall — installed plugin `gitCommitSha`, both load paths | `94dd136925253be74c58df92392044c550aa6ec2` (declared in the freeze receipt; see §2.3 for what was and was not re-derived) |
| configuration serving recall (`~/.helix/config.json`, redacted) | `sha256 16f6d97fffb6b9934f82bcb03570af8657464d9899c22deb89c9cb61555ef9c3` |
| holdout cutoff (canonical UTC, strict `>`) | `2026-08-14T06:20:01.000Z` |
| close instant (cutoff + 28 days, canonical UTC, inclusive) | `2026-09-11T06:20:01.000Z` |
| K | **20** |
| freeze receipt payload | `sha256 360ffe80f6baf853fdc5acb4bc949a14b84838c3827cbeb56832da56bfcc7332` (`v2-freeze-receipt-2026-08.json`; the void first-window receipt is retained as `v2-freeze-receipt-2026-08-02-void.json`) |

The preregistration cannot pin its own hash. What binds it is the freeze commit id above, which any
reader can resolve to those bytes.

### 2.1 Pinned tool hashes (26 paths, `git hash-object`)

| path | pinned blob |
|---|---|
| `scripts/pilot/derive.ts` | `68065a1b12d4b38655af432873d609a07c8d2070` |
| `scripts/pilot/generate-manifest.ts` | `45ffe35803ac8f9eae938c9a4deb42182a5d5d21` |
| `scripts/pilot/snapshot.ts` | `e4cf939d2ac42bbf13d9409eee4f6d0ffb92a26c` |
| `scripts/pilot/classify-o67.ts` | `2f0f2ccbd8753fdafddcebe06e64c63757678b7c` |
| `scripts/pilot/candidate-universe.ts` | `8d78e7a420798b5d836ed40f1505359475837af3` |
| `scripts/pilot/gate-set.ts` | `54c8b767fb6da35349062d1baedc1dcde8ede6f9` |
| `scripts/pilot/prepare-gate.ts` | `38a29589ecf705fcd2d0ba8efb013d9e76f37f5f` |
| `scripts/pilot/score-gate.ts` | `bc49663e43210d8f06ff77075b5b68a6d689750e` |
| `scripts/pilot/binomial.ts` | `5bdc0c6dc6879de2caa3872869636cbfe0ff6ef3` |
| `scripts/pilot/run-pilot.ts` | `4c5383d8786a508169d8251a938ef89c15edbf73` |
| `scripts/pilot/freeze-receipt.ts` | `72c89a51b57121cd512b9851044c7440120f9c13` |
| `scripts/pilot/input-pins.ts` | `abc4f4fb90a09033dee9f709fa45b57dd1b52dbe` |
| `scripts/pilot/ordering-receipt.ts` | `72a5bd1b8b0d11317632e4821ce04ecd43a41b45` |
| `scripts/pilot/release-record.ts` | `40fbe797ccca53e6dd0d4cff78c84e034f8c874f` |
| `scripts/pilot/pin-hashes.ts` | `5a327593ad8c5b743d802b8b13dbb178158b64d5` |
| `scripts/pilot/artifact-io.ts` | `9fe42a028e349fd6c02f2cfb40e480cdffe95eb5` |
| `src/memory/retrieval.ts` | `65d877c7cceabdcd26b947211472aff0f22cdad0` |
| `src/memory/store.ts` | `89219c6b3a75bfc96c645ce03ac2a92117129dc3` |
| `src/memory/expansion.ts` | `88d472e3bdb6494684fdd161bceaf7a0ae233dbf` |
| `src/memory/ownership.ts` | `8906b3f2111df9a1fd288da620e17c5ec774cd50` |
| `src/memory/verified-read.ts` | `027333ed8a4abf12b2295fcf837d686db7a9416f` |
| `src/memory/verified-projection.ts` | `9d02572f53e13de5fdcdfd4749d3e2f319587784` |
| `src/memory/witness-store.ts` | `e52b3e0f0111ee75bec0f967b12f03e0e58ff88a` |
| `src/memory/witness-read.ts` | `c948a73cf740d1c2c580d1aaa916c70abca3af09` |
| `src/memory/witness-core.ts` | `e22468f91eb971a99616dda7c74e56e4134f4cfa` |
| `scripts/close/adjudication-skeleton.ts` | `adb31cc40073ba119c567531b65ff08c303ff67b` |

### 2.2 Pinned method documents (sha256)

| document | pinned sha256 |
|---|---|
| `docs/release/o67-class-rule-2026-07.md` | `c1fe768ca0ec2b117bc41a73e8c45546d83a2d3b7d8f344fe143114814b8a448` |
| `docs/release/gate-decision-2026-07-22.md` | `e51e29373d73f50e0a26fd6e538b3d45460550205221aaa66a2b4543d4522258` |

**At the freeze both matched their pins in the development working tree, and one of them will
diverge before this report is published.** Under the close rule a divergence here is a non-event —
the chain runs from the candidate-commit checkout, whose blobs are the pinned ones, and
`input-pins` re-derives these hashes there — but it is the single thing most likely to be misread
as tampering (`v2-close-procedure-2026-08.md` §"Conditions to expect"), so the expected state is
recorded in advance rather than explained afterwards.

- `gate-decision-2026-07-22.md` **matches its pin, and that is a change from the first window.**
  There, the freeze commit appended an update block to this file in the same commit that issued the
  receipt against the preceding candidate, so receipt and tree disagreed by construction from minute
  zero. The reset forced the ordering to be got right: a pinned method document has to be final
  BEFORE the candidate commit, because the receipt hashes the working tree and refuses any pinned
  path that diverges from `--commit`. Its 2026-08-14 update — the one recording that the first
  window is void — therefore lands inside the candidate (`94dd136`), not after it. Measured
  2026-08-14: pin and working tree both `e51e2937…`.
- `o67-class-rule-2026-07.md` was byte-identical to its pin for the whole window and diverges
  **from close day onward**: the moment the window closes, `test/output-vocabulary.test.ts` stops
  allowing that file's three private-workspace citations and requires their removal, and removing
  them changes its sha256. The close run-sheet performs that edit deliberately after the validated
  close receipt is written, so the receipt records a re-verification that was still true when it
  was taken. The candidate-commit blob remains the pinned one, and the working-tree file after the
  edit is a different, later thing.
- `sha256sum` of `docs/release/o67-class-rule-2026-07.md` still equals the pinned value — the three D2 citations are deliberately NOT yet removed: the vocabulary lock reads `txClose` from the immutable receipt and requires exactly those three citations until 2026-09-11T06:20:01Z, so removing them at the abort (2026-08-31) would redden the suite eleven days early. The removal is scheduled for the receipt's own instant; until then the pinned and working-tree bytes are identical

### 2.3 Re-verification at the close

`scripts/pilot/input-pins.ts` re-derives the tool hashes, the method-doc hashes and the
configuration hash at the close and refuses `method-drift` (exit 1) on any set-wise or value
difference in either direction, so a report that exists at all was produced under pins that matched.
That refusal is the evidence; the artifact below records it positively.

- Method pins re-verified at the close: the input-pins artifact in the close-run directory, `freezeSha256` `360ffe80f6baf853fdc5acb4bc949a14b84838c3827cbeb56832da56bfcc7332`; its ten `inputs` are transcribed in full at §5 element 1b below
- Where the chain ran from — **every measured step from the candidate checkout; one pre-chain check from the development tree**: (a) every measured step C2–C10 and C11 ran from the candidate checkout at `94dd136925253be74c58df92392044c550aa6ec2` (0.2: `Preparing worktree (detached HEAD 94dd136)`, `status --porcelain` empty; C8's preflight re-asserted the tree, the commit and cleanliness immediately before the producer), with the checkout's own `tsx`; (b) the pre-chain development-tree checks 0.4/0.5 were NOT run in this abort-run — they license the close ceremony's dev-tree exception, and the abort's anchor is the ledger's `Abort A-2026-08-31` entry at `ee35e41`

  **The first window's exception covered two steps; this one covers one, and for a different reason.** Under the first candidate, `npm run freeze-guard` and `scripts/close/adjudication-skeleton.ts` both had to run from the development tree, because neither existed at the commit the chain checks out — nor did `tsx` in that commit's lockfile, nor the `typecheck` and `freeze-guard` entries in its `package.json`. All of those absences are gone at `94dd136`: `git ls-tree -r --name-only 94dd136 -- scripts/close test/close` lists both files, `git cat-file -e 94dd136:scripts/freeze-guard.ts` succeeds, the lockfile carries `tsx`, and the scripts block is `build`, `test`, `test:watch`, `typecheck`, `freeze-guard`, `scan:history`. So the adjudication step joins the measured chain inside the checkout.

  **The freeze-guard step cannot, and no re-freeze can fix it.** The guard reads the freeze receipt, and the receipt is issued AGAINST the candidate — so it necessarily lives in a later commit and can never be present in the tree the chain checks out. The guard's entrypoint also hard-codes `join(process.cwd(), 'docs/release/v2-freeze-receipt-2026-08.json')` and ignores `argv` (`freeze-guard.ts:109-110`), so there is no path override to reach past that. This is structural, it was misdiagnosed under the first window as "the script post-dates the candidate", and stating it correctly matters: the earlier diagnosis implied a re-cut candidate would remove the exception, and a re-cut candidate is exactly what happened and did not. The exception stays safe for the reason it always was — the guard re-hashes the candidate commit's own blobs (`git ls-tree` / `git show`, `freeze-guard.ts:78-86`) and never the tree it runs in — and it is a pre-chain anchor check, not a measurement. The development tree's `src/memory/ownership.ts`, which the guard reaches through `scripts/pilot/pin-hashes.ts:22` for one path helper, differs from its pin inside this window (adjudicated `R-2026-08-19`); run-sheet step 0.5's byte-identity check does not walk `src/memory`, so that check is not what licenses this exception — the guard's re-hashing of candidate blobs is.
- Runtime identity re-verification (the half `input-pins.ts` explicitly does NOT do — *"the runtime identity is declared, not derivable from bytes"*): 2 entries, both `gitCommitSha` equal to the candidate `94dd136925253be74c58df92392044c550aa6ec2` — one `user` scope, one `local` scope at the registered project unit; the marketplace clone HEAD the same; `bin/helix-mcp.mjs` sha256 `075fc39e16bf3aea613c8d0a7538bc29b871f6f544eb314fa3d35051486b6db3` at BOTH load paths and equal to the candidate blob — observed 2026-08-31 22:47 KST at C11, before the F4 redeploy replaced the deployment; host CLI version `2.1.251`, binary sha256 `fd5f10ff0eb58daec04900466b143ea98aab50abf208a422bc008eaec13f61f7`

  This is deliberately **not** the load-path check that follows the post-close redeploy. That later check reads the same paths but answers a different question: by then both paths carry the rebuilt bundle and the installed entry names the new commit, so nothing in it can show what the *measurement* ran against. The load paths hold bytes, not history. Its result is recorded separately, in §10's "Deployment brought current" bullet.
- The close-day interpreter: `tsx v4.23.5` / `node v24.17.0`, printed by the checkout's own binary at 0.3
- The **second machine's** pins — the one deployment surface this report cannot re-derive from the measuring box: NOT OBSERVED — the abort ended the window before A1 ran; the second machine's pins were never observed and cannot be reconstructed after the fact. The v3.4 script/doc pair was staged for transfer on 2026-08-31 (SHA256SUMS verified); it remains runnable as an ordinary post-abort check, but no §4 pin report exists

**The five bullets above are not the same kind of evidence, and the difference is the point.** The
first two are **re-derived** at the close: a program re-hashes the pinned files, and a loop
re-hashes the development tree against the candidate's blobs, so both would refuse or print
`DIFFERS` if the world had moved. The third and fifth are **observations** — someone looked at a
running deployment at a moment when it still existed, and no later run can reproduce the reading.
The fourth is a **recording**: which interpreter was used is a fact about the close, not a check
that can pass or fail. The last is listed with the others precisely because it is the one duty that
can be silently dropped; giving it a named place means "never observed" has to be written down
rather than simply not appearing.

The runtime pin and the candidate-commit pin are separate on purpose: a repository commit is not
proof of what is installed, and this deployment has already produced a window where the two
disagreed. The runtime-pin observation in the third bullet is that pin's only counterparty — and it
is an observation, taken before the post-close redeploy, not a derivation from anything inside the
chain.

---

## 3. Population and window — the `cutoff < tx ≤ close` demonstration

The measured population is **ledger records only**, selected by transaction time
`2026-08-14T06:20:01.000Z < tx ≤ 2026-09-11T06:20:01.000Z`. The cutoff narrows the probe **source**
only — a record minted before it still competes for rank at scoring time. The close bounds the
**entire corpus**, every scope and both roles, because it stands in for an atomic snapshot taken at
the close instant. Oracle entries are not in the population; they carry no `tx`, so no window can
date them.

The claim band of §1 applies to every number in this section:

> **The release decision was governed by a rule frozen before the v2 window, and no method,
> product, or remediation decision was informed by the v2 holdout's contents or outcomes.**
>
> v2 is a prospective, ledger-only temporal validation of self-derived decision queries. It is not
> a repetition or replacement of v1's two-sided pilot. v1 scored 25 ledger probes plus 26
> independently worded oracle probes with a manual semantic mapping and 4 preregistered coverage
> gaps; v2's population is structurally ledger-only, so coverage gaps cannot arise and the human
> oracle no longer independently checks what the memory failed to capture. **v2 does not validate**
> oracle segmentation, retrieval from an independent human restatement, the manual mapping, or
> resolution of the oracle-side O_67 failure.

- As-of-close snapshot: the operator's offline close-run snapshot directory (location named to the owner, not published); composed sha256 `4a5908c360045bf5d0dc2350d0afbb4b85cb0c3f08d5ec708971cd2c0862f13c` — by construction the sha256 of the retained 8-line `snapshot-hashes.txt`, whose path column is bytewise-ordered (`cut -c67-` piped into `LC_ALL=C sort -c`, exit 0); `ledger:global` `1bf52353f9fa7de5612078104170a2dd0b872d91218cf8306960efa1e0afb5d9`; `ledger:project` `c264ba34356c066fb7710832b566df82d9982293f121a53537b9d9d69f4b024d`
- The other eight pinned inputs of the snapshot's trust and expansion surface: `manifest` `19cfcadf215f0a3733c67195cc0d73fd248bdb3e49476ce2a061f7d299a74793`; `classifier` `035d027bcfedea46435851bbf4f2f3f6d16d84743926ed693f32f87e0c1546ec`; `universe` `7eb8ffa76e1799d2d0ac134591372b5e499c62b859878f4b720cfee38c3cc0f4`; `ownership:registry` `34e196f38fe2665c551f93f5a383c1c42344f839f36777579cd5c7d09260baa9`; `ownership:owner` `9a7c6132f04ababf3478a288d1f7707fa7ee18928f6e10498953357da6b7e326`; `trust:master-key` `f2a6b212c7f8b9e193e79a0bd14c8d47a6fec968a909fae4e47e3a701df231ea`; `trust:witness` `214389ff9a5031ff1a0cf5eb849853dc650bb5998c605eba64d30a3b1fc28211`; `expansion:semantic-neighbors` `c3cdbf645e260742cc1fc16c6563266975a946963173b0873e71e9b913a33f30`
- Upper-bound demonstration (`tx ≤ close`): prepare-gate accepted every snapshot row — no `snapshot-after-close` refusal, exit 0; rows checked: 59 (global 1, project 58). The corpus ends at T_abort (2026-08-31T10:02:21.000Z), eleven days before the pinned close — the abort record's defining gap: the declared window was never fully populated
- Lower-bound demonstration (`cutoff < tx`): 13 post-cutoff records, all project-scope, `tx` from `2026-08-16T01:51:36.631Z` to `2026-08-31T05:26:11.504Z` (one per dogfood day: 08-16, 08-18, 08-19, 08-20, 08-22, 08-23, 08-24, 08-25, 08-26, 08-27, 08-28, 08-30, 08-31)
- Realized accrual: 13 distinct `(project, record-id)` identities; 1 eligible probe row (the single `unambiguous` probe) — below the pre-registered minimum of 2, which is the gate's blocking reason

**Sample unit.** Exposure and minimum count distinct post-cutoff target identities; the metric
denominator is the eligible probe rows corresponding to those identities; the success rule is that
every one of those rows ranks 1. Under a ledger-only holdout the generator emits exactly one probe
per source record, so all three coincide, and preparation fails closed on a duplicate identity.

**The close is a close rule, not a stopping rule.** Scoring happened at the preregistered close
instant regardless of how many cases accrued. The minimum of 2 is a starvation floor, evaluated
once at the end.

---

## 4. Reset and deviation history

**There was one measurement-window reset.** It ended the first window on 2026-08-13 and is §4.0.
Everything in §§4.1–4.5 happened inside that first window and is retained here rather than
discarded: a reset does not unhappen the events that preceded it, and a report that showed only
the surviving window would be reporting a cleaner history than the one that occurred. Each is
marked with the window it belongs to.

Of those first-window items, two were **deviations** — both control/provenance deviations with
continuous runtime bytes — and two were **disclosures**. One of the disclosures does not carry
forward: §4.4 concerned pinned source files modified in-window, and the re-freeze re-pinned those
files at their current bytes, so the condition it disclosed cannot exist in the second window. The
other, §4.6, is the one that became the reset. Every disposition was **decided by the owner, not by
this report**. Each is summarized here in the substance that binds the report; the full evidence,
including the reflog extracts and the file-history verdicts, is
`v2-freeze-deviations-2026-08.md` in this directory.

Second-window entries are §4.7 and §4.8, and the ledger now carries THREE classes of entry —
`Deviation`, `Ruling` and `Disclosure`. All three are §9a content. Do not list only the ones headed
`Deviation`: §4.7's marker asks for *every* entry appended after 2026-08-14, and not all of them are
deviations.

### 4.0 The first window's reset — D-2026-08-13-in-window-tooling

**What happened.** `scripts/close/adjudication-skeleton.ts` was written on 2026-08-13, inside the
first window, to produce a close-day input the chain had no producer for. §8's Reset paragraph
says building any of the method's tooling after the freeze **does** reset the window, because
implementing an unspecified detail resolves a method choice. Three readings were put to the owner
with their measured costs, and the owner ruled the strictest: **the act of building triggers the
reset, whether or not the program is ever run.** A first ruling taken earlier the same day went the
other way and was withdrawn — it had been put to the owner as a paraphrase of the rule that dropped
the word *does*. That withdrawal is recorded in the ledger rather than smoothed away, because a
pilot whose claim is process integrity cannot keep the one place its own rule was nearly read too
lightly out of its own record.

**What the reset cost.** The close instant moved from `2026-08-30T11:35:05.000Z` to
`2026-09-11T06:20:01.000Z`. The ten probe rows accrued under the old cutoff (one per day, 08-03
through 08-13) fall below the new one and leave the probe population permanently while remaining
live competitors — which can only make the surviving probes harder, never easier. The
sample-sufficiency clock restarted at zero against a measured accrual of about 0.87 rows per day.

**What it did not cost.** No defect in the frozen method was asserted and nothing had to be fixed
first. §§1–9, D1–D5, the O_67 class rule, the claim template, K and the 28-day length are
unchanged; two instants and a set of identities moved. Mechanically a reset is indistinguishable
from a re-freeze — `txClose` is derived from a cutoff that is verified against the candidate
commit's authored time, so it cannot be edited into an existing receipt — and the executed sequence
is recorded step by step in the ledger.

**Three things the reset paid for.** They are named because a reset reads as pure loss and this one
was not. (1) The §4.4 disclosure dissolved. (2) The `bin/` rebuild moved from close day to before
the window, so the window's 28 days became real-use verification of bundles that would otherwise
have been activated unverified on a one-shot day — and the packaging-freshness test, red BY DESIGN
for the whole first window, went green, which also un-blocked a CI job that had been dying before
it reached `npm run typecheck`. (3) The candidate now contains the close-day helpers, so §2.3's
clean-checkout exception shrinks from two steps to one — and re-examining it turned up that the
surviving one had been diagnosed wrongly. It is not there because a script post-dates the
candidate; it is there because the receipt is issued against the candidate and cannot be inside it.
A re-cut candidate was the implied remedy under the old diagnosis, and a re-cut candidate is
precisely what just failed to remove it.

### 4.1 D-2026-08-09-autoupdate *(first window)*

**What happened.** The marketplace `autoUpdate` control regressed during the window and the helix
marketplace clone — a pinned runtime load path — fast-forwarded in-window: 08-03 → `324dbbb`,
08-06 → `e66384c`, 08-07 12:39:56Z → `dc64f6e`. Detected 2026-08-09 during a docs-wide status
audit; no document recorded it before the ledger.

**Byte continuity.** The `bin/`, `.claude-plugin/`, `hooks/` and `data/` git trees are identical
across `27b4373`, `324dbbb`, `e66384c` and `dc64f6e`, and both load-path bundles byte-matched the
candidate throughout. **Wording bound, carried from the ledger:** this is a *control/provenance
deviation with continuous runtime bytes*; the clone-HEAD identity pin FAILED for most of the
window, and this report therefore does not — and must never — say "all runtime identity pins held".

**Root cause (probable, not proven).** The post-startup randomized plugin update check, running
with `autoUpdate: true`, pulled the marketplace after session starts. Settings file history shows
the guard flag was persisted `false` on 08-06 00:08 KST and reverted to `true` 23 seconds after the
18:18:46 `e66384c` pull — the reversion coincides with the update cycle itself.

**Remediation, all verified 2026-08-09.** Both `autoUpdate` flags set explicitly false;
`DISABLE_AUTOUPDATER=1` exported in `~/.bashrc` and in the systemd drop-in
`freeze-guard.conf` (with `UnsetEnvironment=FORCE_AUTOUPDATE_PLUGINS`, which has override
polarity); clone `reset --hard` to `27b4373` on `feat/helix-v1` with evidence preserved first and
3-sha agreement re-verified after; and a recurrence watch, `scripts/freeze-runtime-check.sh`, wired
at interactive shell start and as a hard `ExecStartPre=` on the dogfood unit.

**No-reset determination.** A reset is not required: runtime bytes were continuous for the whole
window, so the system under measurement never changed. Owner-approved 2026-08-09. The alternative
reading — commit identity itself as measured system identity, which would reset from 08-03 — was
considered and not adopted.

### 4.2 D-2026-08-10-autoupdate-recurrence *(first window)*

**What happened.** One day after the remediation, the clone fast-forwarded again:
`2026-08-10 12:02:02Z`, HEAD `27b4373 → 2fdc1ca`. Detected the same evening by
`freeze-runtime-check.sh` on its first post-drift invocation — under 24 hours from wiring to first
catch.

**Both preventive controls are falsified.** At pull time both `autoUpdate` flags were `false` and
the process that triggered the refresh carried `DISABLE_AUTOUPDATER=1` in its environment, verified
via `/proc`. For this CLI version the startup marketplace-clone refresh runs regardless of both.
Prevention is not achievable with documented configuration; **detection plus reset was the
operating mode for the rest of the window**, and this report states that rather than implying the
controls worked.

**Byte continuity.** Unbroken: `2fdc1ca` touches `docs/release/` and `scripts/` only, and the
guard's pin-list checks passed against both load paths throughout.

**Recurrence handling — guard auto-heal, owner-decided 2026-08-10.** `freeze-runtime-check.sh`
mechanizes the twice-approved remediation under a strict condition: the sole violation is
clone-HEAD drift and every byte, pin, flag and receipt check passed. It then resets the clone to
the candidate, appends to `~/.cache/freeze-guard-heals.log`, prints a one-line stderr notice and
exits healthy. Any other violation combination still hard-fails, so the dogfood `ExecStartPre`
blocks only on real incidents.

### 4.3 Auto-heals during the window *(first window)*

Counted from `~/.cache/freeze-guard-heals.log`, as the ledger requires. **Three heals as of
2026-08-13**, each a clone-HEAD drift reset back to the candidate with every other check green:

| UTC | clone HEAD found | reset to |
|---|---|---|
| 2026-08-11T15:08:16Z | `b4997cd9175d1e508610368e1ff914319da572a2` | `27b4373d64d13c7b258aab011570be2d973c34da` |
| 2026-08-12T14:41:24Z | `0bbb000ac37fbf9a98cf143df88ec118861bca86` | `27b4373d64d13c7b258aab011570be2d973c34da` |
| 2026-08-13T04:08:31Z | `0bbb000ac37fbf9a98cf143df88ec118861bca86` | `27b4373d64d13c7b258aab011570be2d973c34da` |

- Final heal count and the complete log: 13 lines total. The ten from 2026-08-14 onward, verbatim: `2026-08-16T01:43:44Z healed 3bd63d008af19ac7c2fb513e55dbd1b4111428a9 -> 94dd136925253be74c58df92392044c550aa6ec2`; `2026-08-17T06:55:31Z healed 0d2e55f91e3f5f248827d876f060fdeef8323e85 -> 94dd136925253be74c58df92392044c550aa6ec2`; `2026-08-18T10:59:42Z healed 5c6e1c7e7e6c01a623845034343f636f389711ae -> 94dd136925253be74c58df92392044c550aa6ec2`; `2026-08-20T12:36:06Z healed 92d5d0a0acdf5ee107d687f01746e6ce3825e8e7 -> 94dd136925253be74c58df92392044c550aa6ec2`; `2026-08-21T12:51:35Z healed d93cb192b182941f20d3c04aa61a51af53924873 -> 94dd136925253be74c58df92392044c550aa6ec2`; `2026-08-22T06:33:35Z healed d93cb192b182941f20d3c04aa61a51af53924873 -> 94dd136925253be74c58df92392044c550aa6ec2`; `2026-08-23T11:42:33Z healed 745403357e52d5aa7f1644fe59fe8c62c8a5686f -> 94dd136925253be74c58df92392044c550aa6ec2`; `2026-08-24T13:52:22Z healed cc6ef4ace02100f6027345e0b5b48148650b84f2 -> 94dd136925253be74c58df92392044c550aa6ec2`; `2026-08-27T01:59:19Z healed eddf313ff0ecc39becd927a0c98315e8f8d36b29 -> 94dd136925253be74c58df92392044c550aa6ec2`; `2026-08-30T10:59:24Z healed eddf313ff0ecc39becd927a0c98315e8f8d36b29 -> 94dd136925253be74c58df92392044c550aa6ec2`

Each heal is the same class of event as §4.1 and §4.2 — clone-HEAD identity drift with continuous
runtime bytes — and each is disclosed for the same reason: the identity pin did not hold
continuously, even though the bytes did.

### 4.4 Pinned source files modified in-window — DISCLOSURE, now DISSOLVED *(first window)*

**Read the dissolution first, because it changes what this section is.** The condition below is a
first-window condition and cannot arise in the second: the reset re-cut the candidate, and the
re-issued receipt pins these six files at the bytes they now have. Measured at the freeze — the
`src/memory` rows of §2.1 differ from the first window's for exactly `retrieval.ts`, `store.ts`,
`ownership.ts`, `verified-projection.ts`, `witness-store.ts` and `witness-core.ts`, which is the
same six. There is no in-window pinned-edit history left to disclose, so what follows is retained
as the first window's record and as the reasoning that would apply if the condition recurred, not
as a live disclosure. It is not deleted, because "this was disclosed and then the disclosure went
away" is itself a fact a reader is entitled to check rather than infer from silence.

Six of the nine pinned `src/memory` modules were modified on the development branch during the
first window: `ownership.ts`, `retrieval.ts`, `store.ts`, `verified-projection.ts`,
`witness-core.ts`, `witness-store.ts`. `v2-close-procedure-2026-08.md` states the preference that all nine be left
untouched on the mainline branch precisely so that the close would not depend on the
candidate-checkout procedure being remembered correctly; that preference was not held.

**Disposition: DISCLOSURE, owner-decided.** The modifications are repository work that never
reached the deployment machine, and the close chain runs from the candidate-commit checkout, so the
measured surface is unaffected and no reset arises. Revert was considered and **rejected**, because
reverting would reopen two verified defect fixes that live in these files: witness laundering
(`witness-core.ts`) and the rename-witness metric (`store.ts`).

**What the committed bundles actually did — a correction.** An earlier draft of this section
grounded that disposition on the claim that *no in-window commit rebuilt `bin/`*. That claim is
false and is withdrawn here rather than carried into the published report. One in-window commit did
rebuild the bundles: `d701735`, *build: rebuild the committed bundles so this branch verifies what
it ships*, 2026-08-06T05:46:34Z, changing four files under `bin/` (167 insertions, 56 deletions
against the candidate). Those bytes reached the mainline through merge `02c7c9d`
(2026-08-10T05:29:35Z) and stood there for about 26 hours, until `b4997cd`, *freeze(pilot): return
`bin/` to the candidate bytes*, 2026-08-11T07:30:00Z, restored them.

The facts the disposition actually rests on are narrower, and each is checkable by a reader with
the repository:

- `bin/` at the branch tip is byte-identical to the candidate — `git diff --quiet 94dd136 HEAD -- bin/`
  succeeds. The interval that was not identical is exactly **15 first-parent commits**, `02c7c9d`
  through `2c2d1d2`, all carrying the single `bin/` tree `abd4f14f`; the candidate and the tip carry
  `8ed67526`.
- **No clone HEAD the runtime ever reached carried non-candidate bundles.** Every head recorded in
  this report — the three in-window auto-pull targets `324dbbb`, `e66384c` and `dc64f6e` (§4.1), the
  recurrence target `2fdc1ca` (§4.2), and the three auto-heal heads `b4997cd` and `0bbb000` twice
  (§4.3) — has `bin/` tree `8ed67526`, identical to the candidate's. The rebuilt bytes existed only
  on the development mainline, which is not a runtime load path.
- The standing counterparty is the guard's byte check, not the discipline: `freeze-runtime-check.sh`
  compares the runtime surface bytes under **both** load paths against the pin list and hard-fails
  on any mismatch. It never did, throughout the interval above.

The deviation ledger stated the same idea as a standing discipline — *"no in-window commit rebuilds
`bin/`"* — in its `D-2026-08-10` remediation paragraph. That wording was falsified by `d701735` in
exactly the same way, and **it has been corrected there** (2026-08-13), since this report cites the
ledger for the evidence rather than restating it. The ledger now carries the same two narrower
supports as the bullets above; if the two ever disagree, they are describing one set of commits and
one of them is wrong.

**No disclosure entry was ever written, and none is owed** — the obligation dissolved with the
condition. The ledger records the dissolution rather than a disclosure, in
`D-2026-08-13-in-window-tooling`, under "Two things the reset paid for rather than cost":

> The pinned-source disclosure question the first window carried — six `src/memory` files whose
> bytes had moved past the candidate they were pinned against — does not exist in the second
> window, because the new candidate contains them and the re-freeze re-pins them where they are.

*(Corrected 2026-08-17. This bullet was a close-time fill marker demanding "the ledger entry id for
the pinned-src disclosure … **owed, not yet written**", inside a section whose own heading says the
condition was DISSOLVED and one line below a sentence claiming in the present tense that the entry
exists. It was the only marker in this report whose artifact had to be created BEFORE publication
rather than produced by the close chain itself — the surviving markers all await something the
close day generates (a run artifact, a receipt, a release record) or observes, and are fillable by
transcription on the day; this one awaited a decision and a ledger write that were never going to
happen. So H1 — which refuses publication while any marker survives — was blocked by a demand that
could not honestly be met. Filling it with `D-2026-08-13`'s id was considered and
rejected: that entry records the question's elimination, not a disclosure, and citing it as one
would misrepresent it. Writing a fresh first-window entry now was rejected for two reasons — it
would be false history, and being dated after 2026-08-14 it would be swept into §4.7's marker for
second-window ledger appends.)*

### 4.5 Deployment status of in-window source work *(first window; superseded by the pre-window rebuild)*

Throughout the first window the deployed runtime was the first candidate and `bin/` was
byte-identical to it, so every source fix made during that window was **fixed in source and open in
deployment** — a backlog that had reached 62 source commits, all of which the original plan
activated in a single post-close rebuild.

**That is no longer the state, and the change is the reset's largest practical dividend.** The
rebuild was pulled forward and executed BEFORE the second window opened: `bin/` was rebuilt at
`d581e7e`, gated on the full suite rather than on the packaging test alone (2215 pass; the
packaging-freshness test, red BY DESIGN for the whole first window, went green), and the runtime
redeployed to the candidate. So the second window's 28 days are real-use verification of exactly
the bytes the report will describe, instead of a one-shot activation on close day of bytes nothing
had yet exercised. The largest behavioural change carried in is the dual_verify agreement map's
negation handling. It was justified by a differential measurement over 19,377 generated pairs, in
which contradictions silently rendering as agreement fell from 9,445 under the previously deployed
bytes — which had no negation handling at all — to 638.

**Those three figures are reported here as HISTORICAL AND UNREPRODUCIBLE, and the qualifier is the
point of the sentence.** The generator, its seed and its labels were never committed: a repo-wide
sweep including gitignored paths finds `19,377` and `9,445` in this sentence and nowhere else, and
the intermediate `3,889` nowhere at all. So no reader — including a later reader of this project —
can re-derive them, check the labelling rule, or tell a real regression from a change in how pairs
were generated. They are recorded because deleting a measurement that actually drove a design
decision would be worse than reporting it with its provenance gap stated; they are not evidence
anyone can act on, and nothing in this report's gate or verdict rests on them.

Two things were done about it rather than promised. Four adversarial cases were pinned in
`test/verify/agreement-map.test.ts` on 2026-08-16 — unlisted negators, multi-claim absorption, a
role swap at identical token sets, and a bare figure substitution — each asserting the *current
wrong* answer, so the limit class is now measured in the suite instead of only asserted in a
comment. And the module's limits header was corrected: it had named "true antonym pairs" as the
boundary when the real class is any contradiction not carried by negation morphology.

**What was deliberately NOT done: re-measuring the corpus now and restating this section around the
new number.** A newly built in-window metric that a §9a-mandatory section is rewritten around lands
on the Reset clause's first limb — *"Any intervening system, config, rule, or **metric** change
resets the window"* — whereas correcting prose about a subsystem the pilot does not measure is
covered by the same clause's carve-out for amending a document that changes no measured rule. The
distinction is narrow and it is the whole reason this section states a gap instead of closing it.
Rebuilding the corpus is post-close work.

What remains close-day follow-up (§10) is only the redeploy of whatever source work accrues inside
the SECOND window.

### 4.6 A close-day program written in-window — the §8 disposition that became the RESET *(first window)*

**What exists.** `scripts/close/adjudication-skeleton.ts`, with `test/close/adjudication-skeleton.test.ts`,
was written **2026-08-13**, inside the window. It stamps the mechanical half of §5 element 6 — the
adjudication artifact — and leaves the human half blank. It is disclosed here because §8 of the
preregistration makes tooling built after the freeze a **reset**, and the reader is entitled to see
that rule applied to this file rather than to discover the file in the run-sheet.

**Where it lives — and the argument that it lived outside the pinned set, which the ruling
destroyed.** It sits outside `scripts/pilot/`, and at the time it was written that was offered as
load-bearing: the freeze pinned sixteen pilot tools as a fixed list rather than a directory glob,
so a file placed elsewhere created neither value nor set-wise drift in `input-pins`, and the close
report could say the pinned surface was untouched without qualification. **That argument answered
the wrong question.** §8 turns on the ACT of building the method's tooling, not on which directory
receives it, so a location cannot buy an exemption the rule never granted — which is exactly what
the ruling found. At the second freeze the path was therefore added to `PINNED_TOOL_PATHS` as its
twenty-sixth entry (§2.1), so the one edit class that has already cost a window is now caught by
the mechanical divergence check instead of by anyone remembering the rule. Its only value import
from a pinned module is `artifact-io.js`, used read-only; the two other imports are type-only and
are erased before execution. Its TEST is deliberately not pinned — the list pins no test file for
any of the sixteen pilot tools either, and a test neither decides a rank nor issues evidence.

**Which tree it runs from — the checkout, as of the second window.** Under the first candidate this
program was one of two steps that necessarily ran from the development tree, because `scripts/close/`
did not exist at the commit the chain checks out; copying it in was rejected as trading one
disclosure for a worse one, since an untracked file there breaks the `git status --porcelain` =
empty evidence §2.3 cites. The reset removed the problem rather than the disclosure: at `94dd136`
the file, its test, `tsx` in the lockfile and the `typecheck` / `freeze-guard` script entries all
exist, so this step now runs inside the checkout with the rest of the measured chain. It reads
nothing from the tree it runs in beyond its own imports — its inputs are the two artifact paths
handed to it on the command line. The other of the two, the pre-chain `freeze-guard` check, still
runs from the development tree, and §2.3 records why that one is structural rather than incidental:
the receipt it reads is issued against the candidate and so can never exist inside it.

**The §8 rule, quoted.** *"Building any of the method's tooling after the freeze **does** reset it,
because implementing an unspecified detail resolves a method choice."* The operative words are
*resolves a method choice*. §9b applied that rule to the three producers it named as missing
(freeze receipt, ordering receipt, release record) precisely because each of those **decides
content**: what is pinned, what counts as ordering evidence, what binds the release decision.

**Disposition: RESET — ruled by the owner 2026-08-13.** The recommendation this section was drafted
to carry was DISCLOSURE, and the owner did not take it. What follows is that recommendation and its
grounds, kept verbatim in substance rather than rewritten to agree with the outcome, because the
grounds are what the ruling was made against and a report that showed only the winning argument
would be hiding the shape of the decision. Read them as the case that was put, not as the
disposition. The ruling itself, the reading it turned on, and the withdrawn first ruling are under
"Owner ruling" below.

1. **It resolves no unspecified detail, because the pinned scorer already specifies all of them.**
   Every mechanical property the program supplies is one `score-gate.ts` independently re-derives
   and refuses on mismatch: the two hash bindings (`adjudication-unbound`, `score-gate.ts:426`),
   non-duplication (`adjudication-duplicate`, `:431`), one judgment per frozen probe
   (`adjudication-incomplete`, `:434`), and a stale judgment set required only when closer
   relationships exist (`:473-480`). The choice was made at the freeze, in a pinned file. This
   program restates it earlier.
2. **It decides no verdict and computes no score.** Every contradiction and stale verdict it emits
   is the literal sentinel `UNJUDGED`, which is deliberately not one of the two values the gate
   accepts, so an unfilled skeleton handed to the gate **over a non-empty frozen denominator** is
   **refused** `adjudication-uncertain` (`score-gate.ts:437-440`). A template pre-filled with `none`
   would be a release-blocking condition pre-answered in the release's favour by the tool that
   generated it; this one fails closed instead. The qualifier is load-bearing and the boundary it
   marks is stated below rather than left for a reader to find.
3. **The decisive test: it cannot move the gate.** It cannot cause the gate to accept an
   adjudication the gate would otherwise refuse, nor refuse one it would otherwise accept. A
   hand-authored adjudication and a filled skeleton reach identical treatment. The producer is
   therefore operator convenience over an already-frozen shape, not a method component — which is
   also why the fallback is cheap: **the chain remains executable without it**, by hand-authoring
   the file as the preregistration always assumed, and an operator unconvinced by this disposition
   should take that route.
4. **It is outcome-blind by construction and by timing.** Nothing about it was written on the basis
   of a rank — no rank existed on 2026-08-13, and §8's inspection ban runs *until the close
   instant*, while this program first executes at the close, after the three runs exist.

**What a skeptical reader should check, stated because it is the honest residue.**

- The one genuine degree of freedom the program has is the **emission order** of its
  `contradictions` and `staleViolations` entries, and `adjudicationSha256` is order-sensitive by
  design (`score-gate.ts:494-497` — the hash is taken over the parsed object, which preserves key
  order). The order chosen is the frozen gate set's own denominator order, so
  it is derived from pinned input rather than invented — and it changes the value of a provenance
  hash, never a verdict, a denominator, a threshold or a pass/fail. Two orders score identically.
- The program pre-fills each entry's `returnedId` with the **rank-1** returned id, while the §5a
  rubric spans every returned record in the top-K. That field is judging aid, not gate input — the
  scorer does not validate it — but a judge who treats it as the whole evidence surface can miss a
  contradicting record at rank 2–20. The run-sheet's human pass, not this disposition, is what
  closes that; it is named here so the reader does not have to find it.
- The claim that an unfilled skeleton fails closed has **two** boundaries, and both are real.
  *First, it is not symmetric:* it holds through the contradictions check, which refuses the whole
  file before the stale section is read. Fill the contradictions and leave the stale set unjudged
  and that protection is gone — the scorer counts `violation` and ignores every other string, so an
  unjudged stale entry reads there as "no violation".
  *Second, it does not hold at zero probes.* `adjudication-uncertain` is raised by a loop over the
  contradiction calls (`score-gate.ts:437`), so a gate set whose frozen denominator is empty yields
  an empty skeleton, the loop iterates nothing, and the gate **accepts** the unfilled file. The
  release verdict is still correct in that state, but for a different reason than any judgment: zero
  probes puts `eligible.exposure` below the Hit@1 minimum, and Hit@1 is blocking, so the block comes
  from an exposure floor. The program does not refuse this case — refusing would dead-end the chain
  on a one-shot day in a state the method calls a result rather than a failure (an empty manifest),
  while leaving `score-gate` still demanding an adjudication to hand-author under time pressure — so
  it emits the file and prints a `NO JUDGMENTS` block naming the boundary in as many words. Both
  boundaries are asserted against the real scorer in the producer's test file, not restated as
  belief.

**Owner ruling — MADE 2026-08-13: the window RESETS.** This report did not decide the window's fate
by its own authorship. The disposition set out above was a **recommendation**, offered against a
sentence that reads the other way, and the sentence won. The governing text is quoted here rather
than summarised, because a summary of it is what produced a first ruling that had to be withdrawn:

> Any intervening **system, config, rule, or metric** change resets the window, which restarts
> from the change. … Building any of the method's tooling *after* the freeze **does** reset it,
> because implementing an unspecified detail resolves a method choice.
> — `v2-preregistration-2026-07.md`, the Reset paragraph

Two readings were open, and the difference was not rhetorical. Read the main clause as
unconditional, and this program is the method's tooling built after the freeze, so the window
resets and the recommendation below would have been a **departure from the preregistration's own
text**. Read the trailing clause as limiting — the rule resets because an unspecified detail was
resolved — and no such detail was resolved here, so the sentence does not reach this program and
the recommendation would have been an **application** of the rule. **The owner ruled the first
reading: the main clause is unconditional, and building alone triggers the reset whether or not the
program is ever run.** Under that reading the placement argument, the cannot-move-the-gate argument
and the chain-runs-without-it argument are all true and all beside the point — they answer whether
the program is harmful, and the rule does not ask that.

A first ruling was taken on 2026-08-13 on a paraphrase of the rule that omitted the word
**does**, and was withdrawn once the sentence itself was read. That withdrawal is recorded here
rather than quietly overwritten, because a pilot whose claim is process integrity cannot hide the
one place where its own rule was nearly read too lightly.

The grounds offered for the recommendation, stated as grounds rather than as a settled conclusion:

1. **It decides no verdict and computes no score** — every judgment it writes is the sentinel
   `UNJUDGED`, which the pinned scorer refuses as `adjudication-uncertain` until a human replaces
   it (point 2 above, with its zero-probe boundary in the residue).
2. **It resolves no unspecified detail** — completeness, non-duplication and the two hash bindings
   are properties `score-gate.ts` already specifies and independently re-derives; the producer
   satisfies them rather than choosing them (point 1 above).
3. **It cannot move the gate in either direction** — it can neither cause an adjudication to be
   accepted that would otherwise be refused, nor the reverse (point 3 above, the decisive test).
4. ~~**It lives outside the pinned tool set**~~ — **this point was true when the case was put and
   is false now, and it is retained struck through rather than deleted because it is one of the
   arguments the ruling rejected.** At the first freeze the pin list named sixteen pilot tools as a
   fixed list rather than a directory glob, so a file placed elsewhere created neither value nor
   set-wise drift in `input-pins`. The second freeze added
   `scripts/close/adjudication-skeleton.ts` to `PINNED_TOOL_PATHS` as its twenty-sixth entry, so
   the program is now inside the pinned set and its drift IS caught mechanically. See "Where it
   lives" above, which records why the location argument answered the wrong question in the first
   place.
5. **The chain runs without it** — the same file can be hand-authored, as the preregistration
   always assumed, which makes it a labour-saving helper rather than a method component.

**The ruling did not retire the residue.** The three items under "What a skeptical reader should
check" above — `adjudicationSha256`'s order-sensitivity, the rank-1 `returnedId` against a top-K
rubric, and the asymmetric/zero-probe boundaries of the fail-closed claim — survive the ruling
unchanged. A disposition decides whether the window resets; it does not make a program's degrees of
freedom disappear. They now apply to a program that is committed, pinned, and part of the second
window's frozen method, which raises rather than lowers what a reader should check.

**The third course was not taken, and is now closed.** Hand-authoring the adjudication from the
frozen probe list — the route the preregistration assumed all along — would have meant no
post-freeze tooling ever entered the method. It was measured rather than argued: at ten real probe
ids the file is 1,134 bytes, about 2.9 KB at the ~26 probes expected at close, and all five
hand-authoring mistake classes are refused by the pinned scorer rather than silently accepted. The
owner's ruling made the route moot in one direction — the building had already happened, so the
window reset regardless of what the program is used for — and the re-freeze closed it in the other:
the producer is committed at `94dd136` and pinned, so it is now part of the frozen method rather
than an optional helper alongside it.

**Ruling — MADE.** RESET, ruled by the owner 2026-08-13 against the quoted text, on the reading that
the Reset paragraph's main clause is unconditional. Recorded as `D-2026-08-13-in-window-tooling` in
`v2-freeze-deviations-2026-08.md`, together with the withdrawn first ruling, the three readings put
with their measured costs, and the step-by-step remediation executed on 2026-08-14. The first
window ended and was not published; this report is the second window's, and §4.0 carries the reset
as the head of the deviation history rather than as a footnote to it.

**The question does not recur for THE PRODUCER in this window — but a second §8 ruling WAS owed,
and this sentence used to deny it.** §8 reaches tooling built after the freeze it governs. This
window's freeze is `3bd63d0` and its candidate `94dd136` already contains both the producer and its
test — `git ls-tree -r --name-only 94dd136 -- scripts/close test/close` returns exactly
`scripts/close/adjudication-skeleton.ts` and `test/close/adjudication-skeleton.test.ts` — and the
producer is pinned as the 26th `payload.tools` entry, with its blob row in §2.1. So the close-day
chain runs no program that post-dates this freeze.

**Corrected 2026-08-18.** This paragraph previously ended "and no second §8 ruling is owed". One
was: on 2026-08-18 an in-window recomputation of two frozen rules raised the same clause, and it is
disposed of as NOT A RESET in `Disclosure R-2026-08-18` of the deviation ledger, together with the
conduct findings the disposition does not clear and a second instance, adjudicated the same day at
`R-2026-08-18b`. The
error was one of scope, and the paragraph's own next sentence already warned about it: the evidence
here is producer-scoped and was never a survey of everything authored during the window. §4.8 lists
the entry.
**Scope of that claim, stated so it is not read wider than it is measured:** the evidence above is
producer-scoped. It establishes that the one program §9b identified as missing predates the freeze;
it is not a survey of everything authored during the window. The general assurance rests on the
standing rule — no close-day tooling is built inside the window — and on the run-sheet using no
close-day program other than this one.

### 4.7 Second-window deviations — D-2026-08-15-autoupdate-second-window

**Two as of 2026-08-17, both of the predicted kind; the second is written up after the first.**
*(This section opened "One so far" until 2026-08-17. The count is provisional by construction — the
marker at the end of this section is what fixes it at the close. It has since been overtaken twice:
the ledger carried four instances by 2026-08-19 and seven by 2026-08-22. Those instances are
deliberately NOT restated here — two accounts of the same events drift apart, and the ledger is the
record. What this section keeps is the reading below, which the later instances confirm rather than
revise.)*

**Instance 1.** The marketplace clone fast-forwarded off the candidate
on 2026-08-15 11:26:24Z — `pull origin HEAD: Fast-forward`, `94dd136 -> 3bd63d0` — with both
`autoUpdate` flags `false` and `DISABLE_AUTOUPDATER=1` exported and inherited. §4.2 established for
CLI 2.1.226 that the startup clone refresh consults neither, and closed with "every Claude startup
may move the clone again"; this is that. The instant is corroborated independently of the reflog by
`known_marketplaces.json`'s `helix.lastUpdated`, `2026-08-15T11:26:24.026Z`.

**Byte continuity unbroken.** `git diff 94dd136 3bd63d0 -- bin/ .claude-plugin/ hooks/ data/` is
empty; the freeze commit touches only `docs/release/`, `scripts/` and `test/`. All nine runtime
surfaces re-verified byte-identical under both load paths after the heal. Same wording as §§4.1-4.3:
a control/provenance deviation with continuous runtime bytes. **The clone-HEAD identity pin did not
hold continuously in this window either, and this report does not say it did.**

**Healed automatically** at 2026-08-16 01:43:44Z back to the candidate — the fourth heal overall
(§4.3 carries the first window's three) and the first of this window.

**Detection latency 14 h 17 m 20 s, stated because the alternative is implying monitoring that does
not exist.** `freeze-runtime-check.sh` is point-in-time: it fires on interactive shell start and on
the dogfood unit's `ExecStartPre`, and between the pull and the next such invocation the clone stood
off-pin undetected. This window survives it because the bytes never moved; a drift that also moved
bytes would have gone unnoticed for the same interval. That is the honest shape of the control.

**The wrinkle that makes it look harmless for the wrong reason.** The commit drifted TO is the
freeze commit itself. That is an artefact of ordering — the freeze commit is exactly one past the
candidate by construction, so it is the likeliest drift target and the least alarming-looking one.
The safety comes from the measured byte identity, not from the target's identity.

**Instance 2 — 2026-08-17, and it is the one that changes an operating assumption.** The clone
fast-forwarded again at 2026-08-17 05:32:54Z, `94dd136 -> 0d2e55f`, 16 seconds after a Claude Code
session start, on CLI `2.1.233`; healed at 06:55:31Z, the **fifth** heal overall and the second of
this window; detection latency **1 h 22 m 37 s**. Byte continuity was measured, not assumed: at the
drifted commit all four runtime trees are git-identical to the candidate's (`bin/` `e6bd010a`,
`.claude-plugin/` `e47c958f`, `hooks/` `3e1b6a4a`, `data/` `c2732f2f`) and each of the nine pinned
runtime files hashes to its pinned value. The twelve differing paths are CI config, one `src/`
module, the guard script and nine docs-and-receipt paths — none loaded by the plugin.

**What it establishes beyond the tally: the automatic healing opportunity is one instant per day,
and it precedes the run.** The guard is the dogfood unit's `ExecStartPre`, so it completes before
`ExecStart` — a run that later dies has already taken its healing pass. On 2026-08-16 that path did
the work: the unit started 10:43:44 KST and its `ExecStartPre` healed `3bd63d0` back to the
candidate. On 2026-08-17 the unit started 14:31:55 KST and found nothing to heal, because the drift
arrived **59 seconds later**; it then stood 1 h 22 m until an interactive shell start caught it. So
the exposure is set by WHEN the unit starts, not by whether the run succeeds, and start times have
ranged 10:43–20:01 KST under catch-up scheduling. This also means instance 1's 14 h 17 m and
instance 2's 1 h 22 m measure how soon a shell happened to open, not how well the check works. The
runner's own failures — 08-15 on a weekly quota, 08-17 on the `ISSUE-0006` entitlement refusal,
with 08-16 completing — bear on §5 accrual, not on this control. The ledger carries the same
finding; if the two disagree the ledger is the record.

**Provenance of the heal, stated so it is not read as remediation anyone chose.** It fired from a
subagent's shell start during an unrelated verification pass, under the auto-heal mode approved
2026-08-10 and gated to the case where clone-HEAD drift is the sole violation and every byte check
passes. Both conditions held.

- Final second-window deviation list and heal count: entries appended after 2026-08-14: `D-2026-08-15-autoupdate-second-window` with Instances 2–11; `R-2026-08-16`; `D-2026-08-18-in-window-product-rebuild` and `R-2026-08-19`; `Disclosure R-2026-08-18` with `R-2026-08-18b` and its 2026-08-24 amendment; `D-2026-08-22-in-window-pinned-source-edit`; `D-2026-08-25-rehearsal-triggered-run`; `D-2026-08-26-rehearsal-removed-guard`; `Disclosure R-2026-08-30` with three dispositions and the 2026-08-31 corrigenda; `Abort A-2026-08-31`. Heal log: 13 lines, final

### 4.8 Second-window rulings and disclosures — entries that are not deviations

The ledger entries below record decisions and acts inside this window rather than incidents. Each is
required §9a content and none is headed `Deviation` (Deviations are cited below as precedent or
cross-reference; the one whose class was decided in the same consultation is named at the end); the list is read from the ledger at close (the fill
marker in §4.7 above), not counted here.

**`Ruling R-2026-08-16`** — two in-window edit classes put to the owner with the Reset clause quoted
verbatim, and ruled NOT a reset: splitting `npm run typecheck` into its own CI job, and a
comment-only edit to an unpinned `src/verify/` file. The entry carries its own standing scope, which
is narrower than the ruling might suggest; read it there rather than generalising from this line.

**`Disclosure R-2026-08-18`, and its disposition** — an in-window computation of the §5
eligible-probe count, first by reimplementing two frozen rules in ephemeral Python and then by
running the frozen program itself in its holdout form. Both readings of §8 are set out in the entry,
an independent peer review reached the RESET conclusion, and the disposition recorded on 2026-08-18
is **NOT A RESET** — on the ground that the 2026-08-13 ruling settled the clause's modality and not
its scope, and that what was built issues no artifact of the §9 chain. The entry names the conflict
of interest first, keeps the losing case unrewritten, answers the dissent argument by argument, and
carries five conduct findings the disposition does NOT clear.

**`Disposition R-2026-08-18b`** — the home-machine pin-verification script, rewritten in-window
because the re-freeze replaced every expected value it carries. Also **NOT A RESET**, on precedent
rather than argument: `scripts/freeze-runtime-check.sh` was itself written inside the first window,
its output is cited four times by this report, and `D-2026-08-09` ruled that no reset was required.
Raised by the ruler against the ruler's own interest rather than left for the close.

**Amendment 2026-08-24 to `R-2026-08-18b`** (deviations ledger, same entry). The script moved twice
after the ruling — v3.3 on 2026-08-22 and v3.4 on 2026-08-23; the current file is 19,844 bytes,
sha256 `e1a7be1289f5d71a41910b1f798c75d7d3bc0722e8be3e50afa06f4f39cb4df3`. The amendment leaves the
ruled identification exactly as ruled, diffs the ruled bytes (recovered from the 2026-08-19 restore
point) against v3.4 — two behavioural sites, both narrowing — and re-measures the ruling's two
grounds against the current bytes: read-only, and issuing no §9-chain artifact. Both hold. It also
records, against the ruler's interest, that conduct finding 2's premise (*"the second window's known
set is empty"*) was true when written and no longer is: measured 2026-08-24, pin ∩ (candidate →
branch HEAD) = `src/memory/ownership.ts`, `src/memory/store.ts`, both carried by commits already
adjudicated (`R-2026-08-19`, `D-2026-08-22`). The disposition is unchanged.

**The number that disclosure records is HISTORY, not this report's result, and the distinction is
load-bearing.** §5's realized-accrual marker and §7's Hit@1 marker are close-day fills, produced by
the close chain from the close-bounded snapshot. They must be filled from that run and from nothing
else. An in-window reading of the same quantity is disclosed because §8's Reset clause and the
independence bullet in `pilot-amendment-1.md` both bear on the act of taking it — not because it
substitutes for the measurement. If those two ever disagree at the close, that disagreement is
itself a finding, and it is the close-day value that governs.

**`Disclosure R-2026-08-30`, and its three dispositions** — three §8 questions surfaced while the five
owner-flagged items of the 2026-08-27 rehearsal audit were worked, each recorded with the reading the
record supports and the reading that was tested and failed, and each ruled **NOT A RESET** on
2026-08-31: run-sheet C1.5's snapshot-hash composition (authored 2026-08-13T13:18:09Z, before `txAfter`;
a hand-run evidence line, not a program of the measured chain); the in-window edit of the operator's
global `CLAUDE.md` (environment under a functional, path-independent ruling — the workload driver's
prompt, schedule and project instructions are unchanged, the corpus rows stayed English, and the
generator's own auto-memory changes every run by design); and the host CLI's self-updates (unpinned
environment, as for the earlier versions, with no claim of zero behavioural effect). The entry
carries the why-log of a three-round peer reconciliation in which four reset readings were retracted on
the record's evidence and, on one of them, the peer's Deviation class was adopted — `D-2026-08-26-rehearsal-removed-guard`,
the G3 rehearsal's sub-second removal of the freeze guard's drop-in, recorded as a Deviation of a control
with continuous runtime bytes and ruled NOT A RESET 2026-08-31 (§4.7's fill marker covers it).

- **Owner disposition on `R-2026-08-18`: NOT A RESET, ruled 2026-08-18, changing no window
  identity.** The ledger states it in terms: the six passes reimplemented two frozen RULES but built
  none of the method's tooling, the act produced no input to any chain step and changed nothing on
  the measured surface, and the window stands with the close unchanged at
  `2026-09-11T06:20:01.000Z`. The identity check is recorded with it — all 26 `payload.tools` blob
  ids and both `payload.methodDocs` sha256 values recomputed against the receipt, zero mismatches.
  Two qualifications travel with the disposition and are not close-day values either: it states the
  recording party's conflict of interest before its reasoning, and it does not clear the five
  conduct findings it lists.

  *(Corrected 2026-08-22. This bullet was a close-time fill marker asking for the ruling, its date,
  and whether it moved the window's identities, with a conditional tail for the case where it was
  ruled a reset. All of that was answered on 2026-08-18 — three weeks before the close and fourteen
  lines below a paragraph in this same section that already names the disposition in the report's
  own voice. The conditional tail resolved with it: the ruling was NOT A RESET, so the branch in
  which this report goes unpublished for this window does not arise, and the anchor instant it
  points at, `2026-08-18T10:58:05Z`, is fixed in the ledger as history rather than as an input.
  Leaving the marker and recording the answer somewhere else was considered and rejected: the
  marker's own definition admits only values that can exist at the close alone, so a marker standing
  over a settled value misstates what close day owes. Same defect as §4.4's, same remedy.)*

---

## 5. The evidence chain — §9's eight elements

The chain's order is fixed: freeze receipt → close-bounded snapshot → manifest / candidate universe
/ classifier → **input pins** → prepare → **ordering append** → runner outputs → adjudication →
score → release decision. Input pins sit fourth, not first: the tool requires the manifest, the
classifier and the universe as inputs and exits 2 on any it cannot read, so it cannot run before the
artifacts it hashes. The ordering append that records `prepare-finished` is listed where it occurs,
between prepare and the runs, because that position is the whole of what element 4 attests. Each step
completed and was hashed before the next began, and nothing that reads a rank ran before the
prepare artifact existed and was hashed. **If the chain cannot be reconstructed from retained
evidence, the gate fails.**

**Element 1 — freeze receipt** (method half, issued at T).
`v2-freeze-receipt-2026-08.json`, payload `360ffe80f6baf853fdc5acb4bc949a14b84838c3827cbeb56832da56bfcc7332`,
issued 2026-08-14T06:20:34.216Z, binding the candidate commit, the runtime identity at both load
paths, the configuration bytes, K, the window, and every tool and method-doc hash of §2. Its
`issuedAt` is a self-reported wall clock and the artifact says so. *(Corrected 2026-08-22. This
line read `2026-08-02T11:48:35.264Z`, which is the VOID receipt's issuance — the first window's,
retained unedited as `v2-freeze-receipt-2026-08-02-void.json`. The payload sha on the line above was
already the live receipt's, so the element cited two different artifacts in two consecutive lines.
It is the same class of residue the 2026-08-17 reconciliation was cleaning up: a first-window
constant that survived the re-date because nothing recomputed it.)*

**Element 1b — input pins** (input half, derived at the close, bound back by `freezeSha256`).
the input-pins artifact in the close-run directory; `manifest` `19cfcadf215f0a3733c67195cc0d73fd248bdb3e49476ce2a061f7d299a74793`, `classifier` `035d027bcfedea46435851bbf4f2f3f6d16d84743926ed693f32f87e0c1546ec`, `universe` `7eb8ffa76e1799d2d0ac134591372b5e499c62b859878f4b720cfee38c3cc0f4`, `ledger:global` `1bf52353f9fa7de5612078104170a2dd0b872d91218cf8306960efa1e0afb5d9`, `ledger:project` `c264ba34356c066fb7710832b566df82d9982293f121a53537b9d9d69f4b024d`, `ownership:registry` `34e196f38fe2665c551f93f5a383c1c42344f839f36777579cd5c7d09260baa9`, `ownership:owner` `9a7c6132f04ababf3478a288d1f7707fa7ee18928f6e10498953357da6b7e326`, `trust:master-key` `f2a6b212c7f8b9e193e79a0bd14c8d47a6fec968a909fae4e47e3a701df231ea`, `trust:witness` `214389ff9a5031ff1a0cf5eb849853dc650bb5998c605eba64d30a3b1fc28211`, `expansion:semantic-neighbors` `c3cdbf645e260742cc1fc16c6563266975a946963173b0873e71e9b913a33f30`

**Element 2 — as-of-close snapshot hash demonstrating `cutoff < tx ≤ close`.** Recorded in §3.

**Element 3 — manifest, candidate universe, classifier, prepare.** The candidate universe has no
command of its own: `scripts/pilot/candidate-universe.ts` is a pinned **library module with no entry
point**, and the universe artifact is emitted by `classify-o67` as the `.universe.json` sibling of
its verdicts file — the name is derived at `classify-o67.ts:114` and the file written at `:179`,
from the same in-run recall the verdicts come from, so a verdict can never name an identity absent
from the universe it competed in. Three commands produce the four artifacts.
`manifest.json` `19cfcadf215f0a3733c67195cc0d73fd248bdb3e49476ce2a061f7d299a74793`; `classifier.json` `035d027bcfedea46435851bbf4f2f3f6d16d84743926ed693f32f87e0c1546ec`; `classifier.universe.json` `7eb8ffa76e1799d2d0ac134591372b5e499c62b859878f4b720cfee38c3cc0f4`; `gate-set.json` payloadSha256 `5ea01a2afeb0207c532a8e82f1ee21875a72c44ff3fa928dc309a1ccbeef053e` (file sha256 `41047b68ea98f5a77b1567d5236d4cde62597fe0e2465edd93c802a64b7cf367`)

**Element 4 — append-only ordering receipt showing `prepare-finished` before `runner-started`.**
The three run ids in this log (`run1`, `run2`, `run3`) are **operator labels**, chosen before each
execution to bracket it. They are not the runner's own ids and appear in no run artifact — see
element 5, which states the binding.
- `ordering.jsonl` in the close-run directory — seq 0 `prepare-finished` payload `5ea01a2afeb0207c532a8e82f1ee21875a72c44ff3fa928dc309a1ccbeef053e`; seq 1/3/5 `runner-started` for run1/run2/run3, each bound to that payload; seq 2/4/6 `runner-finished` payload `bf14becffae5ca0cbfdda31b8e49a209bddb26aa7d572d36c58e2c13ae468e56`; chain head `5d0334718f9c91a499f178523c98a976eb6bc3c8f77945fac2b276767d129c42`, verified with `--expect-prepare` AND `--expect-head` — 7 entries, 3 runs bound
- Prepared-artifact hash with its pre-run timestamp: gate-set payloadSha256 `5ea01a2afeb0207c532a8e82f1ee21875a72c44ff3fa928dc309a1ccbeef053e`; its `prepare-finished` line self-reports `2026-08-31T13:16:07.138Z` (a self-attested wall clock, as the verifier's own caveats state)

**Element 5 — runner outputs embedding the prepare hash and the run id.** Three runs of the
deterministic payload; the payload embeds the prepare hash, and the run id and wall clocks live in
the receipts, outside the payload hash, so three honest re-runs agree on the payload while never
being byte-identical files.

**Element 4 and element 5 are bound by the payload hash, never by an id, and the two id spaces are
disjoint by construction.** `run-pilot` takes no `--run-id` — its inputs are exactly `manifest`,
`snapshot`, `gate-set`, `out`, and anything else is refused — and it mints a fresh `randomUUID()`
into its receipts. So the ordering log's three operator labels appear in no run artifact, and the
runners' three UUIDs (`receipts.runIds` in the score) appear in no log line. A reader who tries to
match the two sets is matching things that were never related. What actually ties them is the
`runner-finished` line's `payloadSha256`, transcribed from the runner's own stdout: that value
equals the run artifact's payload hash, and equality is the binding. This is also why
`runner-started` carries the *prepare* hash instead — at that moment the run artifact does not exist
yet.
- `run1.json` / `run2.json` / `run3.json` in the close-run directory; all three payloads `bf14becffae5ca0cbfdda31b8e49a209bddb26aa7d572d36c58e2c13ae468e56`; run ids `82b9a719-5cff-415e-b63c-201c20646de1`, `04e89137-402d-4fda-b064-b06a337a4008`, `be55a4fc-6594-47bc-9400-4b7ecd79ea6c`
- Stability outcome: h1 = h2 = h3 — `stability.pass` true, recomputed by the scorer from the three files

**Element 6 — adjudication artifact binding the runner-output hash and quoting both sides of every
judgment.** The human judgments are ingested, never decided by the tooling. The file's mechanical
half — the two hash bindings and one entry per frozen probe — may be stamped by
`scripts/close/adjudication-skeleton.ts`, a **PINNED** close-day program — the 26th entry of the
receipt's `payload.tools`, whose hash row appears in §2.1. It was written in-window during the
FIRST window; §4.6 records the §8 disposition that followed (RESET) and the re-freeze that then
brought it inside the candidate. It writes every verdict as `UNJUDGED`, which the gate refuses over
a non-empty denominator (§4.6 states the zero-probe boundary), so nothing it emits is a judgment.
It is invoked **from the candidate checkout**, with the rest of the chain. Hand-authoring the file
instead is equally valid and reaches the same gate. *(Corrected 2026-08-17: this passage called the
program "unpinned" and placed its invocation "from the development tree" — both were first-window
facts, and both are contradicted by §2.1, §4.6 and the run-sheet's C8 in this same document set.)*
- the adjudication file in the close-run directory; `gateSetSha256` `5ea01a2afeb0207c532a8e82f1ee21875a72c44ff3fa928dc309a1ccbeef053e`, `runPayloadSha256` `bf14becffae5ca0cbfdda31b8e49a209bddb26aa7d572d36c58e2c13ae468e56`, and the scorer computed `adjudicationSha256` `0d8dd3dc3e1353f0879f297c5749f83e5debc3adc5ee0adf4d0913f6a812e7d3`
- 13 judgments — 0 `contradiction`, 13 `none` (owner-ruled 2026-08-31 over the full returned lists); no positive call, so no quoted texts were required
- no stale set was required: the gate set counts zero closer relationships (`Es = 0`); 0 `violation`

**Element 7 — score artifact binding the prepare, runner and adjudication hashes.**
`score.json` in the close-run directory, payloadSha256 `de7e3bbd2e96a699f60839ef981e12eb00a82944300ad0756ebb98b81bc6ae31`; it binds `gateSetSha256` `5ea01a2afeb0207c532a8e82f1ee21875a72c44ff3fa928dc309a1ccbeef053e`, `stability.runPayloadSha256` `bf14becffae5ca0cbfdda31b8e49a209bddb26aa7d572d36c58e2c13ae468e56` (×3), and `adjudicationSha256` `0d8dd3dc3e1353f0879f297c5749f83e5debc3adc5ee0adf4d0913f6a812e7d3`

**Element 8 — release record binding the score hash and showing the consequence was applied.**
Recorded in §9.

**What the chain closes, and what it does not.** A coordinator that refuses pre-existing outputs,
mints a fresh run id, creates every file exclusively and parent-links each artifact closes the
careless-operator class. It does **not** prove that no earlier unrecorded pass occurred, and no
self-attested timestamp can. Every self-reported wall clock in the retained artifacts is labelled
as such in the artifact that carries it. That the three runs are three distinct *executions* rests
on three distinct self-declared run ids and nothing more — the ids are outside every hash and
nothing signs a run.

---

## 6. Execution log

This section is the report's **one deliberate exception** to the provenance rule of §13. Every other
number here is transcribed from a named artifact; an execution log of commands and exit codes is not
something any artifact in the chain records, so its source is a **captured transcript file** — the
close chain is run under `script`/`tee` from the first command of the close-day sequence, and the
resulting file is the evidence. A captured file is not terminal scrollback and not memory, which is
what §13 rules out.

If no transcript was captured, that is itself reportable and is recorded in place of a claim the
report cannot support: the log is then reconstructed from the shell history and the artifacts
themselves, and it is labelled as a reconstruction with weaker provenance rather than presented as
a transcript. It is never reconstructed from memory.

no `script` capture exists — 0.1 was skipped in the abort-run. The ordered command sequence, outputs and exit codes are retained in the operator-session log and in the close-run log file (described location: the close-run directory); every chain step exited 0

none from any pinned tool — every invocation exited 0. The one blocking verdict is the gate's own, quoted in §8: `Hit@1 — exposure 1 is below the minimum of 2, so the primary measurement did not happen (PARTIALLY EXERCISED — 1/2 (minimum not met))`

none was captured — 0.1 was skipped for the abort-run; the session log and the close-run log are the execution record, described rather than pathed

---

## 7. The gate — seven conditions

The claim band of §1 applies to every number in this section:

> **The release decision was governed by a rule frozen before the v2 window, and no method,
> product, or remediation decision was informed by the v2 holdout's contents or outcomes.**
>
> v2 is a prospective, ledger-only temporal validation of self-derived decision queries. It is not
> a repetition or replacement of v1's two-sided pilot. v1 scored 25 ledger probes plus 26
> independently worded oracle probes with a manual semantic mapping and 4 preregistered coverage
> gaps; v2's population is structurally ledger-only, so coverage gaps cannot arise and the human
> oracle no longer independently checks what the memory failed to capture. **v2 does not validate**
> oracle segmentation, retrieval from an independent human restatement, the manual mapping, or
> resolution of the oracle-side O_67 failure.

| condition | blocking | result |
|---|---|---|
| Recall@20 | yes | 13/13, pass |
| Hit@1 | yes | 1/1 ranked 1; `PARTIALLY EXERCISED — 1/2 (minimum not met)`; FAIL (blocking) |
| Target-relative contradiction | yes | 0 positive calls; pass |
| Stale-served-as-live | only when `Es > 0` | `Es` = 0 — the condition was not required; label `UNEXPOSED — no temporal evidence`; pass (non-blocking) |
| Errors / unscorable | yes | `none`; pass |
| Stability | yes | identical; pass |
| Protocol and population integrity | yes | `chain verified at this link`; pass |

### 7.1 Recall@20 — a regression tripwire, not evidence

Every v2 probe has a retrievable target by construction, and coverage gaps are impossible because
they arise only on the oracle side. Measured on the frozen snapshot, all 25 ledger-side targets
ranked 1 and the worst rank among 47 targeted probes was 3, against a threshold of 20. **The
threshold is enormously slack**, so a pass yields a tight-looking bound on an event that is nearly
certain regardless of system quality. Its reported bound must never be presented as evidence of
recall quality. It is kept because a change that genuinely broke retrieval would trip it.

- 13/13, pass; nominal one-sided 95%% exact-binomial lower bound 0.794

### 7.2 Hit@1 — the primary measurement, with its bound

Denominator: the eligible probe rows, computed against the merged global + project competitor set.
Minimum exposure 2; `M < 2` blocks, because a shortfall means the primary measurement did not
happen rather than that it happened and scored badly.

- 1/1; exposure 1; `PARTIALLY EXERCISED — 1/2 (minimum not met)`; pass FALSE — the gate's blocking reason
- Reported bound: 0.0500 as computed at n = 1 — reported because the artifact carries it, meaningless at this n

The bound is **the nominal one-sided 95 percent exact-binomial lower bound for Hit@1 under a common
independent-success model**, and that qualification travels with the number. It describes sampling
error, not how hard the test was, and it is not a substitute for sample size. `L(0, 0)` is
undefined and is reported as `N/A`, never as 0.

### 7.3 Target-relative contradiction — a construct change, not a substitution

The v2 rubric: a returned live record that addresses the same proposition asserts the **negation**
of **the probe target record's** current statement, with both texts quoted and recorded. v1's
condition asked whether retrieval agreed with an independently maintained human statement; in v2
the target and the query source are the same ledger record under mechanical identity mapping, so
the condition can only test **internal retrieval coherence relative to that target**. It cannot
show that the target is correct, complete, or consistent with any external account, and **this
report does not describe it as oracle validation.**

- 0 positive calls — `contradictions.calls` is empty

### 7.4 Stale-served-as-live — exposure, and why zero exposure does not block

The violation rubric is v1's verbatim: a closed record appears in the top-K without its current
form at an equal-or-better rank. Exposure `Es` is the number of valid **closer relationships** in
the as-of-close snapshot, not the number of closed records returned. `Es = 0` reports
`UNEXPOSED — no temporal evidence` and does not block; `Es > 0` makes the condition binding exactly
as in v1.

`Es = 0` was the expected state: measured 2026-07-31 over the live corpus, 33 rows, every one an
`assert`, zero `supersede` / `invalidate` / `erase` rows across the corpus's entire 43-day history.

The asymmetry with Hit@1 is a preregistered policy, not a logical distinction — in both cases the
opportunity count can be zero. Hit@1 carries an evidence-sufficiency floor because it is the
pilot's primary measurement. Stale handling is a zero-violation safety property whose organic
exposure depends on whether the owner happened to correct or retract anything, and no minimum
stale fixture is preregistered. **The release is not untested on stale handling:** the suite at the
freeze commit deterministically verifies that `supersede`, `invalidate` and `erase` remove their
predecessors from the live projection; the pilot's contribution here would have been temporal
evidence on top of that fixture.

- `Es` 0; `UNEXPOSED — no temporal evidence`; 0 violations; no closed/current pairs exist

### 7.5 Errors / unscorable — structurally always-pass in a report that exists

**This condition cannot fail in the artifact that reports it, and that is stated here rather than
left for a reader to notice.** Every pipeline check in the prepare and score phases fails closed:
snapshot validation, prepare, the classifier, the runner, adjudication completeness and scoring all
refuse to produce a file rather than record a failure inside one. A `pass` here therefore means
only that no refusal occurred — the evidence is **the absence of a refusal, recorded in the run
log**, not the field itself. A condition that cannot fail in the artifact reporting it is not a
check.

The evidence that lives outside it: the freeze receipt (§5 element 1), the as-of-close snapshot
hash (§3), the append-only prepare-before-run ordering receipt (§5 element 4), and the execution
log of §6.

### 7.6 Stability — payload hashes only

Three runs of the deterministic payload; `h1 = h2` and `h1 = h3`, then deterministic scoring re-run
against the same adjudication reproducing the same payload. Audit receipts — real timestamps, run
ids, host facts — are retained and hashed into the provenance chain, never into the stability
comparison. The scorer recomputes the payload hashes rather than reading them from the files.

- run payloads `bf14becffae5ca0cbfdda31b8e49a209bddb26aa7d572d36c58e2c13ae468e56` × 3 — EQUAL; the second scoring run's payloadSha256 equals the first (`de7e3bbd2e96a699f60839ef981e12eb00a82944300ad0756ebb98b81bc6ae31`)

### 7.7 Protocol and population integrity — one link, and the always-pass caveat

The mechanical half of this condition is **also structurally always-pass in a report that exists**,
for the same reason as §7.5: the scorer refuses rather than reports when the gate set does not
match the freeze pin, when a run does not name that gate set, its manifest, its rule and its K, or
when the adjudication does not bind this gate set and this run. What the score artifact attests is
one link — that the prepare, runner and adjudication hashes it asserts are inside its own hashed
payload and so cannot be rewritten without breaking `payloadSha256`.

The rest of the chain is not something a scoring program can attest to about itself. Its evidence
is §5's elements 1, 2 and 4 — the freeze receipt, the as-of-close snapshot hash, and the
append-only prepare-before-run receipt — together with §2.3's re-verified pins and §6's execution
log.

- walked 2026-08-31: `release-record` binds `scoreSha256` `de7e3bbd2e96a699f60839ef981e12eb00a82944300ad0756ebb98b81bc6ae31` and `orderingHead` `5d0334718f9c91a499f178523c98a976eb6bc3c8f77945fac2b276767d129c42`; the score binds `gateSetSha256` `5ea01a2afeb0207c532a8e82f1ee21875a72c44ff3fa928dc309a1ccbeef053e`, the three run payloads `bf14becffae5ca0cbfdda31b8e49a209bddb26aa7d572d36c58e2c13ae468e56` and `adjudicationSha256` `0d8dd3dc3e1353f0879f297c5749f83e5debc3adc5ee0adf4d0913f6a812e7d3`; the adjudication binds the same gate set and run payload; the gate set was prepared from the manifest/classifier/universe whose hashes the pins artifact carries under `freezeSha256` `360ffe80f6baf853fdc5acb4bc949a14b84838c3827cbeb56832da56bfcc7332` — every element names its parent

---

## 8. The O_67 class — reporting only, threshold-free

The claim band of §1 applies to every number in this section, and is repeated here for that reason:

> **The release decision was governed by a rule frozen before the v2 window, and no method,
> product, or remediation decision was informed by the v2 holdout's contents or outcomes.**
>
> v2 is a prospective, ledger-only temporal validation of self-derived decision queries. It is not
> a repetition or replacement of v1's two-sided pilot. v1 scored 25 ledger probes plus 26
> independently worded oracle probes with a manual semantic mapping and 4 preregistered coverage
> gaps; v2's population is structurally ledger-only, so coverage gaps cannot arise and the human
> oracle no longer independently checks what the memory failed to capture. **v2 does not validate**
> oracle segmentation, retrieval from an independent human restatement, the manual mapping, or
> resolution of the oracle-side O_67 failure.

Owner decision D-a removed O_67-class exposure from the release-blocking set; D-b keeps in-class
members **in** the binding Hit@1 denominator. There is therefore no `E` denominator, no
`PARTIALLY EXERCISED` state and no shadow Hit@1. The class does not participate in the close rule.
In-class membership grants no Recall@20 exemption. The membership rule is `o67-class-rule-2026-07.md`
§2, with the candidate universe of its §3 and the fail-closed statuses of its §4.

- Full single-target census: the classifier artifact in the close-run directory (sha256 `035d027bcfedea46435851bbf4f2f3f6d16d84743926ed693f32f87e0c1546ec`) carries the full census
- Distinct in-class target identities: 0
- How many of those are Hit@1 eligible: 0
- Per case — witnesses, best rank, Hit@1, Recall@K: none — there is no in-class case
- Label: `UNEXERCISED — 0 distinct cases observed (reporting only, non-blocking)`

**Honest qualification.** D-b does not guarantee the class was ever tested. If no in-class case
appeared — the expected outcome — D-b and the old exclusion produce identical results, and D5's
unexercised report applies either way. D-b's real effect is that *should* a case appear, it is
graded rather than set aside.

---

## 9. Release decision, and evidence the consequence was applied

The gate's verdict is mechanical: a release is blocked when any blocking condition failed, with one
reason per failing condition written under the condition's governance-text name. The release record
refuses a decision that contradicts the gate in either direction, and anchors the ordering log's
final head.

The claim band of §1 applies to the verdict and to every number behind it, and is repeated here
because a reader who opens the report at its decision must see what the decision does and does not
support:

> **The release decision was governed by a rule frozen before the v2 window, and no method,
> product, or remediation decision was informed by the v2 holdout's contents or outcomes.**
>
> v2 is a prospective, ledger-only temporal validation of self-derived decision queries. It is not
> a repetition or replacement of v1's two-sided pilot. v1 scored 25 ledger probes plus 26
> independently worded oracle probes with a manual semantic mapping and 4 preregistered coverage
> gaps; v2's population is structurally ledger-only, so coverage gaps cannot arise and the human
> oracle no longer independently checks what the memory failed to capture. **v2 does not validate**
> oracle segmentation, retrieval from an independent human restatement, the manual mapping, or
> resolution of the oracle-side O_67 failure.

- Gate verdict: `blocked: true`; reason: `Hit@1 — exposure 1 is below the minimum of 2, so the primary measurement did not happen (PARTIALLY EXERCISED — 1/2 (minimum not met))`
- Release record: the release record in the close-run directory, payloadSha256 `b3fa888377e49462df9f721f734c1fb9828136ece4ca55834121b05d34c1fe97`, binding `scoreSha256` `de7e3bbd2e96a699f60839ef981e12eb00a82944300ad0756ebb98b81bc6ae31` and `orderingHead` `5d0334718f9c91a499f178523c98a976eb6bc3c8f77945fac2b276767d129c42`
- The declared consequence: “Nothing is released on this record: the gate blocked at sample sufficiency (eligible Hit@1 exposure 1 against a minimum of 2), so the primary claim was not measured. These numbers are development evidence of an ABORTED window — Abort A-2026-08-31, T_abort 2026-08-31T10:02:21.000Z, eleven days before the derived close — and no pre-registered close claim attaches to them.”
- Evidence the consequence was actually applied: “score.json payload de7e3bbd2e96a699f60839ef981e12eb00a82944300ad0756ebb98b81bc6ae31 (re-scored EQUAL at score2.json); three runs stable at payload bf14becffae5ca0cbfdda31b8e49a209bddb26aa7d572d36c58e2c13ae468e56; ordering receipt 7 entries, 3 runs bound, head 5d0334718f9c91a499f178523c98a976eb6bc3c8f77945fac2b276767d129c42; snapshot composed sha256 4a5908c360045bf5d0dc2350d0afbb4b85cb0c3f08d5ec708971cd2c0862f13c; abort recorded in the deviations ledger at commit ee35e41.”

A blocked release is a **result**, not an incident to be re-run until it passes. Re-running would
require a new freeze and a new window. Conversion of the v2 probes into a regression suite happens
only after a release.

---

## 10. Close-out actions

These are the window's operational closure, recorded here because the deviation ledger makes them
close-report duties. They are not part of the measurement.

- Validated close receipt written: none — the window was ABORTED before its derived close, so no validated close receipt exists; the guard was retired by removal (G2/G3), not by a receipt. The abort's anchor is `Abort A-2026-08-31` in the deviations ledger, committed and pushed at `ee35e41` before any consequent act
- Guard wiring removed: confirmed 2026-08-31 23:0x KST: the three `~/.bashrc` lines removed (`grep` for the guard prints nothing) and the systemd drop-in plus its `.d` directory removed, `daemon-reload` run — `show` carries no `ExecStartPre` and no `DISABLE_AUTOUPDATER`
- Marketplace `autoUpdate` restored: both `true`, re-read after an atomic rewrite with backups kept beside both files
- Deployment brought current: F1 rebuilt all five bundles from the 37 post-candidate commits (offline `npm ci`; `fast-uri` 3.1.5 bundled for the first time; after `npm run inventory` the full suite reported 2485 passed, 0 failed, 2 skipped); F3 committed and pushed the rebuild; F4 redeployed at BOTH scopes including the `--scope local` leg from the project root; F5: both registry entries, the clone HEAD and both load-path bundles all name the F3 commit, `helix-mcp.mjs` sha256 `a7c133d46fe3bc4e5fbd5c46bb95ed77d0ca9311f4a74e8d14ce63a549c850ea` at all three copies; the CLI binary was byte-identical before and after the sequence
- Retention of the evidence chain: the working set is in place in the close-run directory, and the Q4 archive exists and is verified (below); the durable off-machine copy of the non-secret chain, the offline snapshot location, and the archive's own separate-medium copy remain the owner's physical acts, PENDING as of this record
- In-repository evidence index: `docs/release/v2-close-evidence-index-2026-08.md`, 15 rows — 14 artifacts plus the transcript row marked none-captured
- Owner-owed operational items, **reported open if unexecuted**: Q1 recovery codes: OPEN, not executed; Q2 credential inventory: OPEN, not executed; Q4 encrypted backup: PRODUCED AND VERIFIED 2026-08-31 23:00 KST after one failed attempt at 22:11 (pinentry could not reach the terminal; the loopback prompt resolved it) — 101,632 bytes, AES256 symmetric, archive sha256 `8171a536fba3792e0e7996ad06165dcd2565ea0c1ff6867c8affa88eedeb5bd6`, `ledger-mac-master.key` listed with mode `-rw-------` under decryption, no plaintext archive anywhere; the separate-medium copy and the off-box passphrase note remain OPEN, the owner's physical acts

---

## 11. Failures, refusals, and what this report does not prove

- Failures and refusals: no chain step failed — every pinned invocation exited 0; the blocking verdict is the gate's sample-sufficiency reason quoted in §8. Outside the chain: the Q4 backup's first attempt failed on a pinentry/terminal fault and succeeded the same night (§10); A1 was never run (§2.3)

**What this report does not prove.** No self-attested artifact shows that no unrecorded earlier
pass occurred; every wall clock in the chain is self-reported and labelled as such. The three runs
are distinguished as executions only by three self-declared run ids, which nothing signs. The
runtime identity pin is declared rather than re-derived from bytes inside the chain, and its only
counterparty is the runtime-pin observation recorded in §2.3 — an observation of the deployment as
it stood before the post-close redeploy, not a derivation, and one that cannot be repeated after
that redeploy has replaced the bytes it read. The clone-HEAD identity pin did not hold continuously
during the window (§4.1–§4.3 for the first window, §4.7 for the second), and this report does not
claim it did. Neither can it claim byte continuity without qualification, which an earlier draft of
this paragraph did: on 2026-08-19 the marketplace clone carried non-candidate bytes for
1 h 32 m 27 s with four of the nine pin-list files off-pin, while the install cache stayed
candidate-identical throughout. The claim is therefore the narrower one — byte continuity held at
both load paths for the whole window EXCEPT that one measured interval, evidenced by the tree
comparisons in the deviation ledger — and what cannot be claimed at all is that no short-lived
process bound the marketplace bundle inside it.

---

## 12. D5 disclosure duties — in full

Reproduced in full rather than by reference, as §9a requires. The four duties are quoted below
exactly as `v2-preregistration-2026-07.md` §7 writes them, with nothing added inside the quote; how
this report discharges each one follows the quotation, so that "in full" and "verbatim" are both
visibly true.

> These are duties, not options, and they are what make the non-blocking treatment of §6 honest
> rather than quiet:
>
> 1. **v2's gate design is informed by v1's O_67 outcome and must say so wherever v2 is
>    described.** This document is one such place; the final report is another.
> 2. **Any revised unambiguity/subset rule validates on NEW TEMPORAL CASES ONLY.** The merged-scope
>    competitor denominator (§3) is such a revision: widening the competitor set can only move
>    probes *out* of the unambiguous subset, so it relaxes Hit@1 and tightens O_67 exposure
>    accrual. The frozen corpus cannot demonstrate it — 25 project rows against 1 global row, no
>    probe flips either way — so it carries **no v1 validation claim**.
> 3. **An absent class is reported unexercised, never silently validated.**
> 4. **The measured method's limits are stated with the result**, not in a footnote: §1's
>    coverage statement travels with every published verdict.

Two cross-references inside that quotation are the **preregistration's own** section numbers, not
this report's: "§6" in the preamble and "(§3)" in duty 2 point at the preregistration's §6 (the
O_67 class) and §3 (the six §f elements, which fix the merged-scope competitor denominator). They
are left as written because the quotation is verbatim.

**How each duty is discharged here.**

1. This report is the "final report" duty 1 names, and this sentence is the disclosure it requires:
   v2's gate design is informed by v1's O_67 outcome.
2. Carried verbatim above, including its **no v1 validation claim** conclusion; §8 of this report
   states the same limit at the place where the class is reported.
3. Discharged by §8's label, which reports the class as unexercised when no in-class case appears
   and never as validated.
4. §1's coverage statement travels with every reported number: it is repeated in full in §3, §7, §8
   and §9 — the four sections of this report that carry measured values — rather than stated once
   at the top.

---

## 13. Report provenance

- Drafted 2026-08-13, during the open window, from `v2-preregistration-2026-07.md` §9a's required
  content list. Drafting a report skeleton fixes no measured rule and resets nothing: the measured
  surface is code, config and the frozen rules — not prose. A close-day program was also written
  in-window; it is disclosed with its §8 disposition in §4.6 rather than here, because that is a
  window-lifecycle question and not a provenance one.
- Every number in it comes from an artifact named in §5; nothing was transcribed from a terminal
  scrollback or from memory. **The single exception is §6's execution log and §11's refusal
  record**, which no artifact in the chain carries: their source is the captured close-day
  transcript file named in §6 — a file, not scrollback — and if no such file exists §6 says so and
  labels its content a reconstruction.
- Completed at the close: 2026-08-31 (KST), by the operator and the assistant executing the abort-run; the markers were filled the same night the window was aborted
