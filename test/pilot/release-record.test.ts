import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { RULE } from '../../scripts/pilot/gate-set.js';
import { releaseRecord } from '../../scripts/pilot/release-record.js';

/** Evidence-chain element 8 (preregistration §9): "a release record binding the score hash and
 *  showing the preregistered consequence was actually applied".
 *
 *  Every other artifact in the chain records how the measurement was made. This one records whether
 *  anyone obeyed it, so the tests below are overwhelmingly about REFUSALS: the failure worth
 *  catching is a gate that blocked followed by a release anyway, and an artifact that cannot refuse
 *  that is decoration. */

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const BLOCKING_REASONS = [
  'Hit@1 — exposure 1 is below the minimum of 2, so the primary measurement did not happen ' +
    '(PARTIALLY EXERCISED — 1/2 (minimum not met))',
  'Stability — divergent',
];

/** A `gate-score`-shaped file, built here rather than by importing `score-gate.ts`.
 *
 *  Two reasons. `score-gate.ts` is entry-point-guarded, so importing it from the module under test
 *  is forbidden — and a fixture produced by the same module the program refuses to trust would test
 *  nothing about the bytes that actually arrive from disk. `hash: false` omits `payloadSha256`
 *  entirely; a string overrides it with a wrong one. */
const scoreFile = (over: {
  blocked?: boolean; reasons?: string[]; rule?: string; artifact?: string; hash?: string | false;
  extraPayload?: Record<string, unknown>;
} = {}): unknown => {
  const blocked = over.blocked ?? true;
  const payload = {
    rule: over.rule ?? RULE,
    hit1: { x: 1, n: 2, pass: false, bound: 0.0253, label: 'PARTIALLY EXERCISED — 1/2 (minimum not met)' },
    recall: { x: 2, n: 2, pass: true, bound: 0.2236 },
    release: { blocked, reasons: over.reasons ?? (blocked ? BLOCKING_REASONS : []) },
    // The score's payload is not this program's schema to fix — see the test on extra fields.
    ...over.extraPayload,
  };
  const envelope: Record<string, unknown> = { artifact: over.artifact ?? 'gate-score' };
  if (over.hash !== false) envelope.payloadSha256 = over.hash ?? sha256(JSON.stringify(payload));
  envelope.payload = payload;
  envelope.receipts = { scoredAt: '2026-08-18T10:00:00.000Z', attestation: 'self-reported wall clock' };
  return envelope;
};

/** A plausible ordering-log head. Any 64 lowercase hex string would do — this program never reads
 *  the log — but a `sha256()` of something makes the fixture look like the value it stands for. */
const ORDERING_HEAD = sha256('ordering-log head at the close');

const record = (over: Parameters<typeof releaseRecord>[0] extends infer _ ? Partial<{
  score: unknown; decision: string; consequence: string; evidence: string; orderingHead: string;
}> : never = {}) => releaseRecord({
  // `'score' in over`, not `?? scoreFile()`: a test that hands the program `null` must actually
  // hand it `null`. The nullish default silently substituted a healthy fixture and the refusal
  // test passed against the wrong input.
  score: 'score' in over ? over.score : scoreFile(),
  decision: over.decision ?? 'blocked',
  consequence: over.consequence ?? 'v0.1.0 was NOT tagged and no plugin redeploy was performed',
  evidence: over.evidence ?? 'no tag v0.1.0 exists at the freeze commit; deploy log has no entry for the window',
  orderingHead: over.orderingHead ?? ORDERING_HEAD,
  now: () => '2026-08-18T11:00:00.000Z',
});

