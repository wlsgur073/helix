import { describe, it, expect } from 'vitest';
import { canCommit, isVerifyingSource, promotionFor, resolveTransition, type VerifyOutcome } from '../../src/memory/firewall.js';
import type { Provenance, ProvenanceSource } from '../../src/types.js';

const prov = (source: Provenance['source']): Provenance => ({ source, sessionId: 's1' });

describe('provenance firewall', () => {
  it('rejects a commit with no provenance source', () => {
    expect(canCommit({ provenance: undefined as unknown as Provenance })).toBe(false);
    expect(canCommit({ provenance: prov('user') })).toBe(true);
  });

  it('reality-check / user verification promotes Fresh -> Verified', () => {
    const ok: VerifyOutcome = { ran: true, indeterminate: false, passed: true };
    expect(promotionFor(prov('reality-check'), ok)).toBe('Verified');
    expect(promotionFor(prov('user'), ok)).toBe('Verified');
  });

  it('codex-agree is NEVER verification-eligible (stays Fresh)', () => {
    const ok: VerifyOutcome = { ran: true, indeterminate: false, passed: true };
    expect(promotionFor(prov('codex-agree'), ok)).toBe('Fresh');
  });

  it('fail-closed: an indeterminate or non-run check never promotes; it Suspects', () => {
    const indet: VerifyOutcome = { ran: true, indeterminate: true, passed: false };
    const didNotRun: VerifyOutcome = { ran: false, indeterminate: true, passed: false };
    expect(promotionFor(prov('reality-check'), indet)).toBe('Suspect');
    expect(promotionFor(prov('reality-check'), didNotRun)).toBe('Suspect');
  });

  it('a check that ran and FAILED Suspects the item', () => {
    const failed: VerifyOutcome = { ran: true, indeterminate: false, passed: false };
    expect(promotionFor(prov('reality-check'), failed)).toBe('Suspect');
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

  it('promotionFor returns Fresh for the two new non-authoritative sources', () => {
    const ok: VerifyOutcome = { ran: true, indeterminate: false, passed: true };
    expect(promotionFor(prov('user-relayed'), ok)).toBe('Fresh');
    expect(promotionFor(prov('agent-inference'), ok)).toBe('Fresh');
  });
});

const PASS = { ran: true, indeterminate: false, passed: true };
const FAIL = { ran: true, indeterminate: false, passed: false };
const INDET = { ran: false, indeterminate: true, passed: false };

describe('resolveTransition (write-side authority)', () => {
  const rc = (targetState: any, targetSource: any, outcome: any) =>
    resolveTransition({ targetSource, targetState, evidenceSource: 'reality-check', outcome });

  it('reality-check PASS promotes Fresh/Suspect to Corroborated, leaves Verified/Corroborated unchanged', () => {
    expect(rc('Fresh', 'user-relayed', PASS)).toEqual({ kind: 'state', state: 'Corroborated' });
    expect(rc('Suspect', 'user-relayed', PASS)).toEqual({ kind: 'state', state: 'Corroborated' });
    expect(rc('Corroborated', 'user-relayed', PASS)).toEqual({ kind: 'no-change' });
    expect(rc('Verified', 'user', PASS)).toEqual({ kind: 'no-change' });
  });
  it('reality-check FAIL demotes a non-user Fresh/Corroborated to Suspect', () => {
    expect(rc('Fresh', 'user-relayed', FAIL)).toEqual({ kind: 'state', state: 'Suspect' });
    expect(rc('Corroborated', 'agent-inference', FAIL)).toEqual({ kind: 'state', state: 'Suspect' });
    expect(rc('Suspect', 'user-relayed', FAIL)).toEqual({ kind: 'no-change' });
  });
  it('reality-check FAIL is CONTESTED (no demote) for a user-source or Verified target', () => {
    expect(rc('Fresh', 'user', FAIL)).toEqual({ kind: 'contested' });
    expect(rc('Verified', 'user', FAIL)).toEqual({ kind: 'contested' });
  });
  it('reality-check indeterminate is always no-change', () => {
    expect(rc('Fresh', 'user-relayed', INDET)).toEqual({ kind: 'no-change' });
    expect(rc('Verified', 'user', INDET)).toEqual({ kind: 'no-change' });
  });
  it('a user vouch (confirm) yields Verified from any state', () => {
    const cf = (targetState: any) => resolveTransition({ targetSource: 'user', targetState, evidenceSource: 'user', outcome: PASS });
    expect(cf('Fresh')).toEqual({ kind: 'state', state: 'Verified' });
    expect(cf('Suspect')).toEqual({ kind: 'state', state: 'Verified' });
  });
});
