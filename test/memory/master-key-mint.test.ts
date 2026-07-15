import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { ensureMaster } from '../../src/memory/ledger-mac.js';

// DEVIATION (documented, see task-9-report.md): withFileLock's mutual exclusion plus ensureMaster's
// own in-lock `again` re-check make the publish-time linkSync/EEXIST branch structurally
// UNREACHABLE by any lock-respecting concurrent caller — the two-real-process test below proves
// convergence/no-crash under normal concurrency, but empirically (verified by hand-applying both
// mutations several times) it can never observe that branch: by the time a second process acquires
// the lock, the first process's publish is already complete and visible, so `again` always short
// -circuits it first. That branch exists as defense-in-depth against a LOCK-BYPASSING writer, so we
// pin it directly with a deterministic in-process stand-in: sweepOrphanTmps is the one call ensureMaster
// makes between the `again` check and the publish attempt, so it is the one safe seam to land a
// "concurrent writer" at exactly that instant — without adding a test-only hook to ensureMaster's own
// (frozen) public shape. This is the ONLY module mock in this suite; every other test in this file
// exercises the real, unmocked function via the real sweepOrphanTmps pass-through below.
let injectBeforeSweep: (() => void) | null = null;
vi.mock('../../src/memory/ledger-sweep.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/memory/ledger-sweep.js')>();
  return {
    ...actual,
    sweepOrphanTmps: (...args: Parameters<typeof actual.sweepOrphanTmps>) => {
      const fire = injectBeforeSweep;
      injectBeforeSweep = null; // one-shot: only the dedicated test below arms it
      fire?.();
      return actual.sweepOrphanTmps(...args);
    },
  };
});

describe('master key mint (link publication — never overwrites)', () => {
  it('mints once, 0600, no tmp litter; a second call returns the SAME bytes', () => {
    const home = mkdtempSync(join(tmpdir(), 'key-'));
    const k1 = ensureMaster(home);
    const k2 = ensureMaster(home);
    expect(k1.equals(k2)).toBe(true);
    expect(statSync(join(home, 'ledger-mac-master.key')).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
  });
  it('a PRE-EXISTING key is never overwritten — the loser adopts the winner bytes', () => {
    const home = mkdtempSync(join(tmpdir(), 'key2-'));
    const winner = Buffer.alloc(32, 7);
    writeFileSync(join(home, 'ledger-mac-master.key'), winner, { mode: 0o600 });
    expect(ensureMaster(home).equals(winner)).toBe(true);
  });
  it('an orphaned key tmp (crashed prior mint) is swept before minting', () => {
    const home = mkdtempSync(join(tmpdir(), 'key3-'));
    writeFileSync(join(home, `ledger-mac-master.key.k-${'a'.repeat(32)}.tmp`), Buffer.alloc(32, 9));
    ensureMaster(home);
    expect(readdirSync(home).filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
  });
  it('two REAL processes racing the first mint converge on ONE key (no rotation, no torn key)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'key4-'));
    const worker = join(mkdtempSync(join(tmpdir(), 'key4w-')), 'mint.mjs');
    writeFileSync(join(home, '.placeholder'), '');
    const src = join(mkdtempSync(join(tmpdir(), 'key4s-')), 'mint-worker.ts');
    writeFileSync(src, `
      import { ensureMaster } from '${process.cwd().replace(/\\/g, '/')}/src/memory/ledger-mac.js';
      process.stdout.write(ensureMaster(process.argv[2]).toString('hex'));
    `);
    await build({ entryPoints: [src], outfile: worker, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
    const run = (): Promise<string> => new Promise((res, rej) => {
      const c = spawn(process.execPath, [worker, home], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = ''; c.stdout.on('data', (b) => { out += b; });
      c.on('close', (code) => (code === 0 ? res(out) : rej(new Error('exit ' + code))));
    });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a).toBe(b);                                              // both processes hold the SAME key
    expect(a).toHaveLength(64);
    expect(ensureMaster(home).toString('hex')).toBe(a);             // and it is what landed on disk
  }, 30_000);
  it('EEXIST at publish time (deterministic stand-in for the unreachable-by-real-processes race): a key ' +
     'planted by a concurrent writer between the again-check and publish is ADOPTED, never overwritten', () => {
    const home = mkdtempSync(join(tmpdir(), 'key5-'));
    const path = join(home, 'ledger-mac-master.key');
    const winner = Buffer.alloc(32, 3);
    injectBeforeSweep = () => writeFileSync(path, winner, { mode: 0o600 }); // lands right before publish
    const got = ensureMaster(home);
    expect(got.equals(winner)).toBe(true);                                       // adopted, NOT overwritten
    expect(readdirSync(home).filter((n) => n.endsWith('.tmp'))).toHaveLength(0); // its own tmp still cleaned
  });
});
