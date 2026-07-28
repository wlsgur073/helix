import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../../src/memory/store.js';
import { stampOwnership, projectLedgerPath } from '../../src/memory/ownership.js';

/** recall() resolves each returned record's scope and integrity verdict through a lookup built from
 *  the scoped records. Keying that lookup by bare record id collapses last-wins, so a record id
 *  present in BOTH ledgers makes every copy report one scope — and one integrity verdict.
 *
 *  retrieval.ts fixed exactly this hazard for the SCORING path with positional pairing and says so
 *  in a comment ("duplicate ids ... would collapse last-wins and score a record against another
 *  record's content"); the scope/integrity tagging path never got the same treatment. Honest ids are
 *  random UUIDs, so a collision is adversarial — an imported or shared project ledger that chooses
 *  its ids. That is exactly the input a scope LABEL is supposed to be trustworthy about. */
describe('recall scope tagging under a cross-scope id collision', () => {
  const row = (id: string, content: string) => JSON.stringify({
    id, tx: '2026-07-20T00:00:00.000Z', validFrom: '2026-07-20T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content,
    provenance: { source: 'user', sessionId: 't' }, supersedes: null, blastRadius: null,
    reverifyTrigger: null, classification: 'normal',
  }) + '\n';

  it('tags each record with its OWN scope even when the two ledgers share a record id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-collide-'));
    try {
      const home = join(dir, 'home'); const projectRoot = join(dir, 'proj');
      mkdirSync(home, { recursive: true }); mkdirSync(join(projectRoot, '.helix'), { recursive: true });

      // The SAME id in both scopes, with content that both match the probe so ONE recall returns both.
      const GLOBAL_TEXT = 'zebra quintessential contract from the global ledger';
      const PROJECT_TEXT = 'zebra quintessential contract from the project ledger';
      writeFileSync(join(home, 'memory.jsonl'), row('m_dup', GLOBAL_TEXT));
      writeFileSync(projectLedgerPath(projectRoot), row('m_dup', PROJECT_TEXT));
      stampOwnership(projectRoot, home, { genStamp: () => 'collide-stamp' });

      const store = new MemoryStore(join(home, 'memory.jsonl'), {
        home, sessionId: 't', project: { ledger: projectLedgerPath(projectRoot), root: projectRoot, home },
      });
      const items = store.recall('zebra quintessential contract').items;

      expect(items).toHaveLength(2);
      const fromGlobal = items.find((i) => i.record.content === GLOBAL_TEXT);
      const fromProject = items.find((i) => i.record.content === PROJECT_TEXT);
      expect(fromGlobal?.scope).toBe('global');
      expect(fromProject?.scope).toBe('project');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
