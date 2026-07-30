import { describe, expect, it } from 'vitest';
import { frozenEligibleSet, o67Census, prepareGateSet, staleExposure, type ManifestProbe, type ClassifierVerdict } from '../../scripts/pilot/prepare-gate.js';
import type { LedgerRow, ScopedLedger } from '../../scripts/pilot/generate-manifest.js';

/** C5.1 closure item 3, prepare phase — the OUTCOME-BLIND half of the two-phase reducer.
 *
 *  Its one job is to freeze the denominator before anybody can see a rank. Every test here is
 *  therefore about what the denominator IS and what makes preparation refuse to produce one; no
 *  test in this file may reference a rank, a hit, or any other runner output, because the phase
 *  under test cannot read them. */

const mProbe = (target: string, unambiguous = true): ManifestProbe =>
  ({ id: `L_${target}`, query: `query for ${target}`, relevant: [target], unambiguous, side: 'ledger' });
const cVerdict = (target: string, over: Partial<ClassifierVerdict> = {}): ClassifierVerdict =>
  ({ id: `L_${target}`, status: 'not-in-class', targetId: target, targetScope: 'project', hit1Eligible: true, ...over });

describe('frozen eligible set — the Hit@1 denominator', () => {
  it('is the eligible probes, with exposure counted in distinct target IDENTITIES', () => {
    // §3a states three roles — exposure unit, metric denominator, success rule — that coincide
    // only because the generator emits one probe per source record. They are computed separately
    // so the artifact records which is which rather than assuming the coincidence holds.
    const set = frozenEligibleSet(
      [mProbe('m_a'), mProbe('m_b'), mProbe('m_c', false)],
      [cVerdict('m_a'), cVerdict('m_b'), cVerdict('m_c', { hit1Eligible: false })],
    );
    expect(set.probeIds).toEqual(['L_m_a', 'L_m_b']);
    expect(set.identities).toEqual(['project:m_a', 'project:m_b']);
    expect(set.exposure).toBe(2);
  });

  it('labels exposure against the minimum of 2, which is where a shortfall blocks', () => {
    const at = (n: number) => frozenEligibleSet(
      Array.from({ length: n }, (_, i) => mProbe(`m_${i}`)),
      Array.from({ length: n }, (_, i) => cVerdict(`m_${i}`)),
    ).label;
    expect(at(0)).toBe('UNEXERCISED — 0/2');
    expect(at(1)).toBe('PARTIALLY EXERCISED — 1/2 (minimum not met)');
    expect(at(2)).toBe('EXERCISED — 2/2');
    expect(at(3)).toBe('EXERCISED — 3/2');
  });

  it('fails closed when two eligible probes name the same target identity', () => {
    // §3a: freeze one-probe-per-identity as an invariant. Paraphrase probes sharing an identity
    // would inflate the nominal sample and break the independence the reported bound rests on.
    expect(() => frozenEligibleSet(
      [{ ...mProbe('m_a'), id: 'L_one' }, { ...mProbe('m_a'), id: 'L_two' }],
      [cVerdict('m_a', { id: 'L_one' }), cVerdict('m_a', { id: 'L_two' })],
    )).toThrow(/duplicate-target-identity/);
  });

  it('separates identities by SCOPE, so the same record id in two scopes is two identities', () => {
    const set = frozenEligibleSet(
      [{ ...mProbe('m_a'), id: 'L_g' }, { ...mProbe('m_a'), id: 'L_p' }],
      [cVerdict('m_a', { id: 'L_g', targetScope: 'global' }), cVerdict('m_a', { id: 'L_p' })],
    );
    expect(set.identities).toEqual(['global:m_a', 'project:m_a']);
    expect(set.exposure).toBe(2);
  });

  it('fails closed on a probe that does not name exactly one target', () => {
    expect(() => frozenEligibleSet([{ ...mProbe('m_a'), relevant: [] }], [cVerdict('m_a')]))
      .toThrow(/single-target/);
    expect(() => frozenEligibleSet([{ ...mProbe('m_a'), relevant: ['m_a', 'm_b'] }], [cVerdict('m_a')]))
      .toThrow(/single-target/);
  });

  it('fails closed when the manifest and the classifier disagree about eligibility', () => {
    // The two are computed independently — the manifest from topic-term overlap, the classifier
    // from its own echo of that flag — so a disagreement means one of them read a different
    // manifest. Reconciling it silently would let the denominator come from the wrong input.
    expect(() => frozenEligibleSet([mProbe('m_a')], [cVerdict('m_a', { hit1Eligible: false })]))
      .toThrow(/eligibility-disagreement/);
  });

  it('fails closed when the probe id sets are not equal', () => {
    expect(() => frozenEligibleSet([mProbe('m_a'), mProbe('m_b')], [cVerdict('m_a')]))
      .toThrow(/probe-set-mismatch/);
    expect(() => frozenEligibleSet([mProbe('m_a')], [cVerdict('m_a'), cVerdict('m_b')]))
      .toThrow(/probe-set-mismatch/);
  });

  it('fails closed on a duplicate probe id within either input', () => {
    expect(() => frozenEligibleSet([mProbe('m_a'), mProbe('m_a')], [cVerdict('m_a'), cVerdict('m_a')]))
      .toThrow(/duplicate-probe-id/);
  });

  it('fails closed on any classifier error status, eligible or not', () => {
    // §5a widens errors/unscorable to the whole pipeline: an unscorable probe is a gate failure,
    // never a row quietly dropped from the denominator. Ineligible probes are checked too — they
    // still count toward Recall@20, so an error there is just as disqualifying.
    expect(() => frozenEligibleSet([mProbe('m_a')],
      [cVerdict('m_a', { status: 'unscorable', reason: 'target-not-servable' })])).toThrow(/unscorable/);
    expect(() => frozenEligibleSet([mProbe('m_a', false)],
      [cVerdict('m_a', { status: 'unscorable', reason: 'duplicate-target-identity', hit1Eligible: false })]))
      .toThrow(/unscorable/);
  });

  it('fails closed on a target-zero-evidence verdict', () => {
    // Not an error status in the classifier's own vocabulary, but it means the target carries no
    // lexical evidence at all — the probe cannot discriminate, so scoring it proves nothing.
    expect(() => frozenEligibleSet([mProbe('m_a')], [cVerdict('m_a', { status: 'target-zero-evidence' })]))
      .toThrow(/target-zero-evidence/);
  });

  it('accepts only the two statuses that mean the probe classified successfully', () => {
    // One rule rather than a list of rejected statuses: anything the classifier could grow later
    // is refused by default instead of being silently admitted to the denominator.
    expect(frozenEligibleSet([mProbe('m_a')], [cVerdict('m_a', { status: 'in-class' })]).exposure).toBe(1);
    expect(frozenEligibleSet([mProbe('m_a')], [cVerdict('m_a', { status: 'not-in-class' })]).exposure).toBe(1);
    expect(() => frozenEligibleSet([mProbe('m_a')], [cVerdict('m_a', { status: 'something-new' })]))
      .toThrow(/something-new/);
  });

  it('fails closed on a verdict with no resolved target scope', () => {
    // An identity is the PAIR (scope, record-id). Formatting an absent scope would yield a
    // well-formed string like `undefined:m_a` that dedups and sorts like any other identity.
    expect(() => frozenEligibleSet([mProbe('m_a')], [{ id: 'L_m_a', status: 'not-in-class', targetId: 'm_a', hit1Eligible: true }]))
      .toThrow(/target-scope/);
  });
});

