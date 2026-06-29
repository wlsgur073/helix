import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rankRecords } from '../../src/memory/retrieval.js';
import { loadExpansion, EXP_THETA, EXP_K, SEM_DISCOUNT, SEM_GATE } from '../../src/memory/expansion.js';
import type { MemoryRecord } from '../../src/types.js';

const ASSET = fileURLToPath(new URL('../../data/semantic-neighbors.json', import.meta.url));
const EXP = loadExpansion(readFileSync(ASSET, 'utf8'), EXP_THETA, EXP_K);
const rec = (id: string, content: string): MemoryRecord => ({ id, tx: '2026-01-01T00:00:00.000Z',
  validFrom: '2026-01-01T00:00:00.000Z', validTo: null, type: 'assert', state: 'Fresh', content,
  provenance: { source: 'user', sessionId: 'cli' }, supersedes: null, blastRadius: null,
  reverifyTrigger: null, classification: 'normal' });

const CORPUS = [
  rec('rm', 'rm <id> command hard-deletes a task'),
  rec('exit', 'Exit code 2 on usage error'),
  rec('iso', 'Timestamps are ISO 8601'),
  rec('verb', 'CLI commands are verb-first (add, list)'),
];
// POSITIVES reachable ONLY via a general-English synonym bridge (verified empirically via
// scripts/calibrate-semantic.mjs): remove -> delete(s) (strong, 0.66); failure -> error
// (the one marginal (b) conceptual win, 0.53). No shared content token with the target.
const POS: Array<[string, string]> = [
  ['remove a job', 'rm'],
  ['program failure', 'exit'],
];
// NEGATIVES: expansion must NOT pull an unrelated record.
const NEG: Array<[string, string]> = [
  ['naming convention', 'iso'],
  ['remove a job', 'iso'],
];

describe('EH-3 semantic recall fixture (locked constants)', () => {
  const opts = { expansion: EXP, semDiscount: SEM_DISCOUNT, semGate: SEM_GATE };
  it('recovers the synonym bridges', () => {
    for (const [q, id] of POS) {
      expect(rankRecords(CORPUS, q, opts).map((r) => r.id), `POS "${q}" -> ${id}`).toContain(id);
    }
  });
  it('does not inject negatives (precision preserved)', () => {
    for (const [q, id] of NEG) {
      expect(rankRecords(CORPUS, q, opts).map((r) => r.id), `NEG "${q}" !-> ${id}`).not.toContain(id);
    }
  });
});
