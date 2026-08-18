# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Reporting a vulnerability

Please report security issues **privately** via GitHub's "Report a vulnerability"
(the **Security → Advisories** tab on
[`wlsgur073/helix`](https://github.com/wlsgur073/helix/security/advisories/new)).
Do **not** open a public issue for a vulnerability. Expect an initial
acknowledgement within a few days.

## Trust model (what Helix guarantees)

- **Provenance firewall (fail-closed):** a mechanical reality-check (`helix_memory_recheck`)
  raises a fact only to `Corroborated`; only you (`helix_memory_confirm`) can promote it to
  `Verified`; agreement from an external model never does. `Corroborated`/`Verified` are now
  **tamper-evident at the file surface** (see *Ledger integrity* below): a forged or hand-edited
  ledger record replays as `Fresh`. The grade is still **not** an enforceable human-approval
  signal at the *tool* surface, so do **not** allow-list `helix_memory_confirm` — it must prompt
  for your explicit approval. The same holds for **`helix_memory_adopt`**, the only other tool that
  moves what Helix trusts: adopting a project ledger makes everything already in it recallable, and
  no grade check stands between the adoption and the next recall. It names the project root it is
  adopting so the prompt has something to review, and refuses a root that is not the active scope,
  but neither substitutes for the prompt — do **not** allow-list it either. Every adoption is
  recorded in `audit.jsonl`.
- **Trust states:** `Fresh / Corroborated / Verified / Suspect`, with re-verify-before-use on
  high-blast-radius paths.
- **Secret handling:** memory is secret-scanned and redacted before it is persisted.
  The dual-verify egress guard hard-blocks **named provider credential tokens**
  (override-proof — a config policy of `allow` cannot release them); generic
  heuristic-detected (`password=`-style) and high-entropy secrets are blocked by
  default but are per-leg policy-overridable (`dualVerify.egressPolicy`).
  **One documented exception to "blocked by default":** a high-entropy token whose
  stripped core is pure hex (git SHA / digest) or a chain of individually low-entropy
  segments (dated filenames, doc paths), with no credential keyword in the same
  statement, is RELEASED by default — a false-positive mitigation for design prose,
  which fired twice on real artifact names. It is gated by its own leg,
  `secretEntropyExempt` (default `allow`); set it to `block` to close the exemption.
  Until 2026-08-04 that release was applied inside the detector, upstream of every
  policy key, so no configuration could reach it. Note the asymmetry that remains by
  design: the WRITE path redacts these same bytes regardless of this leg.
  A trailing source-citation line reference (`path/to/file.ts:112`, `:44-45`, `:45:7`)
  is removed before the chain test, so a code pointer is judged on its path. The removal
  is conditional on the prefix being file-shaped (a dot plus a 1–5 character extension)
  with each number at most five digits — a word-labelled numeric value such as
  `backup.recovery.identifier:593821` is **not** a citation and stays in the net, as does
  an interior `label:<secret>` pair. The residual limit, stated plainly: a token
  syntactically indistinguishable from a citation is released, and no local test can
  separate the two.
- **The egress scan fails closed on size, and the caps are hard.** A payload whose raw or
  outbound form exceeds **200,000 characters**, or an aggregate ledger exceeding
  **8,000,000 characters**, is REFUSED unscanned rather than sent — the decision is
  `blocked` with `decidedBy: 'scan_limit'`. No policy key releases either cap; they sit
  upstream of `dualVerify.egressPolicy` entirely. The direction is deliberate: an
  adversary who can grow the ledger can therefore cause **availability** loss on
  dual-verify, which is far cheaper than unbounded scanning of adversary-sized input.
  The ledger cap is sized well above the point at which the persistent-index migration
  trigger fires, so no legitimate ledger reaches it — but a user whose corpus does grow
  past it sees every dual-verify call refused, and this is the only place that says so.
- **Untrusted content** (recalled memory, external-model output) is treated as DATA,
  never instructions: NFKC/control/bidi normalization + per-line datamarking + a
  per-call nonce frame.
- **Local-first:** no telemetry; the only outbound path is the opt-in `helix_dual_verify`
  call, which is off by default and egress-gated.

## Ledger integrity (file surface)

`Corroborated` and `Verified` are conferred **only** by a `verify` record, and every `verify`
record is HMAC-SHA256-authenticated with a key held **only** in `~/.helix` (a 32-byte master,
mode `0600`, never written into the repo ledger; each project signs with its own HKDF subkey).
That location is the home directory itself — `HELIX_HOME` when set — and it is **not** derived from
where the ledger happens to be: pointing `HELIX_LEDGER` into a repository moves the data file and
nothing else. When trust-store files are found beside a relocated ledger — the layout an older build produced —
the server measures whether starting would lose a grade this ledger currently carries, and refuses to
start only in that case, rather than minting a second key over the top of them. Otherwise it starts
and prints a note naming the leftover files: refusing on the layout alone was itself a denial of
service, since one planted, shape-valid file could stop every session on an install with nothing
at risk.
On replay an elevated grade is honored only if its `verify` record's MAC validates under the
locally-held key, so:

- A forged or hand-edited `verify` record (no MAC, or a MAC that no longer matches) is **ignored**,
  and a forged elevated `assert` is clamped to `Fresh` — minting a top grade by appending raw JSON
  to `.helix/memory.jsonl` no longer works.
- Against an adversary that can write `.helix/memory.jsonl` but **cannot read `~/.helix`**,
  `Corroborated`/`Verified` are **unforgeable at the file/append surface**. This is the same trust
  boundary the ownership registry already relies on.
- **A fact id is owned by the first row that claims it**, in file order, and an appended row bearing
  an existing id is inert. A `verify` binds only `(id, contentDigest)`, so a second row with that id
  and that content used to satisfy it just as well as the row it was signed for — and rode the grade
  up carrying the appending writer's `provenance`, `classification` and validity bounds, none of
  which any MAC covers. Position, not `tx` or `gen`, decides ownership: a non-`verify` row carries no
  MAC at all, so those fields are adversary-chosen, whereas getting *in front* of the genuine row
  means rewriting the witnessed prefix, which the rollback witness reports as `mismatch`.
- **A grade cannot be minted while the rollback alarm stands.** The witness verdict used to gate
  what a read *displayed* but not what the write path *signed*, and a signed `verify` records
  nothing about the verdict it was minted under — so it was indistinguishable from an honest one
  afterwards. An elevated `verify` is now refused under a `mismatch` verdict, before anything is
  appended, so the alarm survives to be investigated rather than written over. The refusal is
  narrow: ordinary commits, soft erases, and reality-check **demotions** still land, because a scope
  under suspicion must stay able to record that something failed. Note what this does *not* claim:
  it stops Helix from being used as the signer, not an adversary who already holds the master key.
- **The content binding is injective.** The digest a `verify` signs is taken over an encoding that
  distinguishes every JS string, including ill-formed ones. Plain UTF-8 does not: it replaces every
  lone surrogate with U+FFFD, so unboundedly many distinct contents — including well-formed ones —
  shared a digest and could be substituted under a signed grade. Well-formed content hashes exactly
  as before, so every previously signed `verify` still applies.
- **Verification timing is authenticated (MAC v2).** A `verify` record now also binds its system-time
  `tx` into the MAC, so the *timing* of a genuine verification cannot be edited in place. This is
  **authenticity, not accuracy**: it certifies the bytes the signing clock claimed at mint time, not
  that the clock was correct. Pre-existing v1 verifications stay valid but carry an unauthenticated
  (editable) `tx` — timing trust is therefore per-record, and grows only as facts are genuinely
  re-verified. Grade validity never depends on `tx`: a v1 grade survives even if its `tx` is garbage.
  **Point-in-time membership does depend on it**, and that is the one place an editable v1 `tx`
  still buys something: `--asOf` selects rows by raw `tx`, so a byte-copy of a v1 verify with its
  `tx` moved back is a valid verify inside a past window. Fact-id ownership is therefore resolved
  over the whole ledger *before* the window is applied — otherwise a duplicate dated into the past
  would be the only claimant of its id there, with nothing left to arbitrate against.

**This authenticates the file surface, not the tool surface.** A legitimate `helix_memory_confirm`
call still carries no enforceable human-approval signal, so the guidance above stands: do **not**
allow-list `helix_memory_confirm`, and do **not** allow-list `helix_memory_adopt`.

### Compaction integrity/horizon markers (F5) — clearing a planted marker is an operator procedure

A compaction mints a content-free, **unsigned** `integrity_marker` when it drops one or more forged
`verify` records, and a `horizon_marker` when it drops closed fact history — coalesced to a single
canonical row per kind (constant id, sentinel timestamp; see `canonicalMarker` in
`src/memory/ledger.ts`). Once minted, either marker is a **durable fixpoint by design**: every later
compaction re-mints the byte-identical row rather than dropping it, so a genuine forgery-audit signal
cannot silently age out.

The marker's **presence is forgeable**: it carries no MAC, so a ledger-write adversary who appends any
row whose id starts with `integrity_` or `horizon_` mints the canonical marker whether or not a real
incident occurred. Treat it as an audit *signal* to investigate, not a proof.

**Clearing a planted marker requires an out-of-band, permanent erase of its canonical id** —
`store.erase('integrity_marker', { permanent: true })` (or `'horizon_marker'`), which suppresses the
marker on this and every later compaction (`erasedIds` in `planCompaction`/`compactLedger`). This is
**deliberately unreachable from the MCP tool surface**: `helix_memory_erase`'s schema is `{id}` only —
it always tombstones (soft), it can never pass `permanent: true`. So a prompt-injected agent cannot
reach this path and cannot destroy a genuine forgery-audit signal; only an operator running code
outside the agent's conversation (a script or REPL against `MemoryStore`) can.

**Marker-erase routing (fixed); general non-live-id fallback (narrower residual).** A permanent erase
of a *project* ledger's planted marker no longer risks landing on the global ledger: `erase()` resolves
its target through `resolveEraseTarget`, which recognizes a marker by its canonical family
(`markerFamilyOf` + a family-prefix presence check in `presentIn`) rather than by live-projection
membership, and the `scope` parameter (`erase(id, { permanent: true, scope: 'project' })`) lets a
caller pin the ledger explicitly. A committed probe
(`test/memory/provenance-audit/marker-erase-routing.test.ts`) confirms a project-ledger marker's
permanent erase with `scope: 'project'` empties it from that ledger, not global.

This does not retire every non-live-id routing question. `ledgerOf(id)` — the separate routine that
resolves an *existing* target's ledger for `confirm`/`recheck` (signed-verify writes) and for
`commit`'s supersede-target lookup — still falls back to the GLOBAL ledger for any id absent from both
live projections. Both of its call sites re-check liveness immediately afterward and throw rather than
act on a mismatch, so this is not a silent-corruption path today, but the "default to global when not
found" pattern is not eliminated everywhere, only hardened for erase. For a non-live, non-marker id,
still confirm which ledger it physically lives in (read the ledger JSONL directly, or
`helix_memory_inspect`), or pass an explicit `scope` where the API offers one.

**Residual bounds (documented, not defended):**

- **Arbitrary home-read is irreducible.** An adversary that can read `~/.helix` obtains the key
  and can mint valid MACs; no locally-held key is safe from it. A readable home key (broad
  permissions, a shared host) is a **security downgrade equivalent to that out-of-model adversary**:
  the file-surface guarantee is then void and all grades become forgeable.
- **Unconfined-agent deployments void the model by construction.** Granting an agent an
  allow-listed runtime (e.g. `node`) plus filesystem read of `~/.helix` IS the arbitrary-home-read
  adversary above: in such a deployment (the maintainer's own dogfood box included)
  `Corroborated`/`Verified` are forgeable and the file-surface guarantee does not apply. Accepted
  and documented; confine the agent or isolate the key to restore the boundary.
- **Rollback-by-suppression is not detected by the per-record MAC alone.** Deleting or truncating
  a later legitimate `verify` to preserve a stale elevated grade is invisible to a per-record MAC
  in isolation. A home-side per-scope high-water witness that closes this for a boundary-writable,
  git-tracked ledger has shipped — see *Rollback witness* below for what it catches and its own
  residual bounds (a whole-home coordinated rollback is still undetectable locally).
- **Trust is machine-local.** The signing key never leaves `~/.helix`, so a `Verified` grade does
  not transfer to another machine (e.g. a Windows vs. WSL clone) — elevations signed elsewhere
  replay as `Fresh` until you re-`confirm` on that machine.
- **A `Corroborated` grade can originate from, and be lost to, a non-authoritative source.**
  `recheck`'s mechanical reality-check can raise an `agent-inference`/`agent-test-verified`/`user-relayed` record to
  `Corroborated` because the checked evidence (e.g. a file's contents) is plantable by the same
  agent — deliberately so: `Corroborated` is the weaker, mechanical grade, only a `user`-sourced,
  human-approved `confirm` reaches `Verified`, and `requiresReverifyBeforeUse` still flags any
  non-authoritative source regardless of grade. Symmetrically, the supersede guard protects only a
  target that is `Verified` or already has a verifying source, so that same `Corroborated` record
  can still be superseded or evicted by a later Fresh non-authoritative commit; the replacement is
  honestly `Fresh` — no grade is forged — so this is a within-model crowd-out property, not a
  trust-forgery.
- **Superseding a `Verified` fact requires proof of read.** The guard above it is credentialed by a
  model-supplied enum, so any caller willing to declare `source=user` walked straight past the
  highest tier. What is enforceable instead is that the caller actually retrieved the target: a
  supersede of a `Verified` record must echo that record's `contentDigest` back as
  `supersedesDigest`, and `recall` / `inspect` are what hand the token out — so the whole cost to an
  honest caller is one extra read, and a caller acting blind (the prompt-injected case this exists
  for) cannot pay it. It applies only to `Verified` targets, which is exactly where `state` is
  MAC-covered, so it sits on the authenticated boundary and does not tax ordinary `Fresh` updates.
  **It is proof of read, not an authorization check** — no field a commit carries is authenticated.
  Residual, stated rather than hidden: an adversary who can guess the target's content byte-exactly
  computes the digest without ever reading it, with short predictable facts the weak case — far
  narrower than declaring an enum value, but not nothing. Superseding a `Verified` record costs the
  grade either way: the signed `verify` binds `(id, contentDigest)`, so replacement content replays
  as `Fresh`.
- **`provenance.source` is caller-declared, and is not a trust boundary.** The ledger MAC does not
  cover it, the verified projection passes it through unclamped, and the tool schema lets the calling
  model choose it — the server has no way to tell what you said from what a document you pasted said.
  So it may drive **disclosure and ranking** (the reverify-before-use flag, the recall penalty, which
  items the SessionStart preamble surfaces), where failing open still leaves the content visible in
  front of you. It must never drive a **durable trust-state** decision. Until 2026-08-05 one did: a
  determinate reality-check failure against an item *claiming* `source=user` was suppressed entirely
  rather than demoting it to `Suspect`, so the claim alone bought permanent immunity from mechanical
  contradiction. The demotion guard now reads only the authenticated `Verified` grade. Two
  configuration-dependent controls remain, and are defence-in-depth rather than mechanisms: the
  supersede refusal, and `confirm`'s eligibility check — which is only as strong as the tool-approval
  prompt above it, per the trust-model note on not allow-listing `helix_memory_confirm`.

## Rollback witness (cross-boundary ledger rollback)

Ledger integrity (above) authenticates individual records; it does not by itself detect a ledger
*regressing*. A project ledger that lives in a boundary-writable, git-tracked tree (for example, a
repo that tracks `.helix/memory.jsonl`) can be checked out, restored, or reset to an earlier state
while every other copy of the world still remembers the newer one — silently, with no MAC
violation, because the restored file is itself a completely legitimate, correctly-signed past
state. A home-side **rollback witness** (`~/.helix/witness.json`, one MAC'd entry per ledger scope,
signed with the same master key as `verify` records under its own domain) closes this gap: it
lives on the trusted side of the boundary the ledger-HMAC threat model already assumes an
adversary cannot read or write, so a ledger's current bytes are checked against it on every read.

- **Authority.** A detected mismatch — a current ledger that has forked from or fallen behind its
  witnessed head, with no rewrite already in flight for that scope — clamps that scope's
  `Verified`/`Corroborated` grades to `Fresh` on every live projection (recall, inspect, the
  SessionStart hook) and renders a constant, trusted disclosure note outside the DATA frame. This
  is armed from the first release, not opt-in.
- **Serve-with-note.** A mismatched scope is not blacked out: its rows keep being served (with the
  note, and with elevated grades clamped) and new appends keep landing, but the witness itself
  never advances over a mismatch. Only an explicit re-baseline (below) clears the signal, so the
  very next ordinary append after a rollback can never silently launder the alarm away. (A
  separate, narrower state — a ledger rewrite caught mid-transition — always excludes reads and
  blocks appends for that scope until resolved, independent of this policy. A *rewrite* is still
  permitted there, because re-driving an interrupted transition is how that state is meant to
  resolve. So that this does not become a second laundering route, the mid-transition state is
  itself discriminated: a pending transition records the bytes it opened over as well as the bytes
  it would produce, and a ledger carrying NEITHER as a prefix is neither the before nor the after.
  It is classified a mismatch, not an interruption, and the rewrite is refused.)
- **Fenced current-head-only witness, user-only ceremony.** The witness keeps only each scope's
  live head, never a history of erased-era bytes, kept honest by a content-free marker row planted
  at the end of every legitimate rewrite (compaction, erase, an authorized re-baseline) — so a
  restored old-era file can never pass as a benign extension of the current one. The only
  sanctioned way to re-bless a mismatched scope is `bin/helix-rebaseline.mjs`, an interactive,
  TTY-only CLI that displays the scope, byte hash, and target epoch, requires a typed
  confirmation, and holds the ledger lock from that display through the commit. It is deliberately
  **not** an MCP tool: no agent-suppliable parameter can invoke it, and nothing invokes it
  automatically.

Note: because the witness is signed, a witnessed append now materializes the master signing key
(`~/.helix/ledger-mac-master.key`) on the *first* memory write rather than the first `verify` —
the key simply comes into existence earlier in a fresh install's life. It is created 0600 by the
same one-time path as before; nothing about the key's secrecy changes, only when it first appears.

### Named limitations (documented, not defended)

- A whole-home coordinated rollback — the ledger, the witness, and any cache all restored together
  to one consistent earlier snapshot — is not detectable locally; it is the same class of exposure
  as any other adversary capable of reading and writing your home directory.
- Rows appended in the narrow window between a durable append and the witness's own next advance
  stay regression-unprotected until that advance happens (the unwitnessed-suffix crash window).
- First run, first contact with a new scope, a witness key rotation, and a deleted witness file are
  all trust-on-first-use: each is an honest, fail-open re-initialization rather than a silent one,
  and every case is surfaced by its own disclosure note.
- The re-baseline ceremony proves interface shape, not human presence: any agent capable of driving
  a shell can allocate a pty, read the displayed hash, and type the confirmation. This is a
  residual in every deployment that grants an agent shell access — it is not a guarantee that a
  human approved the re-baseline.
- Era information recovered from marker rows inside a mismatched file is an advisory diagnostic,
  not an authenticated fact: a boundary adversary can strip or replant a marker it has already seen
  (though it can never forge one bearing a future, still-unpredictable nonce).
- The witness does not stop a boundary writer from re-appending copies of previously-read rows as
  new suffix content — that is the ordinary append capability this threat model always grants.
  Keeping replayed content from being trusted again is row-level validation and provenance's job,
  not the witness's.
- Availability under attack is contained per scope: forcing a mismatch and forcing a caught-mid-
  rewrite state both require boundary write access, though they are not the identical capability.
  Recovery is normally a short, idempotent re-drive of the interrupted rewrite. A rewrite that was
  interrupted BEFORE its bytes landed is retracted at the next start instead: the scope is left
  holding exactly the bytes already on disk, which is both the pre-rewrite state and what a
  deliberate rollback to those bytes asked for, so retraction never re-drives anything a rollback
  removed. Only what cannot be decided from the bytes — an interruption whose ledger is on the
  post-rewrite lineage, one with no predecessor to compare against, or a fork off both — stays
  ceremony-bound, and that scope stays dark until a human runs it.

## Ledger locking, erasure, and durability boundaries

- **What the lock defends:** accidental concurrency among helix's own processes, OS scheduling
  (suspension is ALIVE, never stolen), and crashes (a provably-dead holder is reclaimed through a
  serialized, per-boot reaper gate). It does not defend against an adversary with code execution,
  and it presumes ONE kernel/boot-id domain on a LOCAL filesystem — a ledger reached from two
  kernels (e.g. a path under /mnt/c used by both WSL and native Windows) is out of scope.
- **On Linux a reclaimed lock is proved dead; elsewhere it is only waited out.** A holder records its
  pid together with the process start time read from `/proc`, and a waiter reclaims the lock only
  when that recorded start time differs from the one the pid carries now — positive proof the
  original process is gone. Platforms without `/proc` (macOS, Windows) expose no start time to this
  code, so a dead holder whose pid was later reused by an unrelated live process cannot be told apart
  from the holder itself: it classifies `alive-unknown`, acquisition waits out its full budget, and
  then fails with guidance rather than stealing the lock. Age is deliberately NOT used as a
  substitute — it cannot separate a suspended process from a dead one, and that misclassification is
  what resurrected already-erased plaintext once before. The rule is not Linux-specific; only the
  measurement is, so this closes when the start time can be read on those platforms.
- **What erase guarantees:** durable namespace removal by helix's own write paths (compaction
  fsyncs its temp AND the directory; a lock-losing compactor is fenced by orphan-temp sweeps so a
  stale snapshot cannot resurrect erased plaintext). It is NOT media sanitization: freed blocks,
  SSD remapping, filesystem snapshots, external backups/copies (`cp`, `ln`), and already-open file
  descriptors are all outside any userspace design's reach.
- **Hard-linked ledgers are refused:** every write path throws when the ledger's link count is not
  one — two alias names would carry two independent locks (no mutual exclusion) and a compaction
  through one name would leave the other name holding the entire pre-rewrite plaintext.
- **Appends are durable:** every append fsyncs the line before success is reported; a torn tail
  (power cut mid-append) is isolated by the next writer's tail repair and counted by parse health,
  and a complete-but-unacknowledged record commits (at-least-once). The **directory** fsync that
  makes a new file's name durable is attempted on the same path, and splits into two classes on
  **errno alone, never on the message**: if the directory cannot be opened at all, or the fsync call
  itself fails with `EINVAL`/`EISDIR`/`ENOTSUP`/`EOPNOTSUPP`, the platform genuinely cannot fsync a
  directory (some filesystems, and Windows, reject it outright — `ENOTSUP`/`EOPNOTSUPP` are a second
  pair some filesystems return instead of `EINVAL`/`EISDIR`; the same numeric value on Linux but
  distinct symbols elsewhere) and the failure is suppressed — success is still reported, so an
  acknowledged append could, after power loss, be found under a directory entry that never reached
  the platter. Any other failure (`EIO`, `ENOSPC`, and their class) means the fsync was attempted
  and genuinely failed, and now **propagates**: the append itself throws rather than reporting a
  success that isn't true, converting that rare disk-level failure into an availability failure on
  every write path (append, compaction's post-rename fsync, master-key mint, witness advance, orphan
  -tmp sweep) at once — a deliberate trade against silently lying about durability. The audit trail
  (`audit.jsonl`) is the one exception: it is documented best-effort/non-transactional already (see
  its own docstring), and its directory fsync on first creation stays unconditionally suppressed, so a
  disk hiccup on that side channel never reports an already-succeeded operation as failed — or, at a
  rejection site, replaces the real rejection error with an unrelated one on its way out.
  The line's own bytes are unaffected either way.
- **Rollout launch barrier (normative):** old bundles age-steal locks and do not sweep — while any
  old helix-mcp process runs, the new guarantees do not hold. Upgrade procedure: close every Claude
  session, verify no helix-mcp processes remain, reinstall the plugin, then reopen sessions. The
  barrier's unit is a fresh CLI process, not a new conversation: a conversation reset (`/clear`)
  does NOT restart a session's MCP server, which keeps the code image it loaded at startup
  (observed live 2026-07-19: a server outlived a reinstall by hours across `/clear`, while
  per-event hooks — fresh processes — ran the newly installed code immediately).

## Scope / non-goals

The dual-verify echo check is a **verbatim-copy tripwire, not a robust exfiltration
guard** against a host model that transforms content before emitting it. The primary
boundary is the provenance firewall + secret-scan + the DATA-quarantine; the egress
guard and echo tripwire are defense-in-depth.

**The egress guard governs the payload Helix composes — it is not a sandbox around the
Codex CLI.** The CLI is a separate program with its own model and its own connection to
its provider, and `-s read-only` sandboxes its *writes*, not its *reads*. Helix confines
what it can: the subprocess is started in an empty scratch directory, told (`--cd`) to
treat that directory as its working directory, and given a constructed environment
containing only what the CLI needs to authenticate and reach the network — not the
server's own. That removes the automatic exposure of your project directory and your
environment variables. It does not remove the residue: a model that reads an absolute path
it can guess is not stopped by a working directory, and whatever it reads leaves over its
own API connection, where Helix has no visibility at all. Treat enabling dual-verify as
granting a third-party CLI read access to the files your user account can read; if that is
not acceptable, run it under an OS-level sandbox or leave the feature off.

## Handling of sensitive data at rest

- `~/.helix/audit.jsonl` is content-free (enums / IDs / labels only) and is created
  `0o600`. The appender applies that mode at creation and never afterwards, so inside a
  running server a trail loosened from outside stays loosened. A trail that is already
  group- or world-accessible is repaired at the next start instead: the startup pass
  tightens every Helix-owned file in `~/.helix` back to `0o600` and names each one it
  repaired on stderr. It warns rather than refusing, because an over-broad mode is a
  state older versions created and is not by itself evidence of tampering — the
  integrity guarantee does not rest on the mode.
- `~/.helix/codex-log.jsonl` exists only if you opt in (`dualVerify.logContent: true`);
  it stores the exact prompt/response, is created `0o600`, and is capped. A
  firewall-refused payload is never written there.