describe('O_67-class census — reporting only, never blocking', () => {
  const witnessed = (target: string) => cVerdict(target, {
    status: 'in-class', witnesses: [{ id: 'project:c1', extraTerms: ['add'] }],
  });

  it('counts the full single-target census, the distinct in-class identities, and the split', () => {
    // §3e is deliberately threshold-free: no E denominator, no PARTIALLY EXERCISED state, because
    // both are defined only relative to a blocking minimum and D-a removed that minimum.
    const c = o67Census(
      [mProbe('m_a'), mProbe('m_b'), mProbe('m_c', false)],
      [witnessed('m_a'), cVerdict('m_b'), cVerdict('m_c', { hit1Eligible: false })],
    );
    expect(c.census).toBe(3);
    expect(c.distinctInClassIdentities).toBe(1);
    expect(c.eligibleInClass).toBe(1);
    expect(c.cases).toEqual([{ probeId: 'L_m_a', identity: 'project:m_a', hit1Eligible: true,
      witnesses: [{ id: 'project:c1', extraTerms: ['add'] }] }]);
  });

  it('reports an in-class member that is NOT Hit@1 eligible in the split, not by dropping it', () => {
    const c = o67Census([mProbe('m_a', false)], [witnessed('m_a')].map((v) => ({ ...v, hit1Eligible: false })));
    expect(c.distinctInClassIdentities).toBe(1);
    expect(c.eligibleInClass).toBe(0);
  });

  it('labels the class without a threshold, and says non-blocking in the label itself', () => {
    // The label carries the consequence because the label is what a reader sees. D-a made this
    // reporting-only, and §3e requires the honest unexercised report either way.
    expect(o67Census([mProbe('m_a')], [cVerdict('m_a')]).label)
      .toBe('UNEXERCISED — 0 distinct cases observed (reporting only, non-blocking)');
    expect(o67Census([mProbe('m_a')], [witnessed('m_a')]).label)
      .toBe('EXERCISED — 1 distinct cases observed (reporting only, non-blocking)');
  });

  it('does not participate in the close rule — an empty class is a complete census', () => {
    // §3e: were the class to gate window closure, a window with zero in-class cases could never
    // close, reintroducing the starvation D-a removed. Zero cases must therefore be a normal,
    // fully-formed result rather than anything that can refuse to produce one.
    const c = o67Census([mProbe('m_a')], [cVerdict('m_a')]);
    expect(c.census).toBe(1);
    expect(c.cases).toEqual([]);
    expect(c.blocking).toBe(false);
  });
});

