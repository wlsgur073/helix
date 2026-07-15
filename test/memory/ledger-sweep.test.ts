import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orphanTmpPattern, sweepOrphanTmps } from '../../src/memory/ledger-sweep.js';
import { realFsOps } from '../../src/memory/fs-ops.js';

const HEX = 'a'.repeat(32);

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
