// Locks for the 2026-07 matcher-asymmetry repair (spec: docs/superpowers/specs/
// 2026-07-21-retrieval-matcher-asymmetry-repair-design.md §8). Two fixture kinds:
//   negatives    = blocked classes (guards must hold);
//   CHARACTERIZATION = accepted, documented residuals — if a future guard closes the
//   class the test flips and must be consciously updated, not "fixed".
import { describe, it, expect } from 'vitest';
import {
  inflectionRescue, concatRescue, tokenize,
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

describe("concatRescue (A': adjacent-token concatenation equality)", () => {
  const toks = (s: string): string[] => tokenize(s);
  // Positives — record-side tokenizer split an identifier the query carries jammed-lowercase.
  it('camelCase-split identifier: completetask <- "first applied in completeTask here"', () => {
    expect(concatRescue('completetask', toks('first applied in completeTask here'))).toBe(true);
  });
  it('searchtasks <- "store function searchTasks does"', () => {
    expect(concatRescue('searchtasks', toks('store function searchTasks does'))).toBe(true);
  });
  it('space-separated content words match too (token-join semantics, R-F8/R2-2)', () => {
    expect(concatRescue('completetask', toks('complete task'))).toBe(true);
  });
  it('three-constituent join', () => {
    expect(concatRescue('storetaskindex', toks('store task index'))).toBe(true);
  });
  // Blocked classes.
  it('mid-word substring never matches: search vs research (equality, not substring)', () => {
    expect(concatRescue('search', toks('prior research notes'))).toBe(false);
  });
  it('non-adjacent constituents never match', () => {
    expect(concatRescue('completetask', toks('complete big task'))).toBe(false);
  });
  it.each([
    ['invalid', 'recovery works in valid state'],
    ['insecure', 'runs in secure mode'],
    ['notable', 'this is not able to run'],
  ])('meaning-inversion join blocked (R2-3 constituent guard): %s', (t, src) => {
    expect(concatRescue(t, toks(src))).toBe(false);
  });
  it('short constituent blocked: commands <- "the command s parser"', () => {
    expect(concatRescue('commands', toks('the command s parser'))).toBe(false);
  });
  it('term shorter than 6 never matches', () => {
    expect(concatRescue('dolog', toks('do log'))).toBe(false);
  });
  it('Cyrillic is out of scope (R3-3): only the ASCII gate blocks this one', () => {
    // 'под'/'ход' are 3-char non-(EN/KO)-stopword constituents — length/stopword guards
    // would NOT block; the explicit ASCII restriction must (spec §8.4).
    expect(concatRescue('подход', toks('под ход'))).toBe(false);
  });
  // Characterized residuals (ACCEPTED, spec §2).
  it('CHARACTERIZATION: content-word join forming another word: office <- "off ice"', () => {
    expect(concatRescue('office', toks('puck slides off ice fast'))).toBe(true);
  });
  it('CHARACTERIZATION: separator blindness — "complete. Task" == "complete task" (R2-2)', () => {
    expect(concatRescue('completetask', toks('complete. Task'))).toBe(true);
  });
});
