// Locks for the 2026-07 matcher-asymmetry repair (spec: docs/superpowers/specs/
// 2026-07-21-retrieval-matcher-asymmetry-repair-design.md §8). Two fixture kinds:
//   negatives    = blocked classes (guards must hold);
//   CHARACTERIZATION = accepted, documented residuals — if a future guard closes the
//   class the test flips and must be consciously updated, not "fixed".
import { describe, it, expect } from 'vitest';
import {
  inflectionRescue, concatRescue, semanticCoverage, tokenize, type Expansion,
  coverageScore, rankRecords,
} from '../../src/memory/retrieval.js';
import type { MemoryRecord } from '../../src/types.js';

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

describe('semanticCoverage rescue wiring (support-required, R3-1)', () => {
  it('no independent direct match -> rescues never fire (single-term compound query)', () => {
    // the phrase lane serves single-term compound queries in production (spec §2, measured)
    expect(semanticCoverage(['layers'], ['layer']).score).toBe(0);
    expect(semanticCoverage(['completetask'], ['complete', 'task']).score).toBe(0);
  });
  it('an independent direct anchor opens the gate; rescue gets FULL credit and counts as lexical', () => {
    const c = semanticCoverage(['layers', 'cache'], ['layer', 'cache']);
    expect(c.score).toBe(1);          // cache direct, layers rescued at weight 1
    expect(c.lexicalMatched).toBe(2); // rescue counts toward lexicalMatched (M6 lock)
    expect(c.semanticWeight).toBe(0); // a rescue is lexical evidence, not semantic
  });
  it('gate identity: a record can never gain its FIRST lexical evidence from a rescue', () => {
    // both terms individually rescueable, but neither matches directly -> nothing fires (§8.7)
    const c = semanticCoverage(['completetask', 'layers'], ['complete', 'task', 'layer']);
    expect(c.score).toBe(0);
    expect(c.lexicalMatched).toBe(0);
  });
  it('the neighbor-presence predicate stays exact/forward-prefix — rescues NOT wired in (R-F5)', () => {
    const EXP: Expansion = new Map([['erase', [{ token: 'completetask', w: 0.9 }]]]);
    // support exists ('cache' direct) and the record holds complete+task adjacently, but the
    // NEIGHBOR token 'completetask' must not become "present" via concatenation.
    const c = semanticCoverage(['erase', 'cache'], ['complete', 'task', 'cache'], EXP, 1);
    expect(c.semanticWeight).toBe(0);
  });
  it('weighted path: rescue credit scales with the term weight like a direct match', () => {
    const w = (t: string): number => (t === 'layers' ? 4 : 1);
    const c = semanticCoverage(['layers', 'cache'], ['layer', 'cache'], undefined, 1, w);
    expect(c.score).toBe(1); // (4 + 1) / (4 + 1) — full credit at weight w, denominator unchanged
  });
});

function rec(id: string, content: string): MemoryRecord {
  return { id, tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content, provenance: { source: 'user', sessionId: 'cli' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' };
}

describe('coverageScore delegates to semanticCoverage (R-F6 docstring contract)', () => {
  it('equals lexical-only semanticCoverage.score on varied inputs (parity property)', () => {
    const cases: Array<[string[], string[]]> = [
      [['delete'], ['delete', 'task']],
      [['auth'], ['authentication', 'flow']],
      [['layers', 'cache'], ['layer', 'cache']],
      [['completetask', 'search'], ['complete', 'task', 'search', 'index']],
      [['nothing'], ['else', 'here']],
      [[], ['x']],
    ];
    for (const [q, d] of cases) {
      expect(coverageScore(q, d), JSON.stringify(q)).toBe(semanticCoverage(q, d).score);
    }
  });
  it('rescues reach coverageScore too (delegation is live, not a copy)', () => {
    expect(coverageScore(['layers', 'cache'], ['layer', 'cache'])).toBe(1);
  });
});

describe('ranking-level locks (FULL production formula via rankRecords)', () => {
  it('R3-1 negative: a false-morphology rescue cannot outrank the true target (support gate)', () => {
    // Codex round-3 counterexample, adjudicated ACCEPTED: without the support gate,
    // stated<-stat full-idf credit lifts 'wrong' to 0.422 past the target's 0.212 (spec §2).
    const rs = [rec('target', 'rollback procedure'), rec('wrong', 'stat counter')];
    // Full-array lock (C1.2 vacuation-proofing): the support gate zeroes the rescue COVERAGE,
    // but 'wrong' stays present at rank 2 via the phrase leg's char-prefix crumb ('stat' = the
    // leading 4 chars of the normalized query). The lock pins order AND membership — a [0]-only
    // assertion stays green if 'wrong' vanishes or a third record slips in.
    expect(rankRecords(rs, 'stated rollback').map((r) => r.id)).toEqual(['target', 'wrong']);
  });
  it("CHARACTERIZATION (R4-5, accepted residual): a generic shared anchor re-opens the flip", () => {
    // Option A explicit risk acceptance (spec §2 RESOLVED round 4): binary support is
    // bypassable via a low-idf shared anchor ('store'). Per-rescue audit over both frozen
    // manifests: 351 supported rescues, 5 harmful, ALL at the two documented-limitation
    // sites (O_66 4->5, O_67 competitors). If a future guard closes this class, this test
    // SHOULD flip — update it consciously; do not "fix" the guard to keep it green.
    const rs = [rec('target', 'rollback procedure store'), rec('wrong', 'stat counter store')];
    // Full-array lock (C1.2): both records survive (shared 'store' anchor supports the rescue);
    // the characterized residual is the ORDER, and the target's continued presence at rank 2 is
    // part of the characterization — a [0]-only assertion could not see it vanish.
    expect(rankRecords(rs, 'stated store rollback').map((r) => r.id)).toEqual(['wrong', 'target']);
  });
});
