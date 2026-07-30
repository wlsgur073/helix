import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { stampOwnership } from '../../src/memory/ownership.js';
import { bundleCli } from '../helpers/bundle-cli.js';

/** The classifier's pool construction (classify-o67.ts main()) is not exported and only runs under
 *  the entry-point guard, so it is exercised here through the CLI against a production-faithful
 *  dual-scope snapshot — the same fixture shape test/pilot/run-pilot.test.ts uses. */
// Bundled with the pinned esbuild and spawned under plain `node` — see test/helpers/bundle-cli.ts
// for why `npx tsx` is not used. This is also what forced the CLI's entry guard to compare path
// IDENTITY rather than an `.endsWith('.ts')` spelling: under the old guard a bundled CLI exited 0
// having done nothing, and every assertion below would have failed on a missing output file.
let cli: string;
beforeAll(async () => { cli = await bundleCli('scripts/pilot/classify-o67.ts'); }, 30_000);

describe('classify-o67 CLI', () => {
  const row = (id: string, content: string) => JSON.stringify({
    id, tx: '2026-07-20T00:00:00.000Z', validFrom: '2026-07-20T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content,
    provenance: { source: 'user', sessionId: 't' }, supersedes: null, blastRadius: null,
    reverifyTrigger: null, classification: 'normal',
  }) + '\n';

  const fixture = (opts: { adopt?: boolean } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'o67-cli-'));
    const home = join(dir, 'home'); const projectRoot = join(dir, 'proj'); const proj = join(projectRoot, '.helix');
    mkdirSync(home, { recursive: true }); mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'memory.jsonl'), row('m_1', 'exit code two on usage error is the contract'));
    // Shares "exit code contract" with the project row so ONE probe recalls BOTH scopes.
    writeFileSync(join(home, 'memory.jsonl'), row('m_2', 'global background fact about releases and exit code contracts'));
    if (opts.adopt !== false) stampOwnership(projectRoot, home, { genStamp: () => 'o67-stamp' });
    return { dir, projectRoot };
  };

  it('writes a scope-qualified candidate-universe artifact beside its verdicts', () => {
    const { dir } = fixture();
    try {
      const manifest = { k: 20, probes: [{ id: 'p1', query: 'exit code contract', relevant: ['m_1'], unambiguous: true }] };
      const mPath = join(dir, 'manifest.json'); writeFileSync(mPath, JSON.stringify(manifest));
      const out = join(dir, 'out.json');
      execFileSync(process.execPath, [cli,mPath, dir, out], { cwd: process.cwd() });

      const universePath = join(dir, 'out.universe.json');
      expect(existsSync(universePath)).toBe(true);
      const u = JSON.parse(readFileSync(universePath, 'utf8'));

      // Both scopes appear, each identity carrying its scope, sorted by identity (never by rank).
      const p1 = u.probes.find((p: { id: string }) => p.id === 'p1');
      expect(p1.candidates).toEqual(['global:m_2', 'project:m_1']);
      // The recall bound is the physical row count across both ledgers, recorded for audit.
      expect(u.recallBound).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('still writes its verdicts unchanged — the universe is a SEPARATE artifact', () => {
    const { dir } = fixture();
    try {
      const manifest = { k: 20, probes: [{ id: 'p1', query: 'exit code contract', relevant: ['m_1'], unambiguous: true }] };
      const mPath = join(dir, 'manifest.json'); writeFileSync(mPath, JSON.stringify(manifest));
      const out = join(dir, 'out.json');
      execFileSync(process.execPath, [cli,mPath, dir, out], { cwd: process.cwd() });

      const v = JSON.parse(readFileSync(out, 'utf8'));
      expect(v.rule).toBe('o67-class-rule-2026-07');
      expect(v.summary.census).toBe(1);
      expect(v.probes[0].id).toBe('p1');
      // No universe field leaked into the verdict artifact — its bytes must stay reproducible.
      expect(v.universe).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('records the recall disclosure production returns, so a degraded run is not mistaken for a small corpus', () => {
    const { dir } = fixture();
    try {
      const manifest = { k: 20, probes: [{ id: 'p1', query: 'exit code contract', relevant: ['m_1'], unambiguous: true }] };
      const mPath = join(dir, 'manifest.json'); writeFileSync(mPath, JSON.stringify(manifest));
      const out = join(dir, 'out.json');
      execFileSync(process.execPath, [cli,mPath, dir, out], { cwd: process.cwd() });
      const u = JSON.parse(readFileSync(join(dir, 'out.universe.json'), 'utf8'));
      expect(u.disclosure.projectDisposition).toBe('owned');
      expect(u.disclosure.rowsByScope).toEqual({ global: 1, project: 1 });
      // Recorded, not assumed: this fixture has no master key, so the verifying replay runs in
      // key-absent mode and reports false. What matters is that the artifact CARRIES the fact.
      expect(u.disclosure.integrityAvailable).toBe(false);
      expect(Array.isArray(u.disclosure.witnessNotes)).toBe(true);
      // The semantic-neighbor asset is a SILENT input to recall: expansion.ts falls back to
      // undefined on any read/parse failure without a warning, and semantically-rescued records
      // change the UNIVERSE without ever changing a verdict (they carry zero lexical evidence, so
      // they can never be witnesses). The pinned verdict hashes therefore cannot detect its
      // absence — only this field can.
      expect(u.disclosure.expansionAvailable).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('FAILS CLOSED when the project ledger has rows but the scope did not participate', () => {
    // The un-adopted state a relocated snapshot produces — and rule §6 prescribes relocating one
    // ("snapshot the cutoff corpus"), while ownership is keyed on the canonical absolute path.
    const { dir } = fixture({ adopt: false });
    try {
      const manifest = { k: 20, probes: [{ id: 'p1', query: 'exit code contract', relevant: ['m_1'], unambiguous: true }] };
      const mPath = join(dir, 'manifest.json'); writeFileSync(mPath, JSON.stringify(manifest));
      const out = join(dir, 'out.json');
      let stderr = '';
      expect(() => {
        try {
          execFileSync(process.execPath, [cli,mPath, dir, out], { cwd: process.cwd(), stdio: 'pipe' });
        } catch (e) { stderr = String((e as { stderr?: Buffer }).stderr ?? ''); throw e; }
      }).toThrow();
      expect(stderr).toMatch(/scope-did-not-participate/);
      expect(existsSync(join(dir, 'out.universe.json'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses an output path that would collide with a universe artifact', () => {
    const { dir } = fixture();
    try {
      const manifest = { k: 20, probes: [{ id: 'p1', query: 'exit code contract', relevant: ['m_1'], unambiguous: true }] };
      const mPath = join(dir, 'manifest.json'); writeFileSync(mPath, JSON.stringify(manifest));
      let stderr = '';
      expect(() => {
        try {
          execFileSync(process.execPath, [cli,mPath, dir, join(dir, 'x.universe.json')], { cwd: process.cwd(), stdio: 'pipe' });
        } catch (e) { stderr = String((e as { stderr?: Buffer }).stderr ?? ''); throw e; }
      }).toThrow();
      expect(stderr).toMatch(/reserved-output-suffix/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
