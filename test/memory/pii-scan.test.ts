import { describe, it, expect } from 'vitest';
import { detectPII, type PiiHit } from '../../src/memory/pii-scan.js';

const kinds = (hits: PiiHit[]) => hits.map((h) => h.kind).sort();

// Build a checksum-valid KR RRN (runtime-assembled; keeps no real-looking RRN literal in source).
function rrnWithChecksum(yymmdd: string, first6OfSecond: string): string {
  const d = (yymmdd + first6OfSecond).split('').map(Number);
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const sum = d.reduce((a, n, i) => a + n * w[i]!, 0);
  const check = (11 - (sum % 11)) % 10;
  return `${yymmdd}-${first6OfSecond}${check}`;
}

// Shared Luhn-valid digit-string builder (used by the card-length and domain-guard describe blocks
// below, which previously duplicated this loop): appends whichever check digit (0-9) makes `body`
// Luhn-valid, self-verified at runtime rather than hand-picked.
function luhnAppendCheckDigit(body: string): string {
  for (let c = 0; c <= 9; c++) {
    const candidate = body + String(c);
    let sum = 0, dbl = false;
    for (let i = candidate.length - 1; i >= 0; i--) {
      let d = candidate.charCodeAt(i) - 48;
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d; dbl = !dbl;
    }
    if (sum % 10 === 0) return candidate;
  }
  throw new Error(`no Luhn-valid check digit for body "${body}"`);
}

describe('detectPII', () => {
  it('detects an email as low severity', () => {
    const hits = detectPII('contact kim@example.com please');
    expect(hits.some((h) => h.kind === 'email' && h.severity === 'low')).toBe(true);
  });

  it('detects a US-style phone number as low severity', () => {
    const hits = detectPII('call 415-555-0132 today');
    expect(hits.some((h) => h.kind === 'phone' && h.severity === 'low')).toBe(true);
  });

  it('detects a KR mobile number as low severity', () => {
    const hits = detectPII('내 번호는 010-1234-5678 이야');
    expect(hits.some((h) => h.kind === 'phone' && h.severity === 'low')).toBe(true);
  });

  it('detects a Luhn-valid credit card as high severity', () => {
    // 4111 1111 1111 1111 is a Luhn-valid synthetic Visa test number (not a real account).
    const hits = detectPII('card 4111 1111 1111 1111 on file');
    expect(hits.some((h) => h.kind === 'credit_card' && h.severity === 'high')).toBe(true);
  });

  it('does NOT flag a Luhn-invalid 16-digit run as a credit card', () => {
    const hits = detectPII('order 1234 5678 9012 3456 shipped');
    expect(hits.some((h) => h.kind === 'credit_card')).toBe(false);
  });

  it('does NOT false-positive on a plain long number', () => {
    expect(detectPII('the build took 1234567890 milliseconds')).toEqual([]);
  });

  it('detects a checksum-valid KR RRN as high severity national_id', () => {
    const rrn = rrnWithChecksum('900101', '100000'); // runtime-assembled, checksum-valid, synthetic
    const hits = detectPII(`주민번호 ${rrn} 입력`);
    expect(hits.some((h) => h.kind === 'national_id' && h.severity === 'high')).toBe(true);
  });

  it('does NOT flag a bad-checksum RRN-shaped number (validation cuts the false positive)', () => {
    expect(detectPII('order 000000-0000000 shipped').some((h) => h.kind === 'national_id')).toBe(false);
  });

  it('does NOT flag a structurally-invalid SSN (area 000)', () => {
    expect(detectPII('ref 000-12-3456 here').some((h) => h.kind === 'national_id')).toBe(false);
  });

  it('detects a US SSN shape as high severity national_id', () => {
    const hits = detectPII('ssn 123-45-6789 redact me');
    expect(hits.some((h) => h.kind === 'national_id' && h.severity === 'high')).toBe(true);
  });

  it('reports a span (start/end) inside the input for each hit', () => {
    const text = 'mail kim@example.com here';
    const hit = detectPII(text).find((h) => h.kind === 'email')!;
    expect(text.slice(hit.start, hit.end)).toBe('kim@example.com');
  });

  it('returns all hits across multiple kinds in one pass', () => {
    const hits = detectPII('kim@example.com and lee@example.org and 415-555-0132');
    expect(kinds(hits)).toContain('email');
    expect(hits.filter((h) => h.kind === 'email')).toHaveLength(2);
    expect(hits.some((h) => h.kind === 'phone')).toBe(true);
  });

  it('returns [] for clean prose', () => {
    expect(detectPII('the deploy uses the blue cluster')).toEqual([]);
  });
});

