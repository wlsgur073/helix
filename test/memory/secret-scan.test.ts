import { describe, it, expect } from 'vitest';
import { detectSecret, findSecrets, redactSecrets } from '../../src/memory/secret-scan.js';

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
});
