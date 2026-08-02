/** The prepare-before-run ordering receipt — element 4 of the §9 evidence chain.
 *
 *  §9 requires "an append-only or externally attested receipt showing `prepare-finished` before
 *  `runner-started`", and nothing in the pipeline produced one. The scoring phase cannot supply it:
 *  `score-gate.ts` says so in its own condition detail, listing the freeze receipt, the as-of-close
 *  snapshot hash and this receipt as the evidence "a scoring program cannot attest to about
 *  itself". A program that reads outcomes cannot testify that it was handed them in the right
 *  order — its testimony would be exactly as trustworthy as the ordering it is asked to prove.
 *
 *  So the record is built OUTSIDE the measurement, one line at a time. NO PIPELINE STAGE CALLS THIS
 *  MODULE — nothing imports it and nothing shells out to it. The log is written by whoever drives
 *  the run, invoking this CLI's `append` mode once per event, and this program reads and writes
 *  only the file it is handed. That is the whole of the integration today; anything more would have
 *  to be built, not described here.
 *
 *  Each line hashes its own content together with the previous line's hash, which makes the file's
 *  ORDER part of its content: a line cannot be edited, inserted, dropped or reordered without
 *  breaking every hash below it. The predicate that matters is then decidable by reading —
 *  every `runner-started` must be preceded by a `prepare-finished` carrying the same prepare
 *  payload hash.
 *
 *  ─── WHAT THIS RECEIPT DOES NOT ESTABLISH ──────────────────────────────────────────────────
 *
 *  Stated here, in the verify summary, and in the returned verdict, because the specific harm
 *  this guards against is a report CITING this file as proof of something it never checked. An
 *  artifact that oversells itself is worse than no artifact: the absent one prompts the question,
 *  the overselling one answers it wrongly.
 *
 *  1. Every timestamp is a SELF-REPORTED wall clock. Nothing outside this file attests it, and
 *     whoever runs the appender can set the clock to any value. The ordering predicate therefore
 *     does not read timestamps at all — it is positional, decided by the chain. Timestamps are
 *     retained as disclosure, every line carries `attestation` saying so in the retained bytes, and
 *     a clock that falls behind the latest instant already recorded is reported, not refused.
 *  2. The chain establishes the relative order of RECORDED events ONLY. It cannot establish that
 *     no unrecorded exploratory run happened first. §9 says exactly this about the whole
 *     coordinator design — "It does not prove that no such earlier pass occurred, and no
 *     self-attested timestamp can" — and appending to a log is no stronger. What this closes is
 *     the assembled-after-the-fact class: a receipt built once outcomes were visible cannot be
 *     back-dated into the middle of an existing chain.
 *  3. The chain fixes everything BELOW a line, but nothing fixes where the chain ENDS. Truncating
 *     the last entries leaves a shorter chain that verifies perfectly, because no line records how
 *     many should follow it. This is not hypothetical: a log holding two runs bound to two
 *     different prepares FAILS `--expect-prepare`, and the same log cut to its first two lines
 *     PASSES it — deleting the end of the file removes the run that would have failed. Every
 *     verdict therefore reports `head` AND whether `--expect-head` was supplied, because the two
 *     verdicts differ in what they establish and used to be indistinguishable. The anchor value
 *     comes from an enclosing artifact — the release record carries the final head — and is passed
 *     in on the command line; this program never reads that artifact, so an anchored pass is only
 *     as strong as the anchor being beyond the reach of whoever can rewrite the log.
 *  4. The chain covers the VALUES of the named fields, not the BYTES of the file. `verifyChain`
 *     recomputes each hash from the fields it reads, so stored key order and whitespace are outside
 *     it: re-serialising every line leaves every chain value, and the head, identical while the
 *     file on disk changes. Nothing recorded is falsified by such a rewrite, but `head` is not a
 *     digest of the retained bytes and must not be compared against a `git hash-object` of them.
 *  5. The chain detects PIECEMEAL tampering. It does not detect a wholesale re-creation of the
 *     whole file by whoever can write it — nothing here is signed, and no third party holds a
 *     copy. Closing that needs an external attestation this program does not provide, which is
 *     why §9 words the requirement as "append-only OR EXTERNALLY ATTESTED".
 *
 *  A further, smaller limit, recorded where it will be read: read-verify-append is not atomic
 *  against a CONCURRENT appender. Two processes could compute the same `seq`, and the result is
 *  a log that fails verification afterwards rather than one that silently lies — detected, not
 *  prevented. The pipeline is sequential by construction (§9's execution order), so this is a
 *  disclosure rather than a defect to design around.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isEntryPoint } from '../../src/entry-point.js';
import {
  appendArtifactLine, exitOnInvocationError, flagAccumulator, invocationFail,
} from './artifact-io.js';
import { RULE } from './gate-set.js';

export interface VerifyOptions { expectPrepare?: string; expectHead?: string }

export const ORDERING_EVENTS = ['prepare-finished', 'runner-started', 'runner-finished'] as const;
export type OrderingEvent = (typeof ORDERING_EVENTS)[number];

/** §10: "each artifact additionally names its own `rule` and `artifact` fields so a file identifies
 *  itself without reference to a filename." The RETAINED bytes here are the `.jsonl`, not the
 *  verdict printed on stdout, so the naming belongs on every line — a log copied out of its
 *  directory, or read years later, must still say what it is and under which gate composition it
 *  was written. Both are inside the hashed pre-image: unhashed self-naming would ride in the
 *  receipt looking attested while being editable at will, which is exactly the class this file
 *  rejects everywhere else. */
