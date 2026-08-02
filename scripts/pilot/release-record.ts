/** The release record — element 8 of the preregistration's evidence chain (§9).
 *
 *  Every other artifact in the chain records HOW the measurement was made. This one records
 *  WHETHER ANYONE OBEYED IT. §9a demands "evidence that the declared consequence was actually
 *  applied: if the gate blocked, what was not released; if it passed, the release that followed and
 *  its record", and nothing in the pipeline produced such a file.
 *
 *  The failure it exists to catch is the one that matters most in the whole chain: a gate that
 *  blocked, followed by a release anyway. A perfectly scored gate that is then ignored leaves no
 *  trace in any other artifact — the score file says `blocked: true` forever, and the release
 *  happens somewhere the score file cannot see.
 */
import { createHash } from 'node:crypto';
import { isEntryPoint } from '../../src/entry-point.js';
import {
  exitOnInvocationError, flagAccumulator, readJsonInput, refuseOutputCollisions, writeArtifact,
} from './artifact-io.js';
import { RULE } from './gate-set.js';

export type Decision = 'released' | 'blocked';

export interface ReleaseRecordPayload {
  rule: string;
  artifactKind: 'release-record';
  scoreSha256: string;
  /** The `chain` value of the LAST line of the ordering log (element 4), as of this record. */
  orderingHead: string;
  gateBlocked: boolean;
  gateReasons: string[];
  decision: Decision;
  consequence: string;
  evidence: string;
}

export interface ReleaseRecord {
  artifact: 'release-record';
  payloadSha256: string;
  payload: ReleaseRecordPayload;
  receipts: { recordedAt: string; attestation: string };
}

/** The minimal shape this program needs from a `gate-score` file — DECLARED HERE, not imported.
 *
 *  `score-gate.ts` is entry-point-guarded, so importing it (even `import type`) is forbidden: the
 *  guard does not survive bundling and the bundled release-record CLI would run the scorer's
 *  `main()`. See `test/pilot/entry-point-isolation.test.ts`.
 *
 *  That constraint pushes toward the stronger design anyway. The score arrives from DISK. A shared
 *  compile-time type would check nothing about those bytes — `JSON.parse(...) as GateScore` is an
 *  assertion, not a validation — so every field below is verified at runtime before it is read. */
