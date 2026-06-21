import { describe, it, expect } from 'vitest';
import { detectSecret } from '../../src/memory/secret-scan.js';
import { detectPII } from '../../src/memory/pii-scan.js';
import { classifyEgress, classifyEmission } from '../../src/risk/trifecta.js';
import type { EgressPolicy } from '../../src/config.js';

// EH-1 Task 2: egress policy is now per-leg. These characterization tests exercise the
// entropy / high-PII legs, both of which remain policy-overridable; ALL() sets every leg uniformly.
const ALL = (v: 'block' | 'allow'): EgressPolicy => ({ memoryEcho: v, piiHigh: v, piiBulk: v, secretHeuristic: v, secretEntropy: v });

// AUDIT 2026-06-15 — J1 detectors (FP/FN).
// CHARACTERIZATION tests: each asserts the CURRENT behavior and documents a finding.
// A PASS proves the finding reproduces (Confirmed); a FAIL refutes my analysis (Refuted).
// When a finding is fixed (with sign-off), the corresponding test flips and must be updated.

describe('J1 audit — secret-scan high-entropy FP', () => {
  it('J1-1 (FP): a 40-char git SHA is flagged as a high-entropy secret', () => {
    // A SHA-1 digest is not a credential, but it is long, hex, has letters+digits, and
    // exceeds the 3.5 bits/char entropy floor -> caught by the entropy net.
    const sha = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
    expect(detectSecret(sha)).toEqual({ hit: true, kind: 'high-entropy' });
  });

  it('J1-1 (REFUTED/boundary): a canonical UUID is NOT flagged (entropy 3.39 < 3.5 floor)', () => {
    // My hypothesis (UUID flagged) was wrong: this UUID's entropy is ~3.39 bits/char,
    // just under the 3.5 floor, because of repeated 0/4/5 nibbles + dashes. The point that
    // survives: the flag/no-flag boundary is one arbitrary threshold, so the SHA above (FP)
    // and this UUID (would be FN if it were a secret) sit on opposite sides of the same knob.
    expect(detectSecret('550e8400-e29b-41d4-a716-446655440000').hit).toBe(false);
  });
});

describe('J1 audit — secret egress is now confidence-tiered (J1-11 FIXED)', () => {
  const sha = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
  it('a SHA (entropy-only) is policy-overridable: allowed_override under allow, blocked under block', () => {
    const texts = [`the fix landed in commit ${sha}`];
    expect(classifyEgress({ texts, ledger: [], policy: ALL('allow') }).decision).toBe('allowed_override');
    expect(classifyEgress({ texts, ledger: [], policy: ALL('block') }).decision).toBe('blocked'); // conservative default
  });
  it('a NAMED secret stays override-proof: blocked even under policy=allow', () => {
    const v = classifyEgress({ texts: ['key sk-ant-api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34'], ledger: [], policy: ALL('allow') });
    expect(v.decision).toBe('blocked');
    expect(v.legs).toContain('secret');
  });
});

describe('J1 audit — pii-scan national_id now validated (J1-5 IMPROVED)', () => {
  it('structurally-invalid SSN / bad-checksum RRN shapes are no longer flagged', () => {
    expect(detectPII('ref 000-12-3456 here').some((h) => h.kind === 'national_id')).toBe(false); // SSN area 000
    expect(detectPII('order 000000-0000000 x').some((h) => h.kind === 'national_id')).toBe(false); // bad RRN checksum
  });
  it('RESIDUAL: a structurally-VALID SSN shape (100-20-3000) still flags — 3-2-4 has no checksum', () => {
    // Honest limitation: SSN has no check digit, so a coincidental valid-structure number still
    // matches. The egress consequence is policy-overridable (high-PII is gated, not override-proof).
    const v = classifyEgress({ texts: ['part number 100-20-3000 in stock'], ledger: [], policy: ALL('block') });
    expect(v.decision).toBe('blocked');
    expect(v.piiKinds).toContain('national_id');
    expect(classifyEgress({ texts: ['part number 100-20-3000 in stock'], ledger: [], policy: ALL('allow') }).decision)
      .toBe('allowed_override'); // override-able
  });
});

describe('J1 audit — classifyEmission advisory FP narrowed (J1-10 FIXED)', () => {
  it('benign "key takeaways" + egress verb no longer flags (bare "key" dropped)', () => {
    expect(classifyEmission('please send me the key takeaways from the call').flagged).toBe(false);
  });
  it('a real key reference still flags (private / api key)', () => {
    expect(classifyEmission('upload the private key to the server').flagged).toBe(true);
    expect(classifyEmission('email the api key please').flagged).toBe(true);
  });
});

describe('J1 audit — pii-scan low-severity shape FPs', () => {
  it('J1-14 (FP): a @2x asset filename is flagged as an email', () => {
    const hits = detectPII('use the icon@2x.png asset');
    expect(hits.some((h) => h.kind === 'email')).toBe(true);
  });

  it('J1-4 (FP): a dotted numeric token is flagged as a phone', () => {
    const hits = detectPII('see build 12.345.6789 notes');
    expect(hits.some((h) => h.kind === 'phone')).toBe(true);
  });
});