export const LINE_ARTIFACT = 'ordering-receipt-entry' as const;

/** The `at` disclosure, carried by every line for the same reason: the stdout verdict says the
 *  clock is self-reported, and the stdout verdict is not what gets retained. One sentence, fixed
 *  bytes, hashed with the line — see `parseLog` for why it is compared literally. */
export const AT_ATTESTATION =
  'at is a self-reported wall clock from whoever appended this line; nothing outside this file ' +
  'attests it and the ordering predicate does not read it';

export interface OrderingEntry {
  artifact: typeof LINE_ARTIFACT; rule: string; seq: number; event: OrderingEvent;
  payloadSha256: string; runId: string | null; at: string; attestation: string;
  prev: string; chain: string;
}

export interface RunBinding {
  runId: string; startedSeq: number; preparedSha256: string; finishedSeq: number | null;
}

export interface OrderingVerification {
  artifact: 'ordering-receipt-verification';
  rule: string;
  entries: number;
  head: string;
  /** Which OPTIONAL checks actually ran, with the values they were given. Recorded because the
   *  shape and chain checks run on every invocation while these two do not, and a verdict that
   *  reads the same either way lets an unanchored pass be cited as an anchored one. `null` means
   *  the flag was absent and nothing was compared. */
  checks: { expectPrepare: string | null; expectHead: string | null };
  prepares: { seq: number; payloadSha256: string; at: string }[];
  runs: RunBinding[];
  /** Entries whose `at` precedes the LATEST instant recorded before them — a running maximum, not
   *  the adjacent line. DISCLOSED, never fatal — see the walk. */
  clockAnomalies: { seq: number; at: string; priorSeq: number; priorAt: string }[];
  limits: string[];
}

const fail = (code: string, detail: string): never => { throw new Error(`${code}: ${detail}`); };

export const GENESIS_PREV = '0'.repeat(64);

const HEX64 = /^[0-9a-f]{64}$/;
const isHex64 = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v);

/** The line's own key set. Fixed, and checked on read: a key outside this list is data that no
 *  `chain` value covers, so it would ride in the receipt looking attested while being editable at
 *  will. Growing this list is a new log format, not a compatible addition. */
const LINE_KEYS = ['artifact', 'rule', 'seq', 'event', 'payloadSha256', 'runId', 'at',
  'attestation', 'prev', 'chain'] as const;

export const chainOf = (prev: string, e: Omit<OrderingEntry, 'prev' | 'chain'>): string =>
  createHash('sha256').update(prev + JSON.stringify({
    artifact: e.artifact, rule: e.rule, seq: e.seq, event: e.event, payloadSha256: e.payloadSha256,
    runId: e.runId, at: e.at, attestation: e.attestation,
  }), 'utf8').digest('hex');

/** What a passing verification does NOT establish. Carried in the verdict rather than in prose
 *  beside it, because the failure mode being guarded against is a report citing this receipt as
 *  proof of something it never checked.
 *
 *  The tail limit depends on the INVOCATION rather than on the file, so the set is built per verify
 *  by `limitsFor`. A fixed list told an anchored run to "pass --expect-head to close this" — advice
 *  that was false for that very invocation, and the plainest possible form of the overselling this
 *  module exists to prevent. */
const CLOCK_LIMIT =
  'every `at` is a SELF-REPORTED wall clock. Nothing outside this file attests it, and whoever ' +
  'runs the appender can set the clock to any value';

const RECORDED_ONLY_LIMIT =
  'the chain establishes the relative order of RECORDED events only. It cannot establish that no ' +
  'unrecorded exploratory run happened first, and no self-attested timestamp can';

const TAIL_UNANCHORED_LIMIT =
  '--expect-head was NOT SUPPLIED, so this verdict does not bound the log\'s LENGTH. The chain ' +
  'detects an edited, inserted, reordered or dropped line ANYWHERE BUT THE TAIL: truncating the ' +
  'last lines leaves a shorter, perfectly valid chain, because nothing inside the file records how ' +
  'long it should be, and a run whose binding would have failed can be removed by deleting the end ' +
  'of the file. Pass --expect-head with the head recorded by an enclosing artifact to close this';

