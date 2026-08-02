import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  AT_ATTESTATION, LINE_ARTIFACT, appendEntry, summarize, verifyOrderingReceipt,
} from '../../scripts/pilot/ordering-receipt.js';
import { RULE } from '../../scripts/pilot/gate-set.js';

/** Evidence-chain element 4 — the prepare-before-run ordering receipt.
 *
 *  The chain (`v2-preregistration-2026-07.md` §9) requires "an append-only or externally attested
 *  receipt showing `prepare-finished` before `runner-started`". These tests are written against a
 *  log built HERE, with the hash chain recomputed independently of the module under test: if the
 *  fixture called the module's own `chainOf`, a tampering test could pass by agreeing with the very
 *  bug it is supposed to catch. */

const GENESIS = '0'.repeat(64);
const PREP = 'a'.repeat(64);
const RUN = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);

const link = (prev: string, base: object) =>
  createHash('sha256').update(prev + JSON.stringify(base), 'utf8').digest('hex');

interface Ev {
  event: string; payloadSha256: string; runId?: string | null; at?: string;
  // Self-naming overrides, used to forge a whole file rather than edit a line: the fields are
  // hashed, so a piecemeal edit only ever produces `chain-broken`. Re-chaining the entire log is
  // what makes the CONTENT check the interesting one.
  artifact?: string; rule?: string; attestation?: string;
}

/** A well-formed log, one JSON object per line, chained the way the contract says. The key order
 *  here IS the pre-image contract, reproduced independently of the module. */
const buildLog = (events: Ev[]): string => {
  let prev = GENESIS;
  const lines: string[] = [];
  events.forEach((e, i) => {
    const base = { artifact: e.artifact ?? LINE_ARTIFACT, rule: e.rule ?? RULE, seq: i,
      event: e.event, payloadSha256: e.payloadSha256, runId: e.runId ?? null,
      at: e.at ?? `2026-08-01T00:0${i}:00.000Z`, attestation: e.attestation ?? AT_ATTESTATION };
    const chain = link(prev, base);
    lines.push(JSON.stringify({ ...base, prev, chain }));
    prev = chain;
  });
  return lines.join('\n') + '\n';
};

const HEALTHY: Ev[] = [
  { event: 'prepare-finished', payloadSha256: PREP },
  { event: 'runner-started', payloadSha256: PREP, runId: 'r1' },
  { event: 'runner-finished', payloadSha256: RUN, runId: 'r1' },
];

describe('ordering predicate', () => {
  it('FAILS a log whose runner-started precedes every prepare-finished', () => {
    // The central case. A receipt assembled after the outcomes were visible looks exactly like
    // this: the run happened, the prepare line was written afterwards, and every line is
    // individually well-formed. Only the POSITION of the prepare line distinguishes it.
    const log = buildLog([
      { event: 'runner-started', payloadSha256: PREP, runId: 'r1' },
      { event: 'prepare-finished', payloadSha256: PREP },
    ]);
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/run-before-any-prepare/);
  });

  it('FAILS a runner-started naming a prepare hash no prepare-finished line carries', () => {
    // "A prepare happened" is not the predicate; "THIS run was bound to a prepare that happened
    // first" is. A log that satisfied only the weaker reading would pass a run scored against a
    // denominator prepared for something else.
    const log = buildLog([
      { event: 'prepare-finished', payloadSha256: PREP },
      { event: 'runner-started', payloadSha256: OTHER, runId: 'r1' },
    ]);
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/run-prepare-hash-unmatched/);
  });

  it('FAILS when the matching prepare-finished exists but only LATER in the log', () => {
    // The sharpest form of the element-4 failure, and the one a non-positional implementation gets
    // wrong. A prepare DOES precede the run (seq 0), and a prepare carrying the run's exact hash
    // DOES exist (seq 2) — so any check that asks "did a prepare happen?" or "is this hash
    // prepared anywhere?" passes. Only "was THIS hash prepared BEFORE this line?" catches it, and
    // that is exactly the shape of a receipt back-filled once the outcome was known.
    const log = buildLog([
      { event: 'prepare-finished', payloadSha256: OTHER },
      { event: 'runner-started', payloadSha256: PREP, runId: 'r1' },
      { event: 'prepare-finished', payloadSha256: PREP },
    ]);
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/run-prepare-hash-unmatched/);
  });
});