describe('stale-served-as-live exposure — closer relationships in the as-of-close snapshot', () => {
  const row = (id: string, over: Partial<LedgerRow> = {}): LedgerRow =>
    ({ id, tx: '2026-08-01T00:00:00.000Z', type: 'assert', content: `content ${id}`, supersedes: null, ...over });
  const scoped = (project: LedgerRow[], global: LedgerRow[] = []): ScopedLedger[] =>
    [{ scope: 'global', rows: global }, { scope: 'project', rows: project }];

  it('counts closer RELATIONSHIPS, not closed records that happen to be returned', () => {
    // The rubric and the exposure definition are different things, and an earlier draft of the
    // design named two different denominators in one breath. Exposure is a property of the
    // corpus; violations are sought later, in the top-K, by the score phase.
    const es = staleExposure(scoped([
      row('m_a'), row('m_b', { type: 'supersede', supersedes: 'm_a' }),
      row('m_c', { type: 'invalidate', supersedes: 'm_b' }),
    ]));
    expect(es.closerRelationships).toBe(2);
  });

  it('counts erase alongside supersede and invalidate', () => {
    expect(staleExposure(scoped([row('m_a'), row('m_x', { type: 'erase', supersedes: 'm_a' })]))
      .closerRelationships).toBe(1);
  });

  it('labels zero exposure as UNEXPOSED and non-blocking; any exposure makes it binding', () => {
    // §5a: Es = 0 reports honestly and does not convert an absence of churn into a release
    // failure — the expected state, since the corpus holds zero closer rows across its history.
    const none = staleExposure(scoped([row('m_a')]));
    expect(none.closerRelationships).toBe(0);
    expect(none.label).toBe('UNEXPOSED — no temporal evidence');
    expect(none.blocking).toBe(false);
    const some = staleExposure(scoped([row('m_a'), row('m_b', { type: 'supersede', supersedes: 'm_a' })]));
    expect(some.label).toBe('EXPOSED — 1 closer relationship');
    expect(staleExposure(scoped([row('m_a'), row('m_b', { type: 'supersede', supersedes: 'm_a' }),
      row('m_c', { type: 'invalidate', supersedes: 'm_b' })])).label).toBe('EXPOSED — 2 closer relationships');
    expect(some.blocking).toBe(true);
  });

  it('fails closed on a closer whose referent is absent from its own scope', () => {
    // A closer that resolves nowhere means the ledger is not self-consistent, so Es cannot be
    // computed as "valid" relationships at all. Counting it would overstate exposure; skipping it
    // would understate it — neither is a number worth reporting.
    expect(() => staleExposure(scoped([row('m_b', { type: 'supersede', supersedes: 'm_gone' })])))
      .toThrow(/dangling-closer/);
  });

  it('refuses a closer that reaches across scopes', () => {
    // Each scope is its own ledger file and a closer never reaches across them — the same rule
    // liveness resolution follows. Resolving cross-scope would invent a relationship the live
    // projection does not have.
    expect(() => staleExposure(scoped([row('m_b', { type: 'supersede', supersedes: 'm_g' })], [row('m_g')])))
      .toThrow(/dangling-closer/);
  });
});