const TAIL_ANCHORED_LIMIT =
  '--expect-head was supplied and matched, which closes tail truncation — but only as strong as ' +
  'the value it was matched against. This program compares the head with a string handed to it on ' +
  'the command line and cannot see where that string came from; if whoever can rewrite this log ' +
  'can also rewrite the artifact that recorded the head, the anchor moves with the forgery';

/** The narrower unsigned class, stated because `head` looks like a file digest and is not. */
const BYTES_LIMIT =
  'the chain covers the VALUES of the named fields, not the BYTES of this file. Each `chain` is ' +
  'recomputed from the previous line\'s chain value plus artifact, rule, seq, event, payloadSha256, ' +
  'runId, at and attestation, so re-serialising every line with a different key order or different ' +
  'whitespace leaves every chain value — and the head — identical while the file on disk changes. ' +
  'Such a rewrite is semantics-preserving and falsifies no recorded event, but `head` is not a ' +
  'digest of the retained bytes: comparing it against a `git hash-object` of this log is a mistake';

const WHOLESALE_LIMIT =
  'the chain detects PIECEMEAL tampering. It does not detect a wholesale re-creation of the entire ' +
  'file by whoever can write it — nothing here is signed and no third party holds a copy. That ' +
  'needs an external attestation this program does not provide';

export const limitsFor = (opts: VerifyOptions): string[] => [
  CLOCK_LIMIT,
  RECORDED_ONLY_LIMIT,
  opts.expectHead === undefined ? TAIL_UNANCHORED_LIMIT : TAIL_ANCHORED_LIMIT,
  BYTES_LIMIT,
  WHOLESALE_LIMIT,
];

/** Read the log into typed entries, refusing anything the predicate could not honestly evaluate.
 *
 *  Shape is checked BEFORE the chain, because `chainOf` would happily hash a line whose `seq` is a
 *  string and whose `at` is nonsense, and a chain verified over meaningless fields verifies
 *  nothing. */
