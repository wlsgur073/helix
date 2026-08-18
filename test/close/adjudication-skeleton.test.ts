import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundleCli } from '../helpers/bundle-cli.js';
import {
  buildSkeleton, renderInstructions, UNJUDGED, type AdjudicationSkeleton,
} from '../../scripts/close/adjudication-skeleton.js';
import { scoreGate, type Adjudication } from '../../scripts/pilot/score-gate.js';
import { prepareGateSet, type ManifestProbe, type ClassifierVerdict } from '../../scripts/pilot/prepare-gate.js';
import { RULE } from '../../scripts/pilot/gate-set.js';

/** The adjudication PRODUCER. `score-gate.ts` requires `--adjudication` and nothing wrote one, so
 *  what these tests are about is not "does it emit a file" but the three properties that decide
 *  whether the file is safe to hand a human on close day:
 *
 *    1. an UNFILLED skeleton must be REFUSED by the gate, not scored as a clean sweep — asserted by
 *       driving the emitted object through `scoreGate` itself rather than by inspecting a string;
 *    2. the judgments must be complete and unduplicated BY CONSTRUCTION, because both are gate
 *       refusals discovered after three runs are already on disk;
 *    3. the two hashes must BIND — a skeleton stamped against other bytes must fail the gate's own
 *       `adjudication-unbound` check.
 *
 *  Every assertion about the gate's behaviour therefore calls the pinned `scoreGate`. Restating its
 *  rules here in a local matcher would be a test of this file's beliefs about the gate. */

// ─── fixtures ────────────────────────────────────────────────────────────────────────────────────
// Copied from `test/pilot/score-gate.test.ts` rather than imported: that file exports nothing, and
// it is a pinned-surface test this close-day work must not modify. Kept deliberately identical in
// shape so a drift between the two is a readable diff.

const H = { manifest: 'a'.repeat(64), classifier: 'b'.repeat(64), universe: 'c'.repeat(64),
  'ledger:global': 'd'.repeat(64), 'ledger:project': 'e'.repeat(64),
  'ownership:registry': '1'.repeat(64), 'ownership:owner': '2'.repeat(64),
  'trust:master-key': 'absent', 'trust:witness': 'absent',
  'expansion:semantic-neighbors': '3'.repeat(64) };
const TRUST_NAMES = ['ownership:registry', 'ownership:owner', 'trust:master-key', 'trust:witness'] as const;
const TX_AFTER = '2026-07-21T00:00:00.000Z';
const TX_CLOSE = '2026-08-18T00:00:00.000Z';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const mProbe = (t: string, unambiguous = true): ManifestProbe =>
  ({ id: `L_${t}`, query: `query ${t}`, relevant: [t], unambiguous, side: 'ledger' });
const cVerdict = (t: string, over: Partial<ClassifierVerdict> = {}): ClassifierVerdict =>
  ({ id: `L_${t}`, status: 'not-in-class', targetId: t, targetScope: 'project', hit1Eligible: true, ...over });

/** `closers` is the one addition to the copied helper: a supersede whose target is present in the
 *  same scope is what makes `stale.closerRelationships` non-zero (`prepare-gate.ts:157-176`), and
 *  the stale branch of this producer turns on exactly that number. */
const closerRows = (n: number) => Array.from({ length: n }, (_, i) => [
  { id: `base_${i}`, type: 'assert', content: `content base_${i}`, supersedes: null,
    tx: '2026-08-01T00:00:00.000Z' },
  { id: `close_${i}`, type: 'supersede', content: `content close_${i}`, supersedes: `base_${i}`,
    tx: '2026-08-02T00:00:00.000Z' },
]).flat();

const gateSetFor = (targets: string[],
  opts: { ambiguous?: string[]; inClass?: string[]; k?: number; closers?: number } = {}) => {
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
    ledgers: [{ scope: 'global', rows: [] }, { scope: 'project', rows: closerRows(opts.closers ?? 0) }],
    pins: { k, txAfter: TX_AFTER, txClose: TX_CLOSE, inputs: { ...H } },
    inputHashes: { ...H },
    now: () => '2026-08-18T09:00:00.000Z',
  });
};

type GateSetFixture = ReturnType<typeof gateSetFor>;

const runText = (ranks: Record<string, number | null>, prepareSha256: string, runId = 'r1'): string => {
  const payload = {
    rule: RULE, k: 20, prepareSha256, manifestSha256: H.manifest,
    ledgers: { 'ledger:global': H['ledger:global'], 'ledger:project': H['ledger:project'] },
    trust: Object.fromEntries(TRUST_NAMES.map((n) => [n, H[n]])),
    projectDisposition: 'owned',
    expansionSha256: H['expansion:semantic-neighbors'],
    results: Object.entries(ranks).map(([t, bestRank]) => ({
      id: `L_${t}`, query: `query ${t}`, unambiguous: true, bestRank,
      hitAtK: bestRank !== null && bestRank <= 20, hitAt1: bestRank === 1,
      returned: bestRank === null ? []
        : [...Array.from({ length: bestRank - 1 }, (_, i) => `decoy_${i}`), t],
    })),
  };
  return JSON.stringify({
    artifact: 'run', payloadSha256: sha256(JSON.stringify(payload)), payload,
    receipts: { runId, startedAt: `2026-08-18T09:0${runId.slice(-1)}:00.000Z`,
      finishedAt: `2026-08-18T09:0${runId.slice(-1)}:30.000Z`, attestation: 'self-reported wall clocks' },
  }, null, 1) + '\n';
};

