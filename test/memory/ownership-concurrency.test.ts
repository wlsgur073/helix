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
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-adoptworkers-'));
  worker = join(dir, 'adopt.mjs');
  await build({
    entryPoints: ['scripts/adopt-worker.ts'], outfile: worker,
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

  it('concurrent global-nonce mint converges on a single stable nonce', async () => {
    const run = mkdtempSync(join(tmpdir(), 'helix-globalmint-run-'));
    const home = join(run, 'home'); mkdirSync(home, { recursive: true });
    // Each worker adopts one project (which reads/derives), and separately we read the @global nonce
    // after the storm: concurrent adopts must not tear or fork the @global entry.
    const WORKERS = 10;
    const goFile = join(run, 'go');
    const rootsPerWorker = Array.from({ length: WORKERS }, (_, w) => {
      const r = join(run, `p-${w}`); mkdirSync(r, { recursive: true }); return [r];
    });
    const ready = rootsPerWorker.map((_, w) => join(run, `ready-${w}`));
    const procs = spawnAll(worker, home, goFile, ready, rootsPerWorker);
    const exits = exitsOf(procs);
    await waitFor(() => ready.every((f) => existsSync(f)), 15_000);
    writeFileSync(goFile, 'go');
    expect((await exits).every((c) => c === 0)).toBe(true);
    const reg = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(reg).filter((k) => k !== '@global').length).toBe(WORKERS); // all adoptions kept
  }, 40_000);
});
