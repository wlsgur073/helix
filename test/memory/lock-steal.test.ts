import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock, lockPathOf, writeLockFileForTest } from '../../src/memory/lock.js';
import { selfIdentity, realProbe } from '../../src/memory/lock-liveness.js';

const target = (): string => { const d = mkdtempSync(join(tmpdir(), 'helix-steal-')); writeFileSync(join(d, 'ledger.jsonl'), ''); return join(d, 'ledger.jsonl'); };
const deadPid = (): number => spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid!;

describe('reaper-gated stealing', () => {
  it('a DEAD holder (real exited pid) is reclaimed and acquisition proceeds', () => {
    const t = target();
    writeLockFileForTest(lockPathOf(t), { ...selfIdentity('a'.repeat(32)), pid: deadPid(), threadId: 5 });
    let ran = false;
    withFileLock(t, () => { ran = true; }, { maxWaitMs: 2_000 });
    expect(ran).toBe(true);
    expect(existsSync(lockPathOf(t))).toBe(false);                       // released cleanly after steal+acquire
    expect(readdirSync(join(t, '..')).filter((n) => n.includes('.reap.'))).toHaveLength(0); // gate released
  });
  it('dead LITTER (unparseable lock whose mtime predates boot) is reclaimed', () => {
    const t = target();
    writeFileSync(lockPathOf(t), '');                                     // empty/malformed
    const preBoot = new Date((realProbe.bootInstantMs() ?? Date.now()) - 60_000);
    utimesSync(lockPathOf(t), preBoot, preBoot);
    let ran = false;
    withFileLock(t, () => { ran = true; }, { maxWaitMs: 2_000 });
    expect(ran).toBe(true);
  });
  it('malformed lock with SAME-BOOT mtime is NEVER reclaimed (alive-unknown, fail closed)', () => {
    const t = target();
    writeFileSync(lockPathOf(t), '{not json');                            // fresh mtime = now (same boot)
    expect(() => withFileLock(t, () => 1, { maxWaitMs: 200 })).toThrow(/timed out|unreadable/i);
    expect(readFileSync(lockPathOf(t), 'utf8')).toBe('{not json');
  });
  it('a SAME-BOOT gate blocks stealing (fail-closed) even when the main holder is dead', () => {
    const t = target();
    writeLockFileForTest(lockPathOf(t), { ...selfIdentity('b'.repeat(32)), pid: deadPid(), threadId: 5 });
    const gate = `${lockPathOf(t)}.reap.${realProbe.bootId() ?? 'noboot'}`;
    writeFileSync(gate, JSON.stringify({ ...selfIdentity('c'.repeat(32)), threadId: 77 })); // a live reaper holds the gate
    expect(() => withFileLock(t, () => 1, { maxWaitMs: 300 })).toThrow(/timed out/i);
    expect(existsSync(lockPathOf(t))).toBe(true);                         // victim untouched — steal never ran
    rmSync(gate);
  });
  it('an OTHER-BOOT gate is inert litter: removed, then the steal proceeds', () => {
    const t = target();
    writeLockFileForTest(lockPathOf(t), { ...selfIdentity('d'.repeat(32)), pid: deadPid(), threadId: 5 });
    writeFileSync(`${lockPathOf(t)}.reap.previous-boot-id`, 'stale');
    let ran = false;
    withFileLock(t, () => { ran = true; }, { maxWaitMs: 2_000 });
    expect(ran).toBe(true);
    expect(existsSync(`${lockPathOf(t)}.reap.previous-boot-id`)).toBe(false);
  });
  it('legacy DIR with a DEAD owner pid is reclaimed; with a LIVE pid it is not; ownerless NEVER', () => {
    const t1 = target(); mkdirSync(lockPathOf(t1));
    writeFileSync(join(lockPathOf(t1), 'owner'), `${deadPid()}-cafe`);   // dead legacy holder
    let ran = false;
    withFileLock(t1, () => { ran = true; }, { maxWaitMs: 2_000 });
    expect(ran).toBe(true);

    const t2 = target(); mkdirSync(lockPathOf(t2));
    writeFileSync(join(lockPathOf(t2), 'owner'), `${process.pid}-cafe`); // live legacy holder
    expect(() => withFileLock(t2, () => 1, { maxWaitMs: 200 })).toThrow(/timed out/i);

    const t3 = target(); mkdirSync(lockPathOf(t3));                      // ownerless: suspended-in-stamp-gap
    const preBoot = new Date((realProbe.bootInstantMs() ?? Date.now()) - 60_000);
    utimesSync(lockPathOf(t3), preBoot, preBoot);                        // even pre-boot age must not matter
    expect(() => withFileLock(t3, () => 1, { maxWaitMs: 200 })).toThrow(/timed out/i);
  });
  it('the steal ABANDONS when the lock changed between classify and unlink (token re-read)', () => {
    // Deterministic via an injected probe that flips the victim to alive after the first classify:
    const t = target();
    const victim = { ...selfIdentity('e'.repeat(32)), pid: deadPid(), threadId: 5 };
    writeLockFileForTest(lockPathOf(t), victim);
    let classifications = 0;
    const probe = { ...realProbe, kill0: (pid: number) => { classifications++; if (classifications === 1) { writeFileSync(lockPathOf(t), JSON.stringify({ ...selfIdentity('f'.repeat(32)), threadId: 78 })); } return realProbe.kill0(pid); } };
    expect(() => withFileLock(t, () => 1, { maxWaitMs: 300, probe })).toThrow(/timed out/i);
    expect(readFileSync(lockPathOf(t), 'utf8')).toContain('f'.repeat(32)); // the replacement survived — never unlinked
  });
});
