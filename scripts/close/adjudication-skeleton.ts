/** The adjudication PRODUCER — close-day artifact, phase 2.5 of the reducer.
 *
 *  `score-gate.ts` requires `--adjudication` and nothing in this repo has ever written one. The
 *  file is a set of HUMAN judgments (§5a keeps target-relative contradiction a human call with both
 *  texts quoted), so no program can decide its verdicts — but every part of it that is NOT a
 *  judgment is mechanical, and until now the operator had to hand-assemble all of it on close day:
 *  two 64-character hashes copied by eye, one entry per frozen probe id, no duplicates, no
 *  omissions. Each of those is a refusal in the score phase (`adjudication-unbound`,
 *  `adjudication-incomplete`, `adjudication-duplicate`), and each would be discovered AFTER the
 *  three runs are already on disk.
 *
 *  So this program stamps the mechanical half and leaves exactly the human half blank.
 *
 *  ─── Why the blanks are spelled `UNJUDGED` ────────────────────────────────────────────────────
 *
 *  Not `none`, which is a verdict. `UNJUDGED` is deliberately NOT one of the two values the score
 *  phase accepts (`score-gate.ts:437-442`), so an unfilled skeleton over a NON-EMPTY denominator
 *  handed to the gate is REFUSED with `adjudication-uncertain` rather than scored as a clean sweep.
 *  The failure mode this closes is the whole reason a skeleton is dangerous at all: a template
 *  pre-filled with `none` is a release-blocking condition pre-answered in the release's favour by
 *  the tool that generated it. An unfilled file must fail closed, and the gate's own refusal is what
 *  makes it do so.
 *
 *  The qualifier is load-bearing and the claim is false without it. `adjudication-uncertain` is
 *  raised by a LOOP over the contradiction calls (`score-gate.ts:437`), so a gate set whose frozen
 *  denominator is EMPTY yields an empty skeleton, the loop iterates nothing, and the gate ACCEPTS
 *  the unfilled file. Two things make that safe to emit rather than refuse. The verdict is still
 *  correct — with zero probes `eligible.exposure` is 0, below `HIT1_MINIMUM`, so Hit@1 cannot pass
 *  and the release is blocked by that condition instead (asserted against the real `scoreGate` in
 *  `test/close/adjudication-skeleton.test.ts`, not restated here as belief). And refusing would
 *  dead-end a state the run-sheet explicitly calls a result rather than a failure (an empty
 *  manifest), on a one-shot irreversible day, with `score-gate` requiring an `--adjudication` the
 *  operator would then have to hand-author under time pressure — the exact hazard this program
 *  exists to remove. So the emptiness is reported LOUDLY in the printed instructions instead, as
 *  what it most likely is: an upstream defect to go and check before scoring.
 *
 *  The honest boundary, stated because it is not symmetric: the score phase validates CONTRADICTION
 *  verdicts and does not validate STALE ones — `score-gate.ts:481` counts `violation` and ignores
 *  every other string, so a stale entry left `UNJUDGED` reads as "no violation" there. What
 *  protects an unfilled skeleton is therefore the contradictions check refusing the WHOLE FILE
 *  before the stale section is ever reached (`:437` runs before `:476`). Fill the contradictions
 *  and leave the stale set unjudged and that protection is gone — which is why the operator
 *  instructions this program prints say so in as many words.
 *
 *  ─── Why the hashes are recomputed, never copied ──────────────────────────────────────────────
 *
 *  `gateSetSha256` and `runPayloadSha256` are what stop a judgment set being reused across runs, so
 *  reading them out of the `payloadSha256` field each file records ABOUT ITSELF would bind the
 *  judgments to whatever a tampered file claims. Both are recomputed from the bytes on disk and
 *  then compared against the recorded value, which is exactly the pair of steps the score phase
 *  takes (`gate-set-tampered` at `score-gate.ts:138`, `run-tampered` at `:249`) — a skeleton that
 *  refused here is one refusal the operator does not meet three runs later.
 *
 *  `score-gate.ts` exports no hashing helper: its `sha256` is a module-local const
 *  (`score-gate.ts:124`) and the run payload hash is computed INLINE at `score-gate.ts:249` and
 *  `:404` as `sha256(JSON.stringify(run.payload))`. Neither can be imported, and score-gate is a
 *  pinned file that may not be edited to export them. So both are MIRRORED here, with those line
 *  numbers named so a future drift is greppable — `test/close/adjudication-skeleton.test.ts` drives
 *  the emitted skeleton through `scoreGate` itself, which is what actually holds the two together.
 *
 *  ─── Why this file is not in `scripts/pilot/`, and is pinned anyway ──────────────────────────
 *
 *  It sits outside `scripts/pilot/` because that directory is the FROZEN PILOT SURFACE — the
 *  programs the measured method runs — and this one runs on close day, after the measurement.
 *  The original reason given here was different and is now void: it said keeping close-day code
 *  out of that directory let the close report claim the pinned surface was untouched without
 *  qualification. Writing this file inside the first window reset that window instead, because the
 *  preregistration's Reset clause turns on the ACT of building the method's tooling and not on
 *  which directory receives it — a location cannot buy an exemption the rule never granted. So at
 *  the second freeze this path was added to `PINNED_TOOL_PATHS` (last row) and the surface it is
 *  outside of is now the pilot DIRECTORY, not the pinned SET.
 *
 *  Two consequences worth stating where they will be read. Editing this file during the window is
 *  now a mechanical freeze violation rather than a judgment call, which is the point. And the pin
 *  is `git hash-object` over these bytes, so this comment is part of what is sealed: correcting it
 *  after the freeze is itself the violation, which is why it is corrected here, before.
 *
 *  The three imports from `../pilot/` are read-only uses of pinned
 *  modules, and only one of them survives bundling: `artifact-io.js` is a VALUE import of the
 *  unguarded I/O module every pilot CLI shares, while `gate-set.js` (the artifact shapes) and
 *  `score-gate.js` (the two call shapes) are TYPE-ONLY imports — erased before bundling, so the
 *  guarded module `test/pilot/entry-point-isolation.test.ts` protects is never inlined into this
 *  entry point. The CLI test asserts this program's own usage line to hold that in place.
 */
