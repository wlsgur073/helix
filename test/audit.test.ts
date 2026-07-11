import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAudit, type AuditEvent } from '../src/audit.js';

function tmpAudit() { return join(mkdtempSync(join(tmpdir(), 'helix-audit-')), 'audit.jsonl'); }

describe('appendAudit', () => {
  it('appends one JSON line per event and reads back', () => {
    const p = tmpAudit();
    const e: AuditEvent = { kind: 'dual-verify', ts: '2026-06-09T00:00:00.000Z', enabled: true, spawned: true, verdict: 'agree' };
    appendAudit(p, e);
    appendAudit(p, { ...e, verdict: 'diverge' });
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).kind).toBe('dual-verify');
    expect(JSON.parse(lines[1]!).verdict).toBe('diverge');
  });

  it('round-trips the enum/ID-only egress fields', () => {
    const p = tmpAudit();
    const e: AuditEvent = {
      kind: 'dual-verify', ts: '2026-06-14T00:00:00.000Z', enabled: true, spawned: false,
      reason: 'blocked: memory-echo (2 items)',
      egressDecision: 'blocked', decidedLeg: 'memory_echo',
      piiKinds: ['email', 'credit_card'], echoMemoryIds: ['m_1', 'm_2'],
    };
    appendAudit(p, e);
    const back = JSON.parse(readFileSync(p, 'utf8').trim());
    expect(back.egressDecision).toBe('blocked');
    expect(back.decidedLeg).toBe('memory_echo');
    expect(back.piiKinds).toEqual(['email', 'credit_card']);
    expect(back.echoMemoryIds).toEqual(['m_1', 'm_2']);
  });

  it('round-trips an allowed_override egress event', () => {
    const p = tmpAudit();
    const e: AuditEvent = {
      kind: 'dual-verify', ts: '2026-06-14T00:00:00.000Z', enabled: true, spawned: true,
      egressDecision: 'allowed_override', decidedLeg: 'pii', piiKinds: ['credit_card'],
    };
    appendAudit(p, e);
    expect(JSON.parse(readFileSync(p, 'utf8').trim()).egressDecision).toBe('allowed_override');
  });

  it('appends a content-free verify audit row (no path/pattern)', () => {
    const p = tmpAudit();
    const e: AuditEvent = {
      kind: 'verify', ts: '2026-01-01T00:00:00Z', id: 'm1', source: 'reality-check',
      checkKind: 'file-contains', resultState: 'Corroborated', bound: true,
      outcome: { ran: true, indeterminate: false, passed: true },
    };
    appendAudit(p, e);
    const row = JSON.parse(readFileSync(p, 'utf8').trim());
    expect(row.kind).toBe('verify');
    expect(row.resultState).toBe('Corroborated');
    expect(JSON.stringify(row)).not.toMatch(/path|pattern/); // content-free
  });
});
