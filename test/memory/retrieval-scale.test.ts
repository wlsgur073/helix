import { describe, it, expect } from 'vitest';
import { buildRankArtifacts, rankWithArtifacts } from '../../src/memory/retrieval.js';
import type { MemoryRecord } from '../../src/types.js';

// F11: the score normaliser spread every live row's BM25 score into Math.max(...vals)/Math.min(...vals).
// A spread becomes one ARGUMENT per element, so past roughly 125k rows the engine throws
// `RangeError: Maximum call stack size exceeded` — recall dies outright rather than degrading. That
// is ~50x the README's validated envelope, so it is a robustness bug rather than a live one, but a
// hard crash is the wrong failure mode for "you exceeded the supported size" and the fix is a fold.
const record = (i: number): MemoryRecord => ({
  id: `m_${i}`, tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
  type: 'assert', state: 'Fresh', content: `alpha beta ${i}`,
  provenance: { source: 'user', sessionId: 's' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
}) as MemoryRecord;

describe('ranking at a scale past the argument-spread limit', () => {
  it('ranks without throwing, and still returns the requested number of items', () => {
    // Chosen just past the measured ~125k threshold. Deliberately tiny contents: the point is the
    // COUNT of scores being folded, and keeping the corpus trivial holds the whole test under a
    // second so it can live in the ordinary suite.
    const records = Array.from({ length: 130_000 }, (_, i) => record(i));
    const artifacts = buildRankArtifacts(records);
    const hits = rankWithArtifacts(records, artifacts, 'alpha beta', { maxItems: 5 });
    expect(hits.length).toBe(5);
  }, 60_000);
});