const threeRuns = (ranks: Record<string, number | null>, prepareSha256: string) =>
  ['r1', 'r2', 'r3'].map((id) => runText(ranks, prepareSha256, id));

const payloadShaOf = (text: string) => sha256(JSON.stringify((JSON.parse(text) as { payload: unknown }).payload));

/** What the human does to the file, expressed as the smallest possible edit: every `UNJUDGED`
 *  becomes the benign verdict, nothing else changes. `contradictions` may be filled without
 *  `staleViolations` (and vice versa) because one test is about exactly that asymmetry. */
const fill = (s: AdjudicationSkeleton, what: 'both' | 'contradictions' | 'stale' = 'both'): Adjudication => ({
  ...s,
  contradictions: what === 'stale' ? s.contradictions
    : s.contradictions.map((c) => ({ ...c, verdict: 'none' as const })),
  staleViolations: what === 'contradictions' ? s.staleViolations
    : s.staleViolations.map((v) => ({ ...v, verdict: 'none' as const })),
} as Adjudication);

const scoreWith = (g: GateSetFixture, runs: string[], adjudication: Adjudication | AdjudicationSkeleton) =>
  scoreGate({ gateSet: g, expectPayloadSha256: g.payloadSha256, runs,
    adjudication: adjudication as Adjudication, now: () => '2026-08-18T10:00:00.000Z' });

/** A gate set, its three runs and the skeleton stamped from the first of them — the close-day
 *  sequence in one call, because every test below starts from it. */
const stamped = (targets: string[], ranks: Record<string, number | null>,
  opts: Parameters<typeof gateSetFor>[1] = {}) => {
  const g = gateSetFor(targets, opts);
  const runs = threeRuns(ranks, g.payloadSha256);
  return { g, runs, skeleton: buildSkeleton({ gateSet: g, runText: runs[0]! }) };
};

// ─── 1. fail-closed ──────────────────────────────────────────────────────────────────────────────

describe('an unfilled skeleton is refused BY THE GATE, not scored', () => {
  it('drives the emitted skeleton through scoreGate and gets adjudication-uncertain', () => {
    // The property this producer exists to have. A template pre-filled with `none` would be a
    // blocking release condition pre-answered in the release's favour by the tool that wrote it;
    // `UNJUDGED` is chosen precisely because `score-gate.ts:438` accepts neither it nor anything
    // else outside {none, contradiction}. Asserted against the real gate, since the value's whole
    // job is to be rejected by that code and not by a rule restated here.
    const { g, runs, skeleton } = stamped(['m_a', 'm_b'], { m_a: 1, m_b: 1 });
    expect(() => scoreWith(g, runs, skeleton)).toThrow(/adjudication-uncertain/);
  });

  it('stamps every verdict UNJUDGED, and UNJUDGED is neither accepted value', () => {
    const { skeleton } = stamped(['m_a', 'm_b'], { m_a: 1, m_b: 1 }, { closers: 1 });
    expect(skeleton.contradictions.every((c) => c.verdict === UNJUDGED)).toBe(true);
    expect(skeleton.staleViolations.every((v) => v.verdict === UNJUDGED)).toBe(true);
    expect(UNJUDGED).not.toBe('none');
    expect(UNJUDGED).not.toBe('contradiction');
    expect(UNJUDGED).not.toBe('violation');
  });

  it('identifies itself as an adjudication, so the gate does not refuse it as the wrong file', () => {
    // `not-an-adjudication` (score-gate.ts:411) reads this field. A skeleton that failed it would
    // be refused for the wrong reason and the operator would go looking for a path typo.
    const { skeleton } = stamped(['m_a', 'm_b'], { m_a: 1, m_b: 1 });
    expect(skeleton.artifact).toBe('adjudication');
    expect(Object.hasOwn(skeleton, 'runSha256')).toBe(false);   // the legacy field, refused at :420
  });

  it('the SAME file with every verdict filled in scores cleanly', () => {
    // The other half of the same claim: the skeleton must be refused because it is UNFILLED, not
    // because it is malformed. If filling the verdicts were not sufficient to make it scorable,
    // `adjudication-uncertain` above would be hiding some other defect.
    const { g, runs, skeleton } = stamped(['m_a', 'm_b'], { m_a: 1, m_b: 1 });
    const filled = fill(skeleton);
    const s = scoreWith(g, runs, filled);
    expect(s.payload.contradictions.pass).toBe(true);
    expect(s.payload.release.blocked).toBe(false);
    expect(s.payload.adjudicationSha256).toBe(sha256(JSON.stringify(filled)));
  });

  it('carries a positive call and its quoted texts through to the report when the judge makes one', () => {
    // The pre-filled placeholder keys are real keys of the pinned `ContradictionCall`, so a judge
    // who replaces the texts and the verdict produces a call the gate carries into the score
    // payload — including `returnedId`, which the skeleton pre-filled from the run.
    const { g, runs, skeleton } = stamped(['m_a', 'm_b'], { m_a: 1, m_b: 3 });
    const judged = { ...fill(skeleton), contradictions: [
      { ...skeleton.contradictions[0]!, verdict: 'contradiction' as const,
        targetText: 'the timeout is sixty seconds', returnedText: 'the timeout is not sixty seconds' },
      { ...skeleton.contradictions[1]!, verdict: 'none' as const },
    ] } as Adjudication;
    const s = scoreWith(g, runs, judged);
    expect(s.payload.contradictions.pass).toBe(false);
    expect(s.payload.contradictions.calls[0]).toMatchObject({ probeId: 'L_m_a', returnedId: 'm_a',
      targetText: 'the timeout is sixty seconds' });
    expect(s.payload.release.blocked).toBe(true);
  });
});

