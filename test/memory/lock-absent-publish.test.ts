import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, unlinkSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooks = vi.hoisted(() => ({
  onLstat: null as null | ((p: string) => void),      // before the real lstat: can answer for it by throwing
  afterLstat: null as null | ((p: string) => void),   // after it: the object changes between the look and the open
  onLink: null as null | ((dest: string) => void),    // before the real link: the tmp is swept, the budget ends, a holder arrives
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
      if (typeof dest === 'string') { hooks.links.push(dest); hooks.onLink?.(dest); }
      return (real.linkSync as (...a: unknown[]) => unknown)(src, dest);
    },
  };
});
import { withFileLock, lockPathOf, writeLockFileForTest, isLockForeignObjectError } from '../../src/memory/lock.js';
import { selfIdentity, realProbe, type LivenessProbe } from '../../src/memory/lock-liveness.js';
import { sweepOrphanTmps } from '../../src/memory/ledger-sweep.js';

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
beforeEach(() => { hooks.onLstat = null; hooks.afterLstat = null; hooks.onLink = null; hooks.links.length = 0; });

const DYING_PID = 999_999;
const BUDGET_MS = 200;
const refusal = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return (e as Error).message; } };
/** kill0 answers alive for one pass, the budget ends inside its next answer, and the holder is dead from there on,
 *  so the reading and the steal of that pass are the last ones of the budget. Any other pid is alive. */
function dyingProbe(): LivenessProbe {
  let calls = 0;
  return {
    ...realProbe,
    startTicksOf: () => '4242',
    stateOf: () => 'S',
    kill0(pid) {
      if (pid !== DYING_PID) return 'alive';
      calls += 1;
      if (calls === 1) return 'alive';
      if (calls === 2) pause(BUDGET_MS + 30);
      return 'dead';
    },
  };
}
const dyingPayload = (token: string, probe: LivenessProbe): object =>
  ({ ...selfIdentity(token.repeat(32), probe), pid: DYING_PID, startTicks: '4242', threadId: 5 });
function emptyFixture(): { ledger: string; lockPath: string } {
  const d = mkdtempSync(join(tmpdir(), 'helix-absent-'));
  const ledger = join(d, 'ledger.jsonl');
  writeFileSync(ledger, '');
  return { ledger, lockPath: lockPathOf(ledger) };
}

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
    let message = '';
    try { withFileLock(ledger, () => 'ran', { maxWaitMs: 50 }); } catch (e) { message = (e as Error).message; }
    expect(message.split(lockPath).join('<lock>').replace(/after \d+ms/, 'after <n>ms')).toBe(
      'withFileLock: timed out after <n>ms acquiring <lock> — the lock was free at the last look, but another process held it on every ' +
      'earlier attempt inside the budget (contention, not a stuck holder). Try again.');
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

