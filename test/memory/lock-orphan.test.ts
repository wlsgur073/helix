// v-firstwrite-05 / t-04: a lock whose release could not prove ownership (the folder it stands in was replaced while
// it was held) is remembered by (path, token) and taken down by this thread's next acquisition once its own token
// stands at the path again. Bounded at 64 pairs, oldest dropped first. A real re-entrant call is still refused.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, renameSync, rmdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lockMod from '../../src/memory/lock.js';
import { withFileLock, lockPathOf, writeLockFileForTest } from '../../src/memory/lock.js';
import { realProbe } from '../../src/memory/lock-liveness.js';
import { MemoryStore } from '../../src/memory/store.js';
import { projectLedgerPath } from '../../src/memory/ownership.js';
import { readLedgerBytes } from '../../src/memory/ledger.js';
import * as witnessStoreMod from '../../src/memory/witness-store.js';

const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
/** Hold the lock of <dir>/t.jsonl, replace the folder by another one while it is held; the release finds nothing. */
function releaseIntoSwappedFolder(dir: string): string {
  const target = join(dir, 't.jsonl');
  withFileLock(target, () => { renameSync(dir, `${dir}-real`); mkdirSync(dir); });
  return target;
}
const putFolderBack = (dir: string): void => { rmdirSync(dir); renameSync(`${dir}-real`, dir); };

