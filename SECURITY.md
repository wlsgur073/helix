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
  `Verified`; agreement from an external model never does. `Corroborated`/`Verified` are
  **tamper-evident at the file surface** (see *Ledger integrity* below): a forged or hand-edited
  ledger record replays as `Fresh`. The grade is still **not** an enforceable human-approval
  signal at the *tool* surface, so do **not** allow-list `helix_memory_confirm` — it must prompt
  for your explicit approval. The same holds for **`helix_memory_adopt`**, the only other tool that
  moves what Helix trusts on your authority rather than on a mechanical check
  (`helix_memory_recheck` moves grades too, but never above `Corroborated`): adopting a project
  ledger makes everything already in it recallable, and no grade check stands between the adoption
  and the next recall. It names the project root it is adopting so the prompt has something to
  review, and refuses a root that is not the active scope, but neither substitutes for the prompt —
  do **not** allow-list it either. Every adoption made through the tool is recorded in `audit.jsonl`,
  best-effort like every audit row: the row is appended after the adoption lands, so a crash between
  the two leaves the adoption unrecorded, and a failed append returns an error for an adoption that
  nonetheless stands.
- **Trust states:** `Fresh / Corroborated / Verified / Suspect`. Recall and the SessionStart block
  flag an item for re-verification before use — a flag, not a block — whenever its source is not
  `user` (at any grade or blast radius), and when a `user` item is `Suspect` with a blast radius
  other than `read-only`/`local-reversible` (an unset blast radius counts as high). An item whose
  source is `reality-check` — a value the commit tool cannot set, but one a row written straight
  into a ledger can carry — is flagged exactly as a `user` item would be.
- **Secret handling:** memory is secret-scanned before it is persisted, and detected spans are
  redacted — a **syntactically bounded false-positive exclusion, not a promise that a ledger
  contains no secrets**. What is redacted: named provider tokens, `password=`-style heuristic
  matches, and high-entropy tokens, each replaced with `[redacted:<kind>]`. The one write-path
  carve-out: an ENTROPY-ONLY benign word chain (segments individually low-entropy — dated filenames,
  doc paths, note slugs, citations) with no credential keyword within the 40 characters on either
  side of it (a newline, `.` or `;` between the two cuts that window short) is persisted VERBATIM
  (`persistence.releaseWordChains`, default `true`; set `false` to restore unconditional entropy
  redaction); a keyword farther away, even in the same sentence, does not keep it redacted. The
  keyword test also matches inside longer words, so `passed`, `bypass` or `compass` within that
  window keeps the chain redacted, and the window is measured from the ends of the whole
  whitespace-delimited token, so a `.` attached to the chain (a sentence that ends right after a
  path) does not cut it. A
  hex-core entropy token (git SHA / digest shape) always
  redacts on the write path — hex is the native representation of random secret material, and
  persistence cannot tell a git object from a key. This was always an ACCIDENT guarantee, not an
  absolute one: a long pure-alphabetic token (no digit) never matched the entropy detector and is
  persisted verbatim with no exemption involved; the carve-out makes that boundary explicit
  instead of syntactically arbitrary.
  The dual-verify egress guard hard-blocks **named provider credential tokens**
  (override-proof — a config policy of `allow` cannot release them); generic
  heuristic-detected (`password=`-style) and high-entropy secrets are blocked by
  default but are per-leg policy-overridable (`dualVerify.egressPolicy`).
  **One documented exception to "blocked by default":** a high-entropy token whose stripped core is
  pure hex (git SHA / digest) or a chain of individually low-entropy segments (dated filenames, doc
  paths), with no credential keyword within the 40 characters on either side of it (the same window
  as the write-path carve-out above: a newline, `.` or `;` between the two cuts it short, a `.`
  attached to the token does not, and a keyword inside a longer word such as `passed` still counts),
  is RELEASED by default — a false-positive mitigation for design prose: the hex arm for the git SHAs and
  digests quoted in it, the word-chain arm because the entropy leg fired twice on real artifact
  names (dated filenames). It is gated by its own leg,
  `secretEntropyExempt` (default `allow`); set it to `block` to close the exemption.
  The release is applied at the policy layer, so that leg genuinely governs it. The write/egress asymmetry that
  remains by design sits on the HEX arm: egress treats a hex core as exempt-shaped
  (releasable under `secretEntropyExempt`), while the write path always redacts it;
  the word-chain arm is symmetric — released on both paths, each under its own key
  (`secretEntropyExempt` for egress, `persistence.releaseWordChains` for the write
  path), with the same shared `nearCredential` keyword-window guard on both.
  A trailing source-citation line reference (`path/to/file.ts:112`, `:44-45`, `:45:7`)
  is removed before the chain test, so a code pointer is judged on its path. The removal
  is conditional on the prefix being file-shaped (a dot plus a 1–5 character alphanumeric
  extension that begins with a letter) with each number at most five digits — a word-labelled
  numeric value such as
  `backup.recovery.identifier:593821` is **not** a citation and stays in the net, as does
  an interior `label:<secret>` pair. The residual limit, stated plainly: a token
  syntactically indistinguishable from a citation is released, and no local test can
  separate the two.
