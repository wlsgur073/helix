import { describe, it, expect } from 'vitest';
import { normalizeUntrusted } from '../../src/memory/content-frame.js';
import { classifyAction } from '../../src/risk/blast-radius.js';
import { requiresReverifyBeforeUse } from '../../src/memory/state-machine.js';

// AUDIT 2026-06-15 — J2 trust/quarantine.

// J2-3 (FIX TARGET): the fence-breaker exists to neutralize runs that read as a structural
// marker / code fence / rule. It misses markdown thematic breaks (*** / ___) and dash-like
// confusables that NFKC does not fold (U+2010 HYPHEN, U+2212 MINUS SIGN). These assert the
// DESIRED post-fix behavior and are RED until FENCE_RUN is extended.
describe('J2 audit — content-frame fence coverage (fix target)', () => {
  it('J2-3: breaks markdown asterisk/underscore thematic breaks', () => {
    expect(normalizeUntrusted('***')).not.toContain('***');
    expect(normalizeUntrusted('___')).not.toContain('___');
  });
  it('J2-3: breaks dash-like confusables NFKC does not fold (U+2010, U+2212)', () => {
    expect(normalizeUntrusted('‐‐‐')).not.toContain('‐‐‐');
    expect(normalizeUntrusted('−−−')).not.toContain('−−−');
  });
});

// J2-1 / J2-2 (REPORT, design): characterization of the current reverify gate.
describe('J2 audit — blast-radius / reverify design (characterization)', () => {
  it('J2-1: write is low-blast, so a Suspect+write-tagged item skips forced re-verify', () => {
    // classifyAction (action-level) is NOT wired to requiresReverifyBeforeUse (item-level);
    // and an unconditional write -> local-reversible means a Suspect item used to guide a
    // destructive overwrite is not forced to re-verify (if its stored blastRadius is write-level).
    expect(classifyAction({ kind: 'write', target: '~/.bashrc' })).toBe('local-reversible');
    expect(requiresReverifyBeforeUse({ state: 'Suspect', blastRadius: 'local-reversible', source: 'user' })).toBe(false);
  });
  it('J2-2: a Fresh (never-verified) item skips re-verify even on a hard-to-reverse path', () => {
    expect(requiresReverifyBeforeUse({ state: 'Fresh', blastRadius: 'hard-to-reverse', source: 'user' })).toBe(false);
  });
});
