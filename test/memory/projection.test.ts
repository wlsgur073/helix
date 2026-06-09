import { describe, it, expect } from 'vitest';
import { buildProjection, recall } from '../../src/memory/projection.js';
import type { MemoryRecord } from '../../src/types.js';

function rec(p: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content: 'x',
    provenance: { source: 'user', sessionId: 's1' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    ...p,
  };
}

describe('projection', () => {
  it('builds a map of live items, latest-wins on supersede', () => {
    const proj = buildProjection([
      rec({ id: 'm_1', content: 'old' }),
      rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'new' }),
    ]);
    expect(proj.has('m_1')).toBe(false);
    expect(proj.get('m_2')?.content).toBe('new');
  });

  it('excludes invalidated and erased items', () => {
    const proj = buildProjection([
      rec({ id: 'm_1' }),
      rec({ id: 'i_1', type: 'invalidate', supersedes: 'm_1' }),
      rec({ id: 'm_2' }),
      rec({ id: 'e_1', type: 'erase', supersedes: 'm_2' }),
    ]);
    expect([...proj.keys()]).toEqual([]);
  });

  it('recall returns only items whose content matches the query terms', () => {
    const proj = buildProjection([
      rec({ id: 'm_1', content: 'the database uses postgres' }),
      rec({ id: 'm_2', content: 'the frontend uses react' }),
    ]);
    const hits = recall(proj, 'postgres database');
    expect(hits.map((r) => r.id)).toEqual(['m_1']);
  });

  it('recall caps results to maxItems (bounded token injection)', () => {
    const records: MemoryRecord[] = [];
    for (let i = 0; i < 50; i++) records.push(rec({ id: `m_${i}`, content: 'shared keyword' }));
    const hits = recall(buildProjection(records), 'shared', { maxItems: 5 });
    expect(hits).toHaveLength(5);
  });
});
