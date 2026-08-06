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

// F2 leg 1. A fact id is owned by the FIRST row that claims it, in file order, for the whole
// ledger. Helix never re-uses an id — `store.commit` mints `m_${randomUUID()}` and models every
// update as a NEW id carrying `supersedes` — so a second row claiming a live id can only come from
// something that wrote `memory.jsonl` behind the store's back. Letting the later row win handed
// that writer the earlier row's signed grade along with adversary-chosen `provenance`,
// `classification` and validity bounds, none of which any MAC covers.
describe('fact-id ownership is first-wins (F2 leg 1)', () => {
  it('a later row claiming a live id does not displace the row that owns it', () => {
    const proj = buildProjection([
      rec({ id: 'm_1', content: 'genuine' }),
      rec({ id: 'm_1', content: 'forged', tx: '2026-07-01T00:00:00.000Z' }),
    ]);
    expect(proj.get('m_1')?.content).toBe('genuine');
  });

  it('a supersede-shaped claim cannot take an owned id either', () => {
    // `supersede` writes the live map on its OWN id, so a rule that only covered `assert` left this
    // shape as a bypass: no `supersedes` target means nothing is removed, only replaced.
    const proj = buildProjection([
      rec({ id: 'm_1', content: 'genuine' }),
      rec({ id: 'm_1', type: 'supersede', supersedes: null, content: 'forged' }),
    ]);
    expect(proj.get('m_1')?.content).toBe('genuine');
  });

  it('still lets a legitimate supersede chain replace facts, because each link mints a new id', () => {
    const proj = buildProjection([
      rec({ id: 'm_1', content: 'v1' }),
      rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'v2' }),
      rec({ id: 'm_3', type: 'supersede', supersedes: 'm_2', content: 'v3' }),
    ]);
    expect([...proj.keys()]).toEqual(['m_3']);
    expect(proj.get('m_3')?.content).toBe('v3');
  });
});

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