import { createHash } from 'node:crypto';
import { isEntryPoint } from '../../src/entry-point.js';
import {
  exitOnInvocationError, flagAccumulator, invocationFail, parseJsonInput, readInput,
  refuseOutputCollisions, writeArtifact,
} from '../pilot/artifact-io.js';
import type { GateSet, RunArtifact } from '../pilot/gate-set.js';
import type { ContradictionCall, StaleCall } from '../pilot/score-gate.js';

/** The sentinel every verdict is stamped with. Its value matters: it must not be `none`, and it
 *  must not be anything `score-gate.ts:438` accepts. */
export const UNJUDGED = 'UNJUDGED';

/** A call as this program emits it — the pinned shape with its verdict widened by the sentinel.
 *  Widened rather than replaced, because a HALF-filled skeleton (some probes judged, some not) is
 *  the normal state of the file while the human is working through it. */
export type Unjudged<C extends { verdict: string }> =
  Omit<C, 'verdict'> & { verdict: C['verdict'] | typeof UNJUDGED };

/** Structurally an `Adjudication` (`score-gate.ts:71`) in every respect except the verdicts, which
 *  is the point: it is handed to the same gate, and the gate is what refuses it until it is
 *  filled in. */
export interface AdjudicationSkeleton {
  artifact: 'adjudication';
  gateSetSha256: string;
  runPayloadSha256: string;
  contradictions: Unjudged<ContradictionCall>[];
  staleViolations: Unjudged<StaleCall>[];
}

