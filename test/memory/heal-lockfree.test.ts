// Third fix batch B1, task B7 (design 4.6, p-8; 4.7 and G-R6): the startup heal classifies each scope without the ledger lock
// and takes the lock only when there is something it would act on. The 5 s budget of a heal that is needed is kept.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lockMod from '../../src/memory/lock.js';
import * as ledgerMod from '../../src/memory/ledger.js';
import * as witnessStoreMod from '../../src/memory/witness-store.js';
import { lockPathOf, writeLockFileForTest } from '../../src/memory/lock.js';
import { selfIdentity } from '../../src/memory/lock-liveness.js';
import { readLedgerBytes, witnessFenceRecord } from '../../src/memory/ledger.js';
import { MemoryStore } from '../../src/memory/store.js';
import { classifyState, planTransition, openTransition, readScopeWitness } from '../../src/memory/witness-store.js';
import { sha256Hex } from '../../src/memory/witness-core.js';
import { buildGlobalLayout, cleanupLayouts } from '../helpers/global-layouts.js';

const FIXED = '2026-11-01T00:00:00.000Z';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); cleanupLayouts(); });

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'heal-')));
  dirs.push(home);
  const ledger = join(home, 'memory.jsonl');
  let n = 0;
  const store = new MemoryStore(ledger, { home, sessionId: 's', now: () => FIXED, genId: () => `m_${++n}` });
  store.commit({ content: 'the deploy runbook lives in docs/release', source: 'user' });
  return { home, ledger, store };
}

/** A lock payload that classifies ALIVE from this thread: this process's own identity under another thread id. */
function liveHolderLock(ledger: string): string {
  const me = selfIdentity('holder');
  const lockPath = lockPathOf(ledger);
  writeLockFileForTest(lockPath, { ...me, threadId: me.threadId + 1 });
  return lockPath;
}

/** Journal a transition and stop, as a process death between open and rename leaves it (precedent: heal-interrupted.test.ts). */
function strandAt(home: string, expectedBytes: Buffer): void {
  const p = planTransition(home, '@global', 'compaction');
  openTransition(home, '@global', {
    kind: 'compaction', epoch: p.epoch, nonce: p.nonce, predecessor: p.predecessor, supersedes: p.supersedes,
    expected: { byteLength: expectedBytes.length, prefixHash: sha256Hex(expectedBytes) }, tx: FIXED,
  });
}

describe('p-8: a start with nothing to heal is not delayed by a held lock', () => {
  it('a live holder of the global ledger lock costs the start nothing when the scope is in sync', () => {
    const { ledger, store } = fixture();
    const lockPath = liveHolderLock(ledger);
    const t0 = performance.now();
    store.healWitness();
    expect(performance.now() - t0).toBeLessThan(1000);       // HEAD: the lock budget, 5,000 ms
    expect(existsSync(lockPath)).toBe(true);                  // the holder was not touched
  }, 20_000);

  it('the same for an owned project scope', () => {
    const { home } = fixture();
    const root = join(home, 'proj');
    mkdirSync(join(root, '.helix'), { recursive: true });
    const project = { root, ledger: join(root, '.helix', 'memory.jsonl'), origin: 'cwd' as const };
    const s = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 'p', now: () => FIXED, project });
    s.adopt(root);
    s.commit({ content: 'a project fact', source: 'user', scope: 'project' });
    liveHolderLock(project.ledger);
    const t0 = performance.now();
    s.healWitness();
    expect(performance.now() - t0).toBeLessThan(1000);
  }, 20_000);

  it('a transition-interrupted scope that is NOT at its predecessor costs the start nothing either, and its journal stays (design 4.6: both lineages match, nothing to heal)', () => {
    const { home, ledger, store } = fixture();
    const current = readLedgerBytes(ledger);
    strandAt(home, current.subarray(0, current.length - 1));   // `expected` is a strict prefix of the bytes: both lineages match (heal-interrupted.test.ts)
    expect(classifyState(readScopeWitness(home, '@global'), readLedgerBytes(ledger)).kind).toBe('transition-interrupted');
    const lockPath = liveHolderLock(ledger);
    const t0 = performance.now();
    store.healWitness();
    expect(performance.now() - t0).toBeLessThan(1000);         // the look decides: HEAD waits the lock budget, 5,000 ms
    expect(readScopeWitness(home, '@global').journal).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
  }, 20_000);

  it('the lock-free look is ONE bare pair, witness first and ledger second, with no retry and no reader wait', () => {
    const { store } = fixture();
    const order: string[] = [];
    const realW = witnessStoreMod.readScopeWitness;
    const realR = ledgerMod.readLedgerBytes;
    const w = vi.spyOn(witnessStoreMod, 'readScopeWitness').mockImplementation((...a: Parameters<typeof realW>) => { order.push('witness'); return realW(...a); });
    const r = vi.spyOn(ledgerMod, 'readLedgerBytes').mockImplementation((...a: Parameters<typeof realR>) => { order.push('ledger'); return realR(...a); });
    const wait = vi.spyOn(lockMod, 'awaitLiveHolder');
    try {
      store.healWitness();
      expect(order).toEqual(['witness', 'ledger']);           // HEAD: ['ledger', 'witness'] inside the lock
      expect(wait).not.toHaveBeenCalled();
    } finally { w.mockRestore(); r.mockRestore(); wait.mockRestore(); }
  });
});

