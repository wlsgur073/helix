// IT-M6 (second fix batch §4.2). Two changes, each pinned without timing races:
//  (1) a witnessed compaction writes + fsyncs its tmp BEFORE openTransition publishes the journal, so
//      the lock-free "journal over old bytes" window (window A) no longer spans the row writes and the
//      tmp fsync;
//  (2) a witnessed read whose retry still verdicts transition-interrupted consults the scope's LEDGER
//      lock and, for a holder that classifies alive / alive-unknown, waits (25 ms polls, 2 s cap). No
//      lock / dead / reentrant-self -> no wait. Ruling R5: WHATEVER the consultation found (none,
//      released, timeout), the scope is then read once more, witness-first, and that verdict is used —
//      a rewrite that landed and released between the retry and the consultation reads settled.
// Determinism: the wait's pause is an injectable `sleep`, so a test performs the "rewriter finishes"
// step INSIDE the first pause (no second thread, no clock). The production entry is reached through a
// module-namespace vi.spyOn on lock.ts's awaitLiveHolder that forwards to the real function with that
// seam added (the sanctioned interception, witness-concurrent.test.ts).
import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { compactLedger, readLedgerBytes, witnessFenceRecord } from '../../src/memory/ledger.js';
import { realFsOps, type DurableFsOps } from '../../src/memory/fs-ops.js';
import * as witnessStoreMod from '../../src/memory/witness-store.js';
import {
  planTransition, openTransition, completeTransition, readScopeWitness, witnessPath,
  type ScopeWitnessState,
} from '../../src/memory/witness-store.js';
import {
  witnessedRead, readLedgerWitnessed, REWRITER_WAIT_MAX_MS, REWRITER_WAIT_POLL_MS,
} from '../../src/memory/witness-read.js';
import * as lockMod from '../../src/memory/lock.js';
import { awaitLiveHolder, lockPathOf, writeLockFileForTest, type HolderWaitOptions } from '../../src/memory/lock.js';
import { selfIdentity } from '../../src/memory/lock-liveness.js';
import { sha256Hex, type JournalEntry, type WitnessEntry } from '../../src/memory/witness-core.js';
import { WITNESS_TRANSITION_NOTE } from '../../src/memory/content-frame.js';
import { gatherScopedRecords } from '../../src/hooks/session-start.js';

const FIXED = '2026-10-01T00:00:00.000Z';
function newHome(): string { return mkdtempSync(join(tmpdir(), 'helix-rwwait-')); }
function store(home: string): { store: MemoryStore; ledger: string } {
  const ledger = join(home, 'memory.jsonl');
  let n = 0;
  return { store: new MemoryStore(ledger, { home, sessionId: 't', now: () => FIXED, genId: () => `m_${++n}` }), ledger };
}

/** Window A, planted: journal a head that is not on disk yet (old bytes + a fence). Returns the step
 *  that lands it the way compactLedger does after its rename (write the bytes, completeTransition). */
function plantWindowA(home: string, ledger: string): { land: () => void } {
  const plan = planTransition(home, '@global', 'compaction');
  const fence = witnessFenceRecord(plan.epoch, plan.nonce, FIXED);
  const target = readLedgerBytes(ledger).toString('utf8') + JSON.stringify(fence) + '\n';
  openTransition(home, '@global', {
    kind: 'compaction', epoch: plan.epoch, nonce: plan.nonce, predecessor: plan.predecessor,
    supersedes: plan.supersedes,
    expected: { byteLength: Buffer.byteLength(target), prefixHash: sha256Hex(Buffer.from(target)) },
    tx: fence.tx,
  });
  return { land: () => { writeFileSync(ledger, target); completeTransition(home, '@global', readLedgerBytes(ledger), fence.tx); } };
}

/** A lock payload that classifies ALIVE from this thread: this process's own identity under another
 *  thread id (classifyHolder rule 7). DEAD: the same identity from another boot (rule 2). */
function liveHolderLock(ledger: string): string {
  const me = selfIdentity('holder');
  const lockPath = lockPathOf(ledger);
  writeLockFileForTest(lockPath, { ...me, threadId: me.threadId + 1 });
  return lockPath;
}
function deadHolderLock(ledger: string): string {
  const lockPath = lockPathOf(ledger);
  writeLockFileForTest(lockPath, { ...selfIdentity('holder'), bootId: '00000000-0000-0000-0000-000000000000' });
  return lockPath;
}
/** A pid no process holds any more: a child that has already exited. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid!;

/** Route the production wait through the real awaitLiveHolder with test seams added. */
function spyWait(extra: Partial<HolderWaitOptions>): { calls: () => number; restore: () => void } {
  const real = lockMod.awaitLiveHolder;
  let n = 0;
  const spy = vi.spyOn(lockMod, 'awaitLiveHolder').mockImplementation((target, opts) => { n += 1; return real(target, { ...opts, ...extra }); });
  return { calls: () => n, restore: () => spy.mockRestore() };
}

