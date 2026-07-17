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
  for your explicit approval.
- **Trust states:** `Fresh / Corroborated / Verified / Suspect`, with re-verify-before-use on
  high-blast-radius paths.
- **Secret handling:** memory is secret-scanned and redacted before it is persisted;
  the dual-verify egress guard hard-blocks credential tokens (override-proof — a
  config policy of `allow` cannot release them).
- **Untrusted content** (recalled memory, external-model output) is treated as DATA,
  never instructions: NFKC/control/bidi normalization + per-line datamarking + a
  per-call nonce frame.
- **Local-first:** no telemetry; the only outbound path is the opt-in `helix_dual_verify`
  call, which is off by default and egress-gated.

## Ledger integrity (file surface)

`Corroborated` and `Verified` are conferred **only** by a `verify` record, and every `verify`
record is HMAC-SHA256-authenticated with a key held **only** in `~/.helix` (a 32-byte master,
mode `0600`, never written into the repo ledger; each project signs with its own HKDF subkey).
On replay an elevated grade is honored only if its `verify` record's MAC validates under the
locally-held key, so:

- A forged or hand-edited `verify` record (no MAC, or a MAC that no longer matches) is **ignored**,
  and a forged elevated `assert` is clamped to `Fresh` — minting a top grade by appending raw JSON
  to `.helix/memory.jsonl` no longer works.
- Against an adversary that can write `.helix/memory.jsonl` but **cannot read `~/.helix`**,
  `Corroborated`/`Verified` are **unforgeable at the file/append surface**. This is the same trust
  boundary the ownership registry already relies on.
- **Verification timing is authenticated (MAC v2).** A `verify` record now also binds its system-time
  `tx` into the MAC, so the *timing* of a genuine verification cannot be edited in place. This is
  **authenticity, not accuracy**: it certifies the bytes the signing clock claimed at mint time, not
  that the clock was correct. Pre-existing v1 verifications stay valid but carry an unauthenticated
  (editable) `tx` — timing trust is therefore per-record, and grows only as facts are genuinely
  re-verified. Grade validity never depends on `tx`: a v1 grade survives even if its `tx` is garbage.

**This authenticates the file surface, not the tool surface.** A legitimate `helix_memory_confirm`
call still carries no enforceable human-approval signal, so the guidance above stands: do **not**
allow-list `helix_memory_confirm`.

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
- **Rollback-by-suppression is not detected.** Deleting or truncating a later legitimate `verify`
  to preserve a stale elevated grade is invisible to a per-record MAC. A home-side per-target
  high-water counter that would close this is a registered follow-on.
- **Trust is machine-local.** The signing key never leaves `~/.helix`, so a `Verified` grade does
  not transfer to another machine (e.g. a Windows vs. WSL clone) — elevations signed elsewhere
  replay as `Fresh` until you re-`confirm` on that machine.
- **A `Corroborated` grade can originate from, and be lost to, a non-authoritative source.**
  `recheck`'s mechanical reality-check can raise an `agent-inference`/`user-relayed` record to
  `Corroborated` because the checked evidence (e.g. a file's contents) is plantable by the same
  agent — deliberately so: `Corroborated` is the weaker, mechanical grade, only a `user`-sourced,
  human-approved `confirm` reaches `Verified`, and `requiresReverifyBeforeUse` still flags any
  non-authoritative source regardless of grade. Symmetrically, the supersede guard protects only a
  target that is `Verified` or already has a verifying source, so that same `Corroborated` record
  can still be superseded or evicted by a later Fresh non-authoritative commit; the replacement is
  honestly `Fresh` — no grade is forged — so this is a within-model crowd-out property, not a
  trust-forgery.

## Ledger locking, erasure, and durability boundaries

- **What the lock defends:** accidental concurrency among helix's own processes, OS scheduling
  (suspension is ALIVE, never stolen), and crashes (a provably-dead holder is reclaimed through a
  serialized, per-boot reaper gate). It does not defend against an adversary with code execution,
  and it presumes ONE kernel/boot-id domain on a LOCAL filesystem — a ledger reached from two
  kernels (e.g. a path under /mnt/c used by both WSL and native Windows) is out of scope.
- **What erase guarantees:** durable namespace removal by helix's own write paths (compaction
  fsyncs its temp AND the directory; a lock-losing compactor is fenced by orphan-temp sweeps so a
  stale snapshot cannot resurrect erased plaintext). It is NOT media sanitization: freed blocks,
  SSD remapping, filesystem snapshots, external backups/copies (`cp`, `ln`), and already-open file
  descriptors are all outside any userspace design's reach.
- **Hard-linked ledgers are refused:** every write path throws when the ledger's link count is not
  one — two alias names would carry two independent locks (no mutual exclusion) and a compaction
  through one name would leave the other name holding the entire pre-rewrite plaintext.
- **Appends are durable:** every append fsyncs the line and the directory before success is
  reported; a torn tail (power cut mid-append) is isolated by the next writer's tail repair and
  counted by parse health, and a complete-but-unacknowledged record commits (at-least-once).
- **Rollout launch barrier (normative):** old bundles age-steal locks and do not sweep — while any
  old helix-mcp process runs, the new guarantees do not hold. Upgrade procedure: close every Claude
  session, verify no helix-mcp processes remain, reinstall the plugin, then reopen sessions.

## Scope / non-goals

The dual-verify echo check is a **verbatim-copy tripwire, not a robust exfiltration
guard** against a host model that transforms content before emitting it. The primary
boundary is the provenance firewall + secret-scan + the DATA-quarantine; the egress
guard and echo tripwire are defense-in-depth.

## Handling of sensitive data at rest

- `~/.helix/audit.jsonl` is content-free (enums / IDs / labels only).
- `~/.helix/codex-log.jsonl` exists only if you opt in (`dualVerify.logContent: true`);
  it stores the exact prompt/response, is created `0o600`, and is capped. A
  firewall-refused payload is never written there.
