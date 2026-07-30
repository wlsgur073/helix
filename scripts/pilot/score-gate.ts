/** Gate scoring — phase 2 of the two-phase reducer (C5.1 closure item 3).
 *
 *  This half READS OUTCOMES, and its defining constraint is the mirror of the prepare phase's: it
 *  may look at every rank, and it may never alter what was frozen. The denominator arrives already
 *  hashed and is used as given — it is never recomputed here, never widened, never narrowed, and
 *  never derived from anything in a runner output.
 *
 *  Two different checks defend that, and neither is redundant. Recomputing the payload hash catches
 *  an EDITED gate set. Comparing it against the value the freeze pinned catches a WHOLLY
 *  RE-PREPARED one — an operator who had already seen the results could otherwise prepare a smaller
 *  denominator and hand over a perfectly self-consistent artifact.
 *
 *  Judgment conditions are INGESTED, not decided. §5a keeps target-relative contradiction a human
 *  call with both texts quoted; this phase validates that the adjudication is complete, unduplicated,
 *  free of uncertain calls, and bound to this exact gate set and run — then counts it.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isEntryPoint } from '../../src/entry-point.js';
import { lowerBound } from './binomial.js';
import { HIT1_MINIMUM, type GateSet } from './gate-set.js';

export interface RunResult {
  id: string; query: string; unambiguous: boolean;
  bestRank: number | null; hitAtK: boolean; hitAt1: boolean; returned: string[];
}

export interface ContradictionCall {
  probeId: string;
  verdict: 'none' | 'contradiction';
  returnedId?: string;
  targetText?: string;      // §5a requires BOTH sides quoted on a positive call
  returnedText?: string;
}

export interface StaleCall {
  probeId: string;
  verdict: 'none' | 'violation';
  closedId?: string;
  currentId?: string;
  note?: string;
}

/** The human judgments, bound to the artifacts they were made against. The two hashes are what
 *  stop a judgment set from being reused across runs — an adjudication of some other run's output
 *  is not evidence about this one. */
export interface Adjudication {
  artifact: string;
  gateSetSha256: string;
  runSha256: string;
  contradictions: ContradictionCall[];
  staleViolations: StaleCall[];
}

/** `id` is the machine key; `title` is the name the governance texts use, and it is what a
 *  release-block reason is written with — a reader of the report should see "Hit@1", not a slug. */
export interface Condition { id: string; title: string; label: string; pass: boolean; blocking: boolean; detail: string }

export interface GateScore {
  artifact: 'gate-score';
  gateSetSha256: string;
  payload: {
    rule: string;
    hit1: { x: number; n: number; pass: boolean; bound: number | null; label: string };
    recall: { x: number; n: number; pass: boolean; bound: number | null };
    o67: {
      cases: { probeId: string; identity: string; hit1Eligible: boolean;
        witnesses: { id: string; extraTerms: string[] }[];
        bestRank: number | null; hitAt1: boolean; hitAtK: boolean }[];
      label: string; blocking: false;
    };
    stale: { closerRelationships: number; label: string; pass: boolean; blocking: boolean; violations: StaleCall[] };
    contradictions: { pass: boolean; calls: ContradictionCall[] };
    stability: { pass: boolean; runSha256: string[] };
    conditions: Condition[];
    release: { blocked: boolean; reasons: string[] };
  };
  receipts: { scoredAt: string; attestation: string };
}

