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

describe('supply chain: the one registry tool the repo does use is pinned (P2.b)', () => {
  // P2's other half. The finding was `npm test` fetching and executing an unpinned package; the fix
  // had two parts — stop the test suite spawning it (the case below), and pin the copy the remaining
  // npm-run entry points do use. Nothing measured the second part, so the version could drift back to
  // a range and the guard above would stay green: it reads test files, not package.json.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>; scripts: Record<string, string>;
  };

  it('tsx is an EXACT devDependency, not a range', () => {
    const spec = pkg.devDependencies.tsx;
    expect(spec, 'tsx is no longer a devDependency at all').toBeDefined();
    // A range prefix is the whole defect: `^4.23.5` resolves to whatever the registry serves today.
    expect(spec, `tsx is pinned loosely as ${spec}`).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the lockfile carries that exact version with an integrity hash', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; integrity?: string }>;
    };
    const entry = lock.packages['node_modules/tsx'];
    expect(entry, 'tsx has no lockfile entry, so an install is not reproducible').toBeDefined();
    expect(entry!.version).toBe(pkg.devDependencies.tsx);   // recovered from package.json, not typed twice
    expect(entry!.integrity, 'no integrity hash — the bytes are not pinned, only the version').toBeTruthy();
  });

  it('non-vacuity: something in the repo actually runs tsx', () => {
    // A pin guards nothing if no entry point uses it; this is what makes the two cases above load-bearing.
    const users = Object.entries(pkg.scripts).filter(([, cmd]) => /\btsx\b/.test(cmd)).map(([name]) => name);
    expect(users.length, 'no npm script runs tsx, so the pin has nothing to protect').toBeGreaterThan(0);
  });
});

describe('supply chain: the test suite is self-contained', () => {
  it('no test file spawns a program off the registry (P2)', () => {
    const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', 'test'], { encoding: 'utf8' })
      .split('\n')
      .filter((p) => p.endsWith('.ts') && p !== SELF);

    const offenders = tracked.filter((p) => NPX.test(stripComments(readFileSync(join(ROOT, p), 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