describe('binding the record to the score', () => {
  it('carries the score\'s blocking reasons verbatim', () => {
    const r = record();
    expect(r.payload.gateReasons).toEqual(BLOCKING_REASONS);
  });

  it('mirrors the score\'s own blocked flag rather than inferring one from the decision', () => {
    expect(record().payload.gateBlocked).toBe(true);
    expect(record({ score: scoreFile({ blocked: false }), decision: 'released' }).payload.gateBlocked).toBe(false);
  });

  it('accepts payload fields it does not know about, and binds them by the same hash', () => {
    // Deliberately NOT a closed schema. `ScoreFile` declares the minimum this program reads —
    // `rule` and `release` — and the score's payload is the scorer's to define: when the parent
    // hashes it moves INTO that payload (`gateSetSha256`, `adjudicationSha256`), this record reaches
    // them transitively through `scoreSha256` and must not carry a second copy. Two copies of one
    // hash is a drift risk, and a record refusing a payload field it never reads would break the
    // chain every time an upstream artifact gained one.
    const s = scoreFile({ extraPayload: { gateSetSha256: 'a'.repeat(64), adjudicationSha256: 'b'.repeat(64) } });
    const r = record({ score: s });
    expect(r.payload.scoreSha256).toBe((s as { payloadSha256: string }).payloadSha256);
    expect(Object.keys(r.payload)).not.toContain('gateSetSha256');
    expect(Object.keys(r.payload)).not.toContain('adjudicationSha256');
    // Transitivity is not an assumption here — the bound hash is over bytes that contain them.
    expect(sha256(JSON.stringify((s as { payload: unknown }).payload))).toBe(r.payload.scoreSha256);
    expect(JSON.stringify((s as { payload: unknown }).payload)).toContain('adjudicationSha256');
  });

  it('binds the score by hash: scoreSha256 is the score\'s own payloadSha256', () => {
    // The chain element is "a release record BINDING THE SCORE HASH". A record naming a filename
    // or a decision alone binds nothing — the score it was written against has to be identifiable
    // from the record itself, after both files have been moved and renamed.
    const s = scoreFile() as { payloadSha256: string };
    expect(record({ score: s }).payload.scoreSha256).toBe(s.payloadSha256);
  });
});

describe('the declared decision must agree with the score', () => {
  it('REFUSES a blocked gate declared released, and quotes what was ignored', () => {
    // The headline refusal of the whole chain. Every other artifact records how the measurement was
    // made; only this one can catch a gate that blocked followed by a release anyway.
    expect(() => record({ decision: 'released' })).toThrow(/consequence-not-applied/);
    // The message must carry the score's OWN reasons. "Decision does not match" leaves the reader
    // to go and find what was overridden, which is precisely the work this record exists to do.
    for (const reason of BLOCKING_REASONS) {
      expect(() => record({ decision: 'released' })).toThrow(reason.split(' —')[0]!);
    }
    let message = '';
    try { record({ decision: 'released' }); } catch (e) { message = (e as Error).message; }
    for (const reason of BLOCKING_REASONS) expect(message).toContain(reason);
  });

  it('REFUSES an unblocked gate declared blocked, because the claim runs in both directions', () => {
    // Not the symmetric-for-tidiness case. The preregistration's claim is about the RULE governing
    // the decision, so a record inventing a block the gate never issued misrepresents the gate just
    // as much as one ignoring a real block — and it is the shape that manufactures a reason to
    // withhold a release the protocol had already cleared.
    expect(() => record({ score: scoreFile({ blocked: false }), decision: 'blocked' }))
      .toThrow(/consequence-overstated/);
  });

  it('REFUSES a decision the vocabulary does not contain instead of treating it as not-released', () => {
    expect(() => record({ decision: 'partially released' })).toThrow(/decision-unrecognised/);
    expect(() => record({ decision: 'BLOCKED' })).toThrow(/decision-unrecognised/);
  });
});

