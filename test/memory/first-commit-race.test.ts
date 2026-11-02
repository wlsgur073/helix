// Third fix batch B1, task B1 (IT-M5, Review Focus 5): processes racing the FIRST commit of one project. Every
// commit is stored and none is answered with the foreign-file text, because the late ones wait for the ledger lock
// and then read the project as owned. POSIX only (a spawned worker per process), like ownership-concurrency.test.ts.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { bundleCli } from '../helpers/bundle-cli.js';
import { fixture, cleanupFixtures, rowsIn, registryKeys } from '../helpers/first-write-fixture.js';

const posixOnly = describe.skipIf(process.platform === 'win32');
afterEach(cleanupFixtures);

const waitFor = async (pred: () => boolean, ms: number): Promise<void> => {
  const until = Date.now() + ms;
  while (!pred()) { if (Date.now() > until) throw new Error('waitFor timeout'); await new Promise((r) => setTimeout(r, 10)); }
};

posixOnly('IT-M5: four processes commit first to one unadopted project at the same instant', () => {
  it('every commit is stored, none is refused, and the project has exactly one registry entry', async () => {
    const worker = await bundleCli('scripts/first-commit-worker.ts');
    const fx = fixture();
    const tags = ['a', 'b', 'c', 'd'];
    const go = join(fx.base, 'go');
    const procs = tags.map((tag) => spawn(
      process.execPath,
      [worker, fx.home, fx.root, go, join(fx.base, `ready-${tag}`), join(fx.base, `result-${tag}.json`), tag],
      { stdio: 'ignore' },
    ));
    const exits = Promise.all(procs.map((p) => new Promise<number>((res) => p.on('exit', (c) => res(c ?? -1)))));
    await waitFor(() => tags.every((t) => existsSync(join(fx.base, `ready-${t}`))), 30_000);
    writeFileSync(go, 'go');
    expect(await exits).toEqual([0, 0, 0, 0]);
    const results = tags.map((t) => JSON.parse(readFileSync(join(fx.base, `result-${t}.json`), 'utf8')) as { ok: boolean; text?: string });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(rowsIn(fx.ledger).sort()).toEqual(['fact a', 'fact b', 'fact c', 'fact d']);
    expect(registryKeys(fx.home)).toHaveLength(1);
  }, 120_000);
});
