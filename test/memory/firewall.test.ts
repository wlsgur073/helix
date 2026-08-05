import { describe, it, expect } from 'vitest';
import { canCommit, isVerifyingSource, resolveTransition } from '../../src/memory/firewall.js';
import type { Provenance, ProvenanceSource } from '../../src/types.js';

const prov = (source: Provenance['source']): Provenance => ({ source, sessionId: 's1' });

describe('provenance firewall', () => {
  it('rejects a commit with no provenance source', () => {
    expect(canCommit({ provenance: undefined as unknown as Provenance })).toBe(false);
    expect(canCommit({ provenance: prov('user') })).toBe(true);
  });
});

describe('provenance source classification', () => {
  it('only user + reality-check are verifying; everything else (incl. new + unknown) is not', () => {
    expect(isVerifyingSource('user')).toBe(true);
    expect(isVerifyingSource('reality-check')).toBe(true);
    expect(isVerifyingSource('user-relayed')).toBe(false);
    expect(isVerifyingSource('agent-inference')).toBe(false);
    expect(isVerifyingSource('codex-agree')).toBe(false);
    // fail-closed: an unknown/legacy value is non-authoritative
    expect(isVerifyingSource('legacy-mystery' as unknown as ProvenanceSource)).toBe(false);
  });
});

const PASS = { ran: true, indeterminate: false, passed: true };
const FAIL = { ran: true, indeterminate: false, passed: false };
const INDET = { ran: false, indeterminate: true, passed: false };

describe('resolveTransition (write-side authority)', () => {
  const rc = (targetState: any, outcome: any) =>
    resolveTransition({ targetState, evidenceSource: 'reality-check', outcome });

  it('reality-check PASS promotes Fresh/Suspect to Corroborated, leaves Verified/Corroborated unchanged', () => {
    expect(rc('Fresh', PASS)).toEqual({ kind: 'state', state: 'Corroborated' });
    expect(rc('Suspect', PASS)).toEqual({ kind: 'state', state: 'Corroborated' });
    expect(rc('Corroborated', PASS)).toEqual({ kind: 'no-change' });
    expect(rc('Verified', PASS)).toEqual({ kind: 'no-change' });
  });
  it('reality-check FAIL demotes Fresh/Corroborated to Suspect', () => {
    expect(rc('Fresh', FAIL)).toEqual({ kind: 'state', state: 'Suspect' });
    expect(rc('Corroborated', FAIL)).toEqual({ kind: 'state', state: 'Suspect' });
    expect(rc('Suspect', FAIL)).toEqual({ kind: 'no-change' });
  });
  it('reality-check FAIL is CONTESTED (no demote) for a Verified target only', () => {
    expect(rc('Verified', FAIL)).toEqual({ kind: 'contested' });
  });
  it('reality-check indeterminate is always no-change', () => {
    expect(rc('Fresh', INDET)).toEqual({ kind: 'no-change' });
    expect(rc('Verified', INDET)).toEqual({ kind: 'no-change' });
  });
  it('a user vouch (confirm) yields Verified from any state', () => {
    const cf = (targetState: any) => resolveTransition({ targetState, evidenceSource: 'user', outcome: PASS });
    expect(cf('Fresh')).toEqual({ kind: 'state', state: 'Verified' });
    expect(cf('Suspect')).toEqual({ kind: 'state', state: 'Verified' });
  });

  // N2-CONTESTED regression lock. `provenance` is NOT covered by the ledger MAC (ledger-mac.ts names
  // it explicitly, with the load-bearing invariant that no unauthenticated field may drive a trust
  // decision) and the verified projection spreads it through unclamped (it clamps `state` only). A
  // caller-declared `source: 'user'` therefore used to make an item permanently undemotable. The
  // field is still ACCEPTED — store.ts is freeze-pinned and cannot stop passing it — so the lock has
  // to be behavioural: every (state, outcome) verdict must be identical for every claimed source,
  // including unknown/legacy values. This is what fails if the disjunct is ever reintroduced.
  it('INVARIANT: the write-side authority ignores provenance — a claimed source cannot change any verdict', () => {
    const SOURCES: ProvenanceSource[] = [
      'user', 'user-relayed', 'agent-inference', 'reality-check', 'codex-agree',
      'legacy-mystery' as ProvenanceSource,
    ];
    for (const targetState of ['Fresh', 'Corroborated', 'Verified', 'Suspect'] as const) {
      for (const evidenceSource of ['reality-check', 'user', 'agent-inference'] as const) {
        for (const outcome of [PASS, FAIL, INDET]) {
          const baseline = resolveTransition({ targetState, evidenceSource, outcome });
          for (const targetSource of SOURCES) {
            const withClaim = resolveTransition({ targetState, evidenceSource, outcome, targetSource });
            expect(withClaim, `${targetState}/${evidenceSource}/${targetSource}`).toEqual(baseline);
          }
        }
      }
    }
  });
});
