import { describe, it, expect } from 'vitest';
import { detectSecret, findSecrets, redactSecrets, isHexCore } from '../../src/memory/secret-scan.js';

describe('secret scanner', () => {
  it('flags PEM private key blocks', () => {
    expect(detectSecret('-----BEGIN RSA PRIVATE KEY-----\nMIIE...').hit).toBe(true);
  });
  it('flags AWS-style access keys and bearer/api tokens', () => {
    expect(detectSecret('AKIAIOSFODNN7EXAMPLE').hit).toBe(true);
    expect(detectSecret('authorization: Bearer ghp' + '_aBcD1234EfGh5678IjKl9012MnOp34Qr56').hit).toBe(true);
  });
  it('flags password= assignments (even when prefixed, e.g. db_password=)', () => {
    expect(detectSecret('db_password=Sup3rS3cretValue!').hit).toBe(true);
  });
  it('flags a high-entropy long token', () => {
    expect(detectSecret('token n2Xk9Lp4Qa7Zr3Vy8Wb1Mc6Td0Hs5Jf').hit).toBe(true);
  });
  it('does NOT flag ordinary prose', () => {
    expect(detectSecret('The migration script rewrites the users table.').hit).toBe(false);
  });

  // Kind precision: a named pattern must label the redaction (not the entropy catch-all),
  // so audit lines and inspect output say WHAT was redacted.
  it('labels OpenAI / Anthropic API keys by kind', () => {
    expect(detectSecret('OPENAI key sk' + '-proj-Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56')).toEqual({ hit: true, kind: 'openai-key' });
    expect(detectSecret('sk-ant' + '-api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78')).toEqual({ hit: true, kind: 'anthropic-key' });
  });

  it('labels Slack, Google, and npm tokens by kind', () => {
    expect(detectSecret('xoxb' + '-2912345678-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx')).toEqual({ hit: true, kind: 'slack-token' });
    expect(detectSecret('maps key AIza' + 'SyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tUv')).toEqual({ hit: true, kind: 'google-api-key' });
    expect(detectSecret('npm' + '_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dE3fG')).toEqual({ hit: true, kind: 'npm-token' });
  });

  it('labels GitHub fine-grained PATs and JWTs by kind', () => {
    expect(detectSecret('github_pat' + '_11ABCDEFG0abcdefghijklmnopqrstuvwxyZ_AbCdEf')).toEqual({ hit: true, kind: 'github-token' });
    expect(detectSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_AbCdEfGh')).toEqual({ hit: true, kind: 'jwt' });
  });

  it('labels OpenSSH private key blocks via the PEM pattern', () => {
    expect(detectSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC...')).toEqual({ hit: true, kind: 'pem-private-key' });
  });

  it('negative controls: secret-like prose fragments do not trip the new patterns', () => {
    expect(detectSecret('we discussed skating and sk-i trips').hit).toBe(false);
    expect(detectSecret('the eyJ prefix marks a base64url JSON header').hit).toBe(false);
    expect(detectSecret('npm_config_registry is an env var name').hit).toBe(false);
  });
  it('redactSecrets replaces only the secret span, preserving surrounding text', () => {
    const content = 'aws key AKIAIOSFODNN7EXAMPLE here';
    const r = redactSecrets(content, findSecrets(content));
    expect(r.content).toBe('aws key [redacted:aws-access-key] here');
    expect(r.classification).toBe('secret-redacted');
    expect(r.content).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(r.kinds).toContain('aws-access-key');
  });

  // EH-1 Task 1: confidence-tier split. The secret-assignment keyword heuristic is now its own
  // low-confidence 'heuristic' tier (still redacted on the write path); provider patterns stay
  // 'named'; the entropy catch-all stays 'entropy'. Rank-based precedence on overlap.
  it('tags secret-assignment as the heuristic tier (not named)', () => {
    const spans = findSecrets('db_password=Sup3rS3cretValue!');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.tier).toBe('heuristic');
    expect(spans[0]!.kind).toBe('secret-assignment');
  });
  it('tags provider patterns as the named tier', () => {
    expect(findSecrets('AKIAIOSFODNN7EXAMPLE')[0]!.tier).toBe('named');
  });
  it('tags the high-entropy catch-all as the entropy tier', () => {
    expect(findSecrets('token n2Xk9Lp4Qa7Zr3Vy8Wb1Mc6Td0Hs5Jf').some((s) => s.tier === 'entropy')).toBe(true);
  });
  it('mergeSpans precedence: an overlapping provider+heuristic span resolves to named', () => {
    const spans = findSecrets('api_key=AKIAIOSFODNN7EXAMPLE');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.tier).toBe('named');
  });
  it('redaction still covers a heuristic-tier span (recall parity)', () => {
    const r = redactSecrets('db_password=Sup3rS3cretValue!', findSecrets('db_password=Sup3rS3cretValue!'));
    expect(r.content).not.toContain('Sup3rS3cretValue');
  });
});

