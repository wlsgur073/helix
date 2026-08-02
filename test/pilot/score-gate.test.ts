import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { scoreGate, type RunResult, type Adjudication } from '../../scripts/pilot/score-gate.js';
import { prepareGateSet, type ManifestProbe, type ClassifierVerdict } from '../../scripts/pilot/prepare-gate.js';
import { RULE } from '../../scripts/pilot/gate-set.js';

/** C5.1 closure item 3, score phase — the half that READS OUTCOMES.
 *
 *  Its defining constraint is the mirror of the prepare phase's: it may look at every rank, but it
 *  may never alter what was frozen. So the gate set arrives already hashed, and the tests below
 *  are about two things — that the seven §5a conditions are computed from the frozen denominator,
 *  and that the phase refuses to run at all when the artifact it was handed is not the one the
 *  freeze pinned. */

// The ledger, trust and expansion pins are part of H because the scorer cross-checks every run's
// recorded corpus and runtime-surface hashes against the gate set's own pins — placeholders on
// both sides agree the way real hashes on both sides do. Two trust entries are the LITERAL
// 'absent' sentinel on purpose: absence is itself a pinned state, and the sentinel travels through
// the same string comparison a hash does.
const H = { manifest: 'a'.repeat(64), classifier: 'b'.repeat(64), universe: 'c'.repeat(64),
  'ledger:global': 'd'.repeat(64), 'ledger:project': 'e'.repeat(64),
  'ownership:registry': '1'.repeat(64), 'ownership:owner': '2'.repeat(64),
  'trust:master-key': 'absent', 'trust:witness': 'absent',
  'expansion:semantic-neighbors': '3'.repeat(64) };
const TRUST_NAMES = ['ownership:registry', 'ownership:owner', 'trust:master-key', 'trust:witness'] as const;
const TX_AFTER = '2026-07-21T00:00:00.000Z';
const TX_CLOSE = '2026-08-18T00:00:00.000Z';

const mProbe = (t: string, unambiguous = true): ManifestProbe =>
  ({ id: `L_${t}`, query: `query ${t}`, relevant: [t], unambiguous, side: 'ledger' });
const cVerdict = (t: string, over: Partial<ClassifierVerdict> = {}): ClassifierVerdict =>
  ({ id: `L_${t}`, status: 'not-in-class', targetId: t, targetScope: 'project', hit1Eligible: true, ...over });

/** A prepared gate set over `targets`, with `ambiguous` flagged ineligible and `inClass` witnessed.
 *  `k` is a parameter because §10 freezes it as a method identity, so the score phase has to be
 *  exercised against a gate set whose K is NOT the ambient 20. */
const gateSetFor = (targets: string[],
  opts: { ambiguous?: string[]; inClass?: string[]; k?: number } = {}) => {
  const amb = new Set(opts.ambiguous ?? []);
  const cls = new Set(opts.inClass ?? []);
  const k = opts.k ?? 20;
  const probes = targets.map((t) => mProbe(t, !amb.has(t)));
  const verdicts = targets.map((t) => cVerdict(t, {
    hit1Eligible: !amb.has(t),
    ...(cls.has(t) ? { status: 'in-class', witnesses: [{ id: 'project:c1', extraTerms: ['add'] }] } : {}),
  }));
  return prepareGateSet({
    manifest: { k, txAfter: TX_AFTER, txClose: TX_CLOSE, probes },
    classifier: { rule: 'o67-class-rule-2026-07', manifest: 'holdout.json', probes: verdicts },
    universe: {
      rule: 'o67-class-rule-2026-07', artifact: 'candidate-universe', manifest: 'holdout.json', recallBound: k,
      disclosure: { rowsByScope: { global: 0, project: targets.length }, projectDisposition: 'owned',
        integrityAvailable: true, witnessNotes: [], expansionAvailable: true },
      probes: probes.map((p) => ({ id: p.id, candidates: [] })),
    },
    ledgers: [{ scope: 'global', rows: [] }, { scope: 'project', rows: [] }],
    pins: { k, txAfter: TX_AFTER, txClose: TX_CLOSE, inputs: { ...H } },
    inputHashes: { ...H },
    now: () => '2026-08-18T09:00:00.000Z',
  });
};

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** One runner output as its raw text, in the shape `run-pilot.ts` actually writes: a deterministic
 *  payload naming the prepared gate set AND the manifest it asked, plus receipts that differ on
 *  every execution. The receipts are what make the FILE different each time and the payload the
 *  same — the split §4 requires and the only reason the stability condition is satisfiable by an
 *  honest run at all. `over` lets a test break exactly one of the frozen identities. */
interface RunOver { k?: number; rule?: string; manifestSha256?: string;
  ledgers?: Record<string, string>; trust?: Record<string, string>; projectDisposition?: string;
  expansionSha256?: unknown; receipts?: unknown }

