export type SecretTier = 'named' | 'heuristic' | 'entropy';

const TIER_RANK: Record<SecretTier, number> = { named: 2, heuristic: 1, entropy: 0 };

export interface SecretHit {
  hit: boolean;
  kind?: string;
}

export interface SecretSpan {
  start: number;
  end: number;
  kind: string;
  /** Confidence tier: 'named' = a specific provider pattern (high confidence — egress blocks it
   *  override-proof); 'heuristic' = the broad secret-assignment keyword match (low confidence —
   *  still redacted on the write path, but the egress guard treats it as policy-overridable);
   *  'entropy' = the catch-all entropy net (low confidence, e.g. a git SHA — egress-gated but
   *  policy-overridable). */
  tier: SecretTier;
  /** EVERY tier that matched these bytes, not just the reporting one. `tier` above is the highest-
   *  CONFIDENCE member (it picks the redaction kind); merging overlapping spans used to keep only
   *  that one, which silently erased the others — so an egress policy leg could not gate a tier its
   *  span also belonged to. Ranking by confidence is not ranking by blocking strength: with
   *  `secretHeuristic: allow, secretEntropy: block`, a bare high-entropy token blocked while the
   *  SAME token prefixed `password=` merged to heuristic-only and was released. Policy code MUST
   *  read this set; display/redaction code keeps reading `tier`. */
  tiers: SecretTier[];
  /** EH-4: set on entropy-tier spans only — true iff the token's wrapper-punctuation-stripped core
   *  is pure hex >= 24 (git SHA / digest / hex id). Read ONLY by the egress gate; never affects
   *  write-path redaction. */
  entropyHex?: boolean;
  /** C2.2: set on entropy-tier spans only — true iff the stripped core is a separator-joined chain
   *  of individually low-entropy segments (dated filenames, governance doc paths — the FP class
   *  that fired twice on real artifact names). Read ONLY by the egress gate, exactly like
   *  entropyHex; never affects write-path redaction. */
  entropyWordChain?: boolean;
}