describe('an unreleased own lock (v-firstwrite-05)', () => {
  it('the next acquisition of the SAME path takes it down and succeeds, instead of "re-entrant acquisition"', () => {
    const root = tmp('helix-orphan-a-'); const dir = join(root, 'f'); mkdirSync(dir);
    try {
      const target = releaseIntoSwappedFolder(dir);
      putFolderBack(dir);
      expect(existsSync(lockPathOf(target)), 'precondition: the lock stands at its path').toBe(true);
      expect(withFileLock(target, () => 'again')).toBe('again');
      expect(existsSync(lockPathOf(target))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(`${root}/f-real`, { recursive: true, force: true }); }
  });

  it('an acquisition of ANOTHER path takes it down too (other processes wait on it only until then)', () => {
    const root = tmp('helix-orphan-b-'); const dir = join(root, 'f'); mkdirSync(dir);
    try {
      const target = releaseIntoSwappedFolder(dir);
      putFolderBack(dir);
      expect(withFileLock(join(root, 'other.jsonl'), () => 'other')).toBe('other');
      expect(existsSync(lockPathOf(target))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a folder that returns after the look in front of the loop: the own lock is taken down in the loop, not refused as re-entrant', () => {
    const root = tmp('helix-orphan-e-'); const dir = join(root, 'f'); mkdirSync(dir);
    try {
      const target = releaseIntoSwappedFolder(dir);
      let samples = 0;
      // selfIdentity samples the uptime once, before the look; the second sample is the loop's first pass, after it.
      const probe = { ...realProbe, uptimeSec: () => { if (++samples === 2) putFolderBack(dir); return realProbe.uptimeSec(); } };
      expect(withFileLock(target, () => 'again', { probe })).toBe('again');
      expect(samples, 'the folder came back').toBeGreaterThanOrEqual(2);
      expect(existsSync(lockPathOf(target))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a REAL re-entrant call is still refused, and the held lock is not taken down by it', () => {
    const root = tmp('helix-orphan-c-'); const t = join(root, 't.jsonl'); writeFileSync(t, '');
    try {
      withFileLock(t, () => {
        expect(() => withFileLock(t, () => 1)).toThrow(/re-entrant/);
        expect(existsSync(lockPathOf(t))).toBe(true);
      });
      expect(existsSync(lockPathOf(t))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("another holder's lock at a remembered path is never taken down (the proof is the token, not the pid)", () => {
    const root = tmp('helix-orphan-d-'); const t = join(root, 't.jsonl'); writeFileSync(t, '');
    try {
      const lp = lockPathOf(t);
      const seen: { p: { token: string; threadId: number } | null } = { p: null };
      withFileLock(t, () => { seen.p = JSON.parse(readFileSync(lp, 'utf8')); renameSync(lp, `${lp}.away`); });   // the release finds nothing
      const foreign = { ...seen.p!, token: 'ab'.repeat(16), threadId: seen.p!.threadId + 1000 };   // this pid, another thread: classifies alive
      writeLockFileForTest(lp, foreign);
      expect(() => withFileLock(t, () => 1, { maxWaitMs: 150 })).toThrow(/timed out/);
      expect(JSON.parse(readFileSync(lp, 'utf8')).token).toBe(foreign.token);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('remembers at most 64 pairs: the oldest is dropped (its lock is left where it stands), the newest are kept', () => {
    const root = tmp('helix-orphan-cap-');
    const lockOf = (i: number): string => lockPathOf(join(root, `l${i}.jsonl`));
    try {
      for (let i = 0; i < 65; i++) {
        const t = join(root, `l${i}.jsonl`);
        withFileLock(t, () => { renameSync(lockPathOf(t), `${lockPathOf(t)}.away`); });   // the release finds nothing at the path
      }
      expect(lockMod.orphanedOwnLockCount()).toBe(64);
      for (const i of [0, 1, 64]) renameSync(`${lockOf(i)}.away`, lockOf(i));             // three locks stand at their paths again
      withFileLock(join(root, 'other.jsonl'), () => 1);                                    // any acquisition reclaims what it can prove
      expect(existsSync(lockOf(0)), 'pair 0 was dropped: nothing may remove it on a pid').toBe(true);
      expect(existsSync(lockOf(1))).toBe(false);
      expect(existsSync(lockOf(64))).toBe(false);
    } finally {
      for (let i = 2; i < 64; i++) { try { renameSync(`${lockOf(i)}.away`, lockOf(i)); } catch { /* not there */ } }
      try { withFileLock(join(root, 'other.jsonl'), () => 1); } catch { /* best effort: no pair outlives the test */ }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a project commit whose memory folder is replaced during the write (v-firstwrite-05, through the store)', () => {
  it("the SAME process's next project commit is stored once the folder is back, and no lock file is left", () => {
    const home = tmp('helix-orphan-home-'); const root = tmp('helix-orphan-proj-');
    const ledger = projectLedgerPath(root);
    let n = 0;
    const s = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's', now: () => '2026-10-01T00:00:00.000Z', genId: () => `m_${++n}`, project: { root, ledger } });
    const realAdvance = witnessStoreMod.advanceWitness;
    const folder = join(root, '.helix');
    try {
      s.commit({ content: 'alpha deploy fact', source: 'user', scope: 'project' });   // adopts the project; the folder exists
      const spy = vi.spyOn(witnessStoreMod, 'advanceWitness').mockImplementationOnce((...a: Parameters<typeof realAdvance>) => {
        renameSync(folder, `${folder}-real`); mkdirSync(folder);                       // another folder stands at the name while the ledger lock is held
        return realAdvance(...a);
      });
      const before = lockMod.orphanedOwnLockCount();
      // The swap is visible to whatever the commit reads after its append; the lock state is what this test measures, and the
      // assertions below fail if the commit did not reach the swap (no remembered pair) or its row did not land.
      try { s.commit({ content: 'bravo deploy fact', source: 'user', scope: 'project' }); } catch { /* see above */ }
      spy.mockRestore();
      expect(lockMod.orphanedOwnLockCount()).toBe(before + 1);
      rmSync(folder, { recursive: true, force: true }); renameSync(`${folder}-real`, folder);   // the folder returns
      expect(existsSync(lockPathOf(ledger)), 'precondition: the second commit\'s lock was not released').toBe(true);
      expect(() => s.commit({ content: 'charlie deploy fact', source: 'user', scope: 'project' })).not.toThrow();
      const text = readLedgerBytes(ledger).toString('utf8');
      expect(text).toContain('alpha deploy fact'); expect(text).toContain('bravo deploy fact'); expect(text).toContain('charlie deploy fact');
      expect(existsSync(lockPathOf(ledger))).toBe(false);
      expect(lockMod.orphanedOwnLockCount()).toBe(before);
    } finally { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); rmSync(`${folder}-real`, { recursive: true, force: true }); }
  });
});