/** The two quoted sides §5a requires on a positive call. They are emitted as loud placeholders
 *  rather than as empty strings or omitted keys, because a `contradiction` verdict carries them
 *  into the signed score payload (`score-gate.ts:485-486`): an unfilled quote is then visible in
 *  the report as this exact text, instead of being an absence a reader has to notice.
 *
 *  They cannot be pre-filled. A `RunResult` (`gate-set.ts:98-101`) holds ids, ranks and the query —
 *  no row CONTENT at all — so the texts live only in the corpus, which this program does not read
 *  and the freeze pins. `returnedId` is the one side the run does supply. */
const UNQUOTED_TARGET = 'UNQUOTED — paste the target row text here (§5a requires both sides quoted)';
const UNQUOTED_RETURNED = 'UNQUOTED — paste the returned row text here (§5a requires both sides quoted)';

const fail = (code: string, detail: string): never => { throw new Error(`${code}: ${detail}`); };
// Mirrored from `score-gate.ts:124`, which does not export it. Same input discipline (utf8 decode
// of a `JSON.stringify` with no spacing), because a hash computed any other way binds nothing.
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The set difference an operator can act on, printed as ids rather than as a count. Empty sides are
 *  named as "none" so the line reads the same whichever side is at fault. */
const idDelta = (label: string, ids: string[]) =>
  `${label}: ${ids.length === 0 ? 'none' : [...new Set(ids)].sort(byCodeUnit).join(', ')}`;

/** Stamp the skeleton. The run arrives as TEXT rather than as a parsed object for the reason
 *  `score-gate.ts:230-236` gives: the hash recomputed here and the payload read afterwards then
 *  provably come from the same bytes. */