// ─── 2. completeness and non-duplication by construction ────────────────────────────────────────

describe('one entry per frozen probe, complete and unduplicated by construction', () => {
  it('emits exactly the frozen denominator, in frozen order, over a five-probe gate set', () => {
    const { g, skeleton } = stamped(['m_a', 'm_b', 'm_c', 'm_d', 'm_e'],
      { m_a: 1, m_b: 1, m_c: 1, m_d: 1, m_e: 1 });
    const ids = skeleton.contradictions.map((c) => c.probeId);
    expect(ids).toEqual(g.payload.recallDenominator);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(5);
  });

  it('an ineligible probe still gets a judgment, because Recall spans every probe', () => {
    // The contradiction denominator is `recallDenominator`, never `eligible.probeIds`
    // (score-gate.ts:433). A skeleton over the smaller set would be refused as incomplete.
    const { g, runs, skeleton } = stamped(['m_a', 'm_b', 'm_c'], { m_a: 1, m_b: 1, m_c: 1 },
      { ambiguous: ['m_c'] });
    expect(g.payload.eligible.probeIds).not.toContain('L_m_c');
    expect(skeleton.contradictions.map((c) => c.probeId)).toContain('L_m_c');
    expect(() => scoreWith(g, runs, fill(skeleton))).not.toThrow();
  });

  it('pre-fills returnedId from the run wherever the run returned anything', () => {
    // Both sides quoted is §5a's requirement, and the run supplies exactly one of them: the
    // top-ranked returned id. A probe that returned nothing gets no key rather than an empty
    // string — "nothing was returned" and "an unfilled field" are different facts.
    const { skeleton } = stamped(['m_a', 'm_b'], { m_a: 2, m_b: null });
    const [a, b] = skeleton.contradictions;
    expect(a).toMatchObject({ probeId: 'L_m_a', returnedId: 'decoy_0' });
    expect(Object.hasOwn(b!, 'returnedId')).toBe(false);
    // The two texts cannot be pre-filled — a run artifact carries ids and ranks, not row content —
    // so they are loud placeholders that survive into the signed payload if left unreplaced.
    expect(a!.targetText).toMatch(/^UNQUOTED/);
    expect(a!.returnedText).toMatch(/^UNQUOTED/);
  });

  it('refuses a gate set whose denominator names a probe twice, instead of emitting an unfillable file', () => {
    // With a duplicate id, `adjudication-duplicate` and `adjudication-incomplete` are mutually
    // unsatisfiable: no adjudication over that gate set can be scored, so the defect is the freeze's
    // and the skeleton says so rather than stamping work nobody can finish.
    const g = gateSetFor(['m_a', 'm_b']);
    const payload = { ...g.payload, recallDenominator: ['L_m_a', 'L_m_a', 'L_m_b'] };
    const dup = { ...g, payload, payloadSha256: sha256(JSON.stringify(payload)) };
    expect(() => buildSkeleton({ gateSet: dup, runText: runText({ m_a: 1, m_b: 1 }, dup.payloadSha256) }))
      .toThrow(/gate-set-malformed/);
  });
});

// ─── 3. the two hashes bind ──────────────────────────────────────────────────────────────────────