describe('EH-4: isHexCore (hex-literal shape for egress exemption)', () => {
  const SHA = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';                          // 40 hex
  const D256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // 64 hex

  it('is TRUE for clean and punctuation-wrapped pure-hex >= 24', () => {
    expect(isHexCore(SHA)).toBe(true);
    expect(isHexCore(SHA + '.')).toBe(true);
    expect(isHexCore('`' + SHA + '`')).toBe(true);
    expect(isHexCore('(' + SHA + '),')).toBe(true);
    expect(isHexCore('[' + SHA + ']')).toBe(true);
    expect(isHexCore('**' + SHA + '**')).toBe(true);
    expect(isHexCore(D256)).toBe(true);
  });

  it('is FALSE for letter-wrapped hex (closes the v1 false-exempt)', () => {
    expect(isHexCore('g' + SHA + 'z')).toBe(false);
    expect(isHexCore('Z3f8a1c9e7b2d4068f5a19c3e0d741b6eQ')).toBe(false);
  });

  it('is FALSE for label=/label: forms and the 0x prefix (interior non-hex)', () => {
    expect(isHexCore('secret=' + SHA)).toBe(false);
    expect(isHexCore('x=' + SHA)).toBe(false);
    expect(isHexCore('z:' + SHA)).toBe(false);
    expect(isHexCore('0x' + SHA)).toBe(false);
  });

  it('is FALSE for a rich-alphabet token and a sub-24 hex core', () => {
    expect(isHexCore('n2Xk9Lp4Qa7Zr3Vy8Wb1Mc6Td0Hs5Jf')).toBe(false);
    expect(isHexCore('`deadbeefdeadbeefdeadbe`')).toBe(false); // 22-hex core < 24
  });
});

describe('EH-4: findSecrets tags entropy spans with entropyHex', () => {
  it('sets entropyHex=true for a pure-hex entropy token', () => {
    const e = findSecrets('commit da39a3ee5e6b4b0d3255bfef95601890afd80709').find((s) => s.tier === 'entropy');
    expect(e).toBeDefined();
    expect(e!.entropyHex).toBe(true);
  });

  it('sets entropyHex=false for a rich-alphabet entropy token', () => {
    const e = findSecrets('token n2Xk9Lp4Qa7Zr3Vy8Wb1Mc6Td0Hs5Jf').find((s) => s.tier === 'entropy');
    expect(e).toBeDefined();
    expect(e!.entropyHex).toBe(false);
  });

  it('write-path: a pure-hex SHA still redacts to [redacted:high-entropy] (unchanged)', () => {
    const content = 'deployed commit da39a3ee5e6b4b0d3255bfef95601890afd80709 to prod';
    const r = redactSecrets(content, findSecrets(content));
    expect(r.content).toBe('deployed commit [redacted:high-entropy] to prod');
  });
});

describe('C2.2: findSecrets tags entropy spans with entropyWordChain', () => {
  const chainOf = (text: string) => findSecrets(text).find((s) => s.tier === 'entropy');

  it('true for the real observed FP: a dated governance filename path', () => {
    const e = chainOf('see docs/release/gate-decision-2026-07-22.md for the policy');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(true);
  });
  it('true for the real observed FP: a dated backup-archive filename', () => {
    const e = chainOf('archived to helix-docs-backup-2026-07-22-specs.tar.gz yesterday');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(true);
  });
  it('true when the token is backtick-wrapped (wrapper strip, EH-4 parallel)', () => {
    const e = chainOf('the file `helix-docs-backup-2026-07-22-specs.tar.gz` moved');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(true);
  });
  it('true for word+short-digit-suffix segments (specs2 / v2 style) and all-short-digit date chains', () => {
    const a = chainOf('kept helix-docs-backup-2026-07-22-specs2.tar.gz around');
    expect(a?.entropyWordChain).toBe(true);
    const b = chainOf('window 2026-07-22/2026-08-19-0102 spans the freeze');
    if (b !== undefined) expect(b.entropyWordChain).toBe(true); // may not even reach the entropy net
  });
  it('FALSE: a chain whose last segment is a long mixed-alnum secret chunk', () => {
    const e = chainOf('leaked prod-api-token-Zx9fQ2Lm8Kp3Vt5Rw7 today');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(false);
  });
  it('FALSE: interleaved mixed-alnum segments (a1b2 shapes)', () => {
    const e = chainOf('code a1b2-c3d4-e5f6-g7h8-i9j0-k1l2 given');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(false);
  });
  it('FALSE: a digit run longer than 4 in any segment', () => {
    const e = chainOf('ref build-1234567890123456-log-entry today');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(false);
  });
  it('FALSE: a single-segment mixed token is not a chain (classic secret shape stays in the net)', () => {
    const e = chainOf('token Zx9fQ2Lm8Kp3Vt5Rw7Aq1Bc2 here');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(false);
  });
  it('write-path: the exempt filename STILL redacts (exemption is egress-gate-only, EH-4 symmetry)', () => {
    const content = 'kept docs/release/gate-decision-2026-07-22.md tracked';
    const r = redactSecrets(content, findSecrets(content));
    expect(r.content).toBe('kept [redacted:high-entropy] tracked');
  });
});