describe('prepared gate-set artifact', () => {
  const H = { manifest: 'a'.repeat(64), classifier: 'b'.repeat(64), universe: 'c'.repeat(64) };
  const base = () => ({
    manifest: { k: 20, txAfter: '2026-07-21T00:00:00.000Z', txClose: '2026-08-18T00:00:00.000Z',
      probes: [mProbe('m_a'), mProbe('m_b')] },
    classifier: { rule: 'o67-class-rule-2026-07', manifest: 'holdout.json', summary: {},
      probes: [cVerdict('m_a'), cVerdict('m_b')] },
    universe: {
      rule: 'o67-class-rule-2026-07', artifact: 'candidate-universe', manifest: 'holdout.json', recallBound: 26,
      disclosure: { rowsByScope: { global: 1, project: 25 }, projectDisposition: 'owned',
        integrityAvailable: true, witnessNotes: [], expansionAvailable: true },
      probes: [{ id: 'L_m_a', candidates: ['project:m_a'] }, { id: 'L_m_b', candidates: ['project:m_b'] }],
    },
    ledgers: [{ scope: 'global' as const, rows: [] }, { scope: 'project' as const, rows: [] }],
    pins: { k: 20, txAfter: '2026-07-21T00:00:00.000Z', txClose: '2026-08-18T00:00:00.000Z', inputs: { ...H } },
    inputHashes: { ...H },
    now: () => '2026-08-18T09:00:00.000Z',
  });

  it('freezes the denominator and the census, and hashes the deterministic payload', () => {
    const g = prepareGateSet(base());
    expect(g.artifact).toBe('gate-set');
    expect(g.payload.eligible.probeIds).toEqual(['L_m_a', 'L_m_b']);
    expect(g.payload.eligible.label).toBe('EXERCISED — 2/2');
    expect(g.payload.recallDenominator).toEqual(['L_m_a', 'L_m_b']);
    expect(g.payload.o67.label).toBe('UNEXERCISED — 0 distinct cases observed (reporting only, non-blocking)');
    expect(g.payload.stale.label).toBe('UNEXPOSED — no temporal evidence');
    expect(g.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps volatile receipts OUT of the hash stability compares', () => {
    // §5a reconciles stability with the integrity condition by splitting every artifact: real
    // timestamps and run ids differ on every run by construction, so demanding byte identity of
    // the whole file would contradict the requirement to retain them. Payload hashes are compared;
    // receipts are retained and hashed into the provenance chain instead.
    const a = prepareGateSet(base());
    const b = prepareGateSet({ ...base(), now: () => '2026-08-18T17:45:12.003Z' });
    expect(b.receipts.preparedAt).not.toBe(a.receipts.preparedAt);
    expect(b.payloadSha256).toBe(a.payloadSha256);
  });

  it('refuses a manifest whose K, cutoff or close disagrees with the pins', () => {
    // The pins come from the freeze receipt and the manifest from the window. A disagreement means
    // the run is being scored against a method other than the one that was frozen.
    const at = (over: Record<string, unknown>) => () => prepareGateSet({
      ...base(), manifest: { ...base().manifest, ...over } });
    expect(at({ k: 10 })).toThrow(/pin-mismatch/);
    expect(at({ txAfter: '2026-07-22T00:00:00.000Z' })).toThrow(/pin-mismatch/);
    expect(at({ txClose: '2026-08-19T00:00:00.000Z' })).toThrow(/pin-mismatch/);
  });

  it('refuses an input whose bytes do not hash to the pinned value', () => {
    expect(() => prepareGateSet({ ...base(), inputHashes: { ...H, classifier: 'd'.repeat(64) } }))
      .toThrow(/input-hash-mismatch/);
  });

  it('refuses when the pinned input set and the supplied input set differ', () => {
    // Comparing only the hashes of shared keys would let an unpinned input in silently, and let a
    // pinned one go unsupplied without anyone noticing.
    expect(() => prepareGateSet({ ...base(), inputHashes: { manifest: H.manifest, classifier: H.classifier } }))
      .toThrow(/input-set-mismatch/);
    expect(() => prepareGateSet({ ...base(), inputHashes: { ...H, extra: 'e'.repeat(64) } }))
      .toThrow(/input-set-mismatch/);
  });

  it('refuses a universe artifact that does not cover exactly the manifest probes', () => {
    // The universe is what §6 hashes before scoring as the record of what COULD have been
    // returned. If it does not cover the same probes, it is not the universe this run competed in.
    const b = base();
    expect(() => prepareGateSet({ ...b, universe: { ...b.universe, probes: [b.universe.probes[0]!] } }))
      .toThrow(/universe-probe-mismatch/);
  });

  it('refuses a degraded run: unavailable integrity or expansion, or a scope that never served', () => {
    // Each of these produces a well-formed, correctly-hashed artifact that is indistinguishable
    // afterwards from a healthy small run, which is exactly why they must be refused up front.
    const d = (over: Record<string, unknown>) => () => {
      const b = base();
      return prepareGateSet({ ...b, universe: { ...b.universe, disclosure: { ...b.universe.disclosure, ...over } } });
    };
    expect(d({ integrityAvailable: false })).toThrow(/degraded-run/);
    expect(d({ expansionAvailable: false })).toThrow(/degraded-run/);
    expect(d({ projectDisposition: 'unadopted-present' })).toThrow(/degraded-run/);
  });

  it('records witness notes as disclosure, not as errors', () => {
    // Measured against the real frozen snapshot, whose universe artifact carries a benign
    // trust-on-first-use note. A rule that failed on any note would refuse the actual corpus.
    const b = base();
    const note = '(rollback witness: scope not yet witnessed; the current head will be adopted trust-on-first-use at the next write)';
    const g = prepareGateSet({ ...b, universe: { ...b.universe,
      disclosure: { ...b.universe.disclosure, witnessNotes: [note] } } });
    expect(g.payload.disclosure.witnessNotes).toEqual([note]);
  });

  it('carries every pinned input hash into the payload, so the chain binds its parents', () => {
    expect(prepareGateSet(base()).payload.inputs).toEqual(H);
  });
});
