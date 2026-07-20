import { describe, expect, it } from 'vitest';
import { topicTerms, deriveQuery } from '../../scripts/pilot/derive.js';

describe('frozen derivation rule', () => {
  it('lowercases, strips code spans and digits, drops stopwords, dedupes, caps at 8', () => {
    const text = 'Exit code 2 on `usage error`; the CLI catches `Error("task #1")` and exits 2 for the user';
    expect(topicTerms(text)).toEqual(['exit', 'code', 'cli', 'catches', 'exits', 'user']);
  });
  it('is deterministic: same input, same output, twice', () => {
    const t = 'Ids must be unique across the store, and a collision refuses the whole store';
    expect(deriveQuery(t)).toBe(deriveQuery(t));
  });
  it('strips the Formerly: tail before extraction (current form is the target)', () => {
    const t = 'Saves are atomic now. Formerly: every save truncated the store in place.';
    expect(topicTerms(t)).not.toContain('truncated');
  });
  it('caps at exactly 8 tokens, keeping first-8 order, when 9+ unique non-stopword candidates are present', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
    expect(topicTerms(text)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']);
  });
});
