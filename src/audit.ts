import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuditEvent {
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

/** Append one audit event as a JSONL line. Creates parent dirs as needed. */
export function appendAudit(path: string, event: AuditEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + '\n');
}