describe('the skeleton binds this gate set and this run', () => {
  it('recomputes both hashes from the bytes, matching what the gate compares against', () => {
    const { g, runs, skeleton } = stamped(['m_a', 'm_b'], { m_a: 1, m_b: 1 });
    expect(skeleton.gateSetSha256).toBe(g.payloadSha256);
    expect(skeleton.runPayloadSha256).toBe(payloadShaOf(runs[0]!));
    expect(() => scoreWith(g, runs, fill(skeleton))).not.toThrow();
  });

  it('changes the emitted run hash when the run changes, and the gate then refuses the mismatch', () => {
    // A skeleton stamped against one run is not evidence about another. Both halves are asserted:
    // the hash moves, AND the gate's own `adjudication-unbound` fires on the stale one.
    const g = gateSetFor(['m_a', 'm_b']);
    const runsA = threeRuns({ m_a: 1, m_b: 1 }, g.payloadSha256);
    const runsB = threeRuns({ m_a: 1, m_b: 2 }, g.payloadSha256);
    const fromA = buildSkeleton({ gateSet: g, runText: runsA[0]! });
    const fromB = buildSkeleton({ gateSet: g, runText: runsB[0]! });
    expect(fromA.runPayloadSha256).not.toBe(fromB.runPayloadSha256);
    expect(() => scoreWith(g, runsB, fill(fromA))).toThrow(/adjudication-unbound/);
    expect(() => scoreWith(g, runsB, fill(fromB))).not.toThrow();
  });

  it('changes the emitted gate-set hash when the gate set changes, and the gate then refuses it', () => {
    const gA = gateSetFor(['m_a', 'm_b']);
    const gB = gateSetFor(['m_a', 'm_b', 'm_c']);
    const runsB = threeRuns({ m_a: 1, m_b: 1, m_c: 1 }, gB.payloadSha256);
    const fromB = buildSkeleton({ gateSet: gB, runText: runsB[0]! });
    const runsA = threeRuns({ m_a: 1, m_b: 1 }, gA.payloadSha256);
    const fromA = buildSkeleton({ gateSet: gA, runText: runsA[0]! });
    expect(fromA.gateSetSha256).not.toBe(fromB.gateSetSha256);
    expect(() => scoreWith(gA, runsA, fill(fromB))).toThrow(/adjudication-unbound/);
  });

  it('refuses a gate set or a run whose payload does not hash to its own recorded value', () => {
    // The recorded field is exactly what an edit leaves stale, so it is recomputed and compared —
    // the same pair of checks the score phase makes, moved one artifact earlier so the operator
    // meets the refusal before judging rather than after three runs.
    const g = gateSetFor(['m_a', 'm_b']);
    const tampered = { ...g, payloadSha256: 'f'.repeat(64) };
    expect(() => buildSkeleton({ gateSet: tampered, runText: runText({ m_a: 1, m_b: 1 }, g.payloadSha256) }))
      .toThrow(/gate-set-tampered/);

    const run = JSON.parse(runText({ m_a: 1, m_b: 1 }, g.payloadSha256)) as { payloadSha256: string };
    run.payloadSha256 = 'b'.repeat(64);
    expect(() => buildSkeleton({ gateSet: g, runText: JSON.stringify(run) })).toThrow(/run-tampered/);
  });

  it('refuses a run bound to a different prepared gate set, and one over a different probe set', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    expect(() => buildSkeleton({ gateSet: g, runText: runText({ m_a: 1, m_b: 1 }, 'a'.repeat(64)) }))
      .toThrow(/run-not-bound-to-gate-set/);
    expect(() => buildSkeleton({ gateSet: g, runText: runText({ m_a: 1 }, g.payloadSha256) }))
      .toThrow(/run-probe-mismatch/);
  });

  it('names the flag when the run file is not JSON, and marks it an invocation error', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    let thrown: unknown;
    try { buildSkeleton({ gateSet: g, runText: 'not json{\n' }); } catch (e) { thrown = e; }
    expect(String(thrown)).toMatch(/^InvocationError: run-unparsable: --run /);
    expect((thrown as { invocation?: unknown }).invocation).toBe(true);
  });

  it('refuses a file that does not identify itself as a gate set or as a run', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    const run = runText({ m_a: 1, m_b: 1 }, g.payloadSha256);
    expect(() => buildSkeleton({ gateSet: { ...g, artifact: 'gate-score' } as unknown as typeof g, runText: run }))
      .toThrow(/not-a-gate-set/);
    const mislabelled = JSON.parse(run) as { artifact: string };
    mislabelled.artifact = 'gate-score';
    expect(() => buildSkeleton({ gateSet: g, runText: JSON.stringify(mislabelled) })).toThrow(/not-a-run/);
  });
});

// ─── 4. the stale branch ─────────────────────────────────────────────────────────────────────────

