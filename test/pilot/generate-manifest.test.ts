import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { bundleCli } from '../helpers/bundle-cli.js';

// Bundled with the pinned esbuild and spawned under plain `node`, not `npx tsx` — see
// test/helpers/bundle-cli.ts.
let cli: string;
beforeAll(async () => { cli = await bundleCli('scripts/pilot/generate-manifest.ts'); }, 30_000);

/** Characterization lock for the manifest generator, written BEFORE it was made importable.
 *  Its job is to hold the frozen enumeration behaviour still while the file is restructured:
 *  C5.1 items 3 and 4 both rewrite this generator, and neither can be tested until it stops
 *  executing on import. Every assertion here is current behaviour, deliberately, so a refactor
 *  that changes any of it fails loudly. */
describe('manifest generator (frozen enumeration behaviour)', () => {
  const row = (id: string, content: string) => JSON.stringify({
    id, tx: '2026-07-20T00:00:00.000Z', type: 'assert', content, supersedes: null,
  }) + '\n';

  /** The generator requires every scope recall serves to be present (items 3-4). These tests lock
   *  PROJECT-side enumeration, so the global ledger here is deliberately EMPTY — that keeps their
   *  inputs equivalent to the pre-merge ones, so what they characterize is unchanged. Merged-scope
   *  behaviour has its own lock in generate-manifest-scope-cutoff.test.ts. */
  const snapshotDirs = (dir: string) => {
    mkdirSync(join(dir, 'proj', '.helix'), { recursive: true });
    mkdirSync(join(dir, 'home'), { recursive: true });
    writeFileSync(join(dir, 'home', 'memory.jsonl'), '');
  };

  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'genman-'));
    snapshotDirs(dir);
    writeFileSync(join(dir, 'proj', '.helix', 'memory.jsonl'),
      row('m_1', 'store mutators throw on unknown identifier and the interface maps it') +
      row('m_2', 'retry backoff policy governs transient upload failures'));
    // Entry indices count EVERY top-level bullet, excluded ones included — the mapping file is
    // keyed on that full-array index, so an exclusion must not renumber what follows it.
    const oracle = join(dir, 'oracle.md');
    writeFileSync(oracle, [
      '# Notes',
      '- store mutators throw on unknown identifier and the interface maps it',
      '## Roadmap',
      '- an entry under a roadmap heading, excluded by segmentation rule v1',
      '# More',
      '- retry backoff policy governs transient upload failures',
      '',
    ].join('\n'));
    const mapping = join(dir, 'mapping.json');
    writeFileSync(mapping, JSON.stringify({ '0': ['m_1'], '2': ['m_2'] }));
    return { dir, oracle, mapping };
  };

  const generate = () => {
    const { dir, oracle, mapping } = fixture();
    const out = join(dir, 'manifest.json');
    execFileSync(process.execPath, [cli,dir, oracle, mapping, out], { cwd: process.cwd() });
    return { dir, manifest: JSON.parse(readFileSync(out, 'utf8')) };
  };

  it('emits ledger probes then oracle probes, at the frozen K', () => {
    const { dir, manifest } = generate();
    try {
      expect(manifest.k).toBe(20);
      expect(manifest.probes.map((p: { id: string }) => p.id)).toEqual(['L_m_1', 'L_m_2', 'O_0', 'O_2']);
      expect(manifest.probes.map((p: { side: string }) => p.side)).toEqual(['ledger', 'ledger', 'oracle', 'oracle']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('skips an excluded oracle entry WITHOUT renumbering the ones after it', () => {
    const { dir, manifest } = generate();
    try {
      const ids = manifest.probes.map((p: { id: string }) => p.id);
      expect(ids).not.toContain('O_1');   // the roadmap entry
      expect(ids).toContain('O_2');       // still index 2, not renumbered to 1
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('derives each ledger probe query from its own record and targets that record', () => {
    const { dir, manifest } = generate();
    try {
      const p = manifest.probes.find((x: { id: string }) => x.id === 'L_m_1');
      expect(p.relevant).toEqual(['m_1']);
      expect(p.query).toContain('mutators');
      expect(p.query.split(' ').length).toBeLessThanOrEqual(8);  // derivation rule v1 keeps 8 terms
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('flags a probe unambiguous only when no OTHER live record shares three or more query terms', () => {
    const { dir, manifest } = generate();
    try {
      // The two records share no meaningful vocabulary, so both ledger probes are unambiguous.
      expect(manifest.probes.find((p: { id: string }) => p.id === 'L_m_1').unambiguous).toBe(true);
      expect(manifest.probes.find((p: { id: string }) => p.id === 'L_m_2').unambiguous).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a competitor sharing three or more query terms makes the probe ambiguous', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genman-amb-'));
    try {
      snapshotDirs(dir);
      // Second record restates the first: their topic terms overlap well past the threshold.
      writeFileSync(join(dir, 'proj', '.helix', 'memory.jsonl'),
        row('m_1', 'store mutators throw on unknown identifier and the interface maps it') +
        row('m_2', 'store mutators throw on unknown identifier; the interface maps it as well'));
      const oracle = join(dir, 'oracle.md'); writeFileSync(oracle, '# N\n- unrelated bullet text here\n');
      const mapping = join(dir, 'mapping.json'); writeFileSync(mapping, JSON.stringify({}));
      const out = join(dir, 'manifest.json');
      execFileSync(process.execPath, [cli,dir, oracle, mapping, out], { cwd: process.cwd() });
      const m = JSON.parse(readFileSync(out, 'utf8'));
      expect(m.probes.find((p: { id: string }) => p.id === 'L_m_1').unambiguous).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('closes a record that a later row supersedes, so it is never enumerated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genman-sup-'));
    try {
      snapshotDirs(dir);
      writeFileSync(join(dir, 'proj', '.helix', 'memory.jsonl'),
        row('m_old', 'deployment timeout is thirty seconds by default') +
        JSON.stringify({ id: 'm_new', tx: '2026-07-21T00:00:00.000Z', type: 'supersede',
          content: 'deployment timeout is sixty seconds by default', supersedes: 'm_old' }) + '\n');
      const oracle = join(dir, 'oracle.md'); writeFileSync(oracle, '# N\n- unrelated bullet text here\n');
      const mapping = join(dir, 'mapping.json'); writeFileSync(mapping, JSON.stringify({}));
      const out = join(dir, 'manifest.json');
      execFileSync(process.execPath, [cli,dir, oracle, mapping, out], { cwd: process.cwd() });
      const ids = JSON.parse(readFileSync(out, 'utf8')).probes.map((p: { id: string }) => p.id);
      expect(ids).toContain('L_m_new');
      expect(ids).not.toContain('L_m_old');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('manifest generator is importable', () => {
  it('exposes the enumeration as a pure function without executing on import', async () => {
    // This test passing at all is the deliverable: before the refactor the module ran its argv
    // parsing at top level, so importing it called process.exit(2) and no test could reach it.
    // Being importable from test/ is also what pulls the file into the typecheck program.
    const { buildProbes, liveRows, K } = await import('../../scripts/pilot/generate-manifest.js');
    expect(K).toBe(20);
    const rows = [
      { id: 'm_a', type: 'assert', content: 'deployment timeout is thirty seconds by default', supersedes: null },
      { id: 'm_b', type: 'supersede', content: 'deployment timeout is sixty seconds by default', supersedes: 'm_a' },
    ];
    expect(liveRows(rows).map((r) => r.id)).toEqual(['m_b']);
    const probes = buildProbes(
      [{ scope: 'global', rows: [] }, { scope: 'project', rows }],
      { md: '# N\n- unrelated bullet text here\n', mapping: {} },
    );
    expect(probes.map((p) => p.id)).toEqual(['L_m_b', 'O_0']);
  });
});
