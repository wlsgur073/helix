import { describe, it, expect } from 'vitest';
import { semanticCoverage, rankRecords, type Expansion } from '../../src/memory/retrieval.js';
import type { MemoryRecord } from '../../src/types.js';

const EXP: Expansion = new Map([
  ['remove', [{ token: 'delete', w: 0.657 }, { token: 'erase', w: 0.54 }]],
  ['failure', [{ token: 'error', w: 0.525 }]],
]);

describe('semanticCoverage', () => {
  it('exact match weighs 1.0', () => {
    const c = semanticCoverage(['delete'], ['delete', 'task'], EXP);
    expect(c.lexicalMatched).toBe(1);
    expect(c.semanticWeight).toBe(0);
    expect(c.score).toBe(1);
  });
  it('prefix match weighs 1.0 (existing behavior)', () => {
    const c = semanticCoverage(['delete'], ['deletes'], EXP);
    expect(c.lexicalMatched).toBe(1);
  });
  it('neighbor match weighs w (<1) and is recorded as semanticWeight', () => {
    const c = semanticCoverage(['remove'], ['delete', 'task'], EXP);
    expect(c.lexicalMatched).toBe(0);
    expect(c.semanticWeight).toBeCloseTo(0.657, 3);
    expect(c.score).toBeCloseTo(0.657, 3);
  });
  it('uses the BEST present neighbor', () => {
    const c = semanticCoverage(['remove'], ['erase', 'delete'], EXP);
    expect(c.semanticWeight).toBeCloseTo(0.657, 3);
  });
  it('neighbor match also prefix-expands (delete -> deletes), since records carry inflections', () => {
    const c = semanticCoverage(['remove'], ['deletes', 'job'], EXP);
    expect(c.semanticWeight).toBeCloseTo(0.657, 3);
  });
  it('applies the discount', () => {
    const c = semanticCoverage(['remove'], ['delete'], EXP, 0.5);
    expect(c.semanticWeight).toBeCloseTo(0.3285, 3);
  });
  it('no expansion => identical to lexical coverage', () => {
    const c = semanticCoverage(['remove'], ['delete', 'task']);
    expect(c.score).toBe(0);
  });
});

function rec(id: string, content: string): MemoryRecord {
  return { id, tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content, provenance: { source: 'user', sessionId: 'cli' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' };
}

describe('rankRecords semantic rescue', () => {
  // record 'a' shares NO token with the query "remove"; only the neighbor delete -> "deletes" bridges it.
  const recs = [rec('a', 'the cli hard-deletes an entry'), rec('b', 'Timestamps are ISO 8601.')];
  it('WITHOUT expansion: a zero-lexical synonym query drops the record (the EH-3 bug)', () => {
    expect(rankRecords(recs, 'remove').map(r => r.id)).not.toContain('a');
  });
  it('WITH expansion: the synonym query rescues the record', () => {
    const got = rankRecords(recs, 'remove', { expansion: EXP, semGate: 0.3 }).map(r => r.id);
    expect(got).toContain('a');
    expect(got).not.toContain('b');
  });
  it('rescue gate blocks a too-weak semantic-only hit', () => {
    const weak: Expansion = new Map([['remove', [{ token: 'delete', w: 0.2 }]]]);
    expect(rankRecords(recs, 'remove', { expansion: weak, semGate: 0.3 }).map(r => r.id)).not.toContain('a');
  });
});
