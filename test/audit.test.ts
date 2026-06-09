import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAudit, type AuditEvent } from '../src/audit.js';

function tmpAudit() { return join(mkdtempSync(join(tmpdir(), 'helix-audit-')), 'audit.jsonl'); }

describe('appendAudit', () => {
  it('appends one JSON line per event and reads back', () => {
    const p = tmpAudit();
    const e: AuditEvent = { kind: 'dual-verify', ts: '2026-06-09T00:00:00.000Z', enabled: true, available: true, verdict: 'agree' };
    appendAudit(p, e);
    appendAudit(p, { ...e, verdict: 'diverge' });
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).kind).toBe('dual-verify');
    expect(JSON.parse(lines[1]!).verdict).toBe('diverge');
  });
});
