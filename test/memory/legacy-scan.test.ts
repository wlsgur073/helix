import { describe, it, expect } from 'vitest';
import { scanLegacyElevated } from '../../src/memory/legacy-scan.js';
import type { MemoryRecord } from '../../src/types.js';

const base = (over: Partial<MemoryRecord>): MemoryRecord => ({
  id: 'm', tx: 't', validFrom: 't', validTo: null, type: 'assert', state: 'Fresh', content: 'c',
  provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null,
  reverifyTrigger: null, classification: 'normal', ...over,
});

describe('scanLegacyElevated', () => {
  it('is ok on a clean Fresh-only ledger', () => {
    expect(scanLegacyElevated([base({ id: 'a' }), base({ id: 'b' })]).ok).toBe(true);
  });
  it('flags a stray verify record and any elevated state', () => {
    const r = scanLegacyElevated([base({ id: 'a' }), base({ id: 'v', type: 'verify', state: 'Verified' }), base({ id: 'c', state: 'Corroborated' })]);
    expect(r.ok).toBe(false);
    expect(r.offenders.sort()).toEqual(['c', 'v']);
  });
});
