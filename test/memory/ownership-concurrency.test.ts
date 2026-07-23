import { describe, it, expect, beforeAll } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Real cross-process adoption races: the registry lock + atomic publish only mean something across
// separate processes (one MCP server per Claude Code session sharing ~/.helix). POSIX-only, and kept
// out of the fast unit suite because it bundles a worker and spawns processes.
const posixOnly = describe.skipIf(process.platform === 'win32');

let worker: string;
let mintWorker: string;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-adoptworkers-'));
  worker = join(dir, 'adopt.mjs');
  mintWorker = join(dir, 'mint.mjs');
  await build({
    entryPoints: ['scripts/adopt-worker.ts'], outfile: worker,
    bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
  });
  await build({
    entryPoints: ['scripts/global-nonce-worker.ts'], outfile: mintWorker,
    bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
  });
}, 30_000);

const waitFor = async (pred: () => boolean, ms: number): Promise<void> => {
  const until = Date.now() + ms;
  while (!pred()) { if (Date.now() > until) throw new Error('waitFor timeout'); await new Promise((r) => setTimeout(r, 10)); }
};

const spawnAll = (
  worker: string, home: string, goFile: string, ready: string[], rootsPerWorker: string[][],
) => rootsPerWorker.map((roots, w) =>
  spawn(process.execPath, [worker, home, goFile, ready[w]!, ...roots], { stdio: 'ignore' }));

const exitsOf = (procs: ReturnType<typeof spawn>[]) =>
  Promise.all(procs.map((p) => new Promise<number>((res) => p.on('exit', (c) => res(c ?? -1)))));

posixOnly('concurrent adoption (registry lock + atomic publish)', () => {
  it('N processes each adopting distinct projects never lose a registry entry', async () => {
    const run = mkdtempSync(join(tmpdir(), 'helix-adopt-run-'));
    const home = join(run, 'home'); mkdirSync(home, { recursive: true });
    const WORKERS = 8, PER = 8;
    const goFile = join(run, 'go');
    const rootsPerWorker: string[][] = [];
    for (let w = 0; w < WORKERS; w++) {
      const roots: string[] = [];
      for (let p = 0; p < PER; p++) { const r = join(run, `proj-${w}-${p}`); mkdirSync(r, { recursive: true }); roots.push(r); }
      rootsPerWorker.push(roots);
    }
    const ready = rootsPerWorker.map((_, w) => join(run, `ready-${w}`));
    const procs = spawnAll(worker, home, goFile, ready, rootsPerWorker);
    const exits = exitsOf(procs);
    await waitFor(() => ready.every((f) => existsSync(f)), 15_000); // all workers armed at the barrier
    writeFileSync(goFile, 'go');                                     // release them together
    const codes = await exits;

    expect(codes.every((c) => c === 0)).toBe(true);                 // no worker died on a torn/corrupt read
    const reg = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')) as Record<string, unknown>;
    const expected = rootsPerWorker.flat().map((r) => resolve(r));
    const missing = expected.filter((k) => !reg[k]);
    expect(missing).toEqual([]);                                     // EVERY adoption survived — no lost update
    expect(Object.keys(reg).filter((k) => k !== '@global').length).toBe(WORKERS * PER);
  }, 40_000);

  it('concurrent globalScopeNonce mint converges on ONE stable nonce (double-checked lock)', async () => {
    const run = mkdtempSync(join(tmpdir(), 'helix-globalmint-run-'));
    const home = join(run, 'home'); mkdirSync(home, { recursive: true });
    // N processes each call globalScopeNonce(home) on a virgin home at the same instant. Without the
    // lock's double-checked re-read, each racer would mint and persist its OWN nonce (last writer
    // wins, but every process returns a different value); the lock must make all of them observe the
    // single winning nonce.
    const WORKERS = 10;
    const goFile = join(run, 'go');
    const ready = Array.from({ length: WORKERS }, (_, w) => join(run, `ready-${w}`));
    const out = Array.from({ length: WORKERS }, (_, w) => join(run, `out-${w}`));
    const procs = ready.map((r, w) =>
      spawn(process.execPath, [mintWorker, home, goFile, r, out[w]!], { stdio: 'ignore' }));
    const exits = exitsOf(procs);
    await waitFor(() => ready.every((f) => existsSync(f)), 15_000);
    writeFileSync(goFile, 'go');
    expect((await exits).every((c) => c === 0)).toBe(true);

    const observed = out.map((o) => readFileSync(o, 'utf8').trim());
    const unique = new Set(observed);
    expect(unique.size).toBe(1);                     // every process observed the SAME nonce
    const nonce = [...unique][0]!;
    expect(nonce).toMatch(/^[0-9a-f]+$/);            // a real minted nonce, not "null"
    const reg = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')) as Record<string, { macNonce?: string }>;
    expect(reg['@global']!.macNonce).toBe(nonce);    // and that exact nonce is what persisted
  }, 40_000);
});
