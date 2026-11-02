// Third fix batch B1, tasks B1 and B2 (design 4.3): the fixture the first-write tests share. One directory per
// fixture: <base>/home (HELIX_HOME), <base>/proj (the project, with .helix unless told otherwise) and <base>/out
// (somewhere a replaced folder can lead to).
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { projectLedgerPath } from '../../src/memory/ownership.js';

export const NOW = '2026-11-01T00:00:00.000Z';

export interface FirstWriteFixture {
  readonly base: string;
  readonly home: string;
  readonly root: string;
  readonly helix: string;
  readonly ledger: string;
  readonly globalLedger: string;
  readonly outside: string;
  /** A store over this project. `tag` keeps ids of two stores apart. */
  store(tag?: string): MemoryStore;
}

const made: string[] = [];
const writable: string[] = [];

/** A directory a test makes read-only: cleanupFixtures() gives it mode 0700 back before removing the tree. */
export function keepWritable(path: string): void { writable.push(path); }

export function fixture(opts: { helix?: boolean } = {}): FirstWriteFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'fw-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'proj');
  const outside = join(base, 'out');
  for (const d of [home, root, outside]) mkdirSync(d);
  const helix = join(root, '.helix');
  if (opts.helix !== false) mkdirSync(helix);
  const ledger = projectLedgerPath(root);
  const globalLedger = join(home, 'memory.jsonl');
  return {
    base, home, root, helix, ledger, globalLedger, outside,
    store: (tag = 'a') => {
      let n = 0;
      return new MemoryStore(globalLedger, {
        home, sessionId: `s-${tag}`, now: () => NOW, genId: () => `m_${tag}${++n}`,
        project: { root, ledger },
      });
    },
  };
}

export function cleanupFixtures(): void {
  for (const p of writable.splice(0)) { try { chmodSync(p, 0o700); } catch { /* gone */ } }
  for (const b of made.splice(0)) rmSync(b, { recursive: true, force: true });
}

/** The `content` of every row of a ledger file, in order; [] when the file is absent. */
export function rowsIn(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '')
    .map((l) => (JSON.parse(l) as { content: string }).content);
}

/** The project keys of the home registry (the reserved global key is left out); [] when there is no registry. */
export function registryKeys(home: string): string[] {
  const p = join(home, 'projects.json');
  if (!existsSync(p)) return [];
  return Object.keys(JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>).filter((k) => !k.startsWith('@'));
}