describe('an ENOENT at the end of the budget with the folder in place (spec section 14 item 14)', () => {
  it('a tmp swept under a live holder names that holder and never says nothing holds the lock', () => {
    const { ledger, lockPath } = fixture();
    let swept = 0;
    hooks.onLink = () => { hooks.onLink = null; pause(80); swept = sweepOrphanTmps(ledger); };   // the budget (50 ms) ends, then a holder's append sweeps this tmp
    const message = refusal(() => withFileLock(ledger, () => 'ran', { maxWaitMs: 50 }));
    expect(swept, 'the seam fired').toBe(1);
    expect(message).toContain(`held by pid ${process.pid}`);
    expect(message).not.toContain('Nothing holds this lock');
    expect(hooks.links.filter((d) => d === lockPath)).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(true);                // the live holder's lock was never touched
  });

  it('a tmp swept as the holder lets go reads absent: the one more publication takes the lock', () => {
    const { ledger, lockPath } = fixture();
    hooks.onLink = () => { hooks.onLink = null; pause(80); sweepOrphanTmps(ledger); unlinkSync(lockPath); };
    expect(withFileLock(ledger, () => 'ran', { maxWaitMs: 50 })).toBe('ran');
    expect(hooks.links.filter((d) => d === lockPath)).toHaveLength(2);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('a steal on the last pass of the budget (spec section 14 item 14)', () => {
  it('a payload holder that dies at the budget end: its lock is cleared and taken, its old reading is never printed', () => {
    const { ledger, lockPath } = emptyFixture();
    const probe = dyingProbe();
    writeLockFileForTest(lockPath, dyingPayload('c', probe));
    expect(withFileLock(ledger, () => 'ran', { maxWaitMs: BUDGET_MS, probe })).toBe('ran');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a legacy directory whose owner dies at the budget end: cleared and taken, "stands there" is never printed', () => {
    const { ledger, lockPath } = emptyFixture();
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner'), `${DYING_PID}-cafe`);
    expect(withFileLock(ledger, () => 'ran', { maxWaitMs: BUDGET_MS, probe: dyingProbe() })).toBe('ran');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('another holder that takes the cleared lock first is the one the text names', () => {
    const { ledger, lockPath } = emptyFixture();
    const probe = dyingProbe();
    writeLockFileForTest(lockPath, dyingPayload('c', probe));
    let publications = 0;
    hooks.onLink = (dest) => {
      if (dest !== lockPath || ++publications < 3) return;  // the third is the one more publication
      hooks.onLink = null;
      writeLockFileForTest(lockPath, { ...dyingPayload('e', probe), pid: 888_888 });
    };
    const message = refusal(() => withFileLock(ledger, () => 'ran', { maxWaitMs: BUDGET_MS, probe }));
    expect(publications, 'the seam fired').toBe(3);
    expect(message).toContain('held by pid 888888');
    expect(message).not.toContain(`pid ${DYING_PID}`);
    expect(existsSync(lockPath)).toBe(true);                // the new holder's lock was never touched
  });

  it('a second dead holder cleared after the one more publication refuses as vanished, not with the reading of the lock it removed', () => {
    const { ledger, lockPath } = emptyFixture();
    const probe = dyingProbe();
    writeLockFileForTest(lockPath, dyingPayload('c', probe));
    let publications = 0;
    hooks.onLink = (dest) => {
      if (dest !== lockPath || ++publications < 3) return;
      hooks.onLink = null;
      writeLockFileForTest(lockPath, dyingPayload('e', probe));
    };
    const message = refusal(() => withFileLock(ledger, () => 'ran', { maxWaitMs: BUDGET_MS, probe }));
    expect(publications, 'the seam fired').toBe(3);
    expect(message.split(lockPath).join('<lock>').replace(/after \d+ms/, 'after <n>ms')).toBe(
      'withFileLock: timed out after <n>ms acquiring <lock> — the lock was free at the last look, but another process held it on every ' +
      'earlier attempt inside the budget (contention, not a stuck holder). Try again.');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a steal that finds the gate busy keeps the budget-end text: a stuck gate clears nothing', () => {
    const { ledger, lockPath } = emptyFixture();
    const probe: LivenessProbe = { ...realProbe, kill0: () => 'dead' };
    writeLockFileForTest(lockPath, dyingPayload('c', probe));
    writeFileSync(`${lockPath}.reap.${realProbe.bootId() ?? 'noboot'}`, 'a reaper that crashed');
    const message = refusal(() => withFileLock(ledger, () => 'ran', { maxWaitMs: 50, probe }));
    expect(message).toContain(`held by pid ${DYING_PID}`);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('a steal that re-reads the holder alive leaves it: the reading stands and no extra publication is spent', () => {
    const { ledger, lockPath } = emptyFixture();
    let calls = 0;
    const probe: LivenessProbe = {
      ...realProbe,
      startTicksOf: () => '4242',
      stateOf: () => 'S',
      kill0() { calls += 1; if (calls > 1) return 'alive'; pause(80); return 'dead'; },   // dead at the classification, alive under the gate
    };
    writeLockFileForTest(lockPath, dyingPayload('c', probe));
    hooks.links.length = 0;
    const message = refusal(() => withFileLock(ledger, () => 'ran', { maxWaitMs: 50, probe }));
    expect(message).toContain(`held by pid ${DYING_PID}`);
    expect(hooks.links.filter((d) => d === lockPath)).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(true);
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