describe('appendEntry', () => {
  const AT = '2026-08-01T00:00:00.000Z';

  it('opens an empty log at seq 0 with the genesis prev', () => {
    const { entry } = appendEntry('', { event: 'prepare-finished', payloadSha256: PREP, runId: null, now: () => AT });
    expect(entry.seq).toBe(0);
    expect(entry.prev).toBe(GENESIS);
    expect(entry.chain).toBe(link(GENESIS, { artifact: LINE_ARTIFACT, rule: RULE, seq: 0,
      event: 'prepare-finished', payloadSha256: PREP, runId: null, at: AT, attestation: AT_ATTESTATION }));
  });

  it('emits the ten keys in the order the hash contract fixes', () => {
    // The hashed pre-image is built by `JSON.stringify` over an object literal, and that emits keys
    // in insertion order. Re-ordering them is not cosmetic: it changes every chain value in every
    // log ever written, which silently invalidates receipts nobody thought to re-verify.
    const { line } = appendEntry('', { event: 'prepare-finished', payloadSha256: PREP, runId: null, now: () => AT });
    expect(Object.keys(JSON.parse(line) as object))
      .toEqual(['artifact', 'rule', 'seq', 'event', 'payloadSha256', 'runId', 'at', 'attestation', 'prev', 'chain']);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().includes('\n')).toBe(false);   // one entry, one line
  });

  it('links the next entry to the head of the log it was handed', () => {
    const first = buildLog([{ event: 'prepare-finished', payloadSha256: PREP }]);
    const head = (JSON.parse(first.trimEnd()) as { chain: string }).chain;
    const { entry } = appendEntry(first, { event: 'runner-started', payloadSha256: PREP, runId: 'r1', now: () => AT });
    expect(entry.seq).toBe(1);
    expect(entry.prev).toBe(head);
  });

  it('REFUSES to append onto an already-corrupted log', () => {
    // Without this, the newest entries of a corrupted receipt are perfectly well-formed and hash
    // correctly against each other. A reader checking the tail would see a sound chain sitting on
    // top of a broken one.
    const l = buildLog(HEALTHY).trimEnd().split('\n');
    const edited = JSON.parse(l[0]!) as { payloadSha256: string };
    edited.payloadSha256 = OTHER;
    l[0] = JSON.stringify(edited);
    expect(() => appendEntry(l.join('\n') + '\n', {
      event: 'runner-finished', payloadSha256: RUN, runId: 'r2', now: () => AT,
    })).toThrow(/chain-broken/);
  });

  it('appends a runner-started with no matching prepare rather than hiding it', () => {
    // Deliberate, and the opposite of what fail-closed would suggest at first glance. If the
    // appender refused to RECORD an out-of-order run, no log could ever contain the violation that
    // element 4 exists to detect — every log this tool produced would verify by construction, and
    // the verifier would be theatre. The write path records what happened; the read path judges it.
    const { entry } = appendEntry('', { event: 'runner-started', payloadSha256: PREP, runId: 'r1', now: () => AT });
    expect(entry.seq).toBe(0);
    expect(() => verifyOrderingReceipt(entry.chain === '' ? '' : JSON.stringify(entry) + '\n', {}))
      .toThrow(/run-before-any-prepare/);
  });
});

describe('a healthy log', () => {
  it('VERIFIES a prepare -> start -> finish sequence and reports what it bound', () => {
    const v = verifyOrderingReceipt(buildLog(HEALTHY), {});
    expect(v.entries).toBe(3);
    expect(v.prepares).toEqual([{ seq: 0, payloadSha256: PREP, at: '2026-08-01T00:00:00.000Z' }]);
    expect(v.runs).toEqual([{ runId: 'r1', startedSeq: 1, preparedSha256: PREP, finishedSeq: 2 }]);
  });

  it('names its own rule and artifact, so the verdict identifies itself', () => {
    // Preregistration §10: an artifact names its own `rule` and `artifact` fields rather than
    // relying on a filename.
    const v = verifyOrderingReceipt(buildLog(HEALTHY), {});
    expect(v.artifact).toBe('ordering-receipt-verification');
    expect(v.rule).toBe(RULE);
  });

  it('states what it does NOT establish, in the verdict itself', () => {
    // Non-negotiable. A report citing this receipt must not be able to read it as proof that no
    // unrecorded exploratory run preceded the recorded one — §9 says no self-attested timestamp
    // can show that. The limits travel WITH the pass, not in documentation beside it.
    const v = verifyOrderingReceipt(buildLog(HEALTHY), {});
    expect(v.limits.join('\n')).toMatch(/self-reported/i);
    expect(v.limits.join('\n')).toMatch(/unrecorded/i);
    expect(v.limits.join('\n')).toMatch(/RECORDED events only/);
  });
});

