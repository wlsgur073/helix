import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, unlinkSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooks = vi.hoisted(() => ({
  onLstat: null as null | ((p: string) => void),      // before the real lstat: can answer for it by throwing
  afterLstat: null as null | ((p: string) => void),   // after it: the object changes between the look and the open
  links: [] as string[],
}));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    lstatSync: (p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string') hooks.onLstat?.(p);
      const st = (real.lstatSync as (...a: unknown[]) => unknown)(p, ...rest);
      if (typeof p === 'string') hooks.afterLstat?.(p);
      return st;
    },
    linkSync: (src: unknown, dest: unknown) => {
      if (typeof dest === 'string') hooks.links.push(dest);
      return (real.linkSync as (...a: unknown[]) => unknown)(src, dest);
    },
  };
});
import { withFileLock, lockPathOf, writeLockFileForTest, isLockForeignObjectError } from '../../src/memory/lock.js';
import { selfIdentity } from '../../src/memory/lock-liveness.js';

const enoent = (): NodeJS.ErrnoException => Object.assign(new Error('ENOENT: injected'), { code: 'ENOENT' });
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
function fixture(): { ledger: string; lockPath: string } {
  const d = mkdtempSync(join(tmpdir(), 'helix-absent-'));
  const ledger = join(d, 'ledger.jsonl');
  writeFileSync(ledger, '');
  const lockPath = lockPathOf(ledger);
  // A live holder, so every publish fails with EEXIST and the reading after it is the one under test.
  writeLockFileForTest(lockPath, { ...selfIdentity('f'.repeat(32)), threadId: 99 });
  hooks.links.length = 0;   // the plant goes through the same mocked linkSync; only the acquirer's publications are counted
  return { ledger, lockPath };
}
beforeEach(() => { hooks.onLstat = null; hooks.afterLstat = null; hooks.links.length = 0; });

describe('the absent row (spec 4.5, decision 8 locks-R3)', () => {
  it('a lock that is free at the end of the budget is taken by one more publication, never refused', () => {
    const { ledger, lockPath } = fixture();
    let readings = 0;
    hooks.onLstat = (p) => {
      if (p !== lockPath) return;
      if (++readings === 1) { pause(80); unlinkSync(lockPath); throw enoent(); }   // the budget (50 ms) ends inside this reading, and the holder let go
    };
    expect(withFileLock(ledger, () => 'ran', { maxWaitMs: 50 })).toBe('ran');
    expect(hooks.links.filter((d) => d === lockPath)).toHaveLength(2);   // the failed publication and the one more
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a lock that is absent at every reading is refused after exactly ONE more publication (no loop, no budget-free retry)', () => {
    const { ledger, lockPath } = fixture();
    let readings = 0;
    hooks.onLstat = (p) => {
      if (p !== lockPath) return;
      readings += 1;
      if (readings === 1) pause(80);                        // the budget (50 ms) is over at the first reading
      if (readings >= 200) { try { unlinkSync(lockPath); } catch { /* gone */ } }   // spin guard: a loop with no budget check ends here
      throw enoent();
    };
    expect(() => withFileLock(ledger, () => 'ran', { maxWaitMs: 50 })).toThrow(/timed out after \d+ms acquiring/);
    expect(readings).toBe(2);
    expect(hooks.links.filter((d) => d === lockPath)).toHaveLength(2);
    expect(existsSync(lockPath)).toBe(true);                // the live holder's lock was never touched
  });

  it('an absent reading inside the budget retries on the normal cadence and takes a lock that was released', () => {
    const { ledger, lockPath } = fixture();
    let readings = 0;
    hooks.onLstat = (p) => { if (p === lockPath && ++readings === 1) { unlinkSync(lockPath); throw enoent(); } };
    const t0 = performance.now();
    expect(withFileLock(ledger, () => 'ran', { maxWaitMs: 5_000 })).toBe('ran');
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe('a change between the look and the open (decision 8, locks-R2)', () => {
  it('a link that takes the name after the look is foreign: the open answers ELOOP and the acquirer refuses at once', () => {
    const { ledger, lockPath } = fixture();
    let swapped = false;
    let looks = 0;
    hooks.afterLstat = (p) => {
      if (p !== lockPath) return;
      looks += 1;
      if (swapped) return;
      swapped = true;
      renameSync(lockPath, `${lockPath}.elsewhere`);        // the live payload, one link away
      symlinkSync(`${lockPath}.elsewhere`, lockPath);
    };
    let thrown: unknown;
    try { withFileLock(ledger, () => 'ran', { maxWaitMs: 200 }); } catch (e) { thrown = e; }
    expect(swapped, 'the seam fired').toBe(true);
    expect(isLockForeignObjectError(thrown)).toBe(true);
    expect(looks, 'the open refused it: a second look would mean the open followed the link').toBe(1);
  });

  it('a lock released after the look reads absent at the open, and the next pass takes it', () => {
    const { ledger, lockPath } = fixture();
    let released = false;
    hooks.afterLstat = (p) => {
      if (p !== lockPath || released) return;
      released = true;
      unlinkSync(lockPath);
    };
    expect(withFileLock(ledger, () => 'ran', { maxWaitMs: 5_000 })).toBe('ran');
    expect(released, 'the seam fired').toBe(true);
  });
});
