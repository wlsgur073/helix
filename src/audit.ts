import { mkdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeAll, realFsOps, fsyncDir } from './memory/fs-ops.js';
import type { EgressLeg } from './config.js';
import type { GateName } from './verify/dual-verify.js';
import { ensureHelixDir } from './memory/home-permissions.js';

/** Schema note (append-only history): `decidedLeg` replaces the mis-named `blockedLeg` (an
 *  `allowed_override` used to write its DECIDER into a field literally called `blockedLeg`,
 *  claiming a released leg was blocked). Rows written before this change carry `blockedLeg`
 *  instead of `decidedLeg` with the same coarse-`Leg` values; audit.jsonl is append-only, so
 *  those old rows are NEVER migrated — a reader must accept EITHER key as the decider field. */
export interface DualVerifyAudit {
  kind: 'dual-verify';
  ts: string;
  enabled: boolean;
  /** True when a real (metered) Codex call was attempted. */
  spawned: boolean;
  mode?: 'compare' | 'critique';
  verdict?: 'agree' | 'diverge' | 'indeterminate';
  reason?: string;
  // --- egress guard fields (2b): enum / ID / policy-key only — NEVER a matched span, secret, PII value,
  // or memory snippet. Both blocked AND allowed-override events are logged. ---
  egressDecision?: 'pass' | 'blocked' | 'allowed_override';
  decidedLeg?: 'secret' | 'pii' | 'memory_echo';                       // the coarse leg that DECIDED (renamed from blockedLeg)
  // Was a hand-copied union of the same five keys, which silently went stale the moment a sixth leg
  // existed. Sourced from EgressLeg so the audit schema cannot drift from the policy it records.
  releasedLegs?: EgressLeg[];                                          // policy keys a policy released
  piiKinds?: Array<'email' | 'phone' | 'credit_card' | 'national_id'>; // labels, never values
  echoMemoryIds?: string[];                                            // ledger IDs, never text
  /** H7: the guard that ended the call (`enabled` / `stakesFloor` / `egress` / `available` /
   *  `runner`), sourced from GateName so this schema cannot drift from the chain it records. Absent
   *  on a call that ran. It exists so a reader of this ledger reconstructs the gate ORDER from data
   *  rather than from refusal wording -- the inference that took the dogfood channel three weeks and
   *  landed on the reverse of the truth. */
  stoppedGate?: GateName;
}

/** Erase audit (F1): every helix_memory_erase is recorded — best-effort (the fsync'd row is appended
 *  after the fsync'd erase, so a crash in the narrow gap can miss it; see appendAudit) — so a
 *  poisoned/erroneous erase that suppresses an authoritative fact is detectable in audit.jsonl. The MCP tool is soft-only
 *  (`soft: true`); `soft: false` marks the out-of-band permanent/compaction path. Content-free
 *  by design — only the id is recorded, never the erased text. LEAD-AUDIT-ID-UNCONSTRAINED: `id` used
 *  to be an unbounded string written here VERBATIM even when it matched no record (erase() is a
 *  no-op, not a throw, for an absent id) — an attacker-chosen id of unbounded length/bytes could ride
 *  this "content-free" field. `id` is now bounded (length + charset) before this event is ever
 *  constructed: handlers.ts's `assertValidId` guards every caller of this interface, mirrored at the
 *  MCP boundary by helix-server.ts's `ID_SCHEMA`. */
export interface EraseAudit {
  kind: 'erase';
  ts: string;
  id: string;
  soft: boolean; // true = tombstone-only (recoverable); false = physical compaction (right-to-erasure)
}

/** Verify audit (two-tier trust ladder): every trust transition attempt (recheck / confirm) is
 *  recorded — including rejected and contested outcomes — best-effort (the fsync'd row is written
 *  after the fsync'd transition; see appendAudit) — so a poisoned/erroneous promotion or a
 *  silently-dropped corroboration is detectable in audit.jsonl. Content-free by design: ids /
 *  enums / booleans ONLY, NEVER a matched span, file path, or check pattern. `outcome` is an INLINE
 *  shape (not firewall's VerifyOutcome) to keep audit decoupled from the check engine.
 *  LEAD-AUDIT-ID-UNCONSTRAINED: the REJECTED branch (recheck/confirm target-not-found or unbound)
 *  is the sharp case — it audits BEFORE re-throwing, so a garbage id would otherwise be logged on
 *  every single failed lookup. `id` is bounded (length + charset) before either handler's try block
 *  runs: see handlers.ts's `assertValidId` / helix-server.ts's `ID_SCHEMA`. */
