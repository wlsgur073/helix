import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAudit, type AuditEvent } from '../src/audit.js';

function tmpAudit() { return join(mkdtempSync(join(tmpdir(), 'helix-audit-')), 'audit.jsonl'); }

// DEVIATION (documented, task-7-report.md): appendAudit has no injectable DurableFsOps seam of its
// own — audit.jsonl is a single best-effort side channel, not one of the coordinated durable-write
// paths (ledger/key/witness) that thread `fsOps` through for that purpose. To prove the deliberate
// audit.ts exemption (task 7: a genuinely failed directory fsync on first creation must NOT abort an
// already-succeeded primary operation) without adding a production-facing test hook, mock the ONE
// function audit.ts imports from fs-ops.js and make it throw exactly once, on command — every other
// test in this file exercises the real, unmocked fsyncDir via the pass-through below (vitest hoists
// vi.mock above the imports above, so import order here does not matter). This is the ONLY module
// mock in this suite.
let throwOnNextFsyncDir: (Error & { code?: string }) | null = null;
vi.mock('../src/memory/fs-ops.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/memory/fs-ops.js')>();
  return {
    ...actual,
    fsyncDir: (dir: string) => {
      const err = throwOnNextFsyncDir;
      throwOnNextFsyncDir = null; // one-shot: only the dedicated test below arms it
      if (err) throw err;
      return actual.fsyncDir(dir);
    },
  };
});

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

  it('round-trips an indeterminate verdict row', () => {
    const p = tmpAudit();
    appendAudit(p, { kind: 'dual-verify', ts: '2026-07-26T00:00:00.000Z', enabled: true, spawned: true, verdict: 'indeterminate' });
    expect(JSON.parse(readFileSync(p, 'utf8').trim()).verdict).toBe('indeterminate');
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

  // Task 7 (LEAD-DIRFSYNC-SUPPRESSED): fs-ops.ts's fsyncDir now PROPAGATES an attempted-and-failed
  // directory fsync instead of swallowing it — correct for the ledger/key/witness write paths.
  // audit.jsonl is deliberately exempted: this file's own docstring says completeness is best-effort,
  // NOT transactional, and no caller (handlers.ts) wraps appendAudit — by the time it runs, every
  // caller has already COMPLETED its primary operation (successfully at handlers.ts:154/167/186/206,
  // or having already FAILED at :189/:201, about to re-throw its own real error). Fix round 1 (review
  // Important 3): the primary operation is not always a SUCCESS that "already durably committed" —
  // see audit.ts's own docstring for the corrected, per-site breakdown. Fix round 2: that breakdown
  // itself first undercounted the success sites (three, not four — :206, handleConfirm's own
  // post-success append, was missing). Letting a directory-fsync failure escape here would, at best,
  // report an already-successful primary operation as FAILED for an unrelated reason, and at worst —
  // at the reject sites — REPLACE the real rejection error with a
  // generic fsync error, masking it. Both are worse than the audit row silently missing, which the
  // docstring already accepts. The row content itself (writeAll + fsyncSync(fd)) is UNCHANGED — still
  // unconditional and still propagates — only the directory fsync on first creation is swallowed here.
  it('a genuinely failed directory fsync on FIRST creation does not abort the audit append (best-effort by design)', () => {
    const p = tmpAudit();
    throwOnNextFsyncDir = Object.assign(new Error('EIO fake (audit dir fsync)'), { code: 'EIO' });
    expect(() => appendAudit(p, { kind: 'adopt', ts: '2026-08-07T00:00:00.000Z', scope: '/x' })).not.toThrow();
    expect(JSON.parse(readFileSync(p, 'utf8').trim()).kind).toBe('adopt'); // the row still landed
  });
});