describe('the retained bytes say what they are', () => {
  /** Finding 4. Preregistration §10: "each artifact additionally names its own `rule` and
   *  `artifact` fields so a file identifies itself without reference to a filename." The `.jsonl`
   *  carried neither, and the self-reported `at` carried no attestation anywhere in the file — both
   *  lived only in the ephemeral stdout verdict, which is not what gets retained. */
  const AT = '2026-08-01T00:00:00.000Z';

  it('names its artifact and rule and attests its clock on the line itself', () => {
    const { line } = appendEntry('', { event: 'prepare-finished', payloadSha256: PREP, runId: null, now: () => AT });
    const o = JSON.parse(line) as Record<string, unknown>;
    expect(o.artifact).toBe('ordering-receipt-entry');
    expect(o.rule).toBe(RULE);
    expect(o.attestation).toMatch(/self-reported/i);
    expect(o.attestation).toMatch(/wall clock/i);
  });

  it('hashes them, so they are attested rather than decorative', () => {
    // The author's objection to self-naming was that unhashed fields would ride in the receipt
    // looking attested while being editable at will. Hashing them is the answer, and this is the
    // test of it. Editing the value cannot show it — the name and the sentence are fixed, so any
    // edit is caught by comparison first — so the line below carries all ten keys while its `chain`
    // is computed over the OLD five-field pre-image. If the three fields were outside the hash,
    // this log would verify.
    const base = { seq: 0, event: 'prepare-finished', payloadSha256: PREP, runId: null,
      at: '2026-08-01T00:00:00.000Z' };
    const line = JSON.stringify({ artifact: LINE_ARTIFACT, rule: RULE, ...base,
      attestation: AT_ATTESTATION, prev: GENESIS, chain: link(GENESIS, base) });
    expect(() => verifyOrderingReceipt(line + '\n', {})).toThrow(/chain-broken/);
  });

  it('REFUSES a whole file re-chained under another artifact name', () => {
    // The forgery the chain alone cannot see: every line re-hashed, so the chain agrees with
    // itself. Only comparing the NAME against the one this format fixes rejects a file that
    // identifies itself as something else.
    const log = buildLog(HEALTHY.map((e) => ({ ...e, artifact: 'ordering-receipt' })));
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/line-misidentified/);
  });

  it('REFUSES a whole file re-chained under another rule', () => {
    const log = buildLog(HEALTHY.map((e) => ({ ...e, rule: 'v2-gate-composition-2026-01-01' })));
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/line-rule-mismatch/);
  });

  it('REFUSES a weakened attestation even when the chain agrees with it', () => {
    // The disclosure is the point of the field. A re-chained file whose attestation reads
    // "verified externally" would carry a lie past every hash check, so the sentence is compared
    // literally rather than merely being present.
    const log = buildLog(HEALTHY.map((e) => ({ ...e, attestation: 'externally attested timestamp' })));
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/attestation-altered/);
  });

  it('keeps the attestation to one sentence naming the clock as self-reported', () => {
    expect(AT_ATTESTATION).toMatch(/self-reported/i);
    expect(AT_ATTESTATION.split('. ')).toHaveLength(1);
  });
});

