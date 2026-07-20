import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { stampOwnership } from '../../src/memory/ownership.js';

describe('pilot runner', () => {
  it('scores ranks at K=20 deterministically from a manifest against a production-faithful dual-scope (global + owned project) snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pilot-'));
    try {
      const home = join(dir, 'home'); const projectRoot = join(dir, 'proj'); const proj = join(projectRoot, '.helix');
      mkdirSync(home, { recursive: true }); mkdirSync(proj, { recursive: true });
      const projectRow = { id: 'm_1', tx: '2026-07-20T00:00:00.000Z', validFrom: '2026-07-20T00:00:00.000Z', validTo: null,
        type: 'assert', state: 'Fresh', content: 'exit code two on usage error is the contract',
        provenance: { source: 'user', sessionId: 't' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' };
      writeFileSync(join(proj, 'memory.jsonl'), JSON.stringify(projectRow) + '\n');
      // GLOBAL-scope row (distinct fact, lives under snapshot/home/memory.jsonl, not the project ledger).
      // Shares "exit code contract" with the project row on purpose, so one probe query can hit BOTH —
      // proving the runner actually merges scopes rather than reading the project ledger alone.
      const globalRow = { id: 'm_2', tx: '2026-07-20T00:00:00.000Z', validFrom: '2026-07-20T00:00:00.000Z', validTo: null,
        type: 'assert', state: 'Fresh', content: 'global background fact about releases and exit code contracts',
        provenance: { source: 'user', sessionId: 't' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' };
      writeFileSync(join(home, 'memory.jsonl'), JSON.stringify(globalRow) + '\n');
      // Production only merges the project scope into recall when it is OWNED (src/memory/ownership.ts
      // isOwned / MemoryStore's disposition gate) — an un-adopted ledger file reads as
      // 'unadopted-present' and is excluded. Replicate that minimal adoption state here (deterministic
      // stamp — no randomness in the fixture's ownership credential either).
      stampOwnership(projectRoot, home, { genStamp: () => 'pilot-stamp' });
      const manifest = {
        k: 20,
        probes: [
          { id: 'p1', query: 'exit code usage error contract', relevant: ['m_1'], unambiguous: true },
          // Deliberately ambiguous across scopes: both m_1 (project) and m_2 (global) contain
          // "exit code contract" — proves the merge is live, not just that the project scope works.
          { id: 'p2', query: 'exit code contract', relevant: ['m_1', 'm_2'], unambiguous: false },
        ],
      };
      const mPath = join(dir, 'manifest.json'); writeFileSync(mPath, JSON.stringify(manifest));
      const out = join(dir, 'out.json');
      execFileSync('npx', ['tsx', 'scripts/pilot/run-pilot.ts', mPath, dir, out], { cwd: process.cwd() });
      const res = JSON.parse(readFileSync(out, 'utf8'));
      // p1: the project scope still contributes and still ranks its OWN targeted query's record first.
      expect(res.results[0]).toMatchObject({ id: 'p1', bestRank: 1, hitAtK: true, hitAt1: true });
      // p2: both the project-scope id AND the global-scope id come back from the SAME recall call —
      // direct evidence the runner reads global+project together, not the project ledger alone.
      expect(res.results[1]).toMatchObject({ id: 'p2' });
      expect(res.results[1].returned).toEqual(expect.arrayContaining(['m_1', 'm_2']));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
