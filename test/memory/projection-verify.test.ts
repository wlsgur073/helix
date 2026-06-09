import { describe, it, expect } from 'vitest';
import { buildProjection } from '../../src/memory/projection.js';
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

describe('projection — verify records', () => {
  it('a verify record updates its target state and is not itself a live entry', () => {
    const proj = buildProjection([
      rec({ id: 'm_1', state: 'Fresh', content: 'db is postgres' }),
      rec({ id: 'v_1', type: 'verify', supersedes: 'm_1', state: 'Verified' }),
    ]);
    expect(proj.has('v_1')).toBe(false);
    expect(proj.get('m_1')?.state).toBe('Verified');
    expect(proj.get('m_1')?.content).toBe('db is postgres');
  });

  it('a verify for an unknown/removed target is a no-op (not surfaced)', () => {
    const proj = buildProjection([
      rec({ id: 'v_1', type: 'verify', supersedes: 'ghost', state: 'Verified' }),
    ]);
    expect(proj.size).toBe(0);
  });
});