describe('the self-reported clock', () => {
  it('DISCLOSES a backwards timestamp without failing on it', () => {
    // Deliberately not a failure. The predicate is positional — the chain orders these events, the
    // clocks do not — so refusing here would imply the timestamps carry weight they cannot. But
    // silently ignoring a clock that runs backwards would hide the clearest available sign that
    // the wall clocks in this file are not to be relied on, so it is reported.
    const log = buildLog([
      { event: 'prepare-finished', payloadSha256: PREP, at: '2026-08-01T12:00:00.000Z' },
      { event: 'runner-started', payloadSha256: PREP, runId: 'r1', at: '2026-08-01T09:00:00.000Z' },
    ]);
    const v = verifyOrderingReceipt(log, {});
    expect(v.clockAnomalies).toEqual([
      { seq: 1, at: '2026-08-01T09:00:00.000Z', priorSeq: 0, priorAt: '2026-08-01T12:00:00.000Z' },
    ]);
    expect(v.runs).toHaveLength(1);
  });

  it('reports no anomalies for a forward-running log', () => {
    expect(verifyOrderingReceipt(buildLog(HEALTHY), {}).clockAnomalies).toEqual([]);
  });

  it('measures every entry against the LATEST instant recorded before it, not just the line above', () => {
    // 12:00 -> 09:00 -> 09:30. An adjacent-pair comparison reports seq 1 and then falls silent,
    // because 09:30 is later than 09:00 — yet seq 2 is still earlier than seq 0, and a reader who
    // saw one disclosure would conclude the clock recovered. The stated intent is "the plainest
    // available sign that the self-reported clocks in this file cannot be relied on", and only a
    // running maximum delivers it.
    const log = buildLog([
      { event: 'prepare-finished', payloadSha256: PREP, at: '2026-08-01T12:00:00.000Z' },
      { event: 'runner-started', payloadSha256: PREP, runId: 'r1', at: '2026-08-01T09:00:00.000Z' },
      { event: 'runner-finished', payloadSha256: RUN, runId: 'r1', at: '2026-08-01T09:30:00.000Z' },
    ]);
    expect(verifyOrderingReceipt(log, {}).clockAnomalies).toEqual([
      { seq: 1, at: '2026-08-01T09:00:00.000Z', priorSeq: 0, priorAt: '2026-08-01T12:00:00.000Z' },
      { seq: 2, at: '2026-08-01T09:30:00.000Z', priorSeq: 0, priorAt: '2026-08-01T12:00:00.000Z' },
    ]);
  });

  it('names the entry holding the running maximum, which need not be the line above', () => {
    // The disclosure has to say what the anomaly is measured AGAINST, or the reader cannot tell a
    // clock that stepped back once from one that never caught up.
    const log = buildLog([
      { event: 'prepare-finished', payloadSha256: PREP, at: '2026-08-01T08:00:00.000Z' },
      { event: 'runner-started', payloadSha256: PREP, runId: 'r1', at: '2026-08-01T12:00:00.000Z' },
      { event: 'runner-finished', payloadSha256: RUN, runId: 'r1', at: '2026-08-01T10:00:00.000Z' },
    ]);
    expect(summarize(verifyOrderingReceipt(log, {})))
      .toMatch(/seq 2 reports 2026-08-01T10:00:00\.000Z, earlier than seq 1/);
  });
});

describe('what the verdict says it CHECKED', () => {
  /** Finding 1. An anchored run and a bare one produced byte-identical output, and the anchored one
   *  still printed "Pass --expect-head … to close this" — a limit disclosure that was false for that
   *  invocation. A receipt whose whole purpose is to stop an artifact overselling itself may not
   *  report an unrun check the same way it reports a run one. */
  it('records both optional checks as unsupplied on a bare verify', () => {
    expect(verifyOrderingReceipt(buildLog(HEALTHY), {}).checks)
      .toEqual({ expectPrepare: null, expectHead: null });
  });

  it('records the exact values that were compared when the checks DID run', () => {
    const full = buildLog(HEALTHY);
    const head = verifyOrderingReceipt(full, {}).head;
    expect(verifyOrderingReceipt(full, { expectPrepare: PREP, expectHead: head }).checks)
      .toEqual({ expectPrepare: PREP, expectHead: head });
  });

  it('withdraws the "pass --expect-head" advice once the head IS anchored', () => {
    const full = buildLog(HEALTHY);
    const head = verifyOrderingReceipt(full, {}).head;
    const bare = verifyOrderingReceipt(full, {});
    const anchored = verifyOrderingReceipt(full, { expectHead: head });
    expect(bare.limits.join('\n')).toMatch(/Pass --expect-head/);
    expect(anchored.limits.join('\n')).not.toMatch(/Pass --expect-head/);
    // Anchoring does not make the tail unconditionally sound: the head came in on the command line
    // and this program cannot check where it came from. The anchored limit must say that much.
    expect(anchored.limits.join('\n')).toMatch(/only as strong as/i);
  });

  it('makes an anchored summary distinguishable from an unanchored one', () => {
    const full = buildLog(HEALTHY);
    const head = verifyOrderingReceipt(full, {}).head;
    const bare = summarize(verifyOrderingReceipt(full, {}));
    const anchored = summarize(verifyOrderingReceipt(full, { expectHead: head }));
    expect(bare).not.toEqual(anchored);
    expect(bare).toMatch(/--expect-head: NOT SUPPLIED/);
    expect(anchored).toMatch(new RegExp(`--expect-head: ${head}`));
  });
});