describe('the score being bound must be trustworthy first', () => {
  it('REFUSES a score whose payloadSha256 does not match its payload', () => {
    // Binding to a hash is worth nothing if the hash is not the payload's. An edited `release`
    // block with the original hash left in place is the exact forgery this catches.
    expect(() => record({ score: scoreFile({ hash: 'f'.repeat(64) }) })).toThrow(/score-tampered/);
  });

  it('REFUSES a score that recomputes correctly but was edited before it was hashed', () => {
    // The same check from the other side: rewriting the payload AND its hash produces a
    // self-consistent file. That is not caught here and must not be claimed — what the record can
    // say is which bytes it bound, which is why `scoreSha256` is recorded rather than a verdict.
    const s = scoreFile({ blocked: false }) as { payload: { release: { blocked: boolean } } };
    s.payload.release.blocked = true;      // hash still describes the pre-edit payload
    expect(() => record({ score: s })).toThrow(/score-tampered/);
  });

  it('REFUSES a score carrying no payloadSha256 at all', () => {
    // An unhashed score cannot be bound to: `scoreSha256` would have to be invented, and a record
    // that names no identifiable score satisfies element 8 in form only.
    expect(() => record({ score: scoreFile({ hash: false }) })).toThrow(/score-unhashed/);
  });

  it('REFUSES a present-but-non-canonical hash under its OWN slug, not as an unhashed score', () => {
    // An uppercase-hex SHA-256 is a hash that is present and correct. It was refused as
    // `score-unhashed` with a message that quoted the hash while saying there was not one — the
    // operator is told to go and find a missing hash that is sitting in front of them. The intended
    // split was missing -> `score-unhashed`, non-recomputing -> `score-tampered`; this is neither.
    const s = scoreFile() as { payloadSha256: string };
    s.payloadSha256 = s.payloadSha256.toUpperCase();
    expect(() => record({ score: s })).toThrow(/score-hash-malformed/);
    let message = '';
    try { record({ score: s }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain(s.payloadSha256);      // quotes what it found
    expect(message).toMatch(/64 lowercase hex/);     // and says what is wrong with it
    expect(message).not.toMatch(/no payloadSha256|with no hash/);
  });

  it('REFUSES every other unusable spelling of a present hash under the same slug', () => {
    // Uppercase is the interesting instance, not the class. Anything present that is not 64
    // lowercase hex is a hash this record cannot bind by, and none of them is an ABSENT hash.
    for (const hash of ['a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ' ' + 'a'.repeat(64),
      'sha256:' + 'a'.repeat(64)]) {
      expect(() => record({ score: scoreFile({ hash }) }), hash).toThrow(/score-hash-malformed/);
    }
    // A non-string is present too, and equally unbindable.
    const s = scoreFile() as Record<string, unknown>;
    s.payloadSha256 = 12345;
    expect(() => record({ score: s })).toThrow(/score-hash-malformed/);
  });

  it('REFUSES a file that is not a gate-score, however well-formed', () => {
    expect(() => record({ score: scoreFile({ artifact: 'gate-set' }) })).toThrow(/score-not-a-gate-score/);
  });

  it('REFUSES a score scored under a different rule than this record declares', () => {
    expect(() => record({ score: scoreFile({ rule: 'v1-gate-composition-2026-06-01' }) }))
      .toThrow(/rule-mismatch/);
  });

  it('REFUSES a score whose blocked flag contradicts its own reasons', () => {
    // `blocked` is derived from `reasons.length` where the score is produced, so the two can only
    // disagree in a file somebody edited. Reconciling silently would pick a winner between two
    // statements about the same fact.
    expect(() => record({ score: scoreFile({ blocked: false, reasons: ['Stability — divergent'] }) }))
      .toThrow(/score-self-contradictory/);
    expect(() => record({ score: scoreFile({ blocked: true, reasons: [] }) }))
      .toThrow(/score-self-contradictory/);
  });

  it('REFUSES a score whose blocking reason says nothing, because the refusal has to quote it', () => {
    // `{ blocked: true, reasons: [''] }` was ACCEPTED: `gateReasons: ['']` went into the hashed
    // payload, the CLI printed "gate BLOCKED (1 reason(s))", and `consequence-not-applied` rendered
    // "  - " followed by nothing. That refusal exists so the reader "does not have to go and find
    // what was overridden" — quoting an empty string is the same failure with a receipt.
    //
    // The justification is the one the file already makes for `score-self-contradictory`: a scorer
    // cannot emit this, so it only exists in a file somebody edited, and reconciling it would mean
    // inventing the text that was removed.
    for (const reasons of [[''], ['   '], ['\u200b'], ['Stability — divergent', '']]) {
      expect(() => record({ score: scoreFile({ blocked: true, reasons }) }), JSON.stringify(reasons))
        .toThrow(/score-blank-reason/);
    }
    // Positional, so an operator reading the refusal knows WHICH one to go and look at.
    let message = '';
    try { record({ score: scoreFile({ blocked: true, reasons: ['Stability — divergent', ''] }) }); }
    catch (e) { message = (e as Error).message; }
    expect(message).toContain('reasons[1]');
  });

  it('REFUSES a score whose release block is missing or mistyped rather than reading through it', () => {
    expect(() => record({ score: { artifact: 'gate-score', payloadSha256: 'a'.repeat(64) } }))
      .toThrow(/score-malformed/);
    expect(() => record({ score: null })).toThrow(/score-malformed/);
    const noReasons = { artifact: 'gate-score', payload: { rule: RULE, release: { blocked: true } } } as Record<string, unknown>;
    noReasons.payloadSha256 = sha256(JSON.stringify(noReasons.payload));
    expect(() => record({ score: noReasons })).toThrow(/score-malformed/);
  });
});

describe('the consequence must actually be described', () => {
  it('REFUSES an empty or whitespace-only consequence', () => {
    // §9a asks for what was NOT released, or the release that followed. An empty string answers
    // neither while producing a file that looks like element 8 of the chain.
    expect(() => record({ consequence: '' })).toThrow(/consequence-unevidenced/);
    expect(() => record({ consequence: '   \t\n ' })).toThrow(/consequence-unevidenced/);
  });

  it('REFUSES an empty or whitespace-only evidence', () => {
    expect(() => record({ evidence: '' })).toThrow(/consequence-unevidenced/);
    expect(() => record({ evidence: '\n\n' })).toThrow(/consequence-unevidenced/);
  });

  it('REFUSES text made only of characters that carry no content, not merely of spaces', () => {
    // `trim()` strips White_Space and nothing else, so a string of U+200B (ZERO WIDTH SPACE,
    // category Cf since Unicode 4.0.1) went straight through: `--consequence $'\u200b' --evidence
    // $'\u200b'` exited 0 and wrote a valid, hashed release record carrying no information. That is
    // exactly the outcome this refusal's own message calls "worse than an absent one", so the
    // refusal has to cover it. Escapes, not literals: an invisible character pasted into a test
    // file is unreadable in every diff that would ever review it.
    for (const b of ['\u200b', '\ufeff', '\u2060', '\u200e\u200f', ' \u200b\t\n', '\u00a0',
      '\u180e', '\u0000']) {
      expect(() => record({ consequence: b }), JSON.stringify(b)).toThrow(/consequence-unevidenced/);
      expect(() => record({ evidence: b }), JSON.stringify(b)).toThrow(/consequence-unevidenced/);
    }
  });

  it('accepts a short answer padded with zero-width characters, rather than policing the prose', () => {
    // The check asks whether ANY character carries content, not whether the sentence is a good one.
    // Judging that is not this program's job, and a stricter rule would refuse legitimate records —
    // a bare tag name is a sound answer to "what was not released".
    const padded = '\u200bv0.1.0 was NOT tagged\u200b';
    expect(record({ consequence: padded }).payload.consequence).toBe(padded);
    expect(record({ evidence: '-' }).payload.evidence).toBe('-');
  });

  it('reports the decision mismatch first when the text is blank too', () => {
    // Ordering is a judgment, recorded as one: the blank field is the cheaper defect, but a record
    // whose decision contradicts the gate is the failure this element exists for, and that is what
    // the operator must be told about.
    expect(() => record({ decision: 'released', consequence: '' })).toThrow(/consequence-not-applied/);
  });

  it('keeps the surrounding whitespace it was given rather than silently rewriting the operator\'s text', () => {
    const r = record({ consequence: '  nothing shipped  ' });
    expect(r.payload.consequence).toBe('  nothing shipped  ');
  });
});

describe('anchoring the ordering log', () => {
  it('carries the ordering log\'s head in the HASHED payload', () => {
    // The ordering receipt (element 4) verifies a chain that nothing fixes the END of: truncating
    // the last lines leaves a shorter chain that verifies perfectly, and the run whose binding
    // would have failed is simply gone. `ordering-receipt --mode verify --expect-head` closes that,
    // and until now nothing PRODUCED a head to pass it. Element 8 is the last artifact written, so
    // it is the one that can record where the log ended.
    expect(record().payload.orderingHead).toBe(ORDERING_HEAD);
    // In the hashed half, not the receipts: an anchor that can be rewritten without disturbing the
    // record's own hash anchors nothing.
    const r = record();
    expect(r.payloadSha256).toBe(sha256(JSON.stringify(r.payload)));
    expect(JSON.stringify(r.payload)).toContain(ORDERING_HEAD);
  });

  it('REFUSES a head that is not 64 lowercase hex, including a correct one spelled in uppercase', () => {
    // Same rule as every other hash in the chain, for the same reason: the value is recorded
    // verbatim and compared as a string against what `ordering-receipt` prints, so a second
    // spelling is a head that will not match the log it came from.
    for (const head of ['', '   ', ORDERING_HEAD.toUpperCase(), ORDERING_HEAD.slice(0, 63),
      ORDERING_HEAD + '0', 'g'.repeat(64), 'sha256:' + ORDERING_HEAD]) {
      expect(() => record({ orderingHead: head }), JSON.stringify(head))
        .toThrow(/ordering-head-malformed/);
    }
  });

  it('still reports the decision mismatch first when the head is malformed too', () => {
    // Same judgment as the blank consequence: a malformed head is the cheaper defect, and an
    // operator told only about it would fix the argument and re-run into the release the gate
    // had already forbidden.
    expect(() => record({ decision: 'released', orderingHead: 'nope' })).toThrow(/consequence-not-applied/);
  });

  it('says in the record what the anchor does NOT establish', () => {
    // The anchor fixes the log's TAIL as of this moment. It does not establish that the log records
    // every run that happened — an exploratory run that was never appended leaves no gap to find —
    // and this program never opens the log at all, so it cannot even say the head is a real one.
    // A reader who takes `orderingHead` for a verified ordering has been misled by the artifact.
    const { attestation } = record().receipts;
    expect(attestation).toMatch(/orderingHead/);
    expect(attestation).toMatch(/did not read|does not read/i);
    expect(attestation).toMatch(/every run/i);
  });
});

describe('the envelope', () => {
  it('names itself in both halves and hashes exactly the payload', () => {
    const r = record();
    expect(r.artifact).toBe('release-record');
    // §10: "each artifact additionally names its own rule and artifact fields so a file identifies
    // itself without reference to a filename". The payload spells it `artifactKind` because the
    // envelope already owns `artifact`, and the HASHED half is the half that has to be
    // self-describing — an envelope field can be rewritten without disturbing the hash.
    expect(r.payload.artifactKind).toBe('release-record');
    expect(r.payload.rule).toBe(RULE);
    expect(r.payloadSha256).toBe(sha256(JSON.stringify(r.payload)));
    expect(Object.keys(r.payload)).toEqual(
      ['rule', 'artifactKind', 'scoreSha256', 'orderingHead', 'gateBlocked', 'gateReasons', 'decision',
        'consequence', 'evidence']);
  });

  it('is deterministic apart from its receipts', () => {
    const a = releaseRecord({ score: scoreFile(), decision: 'blocked', consequence: 'c', evidence: 'e',
      orderingHead: ORDERING_HEAD, now: () => '2026-08-18T11:00:00.000Z' });
    const b = releaseRecord({ score: scoreFile(), decision: 'blocked', consequence: 'c', evidence: 'e',
      orderingHead: ORDERING_HEAD,
      now: () => '2027-01-01T00:00:00.000Z' });
    expect(b.payloadSha256).toBe(a.payloadSha256);
    expect(b.receipts.recordedAt).not.toBe(a.receipts.recordedAt);
  });

  it('attests the consequence and says so, rather than implying it observed one', () => {
    // The one claim this artifact must never make. It verifies that a declared decision agrees
    // with a score; it has no way to know whether the described release physically happened, and a
    // reader who takes it for an observation has been misled by the artifact itself.
    const { attestation, recordedAt } = record().receipts;
    expect(recordedAt).toBe('2026-08-18T11:00:00.000Z');
    expect(attestation).toMatch(/attests/i);
    expect(attestation).toMatch(/self-reported/i);
    expect(attestation).toMatch(/cannot verify/i);
  });
});