export const parseLog = (text: string): OrderingEntry[] => {
  // The terminator is part of the format, not cosmetic. Appending onto a log whose last line lacks
  // its newline FUSES the two entries into one line: the append reports success and a chain value,
  // `wc -l` counts one line for two events, and every later verify fails — a valid receipt
  // destroyed by a successful-looking command. A file cut short by a partial write looks exactly
  // like this, so it is refused on the read path too. The empty string is the one legitimate
  // unterminated input: there is no last line to fuse onto, and refusing it would make the log
  // unstartable.
  if (text !== '' && !text.endsWith('\n')) {
    fail('log-not-newline-terminated', 'the log does not end in a newline, so its last line is ' +
      'incomplete or was written without its terminator. Appending here would join the next entry ' +
      'onto that line and destroy a receipt that verifies today');
  }
  // One entry per line, each line terminated by exactly one newline — so after the split, the
  // final element is the zero-length remainder after the last terminator, and EVERYTHING ELSE must
  // be an entry. Nothing is filtered: a blank or whitespace-only line is bytes sitting in the
  // retained file covered by no chain value, and the filter that used to drop such lines let an
  // editor park them in a receipt that verified anyway. With the filter gone, the map index tracks
  // the physical line, and every line-naming refusal in this file reports it 1-BASED (`i + 1`) —
  // editors count from 1, and "line 1" for the file's second line sent an operator to the wrong
  // bytes. `seq` values stay the 0-based FIELD they are; only LINE references are 1-based.
  const lines = text === '' ? [] : text.split('\n').slice(0, -1);
  return lines.map((line, i) => {
    if (line.trim() === '') {
      fail('log-unchained-bytes', `line ${i + 1} is ${line === '' ? 'empty' : 'whitespace-only'} — bytes ` +
        'in the retained file that no chain value covers. The format is entry lines each terminated ' +
        'by exactly one newline, so a blank-looking line is not formatting; it is unattested content, ' +
        'and skipping over it would verify a file other than the one on disk');
    }
    let v: unknown;
    try { v = JSON.parse(line); }
    catch { return fail('log-unparsable', `line ${i + 1} is not JSON; an append-only log is one entry per line`); }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      fail('log-unparsable', `line ${i + 1} is not a JSON object`);
    }
    const e = v as Record<string, unknown>;
    const keys = Object.keys(e).sort();
    // `Object.hasOwn`, not `in`, for the same reason as the flag parser (finding X2) — though this
    // one was never observably wrong: no name in `LINE_KEYS` exists on Object.prototype, and the
    // length comparison beside it already refuses a line that swapped one for an inherited name.
    // Changed to remove the pattern, not to fix a reachable defect; no test distinguishes them.
    if (keys.length !== LINE_KEYS.length || !LINE_KEYS.every((k) => Object.hasOwn(e, k))) {
      fail('log-unparsable', `line ${i + 1} carries keys [${keys}]; an entry is exactly ` +
        `[${[...LINE_KEYS].sort()}], and any other key is content no chain value covers`);
    }
    // Self-naming is checked by VALUE, not merely by presence. The fields are inside the pre-image,
    // so a piecemeal edit is caught by the chain — but a whole file re-chained by whoever can write
    // it agrees with itself, and then the only thing separating this receipt from some other
    // artifact re-labelled as one is the name it must carry.
    if (e.artifact !== LINE_ARTIFACT) {
      fail('line-misidentified', `line ${i + 1} names artifact '${String(e.artifact)}'; every line of this ` +
        `log identifies itself as '${LINE_ARTIFACT}', and a file naming itself something else is not ` +
        'this format however well it hashes');
    }
    if (e.rule !== RULE) {
      fail('line-rule-mismatch', `line ${i + 1} names rule '${String(e.rule)}', not '${RULE}'. The lines ` +
        'were written under a different gate composition, and chaining two compositions into one ' +
        'file would present them as one measurement');
    }
    if (!Number.isInteger(e.seq) || (e.seq as number) < 0) fail('log-unparsable', `line ${i + 1} has a non-integer seq`);
    if (typeof e.event !== 'string') fail('log-unparsable', `line ${i + 1} has a non-string event`);
    if (!(ORDERING_EVENTS as readonly string[]).includes(e.event as string)) {
      fail('unknown-event', `line ${i + 1} records event '${String(e.event)}'. Only ` +
        `[${ORDERING_EVENTS}] participate in the ordering predicate, so an unrecognised event would ` +
        'sit in the receipt contributing nothing while reading as evidence');
    }
    if (!isHex64(e.payloadSha256)) fail('log-unparsable', `line ${i + 1} has a payloadSha256 that is not 64 lowercase hex`);
    if (!(e.runId === null || (typeof e.runId === 'string' && e.runId.length > 0))) {
      fail('log-unparsable', `line ${i + 1} has a runId that is neither null nor a non-empty string`);
    }
    if (!isHex64(e.prev) || !isHex64(e.chain)) fail('log-unparsable', `line ${i + 1} has a prev or chain that is not 64 lowercase hex`);
    // Canonical UTC, matching the `tx` spelling the ledger uses. A non-canonical spelling of the
    // same instant hashes differently, so accepting one would make two logs of the same events
    // disagree on every chain value below it.
    let canonical = '';
    try { canonical = new Date(e.at as string).toISOString(); } catch { /* invalid date */ }
    if (typeof e.at !== 'string' || canonical !== e.at) {
      fail('log-unparsable', `line ${i + 1} has at='${String(e.at)}', which is not a canonical UTC instant`);
    }
    // Compared literally, for the same reason as the artifact name and with sharper stakes: a
    // re-chained file whose attestation read "externally attested" would carry a claim this program
    // cannot support past every hash check, and the disclosure is the entire point of the field.
    if (e.attestation !== AT_ATTESTATION) {
      fail('attestation-altered', `line ${i + 1} carries an attestation other than the fixed sentence this ` +
        'format writes. The sentence is what discloses that `at` is self-reported, so a rewritten one ' +
        'is a weakened disclosure, not a variant spelling');
    }
    return e as unknown as OrderingEntry;
  });
};

/** Integrity BEFORE meaning: the ordering predicate reads `event`, `payloadSha256` and position,
 *  and every one of those is exactly what an editor would change. A verdict computed over
 *  unverified bytes answers a question about a file nobody has established is the file written. */
export const verifyChain = (entries: OrderingEntry[]): void => {
  entries.forEach((e, i) => {
    // Three checks, one slug. They are the same fact — this file is not the append-only sequence
    // it claims to be — and each catches a tamper the others miss: recomputation catches an EDIT,
    // contiguity catches a DROP or a REORDER, linkage catches an INSERT.
    if (e.seq !== i) {
      fail('chain-broken', `line ${i + 1} carries seq ${e.seq}; seq must start at 0 and be contiguous, so a ` +
        'gap or a repeat means a line was dropped, inserted or moved');
    }
    const expectedPrev = i === 0 ? GENESIS_PREV : entries[i - 1]!.chain;
    if (e.prev !== expectedPrev) {
      fail('chain-broken', `seq ${e.seq} links to prev ${e.prev} but the line before it hashes to ` +
        `${expectedPrev}; the two are not adjacent in the sequence that was written`);
    }
    if (chainOf(e.prev, e) !== e.chain) {
      fail('chain-broken', `seq ${e.seq} does not hash to its recorded chain value; the line's content ` +
        'was altered after it was appended');
    }
  });
};

/** Build the next entry for `existing`, returning the exact line to append.
 *
 *  It verifies the log it is extending and refuses a broken one, because appending a well-formed
 *  line onto a corrupted log produces a receipt whose newest entries hash correctly against each
 *  other — a sound-looking tail sitting on a broken foundation.
 *
 *  It does NOT evaluate the ordering predicate, and that is deliberate rather than an omission. An
 *  appender that refused to RECORD an out-of-order run would guarantee that no log it produced
 *  could ever contain the violation element 4 exists to detect: every receipt would verify by
 *  construction and the verifier would be theatre. The write path records what happened; the read
 *  path judges it.
 *
 *  Time is injected so the caller — only `main()` — supplies the real clock. */