describe('--expect-prepare', () => {
  it('accepts a log whose runs are bound to the expected prepare hash', () => {
    expect(verifyOrderingReceipt(buildLog(HEALTHY), { expectPrepare: PREP }).runs).toHaveLength(1);
  });

  it('FAILS when a run is bound to some other prepare hash', () => {
    // The log below is internally consistent — OTHER really was prepared first. It is simply not
    // the prepare the caller is scoring against.
    const log = buildLog([
      { event: 'prepare-finished', payloadSha256: OTHER },
      { event: 'runner-started', payloadSha256: OTHER, runId: 'r1' },
    ]);
    expect(() => verifyOrderingReceipt(log, { expectPrepare: PREP })).toThrow(/expect-prepare-mismatch/);
  });

  it('FAILS when the log records no run at all to bind', () => {
    // Vacuous truth is the hazard. "Every run was bound to PREP" is trivially satisfied by a log
    // with no runs, and a report would cite that pass as ordering evidence for a run this receipt
    // never saw. The refusal is now flag-independent — see the vacuity block below — so the slug
    // names the log, not the expectation: the file is not element-4 evidence either way.
    const log = buildLog([{ event: 'prepare-finished', payloadSha256: PREP }]);
    expect(() => verifyOrderingReceipt(log, { expectPrepare: PREP })).toThrow(/log-records-no-run/);
  });
});

describe('vacuity — a log with nothing to judge is not a pass', () => {
  /** Finding 2. `log-empty`'s own stated reason is that every predicate below is vacuously true
   *  over an empty log. A log holding prepares and no `runner-started` is vacuous in exactly the
   *  same way — and element 4's entire subject is the `runner-started`. The two cases must agree. */
  it('REFUSES a log of prepare-finished lines with no runner-started at all', () => {
    const log = buildLog([
      { event: 'prepare-finished', payloadSha256: PREP },
      { event: 'prepare-finished', payloadSha256: OTHER },
    ]);
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/log-records-no-run/);
  });

  it('refuses it whether or not an expectation was supplied', () => {
    // Whether the file is ordering evidence cannot depend on which optional flags the reader
    // happened to pass.
    const log = buildLog([{ event: 'prepare-finished', payloadSha256: PREP }]);
    const head = 'd'.repeat(64);
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/log-records-no-run/);
    expect(() => verifyOrderingReceipt(log, { expectHead: head })).toThrow(/log-records-no-run/);
  });

  it('still ACCEPTS a run that started but has not finished', () => {
    // The boundary. An unfinished run is a real recorded run — element 4 is about the ordering of
    // prepare and start — so it must not be swept up by the vacuity refusal.
    const v = verifyOrderingReceipt(buildLog([
      { event: 'prepare-finished', payloadSha256: PREP },
      { event: 'runner-started', payloadSha256: PREP, runId: 'r1' },
    ]), {});
    expect(v.runs).toEqual([{ runId: 'r1', startedSeq: 1, preparedSha256: PREP, finishedSeq: null }]);
  });
});

describe('the trailing newline is part of the format', () => {
  /** Finding 3. A log whose last line lost its terminator verified fine, and then `append` fused
   *  the new entry onto the last line: "appended seq 2" was printed, `wc -l` said 2 for three
   *  events, and every later verify failed. A success message and a chain value that will never
   *  verify, over a receipt that was valid a moment earlier. */
  it('REFUSES to verify a log that does not end in a newline', () => {
    expect(() => verifyOrderingReceipt(buildLog(HEALTHY).trimEnd(), {}))
      .toThrow(/log-not-newline-terminated/);
  });

  it('REFUSES to append onto a log that does not end in a newline', () => {
    expect(() => appendEntry(buildLog(HEALTHY).trimEnd(), {
      event: 'runner-finished', payloadSha256: RUN, runId: 'r1', now: () => '2026-08-01T00:03:00.000Z',
    })).toThrow(/log-not-newline-terminated/);
  });

  it('still opens a log that does not exist yet', () => {
    // The empty string is the ONE unterminated input that is legitimate: there is no last line to
    // fuse onto. Refusing it would make the receipt unstartable.
    expect(appendEntry('', { event: 'prepare-finished', payloadSha256: PREP, runId: null,
      now: () => '2026-08-01T00:00:00.000Z' }).entry.seq).toBe(0);
  });
});

