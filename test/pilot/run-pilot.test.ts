import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { globalScopeNonce, stampOwnership } from '../../src/memory/ownership.js';
import { defaultExpansion } from '../../src/memory/expansion.js';
import { expansionTableSha256, sha256BytesOrAbsent, snapshotTrustPaths } from '../../scripts/pilot/pin-hashes.js';
import { bundleCli } from '../helpers/bundle-cli.js';

// Bundled with the pinned esbuild and spawned under plain `node`, NOT `npx tsx`: tsx is not a
// dependency of this repo, so the old spelling fetched a floating version off the registry on every
// `npm test`. See test/helpers/bundle-cli.ts.
let cli: string;
beforeAll(async () => { cli = await bundleCli('scripts/pilot/run-pilot.ts'); }, 30_000);

describe('pilot runner', () => {
  it('scores ranks at K=20 deterministically from a manifest against a production-faithful dual-scope (global + owned project) snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pilot-'));
    try {
      const home = join(dir, 'home'); const projectRoot = join(dir, 'proj'); const proj = join(projectRoot, '.helix');
      mkdirSync(home, { recursive: true }); mkdirSync(proj, { recursive: true });
      const projectRow = { id: 'm_1', tx: '2026-07-20T00:00:00.000Z', validFrom: '2026-07-20T00:00:00.000Z', validTo: null,
        type: 'assert', state: 'Fresh', content: 'exit code two on usage error is the contract',
        provenance: { source: 'user', sessionId: 't' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' };
      const projectText = JSON.stringify(projectRow) + '\n';
      writeFileSync(join(proj, 'memory.jsonl'), projectText);
      // GLOBAL-scope row (distinct fact, lives under snapshot/home/memory.jsonl, not the project ledger).
      // Shares "exit code contract" with the project row on purpose, so one probe query can hit BOTH —
      // proving the runner actually merges scopes rather than reading the project ledger alone.
      const globalRow = { id: 'm_2', tx: '2026-07-20T00:00:00.000Z', validFrom: '2026-07-20T00:00:00.000Z', validTo: null,
        type: 'assert', state: 'Fresh', content: 'global background fact about releases and exit code contracts',
        provenance: { source: 'user', sessionId: 't' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' };
      const globalText = JSON.stringify(globalRow) + '\n';
      writeFileSync(join(home, 'memory.jsonl'), globalText);
      // Production only merges the project scope into recall when it is OWNED (src/memory/ownership.ts
      // isOwned / MemoryStore's disposition gate) — an un-adopted ledger file reads as
      // 'unadopted-present' and is excluded. Replicate that minimal adoption state here (deterministic
      // stamp — no randomness in the fixture's ownership credential either).
      stampOwnership(projectRoot, home, { genStamp: () => 'pilot-stamp' });
      // '@global' must pre-exist or the store would MINT one into the snapshot on first recall —
      // the runner refuses an incomplete registry rather than let that write happen.
      globalScopeNonce(home);
      const manifest = {
        k: 20,
        probes: [
          { id: 'p1', query: 'exit code usage error contract', relevant: ['m_1'], unambiguous: true },
          // Deliberately ambiguous across scopes: both m_1 (project) and m_2 (global) contain
          // "exit code contract" — proves the merge is live, not just that the project scope works.
          { id: 'p2', query: 'exit code contract', relevant: ['m_1', 'm_2'], unambiguous: false },
        ],
      };
      const mPath = join(dir, 'manifest.json');
      const mText = JSON.stringify(manifest);
      writeFileSync(mPath, mText);
      // The runner binds to a prepared gate set (preregistration §9 item 5) but takes its PROBES
      // from the manifest, so this fixture's gate set has to be internally hash-consistent AND pin
      // the manifest's own bytes — the runner refuses a manifest that is not the pinned one, so a
      // gate set without `inputs.manifest` cannot be measured against any manifest at all.
      // The gate set pins the CORPUS bytes too (`ledger:global` / `ledger:project`), because the
      // runner refuses a snapshot whose ledger hashes do not byte-agree with the freeze's pins.
      const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
      // The eight pins the runner consumes (classifier/universe are prepare-side and never read
      // here): manifest + both ledgers by utf8 text, the four trust files by raw bytes or the
      // 'absent' sentinel, and the resolved expansion table by content.
      const trustPaths = snapshotTrustPaths(dir);
      const gPayload = { rule: 'v2-gate-composition-2026-07-29', k: 20, recallDenominator: ['p1', 'p2'],
        inputs: { manifest: sha256(mText),
          'ledger:global': sha256(globalText), 'ledger:project': sha256(projectText),
          'ownership:registry': sha256BytesOrAbsent('(fixture)', trustPaths['ownership:registry']!),
          'ownership:owner': sha256BytesOrAbsent('(fixture)', trustPaths['ownership:owner']!),
          'trust:master-key': sha256BytesOrAbsent('(fixture)', trustPaths['trust:master-key']!),
          'trust:witness': sha256BytesOrAbsent('(fixture)', trustPaths['trust:witness']!),
          'expansion:semantic-neighbors': expansionTableSha256(defaultExpansion()!) } };
      const gPath = join(dir, 'gate-set.json');
      writeFileSync(gPath, JSON.stringify({ artifact: 'gate-set',
        payloadSha256: createHash('sha256').update(JSON.stringify(gPayload), 'utf8').digest('hex'),
        payload: gPayload, receipts: { preparedAt: '2026-08-18T09:00:00.000Z', attestation: 'self-reported' },
      }, null, 1) + '\n');
      const out = join(dir, 'out.json');
      execFileSync(process.execPath,
        [cli, '--manifest', mPath, '--snapshot', dir, '--gate-set', gPath, '--out', out], { cwd: process.cwd() });
      const res = JSON.parse(readFileSync(out, 'utf8')).payload;
      // p1: the project scope still contributes and still ranks its OWN targeted query's record first.
      expect(res.results[0]).toMatchObject({ id: 'p1', bestRank: 1, hitAtK: true, hitAt1: true });
      // p2: both the project-scope id AND the global-scope id come back from the SAME recall call —
      // direct evidence the runner reads global+project together, not the project ledger alone.
      expect(res.results[1]).toMatchObject({ id: 'p2' });
      expect(res.results[1].returned).toEqual(expect.arrayContaining(['m_1', 'm_2']));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
