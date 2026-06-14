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
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // Phone: US (415-555-0132 / (415) 555-0132) and KR mobile (010-1234-5678) shapes.
  // Requires separators so a bare run of digits (an id / timestamp) does not match.
  { kind: 'phone', re: /(?<!\d)(?:\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\d{2,3}[-.\s]\d{3,4}[-.\s]\d{4})(?!\d)/g },
];

// Card candidate: 13–19 digits, optionally space/dash grouped. Validated with Luhn below.
const CARD_RE = /(?<!\d)(?:\d[ -]?){13,19}(?<![ -])/g;
// national_id: KR RRN (6 digits - 7 digits) and US SSN (3-2-4) shapes.
const NATIONAL_ID_RE = /(?<!\d)(?:\d{6}-\d{7}|\d{3}-\d{2}-\d{4})(?!\d)/g;

/** Luhn checksum: true when the digit string passes (a real card number does). */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' === 48
    if (d < 0 || d > 9) return false;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0 && digits.length >= 13;
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

  NATIONAL_ID_RE.lastIndex = 0;
  for (let m = NATIONAL_ID_RE.exec(text); m !== null; m = NATIONAL_ID_RE.exec(text)) {
    hits.push({ kind: 'national_id', severity: 'high', start: m.index, end: m.index + m[0].length });
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
