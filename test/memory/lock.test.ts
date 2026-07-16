import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, symlinkSync, lstatSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock, lockPathOf, writeLockFileForTest } from '../../src/memory/lock.js';
import { selfIdentity } from '../../src/memory/lock-liveness.js';

const target = (): string => { const d = mkdtempSync(join(tmpdir(), 'helix-lock-')); writeFileSync(join(d, 'ledger.jsonl'), ''); return join(d, 'ledger.jsonl'); };

describe('withFileLock (link-published)', () => {
  it('runs fn under the lock, the lock is a FILE with a full payload, and it is removed afterward', () => {
    const t = target();
    let sawPayload: unknown = null;
    const r = withFileLock(t, () => { sawPayload = JSON.parse(readFileSync(lockPathOf(t), 'utf8')); return 42; });
    expect(r).toBe(42);
    expect(existsSync(lockPathOf(t))).toBe(false);
    expect((sawPayload as { pid: number }).pid).toBe(process.pid);        // payload complete the moment the name exists
    expect((sawPayload as { v: number }).v).toBe(1);
  });
  it('releases even if fn throws, and leaves no lk- source tmp behind', () => {
    const t = target();
    expect(() => withFileLock(t, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(lockPathOf(t))).toBe(false);
    const dir = join(t, '..');
    expect(readdirSync(dir).filter((n: string) => n.includes('.lk-'))).toHaveLength(0);
  });
  it('a LIVE holder (real payload of a live foreign-ish process) times out with a rich error, and is NEVER stolen no matter how old', () => {
    const t = target();
    const foreign = { ...selfIdentity('c'.repeat(32)), threadId: 99 };    // same pid+ticks, different thread => alive
    writeLockFileForTest(lockPathOf(t), foreign);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lockPathOf(t), old, old);                                 // one hour old — age must be irrelevant
    expect(() => withFileLock(t, () => 1, { maxWaitMs: 200 })).toThrow(/timed out.*pid|pid.*timed out/is);
    expect(existsSync(lockPathOf(t))).toBe(true);                          // still held
    expect(readFileSync(lockPathOf(t), 'utf8')).toContain('c'.repeat(32)); // untouched, byte-identical holder
  });
  it('re-entrant acquisition fails FAST with a diagnostic (not a 5 s block)', () => {
    const t = target();
    const t0 = Date.now();
    expect(() => withFileLock(t, () => withFileLock(t, () => 1))).toThrow(/re-entrant/i);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
  it('a legacy lock DIRECTORY blocks acquisition (mixed-window mutual exclusion)', () => {
    const t = target();
    mkdirSync(lockPathOf(t));
    writeFileSync(join(lockPathOf(t), 'owner'), `${process.pid}-deadbeef`); // live legacy holder (our pid)
    expect(() => withFileLock(t, () => 1, { maxWaitMs: 150 })).toThrow(/timed out/i);
    expect(lstatSync(lockPathOf(t)).isDirectory()).toBe(true);              // untouched
  });
  it('symlink alias resolves to ONE lock (canonicalization)', () => {
    const t = target();
    const aliasDir = mkdtempSync(join(tmpdir(), 'helix-alias-'));
    const alias = join(aliasDir, 'ledger.jsonl');
    symlinkSync(t, alias);
    withFileLock(alias, () => {
      expect(existsSync(lockPathOf(t))).toBe(true);                         // the lock landed at the CANONICAL path
    });
  });
  it('release refuses to unlink a lock whose payload is no longer ours (J3 ownership audit, new form)', () => {
    const t = target();
    const foreign = JSON.stringify({ ...selfIdentity('d'.repeat(32)), threadId: 42 });
    withFileLock(t, () => { writeFileSync(lockPathOf(t), foreign); });      // someone replaced us mid-hold
    expect(readFileSync(lockPathOf(t), 'utf8')).toBe(foreign);              // left in place — we could not prove ownership
    rmSync(lockPathOf(t));
  });
  it('an ENOENT in the acquire loop is BUDGETED: a ledger dir vanishing mid-acquire times out on schedule, never an unbudgeted 100% CPU spin', () => {
    // A fully-missing path cannot exercise this: canonical() throws ENOENT before the loop is ever
    // reached. The loop's ENOENT is only reachable when the dir vanishes AFTER canonical() resolved
    // it — a mid-acquire race. So: a LIVE holder pins us in the acquire loop (EEXIST path), then a
    // SEPARATE process removes the whole dir (this thread is blocked in Atomics.wait, so a same-thread
    // timer can't fire). Every subsequent publish attempt then throws ENOENT and MUST still budget out.
    // Mutation guard: reverting the fix to a bare `continue` spins ENOENT with no sleep/no budget —
    // the test then hangs to vitest's default 5s kill (RED) instead of timing out here at ~maxWaitMs.
    const d = mkdtempSync(join(tmpdir(), 'helix-lock-enoent-'));
    const ledger = join(d, 'ledger.jsonl');
    writeFileSync(ledger, '');
    const liveHolder = { ...selfIdentity('f'.repeat(32)), threadId: 99 }; // same pid+ticks, diff thread => alive => never stolen
    writeLockFileForTest(lockPathOf(ledger), liveHolder);
    const killer = spawn(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(d)}, { recursive: true, force: true })`], { stdio: 'ignore' });
    const t0 = Date.now();
    expect(() => withFileLock(ledger, () => 1, { maxWaitMs: 500 })).toThrow(/timed out/);
    const elapsed = Date.now() - t0;
    killer.kill();
    expect(elapsed).toBeLessThan(2000); // budgeted (~maxWaitMs); a non-yielding spin would only end at the 5s hard-kill
  });
  it('ctx.stillOwned() is true while held and false after a foreign replacement', () => {
    const t = target();
    withFileLock(t, (ctx) => {
      expect(ctx.stillOwned()).toBe(true);
      writeFileSync(lockPathOf(t), JSON.stringify({ ...selfIdentity('e'.repeat(32)), threadId: 42 }));
      expect(ctx.stillOwned()).toBe(false);
    });
    rmSync(lockPathOf(t), { force: true });
  });
});
