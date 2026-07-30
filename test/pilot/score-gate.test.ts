import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { scoreGate, type RunResult, type Adjudication } from '../../scripts/pilot/score-gate.js';
import { prepareGateSet, type ManifestProbe, type ClassifierVerdict } from '../../scripts/pilot/prepare-gate.js';

/** C5.1 closure item 3, score phase — the half that READS OUTCOMES.
 *
 *  Its defining constraint is the mirror of the prepare phase's: it may look at every rank, but it
 *  may never alter what was frozen. So the gate set arrives already hashed, and the tests below
 *  are about two things — that the seven §5a conditions are computed from the frozen denominator,
 *  and that the phase refuses to run at all when the artifact it was handed is not the one the
 *  freeze pinned. */

const H = { manifest: 'a'.repeat(64), classifier: 'b'.repeat(64), universe: 'c'.repeat(64) };
const TX_AFTER = '2026-07-21T00:00:00.000Z';
const TX_CLOSE = '2026-08-18T00:00:00.000Z';

const mProbe = (t: string, unambiguous = true): ManifestProbe =>
  ({ id: `L_${t}`, query: `query ${t}`, relevant: [t], unambiguous, side: 'ledger' });
const cVerdict = (t: string, over: Partial<ClassifierVerdict> = {}): ClassifierVerdict =>
  ({ id: `L_${t}`, status: 'not-in-class', targetId: t, targetScope: 'project', hit1Eligible: true, ...over });

/** A prepared gate set over `targets`, with `ambiguous` flagged ineligible and `inClass` witnessed. */
const gateSetFor = (targets: string[], opts: { ambiguous?: string[]; inClass?: string[] } = {}) => {
  const amb = new Set(opts.ambiguous ?? []);
  const cls = new Set(opts.inClass ?? []);
  const probes = targets.map((t) => mProbe(t, !amb.has(t)));
  const verdicts = targets.map((t) => cVerdict(t, {
    hit1Eligible: !amb.has(t),
    ...(cls.has(t) ? { status: 'in-class', witnesses: [{ id: 'project:c1', extraTerms: ['add'] }] } : {}),
  }));
  return prepareGateSet({
    manifest: { k: 20, txAfter: TX_AFTER, txClose: TX_CLOSE, probes },
    classifier: { rule: 'o67-class-rule-2026-07', manifest: 'holdout.json', probes: verdicts },
    universe: {
      rule: 'o67-class-rule-2026-07', artifact: 'candidate-universe', manifest: 'holdout.json', recallBound: 20,
      disclosure: { rowsByScope: { global: 0, project: targets.length }, projectDisposition: 'owned',
        integrityAvailable: true, witnessNotes: [], expansionAvailable: true },
      probes: probes.map((p) => ({ id: p.id, candidates: [] })),
    },
    ledgers: [{ scope: 'global', rows: [] }, { scope: 'project', rows: [] }],
    pins: { k: 20, txAfter: TX_AFTER, txClose: TX_CLOSE, inputs: { ...H } },
    inputHashes: { ...H },
    now: () => '2026-08-18T09:00:00.000Z',
  });
};

/** One runner output as its raw text, which is what stability compares. */
const runText = (ranks: Record<string, number | null>): string => {
  const results: RunResult[] = Object.entries(ranks).map(([t, bestRank]) => ({
    id: `L_${t}`, query: `query ${t}`, unambiguous: true, bestRank,
    hitAtK: bestRank !== null && bestRank <= 20, hitAt1: bestRank === 1, returned: [],
  }));
  return JSON.stringify({ k: 20, results }, null, 1) + '\n';
};

const cleanAdjudication = (gateSetSha256: string, runSha256: string, probeIds: string[]): Adjudication => ({
  artifact: 'adjudication', gateSetSha256, runSha256,
  contradictions: probeIds.map((id) => ({ probeId: id, verdict: 'none' as const })),
  staleViolations: [],
});

const score = (g: ReturnType<typeof gateSetFor>, ranks: Record<string, number | null>,
  over: { runs?: string[]; adjudication?: (a: Adjudication) => Adjudication } = {}) => {
  const runs = over.runs ?? [runText(ranks), runText(ranks), runText(ranks)];
  const runSha = createHash('sha256').update(runs[0]!, 'utf8').digest('hex');
  const adj = cleanAdjudication(g.payloadSha256, runSha, g.payload.recallDenominator);
  return scoreGate({
    gateSet: g, expectPayloadSha256: g.payloadSha256, runs,
    adjudication: over.adjudication ? over.adjudication(adj) : adj,
    now: () => '2026-08-18T10:00:00.000Z',
  });
};

