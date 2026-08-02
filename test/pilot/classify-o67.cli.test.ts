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

  it('reserves the universe suffix case-INSENSITIVELY', () => {
    // x.UNIVERSE.JSON walked past a case-sensitive `endsWith` — and on a case-insensitive
    // filesystem (a drvfs mount is one) it IS the derived name, so a later run whose <out> was
    // x.json would overwrite this run's verdict artifact through the derived path.
    const { dir } = fixture();
    try {
      const manifest = { k: 20, probes: [{ id: 'p1', query: 'exit code contract', relevant: ['m_1'], unambiguous: true }] };
      const mPath = join(dir, 'manifest.json'); writeFileSync(mPath, JSON.stringify(manifest));
      let stderr = '';
      expect(() => {
        try {
          execFileSync(process.execPath, [cli, mPath, dir, join(dir, 'x.UNIVERSE.JSON')], { cwd: process.cwd(), stdio: 'pipe' });
        } catch (e) { stderr = String((e as { stderr?: Buffer }).stderr ?? ''); throw e; }
      }).toThrow();
      expect(stderr).toMatch(/reserved-output-suffix/);
      expect(existsSync(join(dir, 'x.UNIVERSE.JSON'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('classify-o67 collision inputs — every path the classification READS', () => {
  /** Round-3 finding, reproduced live: the input list held the manifest and the two ledgers, but
   *  the recall this program runs ALSO opens the ownership registry (home/projects.json), the
   *  repo-side .owner stamp, and the semantic-neighbor asset. An <out> aimed at the registry or
   *  the stamp while ABSENT was silently CREATED inside the frozen snapshot at exit 0; while
   *  present, the refusal was `output-exists`, whose old remedy text was the destructive repair.
   *  artifact-io's own contract: "inputs is every path this invocation READS, including ones no
   *  flag names." */
  const row = (id: string, content: string) => JSON.stringify({
    id, tx: '2026-07-20T00:00:00.000Z', validFrom: '2026-07-20T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content,
    provenance: { source: 'user', sessionId: 't' }, supersedes: null, blastRadius: null,
    reverifyTrigger: null, classification: 'normal',
  }) + '\n';

  const fixture = (opts: { adopt?: boolean; projectRows?: boolean } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'o67-inputs-'));
    const home = join(dir, 'home'); const projectRoot = join(dir, 'proj'); const proj = join(projectRoot, '.helix');
    mkdirSync(home, { recursive: true }); mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'memory.jsonl'), opts.projectRows === false ? '' : row('m_1', 'exit code two on usage error is the contract'));
    writeFileSync(join(home, 'memory.jsonl'), row('m_2', 'global background fact about releases and exit code contracts'));
    if (opts.adopt !== false) stampOwnership(projectRoot, home, { genStamp: () => 'o67-stamp' });
    const manifest = { k: 20, probes: [{ id: 'p1', query: 'exit code contract', relevant: ['m_2'], unambiguous: true }] };
    const mPath = join(dir, 'manifest.json'); writeFileSync(mPath, JSON.stringify(manifest));
    return { dir, mPath };
  };

  const refusal = (mPath: string, dir: string, out: string): { status: number; stderr: string } => {
    try {
      execFileSync(process.execPath, [cli, mPath, dir, out], { cwd: process.cwd(), stdio: 'pipe' });
      return { status: 0, stderr: '' };
    } catch (e) {
      const err = e as { status?: number; stderr?: Buffer };
      return { status: err.status ?? -1, stderr: String(err.stderr ?? '') };
    }
  };

  it('refuses <out> aimed at the PRESENT ownership registry as an alias, and the registry survives', () => {
    const { dir, mPath } = fixture();
    try {
      const registry = join(dir, 'home', 'projects.json');
      const before = readFileSync(registry, 'utf8');
      const r = refusal(mPath, dir, registry);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/output-aliases-input/);
      expect(readFileSync(registry, 'utf8')).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses <out> aimed at the PRESENT .owner stamp as an alias, and the stamp survives', () => {
    const { dir, mPath } = fixture();
    try {
      const owner = join(dir, 'proj', '.helix', '.owner');
      const before = readFileSync(owner, 'utf8');
      const r = refusal(mPath, dir, owner);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/output-aliases-input/);
      expect(readFileSync(owner, 'utf8')).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses <out> aimed at an ABSENT registry instead of minting one inside the frozen snapshot', () => {
    // The sharper half of the finding: with no adoption and an empty project ledger the run
    // otherwise COMPLETES, and the old input list let it create home/projects.json at exit 0 — a
    // registry file materialising inside a frozen snapshot, changing what every later run over
    // that snapshot serves.
    const { dir, mPath } = fixture({ adopt: false, projectRows: false });
    try {
      const registry = join(dir, 'home', 'projects.json');
      const r = refusal(mPath, dir, registry);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/output-aliases-input/);
      expect(existsSync(registry)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses <out> aimed at the ABSENT .owner stamp the same way', () => {
    const { dir, mPath } = fixture({ adopt: false, projectRows: false });
    try {
      const owner = join(dir, 'proj', '.helix', '.owner');
      const r = refusal(mPath, dir, owner);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/output-aliases-input/);
      expect(existsSync(owner)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses <out> aimed at the resolved semantic-neighbor asset as an ALIAS, not merely as existing', () => {
    // The asset is an ambient input — no argument names it, expansion.ts resolves it
    // module-relative and falls back silently — and `output-exists`'s remedy cannot know it is
    // load-bearing. Only the alias refusal states the truth: the run is not runnable as written.
    // (canonicalPath sees through the bundle's data/ symlink, so the repo spelling and the
    // bundle-resolved spelling are one file.)
    const { dir, mPath } = fixture();
    const asset = join(process.cwd(), 'data', 'semantic-neighbors.json');
    try {
      const before = readFileSync(asset, 'utf8');
      const r = refusal(mPath, dir, asset);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/output-aliases-input/);
      expect(readFileSync(asset, 'utf8')).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