describe('blank-looking lines are unchained bytes, not formatting', () => {
  /** Post-repair finding. `parseLog` filtered blank and whitespace-only lines out before mapping,
   *  so bytes could sit in the retained file covered by NO chain value: a line of spaces spliced
   *  into the receipt survived every verify. The contract is now explicit — the file is entry
   *  lines each terminated by exactly one newline, and the only legitimate blank-looking thing in
   *  it is the zero-length remainder after the final terminator. Nothing is filtered, anywhere. */
  const splice = (log: string, at: number, content: string): string => {
    const lines = log.trimEnd().split('\n');
    lines.splice(at, 0, content);
    return lines.join('\n') + '\n';
  };

  it('REFUSES a line of spaces spliced between two chained entries', () => {
    // The reproduction: every entry still hashes correctly and links correctly, because the
    // spliced line was invisible to the walk. Only refusing it makes the retained bytes and the
    // verified content the same file.
    const log = splice(buildLog(HEALTHY), 1, '   ');
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/log-unchained-bytes/);
  });

  it('REFUSES a whitespace-only line at the tail', () => {
    const log = buildLog(HEALTHY) + ' \t \n';
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/log-unchained-bytes/);
  });

  it('REFUSES an empty line between entries', () => {
    const log = splice(buildLog(HEALTHY), 2, '');
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/log-unchained-bytes/);
  });

  it('names the 1-BASED physical line number an editor would open the file to', () => {
    // With the filter gone, the map index tracks the physical line — but editors count from 1, so
    // "line 1" for the file's second line sent an operator to the wrong bytes. The contract is
    // 1-based physical lines in every line-naming message of this module; `seq` stays the 0-based
    // FIELD value it is.
    const log = splice(buildLog(HEALTHY), 1, '  ');
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/line 2 is whitespace-only/);
  });

  it('REFUSES on the append precheck too, leaving the log unextended', () => {
    // Appending a well-formed line after unchained bytes would put a sound-looking tail on top of
    // a file that is not the sequence it claims to be — the same reason append refuses a broken
    // chain.
    const log = splice(buildLog(HEALTHY), 1, ' ');
    expect(() => appendEntry(log, { event: 'runner-finished', payloadSha256: RUN, runId: 'r1',
      now: () => '2026-08-01T00:03:00.000Z' })).toThrow(/log-unchained-bytes/);
  });

  it('still accepts the zero-length remainder after the final terminator', () => {
    // The boundary: `split('\n')` on a terminated file yields one empty string at the end, and
    // that remainder is the terminator doing its job, not a line.
    expect(verifyOrderingReceipt(buildLog(HEALTHY), {}).entries).toBe(3);
  });

  it('REFUSES a file that is only a newline as unchained bytes, not as empty', () => {
    // '\n' is one empty line plus its terminator. Under the filter it collapsed to `log-empty`;
    // under the contract the empty line is the defect, and the refusal should say so — naming it
    // as the file's FIRST line, 1-based.
    expect(() => verifyOrderingReceipt('\n', {})).toThrow(/log-unchained-bytes/);
    expect(() => verifyOrderingReceipt('\n', {})).toThrow(/line 1 is empty/);
  });
});

describe('tail truncation — the one piecemeal tamper the chain cannot see by itself', () => {
  /** Two runs bound to two different prepares. Dropping the tail leaves a perfectly valid, shorter
   *  chain: nothing inside the file records how long it is meant to be. */
  const TWO_RUNS: Ev[] = [
    { event: 'prepare-finished', payloadSha256: PREP },
    { event: 'runner-started', payloadSha256: PREP, runId: 'r1' },
    { event: 'prepare-finished', payloadSha256: OTHER },
    { event: 'runner-started', payloadSha256: OTHER, runId: 'r2' },
  ];

  it('shows the hazard: truncating turns a failing --expect-prepare into a pass', () => {
    const full = buildLog(TWO_RUNS);
    expect(() => verifyOrderingReceipt(full, { expectPrepare: PREP })).toThrow(/expect-prepare-mismatch/);
    // The same file, minus its last two lines. Run r2 — the one that made the check fail — is gone,
    // and every remaining hash is correct. This is why the limit is disclosed rather than claimed
    // away, and why `head` is reported for an outer artifact to anchor.
    const truncated = full.trimEnd().split('\n').slice(0, 2).join('\n') + '\n';
    expect(verifyOrderingReceipt(truncated, { expectPrepare: PREP }).entries).toBe(2);
  });

  it('DETECTS the truncation once the head is anchored externally', () => {
    const full = buildLog(TWO_RUNS);
    const head = verifyOrderingReceipt(full, {}).head;
    const truncated = full.trimEnd().split('\n').slice(0, 2).join('\n') + '\n';
    expect(() => verifyOrderingReceipt(truncated, { expectHead: head })).toThrow(/head-mismatch/);
    expect(verifyOrderingReceipt(full, { expectHead: head }).head).toBe(head);
  });

  it('states the truncation limit in the verdict', () => {
    expect(verifyOrderingReceipt(buildLog(HEALTHY), {}).limits.join('\n')).toMatch(/truncat/i);
  });
});

