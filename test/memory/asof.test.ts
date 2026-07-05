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
