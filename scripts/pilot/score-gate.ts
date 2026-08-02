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
 *  The same pair of checks is applied to each RUNNER OUTPUT, which now arrives as a run artifact
 *  rather than a bare result list. Recomputing its payload hash catches an edited run; comparing its
 *  `payload.prepareSha256` against this gate set catches a run measured against a different prepared
 *  denominator. Both are checked on all three runs, because stability establishes that the method
 *  behaved the same way three times and says nothing about WHICH method it was.
 *
 *  Three more identities are compared for the same reason, and each closes a way for a run to be
 *  scored under a method it was not executed under. `rule` and `k` are §10 frozen identities: a run
 *  declaring another rule would be silently re-labelled with this gate set's, and a run executed at
 *  another K returns a different candidate set entirely — the reviewer's K=100 run took Recall from
 *  0/2 to 2/2 on the same corpus while the report still said "Recall@20". `manifestSha256` closes
 *  the largest hole of the three: the gate set freezes a denominator of probe IDS, the manifest
 *  holds the QUERIES those ids stand for, and every id-level check here agrees with a manifest whose
 *  queries were swapped wholesale. Comparing the run's manifest hash against the one the freeze
 *  pinned is the only check in this phase that covers what was actually asked.
 *
 *  Stability compares PAYLOAD hashes, never file bytes. §9's chain requires each run to embed a run
 *  id and real wall clocks, so honest re-runs are never byte-identical; §4 reconciles that with the
 *  stability condition by splitting every artifact, and this phase is the half that consumes the
 *  split. That is why the runner's change and this one were a single change (§9b).
 *
 *  Judgment conditions are INGESTED, not decided. §5a keeps target-relative contradiction a human
 *  call with both texts quoted; this phase validates that the adjudication is complete, unduplicated,
 *  free of uncertain calls, and bound to this exact gate set and run — then counts it.
 */
import { createHash } from 'node:crypto';
import { isEntryPoint } from '../../src/entry-point.js';
import {
  exitOnInvocationError, flagAccumulator, invocationFail, parseJsonInput, readInput,
  refuseOutputCollisions, writeArtifact,
} from './artifact-io.js';
import { lowerBound } from './binomial.js';
import { HIT1_MINIMUM, type GateSet, type RunArtifact } from './gate-set.js';

// `RunResult` now lives in the declaration module, because the RUNNER produces it and this phase
// consumes it and neither guarded CLI may import the other. Re-exported so importers of this module
// keep working unchanged.
export type { RunResult, RunArtifact, RunPayload } from './gate-set.js';

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
  runPayloadSha256: string;
  contradictions: ContradictionCall[];
  staleViolations: StaleCall[];
}

/** `id` is the machine key; `title` is the name the governance texts use, and it is what a
 *  release-block reason is written with — a reader of the report should see "Hit@1", not a slug. */
export interface Condition { id: string; title: string; label: string; pass: boolean; blocking: boolean; detail: string }

/** `payloadSha256` exists because evidence-chain element 8 — the release record — binds the SCORE
 *  hash, and until now nothing produced one. The run ids are in `receipts` for the same reason the
 *  runner's are: §4 requires that re-running deterministic scoring against the same adjudication
 *  reproduce the same payload, which a payload carrying per-run identifiers could never do.
 *
 *  §9 item 7 asks for "a score artifact binding the prepare, runner and adjudication hashes", and
 *  all three are INSIDE the payload: `gateSetSha256`, `stability.runPayloadSha256` and
 *  `adjudicationSha256`. Placement is the whole of it — `payloadSha256` covers the payload and
 *  nothing else, so a copy of any of them in the envelope would be a provenance link the artifact's
 *  own hash does not stand behind, rewritable without disturbing verification. There is exactly one
 *  copy of each for the same reason two copies of a value drift and no reader can tell which one the
 *  hash covers.
 *
 *  `k` is in the payload because it is a §10 frozen identity that the report's own condition names
 *  ("Recall@20"). A title is prose; the number an auditor can check has to be a field. */
