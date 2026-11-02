// N-OWNERSHIP-REPAIR.b, as the critical section of design 4.3 answers it: a foreign ledger that appears while the first commit waits for the registry lock is met by the exclusive creation, and the ownership the commit had recorded is put back.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { MemoryStore } from '../../src/memory/store.js';
import { isOwned } from '../../src/memory/ownership.js';

let worker: string;
beforeAll(async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'helix-raceworker-')), 'worker.mjs');
  await build({
    entryPoints: ['scripts/foreign-ledger-race-worker.ts'], outfile: out,
    bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
  });
  worker = out;
}, 60_000);

/** Block until a barrier file appears, or throw so a missed barrier is never read as success. */
async function waitFor(path: string, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`barrier never appeared: ${path}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('the first commit meets a foreign ledger that appears while it waits for the registry lock', () => {
  it('is refused with the foreign-file text, the foreign file is untouched, and the ownership is put back', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-race-home-'));
    const proj = mkdtempSync(join(tmpdir(), 'helix-race-proj-'));
    const barriers = mkdtempSync(join(tmpdir(), 'helix-race-barrier-'));
    mkdirSync(join(proj, '.helix'), { recursive: true });
    const ledger = join(proj, '.helix', 'memory.jsonl');
    const registry = join(home, 'projects.json');          // registryPath(home), module-private

    const w = spawn(process.execPath, [worker, registry, ledger, barriers, '300', '400'], { stdio: 'ignore' });
    try {
      await waitFor(join(barriers, 'acquired'));           // the lock is definitely held now
      expect(existsSync(ledger), 'the plant landed too early; the pre-check would fire instead').toBe(false);

      const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's1', project: { root: proj, ledger } });
      // Holds the ledger lock and passes its judgement under it (no file yet), then blocks on the registry lock the worker holds. The worker plants the file inside that window, so the exclusive creation is what decides.
      expect(() => store.commit({ content: 'a fact', source: 'user', scope: 'project' }))
        .toThrow(/exists here that Helix did not create/);

      await waitFor(join(barriers, 'planted'));
      expect(existsSync(ledger), 'the worker never planted the foreign ledger').toBe(true);
      expect(readFileSync(ledger, 'utf8')).toBe('{"foreign":"not written by Helix"}\n');
      expect(isOwned(proj, home)).toBe(false);
      expect(existsSync(registry)).toBe(false);
    } finally {
      w.kill('SIGKILL');
      for (const d of [home, proj, barriers]) rmSync(d, { recursive: true, force: true });
    }
  }, 30_000);
});
