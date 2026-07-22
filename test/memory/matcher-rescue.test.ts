// Locks for the 2026-07 matcher-asymmetry repair (spec: docs/superpowers/specs/
// 2026-07-21-retrieval-matcher-asymmetry-repair-design.md §8). Two fixture kinds:
//   negatives    = blocked classes (guards must hold);
//   CHARACTERIZATION = accepted, documented residuals — if a future guard closes the
//   class the test flips and must be consciously updated, not "fixed".
import { describe, it, expect } from 'vitest';
import {
  inflectionRescue,
} from '../../src/memory/retrieval.js';

describe('inflectionRescue (B-infl: suffix-allowlisted reverse prefix)', () => {
  // Positives — the reverse-inflection direction the forward prefix cannot see.
  it.each([['layers', 'layer'], ['tested', 'test'], ['searches', 'search'], ['tasked', 'task']])(
    'query %s reaches record stem %s', (t, dd) => {
      expect(inflectionRescue(t, [dd])).toBe(true);
    });
  // Blocked: pseudo-suffix words the withdrawn delta-cap would have admitted (R-F7).
  it.each([['planet', 'plan'], ['portal', 'port'], ['formal', 'form']])(
    '%s <- %s is not an inflection (allowlist, not delta-cap)', (t, dd) => {
      expect(inflectionRescue(t, [dd])).toBe(false);
    });
  // Blocked: compound sprays that killed the prior cycle's naive bidirectional prefix.
  it.each([['completetask', 'complete'], ['searchtasks', 'search']])(
    '%s <- %s rejected (remainder is not an inflection suffix)', (t, dd) => {
      expect(inflectionRescue(t, [dd])).toBe(false);
    });
  it('stem shorter than 4 never matches (adds <- add)', () => {
    expect(inflectionRescue('adds', ['add'])).toBe(false);
  });
  it('exact/equal token is not a rescue (proper prefix required)', () => {
    expect(inflectionRescue('layers', ['layers'])).toBe(false);
  });
  it('non-ASCII term is out of scope even when the suffix shape matches (R3-3)', () => {
    // mixed-script single token: shape would pass (stem length 5, remainder 's')
    expect(inflectionRescue('литерs', ['литер'])).toBe(false);
  });
  // Characterized residual (R2-4, ACCEPTED): the allowlist validates suffix SHAPE, not
  // lemma identity. Gated in production by support-required; audited 351/5 on the frozen
  // corpus (spec §4).
  it.each([['united', 'unit'], ['stated', 'stat'], ['staring', 'star'], ['evening', 'even']])(
    'CHARACTERIZATION: false morphology %s <- %s DOES match (accepted residual)', (t, dd) => {
      expect(inflectionRescue(t, [dd])).toBe(true);
    });
});
