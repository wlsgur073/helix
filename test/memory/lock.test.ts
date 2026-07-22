import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, symlinkSync, lstatSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock, withFileLockAsync, lockPathOf, writeLockFileForTest } from '../../src/memory/lock.js';
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
    // The vanish is a RENAME, not rmSync (C2.1 de-flake): recursive rm walks unlink→rmdir, and in
    // between the lock NAME is legitimately free while the dir still exists — a waiter waking in that
    // window CORRECTLY acquires (observed ~2/10 full-suite runs). rename is one syscall: no
    // intermediate free-lock state exists, so every post-rename attempt deterministically ENOENTs —
    // which is exactly the state under test, and the loop sees the same errno a real rm -rf ends in.
    // Mutation guard: reverting the fix to a bare `continue` spins ENOENT with no sleep/no budget —
    // observed 2026-07-22: the sync spin blocks the worker's event loop, so vitest's own test
    // timeout never fires either; the run hangs outright (>120s, killed externally). RED by hang.
    const d = mkdtempSync(join(tmpdir(), 'helix-lock-enoent-'));
    const gone = `${d}-gone`;
    const ledger = join(d, 'ledger.jsonl');
    writeFileSync(ledger, '');
    const liveHolder = { ...selfIdentity('f'.repeat(32)), threadId: 99 }; // same pid+ticks, diff thread => alive => never stolen
    writeLockFileForTest(lockPathOf(ledger), liveHolder);
    const killer = spawn(process.execPath, ['-e', `require('fs').renameSync(${JSON.stringify(d)}, ${JSON.stringify(gone)})`], { stdio: 'ignore' });
    const t0 = Date.now();
    try {
      expect(() => withFileLock(ledger, () => 1, { maxWaitMs: 1000 })).toThrow(/timed out/);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(3000); // budgeted (~maxWaitMs); a non-yielding spin would only end at the 5s hard-kill
    } finally {
      killer.kill();
      rmSync(gone, { recursive: true, force: true });
      rmSync(d, { recursive: true, force: true }); // only present if the child never got to rename
    }
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

describe('withFileLockAsync (holds across the await)', () => {
  // The property that distinguishes this from `withFileLock(t, async fn)`: the lock stays held
  // until the async callback SETTLES, not until it hits its first `await`. Verified by a competing
  // same-process acquire while the holder is parked mid-await — because THIS process still holds
  // the lock across the await, the nested acquire is rejected as re-entrant; once the holder
  // releases, the path is free again. (Mutation-checked during authoring: reverting the impl to
  // `return fn(ctx)` — the early-release bug this sibling exists to avoid — turns the re-entrant
  // assertion RED, because the freed lock lets the competitor acquire cleanly and NOT throw.)
  it('holds the lock across the await — a nested acquire is rejected while parked mid-await, then the path frees after it settles', async () => {
    const t = target();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let settled = false;
    // acquireFileLock runs synchronously before the first `await`, so the lock is held the moment
    // withFileLockAsync is called; the holder then parks on `gate`.
    const held = withFileLockAsync(t, async () => { await gate; return 'inner'; })
      .then((v) => { settled = true; return v; });

    // Held across the await: a competing acquire on the same path fails (re-entrant fast-path,
    // because this process is the holder). Under the early-release bug it would instead succeed.
    expect(() => withFileLock(t, () => 'never', { maxWaitMs: 100 })).toThrow(/re-entrant/i);
    expect(settled).toBe(false);                 // the async holder has NOT released yet
    expect(existsSync(lockPathOf(t))).toBe(true); // lock file still present (held across the await)

    release();                                    // let the async fn settle
    await expect(held).resolves.toBe('inner');
    expect(existsSync(lockPathOf(t))).toBe(false); // released in finally, only AFTER the await settled
    expect(withFileLock(t, () => 'ok')).toBe('ok'); // path is free again
  });

  it('releases the lock even when the async fn rejects (finally runs after the promise settles)', async () => {
    const t = target();
    await expect(withFileLockAsync(t, async () => { await Promise.resolve(); throw new Error('boom'); }))
      .rejects.toThrow('boom');
    expect(existsSync(lockPathOf(t))).toBe(false);                       // not left held
    const dir = join(t, '..');
    expect(readdirSync(dir).filter((n: string) => n.includes('.lk-'))).toHaveLength(0); // no orphan src tmp
  });
});