const runArtifact = (results: RunResult[], prepareSha256: string, runId: string, over: RunOver = {}): string => {
  const payload = { rule: over.rule ?? RULE, k: over.k ?? 20, prepareSha256,
    manifestSha256: over.manifestSha256 ?? H.manifest,
    // What the runner verified before ranking, in the shape it records: the corpus and trust-file
    // hashes it checked against the gate set's pins, the disposition the ownership surface
    // resolved to, and the CONTENT hash of the expansion table it ranked with. Defaults match
    // `gateSetFor`'s pins and disclosure, so every fixture below is an honest run unless a test
    // deliberately breaks one of them.
    ledgers: over.ledgers ?? { 'ledger:global': H['ledger:global'], 'ledger:project': H['ledger:project'] },
    trust: over.trust ?? Object.fromEntries(TRUST_NAMES.map((n) => [n, H[n]])),
    projectDisposition: 'projectDisposition' in over ? over.projectDisposition : 'owned',
    expansionSha256: 'expansionSha256' in over ? over.expansionSha256 : H['expansion:semantic-neighbors'],
    results };
  return JSON.stringify({
    artifact: 'run', payloadSha256: sha256(JSON.stringify(payload)), payload,
    receipts: 'receipts' in over ? over.receipts
      : { runId, startedAt: `2026-08-18T09:0${runId.slice(-1)}:00.000Z`,
        finishedAt: `2026-08-18T09:0${runId.slice(-1)}:30.000Z`, attestation: 'self-reported wall clocks' },
  }, null, 1) + '\n';
};

const runText = (ranks: Record<string, number | null>, prepareSha256: string, runId = 'r0',
  over: RunOver = {}): string =>
  runArtifact(Object.entries(ranks).map(([t, bestRank]) => ({
    id: `L_${t}`, query: `query ${t}`, unambiguous: true, bestRank,
    hitAtK: bestRank !== null && bestRank <= (over.k ?? 20), hitAt1: bestRank === 1,
    // A returned list the declared rank is POSSIBLE against — the scorer refuses a result whose
    // bestRank exceeds what was returned (`run-inconsistent`), so an honest fixture carries one.
    returned: bestRank === null ? []
      : [...Array.from({ length: bestRank - 1 }, (_, i) => `decoy_${i}`), t],
  })), prepareSha256, runId, over);

/** Three honest runs of the same frozen method: three DISTINCT run ids, one payload. */
const threeRuns = (ranks: Record<string, number | null>, prepareSha256: string, over: RunOver = {}) =>
  ['r1', 'r2', 'r3'].map((id) => runText(ranks, prepareSha256, id, over));

/** What an adjudicator binds: the hash of the payload it read, RECOMPUTED — never the value the
 *  file records about itself, which is exactly the field a tampered run leaves stale. */
const payloadShaOf = (text: string) => sha256(JSON.stringify((JSON.parse(text) as { payload: unknown }).payload));

const cleanAdjudication = (gateSetSha256: string, runPayloadSha256: string, probeIds: string[]): Adjudication => ({
  artifact: 'adjudication', gateSetSha256, runPayloadSha256,
  contradictions: probeIds.map((id) => ({ probeId: id, verdict: 'none' as const })),
  staleViolations: [],
});

type ScoreOver = { runs?: string[]; adjudication?: (a: Adjudication) => Adjudication; over?: RunOver };

/** The exact inputs `score` hands to the phase. Exposed separately because two tests have to hash
 *  the very adjudication object that was scored, and reconstructing it would prove nothing. */
const inputsFor = (g: ReturnType<typeof gateSetFor>, ranks: Record<string, number | null>,
  o: ScoreOver = {}) => {
  // Three DISTINCT run ids by default, so every test below scores the honest case: three files that
  // differ byte for byte and agree payload for payload.
  const runs = o.runs ?? threeRuns(ranks, g.payloadSha256, o.over);
  const base = cleanAdjudication(g.payloadSha256, payloadShaOf(runs[0]!), g.payload.recallDenominator);
  return { runs, adjudication: o.adjudication ? o.adjudication(base) : base };
};

