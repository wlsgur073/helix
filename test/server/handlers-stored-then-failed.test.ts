// Third fix batch B1, task A16 (design 4.8 item 3, 13.3 decision 11): commit, erase, confirm and recheck turn a marked error
// into the fixed "stored, a later step failed" response, so the agent does not store the same row again. The audit rows do not
// change in this batch (finding F-5): pinned here as they are.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { handleCommit, handleErase, handleConfirm, handleRecheck, STORED_THEN_FAILED_RESPONSE, StoredThenFailedError } from '../../src/server/handlers.js';
import * as witnessStoreMod from '../../src/memory/witness-store.js';
import * as ledgerMod from '../../src/memory/ledger.js';
import { realFsOps } from '../../src/memory/fs-ops.js';
import { isRecordStoredError, isWitnessUnusableError, witnessPath, witnessUnusableRefusal } from '../../src/memory/witness-store.js';
import type { VerifyAudit, EraseAudit } from '../../src/audit.js';

function fx() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hs-'))); let n = 0;
  const s = new MemoryStore(join(dir, 'm.jsonl'), { home: dir, sessionId: 's', now: () => '2026-10-01T00:00:00.000Z', genId: () => `m_${++n}` });
  return { dir, s, ledger: join(dir, 'm.jsonl'), auditPath: join(dir, 'audit.jsonl') };
}
const rows = (p: string): number => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0);
const lastAudit = <T>(p: string): T => { const l = readFileSync(p, 'utf8').trim().split('\n'); return JSON.parse(l[l.length - 1]!) as T; };
const thrown = (f: () => unknown): Error => { try { f(); } catch (e) { return e as Error; } throw new Error('expected a throw'); };
const unlinkSyncSafe = (p: string): void => { try { unlinkSync(p); } catch { /* absent */ } };
const arm = (make: () => Error) => vi.spyOn(witnessStoreMod, 'advanceWitness').mockImplementationOnce(() => { throw make(); });
const eio = (): Error => Object.assign(new Error('EIO: fake'), { code: 'EIO' });
const raced = (): Error => new witnessStoreMod.WitnessAdvanceError('raced');

describe('the four fixed texts (4.9 row "저장된 뒤의 실패": the commit text verbatim; the others are drafts of the same form)', () => {
  it('commit is the 4.9 draft; the other three keep its form with the operation\'s own words', () => {
    expect(STORED_THEN_FAILED_RESPONSE.commit).toBe('commit: the record was stored, but a step after the write failed (the rollback witness may not have been updated). Do not commit it again; tell the user what happened.');
    expect(STORED_THEN_FAILED_RESPONSE.erase).toBe('erase: the erase was stored, but a step after the write failed (the rollback witness may not have been updated). Do not erase it again; tell the user what happened.');
    expect(STORED_THEN_FAILED_RESPONSE.confirm).toBe('confirm: the confirmation was stored, but a step after the write failed (the rollback witness may not have been updated). Do not confirm it again; tell the user what happened.');
    expect(STORED_THEN_FAILED_RESPONSE.recheck).toBe("recheck: the check's result was stored, but a step after the write failed (the rollback witness may not have been updated). Do not run the recheck again; tell the user what happened.");
  });
  it('StoredThenFailedError: the message is the fixed text, the cause is the original, the mark is kept', () => {
    const cause = eio(); const e = new StoredThenFailedError('commit', cause);
    expect(e.message).toBe(STORED_THEN_FAILED_RESPONSE.commit); expect(e.cause).toBe(cause); expect(isRecordStoredError(e)).toBe(true);
  });
});

describe.each([['EIO on the witness replace', eio], ['a racing writer (WitnessAdvanceError)', raced]] as const)('after the append, %s', (label, make) => {
  it('commit: the fixed response, the row stored exactly once', () => {
    const { s, ledger } = fx(); const spy = arm(make);
    try { expect(thrown(() => handleCommit(s, { content: 'a fact', source: 'user', scope: 'global' })).message).toBe(STORED_THEN_FAILED_RESPONSE.commit); } finally { spy.mockRestore(); }
    expect(rows(ledger)).toBe(1);
  });
  it('erase: the fixed response, the tombstone stored once; the audit row is the one of today', () => {
    const { s, ledger, auditPath } = fx(); const id = s.commit({ content: 'a fact', source: 'user', scope: 'global' }).id; const before = rows(ledger);
    const spy = arm(make);
    try { expect(thrown(() => handleErase(s, { id }, { auditPath })).message).toBe(STORED_THEN_FAILED_RESPONSE.erase); } finally { spy.mockRestore(); }
    expect(rows(ledger)).toBe(before + 1);
    const a = lastAudit<EraseAudit>(auditPath);
    if (label.startsWith('a racing')) expect(a).toMatchObject({ kind: 'erase', soft: true, witnessAdvance: 'failed' }); else expect(a).toMatchObject({ kind: 'erase', soft: true, outcome: 'indeterminate' });
  });
  it('confirm: the fixed response, the verify row stored once; the audit row is the one of today (F-5)', () => {
    const { s, ledger, auditPath } = fx(); const id = s.commit({ content: 'a fact', source: 'user', scope: 'global' }).id; const before = rows(ledger);
    const spy = arm(make);
    try { expect(thrown(() => handleConfirm(s, { id }, { auditPath })).message).toBe(STORED_THEN_FAILED_RESPONSE.confirm); } finally { spy.mockRestore(); }
    expect(rows(ledger)).toBe(before + 1);
    const a = lastAudit<VerifyAudit>(auditPath);
    if (label.startsWith('a racing')) expect(a).toMatchObject({ resultState: 'Verified', witnessAdvance: 'failed' }); else expect(a).toMatchObject({ resultState: 'rejected' });
  });
  it('recheck: the fixed response, the verify row stored once', () => {
    const { dir, s, ledger, auditPath } = fx(); writeFileSync(join(dir, 'app.json'), 'base /v2/users');
    const id = s.commit({ content: 'api base /v2/users in app.json', source: 'user-relayed', scope: 'global' }).id; const before = rows(ledger);
    const cwd = process.cwd(); process.chdir(dir); const spy = arm(make);
    try { expect(thrown(() => handleRecheck(s, { id, check: { kind: 'file-contains', path: 'app.json', pattern: '/v2/users' } }, { auditPath })).message).toBe(STORED_THEN_FAILED_RESPONSE.recheck); }
    finally { spy.mockRestore(); process.chdir(cwd); }
    expect(rows(ledger)).toBe(before + 1);
  });
});