- **The egress scan fails closed on size, and the caps are hard.** A payload whose raw or
  outbound form exceeds **200,000 characters**, or live memory whose content totals more than
  **8,000,000 characters** (every record the recall view serves, global plus an adopted project;
  erased and superseded rows do not count), is REFUSED unscanned rather than sent — the decision is
  `blocked` with `decidedBy: 'scan_limit'`. No policy key releases either cap; they sit
  upstream of `dualVerify.egressPolicy` entirely. The direction is deliberate: an
  adversary who can grow the ledger can therefore cause **availability** loss on
  dual-verify, which is far cheaper than unbounded scanning of adversary-sized input.
  Nothing bounds a legitimate corpus below that cap — 489 facts at the 16,384-character content
  limit already exceed it — so a user whose corpus does grow past it sees every dual-verify call
  refused. Each call the cap refuses names that cause in its reply (`ledger exceeds the egress scan
  limit`); a call stopped earlier — by input validation, the enabled gate, the stakes floor, or a
  payload over the 200,000-character cap — names that stop instead. README's dual-verify notes state
  the same refusal.
- **Untrusted content** (recalled memory, external-model output) is treated as DATA,
  never instructions: NFKC/control/bidi normalization + per-line datamarking + a
  per-call nonce frame.
- **Local-first:** no telemetry. The only path that sends memory or conversation content off the
  machine is the opt-in `helix_dual_verify` call, which is off by default and egress-gated.
  `helix_codex_status` is not behind that opt-in and sends no Helix content, but when no
  `dualVerify.model` is set and the Codex CLI reports a login it runs the CLI's `codex doctor
  --json`, whose network checks contact the provider's endpoints and, for a latest-version check,
  GitHub's API (`chatgpt.com`, `api.openai.com` and `api.github.com`, measured on codex-cli
  0.154.0).

## Ledger integrity (file surface)

`Corroborated` and `Verified` are conferred **only** by a `verify` record, and every `verify`
record that confers one is HMAC-SHA256-authenticated with a key held **only** in `~/.helix` (a
32-byte master, mode `0600`, never written into the repo ledger; each project signs with its own
HKDF subkey); the unsigned, target-less `verify`-shaped markers and fences a rewrite writes confer
nothing.
That location is the home directory itself — `HELIX_HOME` when set — and it is **not** derived from
where the ledger happens to be: pointing `HELIX_LEDGER` into a repository moves the data file and
nothing else. When trust-store files are found beside a relocated ledger — a layout that a
pre-release build wrote for every `HELIX_LEDGER` user, and that a hand-assembled setup or a
repo-writing adversary can also produce — the server measures whether starting would lose a grade
this ledger currently carries, and refuses to start unless that measurement completes and finds
nothing at risk, rather than minting a second key over the top of them; only then does it start,
printing a note naming the leftover files. The measurement errs toward refusing: any `verify` that
fails under `HELIX_HOME`'s key (content-free markers aside) and any fact row with a baked
non-`Fresh` state count as a loss even when replay already reads that row as `Fresh`, and a
`HELIX_HOME` master key or a ledger that cannot be read refuses with no measurement at all.
Refusing on the layout alone was a denial of service, since one planted, shape-valid file could stop
every session on an install with nothing at risk; with the measurement, the same adversary also
needs to write one forged `verify` or baked-state row into the relocated ledger, or make that ledger
unreadable, to cause a refusal.
On replay an elevated grade is honored only if its `verify` record's MAC validates under the
locally-held key, so:

- A forged or hand-edited `verify` record (no MAC, or a MAC that no longer matches) is **ignored**,
  and a forged elevated `assert` is clamped to `Fresh` — minting a top grade by appending raw JSON
  to `.helix/memory.jsonl` does not work.
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
  afterwards. An elevated `verify` is refused under a `mismatch` verdict, before anything is
  appended, so the alarm survives to be investigated rather than written over. The refusal is
  narrow: ordinary commits, soft erases, and reality-check **demotions** still land, because a scope
  under suspicion must stay able to record that something failed. Note what this does *not* claim:
  it stops Helix from being used as the signer, not an adversary who already holds the master key.
- **The content binding is injective.** The digest a `verify` signs is taken over an encoding that
  distinguishes every JS string, including ill-formed ones. Plain UTF-8 does not: it replaces every
  lone surrogate with U+FFFD, so unboundedly many distinct contents — including well-formed ones —
  shared a digest and could be substituted under a signed grade. Well-formed content hashes exactly
  as before, so every previously signed `verify` over well-formed content still applies; a
  previously signed promotion over ill-formed content no longer matches and confers nothing, while a
  previously signed `Suspect` demotion over it still applies, since only a promotion is checked
  against the content digest.
- **Verification timing is authenticated (MAC v2 — the ledger record format's second version, which
  has nothing to do with the recall pilot's protocol v2 under `docs/release/`).** A `verify` record
  binds its system-time `tx` into the MAC, so the *timing* of a genuine verification cannot be edited in place. This is
  **authenticity, not accuracy**: it certifies the bytes the signing clock claimed at mint time, not
  that the clock was correct. Pre-existing v1 verifications stay valid but carry an unauthenticated
  (editable) `tx` — timing trust is therefore per-record, and grows only as facts are genuinely
  re-verified. Grade validity never depends on the *value* of `tx`:
  a v1 grade survives any string `tx`, even garbage, and a v2 grade is lost only because editing its
  `tx` breaks the MAC (a `tx` that is not a string at all fails the ledger's parse guard, so that
  row is skipped and its grade with it).
  **Point-in-time membership does depend on it**, and that is the one place an editable v1 `tx`
  still buys something: `helix_memory_inspect`'s `asOf` argument selects rows by raw `tx`, so a byte-copy of a v1 verify with its
  `tx` moved back is a valid verify inside a past window. Fact-id ownership is therefore resolved
  over the whole ledger *before* the window is applied — otherwise a duplicate dated into the past
  would be the only claimant of its id there, with nothing left to arbitrate against.

**This authenticates the file surface, not the tool surface.** A legitimate `helix_memory_confirm`
call still carries no enforceable human-approval signal, so the guidance above stands: do **not**
allow-list `helix_memory_confirm`, and do **not** allow-list `helix_memory_adopt`.

### Compaction integrity/horizon markers — clearing a planted marker is an operator procedure

A compaction mints a content-free, **unsigned** `integrity_marker` when it drops one or more forged
`verify` records, and a `horizon_marker` when it drops closed fact history — coalesced to a single
canonical row per kind (constant id, sentinel timestamp; see `canonicalMarker` in
`src/memory/ledger.ts`). Once minted, either marker is a **durable fixpoint by design**: every later
compaction re-mints the byte-identical row rather than dropping it, so a genuine forgery-audit signal
cannot silently age out.

The marker's **presence is forgeable**: it carries no MAC, so a ledger-write adversary who appends a
marker-shaped row — a `verify` with a null target and no MAC — whose id starts with `integrity_` or
`horizon_` mints the canonical marker whether or not a real incident occurred. Treat it as an audit
*signal* to investigate, not a proof.

**Clearing a planted marker requires an out-of-band, permanent erase of its canonical id** —
`store.erase('integrity_marker', { permanent: true })` (or `'horizon_marker'`), which drops the
marker from that rewrite (`erasedIds` in `planCompaction`/`compactLedger`); a later compaction mints
it again only on a new trigger — another dropped forged `verify`, another planted marker-shaped row,
or, for `horizon_marker`, more dropped closed history. This is **deliberately unreachable from the
MCP tool surface**: `helix_memory_erase`'s schema is `{id}` only — it is always soft (a tombstone
for a live record, and nothing at all, still reported as `erased`, for an id that names no live
record, a marker included; when the global ledger and an adopted project both hold rows the id names
and either both or neither hold a record row with that id, as with any `witness_fence_` id once each
ledger has been rewritten, it writes nothing and returns an `id present in more than one scope`
error instead), and it can never pass `permanent: true`. So a
prompt-injected agent cannot reach this path and cannot destroy a genuine forgery-audit signal; only
an operator running code outside the agent's conversation (a script or REPL against `MemoryStore`)
can.

**Marker-erase routing; general non-live-id fallback (narrower residual).** A permanent erase
of an adopted *project* ledger's planted marker does not risk landing on the global ledger — a
project that is not adopted is never a candidate, so there `scope: 'project'` is refused and a
no-scope erase acts on the global ledger whenever it holds a marker of that family: `erase()` resolves
its target through `resolveEraseTarget`, which decides what an id names from the parsed rows rather
than from the id alone. A row counts as a marker only when it is marker-shaped (`markerFamilyOf` over
the record), so a non-marker row carrying the exact id is erased as a record even when that id wears
a marker prefix, and an id carried by both a marker row and a record is never refused on that
account: a soft erase tombstones the record, and a permanent erase purges every row carrying the id.
The `scope` parameter (`erase(id, { permanent: true, scope: 'project' })`) lets a caller pin the
ledger explicitly. Committed probes cover both halves: a project-ledger marker's permanent erase with
`scope: 'project'` empties it from that ledger, not global
(`test/memory/provenance-audit/marker-erase-routing.test.ts`), and a live row wearing a marker
prefix, or sharing its id with a marker row, resolves as described here
(`test/memory/erase-marker-shape.test.ts`).

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
  and can mint valid MACs; no locally-held key is safe from it. A readable home trust store (broad
  permissions, a shared host) — the key together with `projects.json`, which holds the per-scope
  nonce every `verify`-signing subkey is derived from — is a **security downgrade equivalent to that
  out-of-model adversary**: the file-surface guarantee is then void and all grades become forgeable.
- **Unconfined-agent deployments void the model by construction.** Granting an agent an
  allow-listed runtime (e.g. `node`) plus filesystem read of `~/.helix` IS the arbitrary-home-read
  adversary above: in such a deployment (the maintainer's own dogfood box included)
  `Corroborated`/`Verified` are forgeable and the file-surface guarantee does not apply. Accepted
  and documented; confine the agent or isolate the key to restore the boundary.
- **Rollback-by-suppression is not detected by the per-record MAC alone.** Deleting or truncating
  a later legitimate `verify` to preserve a stale elevated grade is invisible to a per-record MAC
  in isolation. A home-side, per-scope high-water witness closes this for a boundary-writable,
  git-tracked ledger, as for every other ledger scope; see *Rollback witness* below for what it
  catches and its own residual bounds (a whole-home coordinated rollback is still undetectable
  locally).
- **Trust is local to one trust store and, for a project ledger, to one project path.** The signing
  key never leaves `~/.helix`, and each project's subkey is also bound to the path it was adopted at,
  so elevations do not transfer to another machine (e.g. a Windows vs. WSL clone), to a second
  `HELIX_HOME` on the same one, or to the same project moved or cloned to another path — signed
  elsewhere, they replay as `Fresh` until they are earned again there: re-`confirm` a `Verified`
  fact, and re-run `recheck` for a `Corroborated` one (`confirm` refuses any record not committed as
  `source=user`).
- **A `Corroborated` grade can originate from, and be lost to, a non-authoritative source.**
  `recheck`'s mechanical reality-check can raise an `agent-inference`/`agent-test-verified`/`user-relayed` record to
  `Corroborated` because the checked evidence (e.g. a file's contents) is plantable by the same
  agent — deliberately so: `Corroborated` is the weaker, mechanical grade, only `confirm` on a
  `user`-sourced record reaches `Verified` (the human approval behind that call comes from the
  tool-approval prompt; Helix does not check for it), and `requiresReverifyBeforeUse` still flags any
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
  for) cannot pay it. It applies only to `Verified` targets, whose `state` is MAC-covered (as every
  signed grade's is — `Corroborated` too, which this check leaves unguarded), so it sits on the
  authenticated boundary and does not tax ordinary `Fresh` updates.
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
  front of you. It must never drive a **durable trust-state** decision, and it does not: the demotion
  guard reads only the authenticated `Verified` grade, so an item merely *claiming* `source=user`
  buys no immunity from a determinate reality-check failure — it is demoted to `Suspect` like any
  other. Two refusals still turn on the declared source, and are defence-in-depth rather than
  mechanisms: the supersede guard, which any caller declaring `source=user` passes and no setting
  changes (the proof-of-read check above reads no `source` and holds whatever the configuration),
  and `confirm`'s eligibility check, a configuration-dependent control — only as strong as the
  tool-approval prompt above it, per the trust-model note on not allow-listing
  `helix_memory_confirm`.

## Rollback witness (cross-boundary ledger rollback)

Ledger integrity (above) authenticates individual records; it does not by itself detect a ledger
*regressing*. A project ledger that lives in a boundary-writable, git-tracked tree (for example, a
repo that tracks `.helix/memory.jsonl`) can be checked out, restored, or reset to an earlier state
while every other copy of the world still remembers the newer one — silently, with no MAC
violation, because the restored file is itself a completely legitimate, correctly-signed past
state. A home-side **rollback witness** (`~/.helix/witness.json`, one MAC'd entry per ledger scope,
signed with the same master key as `verify` records under its own domain) closes this gap: it
lives on the trusted side of the boundary the ledger-HMAC threat model already assumes an
adversary cannot read or write, so a ledger's current bytes are checked against it on every read that serves memory (recall,
inspect, the SessionStart hook); the store's write-path target lookups (supersede, erase, `confirm`,
`recheck`) read without it, and each write they lead to is witness-gated on its own.

- **Authority.** A detected mismatch — a current ledger that has forked from or fallen behind its
  witnessed head while no rewrite is pending, or, while a rewrite opened over that head is still
  pending, one carrying neither that head nor the rewrite's result as a prefix — clamps that scope's
  `Verified`/`Corroborated` grades to `Fresh` on every live projection (recall, inspect, the
  SessionStart hook) and renders a constant, trusted disclosure note outside the DATA frame. This
  is armed from the first release, not opt-in.
- **Serve-with-note.** A mismatched scope is not blacked out: its rows keep being served (with the
  note, and with elevated grades clamped) and new appends keep landing (except an elevated `verify` — a `confirm` or a passing
  `recheck` — which is refused before anything is written), but the witness itself
  never advances over a mismatch. Only an explicit re-baseline (below) clears the signal, so the
  very next ordinary append after a rollback can never silently launder the alarm away. (A
  separate, narrower state — a ledger rewrite caught mid-transition whose bytes are not exactly the
  rewrite's result — always excludes reads and blocks appends for that scope until resolved,
  independent of this policy; a rewrite whose bytes had already landed whole is served normally and
  is completed by the next write or server start. A *rewrite* is still
  permitted there, because re-driving an interrupted transition is how that state is meant to
  resolve. So that this does not become a second laundering route, the mid-transition state is
  itself discriminated: a pending transition records the bytes it would produce and, when the scope
  had a witnessed head, the head it opened over, and a ledger carrying NEITHER as a prefix is neither
  the before nor the after. It is classified a mismatch, not an interruption, and the rewrite is
  refused. A transition opened with no witnessed head records no predecessor, so under it any ledger
  other than its exact result stays an interruption, and a rewrite over it is permitted.)
- **Fenced current-head-only witness, user-only ceremony.** The witness keeps only each scope's
  live head, never a history of erased-era bytes, kept honest by a content-free marker row planted
  at the end of every legitimate rewrite (compaction, erase, an authorized re-baseline) — so a
  restored old-era file can never pass as a benign extension of the current one. The only
  sanctioned way to re-bless a mismatched scope is `bin/helix-rebaseline.mjs`, an interactive,
  TTY-only CLI that displays the scope, byte hash, and target epoch, requires a typed
  confirmation, and holds the ledger lock from that display through the commit. It is deliberately
  **not** an MCP tool: no agent-suppliable parameter can invoke it, and nothing invokes it
  automatically.

Note: because the witness is signed, a witnessed append materializes the master signing key
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
  all trust-on-first-use: each is an honest, fail-open re-initialization, adopted by the next write
  to that scope. Every recall, inspect or SessionStart read of that scope before that write carries
  the same constant first-contact disclosure note, which does not say which of the four occurred; a
  write that comes first adopts the current head with no note.
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
- The availability effect of a forced witness state is contained to its scope, with one layout
  exception: when `HELIX_LEDGER` is relocated outside `HELIX_HOME`, a writer of the ledger's
  directory who plants one trust-store-shaped file beside the ledger and forces a global mismatch
  over elevated grades makes the server refuse to start, and the same planted file does so without
  any mismatch when the ledger holds one `verify` that fails under `HELIX_HOME`'s key (content-free
  markers aside) or one fact row with a baked non-`Fresh` state, or cannot be read. The MCP server
  then stays down for every scope (the SessionStart hook still loads memory read-only) until the
  planted file is removed; re-baselining the global scope also lifts the refusal, but only when the
  mismatch is its sole cause. Otherwise, forcing a mismatch and forcing a caught-mid-rewrite state both require
  boundary write access, though they are not the identical capability. Recovery from an interrupted
  rewrite is normally automatic at the next server start (below), or else an operator re-drive of
  the interrupted rewrite through the store API, which the rewrite gate permits; no MCP tool
  re-drives one — the erase tool is soft-only, and auto-compaction skips a scope whose transition is
  pending. A rewrite that was interrupted BEFORE its bytes landed is retracted at the next server
  start, provided its journal recorded the head it opened over and did not supersede an earlier
  unresolved transition: the scope is left
  holding exactly the bytes already on disk, which is both the pre-rewrite state and what a
  deliberate rollback to those bytes asked for, so retraction never re-drives anything a rollback
  removed. Startup does not retract an interruption whose ledger is on the post-rewrite lineage
  (whether or not it also carries the pre-rewrite one), one with no predecessor to compare against,
  or one whose journal superseded an earlier unresolved transition: those stay pending, and that
  scope stays dark until an operator clears it, either with the re-baseline ceremony or with the
  store-API re-drive above. A ledger forked off both lineages is not among them:
  it is classified a mismatch, not an interruption, so its rows keep being served with the mismatch
  note and clamped grades and ordinary appends keep landing; elevated verifies and rewrites are
  refused, a restart clears neither the alarm nor the pending journal, and the same ceremony
  re-baselines it.

## Ambiguous re-adoption and the trust-resolution ceremony

A project's ownership stamp decides whether its home registry entry applies at all — and that entry
carries the per-scope nonce that derives the subkey verifying the project's ledger — so the stamp is
part of the trust boundary rather than bookkeeping beside it. Preserving a stamp's nonce
across a re-adoption is convenient and, on its own, non-destructive — but it is still a decision
about whose trust applies to rows that may be restored *later*, which is why a present-row count
cannot settle it.

**When continuity is ambiguous, Helix decides neither way.** If a path is already registered but its
stamp is missing or invalid, the scope enters a reversible `trust-pending` state and every prior
verification there reads as `Fresh` until a human resolves it. No ledger row is deleted or
rewritten — the re-adoption writes only the repo-side stamp (restoring the registered value over a
missing or mismatched one) and the pending flag in `projects.json`; the grades come back if the
resolution says they should.

Resolution is a **separate ceremony**, deliberately not folded into the rollback re-baseline — a
witness nonce and a trust nonce are unrelated, and one operator gesture must not silently answer both
questions:

```bash
node bin/helix-trust-resolve.mjs --scope <absoluteProjectRoot> --repair   # keep the nonce
node bin/helix-trust-resolve.mjs --scope <absoluteProjectRoot> --fresh    # rotate it
```

- It **requires an interactive terminal** and prompts before acting; declining changes nothing.
- It refuses a scope that is not `trust-pending`, so it cannot be used to re-key a healthy project.
- `--repair` keeps the existing trust nonce, and the scope's rows return to their stored grades.
- `--fresh` rotates the nonce. Rows signed under the old one **stay `Fresh` rather than being
  deleted**: compaction may drop a verification of a still-live fact only when the resolved key
  proves a single lineage (a verification whose fact was erased or superseded is dropped with its
  fact, key or no key), and after a rotation it cannot, so rotation is non-destructive on both the read and compaction
  paths.
- It is **not** an MCP tool. No MCP tool parameter reaches it, and nothing invokes it
  automatically. Like the re-baseline ceremony, its terminal gate proves interface shape, not human
  presence: an agent that can drive a shell can run it under a pty and type the confirmation.

**Residual.** This closes the conferral path where a re-adopted path silently inherits trust for rows
dropped back afterwards. It does not make ownership authenticated against an adversary who can write
`~/.helix` itself — that is the same machine-local boundary the rest of this document describes.

## Ledger locking, erasure, and durability boundaries

- **What the lock defends:** accidental concurrency among helix's own processes, OS scheduling
  (suspension is ALIVE, never stolen), and crashes (a provably-dead holder is reclaimed through a
  serialized reaper gate, named per boot where the platform exposes a boot id — Linux; on macOS and
  Windows one gate name serves every boot, so a reaper that crashed inside the gate blocks automatic
  reclaim of that lock until the gate file is removed by hand). It does not defend against an
  adversary with code execution, and it presumes ONE kernel/boot-id domain and ONE Linux time
  namespace on a LOCAL filesystem — a ledger reached from two kernels (e.g. a path under /mnt/c used
  by both WSL and native Windows), or by processes in different time namespaces (which read
  different uptimes within one boot), is out of scope.
- **On Linux, between processes that share one boot id and one time namespace, a lock is reclaimed
  only after its holder is proved dead, and a reused pid does not prevent that proof; on Windows and
  macOS a holder is proved dead whenever its recorded pid is no longer in use, but while that pid
  belongs to another live process the holder is proved dead on Windows only across a reboot and
  never on macOS.** A holder records its pid together with the process start time read
  from `/proc`, and a waiter reclaims the lock when that recorded start time differs from the one the
  pid carries now — positive proof the original process is gone. That proof, and the uptime
  comparison described below, hold only inside one time namespace: Linux reports both a process's
  start time and the system uptime through the reading process's time namespace, so a holder and a
  waiter in namespaces with different boot-time offsets disagree on both values, and a waiter that
  shares the holder's pid namespace proves the live holder dead and takes its lock (a waiter in a
  different pid namespace classifies the holder `alive-unknown` and waits instead). Platforms without `/proc` (macOS,
  Windows) expose no start time, so a dead holder whose pid is reused *within the same boot* by an
  unrelated live process still classifies `alive-unknown` there: acquisition waits out its full
  budget, then fails with guidance rather than stealing the lock. Windows closes the *cross-boot*
  half of that gap by a second, independent measurement: a holder also records system uptime at
  acquisition, and a waiter sampling a strictly lower uptime has proof the machine has rebooted since
  — a process cannot outlive a reboot — so the lock is reclaimed without needing a start time. macOS
  has no counterpart measurement and is unchanged. Age is deliberately NOT used as a substitute — it
  cannot separate a suspended process from a dead one, and that misclassification is what resurrected
  already-erased plaintext once before. The remaining same-boot gap is not Linux-specific in its
  rule, only its measurement, and closes wherever a start time becomes readable.
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
  **errno alone, never on the message**: if the `open` fails with
  `EINVAL`/`EISDIR`/`ENOTSUP`/`EOPNOTSUPP`/`EPERM`/`EACCES`, or the fsync call fails with one of the
  same codes, the failure is treated as the platform or the directory's standing permissions being
  unable to fsync a directory (some filesystems reject it outright —
  `ENOTSUP`/`EOPNOTSUPP` are a second pair some filesystems return instead of `EINVAL`/`EISDIR`;
  they share one numeric value on Linux, where Node reports it as `ENOTSUP`, but Node has no
  `EOPNOTSUPP` code at all, so on a platform where the two values differ an `EOPNOTSUPP` failure
  reaches Helix under another code and propagates; `EPERM`/`EACCES` on the `open`
  are a standing environment fact rather than an I/O fault, and they are suppressed on the fsync call
  too as a deliberate over-inclusion that errs toward the previously shipped silent-loss behaviour
  rather than toward making memory unusable), and the failure is suppressed — success is still
  reported, so an acknowledged append could, after power loss, be found under a directory entry that
  never reached the platter. On Windows the directory opens for reading, but fsync on that read-only
  handle is refused (`EPERM`, already in the suppressed class), and Windows stays wholesale
  best-effort on the same path. Any other failure on either leg (`EIO`, `ENOSPC`, `EMFILE`, `ENOENT`
  and their class) means the attempt was real and genuinely failed, and **propagates**: the append itself throws rather than reporting a
  success that isn't true, converting that rare disk-level failure into an availability failure on
  every write path (append, compaction's post-rename fsync, master-key mint, witness advance, orphan-tmp
  sweep) at once — a deliberate trade against silently lying about durability. There are two
  exceptions. The trust registry's atomic writes (`projects.json` in the home and the repo-side
  `.helix/.owner` stamp) swallow every failure of their directory fsync, on the `open` leg and the
  fsync leg alike and whatever the errno, `EIO`, `ENOSPC`, `EMFILE` and `ENOENT` included: a trust
  resolution (`helix-trust-resolve`) reports success over such a failure, and so does the first
  `@global` scope-nonce mint, which a read such as a recall or the SessionStart hook can perform, and
  so does an adopt whenever the signing key already exists or only the repo-side `.helix` directory
  fails (a first adoption in a home with no key reports the failure only because the key mint that
  follows it propagates, after the registry entry and `.owner` are already written). The audit trail
  (`audit.jsonl`) is the other: it is documented best-effort/non-transactional already (see its own
  docstring), and its directory fsync — attempted on every append, not only on the one that creates
  the file — stays unconditionally suppressed, so a failed directory fsync on that side channel never
  reports an already-succeeded operation as failed — or, at a rejection site, replaces the real
  rejection error with an unrelated one on its way out. The suppression covers the directory fsync
  only: the line's own open, write and fsync still propagate, so a failure there (`ENOSPC`, `EIO`)
  makes the handler throw after its operation already succeeded, and at a rejection site replaces
  the rejection error.
- **Rollout launch barrier (normative):** old bundles age-steal locks and do not sweep — while any
  old helix-mcp process runs, the new guarantees do not hold. Upgrade procedure: close every Claude
  session and pause anything that starts one on a schedule (for example a timer running
  `claude -p`), verify no helix-mcp processes remain, reinstall the plugin at EVERY scope it is
  installed in (`claude plugin uninstall` acts on the user scope only; a local-scope entry is
  uninstalled and reinstalled from its project root with `--scope local` — see
  `docs/release/deploy-runbook.md`), confirm that every `helix@helix` entry's `gitCommitSha` in
  `installed_plugins.json` is the new one, then reopen sessions. The
  barrier's unit is a fresh CLI process, not a new conversation: a conversation reset (`/clear`)
  does NOT restart a session's MCP server, which keeps the code image it loaded at startup
  (observed live 2026-07-19: a server outlived a reinstall by hours across `/clear`, while
  per-event hooks — fresh processes — ran the newly installed code immediately).

## Scope / non-goals

The dual-verify echo check is a **verbatim-copy tripwire, not a robust exfiltration
guard** against a host model that transforms content before emitting it. The primary
boundary is the provenance firewall + secret-scan + the DATA-quarantine; the egress
guard and echo tripwire are defense-in-depth. With `quotedMemory` proof-of-read exemptions, a
NON-transforming host that can read the ledger can also pass the tripwire by declaring what it
quotes — the ability to earn an exemption is exactly the ability to read, so the tripwire catches
UNDECLARED verbatim copies of a live memory (one the recall view serves: global, plus an adopted
project) that share a run of at least 24 characters with it, compared after NFKC, deletion of
control and format characters, lower-casing and whitespace collapsing. Tabs and line breaks are
deleted rather than collapsed, so a copy with a line break or tab where the memory has a space (or
the reverse) splits the run there; a memory whose normalized text is shorter than 24 characters is
never matched; a shared run shorter than that passes; and a superseded or erased memory is not
compared at all, even while its text is still in the ledger file.

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

- `~/.helix/audit.jsonl` is content-free — Helix never writes memory text, a prompt or response,
  or a matched span to it; a row carries a timestamp, enums, booleans, labels (some with counts),
  ids and, on an adopt row, the adopted project root's path, and an id is recorded as the caller
  gave it (up to 128 printable characters, even when no record has that id) — and is created
  `0o600`. The appender applies that mode at creation and never afterwards, so inside a
  running server a trail loosened from outside stays loosened. A trail that is already
  group- or world-accessible is repaired at the next start instead: the startup pass
  tightens every Helix-owned file in `~/.helix` back to `0o600` and names each one it
  repaired on stderr. It warns rather than refusing, because an over-broad mode is a
  state an interrupted copy or an external tool can leave behind and is not by itself
  evidence of tampering — the MAC check never consults a file's mode, so a forged or edited
  record replays as `Fresh` either way. The repair does not restore trust, though: that guarantee
  assumes no other account could read or write `~/.helix` — an account that can only write there can
  swap in its own signing key and `projects.json` and add rows to the ledger that then replay as
  `Verified` — which a loose mode may already have broken, and `audit.jsonl` carries no MAC, so its
  integrity rests on the permissions of the file and of `~/.helix` alone.
- `~/.helix/codex-log.jsonl` is created only if you opt in (`dualVerify.logContent: true`), and
  turning the option off later stops new entries once the MCP server restarts — a server that is
  already running keeps the value it loaded at startup and goes on logging — without deleting the
  file or what it already holds; it stores the exact prompt/response, is created `0o600`, and is
  capped. A
  firewall-refused payload is never written there.