const score = (g: ReturnType<typeof gateSetFor>, ranks: Record<string, number | null>,
  o: ScoreOver & { expect?: string } = {}) => {
  const { runs, adjudication } = inputsFor(g, ranks, o);
  return scoreGate({ gateSet: g, expectPayloadSha256: o.expect ?? g.payloadSha256, runs, adjudication,
    now: () => '2026-08-18T10:00:00.000Z' });
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
    const runs = ['r1', 'r2', 'r3'].map((id) => runArtifact([
      { id: 'L_m_a', query: 'q', unambiguous: true, bestRank: 1, hitAtK: true, hitAt1: true, returned: ['m_a'] },
      { id: 'L_m_b', query: 'q', unambiguous: true, bestRank: 1, hitAtK: true, hitAt1: true, returned: ['m_b'] },
      // m_c claims eligibility the manifest did not grant; a 4th-rank row would fail Hit@1 if believed.
      { id: 'L_m_c', query: 'q', unambiguous: true, bestRank: 4, hitAtK: true, hitAt1: false,
        returned: ['x_1', 'x_2', 'x_3', 'm_c'] },
    ], g.payloadSha256, id));
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
    // The PASS case is three runs differing only in their receipts. It is deliberately no longer
    // `[same, same, same]`: one run copied three times is not three executions, and §4 says "run the
    // runner three times". That shape is now refused outright — see the distinct-run-id test below.
    const g = gateSetFor(['m_a', 'm_b']);
    expect(score(g, { m_a: 1, m_b: 1 }).payload.stability.pass).toBe(true);
    const drifted = score(g, {}, { runs: [
      runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r1'),
      runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r2'),
      runText({ m_a: 1, m_b: 2 }, g.payloadSha256, 'r3')] });
    expect(drifted.payload.stability.pass).toBe(false);
    expect(drifted.payload.release.blocked).toBe(true);
  });

  it('stability PASSES across three runs whose FILES differ and whose payloads do not', () => {
    // The honest case, and the one the old whole-file comparison could not express: §9 requires each
    // run to carry its own run id and real wall clocks, so three genuine re-runs are never byte
    // identical. Comparing files would have failed Stability on every correct execution.
    const g = gateSetFor(['m_a', 'm_b']);
    const runs = ['r1', 'r2', 'r3'].map((id) => runText({ m_a: 1, m_b: 1 }, g.payloadSha256, id));
    expect(new Set(runs).size).toBe(3);
    const s = score(g, {}, { runs });
    expect(s.payload.stability.pass).toBe(true);
    expect(new Set(s.payload.stability.runPayloadSha256).size).toBe(1);
    expect(s.payload.release.blocked).toBe(false);
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

describe('the score artifact and what it binds', () => {
  it('carries its own payload hash, because the release record has to bind something', () => {
    // Evidence-chain element 8 binds the score hash. Nothing produced one before, so the last link
    // of §9's chain had no value to attach to.
    const g = gateSetFor(['m_a', 'm_b']);
    const s = score(g, { m_a: 1, m_b: 1 });
    expect(s.payloadSha256).toBe(sha256(JSON.stringify(s.payload)));
  });

  it('binds the prepare, runner and adjudication hashes INSIDE the hashed payload', () => {
    // §9 item 7: "a score artifact binding the prepare, runner and adjudication hashes". A value in
    // the ENVELOPE is bound by nothing — `payloadSha256` covers the payload, so an envelope copy can
    // be rewritten and the artifact still verifies. All three therefore live in the payload: the
    // prepare hash as `gateSetSha256`, the runner hashes as `stability.runPayloadSha256`, and the
    // adjudication as `adjudicationSha256`.
    const g = gateSetFor(['m_a', 'm_b']);
    const { runs, adjudication } = inputsFor(g, { m_a: 1, m_b: 1 });
    const s = scoreGate({ gateSet: g, expectPayloadSha256: g.payloadSha256, runs, adjudication,
      now: () => '2026-08-18T10:00:00.000Z' });
    expect(s.payload.gateSetSha256).toBe(g.payloadSha256);
    expect(s.payload.adjudicationSha256).toBe(sha256(JSON.stringify(adjudication)));
    expect(s.payload.stability.runPayloadSha256[0]).toBe(payloadShaOf(runs[0]!));
    expect(s.payloadSha256).toBe(sha256(JSON.stringify(s.payload)));
    // Exactly ONE copy. Two would drift, and a reader would have no way to know which one the
    // artifact's own hash stands behind.
    expect(Object.keys(s)).not.toContain('gateSetSha256');
  });

  it('gives two materially different adjudications two different payload hashes', () => {
    // Before the adjudication hash was inside the payload, a clean judgment set and one calling a
    // contradiction on a probe could produce a byte-identical score payload, so the value element 8
    // of the chain binds said nothing about which judgments were actually made.
    const g = gateSetFor(['m_a', 'm_b']);
    const clean = score(g, { m_a: 1, m_b: 1 });
    // A `none` call carrying both quoted texts: a real judgment, recorded exactly as §5a asks, and
    // invisible in the score payload because only `contradiction` verdicts are carried into it.
    const judged = score(g, { m_a: 1, m_b: 1 }, { adjudication: (a) => ({ ...a,
      contradictions: [{ probeId: 'L_m_a', verdict: 'none' as const, returnedId: 'project:m_x',
        targetText: 'the timeout is sixty seconds', returnedText: 'the timeout is sixty seconds' },
      a.contradictions[1]!] }) });
    expect(judged.payload.adjudicationSha256).not.toBe(clean.payload.adjudicationSha256);
    expect(judged.payloadSha256).not.toBe(clean.payloadSha256);
  });

  it('carries the frozen K and names the Recall condition after it', () => {
    // §10 freezes K as a method identity. A hardcoded "Recall@20" title over a gate set frozen at a
    // different K would report the wrong measurement under the right name, and a payload with no `k`
    // at all leaves an auditor nothing to check the claim against.
    const g = gateSetFor(['m_a', 'm_b'], { k: 50 });
    const s = score(g, { m_a: 1, m_b: 1 }, { over: { k: 50 } });
    expect(s.payload.k).toBe(50);
    expect(s.payload.conditions.find((c) => c.id === 'recall-at-k')!.title).toBe('Recall@50');
    const miss = score(g, { m_a: null, m_b: 1 }, { over: { k: 50 } });
    expect(miss.payload.release.reasons.join(' ')).toMatch(/Recall@50/);
  });

  it('records the three run ids in the RECEIPTS, never in the payload', () => {
    // §4 requires that re-running deterministic scoring against the same adjudication reproduce the
    // same payload. Run ids differ by construction, so a payload carrying them could never do that —
    // the same coupling that forced the runner's own split, one artifact further down the chain.
    const g = gateSetFor(['m_a', 'm_b']);
    const s = score(g, { m_a: 1, m_b: 1 });
    expect(s.receipts.runIds).toEqual(['r1', 'r2', 'r3']);
    expect(Object.keys(s.payload)).not.toContain('runIds');

    const later = score(g, {}, { runs: ['r7', 'r8', 'r9'].map((id) => runText({ m_a: 1, m_b: 1 }, g.payloadSha256, id)) });
    expect(later.receipts.runIds).toEqual(['r7', 'r8', 'r9']);
    expect(later.payloadSha256).toBe(s.payloadSha256);
  });
});

describe('refusals — the score phase will not run on the wrong artifact', () => {
  /** A run file that will not PARSE is a path problem, not a gate refusal (finding X3). It used to
   *  escape as a bare `SyntaxError` naming neither the run nor the file — exit 1, the code an
   *  operator's script reads as "the gate says no", with a stack into `JSON.parse`.
   *
   *  Tested here rather than through the CLI because reaching the parse requires a gate set that
   *  already passed its own hash and pin checks; a bogus one refuses earlier and the case is never
   *  exercised, which is exactly how a mutation of this guard survived the first sweep. */
  it('names the run flag when a run file is not JSON, instead of throwing a bare SyntaxError', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    const healthy = threeRuns({ m_a: 1, m_b: 1 }, g.payloadSha256);
    // `scoreGate` is called directly rather than through `score`, because that helper derives the
    // adjudication's `runPayloadSha256` from `runs[0]` and would itself fail to parse the broken
    // one. The adjudication here is built from the healthy text and held fixed, so the only thing
    // varying across the three cases is which run file is unparsable.
    const adjudication = cleanAdjudication(g.payloadSha256, payloadShaOf(healthy[0]!),
      g.payload.recallDenominator);
    for (const i of [0, 1, 2]) {
      const runs = [...healthy];
      runs[i] = 'not json{\n';
      let thrown: unknown;
      try {
        scoreGate({ gateSet: g, expectPayloadSha256: g.payloadSha256, runs, adjudication,
          now: () => '2026-08-18T10:00:00.000Z' });
      } catch (e) { thrown = e; }
      expect(String(thrown), `run${i + 1}`).toMatch(new RegExp(`^InvocationError: run-unparsable: --run${i + 1} `));
      // The marker is what makes `main()` exit 2 rather than letting it propagate as exit 1.
      expect((thrown as { invocation?: unknown }).invocation).toBe(true);
    }
  });

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
      runs: [runText({ m_a: 1, m_b: 1 }, g.payloadSha256)],
      adjudication: cleanAdjudication(g.payloadSha256, 'x', []),
      now: () => '2026-08-18T10:00:00.000Z' })).toThrow(/gate-set-not-pinned/);
  });

  it('refuses an adjudication that does not bind this gate set and this run', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { adjudication: (a) => ({ ...a, gateSetSha256: 'd'.repeat(64) }) }))
      .toThrow(/adjudication-unbound/);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { adjudication: (a) => ({ ...a, runPayloadSha256: 'e'.repeat(64) }) }))
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
    const short = runText({ m_a: 1 }, g.payloadSha256);
    expect(() => score(g, {}, { runs: [short, short, short] })).toThrow(/run-probe-mismatch/);
  });

  it('refuses an adjudication still carrying the legacy runSha256 key instead of reinterpreting it', () => {
    // The field was RENAMED because its MEANING changed: `runSha256` hashed the whole runner file,
    // `runPayloadSha256` hashes the deterministic payload. An adjudication written under the old
    // meaning holds a value that can never equal the new one, so silently reading it as the new
    // field would turn a stale judgment set into an unexplained binding failure — and reading it as
    // a fallback would be worse, because it would bind judgments to a hash the gate no longer uses.
    const g = gateSetFor(['m_a', 'm_b']);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { adjudication: (a) => ({ ...a, runSha256: 'c'.repeat(64) }) }))
      .toThrow(/adjudication-legacy-field/);
    // Refused even when the new field beside it is perfectly correct: the file was authored against
    // a different contract, and which of the two hashes the human actually looked at is unknowable.
    expect(() => score(g, { m_a: 1, m_b: 1 }, { adjudication: (a) => ({ ...a, runSha256: a.runPayloadSha256 }) }))
      .toThrow(/adjudication-legacy-field/);
  });

  it('refuses a file that does not identify itself as a run', () => {
    // §10: every artifact names its own `artifact` field so a file identifies itself without
    // reference to a filename. Honouring that field is what makes the guarantee worth anything —
    // otherwise the phase reads whatever shape it was handed and reports on it as if it were a run.
    const g = gateSetFor(['m_a', 'm_b']);
    const mislabelled = ['r1', 'r2', 'r3'].map((id) => {
      const r = JSON.parse(runText({ m_a: 1, m_b: 1 }, g.payloadSha256, id));
      r.artifact = 'gate-score';       // everything else about this file is impeccable
      return JSON.stringify(r, null, 1) + '\n';
    });
    expect(() => score(g, {}, { runs: mislabelled })).toThrow(/not-a-run/);

    // And the case that actually happens: a path typo hands over the gate set itself. It must be
    // named as the wrong FILE, not as a binding failure that sends the operator hunting elsewhere.
    const gateSetAsRun = JSON.stringify(g, null, 1) + '\n';
    expect(() => score(g, {}, { runs: [gateSetAsRun, gateSetAsRun, gateSetAsRun] })).toThrow(/not-a-run/);
  });

  it('refuses a run whose payload does not hash to its own recorded value', () => {
    // The mirror of `gate-set-tampered`, and needed for the same reason: the score phase recomputes
    // the payload hash, so an edited run whose recorded hash was left behind would otherwise be
    // scored happily under a value that no longer describes it — and the adjudication, the stability
    // comparison and §9's chain would all then bind a hash naming bytes nobody ever ran.
    const g = gateSetFor(['m_a', 'm_b']);
    const edited = ['r1', 'r2', 'r3'].map((id) => {
      const r = JSON.parse(runText({ m_a: 1, m_b: 1 }, g.payloadSha256, id));
      r.payload.results[1].bestRank = 1;    // was already 1; the hash is the thing left stale
      r.payloadSha256 = 'b'.repeat(64);
      return JSON.stringify(r, null, 1) + '\n';
    });
    expect(() => score(g, {}, { runs: edited })).toThrow(/run-tampered/);
  });

  it('refuses runs that are perfectly stable but bound to a DIFFERENT prepared gate set', () => {
    // Everything else about these runs is impeccable: they agree with each other, they cover exactly
    // the frozen probe set, and each hashes to its own recorded value. The only defect is that they
    // name a different prepare artifact — and stability answers "did the method behave the same way
    // three times", never "was it THIS method". Without this check a run of a denominator prepared
    // after the results were visible would score against the pinned one and look flawless.
    const g = gateSetFor(['m_a', 'm_b']);
    const other = 'a'.repeat(64);
    const foreign = ['r1', 'r2', 'r3'].map((id) => runText({ m_a: 1, m_b: 1 }, other, id));
    expect(() => score(g, {}, { runs: foreign })).toThrow(/run-not-bound-to-gate-set/);

    // Checked on ALL THREE, not just the one the adjudication happens to name: a third run measured
    // against another gate set is not evidence about this one either.
    const mixed = [runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r1'),
      runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r2'), runText({ m_a: 1, m_b: 1 }, other, 'r3')];
    expect(() => score(g, {}, { runs: mixed })).toThrow(/run-not-bound-to-gate-set/);
  });

  it('requires three runs, because stability is a condition and not an option', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    const one = runText({ m_a: 1, m_b: 1 }, g.payloadSha256);
    expect(() => score(g, {}, { runs: [one, one] })).toThrow(/stability-needs-three-runs/);
  });

  it('refuses runs measured against a manifest other than the one the gate set pins', () => {
    // The defect this closes: the gate set pins the manifest hash, the runner records the manifest
    // it actually read, and until both were compared here a query swap flipped the verdict with
    // every id-level check still agreeing. `run-probe-mismatch` cannot see it — probe ids are
    // exactly the part of a manifest a swap does not have to touch.
    const g = gateSetFor(['m_a', 'm_b']);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { over: { manifestSha256: '9'.repeat(64) } }))
      .toThrow(/run-manifest-mismatch/);

    // Checked on ALL THREE. A third run over swapped queries is not evidence about this one either.
    const mixed = [runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r1'),
      runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r2'),
      runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r3', { manifestSha256: '9'.repeat(64) })];
    expect(() => score(g, {}, { runs: mixed })).toThrow(/run-manifest-mismatch/);
  });

  it('refuses a gate set that pins no manifest hash, rather than checking the runs against nothing', () => {
    // Fail closed at the freeze, not at the run: comparing every run's manifest hash against an
    // absent pin is an equality that can only hold when neither side exists.
    const g = gateSetFor(['m_a', 'm_b']);
    const payload = { ...g.payload } as Partial<typeof g.payload>;
    delete payload.inputs;
    const unpinned = { ...g, payload: payload as typeof g.payload,
      payloadSha256: sha256(JSON.stringify(payload)) };
    expect(() => scoreGate({ gateSet: unpinned, expectPayloadSha256: unpinned.payloadSha256,
      runs: threeRuns({ m_a: 1, m_b: 1 }, unpinned.payloadSha256),
      adjudication: cleanAdjudication(unpinned.payloadSha256, 'x', g.payload.recallDenominator),
      now: () => '2026-08-18T10:00:00.000Z' })).toThrow(/gate-set-unpinned-manifest/);
  });

  it('refuses a run executed at a K other than the frozen one', () => {
    // K=20 is a §10 frozen identity. A run at K=100 returns more candidates, so targets that missed
    // the frozen cut come back inside it — the reviewer measured Recall going from 0/2 to 2/2 on the
    // same corpus purely by widening K, with the report still headed "Recall@20".
    const g = gateSetFor(['m_a', 'm_b']);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { over: { k: 100 } })).toThrow(/run-k-mismatch/);
    const mixed = [runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r1'),
      runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r2'),
      runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r3', { k: 100 })];
    expect(() => score(g, {}, { runs: mixed })).toThrow(/run-k-mismatch/);
  });

  it('refuses a run declaring a rule other than the frozen one instead of re-labelling it', () => {
    // §10 names `rule` and `artifact` together, and the phase already honours `artifact`. Honouring
    // one and ignoring the other means a run produced under some other method identity is scored and
    // then REPORTED under this gate set's rule — the report names a method the run never claimed.
    const g = gateSetFor(['m_a', 'm_b']);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { over: { rule: 'v1-some-other-rule' } }))
      .toThrow(/run-rule-mismatch/);
  });

  it('refuses a file that does not identify itself as an adjudication', () => {
    // The mirror of `not-a-run`, and missing for the same reason it was needed: `Adjudication`
    // declares an `artifact` field that nothing read, so a path typo handing over the gate score
    // itself was accepted as a judgment set.
    const g = gateSetFor(['m_a', 'm_b']);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { adjudication: (a) => ({ ...a, artifact: 'gate-score' }) }))
      .toThrow(/not-an-adjudication/);
  });
});