export interface GateScore {
  artifact: 'gate-score';
  payloadSha256: string;
  payload: {
    rule: string;
    k: number;
    gateSetSha256: string;
    adjudicationSha256: string;
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
    stability: { pass: boolean; runPayloadSha256: string[] };
    conditions: Condition[];
    release: { blocked: boolean; reasons: string[] };
  };
  receipts: { scoredAt: string; runIds: string[]; attestation: string };
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
    fail('gate-set-not-pinned', `this gate set's payload hashes to ${gateSet.payloadSha256}, but the value ` +
      `handed to this invocation as --expect-payload is ${expectPayloadSha256}. A self-consistent artifact ` +
      'is not the same as the expected one: without this check, a denominator re-prepared after the results ' +
      'were visible would pass unnoticed. This program cannot see where the expected value came from — its ' +
      'provenance (the freeze receipt, via the recorded gate-set hash) is the operator\'s to establish');
  }
  if (runs.length !== 3) {
    fail('stability-needs-three-runs', `got ${runs.length}. Stability is one of the seven binding conditions ` +
      '(§5a), so three runs are required to score at all rather than being an optional extra');
  }

  // Read once, before any run is examined. A gate set that pins no manifest hash cannot support the
  // `run-manifest-mismatch` check at all, and comparing a run's hash against `undefined` would be an
  // equality that can only hold when neither side exists — a check that passes exactly when it has
  // nothing to check. Refused here rather than blamed on a run, because the defect is in the freeze.
  const pinnedManifest = p.inputs?.manifest;
  if (typeof pinnedManifest !== 'string') {
    fail('gate-set-unpinned-manifest', 'this gate set pins no `inputs.manifest` hash, so there is nothing to ' +
      'check the runs\' manifest against. The frozen denominator is a set of probe IDS and the queries those ' +
      'ids stand for live in the manifest, so without that pin the phase cannot tell a run of the frozen ' +
      'question set from a run of any other one that happens to use the same ids');
  }

  // The CORPUS pins and the frozen disposition, read up front for the reason the manifest pin is:
  // the runner records the ledger hashes it verified and the disposition it resolved, and both are
  // compared per run below. An absent pin would make each of those comparisons an equality that can
  // only hold when neither side exists, so a freeze that did not pin them is refused here rather
  // than blamed on a run.
  const pinnedLedgers = { 'ledger:global': p.inputs?.['ledger:global'], 'ledger:project': p.inputs?.['ledger:project'] };
  for (const name of ['ledger:global', 'ledger:project'] as const) {
    if (typeof pinnedLedgers[name] !== 'string') {
      fail('gate-set-unpinned-ledger', `this gate set pins no \`inputs['${name}']\` hash, so there is nothing ` +
        'to check the runs\' corpus against. The gate set froze a denominator over specific ledger bytes, ' +
        'and without the pin the phase cannot tell a run of the frozen corpus from a run of any other one');
    }
  }
  // The TRUST surface and the EXPANSION table, pinned in the same map for the same reason: round 3
  // proved a macNonce swapped inside the registry re-scores signed verify rows, a planted witness
  // journal removes a whole scope, and an emptied neighbor table removes all query expansion —
  // each with both ledger pins green. The runner records what it verified; without the freeze-side
  // pin the comparison below would be a run checked against nothing.
  const TRUST_NAMES = ['ownership:registry', 'ownership:owner', 'trust:master-key', 'trust:witness'] as const;
  const pinnedTrust: Record<string, string> = {};
  for (const name of TRUST_NAMES) {
    const pin = p.inputs?.[name];
    // Expression position keeps `fail`'s `never` visible to the type system, the same reason
    // methodFromFreeze spells its refusals `return fail(...)`.
    pinnedTrust[name] = typeof pin === 'string' ? pin
      : fail('gate-set-unpinned-trust', `this gate set pins no \`inputs['${name}']\` value, so there is ` +
        'nothing to check the runs\' trust surface against — and identical ledger bytes still rank ' +
        'differently under a substituted registry nonce, master key or witness state');
  }
  const pinnedExpansion = p.inputs?.['expansion:semantic-neighbors'];
  if (typeof pinnedExpansion !== 'string') {
    fail('gate-set-unpinned-expansion', 'this gate set pins no `inputs[\'expansion:semantic-neighbors\']` ' +
      'value, so there is nothing to check the runs\' resolved expansion table against — and an emptied ' +
      'table ranks deterministically wrong, passing Stability three times in a row');
  }
  const pinnedDisposition = p.disclosure?.projectDisposition;
  if (typeof pinnedDisposition !== 'string') {
    fail('gate-set-unpinned-disposition', 'this gate set carries no `disclosure.projectDisposition`, so ' +
      'there is nothing to check the runs\' recorded ownership disposition against — and two corpora with ' +
      'identical ledger bytes can still differ in which scopes participate');
  }

  const frozenIds = [...p.recallDenominator].sort(byCodeUnit);

  // The gate set's OTHER two id sets, validated against the denominator BEFORE any scoring: the
  // Hit@1, Recall and o67 sites all do `scored.get(id)!`, and `sameSet` below covers
  // `recallDenominator` only. A re-hashed gate set whose `eligible.probeIds` or `o67.cases` named a
  // ghost id — handed over with --expect-payload set to its own hash, the exact adversary
  // `gate-set-not-pinned` is written against — otherwise dies in a raw TypeError with a stack,
  // which is neither a refusal nor a verdict.
  const frozen = new Set(frozenIds);
  for (const id of p.eligible.probeIds) {
    if (!frozen.has(id)) {
      fail('gate-set-malformed', `eligible.probeIds names ${id}, which is not in recallDenominator. The ` +
        'eligible set is a subset of the frozen denominator by construction, so a gate set violating that ' +
        'was not produced by the prepare phase and cannot be scored');
    }
  }
  for (const c of p.o67.cases) {
    if (!frozen.has(c.probeId)) {
      fail('gate-set-malformed', `o67.cases names ${c.probeId}, which is not in recallDenominator. The o67 ` +
        'census is drawn from the frozen probe set by construction, so a gate set violating that was not ' +
        'produced by the prepare phase and cannot be scored');
    }
  }
  const parsed = runs.map((text, i) => {
    // A run file that is not JSON is a PATH problem, not a gate refusal. It used to escape as a
    // bare `SyntaxError` naming neither the run nor the file, and exited 1 — the code an operator's
    // script reads as "the gate says no" (finding X3). The runs arrive as TEXT rather than as
    // parsed objects so the hash recomputed below and the payload read afterwards provably come
    // from the same bytes, which is why the parse happens here and not in `main`.
    let run: RunArtifact;
    try { run = JSON.parse(text) as RunArtifact; }
    catch (e) {
      return invocationFail('run-unparsable', `--run${i + 1} is not JSON (${(e as Error).message}). ` +
        'This names the flag, because a SyntaxError names no file at all and this phase is handed three');
    }
    // §10 gives every artifact a self-naming `artifact` field precisely so a file is identified by
    // its content and not by the path it arrived on. Reading whatever shape turns up would waste
    // that: a mistyped path is then reported as a binding or population failure, and the operator
    // goes looking for a problem in the wrong artifact.
    if (run.artifact !== 'run') {
      fail('not-a-run', `run ${i + 1} identifies itself as '${String(run.artifact)}', not 'run'`);
    }
    if (sha256(JSON.stringify(run.payload)) !== run.payloadSha256) {
      fail('run-tampered', `run ${i + 1}'s payload does not hash to the value recorded beside it. The mirror ` +
        'of the gate-set check: an edited run whose recorded hash was left behind would be scored under a ' +
        'value that no longer describes it, and the adjudication and §9 chain would then bind a hash naming ' +
        'bytes nobody ran');
    }
    // Identifying the EXECUTION is a refusal, not a nicety. It is the only field that tells three
    // runs apart, so a run without one cannot be distinguished from a copy of another — and until
    // this check existed a missing `receipts` threw a raw TypeError from the receipts assembly at
    // the very end, after the verdict had already been computed.
    const runId = run.receipts?.runId;
    if (typeof runId !== 'string' || runId.length === 0) {
      fail('run-unidentified', `run ${i + 1} carries ${run.receipts === undefined ? 'no receipts at all'
        : `a runId of '${String(runId)}'`}. §9 item 5 requires every runner output to embed a run id, and ` +
        'Stability is a claim about three EXECUTIONS — with nothing identifying which execution produced ' +
        'this file, three copies of one run and three real runs are the same input to this phase');
    }
    // §10 pins `rule` and K as frozen method identities, and the phase already honours the
    // self-naming `artifact` field on this same object. Reading one and ignoring the others means a
    // run produced under a different method is scored and then REPORTED under this gate set's rule
    // and this gate set's K — the report would name a method the run never claimed to be.
    if (run.payload.rule !== p.rule) {
      fail('run-rule-mismatch', `run ${i + 1} declares rule '${String(run.payload.rule)}' and this gate set ` +
        `was frozen under '${p.rule}'. The score reports the gate set's rule, so accepting this run would ` +
        'relabel it rather than reconcile it, and the report would attribute the numbers to a method that ' +
        'did not produce them');
    }
    if (run.payload.k !== p.k) {
      fail('run-k-mismatch', `run ${i + 1} was executed at K=${String(run.payload.k)} and the freeze pinned ` +
        `K=${p.k}. K decides how many candidates each probe returns, so a wider run puts targets inside the ` +
        'cut that the frozen K excludes: Recall is then measured at one K and reported at another, and the ' +
        'condition title alone would still read as the frozen one');
    }
    // Checked on EVERY run, not only the one the adjudication names. Stability answers "did the
    // method behave the same way three times", never "was it this method" — three mutually
    // consistent runs of a denominator prepared after the outcomes were visible would otherwise
    // score against the pinned gate set and look flawless.
    if (run.payload.prepareSha256 !== gateSet.payloadSha256) {
      fail('run-not-bound-to-gate-set', `run ${i + 1} names prepare hash ${String(run.payload.prepareSha256)}, ` +
        `but this gate set's payload hashes to ${gateSet.payloadSha256}. A run measured against a different ` +
        'prepared gate set is not evidence about this one');
    }
    // The queries, which no other check in this phase reaches. `run-probe-mismatch` below compares
    // probe IDS, and ids are exactly the part of a manifest a query swap does not have to touch: two
    // manifests identical in k, probe id and `relevant` and differing only in `query` produce
    // different ranks, satisfy every id-level check here, and flip the verdict.
    if (run.payload.manifestSha256 !== pinnedManifest) {
      fail('run-manifest-mismatch', `run ${i + 1} was measured against manifest ` +
        `${String(run.payload.manifestSha256)} and the freeze pinned ${pinnedManifest}. The frozen gate set ` +
        'fixes WHICH probes are scored; the manifest fixes WHAT each of them asks, and a run over a ' +
        'different question set is not evidence about the frozen one however well its ids line up');
    }
    // The CORPUS, which no hash above covers: `prepareSha256` names the frozen denominator and
    // `manifestSha256` the questions, and a run measured against a substituted snapshot — same gate
    // set, same manifest, one decoy row removed — satisfies both. The runner records the ledger
    // hashes it verified; a record disagreeing with the freeze's pins means the ranks were taken
    // against a corpus the freeze never saw.
    for (const name of ['ledger:global', 'ledger:project'] as const) {
      const recorded = run.payload.ledgers?.[name];
      if (recorded !== pinnedLedgers[name]) {
        fail('run-snapshot-mismatch', `run ${i + 1} records ${name} as ` +
          `${typeof recorded === 'string' ? recorded : 'nothing at all'} and the freeze pinned ` +
          `${String(pinnedLedgers[name])}. A run against other corpus bytes measures a different question ` +
          'under the frozen denominator\'s name, and an absent record is refused rather than compared ' +
          'against nothing');
      }
    }
    for (const name of TRUST_NAMES) {
      const recorded = run.payload.trust?.[name];
      if (recorded !== pinnedTrust[name]) {
        fail('run-snapshot-mismatch', `run ${i + 1} records ${name} as ` +
          `${typeof recorded === 'string' ? recorded : 'nothing at all'} and the freeze pinned ` +
          `${String(pinnedTrust[name])}. The trust surface decides how identical rows are SCORED — a ` +
          'swapped registry nonce or witness state re-ranks the same corpus — and an absent record is ' +
          'refused rather than compared against nothing');
      }
    }
    // The OWNERSHIP surface: identical ledger bytes still rank differently when the project scope
    // does not participate (home/projects.json absent degrades recall to global-only). The runner
    // resolves and records the disposition; the freeze disclosed one. Disagreement means the run
    // ranked against a different participating corpus.
    if (run.payload.projectDisposition !== pinnedDisposition) {
      fail('run-disposition-mismatch', `run ${i + 1} records project disposition ` +
        `'${String(run.payload.projectDisposition)}' and the freeze disclosed '${pinnedDisposition}'`);
    }
    // The EXPANSION surface: a bundle whose neighbor table differs — emptied included — ranks
    // deterministically WRONG, so three degraded runs agree with each other and pass Stability.
    // Round 3 proved an availability boolean is not the signal (an empty table resolves cleanly
    // and records true); the record is the resolved table's CONTENT hash, and it must be the
    // pinned one. An absent record is refused, never compared against nothing.
    if (run.payload.expansionSha256 !== pinnedExpansion) {
      fail('run-expansion-mismatch', `run ${i + 1} records the resolved expansion table as ` +
        `${typeof run.payload.expansionSha256 === 'string' ? run.payload.expansionSha256 : 'nothing at all'} ` +
        `and the freeze pinned ${String(pinnedExpansion)}. Ranks taken under a different table are a ` +
        'different method wearing the frozen denominator\'s name');
    }
    const results = run.payload.results;
    const ids = results.map((r) => r.id).sort(byCodeUnit);
    if (!sameSet(ids, frozenIds)) {
      fail('run-probe-mismatch', `run ${i + 1} reports ${ids.length} probes and the frozen gate set holds ` +
        `${frozenIds.length}; a run over a different population cannot be scored against this denominator`);
    }
    // Internal coherence of each result, refused rather than scored: Hit@1 reads `bestRank`, Recall
    // reads `hitAtK`, o67 echoes `hitAt1`, and with no cross-check a run claiming `bestRank: 1,
    // hitAt1: false, hitAtK: false, returned: []` produced a signed report asserting "every probe
    // ranked 1" and "no probe in the top 20" simultaneously.
    for (const r of results) {
      const inconsistent = (field: string, why: string) =>
        fail('run-inconsistent', `run ${i + 1} probe ${r.id}: ${field} — ${why}. The three condition ` +
          'readers each consume a different field of this result, so an internal contradiction would be ' +
          'reported as two mutually exclusive verdicts in one signed artifact');
      if (r.hitAt1 !== (r.bestRank === 1)) {
        inconsistent('hitAt1', `hitAt1 is ${String(r.hitAt1)} but bestRank is ${String(r.bestRank)}`);
      }
      if (r.hitAtK !== (r.bestRank !== null && r.bestRank <= p.k)) {
        inconsistent('hitAtK', `hitAtK is ${String(r.hitAtK)} but bestRank is ${String(r.bestRank)} ` +
          `against K=${p.k}`);
      }
      if (r.bestRank !== null && r.bestRank > r.returned.length) {
        inconsistent('bestRank', `bestRank is ${r.bestRank} but only ${r.returned.length} id(s) were returned`);
      }
      if (r.returned.length > p.k) {
        inconsistent('returned', `${r.returned.length} ids returned at K=${p.k}`);
      }
    }
    // `runId as string` is safe by the refusal above, which `fail`'s `never` return type does not
    // narrow for the compiler.
    return { run, runId: runId as string, byId: new Map(results.map((r) => [r.id, r])) };
  });

  // §4 says "run the runner three times", and three FILES are not three RUNS. Without this, one run
  // copied three times — or the same path given as --run1 --run2 --run3 — scored as a perfect
  // Stability pass over a single execution. What this check establishes is deliberately narrow:
  // three DISTINCT SELF-DECLARED run ids, no more. `receipts.runId` sits outside every hash and
  // nothing signs a run, so one execution copied three times with three edited run ids passes it —
  // the evidence that could ground the stronger "three executions" claim is the ordering receipt's
  // chain (§9 item 4), which this phase does not read. The stability condition's detail states the
  // same boundary, because a report claiming more than its checks establish is itself a defect.
  const runIds = parsed.map((x) => x.runId);
  if (new Set(runIds).size !== runIds.length) {
    fail('runs-not-distinct', `the three runs report run ids [${runIds.join(', ')}]. Stability is the claim ` +
      'that three separate executions produced the same payload; comparing a run against itself asserts ' +
      'only that copying a file preserves its contents');
  }

  // Stability compares PAYLOAD hashes, not file bytes. §9 requires every runner output to carry its
  // own run id and real wall clocks, so three honest re-runs are never byte-identical; comparing
  // files would fail the Stability condition on every correct execution.
  //
  // Recomputing here catches NOTHING that is not already caught, and an earlier version of this
  // comment claimed it stopped a run from asserting its own stability. It does not: by this line
  // `run-tampered` has proved, for all three runs, that the recorded hash equals the recomputed one,
  // so the two are interchangeable. What actually makes stability un-assertable is that earlier
  // check. This form is kept only so the compared value visibly derives from the payload rather than
  // from a field a file supplies about itself.
  const runHashes = parsed.map((x) => sha256(JSON.stringify(x.run.payload)));
  const scored = parsed[0]!.byId;

  // The mirror of `not-a-run`, for the reason §10 gives every artifact a self-naming field: a file
  // is identified by its content, not by the path it arrived on. `Adjudication` declared `artifact`
  // and nothing read it, so a path typo handing over the gate score or the gate set itself was
  // taken as a judgment set and reported as a binding failure somewhere else.
  if (adjudication.artifact !== 'adjudication') {
    fail('not-an-adjudication', `the adjudication file identifies itself as ` +
      `'${String(adjudication.artifact)}', not 'adjudication'`);
  }
  // A RENAME, not a relocation: `runSha256` hashed the whole runner file and `runPayloadSha256`
  // hashes the deterministic payload, so the two can never hold the same value for the same run.
  // An adjudication authored under the old contract is refused by name rather than reinterpreted —
  // reading it as the new field would bind human judgments to a hash the gate no longer uses, and
  // the operator would have no way to tell which of the two the judge actually looked at.
  if ('runSha256' in adjudication) {
    fail('adjudication-legacy-field', 'this adjudication carries `runSha256`, the pre-split field that hashed ' +
      'the whole runner FILE. It is now `runPayloadSha256` and it hashes the deterministic PAYLOAD; the ' +
      'meaning changed, so the file must be re-issued against this contract rather than reread under it');
  }
  if (adjudication.gateSetSha256 !== gateSet.payloadSha256 || adjudication.runPayloadSha256 !== runHashes[0]) {
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

  const stability = { pass: runHashes.every((h) => h === runHashes[0]), runPayloadSha256: runHashes };

  // Hashed from the PARSED object rather than the file's bytes. §4 requires that re-running
  // deterministic scoring against the same adjudication reproduce the same payload, and the file is
  // a hand-authored artifact — re-indenting it, rewrapping a quoted line, or changing its trailing
  // newline must not change the score. Parsing first makes the hash insensitive to exactly that.
  // It is NOT insensitive to key ORDER, which `JSON.parse` preserves, and that is the honest
  // boundary: nothing here can tell a re-serialization apart from an edit, so a reordered file is
  // treated as a different adjudication rather than assumed to be the same one.
  const adjudicationSha256 = sha256(JSON.stringify(adjudication));

  const conditions: Condition[] = [
    // Titled from the FROZEN k, never from a literal: the title is what a release-block reason is
    // written with, and a hardcoded "Recall@20" over a gate set frozen at another K would report the
    // wrong measurement under the right name.
    { id: 'recall-at-k', title: `Recall@${p.k}`, label: `${recall.x}/${recall.n}`, pass: recall.pass, blocking: true,
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
      detail: 'payload hashes of three runner outputs, recomputed here rather than read from the files. The ' +
        'run id and wall clocks §9 requires every run to carry live in its receipts and are excluded from the ' +
        'comparison by construction, so three honest re-runs agree here while never being byte-identical files. ' +
        'That the three are distinct EXECUTIONS rests on three distinct self-declared run ids and nothing ' +
        'more — the ids are outside every hash and nothing signs a run; the evidence that could ground the ' +
        'stronger claim is the ordering receipt\'s chain (§9 item 4), which this phase does not read' },
    { id: 'protocol-population-integrity', title: 'Protocol and population integrity', label: 'chain verified at this link', pass: true, blocking: true,
      detail: 'the gate set matches the freeze pin; all three runs name it, its manifest, its rule and its K; ' +
        'and the adjudication binds this gate set and this run. The prepare, runner and adjudication hashes ' +
        'this file asserts are inside its own hashed payload, so they cannot be rewritten without breaking ' +
        'payloadSha256. This is one link, not the whole chain: §9 also requires a freeze receipt, an ' +
        'as-of-close snapshot hash, and an append-only or externally attested prepare-before-run receipt, ' +
        'none of which a scoring program can attest to about itself' },
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

  // Key order is fixed by construction because this object is hashed.
  const payload: GateScore['payload'] = {
    rule: p.rule, k: p.k, gateSetSha256: gateSet.payloadSha256, adjudicationSha256,
    hit1, recall, o67, stale, contradictions, stability, conditions,
    release: { blocked: reasons.length > 0, reasons },
  };
  return {
    artifact: 'gate-score',
    payloadSha256: sha256(JSON.stringify(payload)),
    payload,
    receipts: {
      scoredAt: now(),
      // The three SELF-DECLARED run ids that were scored — retained evidence, deliberately outside
      // the hash, and an identification only as strong as the ids' own attestation (none).
      runIds,
      attestation: 'self-reported wall clock; the ordering evidence §9 item 4 requires lives in the ' +
        'provenance chain, not in this field',
    },
  };
};

const INPUTS = ['gate-set', 'expect-payload', 'run1', 'run2', 'run3', 'adjudication', 'out'] as const;
const USAGE = `usage: score-gate ${INPUTS.map((n) => `--${n} <${n === 'expect-payload' ? 'sha256' : 'path'}>`).join(' ')}`;

/** Named flags only, unknown flags refused — the same contract as the prepare phase, for the same
 *  reason. Three runs are three separate flags rather than a list, so "stability compares three
 *  runs" is a property of the interface.
 *
 *  Naming the slots does not constrain the value handed to `--out`, though: `--out <the run1 path>`
 *  destroyed a run this score binds. `refuseOutputCollisions` in `main` is what closes that
 *  (§9 line 376), and it runs before a single hash is recomputed. */
const parseFlags = (argv: string[]): Record<string, string> => {
  const out = flagAccumulator();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) {
      fail('bad-arguments', `expected --name <value> pairs, got '${String(flag)}'`);
    }
    const name = flag!.slice(2);
    if (!(INPUTS as readonly string[]).includes(name)) fail('unknown-input', `--${name} is not an input of the score phase`);
    // `Object.hasOwn`, never `in`: `in` walks Object.prototype (finding X2).
    if (Object.hasOwn(out, name)) fail('duplicate-input', `--${name} given more than once`);
    out[name] = value!;
  }
  for (const name of INPUTS) if (!Object.hasOwn(out, name)) fail('missing-input', `--${name} is required`);
  return out;
};