describe('IT-M6 (1): compaction writes the tmp before it publishes the journal', () => {
  it('the tmp fsync happens while no journal is visible, then openTransition, then the rename', () => {
    const home = newHome();
    const { store: s, ledger } = store(home);
    const realOpen = witnessStoreMod.openTransition;
    const events: string[] = [];
    const openSpy = vi.spyOn(witnessStoreMod, 'openTransition').mockImplementation((...a) => { events.push('openTransition'); return realOpen(...a); });
    try {
      s.commit({ content: 'alpha deploy fact', source: 'user' });
      s.commit({ content: 'bravo deploy fact', source: 'user' });
      const logFs: DurableFsOps = {
        ...realFsOps,
        fsyncSync: (fd) => { events.push(readScopeWitness(home, '@global').journal ? 'tmp-fsync:journal-visible' : 'tmp-fsync:no-journal'); realFsOps.fsyncSync(fd); },
        renameSync: (from, to) => { events.push('rename'); realFsOps.renameSync(from, to); },
      };
      compactLedger(ledger, {
        erasedIds: new Set(), fsOps: logFs, legacyBakeAndDrop: true,
        witness: { home, scopeKey: '@global', now: () => FIXED, kind: 'compaction' },
      });
      expect(events).toEqual(['tmp-fsync:no-journal', 'openTransition', 'rename']);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('in-sync');
    } finally { openSpy.mockRestore(); rmSync(home, { recursive: true, force: true }); }
  });

  it('a tmp fsync failure opens no journal: nothing to retract, the scope stays where it was', () => {
    const home = newHome();
    const { store: s, ledger } = store(home);
    const openSpy = vi.spyOn(witnessStoreMod, 'openTransition');
    const discardSpy = vi.spyOn(witnessStoreMod, 'discardTransition');
    try {
      s.commit({ content: 'alpha deploy fact', source: 'user' });
      const before = readLedgerBytes(ledger);
      const failFs: DurableFsOps = { ...realFsOps, fsyncSync: () => { throw new Error('injected tmp fsync failure'); } };
      expect(() => compactLedger(ledger, {
        erasedIds: new Set(), fsOps: failFs, legacyBakeAndDrop: true,
        witness: { home, scopeKey: '@global', now: () => FIXED, kind: 'compaction' },
      })).toThrow(/injected tmp fsync failure/);
      expect(openSpy).not.toHaveBeenCalled();
      expect(discardSpy).not.toHaveBeenCalled();
      expect(readScopeWitness(home, '@global').journal).toBeNull();
      expect(readLedgerBytes(ledger).equals(before)).toBe(true);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('in-sync');
    } finally { openSpy.mockRestore(); discardSpy.mockRestore(); rmSync(home, { recursive: true, force: true }); }
  });
});

// ---- (2) witnessedRead: pure seam tests (no disk) ----
const pending = (expected: Buffer): ScopeWitnessState => {
  const journal: JournalEntry = {
    kind: 'compaction', epoch: 2, predecessor: null,
    expected: { byteLength: expected.length, prefixHash: sha256Hex(expected) },
    nonce: 'n', tx: FIXED, supersedes: null, mac: 'journal-mac',
  };
  return { entry: null, journal, macInvalid: false };
};
const at = (bytes: Buffer): ScopeWitnessState => {
  const entry: WitnessEntry = { epoch: 2, byteLength: bytes.length, prefixHash: sha256Hex(bytes), headTx: null, mac: 'm' };
  return { entry, journal: null, macInvalid: false };
};
function sequence<T>(...xs: T[]): { read: () => T; calls: () => number } {
  let n = 0;
  return { read: () => xs[Math.min(n++, xs.length - 1)]!, calls: () => n };
}