describe('stability needs three RUNS, not three copies', () => {
  it('refuses three byte-identical copies of one run', () => {
    // §4 says "run the runner three times". The payload/receipts split handed this phase the
    // discriminator that makes that checkable — and it went unused, so one run copied three times
    // scored as a perfect Stability pass over a single execution.
    const g = gateSetFor(['m_a', 'm_b']);
    const one = runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r1');
    expect(() => score(g, {}, { runs: [one, one, one] })).toThrow(/runs-not-distinct/);

    // Two real runs and a duplicate is the same failure: three files were supplied and two
    // executions happened, so the third comparison is a file against itself.
    const dup = [one, one, runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r2')];
    expect(() => score(g, {}, { runs: dup })).toThrow(/runs-not-distinct/);
  });

  it('states in the stability detail that distinctness is self-declared, not proven', () => {
    // The discriminator is `receipts.runId` — OUTSIDE every hash — so one execution copied three
    // times with three edited run ids passes the distinctness check. Nothing signs a run, and that
    // boundary is acknowledged rather than papered over: the condition's own detail must say the
    // check establishes three distinct SELF-DECLARED run ids and no more, and must name where the
    // stronger evidence lives — the ordering receipt's chain — which this phase does not read.
    const g = gateSetFor(['m_a', 'm_b']);
    const s = score(g, { m_a: 1, m_b: 1 });
    const detail = s.payload.conditions.find((c) => c.id === 'stability')!.detail;
    expect(detail).toMatch(/self-declared/);
    expect(detail).toMatch(/ordering receipt/);
    expect(detail).toMatch(/does not read/);
  });

  it('refuses a run that does not identify its execution, before any scoring happens', () => {
    // `receipts: {}` used to score happily with `runIds: [null, null, null]`, and a run with no
    // receipts key at all threw a raw TypeError from inside the scoring code — AFTER the verdict was
    // computed. Both are the same missing check, and it belongs with the other refusals: an
    // unidentified run cannot be told apart from a copy of another one.
    const g = gateSetFor(['m_a', 'm_b']);
    const ids = ['r1', 'r2', 'r3'];
    expect(() => score(g, {}, { runs: ids.map((id) => runText({ m_a: 1, m_b: 1 }, g.payloadSha256, id,
      { receipts: {} })) })).toThrow(/run-unidentified/);
    expect(() => score(g, {}, { runs: ids.map((id) => runText({ m_a: 1, m_b: 1 }, g.payloadSha256, id,
      { receipts: undefined })) })).toThrow(/run-unidentified/);
    expect(() => score(g, {}, { runs: ids.map((id) => runText({ m_a: 1, m_b: 1 }, g.payloadSha256, id,
      { receipts: { runId: '', startedAt: 'x', finishedAt: 'y', attestation: 'z' } })) }))
      .toThrow(/run-unidentified/);
  });
});

describe('the corpus and the runtime surface are cross-checked, not just the gate set', () => {
  // The class these close: the run binds the gate set and the manifest, but a run measured against
  // a SUBSTITUTED corpus or a DEGRADED runtime surface satisfied every hash check above. The
  // runner records what it verified; this phase refuses a run whose record contradicts the freeze.

  it('refuses a run measured against ledger bytes other than the ones the gate set pins', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { over: { ledgers: {
      'ledger:global': '0'.repeat(64), 'ledger:project': H['ledger:project'] } } }))
      .toThrow(/run-snapshot-mismatch/);

    // Checked on ALL THREE runs, and a run recording no corpus hashes at all is refused too —
    // comparing an absent record against a pin must fail, never pass vacuously.
    const mixed = [runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r1'),
      runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r2'),
      runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r3',
        { ledgers: { 'ledger:global': H['ledger:global'], 'ledger:project': '0'.repeat(64) } })];
    expect(() => score(g, {}, { runs: mixed })).toThrow(/run-snapshot-mismatch/);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { over: { ledgers: {} } })).toThrow(/run-snapshot-mismatch/);
  });

  it('refuses a gate set that pins no ledger hashes, rather than checking the runs against nothing', () => {
    // The freeze-side mirror of `gate-set-unpinned-manifest`: the runner always records its corpus
    // hashes, so a gate set with no pin to compare them against cannot support the check at all.
    const g = gateSetFor(['m_a', 'm_b']);
    const payload = { ...g.payload,
      inputs: { manifest: H.manifest, classifier: H.classifier, universe: H.universe } };
    const unpinned = { ...g, payload, payloadSha256: sha256(JSON.stringify(payload)) };
    expect(() => scoreGate({ gateSet: unpinned, expectPayloadSha256: unpinned.payloadSha256,
      runs: threeRuns({ m_a: 1, m_b: 1 }, unpinned.payloadSha256),
      adjudication: cleanAdjudication(unpinned.payloadSha256, 'x', g.payload.recallDenominator),
      now: () => '2026-08-18T10:00:00.000Z' })).toThrow(/gate-set-unpinned-ledger/);
  });

  it('refuses a gate set that discloses no project disposition, rather than comparing against nothing', () => {
    // The freeze-side half of the disposition check, refused for the freeze's defect: a run always
    // records the disposition it resolved, and an absent disclosure would turn the per-run
    // comparison below into a misblamed `run-disposition-mismatch` on an honest run.
    const g = gateSetFor(['m_a', 'm_b']);
    const payload = { ...g.payload } as Record<string, unknown>;
    delete payload.disclosure;
    const undisclosed = { ...g, payload: payload as unknown as typeof g.payload,
      payloadSha256: sha256(JSON.stringify(payload)) };
    expect(() => scoreGate({ gateSet: undisclosed, expectPayloadSha256: undisclosed.payloadSha256,
      runs: threeRuns({ m_a: 1, m_b: 1 }, undisclosed.payloadSha256),
      adjudication: cleanAdjudication(undisclosed.payloadSha256, 'x', g.payload.recallDenominator),
      now: () => '2026-08-18T10:00:00.000Z' })).toThrow(/gate-set-unpinned-disposition/);
  });

  it('refuses a run whose recorded project disposition contradicts the frozen disclosure', () => {
    // Two snapshots with IDENTICAL pinned ledger bytes can differ by `rm home/projects.json`: the
    // project decoy vanishes from recall and the verdict flips while both ledger hashes match the
    // freeze. The runner records the disposition it resolved; a record disagreeing with
    // `disclosure.projectDisposition` means the run ranked against a different participating corpus.
    const g = gateSetFor(['m_a', 'm_b']);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { over: { projectDisposition: 'unadopted-present' } }))
      .toThrow(/run-disposition-mismatch/);
    // An absent record is refused too, never compared against nothing.
    expect(() => score(g, { m_a: 1, m_b: 1 }, { over: { projectDisposition: undefined } }))
      .toThrow(/run-disposition-mismatch/);
  });

  it('refuses a run whose expansion-table CONTENT hash is not the pinned one, or is missing', () => {
    // Three CONSISTENT degraded runs pass Stability — degradation is deterministic — so the only
    // signal is the runner's own record. Round 3 proved an availability BOOLEAN is not that
    // signal: `{"neighbors":{}}` resolves cleanly, removes all expansion, and records true. The
    // record is now the resolved table's content hash, compared against the freeze's own pin.
    const g = gateSetFor(['m_a', 'm_b']);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { over: { expansionSha256: '0'.repeat(64) } }))
      .toThrow(/run-expansion-mismatch/);
    expect(() => score(g, { m_a: 1, m_b: 1 }, { over: { expansionSha256: undefined } }))
      .toThrow(/run-expansion-mismatch/);
  });

  it('refuses a run whose TRUST-file hashes differ from the pins — the macNonce swap, scored-side', () => {
    // The runner-side pin check catches this at run time; this is the mirror for a run artifact
    // however it was produced. A swapped registry nonce re-scores every signed verify row and a
    // planted witness journal removes a scope, each with both LEDGER hashes untouched.
    const g = gateSetFor(['m_a', 'm_b']);
    const swapped = { ...Object.fromEntries(TRUST_NAMES.map((n) => [n, H[n]])), 'ownership:registry': '0'.repeat(64) };
    expect(() => score(g, { m_a: 1, m_b: 1 }, { over: { trust: swapped } }))
      .toThrow(/run-snapshot-mismatch/);
    // Checked on ALL THREE runs, and an absent record is refused, never compared against nothing.
    const mixed = [runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r1'),
      runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r2'),
      runText({ m_a: 1, m_b: 1 }, g.payloadSha256, 'r3', { trust: {} })];
    expect(() => score(g, {}, { runs: mixed })).toThrow(/run-snapshot-mismatch/);
  });

  it('refuses a gate set that pins no trust-file or expansion hash, rather than checking against nothing', () => {
    // The freeze-side mirror, in kind with `gate-set-unpinned-ledger`: the runner always records
    // these, so a gate set with no pin cannot support the comparison at all.
    const g = gateSetFor(['m_a', 'm_b']);
    const drop = (names: string[]) => {
      const inputs = Object.fromEntries(Object.entries(g.payload.inputs).filter(([n]) => !names.includes(n)));
      const payload = { ...g.payload, inputs };
      return { ...g, payload, payloadSha256: sha256(JSON.stringify(payload)) };
    };
    const noTrust = drop(['trust:witness']);
    expect(() => scoreGate({ gateSet: noTrust, expectPayloadSha256: noTrust.payloadSha256,
      runs: threeRuns({ m_a: 1, m_b: 1 }, noTrust.payloadSha256),
      adjudication: cleanAdjudication(noTrust.payloadSha256, 'x', g.payload.recallDenominator),
      now: () => '2026-08-18T10:00:00.000Z' })).toThrow(/gate-set-unpinned-trust/);
    const noExpansion = drop(['expansion:semantic-neighbors']);
    expect(() => scoreGate({ gateSet: noExpansion, expectPayloadSha256: noExpansion.payloadSha256,
      runs: threeRuns({ m_a: 1, m_b: 1 }, noExpansion.payloadSha256),
      adjudication: cleanAdjudication(noExpansion.payloadSha256, 'x', g.payload.recallDenominator),
      now: () => '2026-08-18T10:00:00.000Z' })).toThrow(/gate-set-unpinned-expansion/);
  });

  it('claims for --expect-payload only what is known: the value HANDED to this invocation', () => {
    // The old message asserted "the freeze pinned <X>" where X is arbitrary argv — demonstrated by
    // passing sha256('wrong') and reading a refusal that claimed the freeze pinned it. The program
    // cannot see where the string came from; the wording must not claim it can.
    const g = gateSetFor(['m_a', 'm_b']);
    let thrown: Error | undefined;
    try { score(g, { m_a: 1, m_b: 1 }, { expect: 'f'.repeat(64) }); } catch (e) { thrown = e as Error; }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/gate-set-not-pinned/);
    expect(thrown!.message).toMatch(/handed to this invocation|--expect-payload/);
    expect(thrown!.message).not.toMatch(/the freeze pinned/);
  });
});

