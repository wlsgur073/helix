import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orphanTmpPattern, sweepOrphanTmps } from '../../src/memory/ledger-sweep.js';
import { realFsOps } from '../../src/memory/fs-ops.js';

const HEX = 'a'.repeat(32);
const HEX_B = 'b'.repeat(32);

/** Schedules a real deletion between readdir and unlink, reproducing the observed production race
 *  exactly: `readdir` reports the name, the other process's own cleanup removes it, our unlink then
 *  hits a path that no longer exists. The victim is destroyed with the REAL fs, so the production
 *  `unlinkSync` raises a genuine ENOENT carrying `.code` — nothing about the error is synthetic. */
const vanishAfterReaddir = (victim: string, extra: Partial<typeof realFsOps> = {}) => ({
  ...realFsOps,
  readdirSync: (dir: string) => { const names = realFsOps.readdirSync(dir); realFsOps.unlinkSync(victim); return names; },
  ...extra,
});

const errno = (code: string) => () => { throw Object.assign(new Error(`fake ${code}`), { code }); };

describe('orphanTmpPattern', () => {
  const pat = orphanTmpPattern('memory.jsonl');
  it('matches exactly the three artifact classes + legacy pid tmps', () => {
    for (const good of [`memory.jsonl.c-${HEX}.tmp`, `memory.jsonl.lk-${HEX}.tmp`, `memory.jsonl.k-${HEX}.tmp`, 'memory.jsonl.12345.tmp'])
      expect(pat.test(good)).toBe(true);
  });
  it('near-misses are NOT swept: user backups, other ledgers, short/long hex, our lock, gates', () => {
    for (const bad of ['memory.jsonl.backup.tmp', 'memory.jsonl.tmp', 'other.jsonl.c-' + HEX + '.tmp', `memory.jsonl.c-${'a'.repeat(31)}.tmp`, `memory.jsonl.c-${'a'.repeat(33)}.tmp`, `memory.jsonl.c-${'A'.repeat(32)}.tmp`, 'memory.jsonl.lock', `memory.jsonl.lock.reap.boot`, 'memory.jsonlX.12.tmp'])
      expect(pat.test(bad)).toBe(false);
  });
  it('regex metacharacters in the basename are escaped (a dot is a dot)', () => {
    expect(orphanTmpPattern('a.b').test(`aXb.c-${HEX}.tmp`)).toBe(false);
  });
});

