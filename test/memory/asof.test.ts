import { describe, it, expect } from 'vitest';
import { buildAsOfEvidence } from '../../src/memory/asof.js';
import { digestContent, deriveSubkey, signVerify, signVerifyV1, verifyVerify } from '../../src/memory/ledger-mac.js';
import { buildVerifiedProjection } from '../../src/memory/verified-projection.js';
import type { MemoryRecord } from '../../src/types.js';

const K = deriveSubkey(Buffer.alloc(32, 9), 'proj');
const V = (r: MemoryRecord) => verifyVerify(r, K);
const base = (o: Partial<MemoryRecord>): MemoryRecord => ({
  id: 'x', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
  type: 'assert', state: 'Fresh', content: '', provenance: { source: 'user', sessionId: 's' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal', ...o,
});
const sv2 = (o: Partial<MemoryRecord>) => signVerify(base({ type: 'verify', ...o }), K);
const sv1 = (o: Partial<MemoryRecord>) => signVerifyV1(base({ type: 'verify', ...o }), K);
const D = digestContent('fact');
const T = (s: string) => `2026-06-09T00:00:${s}.000Z`; // helper: distinct seconds within one minute

describe('buildAsOfEvidence (spec C §4)', () => {
  it('a forged duplicate id is tamper evidence here too, so asOf(now) still equals the live grade', () => {
    // The file's own contract is that grade comes from the same resolver as the live projection, so
    // asOf(now) equals the live grade. A guard that lives only on the live path would break that
    // and hand the point-in-time view back as a bypass.
    const recs = [
      base({ id: 'a', content: 'fact', tx: T('01'), provenance: { source: 'agent-inference', sessionId: 's' } }),
      sv2({ id: 'v', supersedes: 'a', state: 'Corroborated', gen: 1, targetDigest: D, tx: T('02') }),
      base({ id: 'a', content: 'fact', tx: T('03'), provenance: { source: 'user', sessionId: 's' } }),
    ];
    const asOf = buildAsOfEvidence(recs, T('09'), { verify: V, keyAvailable: true }).facts.find((f) => f.record.id === 'a')!;
    const live = buildVerifiedProjection(recs, { verify: V, keyAvailable: true }).live.get('a')!;
    // Flagged, not demoted, on BOTH surfaces — and asOf(now) still equals live, which is the
    // contract this test exists for. Detection reads the undeduped window: the evidence is exactly
    // the rows the ownership pass drops, so detecting after that pass would report nothing.
    expect(asOf.grade).toBe('Corroborated');
    expect(asOf.integrity).toBe('compromised');
    expect(asOf.record.state).toBe(live.state);
  });
  it('membership: a fact superseded at tx>t is live at t; absent once tx<=t', () => {
    const recs = [
      base({ id: 'a', content: 'fact', tx: T('01') }),
      base({ id: 'b', type: 'supersede', supersedes: 'a', content: 'v2', state: 'Fresh', tx: T('05') }),
    ];
    expect(buildAsOfEvidence(recs, T('03'), { verify: V, keyAvailable: true }).facts.map((f) => f.record.id)).toContain('a');
    expect(buildAsOfEvidence(recs, T('09'), { verify: V, keyAvailable: true }).facts.map((f) => f.record.id)).not.toContain('a');
  });

  it('grade at asOf(now) equals the live buildVerifiedProjection grade (consistency guarantee)', () => {
    const recs = [
      base({ id: 'a', content: 'fact', tx: T('01') }),
      sv2({ id: 'v', supersedes: 'a', state: 'Verified', gen: 1, targetDigest: D, tx: T('02') }),
    ];
    const live = buildVerifiedProjection(recs, { verify: V, keyAvailable: true }).live.get('a')!.state;
    const asof = buildAsOfEvidence(recs, T('59'), { verify: V, keyAvailable: true }).facts.find((f) => f.record.id === 'a')!;
    expect(asof.grade).toBe(live);
    expect(asof.grade).toBe('Verified');
  });

  it('full evidence: every considered verify surfaces; a v2 verify at tx>t is excluded', () => {
    const recs = [
      base({ id: 'a', content: 'fact', tx: T('01') }),
      sv2({ id: 'v1', supersedes: 'a', state: 'Corroborated', gen: 1, targetDigest: D, tx: T('02') }),
      sv2({ id: 'v2', supersedes: 'a', state: 'Verified', gen: 2, targetDigest: D, tx: T('30') }), // after t
    ];
    const f = buildAsOfEvidence(recs, T('10'), { verify: V, keyAvailable: true }).facts.find((x) => x.record.id === 'a')!;
    expect(f.grade).toBe('Corroborated');           // gen-2 not yet minted at t
    expect(f.evidence.map((e) => e.gen)).toEqual([1]);
  });

  it('authenticated vs declared: v2 tx authenticated, v1 tx declared, both count', () => {
    const recs = [
      base({ id: 'a', content: 'fact', tx: T('01') }),
      sv1({ id: 'leg', supersedes: 'a', state: 'Verified', gen: 1, targetDigest: D, tx: T('02') }),
    ];
    const f = buildAsOfEvidence(recs, T('59'), { verify: V, keyAvailable: true }).facts.find((x) => x.record.id === 'a')!;
    expect(f.grade).toBe('Verified');               // v1 counts toward the grade
    expect(f.evidence[0]!.txAuthenticated).toBe(false); // but its timing is declared
  });

  it('key-absent: every fact clamps Fresh with empty evidence', () => {
    const recs = [
      base({ id: 'a', content: 'fact', tx: T('01') }),
      sv2({ id: 'v', supersedes: 'a', state: 'Verified', gen: 1, targetDigest: D, tx: T('02') }),
    ];
    const out = buildAsOfEvidence(recs, T('59'), { verify: V, keyAvailable: false });
    expect(out.keyAvailable).toBe(false);
    expect(out.facts.find((x) => x.record.id === 'a')!.grade).toBe('Fresh');
  });

  it('compromised: a same-lane equal-gen conflict clamps the grade Fresh and flags integrity (asof wiring, M2)', () => {
    // Two VALID v2 verifies at the SAME gen with DIFFERENT states -> A §4.5 L1 same-lane conflict ->
    // resolveTargetGrade returns compromised. This locks the asof-specific WIRING of that result: the
    // record stamps Fresh (not the conflicting claim) AND integrity flips to 'compromised'. Discriminating:
    // inverting the `integrity: compromised ? … : 'ok'` ternary, or stamping `state:grade` on the null-grade
    // branch, fails this without touching the 5 happy-path cases above.
    const recs = [
      base({ id: 'a', content: 'fact', tx: T('01') }),
      sv2({ id: 'vx', supersedes: 'a', state: 'Verified', gen: 1, targetDigest: D, tx: T('02') }),
      sv2({ id: 'vy', supersedes: 'a', state: 'Suspect', gen: 1, targetDigest: D, tx: T('03') }),
    ];
    const f = buildAsOfEvidence(recs, T('59'), { verify: V, keyAvailable: true }).facts.find((x) => x.record.id === 'a')!;
    expect(f.integrity).toBe('compromised');
    expect(f.grade).toBe('Fresh');        // clamped, never the conflicting Verified/Suspect
    expect(f.record.state).toBe('Fresh'); // the stamped record.state agrees with the grade (no contradiction)
  });
});

// F2 leg 1, the asOf variant. Ownership of a fact id must be resolved over the WHOLE ledger, never
// over the `tx <= t` window: a forged duplicate dated before the genuine row is the only row bearing
// its id inside its own window, so a window-scoped rule sees nothing to arbitrate. The adversary
// still needs a valid verify inside that window, and v1 supplies one for free — `macInputV1` omits
// `tx`, so a byte-copy of an existing v1 verify with only its `tx` moved back is still MAC-valid.
describe('asOf resolves id ownership ledger-wide, not per window (F2 leg 1)', () => {
  const genuine = base({ id: 'a', content: 'fact', tx: T('20'), provenance: { source: 'agent-inference', sessionId: 's' } });
  const v1 = sv1({ id: 'v', supersedes: 'a', state: 'Corroborated', gen: 1, targetDigest: D, tx: T('30') });
  const v1Moved = { ...v1, tx: T('05') };                      // no key needed: v1 never bound tx
  const forged = base({ id: 'a', content: 'fact', tx: T('01'), provenance: { source: 'user', sessionId: 's' } });
  const ledger = [genuine, v1, forged, v1Moved];

  it('the premise holds: a v1 verify survives having its tx rewritten', () => {
    expect(V(v1Moved)).toBe(true);
  });

  it('does not serve the forged duplicate inside the window only it occupies', () => {
    const facts = buildAsOfEvidence(ledger, T('10'), { verify: V, keyAvailable: true }).facts;
    expect(facts.find((f) => f.record.id === 'a')).toBeUndefined();
  });

  it('still serves the genuine row, with its honest grade, once its own tx is in range', () => {
    const f = buildAsOfEvidence(ledger, T('59'), { verify: V, keyAvailable: true }).facts.find((x) => x.record.id === 'a')!;
    expect(f.record.provenance.source).toBe('agent-inference');
    expect(f.grade).toBe('Corroborated');
  });
});