export const appendEntry = (existing: string, input: {
  event: OrderingEvent; payloadSha256: string; runId: string | null; now: () => string;
}): { entry: OrderingEntry; line: string } => {
  const entries = parseLog(existing);
  verifyChain(entries);
  const prev = entries.length === 0 ? GENESIS_PREV : entries[entries.length - 1]!.chain;
  const base = { artifact: LINE_ARTIFACT, rule: RULE, seq: entries.length, event: input.event,
    payloadSha256: input.payloadSha256, runId: input.runId, at: input.now(),
    attestation: AT_ATTESTATION };
  // Key order below is THE HASH CONTRACT. `JSON.stringify` emits keys in insertion order, so the
  // pre-image `chainOf` builds is positional: reorder these and every chain value in every log ever
  // written changes, silently invalidating receipts nobody thought to re-verify. Any change here is
  // a new log format, not a refactor.
  const entry: OrderingEntry = { ...base, prev, chain: chainOf(prev, base) };
  return { entry, line: JSON.stringify(entry) + '\n' };
};

export const verifyOrderingReceipt = (text: string, opts: VerifyOptions): OrderingVerification => {
  const entries = parseLog(text);
  if (entries.length === 0) {
    fail('log-empty', 'the log records no events. Every predicate below is vacuously true over an empty ' +
      'log, so a pass here would be cited as ordering evidence for a run this receipt never saw');
  }
  verifyChain(entries);

  // A backwards clock is DISCLOSED, not refused. Ordering here is positional — the chain is what
  // establishes it — so failing on a timestamp would imply the clocks decide something they do
  // not. Passing over it silently would be the opposite error: it would suppress the plainest
  // available sign that the self-reported clocks in this file cannot be relied on.
  //
  // Compared against the RUNNING MAXIMUM, not the adjacent line. Adjacent comparison reports the
  // step back and then falls silent while the clock catches up (12:00 -> 09:00 -> 09:30 disclosed
  // one anomaly, though seq 2 is also earlier than seq 0), which reads as a clock that recovered.
  // The maximum keeps disclosing until the recorded time genuinely passes the highest one seen.
  const clockAnomalies: OrderingVerification['clockAnomalies'] = [];
  let latest = { seq: entries[0]!.seq, at: entries[0]!.at, ms: Date.parse(entries[0]!.at) };
  for (const e of entries.slice(1)) {
    const ms = Date.parse(e.at);
    if (ms < latest.ms) clockAnomalies.push({ seq: e.seq, at: e.at, priorSeq: latest.seq, priorAt: latest.at });
    else latest = { seq: e.seq, at: e.at, ms };
  }

  const prepares: OrderingVerification['prepares'] = [];
  const prepared = new Set<string>();
  const runs = new Map<string, RunBinding>();
  for (const e of entries) {
    if (e.event === 'prepare-finished') {
      // The run-id asymmetry, re-checked on read. The appender enforces it at the flag, which
      // protects the write path; this protects the FILE, which is the thing the report cites.
      if (e.runId !== null) {
        fail('run-id-on-prepare', `seq ${e.seq} is a prepare-finished carrying run id '${e.runId}'. ` +
          'A prepare precedes every run bound to it and belongs to none of them; naming one would ' +
          'suggest the denominator was prepared for a run that already existed');
      }
      prepares.push({ seq: e.seq, payloadSha256: e.payloadSha256, at: e.at });
      prepared.add(e.payloadSha256);
      continue;
    }
    if (e.runId === null) {
      fail('missing-run-id', `seq ${e.seq} is a ${e.event} with no run id, so nothing ties it to a ` +
        'runner output or to the other half of its own run');
    }
    const runId = e.runId!;
    if (e.event === 'runner-started') {
      if (prepares.length === 0) {
        fail('run-before-any-prepare', `seq ${e.seq} records a runner-started with no prepare-finished ` +
          'at any earlier position');
      }
      if (!prepared.has(e.payloadSha256)) {
        fail('run-prepare-hash-unmatched', `seq ${e.seq} binds run to prepare payload ${e.payloadSha256}, ` +
          'which no earlier prepare-finished carries');
      }
      if (runs.has(runId)) {
        fail('duplicate-run-id', `run id '${runId}' is claimed by seq ${runs.get(runId)!.startedSeq} ` +
          `and again by seq ${e.seq}. A reused id makes the binding undecidable: a runner-finished ` +
          'naming it could belong to either start, and so could a runner output carrying it');
      }
      runs.set(runId, { runId, startedSeq: e.seq, preparedSha256: e.payloadSha256, finishedSeq: null });
      continue;
    }
    // `runs` holds only starts seen SO FAR, so this lookup is positional by construction: a finish
    // recorded before its own start finds nothing, which is the answer it should get.
    const started = runs.get(runId) ?? fail('finish-without-start',
      `seq ${e.seq} closes run '${runId}', which no earlier runner-started opened. A finish is ` +
      'evidence about a run this log never recorded beginning');
    if (started.finishedSeq !== null) {
      fail('duplicate-run-finish', `run '${runId}' is already closed at seq ${started.finishedSeq}; ` +
        `seq ${e.seq} closes it again. Two finishes name two different run artifacts for one run, ` +
        'and nothing in the log says which one was scored');
    }
    started.finishedSeq = e.seq;
  }

  const bound = [...runs.values()];

  // The SECOND vacuity case, refused for the same reason as `log-empty` and — like it — before any
  // optional flag is read. Element 4's whole subject is the `runner-started`: "every runner-started
  // was preceded by a prepare-finished carrying its hash" is as vacuously true over a log of
  // nothing but prepares as it is over an empty file, and the log holding prepares is the one that
  // LOOKS like evidence. It is asked after the walk so that a concrete malformation (a prepare
  // carrying a run id, a finish with no start) is still reported as itself, and before the anchors
  // because whether this file is element-4 evidence cannot depend on which flags the reader
  // happened to pass. `bound` is empty exactly when no runner-started survived the walk, and no
  // runner-started can survive without entering it.
  if (bound.length === 0) {
    fail('log-records-no-run', `the log records ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} ` +
      'and no runner-started. The ordering this receipt exists to show is prepare-finished BEFORE ' +
      'runner-started, and there is no runner-started to order — the same vacuity log-empty refuses, ' +
      'with more bytes in the file');
  }

  // The anchor that closes tail truncation. A hash chain fixes everything below a given line, but
  // nothing fixes where the chain ends: lopping off the last entries leaves a shorter chain that
  // verifies perfectly. Demonstrated, not theorised — a log holding two runs bound to two different
  // prepares FAILS --expect-prepare, and the same log cut to its first two lines PASSES it. So the
  // head is reported on EVERY verdict, for an enclosing artifact to record: the release record
  // (§9 item 8) is where the final head is carried, and this program never reads it — the operator
  // passes the value back in. Comparing it turns "append-only" into "append-only and complete", but
  // no further than the anchoring artifact is itself out of reach, which is why the anchored limit
  // says so rather than dropping the disclosure.
  const head = entries[entries.length - 1]!.chain;
  if (opts.expectHead !== undefined && opts.expectHead !== head) {
    fail('head-mismatch', `the log ends at ${head}, but ${opts.expectHead} was expected. Entries have ` +
      'been removed from the end, or this is not the log that head was taken from');
  }

  if (opts.expectPrepare !== undefined) {
    // No emptiness guard here, deliberately: `bound` cannot be empty by this point. A log with no
    // runner-started was refused above as `log-records-no-run`, and every runner-started that
    // survives the walk is in `bound`. Repeating the check would read as though an unwitnessed
    // expectation were still reachable — a check that cannot fire is not a check.
    for (const r of bound) {
      if (r.preparedSha256 !== opts.expectPrepare) {
        fail('expect-prepare-mismatch', `run '${r.runId}' at seq ${r.startedSeq} is bound to prepare ` +
          `${r.preparedSha256}, not to the expected ${opts.expectPrepare}. The log may be internally ` +
          'consistent and still be the receipt of a different measurement');
      }
    }
  }

  return {
    artifact: 'ordering-receipt-verification',
    rule: RULE,
    entries: entries.length,
    head,
    // What ran, with what. `?? null` distinguishes "compared and matched" from "never looked at":
    // the two verdicts were byte-identical before, so an unanchored pass could be pasted into a
    // report as though the log's length had been bounded.
    checks: { expectPrepare: opts.expectPrepare ?? null, expectHead: opts.expectHead ?? null },
    prepares,
    runs: bound,
    clockAnomalies,
    limits: limitsFor(opts),
  };
};

