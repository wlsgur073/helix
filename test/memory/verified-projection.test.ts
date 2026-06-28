import { describe, it, expect } from 'vitest';
import { buildVerifiedProjection } from '../../src/memory/verified-projection.js';
import { digestContent } from '../../src/memory/ledger-mac.js';
import type { MemoryRecord } from '../../src/types.js';

const base = (o: Partial<MemoryRecord>): MemoryRecord => ({
  id: 'x', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
  type: 'assert', state: 'Fresh', content: '', provenance: { source: 'user', sessionId: 's' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal', ...o,
});
const all = () => true;

describe('buildVerifiedProjection', () => {
  it('R1: a non-verify record claiming Verified is forced to Fresh', () => {
    const recs = [base({ id: 'a', content: 'fact', state: 'Verified' })];
    expect(buildVerifiedProjection(recs, { verify: all, keyAvailable: true }).live.get('a')!.state).toBe('Fresh');
  });
  it('R2: an invalid-MAC verify is ignored; a valid one elevates', () => {
    const recs = [
      base({ id: 'a', content: 'fact' }),
      base({ id: 'v', type: 'verify', supersedes: 'a', state: 'Verified', gen: 1, targetDigest: digestContent('fact') }),
    ];
    expect(buildVerifiedProjection(recs, { verify: () => false, keyAvailable: true }).live.get('a')!.state).toBe('Fresh');
    expect(buildVerifiedProjection(recs, { verify: all, keyAvailable: true }).live.get('a')!.state).toBe('Verified');
  });
  it('R3 promotion is content-bound: edited content drops the elevation to Fresh', () => {
    const recs = [
      base({ id: 'a', content: 'EDITED' }),
      base({ id: 'v', type: 'verify', supersedes: 'a', state: 'Verified', gen: 1, targetDigest: digestContent('fact') }),
    ];
    expect(buildVerifiedProjection(recs, { verify: all, keyAvailable: true }).live.get('a')!.state).toBe('Fresh');
  });
  it('R3 demotion is gen-bound: a content revert cannot resurrect the old promotion', () => {
    const recs = [
      base({ id: 'a', content: 'fact' }),
      base({ id: 'v1', type: 'verify', supersedes: 'a', state: 'Verified', gen: 1, targetDigest: digestContent('fact') }),
      base({ id: 'v2', type: 'verify', supersedes: 'a', state: 'Suspect', gen: 2, targetDigest: digestContent('whatever') }),
    ];
    expect(buildVerifiedProjection(recs, { verify: all, keyAvailable: true }).live.get('a')!.state).toBe('Suspect');
  });
  it('gen ordering: a re-appended older verify does not override a newer one', () => {
    const recs = [
      base({ id: 'a', content: 'fact' }),
      base({ id: 'v2', type: 'verify', supersedes: 'a', state: 'Suspect', gen: 2, targetDigest: digestContent('fact') }),
      base({ id: 'v1', type: 'verify', supersedes: 'a', state: 'Verified', gen: 1, targetDigest: digestContent('fact') }),
    ];
    expect(buildVerifiedProjection(recs, { verify: all, keyAvailable: true }).live.get('a')!.state).toBe('Suspect');
  });
  it('equal-gen conflict forces Fresh + flags compromised', () => {
    const recs = [
      base({ id: 'a', content: 'fact' }),
      base({ id: 'v1', type: 'verify', supersedes: 'a', state: 'Verified', gen: 1, targetDigest: digestContent('fact') }),
      base({ id: 'v2', type: 'verify', supersedes: 'a', state: 'Suspect', gen: 1, targetDigest: digestContent('fact') }),
    ];
    const out = buildVerifiedProjection(recs, { verify: all, keyAvailable: true });
    expect(out.live.get('a')!.state).toBe('Fresh');
    expect(out.compromised.has('a')).toBe(true);
  });
  it('keyAvailable=false: every verify ignored, items Fresh, flag set', () => {
    const recs = [
      base({ id: 'a', content: 'fact' }),
      base({ id: 'v', type: 'verify', supersedes: 'a', state: 'Verified', gen: 1, targetDigest: digestContent('fact') }),
    ];
    const out = buildVerifiedProjection(recs, { verify: all, keyAvailable: false });
    expect(out.live.get('a')!.state).toBe('Fresh');
    expect(out.keyAvailable).toBe(false);
  });
});