interface ScoreFile {
  artifact: string;
  payloadSha256: string;
  payload: { rule: string; release: { blocked: boolean; reasons: string[] } };
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const fail = (code: string, detail: string): never => { throw new Error(`${code}: ${detail}`); };

/** The canonical spelling of every hash in this chain: 64 LOWERCASE hex. Uppercase is refused
 *  rather than folded, here and in `ordering-receipt.ts`, for the same reason — these values are
 *  recorded verbatim and compared as strings, so two spellings of one digest stop matching. */
const HEX64 = /^[0-9a-f]{64}$/;

/** Exactly two decisions, matched case-sensitively and exactly. Anything else is refused rather
 *  than folded into the safer-looking branch: a record that quietly reads `not released` out of an
 *  unrecognised word would report a block nobody declared. */
const DECISIONS = new Set(['released', 'blocked']);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Does this string carry at least one character with semantic content?
 *
 *  `trim() !== ''` was the obvious spelling and it is not enough: `trim()` strips White_Space, so a
 *  `--consequence` of U+200B (ZERO WIDTH SPACE — category Cf, not Zs, since Unicode 4.0.1) or
 *  U+FEFF went through and produced a valid, hashed release record carrying no information. That is
 *  the outcome `consequence-unevidenced` itself calls "worse than an absent one", so the property to
 *  test is CONTENT, not spacing: at least one code point outside White_Space, the format controls
 *  (Cf: zero-width spaces, joiners, bidi marks, U+FEFF) and the C0/C1 controls (Cc).
 *
 *  What it deliberately does NOT do: judge whether the visible characters MEAN anything. `-` passes,
 *  and so does a character that is assigned but renders blank (U+3164 HANGUL FILLER, U+2800 BRAILLE
 *  PATTERN BLANK). A rule that tried to chase every such character would start refusing legitimate
 *  records — a bare tag name is a sound answer to "what was not released" — and no rule expressible
 *  here separates a poor answer from a good one. This closes the class where the field is
 *  MECHANICALLY empty while looking filled; the reader still has to read what it says. */
const hasContent = (s: string): boolean => /[^\p{White_Space}\p{Cf}\p{Cc}]/u.test(s);

/** Validate an arbitrary parsed JSON value into the score shape, or refuse.
 *
 *  No field is TRUSTED here — the two `as` casts below stand downstream of a runtime check that has
 *  already rejected everything they exclude, and are explained where they appear. The file arrives
 *  from disk and may have been hand-edited between scoring and recording, which is the whole window
 *  this element covers, so every field is checked before it is read and a shape that does not check
 *  out is refused rather than read through. `undefined.reasons` would otherwise surface as a
 *  TypeError with no stable code, and an operator cannot tell a crash from a refusal. */
const validatedScore = (raw: unknown): ScoreFile => {
  if (!isObject(raw)) fail('score-malformed', `the score file parsed to ${raw === null ? 'null' : typeof raw}, ` +
    'not an object; there is nothing here to bind a release record to');
  const s = raw as Record<string, unknown>;

  if (s.artifact !== 'gate-score') {
    fail('score-not-a-gate-score', `this file names itself '${String(s.artifact)}'. §10 requires every ` +
      'artifact to name its own kind precisely so a file identifies itself without reference to a ' +
      'filename, so the name is trusted over the path it was found at — and this is not a score');
  }
  // §10 again: an unhashed score cannot be BOUND to. `scoreSha256` would have to be invented, and
  // a record naming no identifiable score satisfies element 8 in form while binding nothing.
  if (s.payloadSha256 === undefined) {
    fail('score-unhashed', 'the score carries no payloadSha256. Element 8 of the evidence chain is a ' +
      'record BINDING THE SCORE HASH; with no hash there is nothing to bind, and a record that names ' +
      'a score it cannot identify is worse than none');
  }
  // A DIFFERENT failure, under its own slug, because it is a different fact about the file and the
  // operator acts on it differently. The hash is present — an uppercase-hex SHA-256 is very likely
  // the correct digest — so calling this "unhashed" sends someone to look for a missing value that
  // is sitting in front of them. Refused rather than normalised: `scoreSha256` is recorded verbatim
  // and compared as a STRING by every reader of the chain, so folding case here would put a
  // spelling in the record that the score file does not contain, and the two would stop matching
  // wherever the comparison is not this program's. §10 pins the schema; the producer emits
  // canonical form or the file is not the artifact it claims to be.
  if (typeof s.payloadSha256 !== 'string' || !HEX64.test(s.payloadSha256)) {
    fail('score-hash-malformed', `the score's payloadSha256 is '${String(s.payloadSha256)}', which is ` +
      'not 64 lowercase hex characters. A present-but-non-canonical hash is often the RIGHT digest in ' +
      'the wrong spelling — uppercase hex is the same value — and it is still refused rather than ' +
      'folded: this record binds the score by recording that string verbatim, every reader compares ' +
      'it textually, and rewriting it here would put a spelling in the record that the score file ' +
      'does not contain');
  }
  // Asserted only AFTER the runtime check above, and only because `fail` is a `const` arrow: TypeScript
  // applies never-returning control-flow narrowing to declared function statements and explicitly
  // annotated variables, not to a call through an inferred const, so the checked field stays `unknown`
  // to the compiler while being verified in fact. Same for `payload` below.
  const payloadSha256 = s.payloadSha256 as string;

  const p = s.payload;
  const r = isObject(p) ? p.release : undefined;
  if (!isObject(p) || typeof p.rule !== 'string' || !isObject(r)
    || typeof r.blocked !== 'boolean'
    || !Array.isArray(r.reasons) || r.reasons.some((x) => typeof x !== 'string')) {
    fail('score-malformed', 'the score has no payload.rule and payload.release{blocked: boolean, ' +
      'reasons: string[]}. Those three fields ARE the consequence this record attests to, so a ' +
      'missing or mistyped one is a refusal, never a default');
  }

  const payload = p as ScoreFile['payload'];
  if (sha256(JSON.stringify(payload)) !== payloadSha256) {
    fail('score-tampered', 'the score\'s payload does not hash to the value recorded beside it, so the ' +
      'release decision below would be bound to bytes nobody scored. Note what this does NOT catch: ' +
      'a payload rewritten together with its hash is self-consistent. That is why the record stores ' +
      'the hash it bound rather than asserting the score is genuine');
  }
  if (payload.rule !== RULE) {
    fail('rule-mismatch', `the score was produced under rule '${payload.rule}' and this record declares ` +
      `'${RULE}'. A consequence is only meaningful against the composition that decided it; recording ` +
      'one rule over another run\'s result would misstate which gate was obeyed');
  }
  // `blocked` is DERIVED from `reasons.length` wherever a score is produced, so the two can only
  // disagree in a file somebody edited. Reconciling would mean picking a winner between two
  // statements of the same fact — and either choice silently discards the other.
  if (payload.release.blocked !== (payload.release.reasons.length > 0)) {
    fail('score-self-contradictory', `the score reports blocked=${payload.release.blocked} with ` +
      `${payload.release.reasons.length} reason(s). A block is exactly the existence of a blocking ` +
      'reason, so this file states two incompatible things about its own verdict');
  }
  // Same argument as `score-self-contradictory` directly above, applied to the reason TEXT. The
  // scorer cannot emit a contentless reason — every one it builds is a condition's title followed by
  // that condition's label (`score-gate.ts`, where `reasons` is assembled) — so this only exists in
  // a file somebody edited, and there is no honest reconciliation: the text that would say what was
  // overridden is exactly what is missing.
  //
  // It matters here more than anywhere else in this program. `consequence-not-applied` quotes these
  // strings precisely so "the reader does not have to go and find what was overridden"; a blank one
  // renders as "  - " and nothing, and the headline refusal of the whole chain would announce a
  // block while naming none of it.
  const blank = payload.release.reasons.findIndex((reason) => !hasContent(reason));
  if (blank !== -1) {
    fail('score-blank-reason', `the score's release.reasons[${blank}] carries no content (it is empty, ` +
      'or made only of whitespace, zero-width and control characters). A blocking reason exists to be ' +
      'QUOTED back at whoever overrode it, and a reason that says nothing blocks a release while ' +
      'recording no ground for it. No scorer emits this');
  }
  return { artifact: 'gate-score', payloadSha256, payload };
};

export const releaseRecord = (input: {
  score: unknown;
  decision: string;
  consequence: string;
  evidence: string;
  orderingHead: string;
  now: () => string;
}): ReleaseRecord => {
  const score = validatedScore(input.score);
  if (!DECISIONS.has(input.decision)) {
    fail('decision-unrecognised', `'${input.decision}' is not a decision; the preregistered ` +
      'vocabulary is exactly released|blocked, and a third word would make the agreement check ' +
      'below unanswerable rather than false');
  }
  const { blocked, reasons } = score.payload.release;

  // §9a's requirement is evidence that "the declared consequence was ACTUALLY APPLIED". A record
  // that says `released` over a gate that said `blocked` is the one failure no other artifact in
  // the chain can show: the score file goes on saying `blocked: true` forever, and the release
  // happened somewhere it cannot see. The refusal quotes the score's own reasons because
  // "decision does not match" would leave the reader to go and find what was overridden — and
  // finding that out is the entire job of this element.
  if (blocked && input.decision === 'released') {
    fail('consequence-not-applied', 'the gate BLOCKED and this record declares a release. The ' +
      `preregistered consequence of these ${reasons.length} reason(s) is that nothing ships:\n` +
      reasons.map((r) => `  - ${r}`).join('\n') +
      '\nA release taken anyway is a protocol deviation and belongs in the deviation history, ' +
      'never in a record that reads as if the gate was satisfied');
  }
  // Refused for the same reason and not merely for symmetry: §4's claim is about the RULE
  // governing the decision, which runs in both directions. A record asserting a block the gate
  // never issued misrepresents the gate exactly as much, and it is the shape that manufactures a
  // reason to withhold a release the protocol had already cleared.
  if (!blocked && input.decision === 'blocked') {
    fail('consequence-overstated', 'this record declares a block, but the score reports the gate ' +
      'did not block (zero blocking reasons). A decision to withhold a release may be perfectly ' +
      'sound, and it is not this gate\'s consequence — record it where its actual grounds can be read');
  }

  // Checked AFTER the two agreement refusals, deliberately. A blank field is the cheaper defect to
  // detect, but a decision contradicting the gate is the failure this element exists for, and an
  // operator told only "your consequence text is empty" would fix the text and re-run into a
  // release that the gate had already forbidden.
  for (const [flag, text] of [['consequence', input.consequence], ['evidence', input.evidence]] as const) {
    if (hasContent(text)) continue;
    fail('consequence-unevidenced', `--${flag} carries no content — it is empty, or made only of ` +
      'whitespace, zero-width and control characters. §9a requires evidence that the declared ' +
      'consequence was actually applied — when the gate blocked, what was NOT released; when it did ' +
      'not, the release that followed and its record. A field that answers neither, while producing ' +
      'a file that looks like element 8 of the chain, is worse than an absent one');
  }

  // The ordering receipt's one open hole, closed from here.
  //
  // Element 4's chain fixes everything BELOW a line and nothing fixes where the chain ENDS:
  // truncating the last entries leaves a shorter chain that verifies perfectly, because no line
  // records how many should follow it. `ordering-receipt --mode verify --expect-head` compares the
  // tail against a value "an enclosing artifact recorded" — and until this flag, no artifact in the
  // chain recorded one. Element 8 is the last thing §9's execution order writes, which makes it the
  // only artifact that can name where the log ended.
  //
  // WHAT ANCHORING HERE ESTABLISHES: the ordering log's tail as of the moment the release was
  // recorded. A later truncation is then detectable — the log's head stops matching a value already
  // hashed into this record.
  //
  // WHAT IT DOES NOT: it does not establish that the log records EVERY run that happened. An
  // exploratory run that was never appended leaves no gap, and §9 says exactly this about the whole
  // coordinator design — "It does not prove that no such earlier pass occurred". Nor does it verify
  // the log: this program never opens it, so a head naming no real log is refused only for its
  // SHAPE. The verification is a separate command a reader runs, with this value as its argument.
  if (!HEX64.test(input.orderingHead)) {
    fail('ordering-head-malformed', `--ordering-head is '${input.orderingHead}', which is not 64 ` +
      'lowercase hex characters. It is the `chain` value of the ordering log\'s last line, printed by ' +
      '`ordering-receipt --mode verify`, and it is recorded verbatim so a reader can pass it back as ' +
      '--expect-head. A head in another spelling will not match the log it was taken from');
  }

  const payload: ReleaseRecordPayload = {
    rule: RULE,
    artifactKind: 'release-record',
    scoreSha256: score.payloadSha256,
    orderingHead: input.orderingHead,
    gateBlocked: blocked,
    // Copied, not aliased: the record must go on saying what the score said even if the caller
    // holds and mutates the parsed score afterwards.
    gateReasons: [...reasons],
    decision: input.decision as Decision,
    consequence: input.consequence,
    evidence: input.evidence,
  };
  return {
    artifact: 'release-record',
    payloadSha256: sha256(JSON.stringify(payload)),
    payload,
    receipts: {
      recordedAt: input.now(),
      attestation: 'this record ATTESTS the consequence; it does not OBSERVE it. What the program ' +
        'verified is that the declared decision agrees with the score it names and that the score\'s ' +
        'payload hashes to the value recorded beside it. It cannot verify that the described release ' +
        'or non-release physically happened — no program reading a score file can — so the consequence ' +
        'and evidence fields are the operator\'s statement, to be checked against the artifacts they ' +
        'name. `orderingHead` is recorded, NOT verified — this program did not read the ordering log; ' +
        'it fixes that log\'s tail as of this record, so run `ordering-receipt --mode verify --log ' +
        '<path> --expect-head <orderingHead>` to check it, and note that an anchored log is complete ' +
        'only in the sense that nothing was removed from its end: it cannot show that every run that ' +
        'happened was appended in the first place. The timestamp is a self-reported wall clock and ' +
        'proves no ordering; §9 item 4 wants an append-only or externally attested receipt for that',
    },
  };
};

/** Named flags only, no positionals, unknown flags REFUSED — the contract `prepare-gate` and
 *  `score-gate` already hold. What it closes is SLOT CONFUSION: with `generate-manifest`'s
 *  overlapping positional shapes, an oracle path could land in the output slot, and no slot here is
 *  decided by position at all.
 *
 *  An earlier version of this comment claimed that fixed the overwrite. It did not, and the
 *  difference is the whole of finding X1: named flags stop an input being MISTAKEN for an output,
 *  and do nothing about an output aimed at an input — `--out <the score path>` was accepted, exited
 *  0, and destroyed the score this record binds. Destination reuse needs a check on the
 *  destination, which is `refuseOutputCollisions` in `artifact-io.ts` and is called from `main`.
 *
 *  It matters more here than anywhere else in the chain. This is the artifact an operator writes
 *  while under pressure to ship, and a silently ignored flag is how a decision ends up recorded
 *  against a score nobody meant to name.
 *
 *  `startsWith('--')` is the load-bearing half of that and reads like a formality, so: `slice(2)`
 *  turns ANY token into a flag name. Without the check, a token that is not a flag but whose third
 *  character onward spells one — `..score` — is honoured as `--score`, which is exactly the
 *  overlapping-positional-shape failure this contract was written for. It went untested until a
 *  mutation survived the whole suite; `release-record.cli.test.ts` now kills it. */
const INPUTS = ['score', 'decision', 'consequence', 'evidence', 'ordering-head', 'out'] as const;
const USAGE = 'usage: release-record --score <path> --decision <released|blocked> ' +
  '--consequence <text> --evidence <text>\n' +
  '                      --ordering-head <sha256> --out <path>\n' +
  '  --consequence   when the gate BLOCKED, name what was NOT released; when it did not block, name\n' +
  '                  the release that followed and its record (preregistration §9a).\n' +
  '  --evidence      where a reader can check that for themselves — a tag that does or does not\n' +
  '                  exist, a deploy log entry, a published artefact.\n' +
  '  --ordering-head the head printed by `ordering-receipt --mode verify --log <path>`. REQUIRED:\n' +
  '                  it anchors the ordering log\'s tail, which nothing else in the chain does.\n' +
  '  The decision is compared against the score and must agree with it in BOTH directions.';

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
      fail('unknown-input', `--${name} is not an input of the release record. In particular there is no ` +
        'flag that overrides the gate\'s verdict: the decision is compared against the score, never ' +
        'supplied alongside a waiver');
    }
    // `Object.hasOwn`, never `in`: `in` walks Object.prototype, so `--constructor x` reported
    // "given more than once" — a false statement about what the operator typed (finding X2).
    if (Object.hasOwn(out, name)) fail('duplicate-input', `--${name} given more than once`);
    out[name] = value!;
  }
  for (const name of INPUTS) if (!Object.hasOwn(out, name)) fail('missing-input', `--${name} is required`);
  // Checked during parsing so a mistyped decision is a USAGE error (exit 2) rather than an
  // integrity failure (exit 1). The two exit codes mean different things to an operator's script:
  // one says "you typed it wrong", the other says "the gate says no".
  if (!DECISIONS.has(out.decision!)) {
    fail('bad-arguments', `--decision must be exactly 'released' or 'blocked', got '${out.decision}'`);
  }
  // Checked here for the same reason and with the same effect: a mistyped hash is a typing error
  // (exit 2), not a gate refusal (exit 1). `releaseRecord` checks it again — the exported function
  // is called by tests and by anything else that imports it, and a guard that lives only in the
  // argument parser is not a property of the artifact.
  if (!HEX64.test(out['ordering-head']!)) {
    fail('bad-arguments', `--ordering-head must be 64 lowercase hex characters, got ` +
      `'${out['ordering-head']}'. It is the head printed by \`ordering-receipt --mode verify\``);
  }
  return out;
};