/** The human-readable verdict. It carries the limits WITH the pass, in the same breath, because
 *  this is the text an operator pastes into the report — and a pass copied without them is the
 *  overselling this module exists to prevent. */
export const summarize = (v: OrderingVerification): string => {
  const out = [
    `ordering receipt VERIFIED — ${v.entries} entries, ${v.prepares.length} prepare-finished, ` +
      `${v.runs.length} run(s) bound`,
    `artifact: ${v.artifact}; rule: ${v.rule}`,
    `head: ${v.head}`,
    // The shape, chain and ordering checks ran because they always run; these two ran only if they
    // were asked for, and the reader of a pasted verdict cannot otherwise tell which pass this is.
    'checked: shape, chain and the prepare-before-run predicate (always) — ' +
      `--expect-prepare: ${v.checks.expectPrepare ?? 'NOT SUPPLIED'}, ` +
      `--expect-head: ${v.checks.expectHead ?? 'NOT SUPPLIED'}`,
  ];
  for (const p of v.prepares) out.push(`  prepare-finished at seq ${p.seq} — payload ${p.payloadSha256} (at ${p.at})`);
  for (const r of v.runs) {
    out.push(`  run '${r.runId}' started at seq ${r.startedSeq}, bound to prepare ${r.preparedSha256}; ` +
      (r.finishedSeq === null ? 'NO runner-finished recorded' : `finished at seq ${r.finishedSeq}`));
  }
  for (const c of v.clockAnomalies) {
    out.push(`  DISCLOSURE — seq ${c.seq} reports ${c.at}, earlier than seq ${c.priorSeq} (${c.priorAt}), ` +
      'the latest instant recorded before it. The verdict does not depend on timestamps, but a clock ' +
      'running backwards is reported, not hidden');
  }
  out.push('WHAT THIS RECEIPT DOES NOT ESTABLISH:');
  for (const l of v.limits) out.push(`  - ${l}`);
  return out.join('\n');
};