describe('IT-M6 (2) + R5: witnessedRead consults the lock only when the retry is still transition-interrupted, then always reads once more', () => {
  const old = Buffer.from('row-one\n');
  const target = Buffer.from('row-one\nfence\n');

  it('interrupted twice, a live rewriter waited for -> a third read, whose verdict is used (in-sync)', () => {
    const w = sequence(pending(target), pending(target), at(target));
    const l = sequence({ bytes: old }, { bytes: old }, { bytes: target });
    let waits = 0;
    const out = witnessedRead(w.read, l.read, () => { waits += 1; return true; });
    expect(out.verdict.kind).toBe('in-sync');
    expect(waits).toBe(1);
    expect(w.calls()).toBe(3);
    expect(l.calls()).toBe(3);
  });

  it('R5: no live holder (the consultation returns at once) -> STILL a third read, whose verdict is used', () => {
    // The rewrite landed and released after read pair #2: the consultation finds nothing to wait for,
    // and the third read sees the settled scope instead of returning the stale interrupted verdict.
    const w = sequence(pending(target), pending(target), at(target));
    const l = sequence({ bytes: old }, { bytes: old }, { bytes: target });
    let consulted = 0;
    // The consultation's answer is not read (R5): `false` here must not skip the third read.
    const out = witnessedRead(w.read, l.read, () => { consulted += 1; return false; });
    expect(out.verdict.kind).toBe('in-sync');
    expect(consulted).toBe(1);
    expect(w.calls()).toBe(3);
    expect(l.calls()).toBe(3);
  });

  it('R5: whatever the consultation reports (none / released / timeout), exactly one more read pair, never a loop', () => {
    for (const outcome of ['none', 'released', 'timeout'] as const) {
      const settles = witnessedRead(sequence(pending(target), pending(target), at(target)).read,
        sequence({ bytes: old }, { bytes: old }, { bytes: target }).read, () => outcome);
      expect(settles.verdict.kind, outcome).toBe('in-sync');
      const w = sequence(pending(target));
      const l = sequence({ bytes: old });
      const stays = witnessedRead(w.read, l.read, () => outcome);
      expect(stays.verdict.kind, outcome).toBe('transition-interrupted');
      expect(w.calls(), outcome).toBe(3);
      expect(l.calls(), outcome).toBe(3);
    }
  });

  it('still interrupted after the wait -> kept as is (the wait never relaxes the verdict, never loops)', () => {
    const w = sequence(pending(target));
    const l = sequence({ bytes: old });
    let waits = 0;
    const out = witnessedRead(w.read, l.read, () => { waits += 1; return true; });
    expect(out.verdict.kind).toBe('transition-interrupted');
    expect(waits).toBe(1);
    expect(w.calls()).toBe(3);
  });

  it('a mismatch after the retry, or an alarm the retry resolves, never consults the wait', () => {
    let waits = 0;
    const wait = (): boolean => { waits += 1; return true; };
    const short = Buffer.from('row');                                   // not a prefix of `target` -> mismatch vs at(target)
    const mm = witnessedRead(sequence(at(target)).read, sequence({ bytes: short }).read, wait);
    expect(mm.verdict.kind).toBe('mismatch');
    const resolved = witnessedRead(sequence(pending(target), at(target)).read, sequence({ bytes: old }, { bytes: target }).read, wait);
    expect(resolved.verdict.kind).toBe('in-sync');
    expect(waits).toBe(0);
  });

  it('omitting the wait keeps the pre-IT-M6 behaviour (two read pairs at most)', () => {
    const w = sequence(pending(target));
    const l = sequence({ bytes: old });
    expect(witnessedRead(w.read, l.read).verdict.kind).toBe('transition-interrupted');
    expect(w.calls()).toBe(2);
  });
});