describe('Hit@1 over the frozen denominator', () => {
  it('passes only when the minimum is met AND every eligible row ranks 1', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    const s = score(g, { m_a: 1, m_b: 1 });
    expect(s.payload.hit1.x).toBe(2);
    expect(s.payload.hit1.n).toBe(2);
    expect(s.payload.hit1.pass).toBe(true);
    expect(s.payload.hit1.bound).toBeCloseTo(0.2236, 4);
    expect(s.payload.release.blocked).toBe(false);
  });

  it('fails on a single eligible row that does not rank 1, and reports the realized x/n', () => {
    const s = score(gateSetFor(['m_a', 'm_b']), { m_a: 1, m_b: 3 });
    expect(s.payload.hit1).toMatchObject({ x: 1, n: 2, pass: false });
    expect(s.payload.hit1.bound).toBeCloseTo(0.0253, 4);
    expect(s.payload.release.blocked).toBe(true);
    expect(s.payload.release.reasons.join(' ')).toMatch(/Hit@1/);
  });

  it('blocks a starved window on the minimum, not on the score', () => {
    // §3b: a one-case window would let a single event decide the verdict, so it blocks even when
    // that one case succeeded. The label must say the minimum was missed, not that the test failed.
    const s = score(gateSetFor(['m_a']), { m_a: 1 });
    expect(s.payload.hit1).toMatchObject({ x: 1, n: 1, pass: false });
    expect(s.payload.hit1.label).toBe('PARTIALLY EXERCISED — 1/2 (minimum not met)');
    expect(s.payload.release.reasons.join(' ')).toMatch(/minimum/);
  });

  it('reports N/A rather than a bound when the window accrued nothing', () => {
    const s = score(gateSetFor(['m_a'], { ambiguous: ['m_a'] }), { m_a: 1 });
    expect(s.payload.hit1).toMatchObject({ x: 0, n: 0, pass: false, bound: null });
    expect(s.payload.hit1.label).toBe('UNEXERCISED — 0/2');
  });

  it('scores the denominator the PREPARE phase froze, never one derived from the results', () => {
    // The runner's own `unambiguous` echo is deliberately ignored: it is outcome-side data, and
    // deriving the denominator from it would let the scored population depend on the run.
    const g = gateSetFor(['m_a', 'm_b', 'm_c'], { ambiguous: ['m_c'] });
    const runs = [1, 2, 3].map(() => JSON.stringify({ k: 20, results: [
      { id: 'L_m_a', query: 'q', unambiguous: true, bestRank: 1, hitAtK: true, hitAt1: true, returned: [] },
      { id: 'L_m_b', query: 'q', unambiguous: true, bestRank: 1, hitAtK: true, hitAt1: true, returned: [] },
      // m_c claims eligibility the manifest did not grant; a 4th-rank row would fail Hit@1 if believed.
      { id: 'L_m_c', query: 'q', unambiguous: true, bestRank: 4, hitAtK: true, hitAt1: false, returned: [] },
    ] }, null, 1) + '\n');
    const s = score(g, {}, { runs });
    expect(s.payload.hit1).toMatchObject({ x: 2, n: 2, pass: true });
  });
});