const main = (): void => {
  let flags: Record<string, string>;
  try { flags = parseFlags(process.argv.slice(2)); }
  catch (e) { console.error(`${(e as Error).message}\n${USAGE}`); process.exit(2); return; }

  // The separation this program promises its callers, now actually implemented: a REFUSAL below is
  // an uncaught throw and exits 1, while anything about the PATHS — unreadable, unparsable, an
  // output that already exists or that names the score itself — is an invocation error and exits 2.
  // Until X1/X3 were fixed, a mistyped `--score` exited 1 with a raw `node:fs` stack, so an
  // operator's script read a filesystem typo as a gate refusal.
  try {
    const out = { arg: '--out', path: flags.out! };
    const score = { arg: '--score', path: flags.score! };
    refuseOutputCollisions(out, [score]);

    const record = releaseRecord({
      score: readJsonInput(score),
      decision: flags.decision!,
      consequence: flags.consequence!,
      evidence: flags.evidence!,
      orderingHead: flags['ordering-head']!,
      now: () => new Date().toISOString(),
    });
    writeArtifact(out, JSON.stringify(record, null, 1) + '\n');
    const { gateBlocked, gateReasons, decision, orderingHead } = record.payload;
    console.log(`release record written: gate ${gateBlocked ? `BLOCKED (${gateReasons.length} reason(s))` : 'DID NOT BLOCK'}; ` +
      `decision ${decision}\nscore sha256: ${record.payload.scoreSha256}\npayload sha256: ${record.payloadSha256}\n` +
      // The anchor is printed with the command that checks it. This program recorded the head without
      // reading the log, so an operator who is not handed the verification step has been given a value
      // that looks checked and is not.
      `ordering head anchored (RECORDED, NOT verified — this program did not read the log):\n` +
      `  ordering-receipt --mode verify --log <path> --expect-head ${orderingHead}\n` +
      'ATTESTED, NOT OBSERVED: the consequence text is the operator\'s statement and was not verified.');
  } catch (e) { exitOnInvocationError(e); }
};
if (isEntryPoint(import.meta.url)) main();