// F12: the email pattern's domain class `[A-Za-z0-9.-]+` contains BOTH `.` and letters, so it
// overlaps the `\.[A-Za-z]{2,}` that follows it. On a string that never completes a match the engine
// has to try every split of the run — quadratic. Measured on the crafted non-match: 50K 0.9s,
// 100K 3.8s, 200K 15.2s, and MAX_FORM_SCAN is exactly 200,000, so a single crafted payload could
// hold the egress scan for a quarter of a minute.
describe('email scanning is linear in the input', () => {
  // A DOT-RICH run is what triggers it, and finding that mattered: `a@` + 200k plain letters is
  // linear, because with no dot at all the `\.` can fail immediately. The blow-up needs many
  // candidate split points between the domain run and the `\.` that follows it, and then no valid
  // TLD to finish on. Measured on the current pattern: 50k 835ms, 200k 13.4s — a ratio of 16.1 for
  // 4x the input, which is quadratic to two significant figures.
  const crafted = (n: number): string => `a@${'a.'.repeat(Math.floor(n / 2))}`;

  it('scans a max-size crafted non-match promptly', () => {
    const t0 = performance.now();
    expect(detectPII(crafted(200_000)).filter((h) => h.kind === 'email')).toHaveLength(0);
    // Generous by two orders of magnitude against the 15s measurement: this is asserting the
    // absence of catastrophic backtracking, not a performance budget.
    expect(performance.now() - t0).toBeLessThan(2_000);
  }, 30_000);

  it('cost grows roughly linearly, not quadratically, with input size', () => {
    const at = (n: number): number => { const t = performance.now(); detectPII(crafted(n)); return performance.now() - t; };
    at(20_000);                                   // warm up, so JIT does not distort the ratio
    const small = Math.max(at(50_000), 1);
    const large = at(200_000);
    // 4x the input: linear predicts ~4x the time, quadratic predicts ~16x. Anything under 8x rules
    // out the quadratic blow-up while leaving room for measurement noise on a loaded machine.
    expect(large / small).toBeLessThan(8);
  }, 30_000);

  it('still matches the addresses it matched before, and still rejects a bare local part', () => {
    // Pins the match SET across the rewrite, not just the cost: a multi-label domain with a hyphen
    // and a two-part TLD, a short one, and two shapes that must stay unmatched.
    const text = 'write to First.Last+tag@sub-domain.example.co.uk or ops@x.io, but not a@b or plain-text';
    const emails = detectPII(text).filter((h) => h.kind === 'email');
    expect(emails.map((h) => text.slice(h.start, h.end)))
      .toEqual(['First.Last+tag@sub-domain.example.co.uk', 'ops@x.io']);
    expect(emails.every((h) => h.severity === 'low')).toBe(true);
  });
});

