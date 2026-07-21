import { describe, expect, it } from 'vitest';
import {
  semanticCoverage, rankRecords, rankWithArtifacts, buildRankArtifacts, buildIndex, tokenize,
} from '../../src/memory/retrieval.js';
import type { MemoryRecord } from '../../src/types.js';

const rec = (id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id, tx: `2026-07-21T00:00:0${id.length % 10}.000Z`, validFrom: '2026-07-21T00:00:00.000Z', validTo: null,
  type: 'assert', state: 'Fresh', content,
  provenance: { source: 'user', sessionId: 't' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal', ...over,
});

describe('IDF-weighted coverage (unit math)', () => {
  it('a matched rare term outweighs an unmatched-heavy generic remainder under weights', () => {
    // weights: rare=4, each generic=1. Doc matches ONLY the rare term.
    const w = (t: string): number => (t === 'rare' ? 4 : 1);
    const out = semanticCoverage(['rare', 'g1', 'g2', 'g3', 'g4'], ['rare'], undefined, 1, w);
    expect(out.score).toBeCloseTo(4 / 8, 10); // 4 / (4+1+1+1+1) — not the unweighted 1/5
  });
  it('back-compat: omitting weights leaves the score byte-identical to the historical formula', () => {
    const terms = ['alpha', 'beta', 'gamma'];
    const doc = ['alpha', 'x', 'y'];
    const legacy = semanticCoverage(terms, doc);
    expect(legacy.score).toBeCloseTo(1 / 3, 10);
    const uniform = semanticCoverage(terms, doc, undefined, 1, () => 7); // any constant weight
    expect(uniform.score).toBeCloseTo(legacy.score, 10); // constant weights == unweighted
  });
  it('a semantic-neighbor rescue is weighted by the SAME term weight in numerator and denominator', () => {
    // term 'delete' absent; neighbor 'remove' present with table weight 0.5; term weight 3 vs generic 1.
    const expansion = new Map([['delete', [{ token: 'remove', w: 0.5 }]]]);
    const w = (t: string): number => (t === 'delete' ? 3 : 1);
    const out = semanticCoverage(['delete', 'g1'], ['remove'], expansion, 1, w);
    // numerator = 3*0.5 (rescued) + 0 ; denominator = 3 + 1
    expect(out.score).toBeCloseTo(1.5 / 4, 10);
    expect(out.semanticWeight).toBeGreaterThan(0);
  });
  it('the semantic-only detector still keys off UNWEIGHTED lexical match count', () => {
    const expansion = new Map([['delete', [{ token: 'remove', w: 0.9 }]]]);
    const out = semanticCoverage(['delete'], ['remove'], expansion, 1, () => 5);
    expect(out.lexicalMatched).toBe(0); // weights must not disturb the gate's input
  });
});

