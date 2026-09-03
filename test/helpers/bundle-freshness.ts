import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The six bundles `build.mjs` produces. This list IS the executable surface that ships, so it has
 * to be extended whenever `build.mjs` gains an entry point. `helix-trust-resolve.mjs` was added to
 * `build.mjs` on 2026-09-01 and not to this list, and the omission was invisible: with a real
 * divergence injected into that bundle, the five-entry list returned `[]` — no staleness reported —
 * while a six-entry list named it. The candidate receipt already pins all six (11 artifacts =
 * 6 bundles + 3 manifest + 2 claim set), so this list was the only place still counting five.
 */
const BUNDLES: readonly string[] = [
  'helix-mcp.mjs',
  'helix-trigger.mjs',
  'helix-rebaseline.mjs',
  'helix-trust-resolve.mjs',
  'hooks/session-start.mjs',
  'hooks/session-end.mjs',
];

/**
 * Rebuilds `src/` into a temporary directory, compares the result byte for byte against the
 * committed `bin/`, and returns the relative paths of the bundles that differ. An empty array means
 * `bin/` is identical to a rebuild of `src/`.
 *
 * It is a shared helper because two places need the same fact. `test/plugin/packaging.test.ts` asks
 * whether `bin/` is stale; `test/docs/shipped-claims.doc.test.ts` asks whether the values it
 * obtained by running `src/` can stand as evidence about the shipped bundle. The second question is
 * answered by the first fact, so if each file kept its own copy of the rebuild logic one of them
 * could drift without anyone noticing.
 *
 * esbuild emits the same bytes for the same version and the same input. A difference therefore means
 * `src/` and `bin/` have diverged, and `bin/` must be rebuilt with `npm run build` and committed.
 */
export function staleBundles(): string[] {
  const out = mkdtempSync(join(tmpdir(), 'helix-freshbuild-'));
  execFileSync(process.execPath, [join(ROOT, 'build.mjs')], {
    cwd: ROOT,
    env: { ...process.env, HELIX_BUILD_OUT: out },
    stdio: 'ignore',
  });
  return BUNDLES.filter(
    (rel) => !readFileSync(join(out, rel)).equals(readFileSync(join(ROOT, 'bin', rel))),
  );
}
