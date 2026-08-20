// Mutation validation: does an extractor actually recover an injected mutation?
//
// Mutating a local copy of the committed snapshot and asserting `not.toEqual` does not establish
// that. What it establishes is that vitest's `toEqual` works, and it passes even if
// `buildSurface()` is broken into returning nothing but empty arrays. So the first two cases below
// CALL the extractor directly and inject the mutation into its input — a temporary copy of the
// bundle, a fixture directory — to see whether the output really changes. The mutation exists only
// under a temporary path outside the repository; `bin/` and the production code are never touched.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SURFACE_PATH, type Surface } from '../../scripts/inventory/build-inventory.js';
import { fromBundle, compareSurfaces } from '../../scripts/inventory/extract-tools.js';
import { extractEnvVars } from '../../scripts/inventory/extract-config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the extractors recover an injected mutation', () => {
  // The tool surface. One registered name is changed in a temporary copy of the shipped bundle, and
  // the extractor is asked whether it reads that copy and reports the changed name. An extractor
  // returning a constant fails this case.
  it('reports the planted tool name when the bundle it reads carries one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-mut-bundle-'));
    try {
      const mutated = join(dir, 'helix-mcp.mjs');
      const original = readFileSync(join(ROOT, 'bin', 'helix-mcp.mjs'), 'utf8');
      writeFileSync(mutated, original.replaceAll('helix_memory_commit', 'helix_memory_planted'));

      const shipped = await fromBundle();
      const planted = await fromBundle(mutated);

      // Negative control: the unmutated side reports the original name and does not disagree with itself.
      expect(shipped.map((t) => t.name)).toContain('helix_memory_commit');
      expect(() => compareSurfaces(shipped, structuredClone(shipped))).not.toThrow();

      // With the mutation injected the extractor's output changes, and the comparator refuses it.
      expect(planted.map((t) => t.name)).toContain('helix_memory_planted');
      expect(planted.map((t) => t.name)).not.toContain('helix_memory_commit');
      expect(() => compareSurfaces(shipped, planted)).toThrow(/tool-surface-disagreement/);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 90_000);

  // Environment variables. Does the extractor recover a read planted in a fixture directory? The
  // control is the same directory holding only unmutated files.
  it('recovers an environment-variable read planted in a fixture bundle', () => {
    const clean = mkdtempSync(join(tmpdir(), 'helix-mut-env-clean-'));
    const mutant = mkdtempSync(join(tmpdir(), 'helix-mut-env-plant-'));
    try {
      writeFileSync(join(clean, 'a.mjs'), 'const h = process.env.HELIX_HOME;\nexport default h;\n');
      writeFileSync(join(mutant, 'a.mjs'), 'const h = process.env.HELIX_HOME;\nexport default h;\n');
      writeFileSync(join(mutant, 'b.mjs'), 'export const p = process.env.HELIX_PLANTED_BY_MUTATION;\n');

      expect(extractEnvVars(clean).map((e) => e.name)).toEqual(['HELIX_HOME']);
      expect(extractEnvVars(mutant).map((e) => e.name)).toEqual(['HELIX_HOME', 'HELIX_PLANTED_BY_MUTATION']);
    } finally {
      for (const d of [clean, mutant]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  });

  // The unrecognised form. When an access the regex cannot see in principle is introduced, the
  // recovery drops it in silence, so extraction itself has to fail. A drift test does not detect
  // this class: the live recovery misses it too, so nothing disagrees with the snapshot.
  it('fails instead of silently omitting a bracket-form environment read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-mut-env-bracket-'));
    try {
      writeFileSync(join(dir, 'a.mjs'), "export const p = process.env['HELIX_HIDDEN'];\n");
      expect(() => extractEnvVars(dir)).toThrow(/env-read-form-unrecognized/);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});

// Narrowed to `keyof Surface`: `Record<string, unknown[]>` is treated as a string index signature,
// which under `noUncheckedIndexedAccess` types every property access — `live.tools` and the rest —
// as `unknown[] | undefined`. Restricting it to the five fields keeps each array element `unknown`
// (so a mutation can still be injected) while guaranteeing the array itself is always present.
const committed = (): Record<keyof Surface, unknown[]> => JSON.parse(readFileSync(SURFACE_PATH, 'utf8'));

// This section establishes only that the snapshot comparison is FIELD-LEVEL, not that the
// extractors are complete — the section above covers that. A case that merely adds an element is a
// tautology, passing even over an empty array, so none is kept here.
describe('the snapshot comparison is field-level, not merely length-level', () => {
  it('a removed config leaf makes the two objects differ', () => {
    const live = committed();
    live.configLeaves = live.configLeaves.slice(1);
    expect(live).not.toEqual(committed());
  });

  it('a changed hook timeout makes the two objects differ', () => {
    const live = committed();
    live.hooks = live.hooks.map((h, i) => (i === 0 ? { ...(h as object), timeout: 999 } : h));
    expect(live).not.toEqual(committed());
  });

  it('a changed CLI usage line makes the two objects differ', () => {
    const live = committed();
    live.clis = live.clis.map((c, i) => (i === 0 ? { ...(c as object), usage: 'planted' } : c));
    expect(live).not.toEqual(committed());
  });

  // The concrete trap this guards: walking DEFAULT_CONFIG alone drops all six compaction leaves.
  it('the committed snapshot actually carries the compaction leaves', () => {
    const paths = (committed().configLeaves as Array<{ path: string }>).map((l) => l.path);
    expect(paths.filter((p) => p.startsWith('compaction.')).length).toBe(6);
  });
});
