import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DualVerifyAudit {
  kind: 'dual-verify';
  ts: string;
  enabled: boolean;
  /** True when a real (metered) Codex call was attempted. */
  spawned: boolean;
  mode?: 'compare' | 'critique';
  verdict?: 'agree' | 'diverge';
  reason?: string;
  // --- egress guard fields (2b): enum / ID only — NEVER a matched span, secret, PII value,
  // or memory snippet. Both blocked AND allowed-override events are logged. ---
  egressDecision?: 'pass' | 'blocked' | 'allowed_override';
  blockedLeg?: 'secret' | 'pii' | 'memory_echo';                       // the deciding leg
  piiKinds?: Array<'email' | 'phone' | 'credit_card' | 'national_id'>; // labels, never values
  echoMemoryIds?: string[];                                            // ledger IDs, never text
}

/** Erase audit (F1): EVERY helix_memory_erase is recorded so a poisoned/erroneous erase that
 *  suppresses an authoritative fact is detectable in audit.jsonl. The MCP tool is soft-only
 *  (`soft: true`); `soft: false` marks the out-of-band permanent/compaction path. Content-free
 *  by design — only the id is recorded, never the erased text. */
export interface EraseAudit {
  kind: 'erase';
  ts: string;
  id: string;
  soft: boolean; // true = tombstone-only (recoverable); false = physical compaction (right-to-erasure)
}

export type AuditEvent = DualVerifyAudit | EraseAudit;

/** Append one audit event as a JSONL line. Creates parent dirs as needed. */
export function appendAudit(path: string, event: AuditEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + '\n');
}