describe('before the append, nothing is marked and nothing is replaced by the fixed response', () => {
  it('a directory at witness.json: commit, erase, confirm and recheck each answer the witness refusal itself; nothing is stored', () => {
    const { dir, s, ledger, auditPath } = fx(); const id = s.commit({ content: 'a fact', source: 'user', scope: 'global' }).id;
    writeFileSync(join(dir, 'app.json'), 'base /v2/users');
    const rid = s.commit({ content: 'api base /v2/users in app.json', source: 'user-relayed', scope: 'global' }).id; const before = rows(ledger);
    unlinkSyncSafe(witnessPath(dir)); mkdirSync(witnessPath(dir));
    const cwd = process.cwd(); process.chdir(dir);
    try {
      for (const [f, op] of [
        [() => handleCommit(s, { content: 'x', source: 'user', scope: 'global' }), 'commit'],
        [() => handleErase(s, { id }, { auditPath }), 'erase'],
        [() => handleConfirm(s, { id }, { auditPath }), 'confirm'],
        [() => handleRecheck(s, { id: rid, check: { kind: 'file-contains', path: 'app.json', pattern: '/v2/users' } }, { auditPath }), 'recheck'],
      ] as const) {
        const e = thrown(f);
        expect(isWitnessUnusableError(e)).toBe(true); expect(isRecordStoredError(e)).toBe(false);
        expect(e.message).toBe(witnessUnusableRefusal(op));
      }
    } finally { process.chdir(cwd); }
    expect(rows(ledger)).toBe(before);
  });

  it('element K: an erase refused by the witness check BEFORE the append is audited rejected (a pre-write class), not indeterminate; the same error AFTER the append keeps today\'s row', () => {
    const { dir, s, auditPath } = fx(); const id = s.commit({ content: 'a fact', source: 'user', scope: 'global' }).id;
    unlinkSyncSafe(witnessPath(dir)); mkdirSync(witnessPath(dir));
    thrown(() => handleErase(s, { id }, { auditPath }));
    expect(lastAudit<EraseAudit>(auditPath)).toMatchObject({ kind: 'erase', soft: true, outcome: 'rejected' });
    const g = fx(); const id2 = g.s.commit({ content: 'a fact', source: 'user', scope: 'global' }).id;
    const real = witnessStoreMod.advanceWitness;
    const spy = vi.spyOn(witnessStoreMod, 'advanceWitness').mockImplementationOnce((...a: Parameters<typeof real>) => { unlinkSyncSafe(witnessPath(g.dir)); mkdirSync(witnessPath(g.dir)); return real(...a); });
    try { thrown(() => handleErase(g.s, { id: id2 }, { auditPath: g.auditPath })); } finally { spy.mockRestore(); }
    expect(lastAudit<EraseAudit>(g.auditPath)).toMatchObject({ kind: 'erase', soft: true, outcome: 'indeterminate' });
  });
});

describe('a failure inside the append after the row is durable reaches the handler as stored', () => {
  it('commit on an existing ledger whose directory fsync fails: the fixed response, the row stored once', () => {
    const { s, ledger } = fx(); s.commit({ content: 'first', source: 'user', scope: 'global' }); const before = rows(ledger);
    const real = ledgerMod.appendRecordUnlocked;
    const spy = vi.spyOn(ledgerMod, 'appendRecordUnlocked').mockImplementationOnce((p, r) => real(p, r, { ...realFsOps, fsyncDir: () => { throw eio(); } }));
    try { expect(thrown(() => handleCommit(s, { content: 'a fact', source: 'user', scope: 'global' })).message).toBe(STORED_THEN_FAILED_RESPONSE.commit); } finally { spy.mockRestore(); }
    expect(rows(ledger)).toBe(before + 1);
  });
});
