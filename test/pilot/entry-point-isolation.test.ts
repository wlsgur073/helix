import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'scripts/pilot';

/** A structural invariant, not a behaviour: **a module guarded by `isEntryPoint` must never be
 *  imported by another module.**
 *
 *  The guard asks whether `import.meta.url` resolves to the same real path as `process.argv[1]`.
 *  Bundling erases the distinction it depends on: esbuild inlines a dependency into the entry
 *  bundle, so the dependency's `import.meta.url` becomes the BUNDLE's url — which is exactly
 *  `process.argv[1]`. The guard then answers "yes" for a module that is not the entry point and
 *  runs its `main()`.
 *
 *  Observed, not theorised: `prepare-gate` imported `readSnapshot` from `generate-manifest`, and
 *  the bundled prepare-gate CLI printed the GENERATOR's usage and exited 2 before doing anything.
 *  `isEntryPoint` cannot be repaired to cover it — inside a bundle the two modules genuinely are
 *  one file — so the rule has to be structural and this test is what holds it. The fix when this
 *  fails is to move the shared code into a module with nothing to guard (`snapshot.ts` is the one
 *  that already exists), never to relax the check. */
describe('entry-point isolation', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'));
  const source = new Map(files.map((f) => [f, readFileSync(join(DIR, f), 'utf8')]));
  // Anchored to column 0, because both patterns must distinguish CODE from PROSE ABOUT code. A
  // plain substring search first reported `snapshot.ts` as guarded — it matched the header comment
  // explaining this very rule. A guard and an import are top-level statements; comment bodies in
  // these files are indented.
  const guarded = files.filter((f) => /^if \(isEntryPoint\(import\.meta\.url\)\)/m.test(source.get(f)!));
  const importsSpec = (src: string, spec: string) =>
    new RegExp(String.raw`^(?:import|export)\b[^\n]*'${spec.replace(/[.]/g, '\\.')}'`, 'm').test(src);

  it('finds the guarded CLIs, so the check below is not vacuous', () => {
    expect(guarded.length).toBeGreaterThan(0);
  });

  it('no guarded module is imported by another script', () => {
    const violations: string[] = [];
    for (const [file, src] of source) {
      for (const g of guarded) {
        if (g === file) continue;
        const spec = `./${g.replace(/\.ts$/, '.js')}`;
        // Type-only imports are erased and cannot pull the guard in, but they are flagged anyway:
        // an `import type` is one keystroke away from becoming a value import, and the distinction
        // is invisible at the point where it breaks.
        if (importsSpec(src, spec)) violations.push(`${file} imports '${spec}', which has a main() guard`);
      }
    }
    expect(violations).toEqual([]);
  });
});
