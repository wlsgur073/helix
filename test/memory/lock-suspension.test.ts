import { describe, it, expect, beforeAll } from 'vitest';
import { build } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock, lockPathOf } from '../../src/memory/lock.js';

// The D3 lock: a SUSPENDED (SIGSTOP) holder is ALIVE and must never be stolen — the old code's
// 10 s age-steal here is exactly what resurrected erased plaintext. POSIX-only.
const posixOnly = describe.skipIf(process.platform === 'win32');

let holdWorker: string, legacyWorker: string;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-lockworkers-'));
  holdWorker = join(dir, 'hold.mjs'); legacyWorker = join(dir, 'legacy.mjs');
  await build({ entryPoints: ['scripts/lock-hold-worker.ts'], outfile: holdWorker, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
  await build({ entryPoints: ['scripts/legacy-lock-worker.ts'], outfile: legacyWorker, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
}, 30_000);

const waitFor = async (pred: () => boolean, ms: number): Promise<void> => {
  const until = Date.now() + ms;
  while (!pred()) { if (Date.now() > until) throw new Error('waitFor timeout'); await new Promise((r) => setTimeout(r, 25)); }
};
const procState = (pid: number): string => { try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[0]!; } catch { return '?'; } };
const spawnWorker = (script: string, target: string, barrierDir: string, holdMs: number): ChildProcess =>
  spawn(process.execPath, [script, target, barrierDir, String(holdMs)], { stdio: 'ignore' });

posixOnly('suspension and death across real processes', () => {
  it('D3: a SIGSTOPped holder with a PRE-AGED lock is never stolen; the waiter times out; the holder finishes intact', async () => {
    const d = mkdtempSync(join(tmpdir(), 'helix-d3-'));
    const target = join(d, 'ledger.jsonl'); writeFileSync(target, '');
    const w = spawnWorker(holdWorker, target, d, 4_000);
    await waitFor(() => existsSync(join(d, 'acquired')), 5_000);
    process.kill(w.pid!, 'SIGSTOP');
    await waitFor(() => procState(w.pid!) === 'T', 2_000);           // provably suspended
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPathOf(target), old, old);                        // pre-age FAR past the old 10 s stale-age threshold:
    // an age-steal mutant steals instantly here (RED); the fixed code respects the live holder.
    expect(() => withFileLock(target, () => 1, { maxWaitMs: 1_500 })).toThrow(/timed out/i);
    expect(existsSync(lockPathOf(target))).toBe(true);
    process.kill(w.pid!, 'SIGCONT');
    await waitFor(() => existsSync(join(d, 'released')), 10_000);    // holder resumed and finished cleanly
    expect(existsSync(lockPathOf(target))).toBe(false);
  }, 20_000);

  it('a SIGKILLed holder IS reclaimed and a new acquirer proceeds', async () => {
    const d = mkdtempSync(join(tmpdir(), 'helix-kill-'));
    const target = join(d, 'ledger.jsonl'); writeFileSync(target, '');
    const w = spawnWorker(holdWorker, target, d, 60_000);
    await waitFor(() => existsSync(join(d, 'acquired')), 5_000);
    process.kill(w.pid!, 'SIGKILL');
    await waitFor(() => procState(w.pid!) === '?', 2_000);           // gone (vitest reaps via libuv)
    let ran = false;
    withFileLock(target, () => { ran = true; }, { maxWaitMs: 3_000 });
    expect(ran).toBe(true);
  }, 20_000);

  it('mixed window pinned: the FROZEN legacy binary age-steals a new-format lock after its stale-age threshold — the documented exposure', async () => {
    const d = mkdtempSync(join(tmpdir(), 'helix-mixed-'));
    const target = join(d, 'ledger.jsonl'); writeFileSync(target, '');
    // A new-format lock held by a live-but-idle owner: fabricate with OUR pid (alive) and age it.
    const { writeLockFileForTest } = await import('../../src/memory/lock.js');
    const { selfIdentity } = await import('../../src/memory/lock-liveness.js');
    writeLockFileForTest(lockPathOf(target), { ...selfIdentity('9'.repeat(32)), threadId: 61 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPathOf(target), old, old);
    const w = spawnWorker(legacyWorker, target, d, 200);             // legacy sees a 60 s old entry -> steals
    await waitFor(() => existsSync(join(d, 'released')), 10_000);
    expect(existsSync(join(d, 'acquired'))).toBe(true);              // it acquired by stealing a LIVE new lock:
    // this is the mixed-window hazard the SECURITY.md launch-barrier runbook exists for.
    w.kill();
  }, 20_000);

  it('mixed window, other direction: the new binary BLOCKS on a live legacy dir', async () => {
    const d = mkdtempSync(join(tmpdir(), 'helix-mixed2-'));
    const target = join(d, 'ledger.jsonl'); writeFileSync(target, '');
    const w = spawnWorker(legacyWorker, target, d, 4_000);           // legacy holds its mkdir lock
    await waitFor(() => existsSync(join(d, 'acquired')), 5_000);
    expect(() => withFileLock(target, () => 1, { maxWaitMs: 500 })).toThrow(/timed out/i);
    await waitFor(() => existsSync(join(d, 'released')), 10_000);
    let ran = false;
    withFileLock(target, () => { ran = true; }, { maxWaitMs: 3_000 });
    expect(ran).toBe(true);                                          // and proceeds once legacy releases
  }, 20_000);
});