/** Flags are per-mode, and a flag belonging to the OTHER mode is refused rather than ignored —
 *  the same contract as the two gate phases, for the same reason. `--expect-prepare` passed to
 *  `append` would leave an operator believing an expectation had been checked when nothing read
 *  it, which is precisely the false confidence this receipt is supposed to remove. */
const MODES = {
  append: { allowed: ['mode', 'log', 'event', 'payload-sha', 'run-id'], required: ['mode', 'log', 'event', 'payload-sha'] },
  verify: { allowed: ['mode', 'log', 'expect-prepare', 'expect-head'], required: ['mode', 'log'] },
} as const;

const USAGE = 'usage: ordering-receipt --mode append --log <path> --event <' + ORDERING_EVENTS.join('|') + '>\n' +
  '                       --payload-sha <sha256> [--run-id <id>]\n' +
  '       ordering-receipt --mode verify --log <path> [--expect-prepare <sha256>] [--expect-head <sha256>]\n' +
  '  append: --run-id is REQUIRED for runner-started / runner-finished and REFUSED for prepare-finished.\n' +
  '  For runner-started, --payload-sha is the PREPARE hash the run is bound to; the run artifact\n' +
  '  does not exist yet, which is why the event carries the prepare hash and not its own.';

/** This parser is where finding X2 actually reached an operator — see `flagAccumulator` in
 *  `artifact-io.ts` for the full account and for what the mutation testing did and did not show.
 *
 *  It checks for a repeat BEFORE consulting the per-mode allow-list (it has to: which flags are
 *  legal is not known until `--mode` has been read), so `--constructor x` reached `name in out`,
 *  found the inherited property, and reported "given more than once" — a false statement about the
 *  command line. The other five CLIs check their allow-list first, so their copies of the same `in`
 *  were unreachable-wrong rather than observably wrong; this one was observable.
 *
 *  `flagAccumulator`'s null prototype is the enforcement. `Object.hasOwn` below spells the intent
 *  and would be the operative guard if the accumulator ever became a literal again; given the null
 *  prototype it is not independently mutation-visible, and this comment does not claim it is. */
const parseFlags = (argv: string[]): Record<string, string> => {
  const out = flagAccumulator();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) {
      fail('bad-arguments', `expected --name <value> pairs, got '${String(flag)}'`);
    }
    const name = flag!.slice(2);
    if (Object.hasOwn(out, name)) fail('duplicate-input', `--${name} given more than once`);
    out[name] = value!;
  }

  const mode = out.mode;
  if (mode === undefined) fail('missing-input', '--mode is required and selects which flags are legal');
  // `Object.hasOwn(MODES, ...)`, not `mode in MODES`: `MODES` is an object literal, so
  // `'constructor' in MODES` was true, `spec` came back as the Object constructor, and the CLI died
  // on "Cannot read properties of undefined (reading 'includes')" — a JS runtime message standing
  // where an unknown-mode refusal belongs.
  if (!Object.hasOwn(MODES, mode!)) fail('unknown-mode', `--mode ${mode} is not one of [${Object.keys(MODES)}]`);
  const spec = MODES[mode as keyof typeof MODES];
  for (const name of Object.keys(out)) {
    if (!(spec.allowed as readonly string[]).includes(name)) {
      fail('unknown-input', `--${name} is not an input of --mode ${mode}. An ignored flag would leave an ` +
        'operator believing an argument was honoured when nothing read it');
    }
  }
  for (const name of spec.required) {
    if (!Object.hasOwn(out, name)) fail('missing-input', `--${name} is required for --mode ${mode}`);
  }

  // Uppercase hex is refused rather than folded: it is the same value spelled differently, it
  // hashes differently, and a log holding both spellings would fail its own prepare-hash match.
  const requireHex = (name: string) => {
    if (out[name] !== undefined && !HEX64.test(out[name]!)) {
      fail(`bad-${name}`, `--${name} must be 64 lowercase hex characters, got '${out[name]}'`);
    }
  };
  requireHex('payload-sha');
  requireHex('expect-prepare');
  requireHex('expect-head');

  if (mode === 'append') {
    const event = out.event!;
    if (!(ORDERING_EVENTS as readonly string[]).includes(event)) {
      fail('unknown-event', `--event ${event} is not one of [${ORDERING_EVENTS}]. An unrecognised event ` +
        'cannot participate in an ordering predicate, so accepting one would let an unverifiable line ' +
        'into an otherwise checkable log');
    }
    const needsRunId = event !== 'prepare-finished';
    if (needsRunId && out['run-id'] === undefined) {
      fail('missing-run-id', `--run-id is required for ${event}; without it nothing ties the event to a ` +
        'runner output or to the other half of its own run');
    }
    if (!needsRunId && out['run-id'] !== undefined) {
      fail('run-id-on-prepare', '--run-id is refused for prepare-finished. A prepare precedes every run ' +
        'bound to it and belongs to none of them; naming one would suggest the denominator was ' +
        'prepared for a run that already existed');
    }
    if (out['run-id'] !== undefined && out['run-id'] === '') fail('bad-run-id', '--run-id must not be empty');
  }
  return out;
};