export const buildSkeleton = (input: { gateSet: GateSet; runText: string }): AdjudicationSkeleton => {
  const { gateSet, runText } = input;

  // §10 gives every artifact a self-naming field so a file is identified by its content and not by
  // the path it arrived on. The mirror of `not-a-run` / `not-an-adjudication` in the score phase:
  // without it a path typo handing over a run or a score becomes a hash mismatch reported against
  // the wrong artifact.
  if (gateSet.artifact !== 'gate-set') {
    fail('not-a-gate-set', `--gate-set identifies itself as '${String(gateSet.artifact)}', not 'gate-set'`);
  }
  // Shape before hash, and a kebab-case refusal rather than whatever `JSON.stringify` of the wrong
  // type happens to do downstream. A file that names itself a gate set and carries no payload object
  // hashes `undefined` — `createHash().update(undefined)` throws a raw TypeError with a Node stack at
  // exit 1, which is the failure class `artifact-io.ts:36-46` exists to eliminate: exit 1 is the
  // code reserved for "the artifacts disagree", and a structurally broken input is not that.
  if (!isObject(gateSet.payload)) {
    fail('gate-set-malformed', `--gate-set carries ${gateSet.payload === undefined ? 'no `payload`'
      : `a \`payload\` of type ${Array.isArray(gateSet.payload) ? 'array' : typeof gateSet.payload}`}. ` +
      'The frozen denominator, the stale exposure and the hash the judgments bind to all live in that ' +
      'object; there is nothing to stamp a skeleton from');
  }
  const gateSetSha256 = sha256(JSON.stringify(gateSet.payload));
  if (gateSetSha256 !== gateSet.payloadSha256) {
    fail('gate-set-tampered', 'the gate set\'s payload does not hash to the value recorded beside it. The ' +
      'skeleton would bind judgments to a recomputed hash the score phase is about to refuse anyway ' +
      '(`gate-set-tampered`, score-gate.ts:138), so it is refused here — before a human spends close day ' +
      'judging against it');
  }

  let run: RunArtifact;
  try { run = JSON.parse(runText) as RunArtifact; }
  catch (e) {
    return invocationFail('run-unparsable', `--run is not JSON (${(e as Error).message}). This names the ` +
      'flag, because a SyntaxError names no file at all');
  }
  if (run.artifact !== 'run') {
    fail('not-a-run', `--run identifies itself as '${String(run.artifact)}', not 'run'`);
  }
  // The mirror of the gate-set shape check, and for the same reason: the hash on the next line is
  // computed over this object, so an absent payload dies inside `createHash` as a TypeError instead
  // of being named here. `run-unidentified` (`score-gate.ts:255-265`) is the precedent — the score
  // phase added exactly this class of check after a missing `receipts` threw from the assembly.
  if (!isObject(run.payload)) {
    fail('run-malformed', `--run carries ${run.payload === undefined ? 'no `payload`'
      : `a \`payload\` of type ${Array.isArray(run.payload) ? 'array' : typeof run.payload}`}. ` +
      'The payload is the half the adjudication binds by hash, so there is nothing to bind to');
  }
  // Recomputed, never read from the file's own `payloadSha256`. That field is exactly what an
  // edited run leaves stale, and binding the judgments to it would bind them to a value no longer
  // describing any bytes. Mirrors `score-gate.ts:249`.
  const runPayloadSha256 = sha256(JSON.stringify(run.payload));
  if (runPayloadSha256 !== run.payloadSha256) {
    fail('run-tampered', '--run\'s payload does not hash to the value recorded beside it');
  }
  // The binding the adjudication is FOR: judgments made against a run of some other prepared gate
  // set are not evidence about this one. Refused here rather than deferred to `score-gate.ts:286`,
  // because a skeleton stamped from a foreign run is unusable and every judgment written into it
  // would be wasted work.
  if (run.payload.prepareSha256 !== gateSetSha256) {
    fail('run-not-bound-to-gate-set', `--run names prepare hash ${String(run.payload.prepareSha256)} and this ` +
      `gate set's payload hashes to ${gateSetSha256}`);
  }

  // `[...x]` on a non-iterable is "gateSet.payload.recallDenominator is not iterable" — a message
  // that names an expression rather than an artifact, at the exit code reserved for gate refusals.
  if (!isStringArray(gateSet.payload.recallDenominator)) {
    fail('gate-set-malformed', 'this gate set carries no `recallDenominator` array of probe ids (got ' +
      `${JSON.stringify(gateSet.payload.recallDenominator)}). That list IS the set of judgments an ` +
      'adjudication must carry one of each of (`score-gate.ts:433`), so no skeleton can be stamped over it');
  }
  const frozenIds = [...gateSet.payload.recallDenominator].sort(byCodeUnit);
  // Completeness and non-duplication are properties of the OUTPUT, and they can only be guaranteed
  // by construction if the input allows it: a denominator naming a probe twice makes
  // `adjudication-duplicate` and `adjudication-incomplete` mutually unsatisfiable. The two checks
  // read different things — `score-gate.ts:430` counts repeats among the CALLS themselves and
  // `:433` is the only one that compares the call set against this list — so one entry per id fails
  // the second and one entry per ENTRY fails the first. No skeleton over it is fillable and the
  // defect belongs to the freeze.
  if (new Set(frozenIds).size !== frozenIds.length) {
    fail('gate-set-malformed', 'recallDenominator names at least one probe more than once. One entry per id ' +
      'would then be judged twice (`adjudication-duplicate`) and one entry per ENTRY would not match the ' +
      'frozen list either — no adjudication over this gate set can satisfy both checks');
  }

  // Read before the emit, not during it: `stale.closerRelationships` decides whether a whole
  // section of the file exists, and an absent value silently taken as zero would emit a skeleton
  // with no stale set for a corpus that requires one — the operator would discover it as
  // `adjudication-incomplete` at scoring time, with no stale judgments made.
  const closerRelationships = gateSet.payload.stale?.closerRelationships;
  if (typeof closerRelationships !== 'number') {
    fail('gate-set-malformed', `this gate set carries no numeric \`stale.closerRelationships\` ` +
      `(got ${JSON.stringify(closerRelationships)}), so whether a stale-served-as-live judgment set is ` +
      'required cannot be decided. Treating an absent value as zero would omit the section the score phase ' +
      'then demands');
  }

  const results = run.payload.results;
  if (!Array.isArray(results)) {
    fail('run-malformed', `--run's payload carries no \`results\` array (got ` +
      `${JSON.stringify(results)}). Every skeleton entry is pre-filled from a result, so there is nothing ` +
      'to stamp from');
  }
  // Per-result shape, refused before the population comparison so the operator is told the file is
  // broken rather than that it measured the wrong probes. `run-pilot.ts:261` always emits `returned`,
  // so reaching this needs a hand-edited run whose `payloadSha256` was recomputed — which is exactly
  // the case that must not escape as `Cannot read properties of undefined (reading '0')`.
  for (const [i, r] of results.entries()) {
    if (!isObject(r) || typeof r.id !== 'string' || !isStringArray(r.returned)) {
      fail('run-malformed', `--run's result at index ${i} is not a probe result: it needs a string \`id\` ` +
        `and a \`returned\` array of ids (got id=${JSON.stringify(isObject(r) ? r.id : undefined)}, ` +
        `returned=${JSON.stringify(isObject(r) ? r.returned : undefined)}). \`returned\` is where this ` +
        'program reads the id it pre-fills, and the score phase reads the same results to compute every ' +
        'condition');
    }
  }
  const resultIds = results.map((r) => r.id).sort(byCodeUnit);
  if (!sameSet(resultIds, frozenIds)) {
    // Two counts would be EQUAL whenever the populations differ without differing in size — a
    // different id set of the same size, or a duplicated id — and a refusal that reads "2 and 2" is
    // one an operator has to disbelieve before they can act on it. So the difference is named.
    const frozenSet = new Set(frozenIds);
    const resultSet = new Set(resultIds);
    const seen = new Set<string>();
    const duplicated = resultIds.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    fail('run-probe-mismatch', `--run reports ${resultIds.length} probe result(s) and the frozen gate set ` +
      `holds ${frozenIds.length}. ` +
      `${idDelta('In the run but not in the frozen denominator', resultIds.filter((id) => !frozenSet.has(id)))}; ` +
      `${idDelta('in the denominator but not in the run', frozenIds.filter((id) => !resultSet.has(id)))}; ` +
      `${idDelta('reported more than once by the run', duplicated)}. ` +
      'The skeleton pre-fills each entry from that probe\'s result, and a run over a different population ' +
      'is one the score phase refuses in any case');
  }
  const byId = new Map(results.map((r) => [r.id, r]));

  // One entry per FROZEN id, in the frozen order — complete and unduplicated by construction, which
  // is the whole of what this program can guarantee about the judgments.
  const contradictions: Unjudged<ContradictionCall>[] = frozenIds.map((probeId) => {
    // The top-ranked candidate — a STARTING POINT for the judge, not the scope of the judgment.
    // §5a's rubric is "**a** returned live record that addresses the same proposition asserts the
    // negation" (`v2-preregistration-2026-07.md:142`), which spans every returned record in the
    // top-K, so the contradicting row may sit at any rank and `returnedId` must then be replaced.
    // Pre-filling rank 1 is what the run supplies for free; the printed instructions carry the scope,
    // because a field a program fills in is read as the field a program decided.
    //
    // The full list is deliberately NOT copied into the skeleton: the calls are carried verbatim into
    // the signed score payload (`score-gate.ts:485-486`) and hashed by `adjudicationSha256`, so
    // adding up to K ids per probe would change the artifact's shape on close day for evidence the
    // judge already has open in the run file (`payload.results[].returned`).
    //
    // `returned` is ordered by rank, so `[0]` is rank 1; a probe that returned nothing gets no key
    // rather than an empty string, because "nothing was returned" and "an unfilled field" are
    // different facts.
    const returnedId = byId.get(probeId)?.returned[0];
    return {
      probeId,
      verdict: UNJUDGED,
      ...(returnedId === undefined ? {} : { returnedId }),
      targetText: UNQUOTED_TARGET,
      returnedText: UNQUOTED_RETURNED,
    };
  });

  // §5a: the stale set is required only above zero (`score-gate.ts:473-480`). Emitting one below
  // zero exposure would invent judgments the gate does not ask for and cannot use, and emitting
  // none above it would make the file incomplete.
  const staleViolations: Unjudged<StaleCall>[] = closerRelationships > 0
    ? frozenIds.map((probeId) => ({ probeId, verdict: UNJUDGED }))
    : [];

  // Key order matches `Adjudication` (`score-gate.ts:71-77`). It is not load-bearing for the gate,
  // which hashes the PARSED object (`score-gate.ts:497`) — but that hash is order-SENSITIVE, so a
  // stable emission order is what makes two stampings of the same inputs produce the same
  // `adjudicationSha256` once the same judgments are written into them.
  return { artifact: 'adjudication', gateSetSha256, runPayloadSha256, contradictions, staleViolations };
};

