import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const cache = new Map<string, string>();

/** Bundle a repo TypeScript CLI to a temp `.mjs` and return its path, so a test can spawn it with
 *  `process.execPath` — plain `node`, no loader.
 *
 *  Why not `npx tsx <script.ts>`: `tsx` is in neither `package.json` nor `node_modules`, so that
 *  spelling makes every `npm test` on a clean machine resolve a FLOATING version off the registry
 *  and execute it with full developer privileges (and fail outright when offline). In a project
 *  whose thesis is a verifiable supply chain that is the one unpinned execution path. `esbuild` is
 *  already a pinned devDependency, and this is the discipline the repo states elsewhere —
 *  see `test/memory/lock-concurrency.test.ts`, which bundles its worker for exactly this reason.
 *
 *  The output is placed at `<tmp>/bin/<name>.mjs` with `data/` beside it as `<tmp>/data`, MIRRORING
 *  the shipped layout. That is not cosmetic: `data/semantic-neighbors.json` is resolved relative to
 *  `import.meta.url` (expansion.ts tries `../../data/…` for the source tree, then `../data/…` for a
 *  `bin/` bundle), so a bundle dropped straight into a temp directory silently loses query expansion
 *  — `defaultExpansion()` returns undefined and the CLI reports a degraded run. Reproducing the
 *  production depth means the test exercises the same asset resolution production does.
 *
 *  Cached per entry point per vitest worker: bundling is the expensive part and the output is
 *  deterministic for a given source tree. */
export async function bundleCli(entry: string): Promise<string> {
  const hit = cache.get(entry);
  if (hit) return hit;
  const root = mkdtempSync(join(tmpdir(), 'helix-clibundle-'));
  mkdirSync(join(root, 'bin'));
  const repoData = join(process.cwd(), 'data');
  try { symlinkSync(repoData, join(root, 'data'), 'dir'); }
  catch {                                    // no symlink privilege (Windows) — copy the one asset
    mkdirSync(join(root, 'data'));
    copyFileSync(join(repoData, 'semantic-neighbors.json'), join(root, 'data', 'semantic-neighbors.json'));
  }
  const out = join(root, 'bin', basename(entry).replace(/\.ts$/, '.mjs'));
  await build({
    entryPoints: [entry], outfile: out,
    bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
  });
  cache.set(entry, out);
  return out;
}