describe('IT-M6 (2): awaitLiveHolder reads the ledger lock and never takes it', () => {
  it('no lock file -> none', () => {
    const home = newHome();
    try { expect(awaitLiveHolder(join(home, 'memory.jsonl'), { maxWaitMs: 2_000 })).toBe('none'); }
    finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a ledger whose directory does not exist -> none (lockPathOf cannot resolve it)', () => {
    const home = newHome();
    try { expect(awaitLiveHolder(join(home, 'absent-dir', 'memory.jsonl'), { maxWaitMs: 2_000 })).toBe('none'); }
    finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a dead holder -> none at once, and its lock file is left exactly as it was', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      writeFileSync(ledger, '');
      const lockPath = deadHolderLock(ledger);
      const bytes = readFileSync(lockPath);
      const t0 = performance.now();
      expect(awaitLiveHolder(ledger, { maxWaitMs: 2_000 })).toBe('none');
      expect(performance.now() - t0).toBeLessThan(500);
      expect(readFileSync(lockPath).equals(bytes)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("this thread's own lock (reentrant-self) -> none: a writer never waits on itself", () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      writeFileSync(ledger, '');
      const out = lockMod.withFileLock(ledger, () => awaitLiveHolder(ledger, { maxWaitMs: 2_000 }));
      expect(out).toBe('none');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a live holder that releases during the wait -> released, after the release and not before', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      writeFileSync(ledger, '');
      const lockPath = liveHolderLock(ledger);
      const pauses: number[] = [];
      const out = awaitLiveHolder(ledger, {
        maxWaitMs: 2_000, pollMs: 25,
        sleep: (ms) => { pauses.push(ms); if (pauses.length === 3) unlinkSync(lockPath); },
      });
      expect(out).toBe('released');
      expect(pauses).toEqual([25, 25, 25]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a lock re-taken by another acquisition counts as released (the holder we saw let go)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      writeFileSync(ledger, '');
      const lockPath = liveHolderLock(ledger);
      const out = awaitLiveHolder(ledger, {
        maxWaitMs: 2_000,
        sleep: () => { unlinkSync(lockPath); liveHolderLock(ledger); },
      });
      expect(out).toBe('released');
      expect(existsSync(lockPath)).toBe(true);   // the new holder's lock is untouched
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a live holder that never releases -> timeout once the budget is spent', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      writeFileSync(ledger, '');
      liveHolderLock(ledger);
      const t0 = performance.now();
      expect(awaitLiveHolder(ledger, { maxWaitMs: 120, pollMs: 25 })).toBe('timeout');
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(115);
      expect(elapsed).toBeLessThan(1_000);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('an unparseable lock written in this boot classifies alive-unknown and is waited for', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      writeFileSync(ledger, '');
      writeFileSync(lockPathOf(ledger), 'not a lock payload');
      expect(awaitLiveHolder(ledger, { maxWaitMs: 60, pollMs: 25 })).toBe('timeout');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  // L1: the wait applies the acquirer's own classification (readLockHolder), legacy lock DIRECTORY
  // included — its owner file's pid decides, exactly as acquireFileLock's contention branch decides.
  it('a legacy lock directory: a live owner pid is waited for, a dead one is not', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      writeFileSync(ledger, '');
      const lockPath = lockPathOf(ledger);
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, 'owner'), `${process.pid}-cafe`);   // a live legacy holder (this process)
      expect(awaitLiveHolder(ledger, { maxWaitMs: 60, pollMs: 25 })).toBe('timeout');
      writeFileSync(join(lockPath, 'owner'), `${deadPid()}-cafe`);     // a dead legacy holder
      expect(awaitLiveHolder(ledger, { maxWaitMs: 2_000 })).toBe('none');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('the production budget is 2,000 ms at 25 ms polls', () => {
    expect(REWRITER_WAIT_MAX_MS).toBe(2_000);
    expect(REWRITER_WAIT_POLL_MS).toBe(25);
  });
});

describe('IT-M6 (2): the real read paths over a planted window A', () => {
  function seeded(): { home: string; s: MemoryStore; ledger: string; land: () => void } {
    const home = newHome();
    const { store: s, ledger } = store(home);
    s.commit({ content: 'alpha deploy fact', source: 'user' });
    s.commit({ content: 'bravo deploy fact', source: 'user' });
    const { land } = plantWindowA(home, ledger);
    return { home, s, ledger, land };
  }

  it('no lock: the interrupted verdict comes back at once (no wait), as before IT-M6', () => {
    const { home, ledger } = seeded();
    try {
      const t0 = performance.now();
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('transition-interrupted');
      expect(performance.now() - t0).toBeLessThan(500);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('dead holder: no wait, interrupted', () => {
    const { home, ledger } = seeded();
    const w = spyWait({ sleep: () => { throw new Error('a dead holder must not be waited for'); } });
    try {
      deadHolderLock(ledger);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('transition-interrupted');
      expect(w.calls()).toBe(1);
    } finally { w.restore(); rmSync(home, { recursive: true, force: true }); }
  });

  it('live holder that lands the rewrite and releases: inspect and SessionStart both serve the records, no note', () => {
    const { home, s, ledger, land } = seeded();
    let lockPath = '';
    const finish = (): void => { land(); unlinkSync(lockPath); };
    const w = spyWait({ sleep: () => { if (existsSync(lockPath)) finish(); } });
    try {
      lockPath = liveHolderLock(ledger);
      const view = s.currentView();                                  // inspect's current path
      expect(view.witnessNotes).not.toContain(WITNESS_TRANSITION_NOTE);
      expect(view.records.map((r) => r.record.content).sort()).toEqual(['alpha deploy fact', 'bravo deploy fact']);
      expect(w.calls()).toBe(1);

      const { land: land2 } = plantWindowA(home, ledger);            // a second rewrite, same holder shape
      lockPath = liveHolderLock(ledger);
      const finish2 = (): void => { land2(); unlinkSync(lockPath); };
      w.restore();
      const w2 = spyWait({ sleep: () => { if (existsSync(lockPath)) finish2(); } });
      try {
        const g = gatherScopedRecords({ home, globalLedger: ledger });   // SessionStart
        expect(g.witnessNotes).not.toContain(WITNESS_TRANSITION_NOTE);
        expect(g.records.map((r) => r.record.content).sort()).toEqual(['alpha deploy fact', 'bravo deploy fact']);
        expect(w2.calls()).toBe(1);
      } finally { w2.restore(); }
    } finally { w.restore(); rmSync(home, { recursive: true, force: true }); }
  });

  it('live holder that lands the rewrite and releases: recall (the bytes-only read path) serves the records, no note', () => {
    // recall reads through readLedgerBytesWitnessed, not readLedgerWitnessed: its wait is wired separately.
    const { home, s, ledger, land } = seeded();
    let lockPath = '';
    const finish = (): void => { land(); unlinkSync(lockPath); };
    const w = spyWait({ sleep: () => { if (existsSync(lockPath)) finish(); } });
    try {
      lockPath = liveHolderLock(ledger);
      const out = s.recall('deploy fact');
      expect(out.witnessNotes).not.toContain(WITNESS_TRANSITION_NOTE);
      expect(out.items.map((i) => i.record.content).sort()).toEqual(['alpha deploy fact', 'bravo deploy fact']);
      expect(w.calls()).toBe(1);
    } finally { w.restore(); rmSync(home, { recursive: true, force: true }); }
  });

  it('R5: a rewriter that lands and releases between the retry and the lock check is no longer missed — the check finds no lock, the scope is read once more, and the settled verdict is returned', () => {
    const { home, s, ledger, land } = seeded();
    const real = lockMod.awaitLiveHolder;
    // Constructed interleaving: the holder finishes (lands + releases) in the gap between read pair #2
    // and the lock check. The check then finds no lock ('none'), and the third read sees the completed
    // transition.
    const outcomes: string[] = [];
    const spy = vi.spyOn(lockMod, 'awaitLiveHolder').mockImplementation((target, opts) => {
      land();
      const o = real(target, opts);
      outcomes.push(o);
      return o;
    });
    try {
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('in-sync');
      expect(outcomes).toEqual(['none']);                                   // no lock at the check: nothing was waited for
      const { land: land2 } = plantWindowA(home, ledger);                  // the same race on inspect's current path
      spy.mockImplementation((target, opts) => { land2(); return real(target, opts); });
      const view = s.currentView();
      expect(view.witnessNotes).not.toContain(WITNESS_TRANSITION_NOTE);
      expect(view.records.map((r) => r.record.content).sort()).toEqual(['alpha deploy fact', 'bravo deploy fact']);
    } finally { spy.mockRestore(); rmSync(home, { recursive: true, force: true }); }
  });

  it('live holder past the budget: the note and the exclusion stay, and the wait wrote nothing', () => {
    const { home, s, ledger } = seeded();
    const w = spyWait({ maxWaitMs: 100 });
    try {
      const lockPath = liveHolderLock(ledger);
      const lockBytes = readFileSync(lockPath);
      const witnessBytes = readFileSync(witnessPath(home));
      const t0 = performance.now();
      const view = s.currentView();
      expect(performance.now() - t0).toBeGreaterThanOrEqual(95);
      expect(view.witnessNotes).toContain(WITNESS_TRANSITION_NOTE);
      expect(view.records).toEqual([]);
      expect(readFileSync(lockPath).equals(lockBytes)).toBe(true);          // lock untouched
      expect(readFileSync(witnessPath(home)).equals(witnessBytes)).toBe(true); // no transition opened/advanced/cleared
    } finally { w.restore(); rmSync(home, { recursive: true, force: true }); }
  });
});