export interface VerifyAudit {
  kind: 'verify';
  ts: string;
  id: string;
  source: 'reality-check' | 'user';
  resultState: 'Corroborated' | 'Verified' | 'Suspect' | 'no-change' | 'contested' | 'rejected';
  checkKind?: 'file-contains' | 'file-exists';
  bound?: boolean;
  outcome?: { ran: boolean; indeterminate: boolean; passed: boolean };
}

/** Adopt audit: every helix_memory_adopt is recorded — best-effort, like the others. Adoption is one
 *  of only two operations that move what Helix trusts (confirm is the other), and it was previously
 *  the only one that left no trace at all: a foreign project ledger became trusted with nothing in
 *  audit.jsonl to show for it. `scope` is the canonical project root — an IDENTITY, not content. It
 *  discloses nothing that `projects.json` beside it does not already hold, and the content-free rule
 *  this file keeps is about memory text, which never appears here. */
export interface AdoptAudit {
  kind: 'adopt';
  ts: string;
  scope: string;
}

export type AuditEvent = DualVerifyAudit | EraseAudit | VerifyAudit | AdoptAudit;

/** Append one audit event as a JSONL line, fsync'd so a written row survives power loss. Creates
 *  parent dirs as needed. Completeness is best-effort, NOT transactional: the row is appended AFTER
 *  the action it records (the erase/verify, itself fsynced), so a crash in the narrow window between
 *  the two can leave the action durable with its audit row absent. Durable-once-written: the row bytes
 *  are fsync'd, and on FIRST creation the parent directory is fsync'd too, so the new file's directory
 *  entry is durable — not just its inode (a crash could otherwise lose the whole freshly-created file).
 *
 *  The directory fsync is swallowed UNCONDITIONALLY here — narrower than fs-ops.ts's own fsyncDir
 *  contract (task 7), which now propagates a genuinely failed attempt. No caller (handlers.ts) wraps
 *  this call, and by the time it runs every caller has already COMPLETED its primary operation — not
 *  always successfully. Four of seven call sites — handlers.ts `handleErase`, `handleAdopt`, and the
 *  post-success appends in `handleRecheck` and `handleConfirm` — run it after a SUCCEEDED operation;
 *  two — the appends in `handleRecheck`'s and `handleConfirm`'s catch blocks — run it INSIDE a catch,
 *  after the primary operation already FAILED, immediately before re-throwing that real error; one —
 *  `handleDualVerify` — follows an operation that commits nothing to disk at all: audit.jsonl IS the
 *  durable record there. Sites are named by FUNCTION rather than by line because the line form of this
 *  same enumeration was corrected twice for its reasoning and then invalidated a third time by
 *  unrelated edits above it, silently and without any check noticing. `grep -n appendAudit
 *  src/server/handlers.ts` re-derives it. Fix round 1 (review Important 3): an earlier version of this
 *  comment claimed every caller's primary operation had "already durably committed", which is false
 *  for the reject paths and the dual-verify path. Fix round 2: that same earlier version also
 *  undercounted the success sites (three, not four — `handleConfirm`'s was missing). The
 *  exemption is correct regardless of the count — it is *more* clearly correct once stated right: at
 *  the reject sites, letting a directory-fsync failure escape would not just misreport a success as a
 *  failure, it would REPLACE the real rejection error the caller is about to re-throw with an
 *  unrelated fsync error, masking the actual diagnosis. Both outcomes are worse than the audit row
 *  silently missing — a gap this docstring already accepts. The row's own bytes stay unconditional:
 *  writeAll + fsyncSync(fd) above are untouched and still propagate.
 *
 *  EVERY append fsyncs the directory, not just the first (2026-08-11): an exists-then-decide probe
 *  raced concurrent first creation, so a non-creator's acknowledged row depended on the CREATOR
 *  surviving to its own fsyncDir. Each appender now owns the directory-entry durability of the row
 *  it acknowledges. Audit appends are low-frequency; the extra directory fsync is noise. */
export function appendAudit(path: string, event: AuditEvent, io: { fsyncDir: typeof fsyncDir } = { fsyncDir }): void {
  ensureHelixDir(dirname(path));
  const fd = openSync(path, 'a', 0o600);   // owner-only ON CREATE (the audit trail is unauthenticated; a group writer could rewrite it)
  try {
    // writeAll loops short writes (a truncated row is never fsynced) and guards a zero-progress write.
    writeAll(realFsOps, fd, JSON.stringify(event) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  // Unconditional call, unconditionally swallowed here — narrower than fs-ops.ts's own fsyncDir
  // contract, which now propagates a genuinely failed attempt. See the docstring above: at the two
  // reject sites this runs inside a catch, immediately before re-throwing the caller's real error,
  // so an escaping fsync error would REPLACE that diagnosis rather than add to it.
  try { io.fsyncDir(dirname(path)); } catch { /* best-effort by design — see docstring above */ }
}
