import { mkdirSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

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
  verdict?: 'agree' | 'diverge';
  reason?: string;
  // --- egress guard fields (2b): enum / ID / policy-key only — NEVER a matched span, secret, PII value,
  // or memory snippet. Both blocked AND allowed-override events are logged. ---
  egressDecision?: 'pass' | 'blocked' | 'allowed_override';
  decidedLeg?: 'secret' | 'pii' | 'memory_echo';                       // the coarse leg that DECIDED (renamed from blockedLeg)
  releasedLegs?: Array<'memoryEcho' | 'piiHigh' | 'piiBulk' | 'secretHeuristic' | 'secretEntropy'>; // policy keys a policy released
  piiKinds?: Array<'email' | 'phone' | 'credit_card' | 'national_id'>; // labels, never values
  echoMemoryIds?: string[];                                            // ledger IDs, never text
}

/** Erase audit (F1): every helix_memory_erase is recorded — best-effort (the fsync'd row is appended
 *  after the fsync'd erase, so a crash in the narrow gap can miss it; see appendAudit) — so a
 *  poisoned/erroneous erase that suppresses an authoritative fact is detectable in audit.jsonl. The MCP tool is soft-only
 *  (`soft: true`); `soft: false` marks the out-of-band permanent/compaction path. Content-free
 *  by design — only the id is recorded, never the erased text. */
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
 *  shape (not firewall's VerifyOutcome) to keep audit decoupled from the check engine. */
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

export type AuditEvent = DualVerifyAudit | EraseAudit | VerifyAudit;

/** Append one audit event as a JSONL line, fsync'd so a written row survives power loss. Creates
 *  parent dirs as needed. Completeness is best-effort, NOT transactional: the row is appended AFTER
 *  the action it records (the erase/verify, itself fsynced), so a crash in the narrow window between
 *  the two can leave the action durable with its audit row absent. Durable-once-written. */
export function appendAudit(path: string, event: AuditEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  try {
    // writeSync may short-write; loop until the whole line lands so a truncated row is never fsynced.
    const buf = Buffer.from(JSON.stringify(event) + '\n', 'utf8');
    for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