describe('the stale-served-as-live set exists only when the gate set says the hazard could arise', () => {
  it('emits no stale entries at zero closer relationships, and the gate accepts that', () => {
    const { g, runs, skeleton } = stamped(['m_a', 'm_b'], { m_a: 1, m_b: 1 });
    expect(g.payload.stale.closerRelationships).toBe(0);
    expect(skeleton.staleViolations).toEqual([]);
    const s = scoreWith(g, runs, fill(skeleton));
    expect(s.payload.stale).toMatchObject({ closerRelationships: 0, pass: true, blocking: false });
  });

  it('emits one entry per frozen probe above zero, which is exactly what the gate then demands', () => {
    const { g, runs, skeleton } = stamped(['m_a', 'm_b'], { m_a: 1, m_b: 1 }, { closers: 2 });
    expect(g.payload.stale.closerRelationships).toBe(2);
    expect(skeleton.staleViolations.map((v) => v.probeId)).toEqual(g.payload.recallDenominator);
    const s = scoreWith(g, runs, fill(skeleton));
    expect(s.payload.stale).toMatchObject({ pass: true, blocking: true, violations: [] });
    expect(s.payload.release.blocked).toBe(false);
  });

  it('an EMPTY stale set above zero is what the gate refuses — the branch is not cosmetic', () => {
    // The negative control for the branch: had the producer emitted `[]` regardless of exposure,
    // this is the refusal the operator would meet on close day with no stale judgments made.
    const { g, runs, skeleton } = stamped(['m_a', 'm_b'], { m_a: 1, m_b: 1 }, { closers: 2 });
    expect(() => scoreWith(g, runs, { ...fill(skeleton), staleViolations: [] }))
      .toThrow(/adjudication-incomplete/);
  });

  it('refuses a gate set carrying no numeric stale count rather than assuming zero', () => {
    // Absent is not zero. Assuming it were would omit the whole section for a corpus the gate then
    // demands one for, and the omission would surface as `adjudication-incomplete` at scoring time.
    const g = gateSetFor(['m_a', 'm_b']);
    const payload = { ...g.payload } as Record<string, unknown>;
    delete payload.stale;
    const noStale = { ...g, payload: payload as unknown as typeof g.payload,
      payloadSha256: sha256(JSON.stringify(payload)) };
    expect(() => buildSkeleton({ gateSet: noStale, runText: runText({ m_a: 1, m_b: 1 }, noStale.payloadSha256) }))
      .toThrow(/gate-set-malformed/);
  });

  it('documents the asymmetry: the gate validates contradiction verdicts and NOT stale ones', () => {
    // Not an endorsement — a boundary. `score-gate.ts:481` counts `violation` and ignores every
    // other string, so an UNJUDGED stale entry reads there as "no violation". What protects an
    // unfilled skeleton is therefore the CONTRADICTIONS refusal, which fires first (:437 before
    // :476) and refuses the whole file. Judge the contradictions only, and this is what happens:
    const { g, runs, skeleton } = stamped(['m_a', 'm_b'], { m_a: 1, m_b: 1 }, { closers: 1 });
    const half = fill(skeleton, 'contradictions');
    expect(half.staleViolations.every((v) => (v.verdict as string) === UNJUDGED)).toBe(true);
    const s = scoreWith(g, runs, half);
    expect(s.payload.stale.pass).toBe(true);       // silently, which is why the CLI warns about it
    // So the instructions must say so in as many words whenever a stale set is emitted at all.
    expect(renderInstructions(skeleton, '/tmp/adj.json')).toMatch(/WARNING/);
  });
});

// ─── 5. what the operator is told ────────────────────────────────────────────────────────────────