describe('the chain covers field VALUES, not the bytes of the file', () => {
  /** Finding 7. `verifyChain` recomputes from named fields, so stored key order and whitespace are
   *  outside the hash. The rewrite below is semantics-preserving — no recorded event changes — but
   *  it means an anchored `head` does NOT fix the retained bytes, and a reader comparing a
   *  `git hash-object` of the log against the anchor will be wrong. The old limit text framed the
   *  undetected class as needing a signature, which understates this narrower one. */
  const reserialise = (text: string): string =>
    text.trimEnd().split('\n').map((l) => {
      const o = Object.entries(JSON.parse(l) as Record<string, unknown>).reverse();
      return JSON.stringify(Object.fromEntries(o), null, 1).replace(/\n\s*/g, ' ');
    }).join('\n') + '\n';

  it('reproduces the undetected class: different bytes, identical head, anchored verify passes', () => {
    const full = buildLog(HEALTHY);
    const head = verifyOrderingReceipt(full, {}).head;
    const rewritten = reserialise(full);
    expect(rewritten).not.toEqual(full);                       // the file on disk is not the file
    expect(verifyOrderingReceipt(rewritten, {}).head).toBe(head);
    expect(verifyOrderingReceipt(rewritten, { expectHead: head }).entries).toBe(3);
  });

  it('says so in the limits, in the terms a reader would get wrong', () => {
    const limits = verifyOrderingReceipt(buildLog(HEALTHY), {}).limits.join('\n');
    expect(limits).toMatch(/not the BYTES/);
    expect(limits).toMatch(/key order/);
    expect(limits).toMatch(/git hash-object/);
  });
});

describe('malformed input', () => {
  it('REFUSES an empty log rather than passing a predicate over nothing', () => {
    expect(() => verifyOrderingReceipt('', {})).toThrow(/log-empty/);
  });

  it('REFUSES a line that is not a well-formed entry', () => {
    const log = buildLog(HEALTHY).trimEnd().split('\n');
    log[1] = JSON.stringify({ artifact: LINE_ARTIFACT, rule: RULE, seq: 1, event: 'runner-started',
      payloadSha256: 'not-a-sha', runId: 'r1', at: '2026-08-01T00:01:00.000Z',
      attestation: AT_ATTESTATION, prev: GENESIS, chain: GENESIS });
    expect(() => verifyOrderingReceipt(log.join('\n') + '\n', {})).toThrow(/log-unparsable/);
  });

  it('REFUSES an unrecognised event name found in the log', () => {
    // The appender refuses these at the flag, but a hand-edited log can still carry one, and an
    // event the predicate does not model would sit in the log contributing nothing while looking
    // like evidence.
    const log = buildLog([
      { event: 'prepare-finished', payloadSha256: PREP },
      { event: 'runner-resumed', payloadSha256: PREP, runId: 'r1' },
    ]);
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/unknown-event/);
  });

  it('REFUSES a prepare-finished carrying a runId, and a runner event without one', () => {
    // The same asymmetry the appender enforces, re-checked on read: the flag check protects the
    // write path, and this protects the file.
    expect(() => verifyOrderingReceipt(buildLog([
      { event: 'prepare-finished', payloadSha256: PREP, runId: 'r1' },
    ]), {})).toThrow(/run-id-on-prepare/);
    expect(() => verifyOrderingReceipt(buildLog([
      { event: 'prepare-finished', payloadSha256: PREP },
      { event: 'runner-started', payloadSha256: PREP, runId: null },
    ]), {})).toThrow(/missing-run-id/);
  });
});