describe('mechanism regressions from the 2026-07 pilot (synthetic fixtures — no dogfood text)', () => {
  // Pads replicate the REAL corpus shape: generic engineering terms recur across many records
  // (depressing their idf) while each naming token appears exactly once. Without this spread a
  // tiny corpus compresses idf and the mechanism under test disappears.
  const pads = [
    rec('pad_1', 'add a new task; ordering of the set is stable; filtered views are pure'),
    rec('pad_2', 'add new flags; the filtered set keeps ordering; opt-in validate pass'),
    rec('pad_3', 'a new pure renderer; add output over the filtered set; ordering kept'),
    rec('pad_4', 'ordering is stable across saves; add a new opt-in set of flags; one pass'),
    rec('pad_5', 'add tags; new pure store update; filtered set ordering preserved'),
    rec('pad_6', 'the set of flags is validated on load; add new ordering; one pure pass'),
    rec('pad_7', 'a new opt-in output mode; add stats over the filtered set; validate left'),
    rec('pad_8', 'tasks persist in one json file; add new pure functions; filtered set'),
  ];
  // Mechanism A (probes O_63/O_73): the query carries one corpus-UNIQUE token naming the target
  // plus several corpus-common generics; a competitor matches MORE generics. Under equal-weight
  // coverage the competitor wins; rarity-weighted coverage must put the named target first.
  const corpusA = [
    rec('target_a', 'sorttool orders the filtered set of tasks; a new pure comparator'),
    rec('rival_a1', 'add an opt-in ordering over the filtered set: new pure output mode for tasks'),
    ...pads,
  ];
  it('unique-token target ranks first against a generic-heavy rival with phrase advantage (pilot mechanism, fixed)', () => {
    // Baseline: rival covers every generic AND phrase-matches the query prefix -> rival first.
    // IDF-weighted coverage: sorttool (df=1) carries the mass -> target first.
    const out = rankRecords(corpusA, 'add sorttool opt-in ordering over filtered set new');
    expect(out[0]!.id).toBe('target_a');
  });

  const corpusB = [
    rec('target_b', 'flagcheck validates flags in a left-to-right pass; centralized parser'),
    rec('rival_b1', 'the list gets validated: flags run through one new pure pass; loader unchanged'),
    ...pads,
  ];
  it('unique-token target beats a generic-covering rival (second pilot mechanism, fixed)', () => {
    const out = rankRecords(corpusB, 'validate flags via new pure flagcheck one left-to-right pass');
    expect(out[0]!.id).toBe('target_b');
  });

  // CHARACTERIZATION (probes O_10/O_67/O_69 class): the query's discriminative-LOOKING terms
  // dissolve into stems shared across records, and a rival legitimately covers as many query
  // terms as the target. Documented KNOWN LIMITATION of lexical ranking — these assert the
  // CURRENT behavior so a future (semantic/morphological) fix flips them consciously.
  const corpusC = [
    rec('target_c', 'store mutator functions reject an unknown id by throwing; the cli catches it'),
    rec('rival_c1', 'reopen adds a completed task back; a store mutator too; the cli catches unknown id errors thrown here'),
    rec('pad_c1', 'help output prints usage'),
  ];
  it('CHARACTERIZATION: plural query form (mutators) matches NO record forward-prefix; rival with equal generic cover + add wins (known lexical limit)', () => {
    const out = rankRecords(corpusC, 'add mutators store throw unknown id cli');
    expect(out[0]!.id).toBe('rival_c1'); // documents the limitation — flip only with a measured fix
  });
  it('CHARACTERIZATION: an all-generic query (no unique token survives) cannot single out its target (known lexical limit)', () => {
    const corpus = [
      rec('target_d', 'the project gains a second test layer; the first test executes the command end to end'),
      rec('rival_d1', 'pure store functions are unit-tested; the cli layer is tested end to end'),
      rec('pad_d1', 'timestamps use the iso format'),
    ];
    const out = rankRecords(corpus, 'tests two layers pure store fns unit-tested cli');
    expect(out[0]!.id).toBe('rival_d1'); // rival legitimately covers more of the generic bag
  });
});

describe('ranker wiring', () => {
  const corpus = [
    rec('t1', 'sorttool orders the filtered set; pure function over tasks'),
    rec('t2', 'adds an opt-in machine readable output mode, new pure function over tasks'),
  ];
  it('rankRecords and rankWithArtifacts(buildRankArtifacts) agree (A4 cache path parity)', () => {
    const q = 'sorttool ordering set';
    const a = rankRecords(corpus, q).map((r) => r.id);
    const b = rankWithArtifacts(corpus, buildRankArtifacts(corpus), q).map((r) => r.id);
    expect(b).toEqual(a);
  });
  it('idf weights come from the shared union index (df=0 terms get finite positive weight)', () => {
    const idx = buildIndex(corpus.map((r) => ({ id: r.id, tokens: tokenize(r.content) })));
    expect(idx.df.get('nonexistentterm') ?? 0).toBe(0); // df=0 in-index
    // the ranker must not throw on df=0 query terms and the target still ranks:
    const out = rankRecords(corpus, 'sorttool nonexistentterm');
    expect(out[0]!.id).toBe('t1');
  });
});
