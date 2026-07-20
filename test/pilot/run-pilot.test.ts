import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

describe('pilot runner', () => {
  it('scores ranks at K=20 deterministically from a manifest against a snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pilot-'));
    try {
      const home = join(dir, 'home'); const proj = join(dir, 'proj', '.helix');
      mkdirSync(home, { recursive: true }); mkdirSync(proj, { recursive: true });
      const row = { id: 'm_1', tx: '2026-07-20T00:00:00.000Z', validFrom: '2026-07-20T00:00:00.000Z', validTo: null,
        type: 'assert', state: 'Fresh', content: 'exit code two on usage error is the contract',
        provenance: { source: 'user', sessionId: 't' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' };
      writeFileSync(join(proj, 'memory.jsonl'), JSON.stringify(row) + '\n');
      const manifest = { k: 20, probes: [{ id: 'p1', query: 'exit code usage error contract', relevant: ['m_1'], unambiguous: true }] };
      const mPath = join(dir, 'manifest.json'); writeFileSync(mPath, JSON.stringify(manifest));
      const out = join(dir, 'out.json');
      execFileSync('npx', ['tsx', 'scripts/pilot/run-pilot.ts', mPath, dir, out], { cwd: process.cwd() });
      const res = JSON.parse(readFileSync(out, 'utf8'));
      expect(res.results[0]).toMatchObject({ id: 'p1', bestRank: 1, hitAtK: true, hitAt1: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
