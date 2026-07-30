/** Snapshot reading, shared by the pilot scripts — and deliberately a module with NO top-level
 *  side effect and NO `main()`.
 *
 *  That is the whole reason this file exists separately from `generate-manifest.ts`, which owned
 *  these readers first. A module guarded by `isEntryPoint(import.meta.url)` must never be imported
 *  by another module, because the guard cannot survive bundling: esbuild inlines a dependency into
 *  the entry bundle, so the dependency's `import.meta.url` becomes the BUNDLE's url, which is
 *  exactly `process.argv[1]`. The guard then answers "yes, I am the entry point" for a module that
 *  is not one, and its `main()` runs — observed when `prepare-gate` imported `readSnapshot` from
 *  the generator and the bundled CLI printed the generator's usage and exited 2.
 *
 *  `isEntryPoint` cannot be fixed to cover this: inside a bundle the two modules genuinely are one
 *  file, so there is no identity left to distinguish. The rule is structural instead — shared code
 *  lives in files that have nothing to guard — and `test/pilot/entry-point-isolation.test.ts` holds
 *  it in place. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryScope } from '../../src/types.js';

export interface LedgerRow { id: string; type: string; content: string; supersedes: string | null; tx?: string }
export interface ScopedLedger { scope: MemoryScope; rows: LedgerRow[] }

/** One scope's ledger. ABSENT is fatal, not empty: a snapshot copied without its global ledger
 *  produces a well-formed manifest whose probes are unambiguous only because their competitors
 *  were never read — indistinguishable, afterwards, from a corpus that genuinely has none. */
export const readLedger = (path: string): LedgerRow[] => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`ledger-unreadable: ${path} (${(e as Error).message}). Every scope recall serves must be ` +
      'present, or the unambiguity denominator is narrower than the universe the runner ranks against');
  }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerRow);
};

/** The snapshot layout run-pilot.ts also reads: home/ is the global scope, proj/ the project. */
export const readSnapshot = (snapshotDir: string): ScopedLedger[] => [
  { scope: 'global', rows: readLedger(join(snapshotDir, 'home', 'memory.jsonl')) },
  { scope: 'project', rows: readLedger(join(snapshotDir, 'proj', '.helix', 'memory.jsonl')) },
];