describe('the operator instructions state what is outstanding', () => {
  it('counts the judgments, names both legal verdicts, and requires both texts on a positive call', () => {
    const { skeleton } = stamped(['m_a', 'm_b', 'm_c'], { m_a: 1, m_b: 1, m_c: 1 });
    const text = renderInstructions(skeleton, '/tmp/adj.json');
    expect(text).toMatch(/^wrote \/tmp\/adj\.json$/m);
    expect(text).toMatch(/3 contradiction judgment\(s\) required/);
    expect(text).toMatch(/'none' or 'contradiction'/);
    expect(text).toMatch(/adjudication-uncertain/);
    expect(text).toMatch(/BOTH sides/);
    expect(text).toMatch(/targetText and returnedText/);
    expect(text).toMatch(/zero closer relationships/);
  });

  it('states the stale count and its two verdicts when the stale set exists', () => {
    const { skeleton } = stamped(['m_a', 'm_b'], { m_a: 1, m_b: 1 }, { closers: 3 });
    const text = renderInstructions(skeleton, '/tmp/adj.json');
    expect(text).toMatch(/2 stale-served-as-live judgment\(s\) required/);
    expect(text).toMatch(/'none' or 'violation'/);
  });

  it('asks a violation to name closedId and currentId, which the report reads back', () => {
    // `StaleCall` carries both as optional keys (score-gate.ts:60-65) and the scorer copies each
    // violation VERBATIM into the signed payload (:481-483), which is where the close report's §7.4
    // reads the closed/current ids from. Nothing pre-fills them — a run artifact carries ranks, not
    // closer relationships — so a judge who is not asked leaves the report unable to name the pair.
    const { skeleton } = stamped(['m_a', 'm_b'], { m_a: 1, m_b: 1 }, { closers: 3 });
    const text = renderInstructions(skeleton, '/tmp/adj.json');
    expect(text).toMatch(/`closedId`/);
    expect(text).toMatch(/`currentId`/);
    expect(text).toMatch(/copies each violation verbatim/);
    // And it is asked ONLY where a violation can arise: at zero exposure the score phase requires no
    // stale set at all, so the instruction would name keys of entries that do not exist.
    const { skeleton: noStale } = stamped(['m_a', 'm_b'], { m_a: 1, m_b: 1 });
    expect(renderInstructions(noStale, '/tmp/adj.json')).not.toMatch(/`closedId`/);
  });

  it('scopes the judgment to EVERY returned record in the top-K, not to the pre-filled rank 1', () => {
    // The instruction has to reach the operator here and not only in the run-sheet, because this is
    // what prints on the terminal at the moment the file is created. `returnedId` pre-filled with
    // rank 1 reads as the row the program decided the judgment is about; §5a's rubric is "A returned
    // live record", so the contradicting row may sit anywhere in the top-K and the id must then be
    // replaced. A judge working the skeleton verbatim would otherwise inspect 1 of up to K rows.
    const { skeleton } = stamped(['m_a', 'm_b'], { m_a: 1, m_b: 3 });
    const text = renderInstructions(skeleton, '/tmp/adj.json');
    expect(text).toMatch(/SCOPE of each contradiction judgment/);
    expect(text).toMatch(/EVERY returned live record in that probe's top-K/);
    expect(text).toMatch(/payload\.results\[\]\.returned/);
    expect(text).toMatch(/REPLACE `returnedId`/);
    // The pre-filled value is still rank 1 — the instruction is what makes it a starting point.
    expect(skeleton.contradictions[1]).toMatchObject({ probeId: 'L_m_b', returnedId: 'decoy_0' });
  });

  it('sends a re-stamp to a NEW --out, because re-stamping over this one is refused', () => {
    // "re-stamp rather than hand-correct" had no executable path: the same --out is refused
    // `output-exists`, and that refusal's own text forbids deleting what is there. The CLI test
    // below drives the refusal; this pins that the instruction agrees with it.
    const { skeleton } = stamped(['m_a', 'm_b'], { m_a: 1, m_b: 1 });
    const text = renderInstructions(skeleton, '/tmp/adj.json');
    expect(text).toMatch(/NEW --out path/);
    expect(text).toMatch(/output-exists/);
    expect(text).toMatch(/Do NOT delete this one/);
    expect(text).toMatch(/score-gate as --adjudication/);
  });
});

// ─── 5b. the zero-probe boundary ─────────────────────────────────────────────────────────────────

describe('a gate set with an EMPTY frozen denominator', () => {
  /** The honest statement of where the fail-closed property stops, pinned so it cannot be quietly
   *  re-broadened. `adjudication-uncertain` is raised by a LOOP over the contradiction calls
   *  (score-gate.ts:437), so an empty skeleton is accepted by the gate: the claim holds for every
   *  non-empty denominator and vacuously fails for the empty one.
   *
   *  THE DECISION, recorded here because it is the kind a reviewer will ask about: the producer does
   *  NOT refuse an empty denominator. Refusing would be safer only if it protected the verdict, and
   *  it does not — the release is blocked either way, by the Hit@1 exposure floor. What refusing
   *  would do is dead-end the close chain on a one-shot irreversible day in a state the run-sheet
   *  explicitly calls a result rather than a failure (an empty manifest), leaving `score-gate` still
   *  demanding an `--adjudication` the operator would then hand-author under time pressure — the
   *  exact hazard this program exists to remove. So it emits, and says loudly what the file is. */
  const emptyGateSet = () => {
    const g = gateSetFor([]);
    const runs = threeRuns({}, g.payloadSha256);
    return { g, runs, skeleton: buildSkeleton({ gateSet: g, runText: runs[0]! }) };
  };

  it('stamps an empty skeleton rather than refusing, so the close chain stays executable', () => {
    const { g, skeleton } = emptyGateSet();
    expect(g.payload.recallDenominator).toEqual([]);
    expect(skeleton.artifact).toBe('adjudication');
    expect(skeleton.contradictions).toEqual([]);
    expect(skeleton.staleViolations).toEqual([]);
  });

  it('is ACCEPTED unfilled by the gate — the fail-closed property does not hold here', () => {
    // The negative control for the claim in this file's header. Asserted against the real
    // `scoreGate`, because a boundary restated as a local belief is worth nothing.
    const { g, runs, skeleton } = emptyGateSet();
    expect(() => scoreWith(g, runs, skeleton)).not.toThrow();
  });

  it('still blocks the release, on the Hit@1 exposure floor rather than on any judgment', () => {
    // Why emitting is safe: no arrangement of this file can produce a release. Zero probes puts
    // `eligible.exposure` below HIT1_MINIMUM, and that condition is blocking.
    const { g, runs, skeleton } = emptyGateSet();
    const s = scoreWith(g, runs, skeleton);
    expect(s.payload.release.blocked).toBe(true);
    expect(s.payload.release.reasons.join(' ')).toMatch(/Hit@1/);
    expect(s.payload.hit1.pass).toBe(false);
    expect(s.payload.contradictions.pass).toBe(true);        // vacuously — zero calls, zero positives
  });

  it('says so in the printed instructions instead, and prints none of the judgment lines', () => {
    // Every judgment instruction would be FALSE here — nothing is required, nothing is UNJUDGED, and
    // the gate will not refuse the file — so the zero-probe block replaces them rather than joining
    // them. The operator is told the most likely cause: a defect upstream of this program.
    const { skeleton } = emptyGateSet();
    const text = renderInstructions(skeleton, '/tmp/adj.json');
    expect(text).toMatch(/NO JUDGMENTS/);
    expect(text).toMatch(/does NOT hold at zero probes/);
    expect(text).toMatch(/ACCEPTS this file/);
    expect(text).toMatch(/Hit@1/);
    expect(text).toMatch(/defect/);
    expect(text).not.toMatch(/judgment\(s\) required/);
    expect(text).not.toMatch(/adjudication-uncertain/);
    expect(text).not.toMatch(new RegExp(UNJUDGED));
  });
});

// ─── 5c. malformed artifacts refuse by name, not as TypeErrors ───────────────────────────────────

describe('a structurally broken artifact is refused in kebab-case, never as a raw TypeError', () => {
  /** The failure class `artifact-io.ts:36-46` and `score-gate.ts:255-265` exist to eliminate: a
   *  hand-forged artifact whose recorded hash was recomputed used to escape as a Node stack at exit
   *  1 — the code reserved for "the artifacts disagree", which a structurally broken file is not.
   *  Each assertion checks the SLUG and, by anchoring on `Error:`, that a TypeError is not what
   *  reached the operator. */
  const thrownBy = (fn: () => unknown): string => {
    try { fn(); return 'DID NOT THROW'; } catch (e) { return `${(e as Error).name}: ${(e as Error).message}`; }
  };
  type MutableRun = { payload?: Record<string, unknown>; payloadSha256?: string };
  const mangledRun = (prepareSha256: string, mutate: (run: MutableRun) => void): string => {
    const run = JSON.parse(runText({ m_a: 1, m_b: 1 }, prepareSha256)) as MutableRun;
    mutate(run);
    if (run.payload !== undefined) run.payloadSha256 = sha256(JSON.stringify(run.payload));
    return JSON.stringify(run);
  };
  const mangledGateSet = (g: GateSetFixture, mutate: (payload: Record<string, unknown>) => void) => {
    const payload = { ...g.payload } as unknown as Record<string, unknown>;
    mutate(payload);
    return { ...g, payload: payload as unknown as GateSetFixture['payload'],
      payloadSha256: sha256(JSON.stringify(payload)) };
  };

  it('refuses a run with no payload, before the hash is computed over it', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    // `sha256(JSON.stringify(undefined))` throws from inside `createHash().update` — the check must
    // therefore sit BEFORE the hash, not beside it.
    expect(thrownBy(() => buildSkeleton({ gateSet: g, runText: mangledRun(g.payloadSha256, (r) => { delete r.payload; }) })))
      .toMatch(/^Error: run-malformed: --run carries no `payload`/);
  });

  it('refuses a run whose payload carries no results array', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    expect(thrownBy(() => buildSkeleton({ gateSet: g,
      runText: mangledRun(g.payloadSha256, (r) => { delete r.payload!.results; }) })))
      .toMatch(/^Error: run-malformed: --run's payload carries no `results` array/);
  });

  it('refuses a result that carries no returned list, naming the index', () => {
    // The one that mattered: `returned[0]` on an absent list is
    // "Cannot read properties of undefined (reading '0')" at the line that pre-fills `returnedId`.
    const g = gateSetFor(['m_a', 'm_b']);
    const broken = mangledRun(g.payloadSha256, (r) => {
      delete (r.payload!.results as Record<string, unknown>[])[0]!.returned;
    });
    expect(thrownBy(() => buildSkeleton({ gateSet: g, runText: broken })))
      .toMatch(/^Error: run-malformed: --run's result at index 0 is not a probe result/);
  });

  it('refuses a gate set with no payload and one with no recallDenominator array', () => {
    const g = gateSetFor(['m_a', 'm_b']);
    const run = runText({ m_a: 1, m_b: 1 }, g.payloadSha256);
    const noPayload = { ...g, payload: undefined } as unknown as GateSetFixture;
    expect(thrownBy(() => buildSkeleton({ gateSet: noPayload, runText: run })))
      .toMatch(/^Error: gate-set-malformed: --gate-set carries no `payload`/);

    const noDenominator = mangledGateSet(g, (p) => { delete p.recallDenominator; });
    expect(thrownBy(() => buildSkeleton({ gateSet: noDenominator,
      runText: runText({ m_a: 1, m_b: 1 }, noDenominator.payloadSha256) })))
      .toMatch(/^Error: gate-set-malformed: this gate set carries no `recallDenominator` array/);
  });

  it('names the ids in a population mismatch, never two counts that can be equal', () => {
    // Both reproductions the review recorded. "2 probes and the frozen gate set holds 2" is a
    // refusal an operator has to disbelieve before they can act on it.
    const g = gateSetFor(['m_a', 'm_b']);
    const other = thrownBy(() => buildSkeleton({ gateSet: g,
      runText: runText({ m_x: 1, m_z: 1 }, g.payloadSha256) }));
    expect(other).toMatch(/^Error: run-probe-mismatch: /);
    expect(other).toMatch(/In the run but not in the frozen denominator: L_m_x, L_m_z/);
    expect(other).toMatch(/in the denominator but not in the run: L_m_a, L_m_b/);

    const duplicated = thrownBy(() => buildSkeleton({ gateSet: g,
      runText: mangledRun(g.payloadSha256, (r) => {
        const results = r.payload!.results as unknown[];
        r.payload!.results = [results[0], results[0]];
      }) }));
    expect(duplicated).toMatch(/reported more than once by the run: L_m_a/);
    expect(duplicated).toMatch(/in the denominator but not in the run: L_m_b/);
  });
});

// ─── 6. the CLI ──────────────────────────────────────────────────────────────────────────────────

describe('the CLI behaves like its pilot siblings', () => {
  let cli: string;
  beforeAll(async () => { cli = await bundleCli('scripts/close/adjudication-skeleton.ts'); }, 30_000);

  const runCli = (args: string[]) => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' }), stderr: '' };
    } catch (e) {
      const err = e as { status: number | null; stdout: string; stderr: string };
      return { status: err.status ?? -1, stdout: err.stdout, stderr: err.stderr };
    }
  };

  /** Gate set and run on disk, plus a fresh unused output path. */
  const onDisk = () => {
    const dir = mkdtempSync(join(tmpdir(), 'adjskel-'));
    const g = gateSetFor(['m_a', 'm_b']);
    const runs = threeRuns({ m_a: 1, m_b: 1 }, g.payloadSha256);
    const gateSetPath = join(dir, 'gate-set.json');
    const runPath = join(dir, 'run1.json');
    writeFileSync(gateSetPath, JSON.stringify(g, null, 1) + '\n');
    writeFileSync(runPath, runs[0]!);
    return { dir, g, runs, gateSetPath, runPath, outPath: join(dir, 'adjudication.json') };
  };

  it('writes a skeleton the gate refuses as uncertain and accepts once filled', async () => {
    const { g, runs, gateSetPath, runPath, outPath } = onDisk();
    const r = runCli(['--gate-set', gateSetPath, '--run', runPath, '--out', outPath]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/2 contradiction judgment\(s\) required/);
    const written = JSON.parse(readFileSync(outPath, 'utf8')) as AdjudicationSkeleton;
    expect(written.artifact).toBe('adjudication');
    expect(() => scoreWith(g, runs, written)).toThrow(/adjudication-uncertain/);
    expect(() => scoreWith(g, runs, fill(written))).not.toThrow();
  });

  it('is its own entry point: no args prints THIS usage and exits 2', async () => {
    // The regression lock for the hazard `test/pilot/entry-point-isolation.test.ts` describes: the
    // two call shapes come from the guarded `score-gate.ts` as TYPE-ONLY imports, and a value
    // import would inline that module's `main()` into this bundle and print ITS usage instead.
    const r = runCli([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage: adjudication-skeleton --gate-set <path> --run <path> --out <path>/);
    expect(r.stderr).toMatch(/missing-input/);
    // A guarded module inlined into this bundle would print ITS usage line, not just be named in
    // prose — this program's own usage text cites `score-gate.ts:425`, so the check is on the
    // usage HEADER of another CLI rather than on the word.
    expect(r.stderr).not.toMatch(/usage: (score|prepare)-gate/);
  });

  it('refuses a pre-existing output, an output aliasing an input, and an unreadable input', async () => {
    const { dir, gateSetPath, runPath, outPath } = onDisk();
    writeFileSync(outPath, 'occupied\n');
    const exists = runCli(['--gate-set', gateSetPath, '--run', runPath, '--out', outPath]);
    expect(exists.status).toBe(2);
    expect(exists.stderr).toMatch(/output-exists/);
    expect(readFileSync(outPath, 'utf8')).toBe('occupied\n');       // untouched

    const alias = runCli(['--gate-set', gateSetPath, '--run', runPath, '--out', runPath]);
    expect(alias.status).toBe(2);
    expect(alias.stderr).toMatch(/output-aliases-input/);

    const missing = runCli(['--gate-set', join(dir, 'nope.json'), '--run', runPath,
      '--out', join(dir, 'a.json')]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/input-unreadable/);
  });

  it('exits 1, not 2, when the artifacts read fine and disagree', async () => {
    // The split every pilot CLI promises: a path that can be retyped is exit 2, a refusal about
    // what the files SAY is exit 1. A run bound to another gate set is the latter.
    const { dir, gateSetPath } = onDisk();
    const foreign = join(dir, 'foreign.json');
    writeFileSync(foreign, runText({ m_a: 1, m_b: 1 }, 'a'.repeat(64)));
    const r = runCli(['--gate-set', gateSetPath, '--run', foreign, '--out', join(dir, 'b.json')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/run-not-bound-to-gate-set/);
  });
});
