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
}

/** Append one audit event as a JSONL line. Creates parent dirs as needed. */
export function appendAudit(path: string, event: AuditEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + '\n');
}