/** What the operator must now do, printed to stdout. The skeleton is a half-finished artifact and
 *  the half that is missing is the half that decides a release condition, so the program says how
 *  many judgments are outstanding, what the two legal values are, what a positive call additionally
 *  requires, and where the fail-closed protection stops. */
export const renderInstructions = (skeleton: AdjudicationSkeleton, outPath: string): string => {
  const n = skeleton.contradictions.length;
  const s = skeleton.staleViolations.length;
  const lines = [`wrote ${outPath}`];
  if (n === 0) {
    // The one case where the fail-closed property does not hold, said in as many words rather than
    // left to a count of zero the operator has to interpret. Printed INSTEAD of the judgment
    // instructions, because every one of them would be false here: nothing is required, nothing is
    // UNJUDGED, and the gate will not refuse this file.
    lines.push('NO JUDGMENTS: this gate set\'s frozen denominator is EMPTY, so the skeleton carries no ' +
      'entries and there is nothing for a judge to decide.',
    'READ THIS AS A DEFECT SIGNAL, not as a clean file. The fail-closed property does NOT hold at zero ' +
      'probes: the score phase refuses an unfilled adjudication by iterating its contradiction calls ' +
      '(`score-gate.ts:437`), and with no calls it iterates nothing and ACCEPTS this file as it stands. ' +
      'The release verdict is still correct — zero probes puts `eligible.exposure` below the Hit@1 ' +
      'minimum, so the score blocks on the Hit@1 condition instead — but it is blocked by an exposure ' +
      'floor, not by any judgment. Before scoring, go back and confirm the manifest and the prepared ' +
      'gate set are what you meant to freeze: an empty denominator on close day is far more likely a ' +
      'defect upstream of this program than a real corpus.');
  } else {
    lines.push(`${n} contradiction judgment(s) required — one per frozen probe, complete and unduplicated ` +
      'by construction; do not add, remove or reorder entries.');
  }
  lines.push(s > 0
    ? `${s} stale-served-as-live judgment(s) required — the gate set counts closer relationships above ` +
      'zero, so §5a makes this condition binding and the score phase demands one entry per probe.'
    : 'No stale-served-as-live judgments: this gate set counts zero closer relationships, so the score ' +
      'phase requires no stale set and the hazard could not arise.');
  if (s > 0) {
    // The two ids are optional keys of the pinned `StaleCall` (`score-gate.ts:60-65`) and nothing
    // fills them: the run artifact carries ranks, not closer relationships. They are asked for here
    // because the score phase copies each violation VERBATIM into the signed payload
    // (`score-gate.ts:481-483`) and the close report reads those ids back out of it — a violation
    // recorded without them is a violation the report cannot name.
    lines.push('A \'violation\' call must ALSO name the pair it is about: set `closedId` to the closed record ' +
      'that was served and `currentId` to its current form. Neither can be pre-filled — the run artifact ' +
      'carries ids and ranks, not closer relationships — and the score phase copies each violation verbatim ' +
      'into the signed payload, which is where the close report reads the two ids from. A \'none\' verdict ' +
      'needs neither.');
  }
  if (n > 0) {
    lines.push(`Every verdict is written '${UNJUDGED}', which the score phase does NOT accept: replace each ` +
      'contradiction verdict with \'none\' or \'contradiction\' (until then the gate refuses the whole file ' +
      'with `adjudication-uncertain`)' +
      (s > 0 ? ', and each stale verdict with \'none\' or \'violation\'.' : '.'),
    'SCOPE of each contradiction judgment (§5a): the rubric is "A returned live record that addresses the ' +
      'same proposition asserts the negation of the probe target record\'s current statement" — A ' +
      'returned record, not the top-ranked one. Judge EVERY returned live record in that probe\'s top-K ' +
      'list, which the run artifact carries in full at `payload.results[].returned` (K is the k frozen in ' +
      'the gate set); this file pre-fills `returnedId` with rank 1 only because that is the one id the run ' +
      'hands over for free. If the contradicting record sits at another rank, REPLACE `returnedId` with ' +
      'that record\'s id — a pre-filled field is not a decided one, and leaving rank 1 in place would ' +
      'record a call against a row the judge did not make it about.',
    'A \'contradiction\' call must quote BOTH sides (§5a): replace targetText and returnedText with the ' +
      'actual row texts (the target row, and the record you judged against — not necessarily rank 1). They ' +
      'cannot be pre-filled — a run artifact carries ids and ranks, not row content — and an unreplaced ' +
      'placeholder is carried verbatim into the signed score payload.');
  }
  if (s > 0) {
    lines.push('WARNING — the fail-closed property is NOT symmetric: the score phase validates contradiction ' +
      'verdicts and ignores any stale verdict that is not \'violation\'. An unfilled skeleton is refused ' +
      'because of its CONTRADICTIONS; judge those and leave a stale entry unjudged and it will be counted ' +
      'as \'no violation\' silently. Judge both sets.');
  }
  lines.push('The two hashes bind this file to that gate set and that run. Do not edit them: if either input ' +
    'is replaced, re-stamp rather than hand-correct — and re-stamp to a NEW --out path, because this ' +
    'program refuses a pre-existing output (`output-exists`, exit 2) and will not overwrite this file. Do ' +
    'NOT delete this one to make room: if judgments have already been written into it, deleting it ' +
    'destroys that work, and the refusal deliberately never advises removing whatever is at the ' +
    'destination. Pass the new path to score-gate as --adjudication, and keep the superseded file — an ' +
    'artifact that existed is part of the close-day record.');
  return lines.join('\n');
};

