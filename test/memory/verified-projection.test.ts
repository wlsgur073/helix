import { describe, it, expect } from 'vitest';
import { buildVerifiedProjection } from '../../src/memory/verified-projection.js';
import { digestContent, deriveSubkey, signVerify, signVerifyV1, verifyVerify } from '../../src/memory/ledger-mac.js';
import type { MemoryRecord } from '../../src/types.js';

const base = (o: Partial<MemoryRecord>): MemoryRecord => ({
  id: 'x', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
  type: 'assert', state: 'Fresh', content: '', provenance: { source: 'user', sessionId: 's' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal', ...o,
});
const all = () => true;

// Signed-record helpers for the lane-aware tests: real macVersion is the lane discriminator (spec §4.5).
const K = deriveSubkey(Buffer.alloc(32, 9), 'proj');
const V = (r: MemoryRecord) => verifyVerify(r, K);
const sv2 = (o: Partial<MemoryRecord>) => signVerify(base({ type: 'verify', ...o }), K);
const sv1 = (o: Partial<MemoryRecord>) => signVerifyV1(base({ type: 'verify', ...o }), K);

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
  it('equal-gen conflict is order-independent even when one verify is a non-applicable promotion', () => {
    const a = base({ id: 'a', content: 'fact' });
    const promo = base({ id: 'vp', type: 'verify', supersedes: 'a', state: 'Verified', gen: 1, targetDigest: digestContent('STALE') });
    const demo = base({ id: 'vd', type: 'verify', supersedes: 'a', state: 'Suspect', gen: 1, targetDigest: digestContent('fact') });
    for (const order of [[a, promo, demo], [a, demo, promo]]) {
      const out = buildVerifiedProjection(order, { verify: all, keyAvailable: true });
      expect(out.live.get('a')!.state).toBe('Fresh');
      expect(out.compromised.has('a')).toBe(true);
    }
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

describe('lane-aware equal-gen conflict + cross-lane fail-low (spec §4.5)', () => {
  const D = digestContent('fact');
  const STALE = digestContent('stale');

  it('Codex counter-1: a blind v1 demotion colliding with a v2 gen is HONORED (fail-low, not resurrection)', () => {
    // v1 gen1 Verified, v2 gen2 Verified, blind v1 gen2 Suspect -> gen2 fails low to Suspect -> target Suspect.
    const recs = [
      base({ id: 'a', content: 'fact' }),
      sv1({ id: 'va', supersedes: 'a', state: 'Verified', gen: 1, targetDigest: D }),
      sv2({ id: 'vb', supersedes: 'a', state: 'Verified', gen: 2, targetDigest: D }),
      sv1({ id: 'vc', supersedes: 'a', state: 'Suspect', gen: 2, targetDigest: D }),
    ];
    const out = buildVerifiedProjection(recs, { verify: V, keyAvailable: true });
    expect(out.live.get('a')!.state).toBe('Suspect');
    expect(out.compromised.has('a')).toBe(false);
  });

  it('the brick is gone: v2 gen1 Verified vs blind v1 gen1 Corroborated -> Corroborated, NOT compromised, and heals', () => {
    const a = base({ id: 'a', content: 'fact' });
    const collide = [
      sv2({ id: 'vb', supersedes: 'a', state: 'Verified', gen: 1, targetDigest: D }),
      sv1({ id: 'va', supersedes: 'a', state: 'Corroborated', gen: 1, targetDigest: D }),
    ];
    const out = buildVerifiedProjection([a, ...collide], { verify: V, keyAvailable: true });
    expect(out.live.get('a')!.state).toBe('Corroborated'); // fail-low: lower rank of {Verified, Corroborated}
    expect(out.compromised.has('a')).toBe(false);          // cross-lane collision does NOT clamp
    // a later post-A verify heals the target (non-sticky)
    const healed = buildVerifiedProjection(
      [a, ...collide, sv2({ id: 'vh', supersedes: 'a', state: 'Verified', gen: 2, targetDigest: D })],
      { verify: V, keyAvailable: true },
    );
    expect(healed.live.get('a')!.state).toBe('Verified');
  });

  it('L1 state leg: same-lane same-gen state disagreement clamps sticky — even with an agreeing other lane', () => {
    // v1 gen7 Verified + v1 gen7 Suspect (same lane, disagree) + v2 gen7 Verified (agrees with one) -> compromised.
    const recs = [
      base({ id: 'a', content: 'fact' }),
      sv1({ id: 'va', supersedes: 'a', state: 'Verified', gen: 7, targetDigest: D }),
      sv1({ id: 'vb', supersedes: 'a', state: 'Suspect', gen: 7, targetDigest: D }),
      sv2({ id: 'vc', supersedes: 'a', state: 'Verified', gen: 7, targetDigest: D }),
    ];
    const out = buildVerifiedProjection(recs, { verify: V, keyAvailable: true });
    expect(out.live.get('a')!.state).toBe('Fresh');
    expect(out.compromised.has('a')).toBe(true);
  });

  it('L1 digest leg: same-lane same-gen same-state records with DIFFERENT targetDigest clamp sticky', () => {
    // two v2 gen7 Verified with different digests = two genuine signings of one gen -> tamper evidence.
    const recs = [
      base({ id: 'a', content: 'fact' }),
      sv2({ id: 'va', supersedes: 'a', state: 'Verified', gen: 7, targetDigest: D }),
      sv2({ id: 'vb', supersedes: 'a', state: 'Verified', gen: 7, targetDigest: STALE }),
    ];
    const out = buildVerifiedProjection(recs, { verify: V, keyAvailable: true });
    expect(out.live.get('a')!.state).toBe('Fresh');
    expect(out.compromised.has('a')).toBe(true);
  });

  it('verbatim duplicate of one record stays benign (no L1 disagreement)', () => {
    const a = base({ id: 'a', content: 'fact' });
    const dup = sv2({ id: 'vd', supersedes: 'a', state: 'Verified', gen: 1, targetDigest: D });
    const out = buildVerifiedProjection([a, dup, dup], { verify: V, keyAvailable: true });
    expect(out.live.get('a')!.state).toBe('Verified');
    expect(out.compromised.has('a')).toBe(false);
  });

  it('fail-low + R3: the colliding lower-rank winner is a stale-digest promotion -> skipped -> grade falls to earlier gens', () => {
    // gen1 Suspect (applicable floor); gen2 collision v2 Verified(D) vs v1 Corroborated(STALE):
    // fail-low keeps the Corroborated, but its stale digest makes it non-applicable, so grade falls to gen1 Suspect.
    const recs = [
      base({ id: 'a', content: 'fact' }),
      sv2({ id: 'g1', supersedes: 'a', state: 'Suspect', gen: 1, targetDigest: STALE }),
      sv2({ id: 'g2b', supersedes: 'a', state: 'Verified', gen: 2, targetDigest: D }),
      sv1({ id: 'g2a', supersedes: 'a', state: 'Corroborated', gen: 2, targetDigest: STALE }),
    ];
    const out = buildVerifiedProjection(recs, { verify: V, keyAvailable: true });
    expect(out.live.get('a')!.state).toBe('Suspect');
    expect(out.compromised.has('a')).toBe(false);
  });
});