// Named patterns run before the entropy net so redactions carry a precise kind
// (audit lines say WHAT was redacted). Specific prefixes precede generic ones
// (sk-ant- before sk-), and lengths are floors, not exact — over-flagging bias.
const PATTERNS: ReadonlyArray<{ kind: string; tier: SecretTier; re: RegExp }> = [
  { kind: 'pem-private-key', tier: 'named', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'aws-access-key', tier: 'named', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'github-token', tier: 'named', re: /\bgh[posru]_[A-Za-z0-9]{30,}\b/ },
  { kind: 'github-token', tier: 'named', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { kind: 'anthropic-key', tier: 'named', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'openai-key', tier: 'named', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { kind: 'slack-token', tier: 'named', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'google-api-key', tier: 'named', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { kind: 'npm-token', tier: 'named', re: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { kind: 'jwt', tier: 'named', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  { kind: 'bearer-token', tier: 'named', re: /\b[Bb]earer\s+[A-Za-z0-9._\-]{20,}\b/ },
  // No leading \b: real keys are often prefixed (db_password=...), and a secret
  // scanner should err toward over-flagging rather than miss a credential.
  // Known limitation: this also flags prose like "pass: install" as a secret. It is therefore
  // demoted to the low-confidence 'heuristic' tier: it STILL redacts on the write path, but the
  // egress guard treats a heuristic-only hit as policy-overridable (see EH-1). A naive value-shape
  // tighten regressed recall (missed alpha-only secrets) and still mis-fired on punctuated prose,
  // so the broad form is kept and the tier — not the regex — carries the confidence signal.
  { kind: 'secret-assignment', tier: 'heuristic', re: /(pass(word)?|secret|api[_-]?key)\s*[=:]\s*\S{6,}/i },
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

/** Strip the defined wrapper-punctuation set from the ends of a token — NEVER letters or digits,
 *  and never interior characters (the EH-4 greedy-strip lesson: a strip that can eat part of a real
 *  secret manufactures a false exemption from the remainder). Shared by both entropy exemptions. */
function stripWrapper(t: string): string {
  return t.replace(/^[`'"([{<*_~]+/, '').replace(/[`'"’)\]}>*_~.,;:!?]+$/, '');
}

/** EH-4: true iff T's wrapper-punctuation-stripped core is pure hex >= 24 chars (git SHA / digest /
 *  hex id shape). Strips ONLY a defined wrapper-punctuation set — NEVER letters or digits — so a
 *  rich-alphabet token whose non-hex chars sit only at the ends (e.g. `g<40 hex>z`) is NOT hex-shaped,
 *  and every `label=<hex>` / `0x<hex>` form keeps an interior non-hex char and is NOT hex-shaped. */
export function isHexCore(t: string): boolean {
  return /^[0-9a-fA-F]{24,}$/.test(stripWrapper(t));
}

/** E-CITE: strip ONE trailing source-citation line reference — `:112`, `:44-45`, `:45:7` — so the
 *  path in front of it can be judged on its own. Deliberately NOT done by adding `:` to the C2.2
 *  separator class: that would split every colon anywhere in the token and exempt `label:<secret>`
 *  pairs.
 *
 *  Whatever this removes is thereafter judged by NOTHING, so the grammar has to earn the removal —
 *  a bare bounded-digit strip does not. `backup.recovery.identifier.593821` is correctly caught by
 *  the "no digit run over 4" segment rule, and an unconditional strip released the SAME digits the
 *  moment that separator became a colon: a 6-digit code (12 with the range form) laundered straight
 *  past a sibling rule written to stop it. So the prefix must also be FILE-SHAPED — it must end in a
 *  dot plus a 1-to-5-character alphanumeric extension — and each number is capped at 5 digits (above
 *  any real line number; `bin/helix-mcp.mjs` line 13040 is the longest in this repo). A label whose
 *  final segment is a word rather than an extension keeps its digits and stays in the net.
 *
 *  ACCEPTED RESIDUAL, stated rather than hidden: a token that is syntactically INDISTINGUISHABLE
 *  from a citation — an all-benign chain ending in a <=5-char segment, then a colon and up to two
 *  5-digit groups — is released. No local syntactic test can separate that from a real citation.
 *  This is the same class of limit the chain test already declares for re-encoded secrets, and the
 *  digits it can carry (<=10) sit near the 4 the segment rule already allows anywhere, unconditionally. */
const CITATION_LINE_REF = /^(.*\.[A-Za-z][A-Za-z0-9]{0,4}):\d{1,5}(?:[-:]\d{1,5})?$/;
function stripLineRef(t: string): string {
  return CITATION_LINE_REF.exec(t)?.[1] ?? t;
}

/** C2.2: true iff T's stripped core is a chain (>= 2 segments over -._/ separators) in which EVERY
 *  segment is individually low-entropy: pure alphabetic (any length), pure digits of <= 4 (years,
 *  months, days, small counters), or a word with a short trailing digit suffix (v2, specs2, api03,
 *  sha256 — <= 8 chars total, digits only at the end). ONE disqualifying segment keeps the whole
 *  token in the entropy net — no partial credit (anti-greedy, mirroring the EH-4 lesson): a chain
 *  smuggling one long mixed-alnum or long-digit segment (an embedded key chunk, a 12-digit id) is
 *  NOT exempt. Deliberate NON-GOAL: covert re-encoding of a secret as an all-benign chain — a
 *  char-level low-confidence net cannot police re-encoding (an adversary can always spell a secret
 *  as words); this net exists for ACCIDENTAL inclusions, and accidental keys virtually always carry
 *  a high-entropy segment. Read only by the egress gate (like isHexCore); write-path redaction is
 *  unaffected. A trailing source-citation line reference is removed first (stripLineRef) so a
 *  `path.ext:112` pointer is judged on its path, with the segment rules applying unchanged. */
export function isBenignWordChain(t: string): boolean {
  const segments = stripLineRef(stripWrapper(t)).split(/[-._/]+/).filter((s) => s !== '');
  if (segments.length < 2) return false;
  return segments.every(
    (s) => /^[A-Za-z]+$/.test(s) || /^[0-9]{1,4}$/.test(s) || (s.length <= 8 && /^[A-Za-z]+[0-9]{1,3}$/.test(s)),
  );
}

/** Merge overlapping spans into non-overlapping ones (required for safe in-place redaction).
 *  A merged span REPORTS the highest-rank tier among its overlapping members (named > heuristic >
 *  entropy via TIER_RANK) and that member's kind — but it ACCUMULATES every member's tier in
 *  `tiers`, so nothing a policy leg needs is lost to the merge. */
function mergeSpans(spans: SecretSpan[]): SecretSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: SecretSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      for (const t of s.tiers) if (!last.tiers.includes(t)) last.tiers.push(t);
      if (TIER_RANK[s.tier] > TIER_RANK[last.tier]) { last.tier = s.tier; last.kind = s.kind; }
    } else {
      out.push({ ...s, tiers: [...s.tiers] });
    }
  }
  return out;
}

/** F6: every detector above reads the RAW bytes, but the render path NFKC-folds — so a confusable
 *  encoding (fullwidth `ＡＫＩＡ…`, fullwidth `ｐａｓｓｗｏｒｄ＝`) was persisted verbatim and came back out
 *  as a live credential. The egress guard already scans both forms for exactly this reason
 *  (classifyEgress: "the raw form is blind to a confusable that normalization folds back into a live
 *  secret"); this gives the WRITE path the same coverage without changing a single caller.
 *
 *  Per-TOKEN, never whole-string. Folding the whole string shifts every index, and the spans
 *  returned here must address the CALLER's raw bytes — `redactSecrets` splices them. Token
 *  boundaries survive folding because JS `\s`, the complement of the `\S+` used here, already
 *  includes every space character NFKC maps to a space (U+3000 among them), so a raw token can
 *  neither contain one nor split under folding.
 *
 *  The RAW token's whole span is emitted, not a sub-range: a folded match's offsets mean nothing in
 *  the raw string, and redacting the entire confusable token is the conservative reading. Tokens
 *  that fold to themselves — nearly all of them — cost one comparison and are skipped. */
function foldedTokenSpans(content: string): SecretSpan[] {
  const out: SecretSpan[] = [];
  const tok = /\S+/g;
  for (let m = tok.exec(content); m !== null; m = tok.exec(content)) {
    const folded = m[0].normalize('NFKC');
    if (folded === m[0]) continue;                       // folding reveals nothing here
    let hit: { kind: string; tier: SecretTier } | null = null;
    for (const { kind, tier, re } of PATTERNS) {
      if (new RegExp(re.source, re.flags.replace('g', '')).test(folded)) { hit = { kind, tier }; break; }
    }
    if (hit === null && isHighEntropyToken(folded)) hit = { kind: 'high-entropy', tier: 'entropy' };
    if (hit === null) continue;
    const span: SecretSpan = {
      start: m.index, end: m.index + m[0].length,
      kind: hit.kind, tier: hit.tier, tiers: [hit.tier],
    };
    // The entropy exemptions are shape questions, so they are asked of the FOLDED core — the shape
    // an operator would recognise — exactly as they are for a token that needed no folding.
    if (hit.tier === 'entropy') {
      span.entropyHex = isHexCore(folded);
      span.entropyWordChain = isBenignWordChain(folded);
    }
    out.push(span);
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
  for (const { kind, tier, re } of PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (let m = g.exec(content); m !== null; m = g.exec(content)) {
      spans.push({ start: m.index, end: m.index + m[0].length, kind, tier, tiers: [tier] });
      if (g.lastIndex === m.index) g.lastIndex++; // guard against a zero-width match looping
    }
  }
  const tok = /\S+/g;
  for (let m = tok.exec(content); m !== null; m = tok.exec(content)) {
    if (isHighEntropyToken(m[0])) {
      spans.push({
        start: m.index, end: m.index + m[0].length, kind: 'high-entropy', tier: 'entropy',
        tiers: ['entropy'],
        entropyHex: isHexCore(m[0]), entropyWordChain: isBenignWordChain(m[0]),
      });
    }
  }
  spans.push(...foldedTokenSpans(content));   // F6: what the render path would reveal
  return mergeSpans(spans);
}

/** Backward-compatible single verdict: hit + the highest-confidence kind (highest-rank tier wins). */
export function detectSecret(content: string): SecretHit {
  const spans = findSecrets(content);
  if (spans.length === 0) return { hit: false };
  // Highest-rank tier wins; ties break by earliest span (explicit, not relying on sort stability).
  const best = [...spans].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || a.start - b.start)[0]!;
  return { hit: true, kind: best.kind };
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