// The card candidate is 13-19 digits, Luhn-validated. Narrowing either end IS measured here: the two
// accept cases below (13 and 19 digits) fail if either boundary moves inward, at any one of the sites
// that enforces it. Widening the LOWER bound is a different story: it is enforced at THREE independent
// sites — the CARD_RE regex quantifier `{13,19}`, the `digits.length >= 13` check at the detectPII call
// site, and the same length floor inside luhnValid — and the "12 digits" reject case below only turns
// red when all three move together. Measured: widening the regex alone leaves the suite green (the
// call site still filters the resulting 12-digit digest out); widening both `>= 13` guards while
// leaving the regex at `{13,19}` also leaves it green (CARD_RE then never matches a 12-digit run for
// either downstream guard to see). So a single-site widening of the lower bound is NOT measured by
// this suite. (The upper bound has no matching above-window case: a 20-digit input would not
// discriminate either, because the call site's `<= 19` independently caps it regardless of what the
// regex or luhnValid allow — that case would ship unable to fail.) Numbers are assembled at runtime
// from a Luhn-valid seed rather than written as literals, matching this file's existing discipline for
// RRNs.
describe('card-length window boundaries', () => {
  // Build a Luhn-valid digit string of exactly `len` digits (all-4s body + Luhn check digit).
  const luhnOf = (len: number): string => luhnAppendCheckDigit('4'.repeat(len - 1));

  it('accepts the shortest card in the window (13 digits)', () => {
    expect(kinds(detectPII(`card ${luhnOf(13)} on file`))).toContain('credit_card');
  });

  it('accepts the longest card in the window (19 digits)', () => {
    expect(kinds(detectPII(`card ${luhnOf(19)} on file`))).toContain('credit_card');
  });

  it('rejects one digit below the window (12 digits)', () => {
    expect(kinds(detectPII(`card ${luhnOf(12)} on file`))).not.toContain('credit_card');
  });
});

// The Luhn domain guard (`if (d < 0 || d > 9) return false;`) mutated to `d >= 9` survived the whole
// suite: every existing Luhn-valid fixture in this file (`4111 1111 1111 1111`, and every length
// `luhnOf` above produces for 13-19) happens to land no digit 9 anywhere in it, so a mutation that
// rejects any card containing a 9 was never triggered. (That mutant is NOT the same as the one
// recorded at the doubling branch in `src/memory/pii-scan.ts` — that one is unreachable/equivalent by
// construction; this one is reachable and was a genuine gap.) This constructs a Luhn-valid card that
// DOES contain a 9, self-verified at runtime rather than hand-picked, to close it.
describe('Luhn domain guard: a card containing digit 9 is still valid', () => {
  // Body carries a literal 9 (not just possibly in the trailing check digit), then solves for
  // whichever trailing digit makes the whole string Luhn-valid.
  const luhnWithNine = (len: number): string => luhnAppendCheckDigit('4'.repeat(len - 2) + '9');

  it('detects a Luhn-valid 16-digit card that contains a 9 as high severity', () => {
    const card = luhnWithNine(16);
    expect(card).toContain('9'); // guards the fixture itself, not just detectPII's answer
    const hits = detectPII(`card ${card} on file`);
    expect(hits.some((h) => h.kind === 'credit_card' && h.severity === 'high')).toBe(true);
  });
});

// The RRN gender/century digit (7th digit) is accepted for 1-8. Perturbing that accepted set by one
// value at EITHER end survived the whole suite: narrowing `gender > 8` to `gender > 7` (upper bound),
// and separately widening `gender < 1` to `gender < 0` (lower bound, which starts accepting 0). So
// neither end of this range was measured. Numbers are assembled at runtime via rrnWithChecksum,
// matching this file's existing discipline. (The pre-existing bad-checksum RRN test elsewhere in this
// file also carries gender digit 0, but it fails on checksum, not on the gender digit — it does not
// cover this boundary, which is why this case is assembled with a checksum-VALID gender-0 RRN.)
describe('RRN gender-digit range boundaries', () => {
  it('accepts the lowest gender digit in the range (1)', () => {
    const rrn = rrnWithChecksum('900101', '100001');
    expect(kinds(detectPII(`id ${rrn} here`))).toContain('national_id');
  });

  it('accepts the highest gender digit in the range (8)', () => {
    const rrn = rrnWithChecksum('900101', '800001');
    expect(kinds(detectPII(`id ${rrn} here`))).toContain('national_id');
  });

  it('rejects one gender digit above the range (9)', () => {
    const rrn = rrnWithChecksum('900101', '900001');
    expect(kinds(detectPII(`id ${rrn} here`))).not.toContain('national_id');
  });

  it('rejects one gender digit below the range (0)', () => {
    const rrn = rrnWithChecksum('900101', '000001');
    expect(kinds(detectPII(`id ${rrn} here`))).not.toContain('national_id');
  });
});
