import { describe, it, expect } from 'vitest';
import { deriveSubkey, signVerify, verifyVerify, digestContent as dc } from '../../../src/memory/ledger-mac.js';
import type { MemoryRecord } from '../../../src/types.js';

const k = deriveSubkey(Buffer.alloc(32, 7), 'scope-a');
const base = (): MemoryRecord => ({
  id: 'v1', tx: '2026-07-01T00:00:00.000Z', validFrom: '2026-07-01T00:00:00.000Z', validTo: null,
  type: 'verify', state: 'Verified', content: '', provenance: { source: 'user', sessionId: 's' },
  supersedes: 'target1', blastRadius: null, reverifyTrigger: null, classification: 'normal',
  gen: 1, targetDigest: dc('the fact'),
});

describe('probe (b): trust authority is the MAC-bound state, not provenance', () => {
  it('a genuine signed verify verifies', () => {
    expect(verifyVerify(signVerify(base(), k), k)).toBe(true);
  });

  it('flipping the grade field `state` after signing invalidates the MAC (state IS bound)', () => {
    expect(verifyVerify({ ...signVerify(base(), k), state: 'Corroborated' }, k)).toBe(false);
  });

  it('repurposing a signed verify as an assert invalidates the MAC (type IS bound)', () => {
    expect(verifyVerify({ ...signVerify(base(), k), type: 'assert' }, k)).toBe(false);
  });

  it('provenance.source is NOT MAC-bound — and that is sound: it confers no authority', () => {
    // Mutating source leaves the MAC valid (source is outside macCommon). This is the AUDIT FINDING:
    // a signed verify's provenance does not raise trust; only `state` does, and `state` is bound above.
    const signed = signVerify(base(), k);
    const reSourced = { ...signed, provenance: { ...signed.provenance, source: 'agent-inference' as const } };
    expect(verifyVerify(reSourced, k)).toBe(true); // still valid — source is not part of the signed input
  });

  it('rejects verification under a different scope subkey (per-scope domain separation)', () => {
    const other = deriveSubkey(Buffer.alloc(32, 7), 'scope-b');
    expect(verifyVerify(signVerify(base(), k), other)).toBe(false);
  });
});