describe('an internally impossible run is refused, not scored', () => {
  // Hit@1 reads `bestRank`, Recall reads `hitAtK`, o67 echoes `hitAt1` — three readers of one
  // result, and nothing cross-checked them: a run claiming `bestRank: 1, hitAt1: false, hitAtK:
  // false, returned: []` produced a signed report asserting "every probe ranked 1" and "no probe
  // in the top 20" SIMULTANEOUSLY.
  const g = () => gateSetFor(['m_a', 'm_b']);
  const okResult = (t: string): RunResult => ({ id: `L_${t}`, query: `query ${t}`, unambiguous: true,
    bestRank: 1, hitAtK: true, hitAt1: true, returned: [t] });
  const runsWith = (gs: ReturnType<typeof gateSetFor>, broken: Partial<RunResult>) =>
    ['r1', 'r2', 'r3'].map((id) =>
      runArtifact([{ ...okResult('m_a'), ...broken }, okResult('m_b')], gs.payloadSha256, id));

  it('refuses the reproduced contradiction: rank 1 with hitAt1 false, naming probe and field', () => {
    const gs = g();
    const runs = runsWith(gs, { bestRank: 1, hitAt1: false, hitAtK: false, returned: [] });
    expect(() => score(gs, {}, { runs })).toThrow(/run-inconsistent/);
    expect(() => score(gs, {}, { runs })).toThrow(/L_m_a/);
    expect(() => score(gs, {}, { runs })).toThrow(/hitAt1/);
  });

  it('refuses hitAtK disagreeing with bestRank against the frozen K', () => {
    const gs = g();
    expect(() => score(gs, {}, { runs: runsWith(gs, { bestRank: null, hitAt1: false, hitAtK: true, returned: [] }) }))
      .toThrow(/run-inconsistent/);
    expect(() => score(gs, {}, { runs: runsWith(gs, { bestRank: null, hitAt1: false, hitAtK: true, returned: [] }) }))
      .toThrow(/hitAtK/);
  });

  it('refuses a bestRank deeper than the returned list that is supposed to contain it', () => {
    const gs = g();
    expect(() => score(gs, {}, { runs: runsWith(gs, { bestRank: 2, hitAt1: false, hitAtK: true, returned: ['x_1'] }) }))
      .toThrow(/run-inconsistent/);
  });

  it('refuses a returned list longer than the frozen K', () => {
    const gs = g();
    const tooMany = Array.from({ length: 21 }, (_, i) => (i === 0 ? 'm_a' : `x_${i}`));
    expect(() => score(gs, {}, { runs: runsWith(gs, { returned: tooMany }) }))
      .toThrow(/run-inconsistent/);
  });

  it('checks all three runs, not only the first', () => {
    const gs = g();
    const runs = [runText({ m_a: 1, m_b: 1 }, gs.payloadSha256, 'r1'),
      runText({ m_a: 1, m_b: 1 }, gs.payloadSha256, 'r2'),
      runArtifact([{ ...okResult('m_a'), bestRank: 1, hitAt1: false, hitAtK: false, returned: [] },
        okResult('m_b')], gs.payloadSha256, 'r3')];
    expect(() => score(gs, {}, { runs })).toThrow(/run-inconsistent/);
  });
});

