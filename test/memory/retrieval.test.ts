import { describe, it, expect } from 'vitest';
import { tokenize, normalizeText } from '../../src/memory/retrieval.js';
import { meaningfulTokens } from '../../src/memory/retrieval.js';
import { coverageScore } from '../../src/memory/retrieval.js';
import { phraseScore } from '../../src/memory/retrieval.js';
import { buildIndex, bm25Score } from '../../src/memory/retrieval.js';
import { rankRecords } from '../../src/memory/retrieval.js';
import type { MemoryRecord, MemoryState } from '../../src/types.js';

function mrec(id: string, content: string, state: MemoryState = 'Fresh', tx = '2026-06-09T00:00:00.000Z'): MemoryRecord {
  return {
    id, tx, validFrom: tx, validTo: null, type: 'assert', state, content,
    provenance: { source: 'user', sessionId: 's' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  };
}

describe('tokenize', () => {
  it('lowercases and splits English on word/separator boundaries', () => {
    expect(tokenize('The Database uses Postgres')).toEqual(['the', 'database', 'uses', 'postgres']);
  });
  it('splits identifiers: separators, camelCase, letter<->digit', () => {
    expect(tokenize('helix-mcp.mjs')).toEqual(['helix', 'mcp', 'mjs']);
    expect(tokenize('parseLedger')).toEqual(['parse', 'ledger']);
    expect(tokenize('node20')).toEqual(['node', '20']);
  });
  it('emits CJK per-character tokens AND adjacent bigrams', () => {
    expect(tokenize('배포를')).toEqual(['배', '포', '를', '배포', '포를']);
  });
  it('NFKC-normalizes: NFD Hangul composes; full-width digits fold', () => {
    const nfd = '한'.normalize('NFD'); // 3 conjoining jamo
    expect(tokenize(nfd)).toEqual(['한']);
    expect(tokenize('３')).toEqual(['3']);
  });
  it('normalizeText is NFKC + lowercase, no tokenization', () => {
    expect(normalizeText('Node 20')).toBe('node 20');
  });
});

describe('meaningfulTokens', () => {
  it('drops English stopwords (English is the default language)', () => {
    expect(meaningfulTokens(['what', 'did', 'we', 'decide', 'about', 'node', '20']))
      .toEqual(['decide', 'node', '20']);
  });
  it('drops Korean particles', () => {
    expect(meaningfulTokens(['배포', '는', '정책'])).toEqual(['배포', '정책']);
  });
});

describe('coverageScore', () => {
  it('counts exact token matches as a ratio of unique query terms', () => {
    expect(coverageScore(['postgres', 'database'], ['the', 'database', 'uses', 'postgres'])).toBe(1);
    expect(coverageScore(['postgres', 'react'], ['uses', 'postgres'])).toBe(0.5);
  });
  it('expands a >=3-char query token to a record token prefix (auth -> authentication)', () => {
    expect(coverageScore(['auth'], ['authentication', 'flow'])).toBe(1);
  });
  it('does NOT expand short (<3) tokens (id must not match video/idea)', () => {
    expect(coverageScore(['id'], ['video', 'idea'])).toBe(0);
  });
  it('returns 0 for an empty query-term list', () => {
    expect(coverageScore([], ['anything'])).toBe(0);
  });
});

describe('phraseScore', () => {
  it('returns 1.0 when the full normalized query is a contiguous substring', () => {
    expect(phraseScore('memory erase', 'our memory erase policy')).toBe(1);
  });
  it('matches contiguous CJK at length 2 (배포)', () => {
    expect(phraseScore('배포', '배포를 한다')).toBe(1);
  });
  it('returns a prefix ratio when only a leading part matches', () => {
    expect(phraseScore('postgres', 'we use postgresql')).toBe(1);   // whole query is a substring
    expect(phraseScore('reactjs', 'react app')).toBeCloseTo(5 / 7); // 'react' (5) is the longest prefix present
  });
  it('does NOT fire for short ASCII queries (id must not match inside video)', () => {
    expect(phraseScore('id', 'a short video clip')).toBe(0); // ASCII < 3 chars => no phrase
    expect(phraseScore('xy', 'totally unrelated')).toBe(0);
  });
  it('strips leading stopwords so a stopword prefix cannot drive a match (spec §5)', () => {
    expect(phraseScore('what did we decide about node 20', 'what about the weather')).toBe(0);
    expect(phraseScore('the memory erase', 'our memory erase policy')).toBe(1);
  });
});

describe('bm25', () => {
  const docs = [
    { id: 'a', tokens: tokenize('rare apple common common common') },
    { id: 'b', tokens: tokenize('common common common common common') },
    { id: 'c', tokens: tokenize('common word here') },
  ];
  it('weights a rare term above a common one (IDF)', () => {
    const idx = buildIndex(docs);
    expect(bm25Score('a', ['rare'], idx)).toBeGreaterThan(bm25Score('a', ['common'], idx));
  });
  it('sums over unique query terms only (no linear repeat boost)', () => {
    const idx = buildIndex(docs);
    expect(bm25Score('a', ['rare', 'rare'], idx)).toBe(bm25Score('a', ['rare'], idx));
  });
  it('returns 0 for a doc the term is absent from', () => {
    const idx = buildIndex(docs);
    expect(bm25Score('c', ['apple'], idx)).toBe(0);
  });
  it('guards empty corpus (N=0, avgdl=0)', () => {
    const idx = buildIndex([]);
    expect(idx.N).toBe(0);
    expect(bm25Score('x', ['anything'], idx)).toBe(0);
  });
});

describe('rankRecords', () => {
  it('coverage beats rarity: two central terms outrank one rare incidental term', () => {
    const out = rankRecords([
      mrec('central', 'memory erase notes'),
      mrec('rare', 'unrelated policy thoughts'),
    ], 'memory erase policy');
    expect(out[0]?.id).toBe('central');
  });
  it('filters zero-relevance records (no token/phrase match)', () => {
    const out = rankRecords([mrec('hit', 'deploy steps'), mrec('miss', 'lunch menu')], 'deploy');
    expect(out.map((r) => r.id)).toEqual(['hit']);
  });
  it('empty / all-stopword query returns []', () => {
    expect(rankRecords([mrec('a', 'anything')], '')).toEqual([]);
    expect(rankRecords([mrec('a', 'anything')], 'the what is')).toEqual([]);
  });
  it('caps to maxItems', () => {
    const recs = Array.from({ length: 30 }, (_, i) => mrec(`m${i}`, 'shared keyword'));
    expect(rankRecords(recs, 'shared', { maxItems: 5 })).toHaveLength(5);
  });
  it('trust margin: a near-equal Suspect loses to Verified', () => {
    const out = rankRecords([
      mrec('v', 'deploy policy', 'Verified'),
      mrec('s', 'deploy policy', 'Suspect'),
    ], 'deploy policy');
    expect(out[0]?.id).toBe('v');
  });
  it('trust margin: a much-more-relevant Suspect still wins (no ceiling)', () => {
    const out = rankRecords([
      mrec('v', 'deploy something unrelated padding text', 'Verified'),
      mrec('s', 'deploy policy', 'Suspect'),
    ], 'deploy policy');
    expect(out[0]?.id).toBe('s');
  });
  it('recency breaks ties (newer tx first)', () => {
    const out = rankRecords([
      mrec('old', 'deploy policy', 'Fresh', '2026-06-01T00:00:00.000Z'),
      mrec('new', 'deploy policy', 'Fresh', '2026-06-10T00:00:00.000Z'),
    ], 'deploy policy');
    expect(out[0]?.id).toBe('new');
  });
  it('bm25 all-zero branch: ranks by phrase+coverage when no token literally overlaps', () => {
    // 'auth' is not a literal token in either doc (tokens are 'authentication','flow'),
    // so every BM25 raw score is 0 -> max==min -> bm25norm 0; ranking must come from
    // phrase + coverage (prefix expansion) alone.
    const out = rankRecords([mrec('a', 'authentication flow'), mrec('b', 'something else')], 'auth');
    expect(out.map((r) => r.id)).toEqual(['a']);
  });
});

describe('golden queries (spec 2026-06-13 §10)', () => {
  it('English NL query ignores stopwords and finds the identifier record', () => {
    const out = rankRecords([
      mrec('target', 'we will deploy on node20 in staging'),
      mrec('noise', 'what about the weather and the news'),
    ], 'what did we decide about node 20');
    expect(out[0]?.id).toBe('target');
    expect(out.map((r) => r.id)).not.toContain('noise');
  });
  it('prefix expansion: auth -> authentication', () => {
    const out = rankRecords([mrec('a', 'authentication flow notes')], 'auth');
    expect(out.map((r) => r.id)).toEqual(['a']);
  });
  it('short token does not over-match (id !-> video)', () => {
    expect(rankRecords([mrec('v', 'video editing notes')], 'id')).toEqual([]);
  });
  it('Korean: 배포 matches both 배포를 and 배포는', () => {
    const out = rankRecords([mrec('a', '배포를 한다'), mrec('b', '배포는 위험하다')], '배포');
    expect(out.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
  it('Korean: contiguous 배포 outranks scattered 배 ... 포', () => {
    const out = rankRecords([
      mrec('scattered', '배 그리고 포 따로'),
      mrec('contiguous', '배포 절차'),
    ], '배포');
    expect(out[0]?.id).toBe('contiguous');
  });
  it('NFKC: NFD-decomposed Hangul matches composed', () => {
    const out = rankRecords([mrec('a', '한국 메모')], '한'.normalize('NFD'));
    expect(out.map((r) => r.id)).toEqual(['a']);
  });
  it('length fairness: a short on-point record beats a long padded one', () => {
    const out = rankRecords([
      mrec('long', 'deploy ' + 'padding '.repeat(40)),
      mrec('short', 'deploy steps'),
    ], 'deploy steps');
    expect(out[0]?.id).toBe('short');
  });
});
