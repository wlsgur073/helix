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