const INPUTS = ['gate-set', 'run', 'out'] as const;
const USAGE = `usage: adjudication-skeleton ${INPUTS.map((n) => `--${n} <path>`).join(' ')}\n` +
  '  --run is the run whose payload the adjudication binds: pass the SAME file you will pass to\n' +
  '  score-gate as --run1, which is the run its adjudication check reads (score-gate.ts:425).';

/** Named flags only, unknown flags refused — the pilot CLIs' contract, kept identically so this
 *  program can be read by anyone who has read those. `flagAccumulator` and `Object.hasOwn` for the
 *  reasons `artifact-io.ts` records (finding X2). */
const parseFlags = (argv: string[]): Record<string, string> => {
  const out = flagAccumulator();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) {
      fail('bad-arguments', `expected --name <value> pairs, got '${String(flag)}'`);
    }
    const name = flag!.slice(2);
    if (!(INPUTS as readonly string[]).includes(name)) {
      fail('unknown-input', `--${name} is not an input of the adjudication producer`);
    }
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
    const runPath = { arg: '--run', path: flags.run! };
    // Before anything is read or hashed, §9 line 376: `--out <the run path>` would destroy the very
    // run this skeleton binds, and the recomputed hash would then name bytes that no longer exist.
    refuseOutputCollisions(out, [gateSetPath, runPath]);

    const skeleton = buildSkeleton({
      gateSet: parseJsonInput(gateSetPath, readInput(gateSetPath)) as GateSet,
      runText: readInput(runPath),
    });
    writeArtifact(out, JSON.stringify(skeleton, null, 1) + '\n');
    console.log(renderInstructions(skeleton, flags.out!));
  } catch (e) { exitOnInvocationError(e); }
};
if (isEntryPoint(import.meta.url)) main();
