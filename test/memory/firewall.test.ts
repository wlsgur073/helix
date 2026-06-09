import { describe, it, expect } from 'vitest';
import { canCommit, promotionFor, type VerifyOutcome } from '../../src/memory/firewall.js';
import type { Provenance } from '../../src/types.js';

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
