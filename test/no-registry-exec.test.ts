// P2, executable: `npm test` must never fetch and execute an unpinned program off the registry.
// `test/pilot/run-pilot.test.ts` used to run `execFileSync('npx', ['tsx', …])` while tsx was in
// neither package.json nor node_modules, so a plain `npm test` reached npmjs.com and executed
// whatever version it got, with full developer privileges, in a project whose thesis is a verifiable
// supply chain. The call site is gone and every CLI test now bundles with the pinned esbuild and
// spawns plain `node` (test/helpers/bundle-cli.ts), but nothing stopped the next one being written.
//
// `npx` is the shape that matters, not tsx: it falls back to a FLOATING registry version whenever
// the local copy is absent — a fresh clone before `npm ci`, a pruned production install, an
// `npx tsx@latest` typo — so a suite that CAN reach the network on some machines and not others is
// the one unpinned execution path left.
//
// Comments are stripped before matching. Every current mention of npx in the test tree is prose
// explaining why it is not used, including in this file, and a guard that fired on its own rationale
// would be deleted within a week.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'test/no-registry-exec.test.ts';

/** Quoted `npx` used as a program name — `'npx',` as a spawn's first argument, or a command string
 *  beginning `npx `. Backticks are included, so template-literal command strings are covered too;
 *  that is exactly why comment stripping above is not optional. Assembled from parts so this
 *  constant does not match itself once comments are gone. */
const NPX = new RegExp(`(['"\`])${'np' + 'x'}(\\1|\\s)`);

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')        // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1');      // line comments; [^:] spares https:// inside strings
}

describe('supply chain: the test suite is self-contained', () => {
  it('no test file spawns a program off the registry (P2)', () => {
    const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', 'test'], { encoding: 'utf8' })
      .split('\n')
      .filter((p) => p.endsWith('.ts') && p !== SELF);

    const offenders = tracked.filter((p) => NPX.test(stripComments(readFileSync(join(ROOT, p), 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
