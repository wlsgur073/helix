import { describe, it, expect } from 'vitest';
import { classifyProbe, strictSuperset, type CandidateDoc } from '../../scripts/pilot/classify-o67.js';

const probe = (over: Partial<Parameters<typeof classifyProbe>[0]> = {}) => ({
  id: 'P_1', query: 'add completetask store mutators throw unknown id cli', relevant: ['t1'], unambiguous: true, ...over,
});

// Mini-corpus shaped like the real O_67: a short defining record and two longer restating ones.
const target: CandidateDoc = { id: 't1', scope: 'project', content: 'store mutators throw on unknown id; the CLI maps it. completeTask follows the contract.' };
const restater: CandidateDoc = { id: 'c1', scope: 'project', content: 'add uses the same store mutators contract: throw on unknown id, CLI maps it, like completeTask.' };

describe('strictSuperset', () => {
  it('is strict', () => {
    expect(strictSuperset(new Set(['a', 'b']), new Set(['a']))).toBe(true);
    expect(strictSuperset(new Set(['a']), new Set(['a']))).toBe(false);
    expect(strictSuperset(new Set(['a', 'c']), new Set(['a', 'b']))).toBe(false);
  });
});

describe('classifyProbe', () => {
  it('flags superset competition as in-class with the witness and its extra terms', () => {
    const v = classifyProbe(probe(), [target, restater]);
    expect(v.status).toBe('in-class');
    // Emitted identities carry scope, in the SAME canonical form as the candidate-universe
    // artifact, so "is every witness in the universe?" is direct string equality.
    expect(v.witnesses).toEqual([{ id: 'project:c1', extraTerms: ['add'] }]);
    // targetId stays BARE: it echoes the manifest's `relevant` entry verbatim. The resolved scope
    // rides alongside it instead, so the pair is recoverable without redefining a manifest field.
    expect(v.targetId).toBe('t1');
    expect(v.targetScope).toBe('project');
    expect(v.finalHit1Eligible).toBe(false);
    expect(v.baseHit1Eligible).toBe(true);
  });

  it('equal coverage is NOT in-class (reported informationally)', () => {
    const twin: CandidateDoc = { id: 'c2', scope: 'global', content: target.content };
    const v = classifyProbe(probe(), [target, twin]);
    expect(v.status).toBe('not-in-class');
    expect(v.equalCoverage).toEqual(['global:c2']);
    expect(v.finalHit1Eligible).toBe(true);
  });

  it('a zero-evidence target is target-zero-evidence, never in-class (empty set inflates exposure)', () => {
    const blank: CandidateDoc = { id: 't1', scope: 'project', content: '한국어 전용 내용' };
    const other: CandidateDoc = { id: 'c1', scope: 'project', content: 'add store throw unknown id cli' };
    const v = classifyProbe(probe(), [blank, other]);
    expect(v.status).toBe('target-zero-evidence');
  });

  it('multi-target and empty-relevance probes are out of domain', () => {
    expect(classifyProbe(probe({ relevant: ['a', 'b'] }), [target]).status).toBe('out-of-domain');
    expect(classifyProbe(probe({ relevant: [] }), [target]).reason).toBe('no-target');
  });

  it('missing and duplicate target identities are unscorable, never non-member', () => {
    expect(classifyProbe(probe(), [restater]).reason).toBe('target-not-servable');
    expect(classifyProbe(probe(), [target, { ...target }]).reason).toBe('duplicate-target-identity');
  });

  it('support gate flows through: rescued terms count for target and witness alike', () => {
    const v = classifyProbe(probe(), [target, restater]);
    expect(v.targetRescued).toContain('completetask');
    expect(v.targetMatched).toContain('completetask');
  });

  it('a competitor in the OTHER scope is emitted with that scope, not the target\'s', () => {
    const globalRestater: CandidateDoc = { id: 'c9', scope: 'global', content: restater.content };
    const v = classifyProbe(probe(), [target, globalRestater]);
    expect(v.status).toBe('in-class');
    expect(v.witnesses).toEqual([{ id: 'global:c9', extraTerms: ['add'] }]);
  });

  it('duplicate-target-identity keeps its bare-id meaning — scope qualification must not redefine it', () => {
    // Rule §2 makes this a hard error, never a clean non-member. Keying the target lookup by the
    // (scope, id) PAIR would turn a cross-scope duplicate into two clean identities and silently
    // change the normative membership rule, which is C1.3's reopen condition. A cross-scope
    // collision is refused upstream by the snapshot precondition instead.
    expect(classifyProbe(probe(), [target, { ...target, scope: 'global' }]).reason)
      .toBe('duplicate-target-identity');
  });
});
