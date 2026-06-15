import { describe, it, expect, beforeAll } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Cross-process mutual exclusion is withFileLock's whole reason to exist (concurrent helix-mcp
// processes against one ~/.helix/memory.jsonl). The lock is synchronous/blocking, so true contention
// is only observable across separate OS processes. The project ships no tsx and src/*.ts can't run
// directly under node, so we bundle a tiny worker with esbuild and spawn several under plain `node`.

let workerPath: string;

beforeAll(async () => {
  workerPath = join(mkdtempSync(join(tmpdir(), 'helix-lockworker-')), 'worker.mjs');
  await build({
    entryPoints: ['scripts/lock-contend-worker.ts'],
    outfile: workerPath,
    bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
  });
}, 30_000);

function runWorker(target: string, iters: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, target, String(iters)], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
  });
}

describe('withFileLock cross-process mutual exclusion', () => {
  it('serializes concurrent read-modify-write across OS processes (no lost updates)', async () => {
    const target = join(mkdtempSync(join(tmpdir(), 'helix-lockc-')), 'ledger.jsonl');
    const PROCS = 4;
    const ITERS = 25;
    writeFileSync(target + '.count', '0');
    await Promise.all(Array.from({ length: PROCS }, () => runWorker(target, ITERS)));
    // Without the lock, concurrent RMW races lose updates -> final < PROCS*ITERS. With the lock
    // (and the ownership-verified release), every increment is serialized -> exactly PROCS*ITERS.
    expect(Number(readFileSync(target + '.count', 'utf8'))).toBe(PROCS * ITERS);
  }, 60_000);
});