const main = (): void => {
  let flags: Record<string, string>;
  try { flags = parseFlags(process.argv.slice(2)); }
  catch (e) { console.error(`${(e as Error).message}\n${USAGE}`); process.exit(2); return; }

  try {
    const out = { arg: '--out', path: flags.out! };
    const gateSetPath = { arg: '--gate-set', path: flags['gate-set']! };
    const adjudicationPath = { arg: '--adjudication', path: flags.adjudication! };
    const runPaths = (['run1', 'run2', 'run3'] as const).map((f) => ({ arg: `--${f}`, path: flags[f]! }));
    refuseOutputCollisions(out, [gateSetPath, ...runPaths, adjudicationPath]);

    const score = scoreGate({
      gateSet: parseJsonInput(gateSetPath, readInput(gateSetPath)) as GateSet,
      expectPayloadSha256: flags['expect-payload']!,
      // The runs arrive as TEXT and are parsed inside `scoreGate`, so the hash it recomputes and the
      // payload it reads provably come from the same bytes.
      runs: runPaths.map(readInput),
      adjudication: parseJsonInput(adjudicationPath, readInput(adjudicationPath)) as Adjudication,
      now: () => new Date().toISOString(),
    });
    writeArtifact(out, JSON.stringify(score, null, 1) + '\n');
    const { release } = score.payload;
    console.log(`Hit@1 ${score.payload.hit1.x}/${score.payload.hit1.n} (${score.payload.hit1.label}); ` +
      `Recall@K ${score.payload.recall.x}/${score.payload.recall.n}; O_67 ${score.payload.o67.label}\n` +
      // Printed because evidence-chain element 8 binds this value: the release record names it.
      `payload sha256: ${score.payloadSha256}\n` +
      (release.blocked ? `RELEASE BLOCKED:\n  ${release.reasons.join('\n  ')}` : 'RELEASE NOT BLOCKED by this gate'));
  } catch (e) { exitOnInvocationError(e); }
};
if (isEntryPoint(import.meta.url)) main();
