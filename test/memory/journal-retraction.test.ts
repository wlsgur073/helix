// Third fix batch B1, task B7 (design 4.6, p-7): a rewrite whose journal publication fails after its own rename retracts that
// journal, keyed by the plan's nonce; a publication that failed before its rename retracts nothing and waits for nothing.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realFsOps } from '../../src/memory/fs-ops.js';
import * as witnessStoreMod from '../../src/memory/witness-store.js';
import * as lockMod from '../../src/memory/lock.js';
import * as dirBoundMod from '../../src/memory/dir-bound.js';
import { lockPathOf } from '../../src/memory/lock.js';
import { compactLedger, readLedgerBytes } from '../../src/memory/ledger.js';
import { MemoryStore } from '../../src/memory/store.js';
import {
  journalPublished, planTransition, openTransition, discardTransition, readScopeWitness, classifyState, witnessPath, witnessLogPath,
  isWitnessUnusableError,
} from '../../src/memory/witness-store.js';
import { sha256Hex } from '../../src/memory/witness-core.js';

const FIXED = '2026-11-01T00:00:00.000Z';
const K = '@global';
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'p7-')));
  dirs.push(home);
  const ledger = join(home, 'memory.jsonl');
  let n = 0;
  const store = new MemoryStore(ledger, { home, sessionId: 's', now: () => FIXED, genId: () => `m_${++n}` });
  for (const c of ['alpha deploy fact', 'bravo fact to erase', 'charlie deploy fact']) store.commit({ content: c, source: 'user' });
  return { home, ledger, store };
}
const thrownBy = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return undefined; };
const logOps = (home: string): Array<{ kind: string; op?: string; nonce: string }> =>
  readFileSync(witnessLogPath(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; op?: string; nonce: string });

/** One EIO on the fsync of `home` that runs while a journal is pending: the one after openTransition's witness rename. */
function armFsyncFault(home: string): { fired: () => number } {
  const real = realFsOps.fsyncDir.bind(realFsOps);
  let armed = true; let fired = 0;
  vi.spyOn(realFsOps, 'fsyncDir').mockImplementation((dir: string) => {
    if (armed && dir === home && readScopeWitness(home, K).journal !== null) {
      armed = false; fired += 1;
      throw Object.assign(new Error('EIO: injected, fsync of the home directory after the witness rename'), { code: 'EIO' });
    }
    real(dir);
  });
  return { fired: () => fired };
}

describe('journalPublished (the lock-free question of p-7)', () => {
  it('is true only for the journal of that nonce, from its publication to its retraction', () => {
    const { home, ledger } = fixture();
    const plan = planTransition(home, K, 'compaction');
    expect(journalPublished(home, K, plan.nonce)).toBe(false);
    const bytes = readLedgerBytes(ledger);
    openTransition(home, K, {
      kind: 'compaction', epoch: plan.epoch, nonce: plan.nonce, predecessor: plan.predecessor, supersedes: plan.supersedes,
      expected: { byteLength: bytes.length + 1, prefixHash: sha256Hex(Buffer.concat([bytes, Buffer.from('\n')])) }, tx: FIXED,
    });
    expect(journalPublished(home, K, plan.nonce)).toBe(true);
    expect(journalPublished(home, K, '0'.repeat(32))).toBe(false);
    discardTransition(home, K, plan.nonce);
    expect(journalPublished(home, K, plan.nonce)).toBe(false);
  });

  it('takes no lock and writes nothing', () => {
    const { home } = fixture();
    const before = readFileSync(witnessPath(home));
    const lockSpy = vi.spyOn(lockMod, 'withFileLock');
    expect(journalPublished(home, K, 'f'.repeat(32))).toBe(false);
    expect(lockSpy).not.toHaveBeenCalled();
    expect(readFileSync(witnessPath(home)).equals(before)).toBe(true);
  });

  it('an unusable witness file makes it throw, so the retraction that asks it does not happen', () => {
    const { home } = fixture();
    rmSync(witnessPath(home));
    mkdirSync(witnessPath(home));
    expect(isWitnessUnusableError(thrownBy(() => journalPublished(home, K, 'f'.repeat(32))))).toBe(true);
  });
});

