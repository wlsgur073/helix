import { createHash } from 'node:crypto';

export interface SecretHit {
  hit: boolean;
  kind?: string;
}

// Named patterns run before the entropy net so redactions carry a precise kind
// (audit lines say WHAT was redacted). Specific prefixes precede generic ones
// (sk-ant- before sk-), and lengths are floors, not exact — over-flagging bias.
const PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'github-token', re: /\bgh[posru]_[A-Za-z0-9]{30,}\b/ },
  { kind: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  { kind: 'bearer-token', re: /\b[Bb]earer\s+[A-Za-z0-9._\-]{20,}\b/ },
  // No leading \b: real keys are often prefixed (db_password=...), and a secret
  // scanner should err toward over-flagging rather than miss a credential.
  { kind: 'secret-assignment', re: /(pass(word)?|secret|api[_-]?key)\s*[=:]\s*\S{6,}/i },
];

/** Shannon entropy (bits/char) of a string. */
function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** True when any token in the content looks like a high-entropy secret. */
function hasHighEntropyToken(content: string): boolean {
  for (const tok of content.split(/\s+/)) {
    if (tok.length >= 24 && /[A-Za-z]/.test(tok) && /[0-9]/.test(tok) && entropy(tok) >= 3.5) {
      return true;
    }
  }
  return false;
}

export function detectSecret(content: string): SecretHit {
  for (const { kind, re } of PATTERNS) {
    if (re.test(content)) return { hit: true, kind };
  }
  if (hasHighEntropyToken(content)) return { hit: true, kind: 'high-entropy' };
  return { hit: false };
}

export interface Redaction {
  content: '';
  classification: 'secret-redacted';
  kind: string;
  hash: string; // sha256 of the original, so the same secret is recognizable without storing it
}

export function redactSecret(original: string, kind: string): Redaction {
  return {
    content: '',
    classification: 'secret-redacted',
    kind,
    hash: createHash('sha256').update(original).digest('hex'),
  };
}