describe('run identity', () => {
  it('FAILS when one runId is claimed by two runner-started lines', () => {
    // A reused run id makes the binding ambiguous: a runner-finished naming it could belong to
    // either start, so "this output came from the run bound to that prepare" stops being decidable.
    const log = buildLog([
      { event: 'prepare-finished', payloadSha256: PREP },
      { event: 'runner-started', payloadSha256: PREP, runId: 'r1' },
      { event: 'runner-started', payloadSha256: PREP, runId: 'r1' },
    ]);
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/duplicate-run-id/);
  });

  it('FAILS a runner-finished with no earlier runner-started of that runId', () => {
    const log = buildLog([
      { event: 'prepare-finished', payloadSha256: PREP },
      { event: 'runner-started', payloadSha256: PREP, runId: 'r1' },
      { event: 'runner-finished', payloadSha256: RUN, runId: 'r2' },
    ]);
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/finish-without-start/);
  });

  it('FAILS a runner-finished that precedes its own runner-started', () => {
    // Position, not mere presence. `r1` does start — one line later. Matching on presence alone
    // would accept a finish recorded before the run it claims to close.
    const log = buildLog([
      { event: 'prepare-finished', payloadSha256: PREP },
      { event: 'runner-finished', payloadSha256: RUN, runId: 'r1' },
      { event: 'runner-started', payloadSha256: PREP, runId: 'r1' },
    ]);
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/finish-without-start/);
  });

  it('FAILS a second runner-finished for the same runId', () => {
    const log = buildLog([
      { event: 'prepare-finished', payloadSha256: PREP },
      { event: 'runner-started', payloadSha256: PREP, runId: 'r1' },
      { event: 'runner-finished', payloadSha256: RUN, runId: 'r1' },
      { event: 'runner-finished', payloadSha256: OTHER, runId: 'r1' },
    ]);
    expect(() => verifyOrderingReceipt(log, {})).toThrow(/duplicate-run-finish/);
  });
});

describe('chain integrity', () => {
  const lines = () => buildLog(HEALTHY).trimEnd().split('\n');

  it('FAILS with chain-broken when one line\'s payloadSha256 is edited', () => {
    // Editing the prepare hash is how a log would be made to "cover" a run it never covered. The
    // line stays well-formed JSON and its position never changes, so only the hash catches it.
    const l = lines();
    const edited = JSON.parse(l[0]!) as { payloadSha256: string };
    edited.payloadSha256 = OTHER;
    l[0] = JSON.stringify(edited);
    expect(() => verifyOrderingReceipt(l.join('\n') + '\n', {})).toThrow(/chain-broken/);
  });

  it('FAILS when a middle line is deleted', () => {
    // Dropping the runner-started leaves prepare and finish, each hashing correctly on its own.
    // Only the SEQUENCE knows a line is missing.
    const l = lines();
    l.splice(1, 1);
    expect(() => verifyOrderingReceipt(l.join('\n') + '\n', {})).toThrow(/chain-broken/);
  });

  it('FAILS a repeated seq even when every prev and chain is internally consistent', () => {
    // Isolates the CONTIGUITY check. This log is forged, not merely edited: seq 1 appears twice and
    // both lines hash correctly over their own contents and link correctly to the line above. Only
    // the requirement that seq be 0,1,2,… by POSITION rejects it. Without it, `seq` would be a
    // decorative field an attacker could set freely.
    let prev = GENESIS;
    const l = [0, 1, 1].map((seq, i) => {
      const base = { artifact: LINE_ARTIFACT, rule: RULE, seq, event: 'prepare-finished',
        payloadSha256: PREP, runId: null, at: `2026-08-01T00:0${i}:00.000Z`,
        attestation: AT_ATTESTATION };
      const chain = link(prev, base);
      const line = JSON.stringify({ ...base, prev, chain });
      prev = chain;
      return line;
    });
    expect(() => verifyOrderingReceipt(l.join('\n') + '\n', {})).toThrow(/chain-broken/);
  });

  it('FAILS a broken prev even when that line hashes correctly over its own broken prev', () => {
    // Isolates the LINKAGE check. Line 1 declares prev = genesis and hashes itself accordingly, so
    // recomputation agrees with it and seq is contiguous. What it no longer does is depend on line
    // 0 — and a line that does not depend on its predecessor leaves that predecessor free to be
    // replaced with anything.
    const first = buildLog([{ event: 'prepare-finished', payloadSha256: PREP }]).trimEnd();
    const base = { artifact: LINE_ARTIFACT, rule: RULE, seq: 1, event: 'runner-started',
      payloadSha256: PREP, runId: 'r1', at: '2026-08-01T00:01:00.000Z', attestation: AT_ATTESTATION };
    const orphan = JSON.stringify({ ...base, prev: GENESIS, chain: link(GENESIS, base) });
    expect(() => verifyOrderingReceipt(first + '\n' + orphan + '\n', {})).toThrow(/chain-broken/);
  });

  it('FAILS when two lines are reordered', () => {
    // Reordering is the tamper that matters most here: it is precisely how a runner-started would
    // be moved to look as though it followed a prepare.
    const l = lines();
    expect(() => verifyOrderingReceipt([l[0], l[2], l[1]].join('\n') + '\n', {})).toThrow(/chain-broken/);
  });
});
