export type SecretTier = 'named' | 'entropy';

export interface SecretHit {
  hit: boolean;
  kind?: string;
}

export interface SecretSpan {
  start: number;
  end: number;
  kind: string;
  /** Confidence tier: 'named' = a specific provider pattern (high confidence — egress blocks it
   *  override-proof); 'entropy' = the catch-all entropy net (low confidence, e.g. a git SHA —
   *  egress-gated but policy-overridable). */
  tier: SecretTier;
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

/** A whitespace-delimited token that looks like a high-entropy secret. */
function isHighEntropyToken(tok: string): boolean {
  return tok.length >= 24 && /[A-Za-z]/.test(tok) && /[0-9]/.test(tok) && entropy(tok) >= 3.5;
}

/** Merge overlapping spans into non-overlapping ones (required for safe in-place redaction).
 *  A merged span is 'named' if ANY overlapping member was named (high confidence wins). */
function mergeSpans(spans: SecretSpan[]): SecretSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: SecretSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      if (last.tier !== 'named' && s.tier === 'named') { last.tier = 'named'; last.kind = s.kind; }
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/**
 * All secret spans in `content`: named provider patterns (high confidence) plus high-entropy
 * tokens (low confidence), merged into non-overlapping spans sorted by start. Spans drive
 * per-token redaction (preserving the surrounding non-secret text) and the egress confidence tier.
 */
export function findSecrets(content: string): SecretSpan[] {
  const spans: SecretSpan[] = [];
  for (const { kind, re } of PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (let m = g.exec(content); m !== null; m = g.exec(content)) {
      spans.push({ start: m.index, end: m.index + m[0].length, kind, tier: 'named' });
      if (g.lastIndex === m.index) g.lastIndex++; // guard against a zero-width match looping
    }
  }
  const tok = /\S+/g;
  for (let m = tok.exec(content); m !== null; m = tok.exec(content)) {
    if (isHighEntropyToken(m[0])) {
      spans.push({ start: m.index, end: m.index + m[0].length, kind: 'high-entropy', tier: 'entropy' });
    }
  }
  return mergeSpans(spans);
}

/** Backward-compatible single verdict: hit + the highest-confidence kind (named precedence). */
export function detectSecret(content: string): SecretHit {
  const spans = findSecrets(content);
  if (spans.length === 0) return { hit: false };
  const named = spans.find((s) => s.tier === 'named');
  return { hit: true, kind: (named ?? spans[0]!).kind };
}

export interface Redaction {
  content: string;
  classification: 'secret-redacted';
  kinds: string[];
}

/**
 * Span-level redaction: replace ONLY the detected secret tokens with a content-free marker,
 * preserving the surrounding text. A high-entropy false positive (e.g. a git SHA in
 * "deployed commit <sha> to prod") no longer destroys the whole note. Spans must be
 * non-overlapping (findSecrets guarantees this); replaced right-to-left so indices stay valid.
 */
export function redactSecrets(content: string, spans: SecretSpan[]): Redaction {
  let out = content;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + `[redacted:${s.kind}]` + out.slice(s.end);
  }
  return { content: out, classification: 'secret-redacted', kinds: [...new Set(spans.map((s) => s.kind))] };
}