const fail = (code: string, detail: string): never => { throw new Error(`${code}: ${detail}`); };
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export const scoreGate = (input: {
  gateSet: GateSet;
  expectPayloadSha256: string;
  runs: string[];
  adjudication: Adjudication;
  now: () => string;
}): GateScore => {
  const { gateSet, expectPayloadSha256, runs, adjudication, now } = input;
  const p = gateSet.payload;

  if (sha256(JSON.stringify(p)) !== gateSet.payloadSha256) {
    fail('gate-set-tampered', 'the gate set\'s payload does not hash to the value recorded beside it');
  }
  if (gateSet.payloadSha256 !== expectPayloadSha256) {
    fail('gate-set-not-pinned', `this gate set's payload hashes to ${gateSet.payloadSha256}, but the freeze ` +
      `pinned ${expectPayloadSha256}. A self-consistent artifact is not the same as the frozen one: without ` +
      'this check, a denominator re-prepared after the results were visible would pass unnoticed');
  }
  if (runs.length !== 3) {
    fail('stability-needs-three-runs', `got ${runs.length}. Stability is one of the seven binding conditions ` +
      '(§5a), so three runs are required to score at all rather than being an optional extra');
  }

  const frozenIds = [...p.recallDenominator].sort(byCodeUnit);
  const parsed = runs.map((text, i) => {
    const results = (JSON.parse(text) as { results: RunResult[] }).results;
    const ids = results.map((r) => r.id).sort(byCodeUnit);
    if (!sameSet(ids, frozenIds)) {
      fail('run-probe-mismatch', `run ${i + 1} reports ${ids.length} probes and the frozen gate set holds ` +
        `${frozenIds.length}; a run over a different population cannot be scored against this denominator`);
    }
    return new Map(results.map((r) => [r.id, r]));
  });
  const runHashes = runs.map(sha256);
  const scored = parsed[0]!;

  if (adjudication.gateSetSha256 !== gateSet.payloadSha256 || adjudication.runSha256 !== runHashes[0]) {
    fail('adjudication-unbound', 'the adjudication does not name this gate set and this runner output. ' +
      'Judgments made against some other run are not evidence about this one');
  }
  const callIds = adjudication.contradictions.map((c) => c.probeId);
  if (new Set(callIds).size !== callIds.length) {
    fail('adjudication-duplicate', 'a probe is judged more than once for contradiction');
  }
  if (!sameSet([...callIds].sort(byCodeUnit), frozenIds)) {
    fail('adjudication-incomplete', `${callIds.length} contradiction judgments for ${frozenIds.length} probes; ` +
      'every probe needs one, or "contradictions = 0" means "0 among the probes somebody looked at"');
  }
  for (const c of adjudication.contradictions) {
    if (c.verdict !== 'none' && c.verdict !== 'contradiction') {
      fail('adjudication-uncertain', `probe ${c.probeId} is judged '${c.verdict}'. An unresolved judgment is ` +
        'a gate failure, never a pass by default');
    }
  }

  // The denominator is READ, never recomputed. Note in particular that a run result carries its own
  // `unambiguous` echo, which is deliberately ignored: it is outcome-side data, and deriving
  // eligibility from it would let the scored population depend on the run.
  const eligible = p.eligible.probeIds;
  const hit1x = eligible.filter((id) => scored.get(id)!.bestRank === 1).length;
  const hit1n = eligible.length;
  const hit1 = {
    x: hit1x, n: hit1n,
    pass: p.eligible.exposure >= HIT1_MINIMUM && hit1x === hit1n && hit1n > 0,
    bound: lowerBound(hit1x, hit1n),
    label: p.eligible.label,
  };

  const recallX = frozenIds.filter((id) => scored.get(id)!.hitAtK).length;
  const recall = { x: recallX, n: frozenIds.length, pass: recallX === frozenIds.length,
    bound: lowerBound(recallX, frozenIds.length) };

  const o67 = {
    cases: p.o67.cases.map((c) => {
      const r = scored.get(c.probeId)!;
      return { ...c, bestRank: r.bestRank, hitAt1: r.hitAt1, hitAtK: r.hitAtK };
    }),
    label: p.o67.label,
    blocking: false as const,
  };

  // §5a: `Es = 0` reports honestly and does not block — no minimum stale fixture is preregistered,
  // so an absence of churn must not become a release failure. Above zero, the v1 rubric applies
  // verbatim and any violation blocks.
  const exposed = p.stale.closerRelationships > 0;
  if (exposed) {
    const staleIds = adjudication.staleViolations.map((s) => s.probeId);
    if (!sameSet([...staleIds].sort(byCodeUnit), frozenIds)) {
      fail('adjudication-incomplete', `the corpus holds ${p.stale.closerRelationships} closer relationship(s), ` +
        'so every probe needs a stale-served-as-live judgment');
    }
  }
  const violations = adjudication.staleViolations.filter((s) => s.verdict === 'violation');
  const stale = { closerRelationships: p.stale.closerRelationships, label: p.stale.label,
    pass: violations.length === 0, blocking: exposed, violations };

  const calls = adjudication.contradictions.filter((c) => c.verdict === 'contradiction');
  const contradictions = { pass: calls.length === 0, calls };

  const stability = { pass: runHashes.every((h) => h === runHashes[0]), runSha256: runHashes };

  const conditions: Condition[] = [
    { id: 'recall-at-k', title: 'Recall@20', label: `${recall.x}/${recall.n}`, pass: recall.pass, blocking: true,
      detail: 'a regression tripwire, not evidence: the threshold is enormously slack, so a pass here ' +
        'must never be presented as evidence of recall quality' },
    { id: 'hit-at-1', title: 'Hit@1', label: `${hit1.x}/${hit1.n} ranked 1; ${hit1.label}`, pass: hit1.pass, blocking: true,
      detail: `${hit1.x}/${hit1.n} eligible rows ranked 1; minimum exposure ${HIT1_MINIMUM}` },
    { id: 'target-relative-contradiction', title: 'Target-relative contradiction', label: `${calls.length} call(s)`, pass: contradictions.pass, blocking: true,
      detail: 'internal retrieval coherence relative to the probe target — a construct change from v1, ' +
        'which asked whether retrieval agreed with an independently maintained human statement. It cannot ' +
        'show the target itself is correct, and must not be described as oracle validation' },
    { id: 'stale-served-as-live', title: 'Stale-served-as-live', label: stale.label, pass: stale.pass, blocking: exposed,
      detail: exposed ? `${violations.length} violation(s) against ${stale.closerRelationships} closer relationship(s)`
        : 'no closer relationships in the as-of-close snapshot, so the hazard could not arise' },
    { id: 'errors-unscorable', title: 'Errors / unscorable', label: 'none', pass: true, blocking: true,
      detail: 'structurally always true IN A REPORT THAT EXISTS: every pipeline check in the prepare and ' +
        'score phases fails closed, so a failure refuses the run instead of producing this file. The ' +
        'evidence for this condition is the absence of a refusal, recorded in the run log' },
    { id: 'stability', title: 'Stability', label: stability.pass ? 'identical' : 'divergent', pass: stability.pass, blocking: true,
      detail: 'payload hashes of three runner outputs; volatile audit receipts are excluded by construction' },
    { id: 'protocol-population-integrity', title: 'Protocol and population integrity', label: 'chain verified at this link', pass: true, blocking: true,
      detail: 'the gate set matches the freeze pin and the adjudication binds this gate set and this run. ' +
        'This is one link, not the whole chain: §5 also requires a freeze receipt, an as-of-close snapshot ' +
        'hash, and an append-only or externally attested prepare-before-run receipt, none of which a ' +
        'scoring program can attest to about itself' },
  ];

  // One reason per failing binding condition, written with the condition's governance-text name.
  // Hit@1 gets two possible wordings because the two failures are different facts: falling short of
  // the exposure FLOOR means the primary measurement did not happen, which is not the same as
  // having measured it and scored badly. §3b turns on exactly that distinction.
  const reasons: string[] = [];
  for (const c of conditions) {
    if (!c.blocking || c.pass) continue;
    reasons.push(c.id === 'hit-at-1' && p.eligible.exposure < HIT1_MINIMUM
      ? `${c.title} — exposure ${p.eligible.exposure} is below the minimum of ${HIT1_MINIMUM}, so the primary ` +
        `measurement did not happen (${hit1.label})`
      : `${c.title} — ${c.label}`);
  }

  const payload: GateScore['payload'] = {
    rule: p.rule, hit1, recall, o67, stale, contradictions, stability, conditions,
    release: { blocked: reasons.length > 0, reasons },
  };
  return {
    artifact: 'gate-score',
    gateSetSha256: gateSet.payloadSha256,
    payload,
    receipts: {
      scoredAt: now(),
      attestation: 'self-reported wall clock; the ordering evidence §5 requires lives in the provenance ' +
        'chain, not in this field',
    },
  };
};

