// Third fix batch B1, task B5 (14 decision 8 t-07; 14 item 19): a lock wait that ran out of its budget carries a mark and
// its cause kind, so the store can give the adopt operation a fixed text chosen by the cause; nothing else carries it.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withFileLock, lockPathOf, writeLockFileForTest, isLockTimeoutError, lockTimeoutCauseOf, isLockForeignObjectError } from '../../src/memory/lock.js';
import { selfIdentity, realProbe } from '../../src/memory/lock-liveness.js';

const target = (): string => { const d = mkdtempSync(join(tmpdir(), 'helix-lockmark-')); writeFileSync(join(d, 'ledger.jsonl'), ''); return join(d, 'ledger.jsonl'); };
const thrown = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } return undefined; };
// A holder that is alive and cannot be identified: the wait runs to its budget (test/memory/lock.test.ts:197-205).
const unidentifiable = { ...realProbe, kill0: () => 'alive' as const, startTicksOf: () => null, stateOf: () => null };

describe('isLockTimeoutError and lockTimeoutCauseOf', () => {
  it('is true for the error of a wait that ran out of its budget behind a live holder, and the text still carries the lock path', () => {
    const t = target();
    writeLockFileForTest(lockPathOf(t), { ...selfIdentity('a'.repeat(32)), pid: 999_999, startTicks: '4242' });
    const e = thrown(() => withFileLock(t, () => 1, { maxWaitMs: 60, probe: unidentifiable }));
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/timed out/);
    expect(isLockTimeoutError(e)).toBe(true);
    expect(lockTimeoutCauseOf(e)).toBe('payload');
  });

  it('is true for the timeout of a lock file that does not parse', () => {
    const t = target();
    writeFileSync(lockPathOf(t), '{not json');
    const e = thrown(() => withFileLock(t, () => 1, { maxWaitMs: 80 }));
    expect(isLockTimeoutError(e)).toBe(true);
    expect(lockTimeoutCauseOf(e)).toBe('unparseable');
  });

  it('is true for the timeout of a holder that cannot be read or identified, and of a legacy lock directory', () => {
    const t = target();
    writeLockFileForTest(lockPathOf(t), { ...selfIdentity('b'.repeat(32)), pid: 999_999, startTicks: '4242', threadId: 5 });
    const probe = { ...realProbe, kill0() { throw new Error('injected'); } };
    const unreadable = thrown(() => withFileLock(t, () => 1, { maxWaitMs: 80, probe }));
    expect(isLockTimeoutError(unreadable)).toBe(true);
    expect(lockTimeoutCauseOf(unreadable)).toBe('unreadable');
    const u = target();
    mkdirSync(lockPathOf(u));
    writeFileSync(join(lockPathOf(u), 'owner'), `${process.pid}-cafe`);   // a live legacy holder
    const legacy = thrown(() => withFileLock(u, () => 1, { maxWaitMs: 80 }));
    expect(isLockTimeoutError(legacy)).toBe(true);
    expect(lockTimeoutCauseOf(legacy)).toBe('legacy-dir');
  });

  it('is true for the timeout of a lock whose folder went away, with the cause no-directory', () => {
    // The resolver refuses a target whose folder is absent before the lock layer runs, so the folder of a real target is
    // removed after the resolver: on the probe's first sample of the uptime, which every publish attempt takes.
    const t = target();
    let removed = false;
    const probe = { ...realProbe, uptimeSec: () => { if (!removed) { removed = true; rmSync(dirname(t), { recursive: true }); } return realProbe.uptimeSec(); } };
    const e = thrown(() => withFileLock(t, () => 1, { maxWaitMs: 80, probe }));
    expect(removed).toBe(true);
    expect(isLockTimeoutError(e)).toBe(true);
    expect(lockTimeoutCauseOf(e)).toBe('no-directory');
  });

  it('is false for a foreign object at the lock path, for an error raised inside the held section and for no error', () => {
    const t = target();
    symlinkSync(join(tmpdir(), 'helix-nowhere'), lockPathOf(t));
    const foreign = thrown(() => withFileLock(t, () => 1, { maxWaitMs: 80 }));
    expect(isLockForeignObjectError(foreign)).toBe(true);
    expect(isLockTimeoutError(foreign)).toBe(false);
    expect(lockTimeoutCauseOf(foreign)).toBeNull();
    const u = target();
    const inner = thrown(() => withFileLock(u, () => { throw new Error('timed out after 1ms (an inner error that only reads like one)'); }));
    expect(isLockTimeoutError(inner)).toBe(false);
    expect(lockTimeoutCauseOf(inner)).toBeNull();
    expect(isLockTimeoutError(undefined)).toBe(false);
    expect(lockTimeoutCauseOf(undefined)).toBeNull();
  });
});
