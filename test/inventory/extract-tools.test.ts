// The tool-surface extractor's contract. The count is never hard-coded: a hard-coded list is how
// the shipped tree came to say "Seven MCP tools", and pinning the count is the committed inventory
// snapshot's job.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromBundle, fromSource, compareSurfaces, extractTools } from '../../scripts/inventory/extract-tools.js';

describe('tool surface extraction', () => {
  it('recovers the same tool set from the shipped bundle and from the source registry', async () => {
    const [bundle, source] = await Promise.all([fromBundle(), fromSource()]);
    expect(bundle.map((t) => t.name)).toEqual(source.map((t) => t.name));
    expect(bundle.length).toBeGreaterThan(1);
  }, 60_000);

  it('carries description and input schema, not just names', async () => {
    const tools = await extractTools();
    const commit = tools.find((t) => t.name === 'helix_memory_commit');
    expect(commit, 'helix_memory_commit is no longer registered').toBeDefined();
    expect(commit!.description.length).toBeGreaterThan(0);
    expect(commit!.inputSchema).toBeDefined();
  }, 60_000);

  it('removes the temporary home it created, so a run outside vitest does not accumulate them', async () => {
    // Run under a private temporary root belonging to this file alone. Counting `helix-inv-*` in a
    // shared temporary directory mixes in directories that other test files of the same run create
    // and remove concurrently, so the case passes or fails for reasons unrelated to the extractor
    // (measured: a failure at before=1, after=0). Under a private root whatever remains is what the
    // extractor left, so the assertion can demand the empty set rather than mere invariance.
    const priv = mkdtempSync(join(tmpdir(), 'helix-tmproot-'));
    const prior = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    try {
      process.env.TMPDIR = priv;
      process.env.TMP = priv;
      process.env.TEMP = priv;
      await extractTools();
      expect(readdirSync(priv), 'extractTools left its temporary HELIX_HOME behind').toEqual([]);
    } finally {
      // `process.env.X = undefined` stores the string "undefined", so the restore deletes the key.
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try { rmSync(priv, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 60_000);

  // `fromSource` changes `process.env.HELIX_HOME` temporarily so that the home `buildServer`
  // resolves for itself points at a temporary directory. If that value survives in the process,
  // another recovery in the same process reads an already-removed temporary directory as the real
  // home. Leaving the string "undefined" behind on a variable that was absent is the same class of
  // contamination, so the restore-by-deletion is checked as well.
  it('leaves process.env.HELIX_HOME exactly as it found it', async () => {
    const prior = process.env.HELIX_HOME;
    try {
      delete process.env.HELIX_HOME;
      await fromSource();
      expect('HELIX_HOME' in process.env, 'fromSource left HELIX_HOME defined').toBe(false);

      process.env.HELIX_HOME = '/nonexistent/helix-prior-marker';
      await fromSource();
      expect(process.env.HELIX_HOME, 'fromSource did not restore the prior value').toBe('/nonexistent/helix-prior-marker');
    } finally {
      if (prior === undefined) delete process.env.HELIX_HOME;
      else process.env.HELIX_HOME = prior;
    }
  }, 60_000);

  // Negative control: does the comparator actually refuse a disagreement? Without it the two cases
  // above stay green even if the comparator always passes.
  it('rejects a surface that differs by one name', () => {
    const a = [{ name: 'helix_memory_commit', description: 'd', inputSchema: {} }];
    const b = [{ name: 'helix_memory_commmit', description: 'd', inputSchema: {} }];
    expect(() => compareSurfaces(a, b)).toThrow(/tool-surface-disagreement/);
  });

  it('rejects a surface that differs only by input schema', () => {
    const a = [{ name: 'x', description: 'd', inputSchema: { a: 1 } }];
    const b = [{ name: 'x', description: 'd', inputSchema: { a: 2 } }];
    expect(() => compareSurfaces(a, b)).toThrow(/tool-surface-disagreement/);
  });

  it('accepts two identical surfaces', () => {
    const a = [{ name: 'x', description: 'd', inputSchema: { a: 1 } }];
    expect(() => compareSurfaces(a, structuredClone(a))).not.toThrow();
  });
});