const INPUTS = ['gate-set', 'expect-payload', 'run1', 'run2', 'run3', 'adjudication', 'out'] as const;
const USAGE = `usage: score-gate ${INPUTS.map((n) => `--${n} <${n === 'expect-payload' ? 'sha256' : 'path'}>`).join(' ')}`;

/** Named flags only, unknown flags refused — the same contract as the prepare phase, for the same
 *  reason. Three runs are three separate flags rather than a list, so "stability compares three
 *  runs" is a property of the interface. */
const parseFlags = (argv: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) {
      fail('bad-arguments', `expected --name <value> pairs, got '${String(flag)}'`);
    }
    const name = flag!.slice(2);
    if (!(INPUTS as readonly string[]).includes(name)) fail('unknown-input', `--${name} is not an input of the score phase`);
    if (name in out) fail('duplicate-input', `--${name} given more than once`);
    out[name] = value!;
  }
  for (const name of INPUTS) if (!(name in out)) fail('missing-input', `--${name} is required`);
  return out;
};

const main = (): void => {
  let flags: Record<string, string>;
  try { flags = parseFlags(process.argv.slice(2)); }
  catch (e) { console.error(`${(e as Error).message}\n${USAGE}`); process.exit(2); return; }
  const read = (p: string) => readFileSync(p, 'utf8');
  const score = scoreGate({
    gateSet: JSON.parse(read(flags['gate-set']!)) as GateSet,
    expectPayloadSha256: flags['expect-payload']!,
    runs: [read(flags.run1!), read(flags.run2!), read(flags.run3!)],
    adjudication: JSON.parse(read(flags.adjudication!)) as Adjudication,
    now: () => new Date().toISOString(),
  });
  writeFileSync(flags.out!, JSON.stringify(score, null, 1) + '\n');
  const { release } = score.payload;
  console.log(`Hit@1 ${score.payload.hit1.x}/${score.payload.hit1.n} (${score.payload.hit1.label}); ` +
    `Recall@K ${score.payload.recall.x}/${score.payload.recall.n}; O_67 ${score.payload.o67.label}\n` +
    (release.blocked ? `RELEASE BLOCKED:\n  ${release.reasons.join('\n  ')}` : 'RELEASE NOT BLOCKED by this gate'));
};
if (isEntryPoint(import.meta.url)) main();