describe('4.6: a heal that is needed is still done, under the lock, with the 5 s budget', () => {
  it('a transition-heal scope (the rewrite landed, the journal was never completed) is completed in the same call', () => {
    const { home, ledger, store } = fixture();
    const plan = planTransition(home, '@global', 'compaction');
    const fence = witnessFenceRecord(plan.epoch, plan.nonce, FIXED);
    const target = readLedgerBytes(ledger).toString('utf8') + JSON.stringify(fence) + '\n';
    openTransition(home, '@global', {
      kind: 'compaction', epoch: plan.epoch, nonce: plan.nonce, predecessor: plan.predecessor, supersedes: plan.supersedes,
      expected: { byteLength: Buffer.byteLength(target), prefixHash: sha256Hex(Buffer.from(target)) }, tx: fence.tx,
    });
    writeFileSync(ledger, target);
    expect(classifyState(readScopeWitness(home, '@global'), readLedgerBytes(ledger)).kind).toBe('transition-heal');
    store.healWitness();
    expect(readScopeWitness(home, '@global').journal).toBeNull();
    expect(classifyState(readScopeWitness(home, '@global'), readLedgerBytes(ledger)).kind).toBe('in-sync');
  });

  it('an interrupted scope at its predecessor with a live holder: the start waits the budget, then leaves the journal pending', () => {
    const { home, ledger, store } = fixture();
    strandAt(home, Buffer.from('bytes this rewrite never produced\n', 'utf8'));
    liveHolderLock(ledger);
    const t0 = performance.now();
    store.healWitness();
    const ms = performance.now() - t0;
    expect(ms).toBeGreaterThan(4000);                         // the budget of 4.5 is kept (4.6: "5초 예산은 유지한다")
    expect(ms).toBeLessThan(9000);
    expect(readScopeWitness(home, '@global').journal).not.toBeNull();
  }, 30_000);
});

describe('4.7 and G-R6: a read-only global scope is not healed and its lock is not taken', () => {
  it.each(['nonutf8-dir-link', 'dangling-target-dir-missing'] as const)('%s: no lock, no ledger read, the pending journal stays', (name) => {
    const l = buildGlobalLayout(name);
    strandAt(l.home, Buffer.from('bytes this rewrite never produced\n', 'utf8'));
    const lockSpy = vi.spyOn(lockMod, 'withFileLock');
    const readSpy = vi.spyOn(ledgerMod, 'readLedgerBytes');
    try {
      l.store().healWitness();
      expect(lockSpy).not.toHaveBeenCalled();                 // HEAD: called once, and the lock path throws
      expect(readSpy).not.toHaveBeenCalled();
    } finally { lockSpy.mockRestore(); readSpy.mockRestore(); }
    expect(readScopeWitness(l.home, '@global').journal).not.toBeNull();
  });
});
