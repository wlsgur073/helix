import { describe, it, expect } from 'vitest';
import { markSuspect, requiresReverifyBeforeUse } from '../../src/memory/state-machine.js';

describe('state machine', () => {
  it('markSuspect moves Verified -> Suspect on observed change', () => {
    expect(markSuspect('Verified')).toBe('Suspect');
    expect(markSuspect('Fresh')).toBe('Suspect');
  });

  it('high-blast-radius Suspect use REQUIRES re-verify (K=0)', () => {
    expect(requiresReverifyBeforeUse({ state: 'Suspect', blastRadius: 'hard-to-reverse' })).toBe(true);
    expect(requiresReverifyBeforeUse({ state: 'Suspect', blastRadius: 'external' })).toBe(true);
  });

  it('low-blast-radius Suspect use MAY proceed on aged copy', () => {
    expect(requiresReverifyBeforeUse({ state: 'Suspect', blastRadius: 'read-only' })).toBe(false);
    expect(requiresReverifyBeforeUse({ state: 'Suspect', blastRadius: 'local-reversible' })).toBe(false);
  });

  it('Verified items do not require re-verify', () => {
    expect(requiresReverifyBeforeUse({ state: 'Verified', blastRadius: 'hard-to-reverse' })).toBe(false);
  });

  it('unknown blast radius on a Suspect item fails safe -> requires re-verify', () => {
    expect(requiresReverifyBeforeUse({ state: 'Suspect', blastRadius: null })).toBe(true);
  });
});