describe('a self-consistent gate set naming ghost probes is refused, not crashed on', () => {
  // `scored.get(id)!` at the Hit@1, Recall and o67 sites: `sameSet` covers `recallDenominator`
  // only, so a re-hashed gate set whose `eligible.probeIds` or `o67.cases[].probeId` named an id
  // outside it — handed over with --expect-payload set to its own hash, the exact adversary
  // `gate-set-not-pinned` is written against — threw a raw TypeError with a stack, exit 1.
  const rehash = (g: ReturnType<typeof gateSetFor>, mutate: (p: typeof g.payload) => void) => {
    const payload = JSON.parse(JSON.stringify(g.payload)) as typeof g.payload;
    mutate(payload);
    return { ...g, payload, payloadSha256: sha256(JSON.stringify(payload)) };
  };
  const scoreIt = (gs: ReturnType<typeof gateSetFor>) => {
    const runs = threeRuns({ m_a: 1, m_b: 1 }, gs.payloadSha256);
    return scoreGate({ gateSet: gs, expectPayloadSha256: gs.payloadSha256, runs,
      adjudication: cleanAdjudication(gs.payloadSha256, payloadShaOf(runs[0]!), gs.payload.recallDenominator),
      now: () => '2026-08-18T10:00:00.000Z' });
  };

  it('refuses a ghost id in eligible.probeIds with a slug, never a TypeError', () => {
    const gs = rehash(gateSetFor(['m_a', 'm_b']), (p) => { p.eligible.probeIds.push('L_ghost'); });
    let thrown: unknown;
    try { scoreIt(gs); } catch (e) { thrown = e; }
    expect(String(thrown)).toMatch(/gate-set-malformed/);
    expect(String(thrown)).toMatch(/L_ghost/);
    expect(thrown).not.toBeInstanceOf(TypeError);
  });

  it('refuses a ghost id in o67.cases with a slug, never a TypeError', () => {
    const gs = rehash(gateSetFor(['m_a', 'm_b'], { inClass: ['m_a'] }), (p) => {
      p.o67.cases.push({ probeId: 'L_ghost', identity: 'project:ghost', hit1Eligible: true, witnesses: [] });
    });
    let thrown: unknown;
    try { scoreIt(gs); } catch (e) { thrown = e; }
    expect(String(thrown)).toMatch(/gate-set-malformed/);
    expect(String(thrown)).toMatch(/L_ghost/);
    expect(thrown).not.toBeInstanceOf(TypeError);
  });
});