describe('p-7, compaction: the journal a failed publication left is retracted by the plan\'s nonce', () => {
  it('a permanent erase whose journal publication fails after its rename: the journal is retracted, the scope is in sync, the next commit is stored', () => {
    const { home, ledger, store } = fixture();
    const opened: string[] = [];
    const discarded: string[] = [];
    const realOpen = witnessStoreMod.openTransition;
    const realDiscard = witnessStoreMod.discardTransition;
    vi.spyOn(witnessStoreMod, 'openTransition').mockImplementation((h, k, plan, fsOps) => { opened.push(plan.nonce); return realOpen(h, k, plan, fsOps); });
    vi.spyOn(witnessStoreMod, 'discardTransition').mockImplementation((h, k, nonce, fsOps) => { discarded.push(nonce); return realDiscard(h, k, nonce, fsOps); });
    const fault = armFsyncFault(home);
    const e = thrownBy(() => store.erase('m_2', { permanent: true })) as Error;
    expect(fault.fired()).toBe(1);
    expect(e.message).toMatch(/EIO/);                                       // the original error still reaches the caller
    expect(readScopeWitness(home, K).journal).toBeNull();                   // HEAD: PENDING
    expect(classifyState(readScopeWitness(home, K), readLedgerBytes(ledger)).kind).toBe('in-sync');
    expect(opened).toHaveLength(1);
    expect(discarded).toEqual(opened);                                      // keyed by the plan's nonce
    expect(logOps(home).some((l) => l.op === 'discard' && l.nonce === opened[0])).toBe(true);
    expect(() => store.commit({ content: 'delta fact after the fault', source: 'user' })).not.toThrow();
  });

  it('the same on a host without /proc (Review Focus 2): the rewrite takes the unbound route and the journal is still retracted', () => {
    const { home, ledger, store } = fixture();
    const enoent = (): never => { throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }); };
    realFsOps.procFd = { statSync: enoent, readlinkSync: enoent };   // a fresh stub has no memory: its first verification fails
    const opened = vi.spyOn(dirBoundMod, 'openJudgedDir');
    try {
      const fault = armFsyncFault(home);
      const e = thrownBy(() => store.erase('m_2', { permanent: true })) as Error;
      expect(fault.fired()).toBe(1);
      expect(e.message).toMatch(/EIO/);
      expect(opened).toHaveBeenCalled();
      expect(new Set(opened.mock.results.map((r) => (r.value as dirBoundMod.JudgedDirOutcome).kind))).toEqual(new Set(['unbound']));
      expect(dirBoundMod.procFdAvailable(realFsOps)).toBe(false);
    } finally { delete realFsOps.procFd; }
    expect(readScopeWitness(home, K).journal).toBeNull();
    expect(classifyState(readScopeWitness(home, K), readLedgerBytes(ledger)).kind).toBe('in-sync');
    expect(() => store.commit({ content: 'delta fact after the fault', source: 'user' })).not.toThrow();
  });

  it('a publication that failed BEFORE its rename retracts nothing and does not wait for the witness lock a second time', () => {
    const { home, ledger } = fixture();
    writeFileSync(lockPathOf(witnessPath(home)), 'not a lock payload');     // written in this boot: never reclaimed, so the budget runs out
    const discardSpy = vi.spyOn(witnessStoreMod, 'discardTransition');
    const t0 = performance.now();
    const e = thrownBy(() => compactLedger(ledger, {
      erasedIds: new Set(), keepValidVerify: () => true, provesKey: () => false,
      witness: { home, scopeKey: K, now: () => FIXED, kind: 'compaction' },
    })) as Error;
    const ms = performance.now() - t0;
    expect(e.message).toMatch(/timed out/);
    expect(ms).toBeLessThan(8000);                                          // one budget of 5,000 ms; a second wait would make it about 10,000
    expect(discardSpy).not.toHaveBeenCalled();
    rmSync(lockPathOf(witnessPath(home)));
    expect(readScopeWitness(home, K).journal).toBeNull();
  }, 30_000);

  it('a rewrite that DID land and then failed keeps its journal (the bytes no longer equal the pre-publication hash)', () => {
    const { home, ledger } = fixture();
    const real = realFsOps.fsyncDir.bind(realFsOps);
    let calls = 0;
    // The directory fsync that follows the LEDGER rename. The rewrite holds its directory (A6, B3), so with /proc it is the
    // fsync of /proc/self/fd/<n>, and without /proc that of the home; either way it is the second one while a journal is
    // pending, the first being the publication's own (dir === home).
    vi.spyOn(realFsOps, 'fsyncDir').mockImplementation((dir: string) => {
      if ((dir === home || dir.startsWith('/proc/self/fd/')) && readScopeWitness(home, K).journal !== null && (calls += 1) === 2) throw Object.assign(new Error('EIO: injected after the ledger rename'), { code: 'EIO' });
      real(dir);
    });
    const before = readLedgerBytes(ledger);
    const e = thrownBy(() => compactLedger(ledger, {
      erasedIds: new Set(['m_2']), keepValidVerify: () => true, provesKey: () => false,
      witness: { home, scopeKey: K, now: () => FIXED, kind: 'erase' },
    })) as Error;
    expect(e.message).toMatch(/EIO/);
    expect(readLedgerBytes(ledger).equals(before)).toBe(false);             // the rename landed
    expect(readScopeWitness(home, K).journal).not.toBeNull();               // so the journal stays: classifyWitness reports transition-heal
  });
});