describe('sweepOrphanTmps', () => {
  it('removes matching orphans, keeps `keep`, ignores near-misses, returns the count', () => {
    const d = mkdtempSync(join(tmpdir(), 'sweep-'));
    const ledger = join(d, 'memory.jsonl'); writeFileSync(ledger, '');
    const orphan1 = join(d, `memory.jsonl.c-${HEX}.tmp`); writeFileSync(orphan1, 'PRE-ERASE PLAINTEXT');
    const orphan2 = join(d, 'memory.jsonl.4242.tmp'); writeFileSync(orphan2, 'legacy pid tmp');
    const keepMe = join(d, `memory.jsonl.c-${'b'.repeat(32)}.tmp`); writeFileSync(keepMe, 'ours');
    const user = join(d, 'memory.jsonl.backup.tmp'); writeFileSync(user, 'user file');
    expect(sweepOrphanTmps(ledger, { keep: keepMe })).toBe(2);
    expect(existsSync(orphan1)).toBe(false);
    expect(existsSync(orphan2)).toBe(false);
    expect(existsSync(keepMe)).toBe(true);
    expect(existsSync(user)).toBe(true);
  });
  it('THROWS when a matching orphan cannot be unlinked (abort semantics), and when readdir fails', () => {
    const d = mkdtempSync(join(tmpdir(), 'sweep2-'));
    const ledger = join(d, 'memory.jsonl'); writeFileSync(ledger, '');
    writeFileSync(join(d, `memory.jsonl.c-${HEX}.tmp`), 'x');
    const failingUnlink = { ...realFsOps, unlinkSync: () => { throw new Error('EACCES fake'); } };
    expect(() => sweepOrphanTmps(ledger, { fsOps: failingUnlink })).toThrow(/EACCES fake/);
    const failingReaddir = { ...realFsOps, readdirSync: () => { throw new Error('EIO fake'); } };
    expect(() => sweepOrphanTmps(ledger, { fsOps: failingReaddir })).toThrow(/EIO fake/);
  });
  it('an orphan that VANISHES between readdir and unlink does not abort the sweep', () => {
    // Production race, root-caused 2026-07-29 from a 1-in-30 suite flake: a lock CONTENDER writes
    // `<artifact>.lk-<hex>.tmp` while it does NOT yet hold the lock (src/memory/lock.ts:75) and
    // removes it again in a finally that already tolerates a holder sweeping it first
    // (lock.ts:79, "swept by a holder mid-flight — harmless"). The holder's sweep had no such
    // tolerance, so whoever lost the unlink race threw ENOENT and killed the process. Reachable
    // from every commit/erase append via ledger.ts:80, not only from the observed key mint.
    const d = mkdtempSync(join(tmpdir(), 'sweep-race-'));
    const ledger = join(d, 'memory.jsonl'); writeFileSync(ledger, '');
    const victim = join(d, `memory.jsonl.lk-${HEX}.tmp`); writeFileSync(victim, 'a contender lock payload');
    const survivor = join(d, `memory.jsonl.c-${HEX_B}.tmp`); writeFileSync(survivor, 'a genuinely dead writer');
    const user = join(d, 'memory.jsonl.backup.tmp'); writeFileSync(user, 'user file');
    const calls: string[] = [];
    const fsOps = vanishAfterReaddir(victim, { fsyncDir: (p: string) => { calls.push(p); realFsOps.fsyncDir(p); } });

    expect(sweepOrphanTmps(ledger, { fsOps })).toBe(1);   // the vanished one is NOT counted: we removed nothing
    expect(existsSync(survivor)).toBe(false);             // and the sweep CONTINUED past the ENOENT
    expect(existsSync(victim)).toBe(false);               // Layer-4 postcondition holds whoever's hand removed it
    expect(existsSync(user)).toBe(true);
    expect(calls).toEqual([d]);                           // one real removal still earns exactly one dir fsync
  });

  it('a sweep whose ONLY match vanished removes nothing and does not fsync the directory', () => {
    const d = mkdtempSync(join(tmpdir(), 'sweep-race2-'));
    const ledger = join(d, 'memory.jsonl'); writeFileSync(ledger, '');
    const victim = join(d, `memory.jsonl.lk-${HEX}.tmp`); writeFileSync(victim, 'x');
    const calls: string[] = [];
    const fsOps = vanishAfterReaddir(victim, { fsyncDir: (p: string) => { calls.push(p); realFsOps.fsyncDir(p); } });

    expect(sweepOrphanTmps(ledger, { fsOps })).toBe(0);
    expect(calls).toHaveLength(0);   // no directory entry changed by US, so nothing of ours needs persisting
  });

  it('STILL throws on a coded failure that leaves the orphan present (ENOENT tolerance is not a blanket catch)', () => {
    // The class boundary, stated in both directions. Deliberately code-CARRYING, because the
    // code-less fakes above cannot distinguish an errno check from a message match.
    for (const code of ['EACCES', 'EPERM', 'EIO', 'EBUSY']) {
      const d = mkdtempSync(join(tmpdir(), 'sweep-errno-'));
      const ledger = join(d, 'memory.jsonl'); writeFileSync(ledger, '');
      const orphan = join(d, `memory.jsonl.c-${HEX}.tmp`); writeFileSync(orphan, 'x');
      expect(() => sweepOrphanTmps(ledger, { fsOps: { ...realFsOps, unlinkSync: errno(code) } })).toThrow(new RegExp(`fake ${code}`));
      expect(existsSync(orphan)).toBe(true);   // an unfenceable predecessor must still block the successor
    }
  });

  it('discriminates on errno and NOT on the message: an ENOENT-mentioning EACCES still throws', () => {
    // The only input that separates `e.code === 'ENOENT'` from a `/ENOENT/` message match, and
    // therefore the only test that backs the claim in the source comment. Composed and wrapped
    // errors really do carry another process's errno text in their message; the code is the
    // authoritative signal. Mutation-verified: a message-matched implementation fails only here.
    const d = mkdtempSync(join(tmpdir(), 'sweep-errno2-'));
    const ledger = join(d, 'memory.jsonl'); writeFileSync(ledger, '');
    const orphan = join(d, `memory.jsonl.c-${HEX}.tmp`); writeFileSync(orphan, 'x');
    const misleading = () => { throw Object.assign(new Error('EACCES: permission denied while clearing an ENOENT leftover'), { code: 'EACCES' }); };
    expect(() => sweepOrphanTmps(ledger, { fsOps: { ...realFsOps, unlinkSync: misleading } })).toThrow(/permission denied/);
    expect(existsSync(orphan)).toBe(true);
  });

  it('fsyncs the directory exactly when something was removed', () => {
    const d = mkdtempSync(join(tmpdir(), 'sweep3-'));
    const ledger = join(d, 'memory.jsonl'); writeFileSync(ledger, '');
    const calls: string[] = [];
    const rec = { ...realFsOps, fsyncDir: (p: string) => { calls.push(p); realFsOps.fsyncDir(p); } };
    sweepOrphanTmps(ledger, { fsOps: rec });
    expect(calls).toHaveLength(0);                                    // nothing removed -> no dir fsync
    writeFileSync(join(d, `memory.jsonl.c-${HEX}.tmp`), 'x');
    sweepOrphanTmps(ledger, { fsOps: rec });
    expect(calls).toEqual([d]);                                       // removed -> exactly one dir fsync
  });
});