describe('the other §5a conditions', () => {
  it('Recall@20 spans every probe, in-class ones included, and is binding', () => {
    // §2: in-class membership grants no Recall exemption. The condition is a regression tripwire
    // rather than evidence — its threshold is enormously slack — but it still blocks.
    const g = gateSetFor(['m_a', 'm_b'], { inClass: ['m_a'] });
    expect(score(g, { m_a: 3, m_b: 1 }).payload.recall).toMatchObject({ x: 2, n: 2, pass: true });
    const miss = score(g, { m_a: null, m_b: 1 });
    expect(miss.payload.recall).toMatchObject({ x: 1, n: 2, pass: false });
    expect(miss.payload.release.blocked).toBe(true);
  });

  it('reports O_67 cases with their ranks and hits, without letting them block', () => {
    // D-a made the class reporting-only, and D-b keeps its members in the binding denominators —
    // so a rank-3 in-class case is visible here AND counted in Hit@1 above. It is never hidden.
    const g = gateSetFor(['m_a', 'm_b'], { inClass: ['m_a'] });
    const s = score(g, { m_a: 3, m_b: 1 });
    expect(s.payload.o67.cases).toEqual([{ probeId: 'L_m_a', identity: 'project:m_a', hit1Eligible: true,
      witnesses: [{ id: 'project:c1', extraTerms: ['add'] }], bestRank: 3, hitAt1: false, hitAtK: true }]);
    expect(s.payload.o67.blocking).toBe(false);
    expect(s.payload.release.reasons.join(' ')).not.toMatch(/O_67/);
  });

  it('stale is UNEXPOSED and non-blocking when the corpus holds no closer relationships', () => {
    const s = score(gateSetFor(['m_a', 'm_b']), { m_a: 1, m_b: 1 });
    expect(s.payload.stale).toMatchObject({ label: 'UNEXPOSED — no temporal evidence', pass: true, blocking: false });
  });

  it('stability compares the runner payloads and blocks when they differ', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    const same = runText({ m_a: 1, m_b: 1 });
    expect(score(g, {}, { runs: [same, same, same] }).payload.stability.pass).toBe(true);
    const drifted = score(g, {}, { runs: [same, same, runText({ m_a: 1, m_b: 2 })] });
    expect(drifted.payload.stability.pass).toBe(false);
    expect(drifted.payload.release.blocked).toBe(true);
  });

  it('a contradiction call blocks, and its quoted texts are carried into the report', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    const s = score(g, { m_a: 1, m_b: 1 }, { adjudication: (a) => ({ ...a,
      contradictions: [
        { probeId: 'L_m_a', verdict: 'contradiction', returnedId: 'project:m_x',
          targetText: 'the timeout is sixty seconds', returnedText: 'the timeout is not sixty seconds' },
        { probeId: 'L_m_b', verdict: 'none' },
      ] }) });
    expect(s.payload.contradictions.pass).toBe(false);
    expect(s.payload.contradictions.calls[0]).toMatchObject({ probeId: 'L_m_a', returnedId: 'project:m_x' });
    expect(s.payload.release.blocked).toBe(true);
  });
});

describe('refusals — the score phase will not run on the wrong artifact', () => {
  it('refuses a gate set whose payload does not hash to its own recorded value', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    const tampered = { ...g, payload: { ...g.payload,
      eligible: { ...g.payload.eligible, probeIds: ['L_m_a'], identities: ['project:m_a'], exposure: 1 } } };
    expect(() => score(tampered, { m_a: 1, m_b: 1 })).toThrow(/gate-set-tampered/);
  });

  it('refuses a gate set that is self-consistent but not the one the freeze pinned', () => {
    // Recomputing the hash catches an edited payload; only the pin catches a WHOLLY RE-PREPARED
    // one. Without it, an operator who saw the results could prepare a smaller denominator and
    // hand over a perfectly self-consistent artifact.
    const g = gateSetFor(['m_a', 'm_b']);
    expect(() => scoreGate({ gateSet: g, expectPayloadSha256: 'f'.repeat(64),
      runs: [runText({ m_a: 1, m_b: 1 })], adjudication: cleanAdjudication(g.payloadSha256, 'x', []),
      now: () => '2026-08-18T10:00:00.000Z' })).toThrow(/gate-set-not-pinned/);
  });

  it('refuses an adjudication that does not bind this gate set and this run', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { adjudication: (a) => ({ ...a, gateSetSha256: 'd'.repeat(64) }) }))
      .toThrow(/adjudication-unbound/);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { adjudication: (a) => ({ ...a, runSha256: 'e'.repeat(64) }) }))
      .toThrow(/adjudication-unbound/);
  });

  it('refuses an incomplete, duplicated or uncertain adjudication', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { adjudication: (a) => ({ ...a, contradictions: [a.contradictions[0]!] }) }))
      .toThrow(/adjudication-incomplete/);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { adjudication: (a) => ({ ...a,
      contradictions: [a.contradictions[0]!, a.contradictions[0]!] }) })).toThrow(/adjudication-duplicate/);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { adjudication: (a) => ({ ...a,
      contradictions: [{ probeId: 'L_m_a', verdict: 'uncertain' as never }, a.contradictions[1]!] }) }))
      .toThrow(/adjudication-uncertain/);
  });

  it('refuses a run whose probe set is not the frozen one', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    const short = runText({ m_a: 1 });
    expect(() => score(g, {}, { runs: [short, short, short] })).toThrow(/run-probe-mismatch/);
  });

  it('requires three runs, because stability is a condition and not an option', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    const one = runText({ m_a: 1, m_b: 1 });
    expect(() => score(g, {}, { runs: [one, one] })).toThrow(/stability-needs-three-runs/);
  });
});