const main = (): void => {
  let flags: Record<string, string>;
  try { flags = parseFlags(process.argv.slice(2)); }
  catch (e) { console.error(`${(e as Error).message}\n${USAGE}`); process.exit(2); return; }

  try {
    const log = { arg: '--log', path: flags.log! };
    // ENOENT is the ONE read failure that is not an error here: the first append creates the log,
    // so "not there yet" is a legal state. Every other failure — a directory, a permission denial —
    // is a path the operator got wrong, and treating it as an empty log would let an append mint a
    // fresh seq-0 chain beside a log that already exists.
    const readOrNull = (): string | null => {
      try { return readFileSync(log.path, 'utf8'); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        return invocationFail('log-unreadable', `--log ${log.path} exists and could not be read ` +
          `(${(e as Error).message}). It is NOT treated as an empty log: an append would then start a ` +
          'second chain at seq 0 while the real one sat unread beside it');
      }
    };

    if (flags.mode === 'append') {
      const existing = readOrNull();
      // The one destination check the exempt write gets, and it is about IDENTITY, not existence:
      // a zero-length file is the single input `parseLog` cannot tell from "no log yet" (the empty
      // string is its one legitimate unterminated input), and this tool's own appends always leave
      // at least one terminated line — so an EXISTING zero-length file is never a log this tool
      // wrote. Extending it destroyed a pinned EMPTY project ledger (a normal snapshot state) at
      // exit 0. Only ENOENT means first append; zero bytes means the operator named some other
      // file. The remedy is deliberately non-destructive: this program cannot know what the empty
      // file is, so it may only send the log elsewhere, never the file.
      if (existing === '') {
        invocationFail('log-preexisting-empty', `--log ${flags.log} exists and is zero-length, so it is ` +
          'not a log this tool wrote — every append this program performs leaves at least one ' +
          'newline-terminated line. If the file is a pipeline artifact (a pinned empty ledger is a normal ' +
          'snapshot state), it must not be touched: appending here would destroy it while reporting ' +
          'success. Point --log at a different path; a --log that does not exist yet is still created ' +
          'fresh');
      }
      const { entry, line } = appendEntry(existing ?? '', {
        event: flags.event as OrderingEvent,
        payloadSha256: flags['payload-sha']!,
        runId: flags['run-id'] ?? null,
        now: () => new Date().toISOString(),
      });
      // The ONE pilot write EXEMPT from §9 line 376's "creates every file exclusively", and the
      // exemption is the artifact's design: §9 item 4 asks for an APPEND-ONLY receipt, so this file
      // must be able to grow. `appendArtifactLine` opens 'a', so the write is positioned at
      // end-of-file by the kernel and the existing bytes are never re-emitted — append-only is a
      // property of the open flag, not of a promise that this program will not rewrite the file.
      appendArtifactLine(log, line);
      console.log(`appended seq ${entry.seq} ${entry.event}` +
        `${entry.runId === null ? '' : ` (run '${entry.runId}')`} — payload ${entry.payloadSha256}\n` +
        `chain: ${entry.chain}`);
      return;
    }

    const text = readOrNull() ?? fail('log-missing',
      `no ordering log at ${log.path}. A missing receipt is an integrity failure, not an argument error: ` +
      'the chain element §9 requires simply does not exist');
    console.log(summarize(verifyOrderingReceipt(text, {
      expectPrepare: flags['expect-prepare'], expectHead: flags['expect-head'],
    })));
  } catch (e) { exitOnInvocationError(e); }
};
if (isEntryPoint(import.meta.url)) main();
