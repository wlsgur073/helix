import { describe, it, expect } from 'vitest';
import { buildAgreementMap } from '../../src/verify/agreement-map.js';
import { buildCodexExecArgs } from '../../src/verify/codex.js';
import { detectEcho } from '../../src/risk/trifecta.js';

// AUDIT 2026-06-15 — J4 verify path. CHARACTERIZATION (current behavior).

describe('J4 audit — agreement-map now matches paraphrases (J4-1 FIXED)', () => {
  it('semantically-equal answers (reordered words) are AGREE with the claim listed', () => {
    const m = buildAgreementMap('The capital of France is Paris.', 'Paris is the capital of France.');
    expect(m.verdict).toBe('agree');
    expect(m.agreements).toContain('The capital of France is Paris');
  });
  it('a near-paraphrase (extra trailing word) still agrees (token overlap >= 0.5)', () => {
    const m = buildAgreementMap('We deploy on Friday', 'We deploy on Friday afternoon');
    expect(m.verdict).toBe('agree');
  });
  it('genuinely different claims still diverge', () => {
    const m = buildAgreementMap('Use Postgres for storage', 'Use Redis as the cache');
    expect(m.verdict).toBe('diverge');
  });
});

describe('J4 audit — codex model arg rejects leading dash (J4-2 FIXED)', () => {
  it('a leading-dash model is now rejected (regex aligned with the "no leading dash" intent)', () => {
    expect(() => buildCodexExecArgs('/tmp/out.txt', { model: '-rf' })).toThrow(/invalid codex model/i);
  });
  it('a normal model is still accepted', () => {
    expect(() => buildCodexExecArgs('/tmp/out.txt', { model: 'gpt-5.5' })).not.toThrow();
  });
});

// J1-9 (FIXED): detectEcho ran O(items * per_item_cap * maxScan) per dual-verify over the FULL
// ledger (server wires ledgerTexts = all items); the no-echo common case was the worst case. The
// fix precomputes the haystack k-gram set (O(n+m)) with identical matches. These guard correctness
// at scale (the path that used to be the cliff).
describe('J1-9 audit — detectEcho scale correctness (behavior-preserving perf fix)', () => {
  const phrase = 'the deploy uses the blue cluster in us-east-1';
  it('over a 400-item ledger, returns exactly the one echoing item', () => {
    const ledger = Array.from({ length: 400 }, (_, i) =>
      i === 200 ? { id: 'echo', content: phrase } : { id: `m_${i}`, content: `unrelated note ${i} on assorted other topics entirely` });
    expect(detectEcho([phrase], ledger).memoryIds).toEqual(['echo']);
  });
  it('a clean payload over a 400-item ledger returns [] (the former quadratic worst case)', () => {
    const ledger = Array.from({ length: 400 }, (_, i) => ({ id: `m_${i}`, content: `unrelated note ${i} about assorted unrelated matters here` }));
    expect(detectEcho(['a totally different question with zero overlap whatsoever present'], ledger).memoryIds).toEqual([]);
  });
});
