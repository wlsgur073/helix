import { describe, it, expect } from 'vitest';
import type { MemoryRecord } from '../src/types.js';

describe('types', () => {
  it('a MemoryRecord literal type-checks and round-trips through JSON', () => {
    const rec: MemoryRecord = {
      id: 'm_1', tx: '2026-06-09T00:00:00.000Z',
      validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
      type: 'assert', state: 'Fresh', content: 'hello',
      provenance: { source: 'user', sessionId: 's1' },
      supersedes: null, blastRadius: null, reverifyTrigger: null,
      classification: 'normal',
    };
    expect(JSON.parse(JSON.stringify(rec)).id).toBe('m_1');
  });
});
