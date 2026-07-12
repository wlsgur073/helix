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

**Known routing caveat (registered follow-up, not fixed).** `store.ts`'s `ledgerOf(id)` falls back to
the GLOBAL ledger for any id absent from both live projections, and a marker is never in the live
projection (it is a verify-shaped tombstone with a null target) — so a permanent erase of a *project*
ledger's planted marker can route to the global ledger instead of the ledger that actually holds it.
Before erasing, confirm which ledger file the marker physically lives in (read the ledger JSONL
directly, or `helix_memory_inspect`) rather than trusting `ledgerOf`'s fallback.

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
