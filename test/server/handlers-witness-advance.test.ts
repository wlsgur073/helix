// Task 9 (owner-ruled, spec §3.7): witness-write.ts appends the ledger record and THEN advances the
// rollback witness. When the advance throws, the signed row is already on disk, but handlers.ts used
// to audit the operation as 'rejected' -- the audit said rejected, the ledger said Verified/
// Corroborated. The first two tests below manufacture that post-append failure and pin that the audit
// now names the state that actually landed.
//
// The throw is not reachable in-process from a fixed witness state (a fixed pre-append verdict that
// permits an advance implies the post-append verdict permits it too), so it is manufactured by
// intercepting advanceWitness on the module namespace -- the same construction
// test/memory/witness-concurrent.test.ts:273 already uses to intercept a call made INSIDE the store.
// The RED run is the proof the spy reaches witness-write.ts's internal call: the assertion can fail on
// resultState === 'rejected' only if the throw propagated through the real path AFTER the append landed.
//
// Final review I-1: a WitnessAdvanceError can also reach handleConfirm from the OTHER side of the
// append -- completeTransition, on the transition-heal path, throws BEFORE any byte moves and never
// sets landedState. The last test below manufactures that inverse case (a transition-heal verdict with
// no real journal on disk to heal) and pins that confirm still audits 'rejected' there, never a landed
// grade.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { handleConfirm, handleRecheck } from '../../src/server/handlers.js';
import type { VerifyAudit } from '../../src/audit.js';
import * as witnessStoreMod from '../../src/memory/witness-store.js';
import type { JournalEntry } from '../../src/memory/witness-core.js';

function store() {
  let n = 0;
  const home = mkdtempSync(join(tmpdir(), 'helix-h-'));
  return new MemoryStore(join(home, 'm.jsonl'), {
    home, sessionId: 's1', now: () => '2026-06-09T00:00:00.000Z', genId: () => `m_${++n}`,
  });
}

/** Parses audit.jsonl line by line and returns the last row whose `kind === 'verify'`. */
function lastVerifyAuditRow(path: string): VerifyAudit {
  const rows = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as VerifyAudit);
  const verifyRows = rows.filter((r) => r.kind === 'verify');
  return verifyRows[verifyRows.length - 1]!; // callers only reach here after a verify row was written
}

/** Arms ONE manufactured post-append failure: the next advanceWitness call throws the real error
 *  class, later calls run the real implementation. Arm it AFTER the commit under test has landed,
 *  so the commit's own advance runs for real; mockRestore() in a finally. */
function armAdvanceFailure() {
  return vi.spyOn(witnessStoreMod, 'advanceWitness').mockImplementationOnce(() => {
    throw new witnessStoreMod.WitnessAdvanceError('manufactured: a racing writer moved the witness between the pre-append read and the advance');
  });
}

describe('audit records the state that actually landed on a witness-advance failure', () => {
  it('a confirm whose row landed but whose witness advance failed audits the LANDED state', () => {
    const s = store();
    const auditPath = join(mkdtempSync(join(tmpdir(), 'helix-h-audit-')), 'audit.jsonl');
    const rec = s.commit({ content: 'db is postgres', source: 'user' });
    const spy = armAdvanceFailure();
    try {
      expect(() => handleConfirm(s, { id: rec.id }, { auditPath })).toThrow();
    } finally { spy.mockRestore(); }
    const row = lastVerifyAuditRow(auditPath);
    // The ledger says Verified. The audit must not say the opposite.
    expect(row.resultState).toBe('Verified');
    expect(row.witnessAdvance).toBe('failed');
    // And the record really is on disk at that grade — the point of the whole fix.
    expect(s.inspect().find((r) => r.record.id === rec.id)!.record.state).toBe('Verified');
  });

  it('a recheck whose row landed but whose witness advance failed audits the LANDED grade and bound: true', () => {
    // Fixture mirrors the passing file-contains case at test/server/handlers.test.ts:264-281: a store
    // over `dir`, app.json containing 'base /v2/users', chdir(dir) for the duration, restored after.
    const dir = mkdtempSync(join(tmpdir(), 'helix-h-'));
    const auditPath = join(dir, 'audit.jsonl');
    let n = 0;
    const s = new MemoryStore(join(dir, 'm.jsonl'), { home: dir, sessionId: 's1', now: () => '2026-06-09T00:00:00.000Z', genId: () => `m_${++n}` });
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      writeFileSync(join(dir, 'app.json'), 'base /v2/users');
      const a = s.commit({ content: 'api base /v2/users in app.json', source: 'user-relayed' });
      const spy = armAdvanceFailure();
      try {
        expect(() => handleRecheck(s, { id: a.id, check: { kind: 'file-contains', path: 'app.json', pattern: '/v2/users' } }, { auditPath })).toThrow();
      } finally { spy.mockRestore(); }
      const row = lastVerifyAuditRow(auditPath);
      expect(row).toMatchObject({ kind: 'verify', source: 'reality-check', checkKind: 'file-contains', resultState: 'Corroborated', bound: true, witnessAdvance: 'failed' });
      expect(row.outcome).toBeUndefined(); // genuinely unavailable on this path — omitted, never guessed
      expect(s.inspect().find((r) => r.record.id === a.id)!.record.state).toBe('Corroborated');
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('a WitnessAdvanceError thrown BEFORE the append still audits rejected (I-1)', () => {
  it('a confirm whose pre-append verdict is transition-heal, but disk holds no journal to heal, audits rejected -- never the landed grade', () => {
    const s = store();
    const auditPath = join(mkdtempSync(join(tmpdir(), 'helix-h-audit-')), 'audit.jsonl');
    const rec = s.commit({ content: 'db is postgres', source: 'user' });
    // Arm AFTER the commit so its own witness advance runs for real and mints the scope's real entry.
    // classifyState's first call after that is witness-write.ts's PRE-append read; mocking it to
    // 'transition-heal' sends appendWitnessedUnlocked into the REAL completeTransition, which re-reads
    // the REAL (journal-less) witness.json and throws before touching the ledger -- the mock journal
    // below only has to satisfy the type completeTransition's caller destructures `.tx` from.
    const journal: JournalEntry = {
      kind: 'compaction', epoch: 1, predecessor: null,
      expected: { byteLength: 0, prefixHash: '' }, nonce: 'n', tx: '2026-06-09T00:00:00.000Z',
      supersedes: null, mac: 'journal-mac',
    };
    const spy = vi.spyOn(witnessStoreMod, 'classifyState').mockImplementationOnce(() => ({ kind: 'transition-heal', journal }));
    try {
      expect(() => handleConfirm(s, { id: rec.id }, { auditPath })).toThrow(/no pending journal/);
    } finally { spy.mockRestore(); }
    const row = lastVerifyAuditRow(auditPath);
    // No byte moved on this path -- the audit must say so, not the landed grade the other tests pin.
    expect(row.resultState).toBe('rejected');
    expect(row.witnessAdvance).toBeUndefined();
    expect(s.inspect().find((r) => r.record.id === rec.id)!.record.state).toBe('Fresh');
  });
});
