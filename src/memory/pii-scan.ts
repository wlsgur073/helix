// Deterministic PII detector — sibling of secret-scan.ts. Bounded, well-known patterns only.
// Unlike secret fixtures, PII test values may be literal (not GitHub push-protection-blocked);
// use synthetic/invalid values only. Defense-in-depth — the primary boundary is the firewall.

export type PiiKind = 'email' | 'phone' | 'credit_card' | 'national_id';

export interface PiiHit {
  kind: PiiKind;
  severity: 'low' | 'high';
  start: number;
  end: number;
}

// Low-severity, single-pattern kinds. credit_card and national_id need extra validation,
// so they are handled separately below.
const LOW_PATTERNS: ReadonlyArray<{ kind: 'email' | 'phone'; re: RegExp }> = [
  // RFC-pragmatic email: local@domain.tld (bounded, no nested comments).
  // Every quantifier is BOUNDED, and the domain is spelled as labels. Both matter, for different
  // reasons, and the second one is the one that actually cost 13 seconds:
  //   - labels `(?:[A-Za-z0-9-]{1,63}\.)+` instead of one `[A-Za-z0-9.-]+` run followed by `\.`
  //     stops the same dot from being claimable by either side;
  //   - `{1,64}` on the local part stops each start position from scanning the whole rest of the
  //     input. On a dot-rich string EVERY letter sits after a `.`, so every letter is a word
  //     boundary and `\b` no longer prunes anything: O(n) starts each scanning O(n) forward for an
  //     `@` that never comes. That is where the quadratic came from — measured 835ms at 50k chars
  //     and 13.4s at 200k, and MAX_FORM_SCAN is exactly 200,000. A plain letter run stayed fast only
  //     because `\b` matched at one position in it.
  // The bounds are the RFC/IANA maxima (local part 64, label 63, TLD comfortably under 24), so
  // nothing a real address can be is excluded.
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}\b/g },
  // Phone: US (415-555-0132 / (415) 555-0132) and KR mobile (010-1234-5678) shapes.
  // Requires separators so a bare run of digits (an id / timestamp) does not match.
  { kind: 'phone', re: /(?<!\d)(?:\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\d{2,3}[-.\s]\d{3,4}[-.\s]\d{4})(?!\d)/g },
];

// Card candidate: 13–19 digits, optionally space/dash grouped. Validated with Luhn below.
const CARD_RE = /(?<!\d)(?:\d[ -]?){13,19}(?<![ -])/g;
// national_id: KR RRN (6-7) and US SSN (3-2-4) shapes, each structurally validated below to cut the
// false positives of a bare digit-shape match (mirrors the Luhn gate on credit_card).
const SSN_RE = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g;
const RRN_RE = /(?<!\d)\d{6}-\d{7}(?!\d)/g;

/** Luhn checksum: true when the digit string passes (a real card number does). */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' === 48
    // A mutation sweep reported `d > 9` -> `d >= 9` at this domain guard (line 37 in the audited
    // revision) as a SURVIVOR, bearing "drops every card containing a 9". Confirmed: `d` here is the
    // raw, undoubled digit, always in [0,9] as this function is actually called (detectPII strips to
    // digits-only first), so d === 9 is reachable and the mutation really does reject any card
    // containing a 9. That is a genuine, killable gap, not an equivalent mutant — closed by
    // `test/memory/pii-scan.test.ts`'s "Luhn domain guard: a card containing digit 9 is still valid".
    if (d < 0 || d > 9) return false;
    // `d > 9` recurs here in the doubling branch, and mutating THIS one to `d >= 9` is a separate,
    // EQUIVALENT mutant, unrelated to the domain-guard survivor above: `d` has just been doubled,
    // d = 2k with k in [0,9], so d is always even and d === 9 is unreachable at this site. The two
    // predicates select the same set here, so no test can ever kill this one. If a future sweep
    // reports it again, this is why — proved, not chased.
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0 && digits.length >= 13;
}

/** US SSN structural validity: reject the never-issued forms (area 000/666, group 00, serial 0000).
 *  900-999 is kept (ITINs share the shape) — PII detection errs conservative. No SSN checksum exists,
 *  so a structurally-valid 3-2-4 number (e.g. a coincidental product code) still matches. */
function validSsn(span: string): boolean {
  const area = Number(span.slice(0, 3));
  const group = Number(span.slice(4, 6));
  const serial = Number(span.slice(7, 11));
  return area !== 0 && area !== 666 && group !== 0 && serial !== 0;
}

/** KR RRN validity: 7th digit (gender/century) in 1-8 and the mod-11 check digit matches. */
function validRrn(span: string): boolean {
  const d = span.replace('-', '');
  if (d.length !== 13) return false;
  const gender = d.charCodeAt(6) - 48;
  if (gender < 1 || gender > 8) return false;
  const weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (d.charCodeAt(i) - 48) * weights[i]!;
  const check = (11 - (sum % 11)) % 10;
  return check === d.charCodeAt(12) - 48;
}

/** Detect bounded, well-known PII shapes. Returns every hit with span + severity. */
export function detectPII(text: string): PiiHit[] {
  const hits: PiiHit[] = [];

  for (const { kind, re } of LOW_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      hits.push({ kind, severity: 'low', start: m.index, end: m.index + m[0].length });
    }
  }

  SSN_RE.lastIndex = 0;
  for (let m = SSN_RE.exec(text); m !== null; m = SSN_RE.exec(text)) {
    if (validSsn(m[0])) hits.push({ kind: 'national_id', severity: 'high', start: m.index, end: m.index + m[0].length });
  }
  RRN_RE.lastIndex = 0;
  for (let m = RRN_RE.exec(text); m !== null; m = RRN_RE.exec(text)) {
    if (validRrn(m[0])) hits.push({ kind: 'national_id', severity: 'high', start: m.index, end: m.index + m[0].length });
  }

  CARD_RE.lastIndex = 0;
  for (let m = CARD_RE.exec(text); m !== null; m = CARD_RE.exec(text)) {
    const span = m[0];
    const digits = span.replace(/[^0-9]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      hits.push({ kind: 'credit_card', severity: 'high', start: m.index, end: m.index + span.length });
    }
  }

  return hits;
}
