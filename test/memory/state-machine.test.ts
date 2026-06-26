import { describe, it, expect } from 'vitest';
import { markSuspect, requiresReverifyBeforeUse } from '../../src/memory/state-machine.js';

describe('state machine', () => {
  it('markSuspect moves Verified -> Suspect on observed change', () => {
    expect(markSuspect('Verified')).toBe('Suspect');
    expect(markSuspect('Fresh')).toBe('Suspect');
  });

  it('high-blast-radius Suspect use REQUIRES re-verify (K=0)', () => {
    expect(requiresReverifyBeforeUse({ state: 'Suspect', blastRadius: 'hard-to-reverse', source: 'user' })).toBe(true);
    expect(requiresReverifyBeforeUse({ state: 'Suspect', blastRadius: 'external', source: 'user' })).toBe(true);
  });

  it('low-blast-radius Suspect use MAY proceed on aged copy', () => {
    expect(requiresReverifyBeforeUse({ state: 'Suspect', blastRadius: 'read-only', source: 'user' })).toBe(false);
    expect(requiresReverifyBeforeUse({ state: 'Suspect', blastRadius: 'local-reversible', source: 'user' })).toBe(false);
  });

  it('Verified items do not require re-verify', () => {
    expect(requiresReverifyBeforeUse({ state: 'Verified', blastRadius: 'hard-to-reverse', source: 'user' })).toBe(false);
  });

  it('unknown blast radius on a Suspect item fails safe -> requires re-verify', () => {
    expect(requiresReverifyBeforeUse({ state: 'Suspect', blastRadius: null, source: 'user' })).toBe(true);
  });

  it('always flags a non-authoritative source, even at low/unknown blast radius', () => {
    for (const source of ['user-relayed', 'agent-inference', 'codex-agree'] as const) {
      expect(requiresReverifyBeforeUse({ state: 'Fresh', blastRadius: 'read-only', source })).toBe(true);
      expect(requiresReverifyBeforeUse({ state: 'Fresh', blastRadius: null, source })).toBe(true);
      expect(requiresReverifyBeforeUse({ state: 'Fresh', blastRadius: 'external', source })).toBe(true);
    }
  });

  it('does NOT flag an authoritative Fresh item (any blast radius)', () => {
    expect(requiresReverifyBeforeUse({ state: 'Fresh', blastRadius: 'external', source: 'user' })).toBe(false);
    expect(requiresReverifyBeforeUse({ state: 'Fresh', blastRadius: null, source: 'reality-check' })).toBe(false);
  });
});
