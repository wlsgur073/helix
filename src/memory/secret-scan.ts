import { stripControls } from './content-frame.js';
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
   *  is pure hex >= 24 (git SHA / digest / hex id). Read by the egress gate, and by
   *  selectWriteRedactions only to keep a hex core redacting. */
  entropyHex?: boolean;
  /** C2.2: set on entropy-tier spans only — true iff the stripped core passes the chain test
   *  (isBenignWordChain): a separator-joined chain of individually low-entropy segments (dated
   *  filenames, doc paths, Windows paths, settings, source code). Read by the egress exemption and by
   *  the write path (selectWriteRedactions) alike, owner ruling 2026-10-18 (issue #12). */
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

/** The C2.2 segment rules. */
function isLowEntropySegment(s: string): boolean {
  return /^[A-Za-z]+$/.test(s) || /^[0-9]{1,4}$/.test(s) || (s.length <= 8 && /^[A-Za-z]+[0-9]{1,3}$/.test(s));
}

const DRIVE_PREFIX = /^[A-Za-z]:(?=[\\/])/;
const ENV_REFERENCE = /%([A-Za-z_][A-Za-z0-9_]*)%|\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gi;
// A credential word in a name to the left of an `=` keeps the setting redacted. Matched anywhere in
// the name (`DB_PASSWORD`, `PHPSESSID`, `KENNWORT`). A spurious match only keeps the redaction the
// token had before `=` became a separator, while a missed word persists a secret value written as a
// word chain (`ADMIN_PW=<passphrase>`), so the list is broad on purpose, other languages included.
const CREDENTIAL_WORD = /key|token|secret|pass|pwd|auth|cred|cookie|sess|private|sign|salt|pepper|bearer|hmac|nonce|mnemonic|seed|recovery|license|serial|cipher|kennwort|contrasen|senha|parola|wachtwoord|haslo|heslo|salasana|jelszo|losenord|adgangskode|geheim|clave|chave|schluessel/i;
// Short credential words, matched as a whole part of the name (`ADMIN_PW`, `-p`, `wifiPsk`, `PIN2`)
// and, for the ones that rarely end an English word, also at the end of a part, a trailing `code` or
// `codes` included (`ROOTPW`, `USERPIN`, `PINCODE`): anywhere inside longer words they are too common
// (`spinner`, `inside`, `footprint`).
const CREDENTIAL_PART = new Set(['p', 'sig', 'sk', 'pk', 'code', 'codes', 'phrase', 'answer']);
const CREDENTIAL_SUFFIX = /(pw|pin|otp|mfa|psk|jwt|sid|mdp)[0-9]*(codes?)?$/;
function namesCredential(name: string): boolean {
  if (CREDENTIAL_WORD.test(name)) return true;
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)
    .some((part) => CREDENTIAL_PART.has(part) || CREDENTIAL_PART.has(part.replace(/[0-9]+$/, '')) || CREDENTIAL_SUFFIX.test(part));
}

// `=` separates a name from its value only right after a setting name as such names are written: an
// environment variable in upper case (`NODE_OPTIONS=`), an option in lower case
// (`--max-old-space-size=`) or a Java system property (`-Dfile.encoding=`, `-Dhttp.proxyHost=`), and
// only before a value that is not empty. A name in mixed case is not taken for one, nor text with
// other characters in it: so a base64 body, whose case is mixed, never splits off its padding
// (`...ig==`, a urlsafe `...Q=` followed by `/cfg`), and the `=` stays in a segment that fails the
// segment rules. A second `=` of a run is never right after a name.
const SETTING_NAME = /^(?:-{0,2}[A-Z_][A-Z0-9_]*|-{0,2}[a-z_][a-z0-9_.-]*|-D[A-Za-z][A-Za-z0-9_.-]*)$/;
function splitSettings(core: string): string[] {
  const parts: string[] = [];
  let rest = core;
  for (let i = rest.indexOf('='); i > 0 && i + 1 < rest.length && SETTING_NAME.test(rest.slice(0, i)); i = rest.indexOf('=')) {
    parts.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  parts.push(rest);
  return parts;
}

// Issue #12: the separators of the chain test. The C2.2 set `-._/`, the Windows `\` (issue #5), the
// punctuation of source code (brackets, quotes, the backtick, `,` and `;`) and three pairs that code
// writes and a password rarely does: `${` (a template), `?.` (optional chaining) and `!` before `.`, a
// bracket, `,` or `;` (a non-null assertion). A symbol of a password alphabet (`!@#$%^&*` and the
// like) does not separate on its own: while it did, 1.85% of 24-character random values over letters,
// digits and `!@#$%^&*` passed when written alone (review of issue #12, round 1; 100,000 uniform
// draws). Not `+` or `=`, which base64 uses (its padding would split off), and not `:`, for the reason
// E-CITE gives (`label:<secret>`).
const CHAIN_SEPARATORS = /(?:[-._/\\()[\]{}<>"'`,;]|\$(?=\{)|\?(?=\.)|!(?=[.)\][,;]))+/;
// In a token that carries a URL, `#` separates as well, anywhere in the token: it starts the fragment
// (`x.ts#L42`).
const URL_SEPARATORS = /(?:[-._/\\()[\]{}<>"'`,;]|\$(?=\{)|\?(?=\.)|!(?=[.)\][,;])|#)+/;
// A URL anywhere in the token (`fetch("http://localhost:3000/x")`) is judged with its scheme as a
// segment, split on `+` (`svn+ssh`), and without the port right after its host. Only there: a bare
// `word:12345` is not a URL, and stripping its digits would launder them past the segment rules;
// userinfo (`admin:pw@host`) does not match, so its colon stays and keeps the token in the net. Each
// URL of a token loses its port, at most 5 digits after a scheme and a host, and the removals add
// up with each other and with stripLineRef's (`http://h:54321/x.js:12345:67890` loses 15 digits): a
// token built that way is the re-encoding the chain test does not police (isBenignWordChain).
const URL_AUTHORITY = /(^|[^A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*):\/\/([A-Za-z0-9.-]+)(?::\d{1,5})?(?=[/?#"'`)\]}>,;]|$)/g;
// The tokens issue #12 widened are those split by the punctuation of code or carrying a URL. They
// are read for the credential keywords of nearCredential as well: a setter or a builder names the
// credential in the same token as its value (`db.setPassword("<passphrase>")`), where nearCredential
// does not look. Other tokens (paths, settings) are judged as before issue #12.
const CODE_PUNCTUATION = /[()[\]{}<>"'`,;]|[?!]\./;
// In a widened token a run of six or more letters in mixed case must read as camelCase words
// averaging at least 2.5 letters (`getCustomerId`, `toBeNull`; `aBcDeF` changes case at every
// letter). Random letters in mixed case still average that much a third to a half of the time, at
// every length (`nZTDAGXu`: 2.67); the rates for random values with digits fall with length because
// a digit inside a value fails the segment rules whatever its letters (2026-10-20 check of issue
// #12: 31% to 50% of the values of letters alone in mixed case pass in a code token that carries a
// digit elsewhere, by length). In a token with a URL every segment is also written in one case or
// Capitalized, digits as the segment rules allow: the random id of a share, invite or reset link
// mixes case (`nZTDAGXu`), while a path written by hand rarely does (review of issue #12, round 2:
// about 30% of 8-character random ids in mixed case behind `http://localhost:8080/s/` passed
// without these two tests, 0.45% with them). An id in one case passes as often as 10035b8 already
// let the same link through written without its scheme (round 3: about 12% of 8-character lowercase
// base36 ids). A URL with a camelCase segment (`Microsoft/TypeScript`) stays in the net, as before
// issue #12.
const ONE_CASE_SEGMENT = /^(?:[a-z]+|[A-Z]+|[A-Z][a-z]+)[0-9]{0,3}$|^[0-9]{1,4}$/;
function readsAsWords(s: string): boolean {
  const letters = s.replace(/[0-9]+$/, '');
  if (letters.length < 6 || letters === letters.toLowerCase() || letters === letters.toUpperCase()) return true;
  const words = letters.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? [];
  return letters.length / Math.max(1, words.length) >= 2.5;
}

/** C2.2: true iff T's stripped core is a chain (>= 2 segments) in which EVERY segment is
 *  individually low-entropy: pure alphabetic (any length), pure digits of <= 4 (years, months, days,
 *  small counters), or a word with a short trailing digit suffix (v2, specs2, api03, sha256 — <= 8
 *  chars total, digits only at the end). ONE disqualifying segment keeps the whole token in the
 *  entropy net — no partial credit (anti-greedy, mirroring the EH-4 lesson): a chain smuggling one
 *  long mixed-alnum or long-digit segment (an embedded key chunk, a 12-digit id) is NOT exempt.
 *  Deliberate NON-GOAL: covert re-encoding of a secret as an all-benign chain — a char-level
 *  low-confidence net cannot police re-encoding (an adversary can always spell a secret as words);
 *  this net exists for ACCIDENTAL inclusions, and accidental keys virtually always carry a
 *  high-entropy segment.
 *
 *  Before the segments are judged:
 *  - a trailing source-citation line reference is removed (stripLineRef), so a `path.ext:112`
 *    pointer is judged on its path;
 *  - a URL anywhere in the token keeps its scheme as a segment, split on `+`, and loses the port
 *    right after its host (`https://host:3000/x` -> `https/host/x`);
 *  - a LEADING drive prefix (`C:\`, `C:/`) is dropped (issue #5); any other colon keeps the token in
 *    the net;
 *  - an environment-variable reference (`%NAME%`, `$env:NAME` in any case, `${NAME}`, `$NAME`) is
 *    judged by its name: the sigils carry nothing a secret could hide in;
 *  - `=` separates a setting name, as such names are written, from its value (splitSettings: a
 *    mixed-case base64 body never splits off its padding), unless a name to the left of an `=`
 *    carries a credential word (namesCredential). That name sits INSIDE the token, where
 *    nearCredential does not look, so the check is not redundant with it.
 *  A token split by the punctuation of code (CODE_PUNCTUATION) or carrying a URL is not exempt when
 *  it mentions a credential keyword of nearCredential (`db.setPassword("<passphrase>")`).
 *  Segments are then split on CHAIN_SEPARATORS, or URL_SEPARATORS in a token with a URL (issue #12:
 *  source code is judged by its words); in such a widened token every segment must also read as
 *  words (readsAsWords), and in a token with a URL be written in one case or Capitalized
 *  (ONE_CASE_SEGMENT). The length floor is still judged on the token as written.
 *  ACCEPTED RESIDUAL: a secret written as words and short numbers (a passphrase, grouped digits)
 *  passes the segment rules, so behind a name outside the credential list, or as a piece of a code
 *  token that names no keyword of nearCredential (`setToken("<passphrase>")`), it is persisted and
 *  sent; measured on random values, the pieces of a random value can still look like words (issue
 *  #12, against 10035b8, uniform draws: 2.5% of 8-char, 0.4% of 16-char and 0.1% of 24-char
 *  mixed-case alphanumeric values set into code, which 10035b8 blocked only for the code around
 *  them, and more in one case, which readsAsWords cannot read: 6% of 8-char lowercase base36
 *  values, three quarters of letters alone in one case; letters alone in mixed case 8% at 8 and 12
 *  chars and 12% from 16 to 32, about half where the code token carries a digit elsewhere; 0.4% of
 *  8-char mixed-case ids in a share link, 0.01% at 12 and none from 16, one-case ids as often as
 *  10035b8 released the link written without its scheme; and 0.15% of 24-char values over the 94
 *  printable ASCII characters written alone, whose symbols happened to be code punctuation). Read
 *  by the egress exemption and the write path alike (owner ruling 2026-10-18). */
export function isBenignWordChain(t: string): boolean {
  let url = false;
  const core = stripLineRef(stripWrapper(t))
    .replace(URL_AUTHORITY, (_m, before: string, scheme: string, host: string) => {
      url = true;
      return `${before}${scheme.replace(/\+/g, '/')}/${host}`;
    })
    .replace(DRIVE_PREFIX, '')
    .replace(ENV_REFERENCE, (_m, ...names: Array<string | undefined>) => names.slice(0, 4).find((n) => n !== undefined) ?? '');
  const widened = url || CODE_PUNCTUATION.test(core);
  if (widened && mentionsCredential(core)) return false;
  const setting = splitSettings(core);
  if (setting.slice(0, -1).some(namesCredential)) return false;
  const segments = setting.flatMap((part) => part.split(url ? URL_SEPARATORS : CHAIN_SEPARATORS)).filter((s) => s !== '');
  if (segments.length < 2) return false;
  if (url && !segments.every((s) => ONE_CASE_SEGMENT.test(s))) return false;
  if (widened && !segments.every(readsAsWords)) return false;
  return segments.every(isLowEntropySegment);
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
 *  that fold to themselves — nearly all of them — cost one comparison and are skipped.
 *
 *  ROUND 2: the fold is `stripControls(NFKC(token))`, matching content-frame.ts's render transform
 *  exactly. NFKC alone missed every invisible Cf code point — a zero-width space inside an AWS key
 *  matched no pattern on the way in and was deleted on the way out. `RENDER_TOKEN` exists for the
 *  same reason: `\S` counts U+FEFF as whitespace, so the default tokenizer SPLIT a credential the
 *  render path silently rejoins, and no per-token fold could ever have seen it. */
const RENDER_TOKEN = /[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
function foldedTokenSpans(content: string): SecretSpan[] {
  const out: SecretSpan[] = [];
  const tok = new RegExp(RENDER_TOKEN.source, RENDER_TOKEN.flags);
  for (let m = tok.exec(content); m !== null; m = tok.exec(content)) {
    const folded = stripControls(m[0].normalize('NFKC'));
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

// EH-4: credential-context guard, the SINGLE definition — shared by the egress entropy exemptions
// (trifecta.ts imports it) and the W-CITE write-policy selector below, moved here from trifecta.ts
// so the two paths cannot drift. A credential keyword within ~CRED_WINDOW chars of the span,
// restricted to the SAME statement (window clipped at \n / . / ; — comma is intentionally NOT a
// boundary), keeps the span protected (bias toward protection). Locked tunables (spec §6):
// boundary set \n . ; ; CRED_WINDOW 24 ; KW_PAD 16 ; keyword set below (issue #12 added `pw` and `pwd`
// at the end of a word, `adminpw` and `dbPw` included: no English word ends that way, while `upward`
// and `pwm` go on with a letter; and `api key` written with a space).
const CREDENTIAL_CONTEXT = /(pass(word|wd)?|secret|credential|api[ _-]?key|client[_-]?secret|webhook[_-]?secret|signing[_-]?secret|(access|refresh|auth|session|csrf|bearer)[ _-]?token|pwd?(?![a-z]))/i;
const CRED_WINDOW = 24; // proximity cap (chars)
const KW_PAD = 16;      // longest guard keyword; pad the raw slice so an edge keyword is not truncated
function mentionsCredential(s: string): boolean {
  return CREDENTIAL_CONTEXT.test(s.replace(/([a-z])([A-Z])/g, '$1 $2'));
}
export function nearCredential(text: string, start: number, end: number): boolean {
  let pre = text.slice(Math.max(0, start - CRED_WINDOW - KW_PAD), start);
  let post = text.slice(end, Math.min(text.length, end + CRED_WINDOW + KW_PAD));
  const b = Math.max(pre.lastIndexOf('\n'), pre.lastIndexOf('.'), pre.lastIndexOf(';'));
  if (b >= 0) pre = pre.slice(b + 1);
  const m = post.search(/[\n.;]/);
  if (m >= 0) post = post.slice(0, m);
  return mentionsCredential(pre) || mentionsCredential(post);
}

/** W-CITE write-policy selector: which spans `redactSecrets` must still replace on the WRITE path.
 *  A span is RELEASED (persisted verbatim) iff its `tiers` is exactly ['entropy'] AND its core
 *  passes the chain test (isBenignWordChain, the same one the egress exemption reads) AND NOT
 *  hex-shaped AND no credential keyword sits in the same statement.
 *  Deny-dominant on `tiers` (read the accumulated list, never the display `tier`): any
 *  named/heuristic overlap in a merged span keeps it redacting. Hex keeps redacting because hex is
 *  the native representation of random secret material — a 40-char hex value may be a git object
 *  or a key, and persistence cannot infer which — while a word chain's digit-free twin is already
 *  persisted verbatim today with no exemption involved, so the released arm's marginal exposure is
 *  the digit-bearing word chain alone (measured 0 of 7 real values on this box; design doc
 *  2026-08-05 Part 3, falsifier 2026-09-01). The SELECTION lives here; the decision is APPLIED at
 *  the commit boundary in store.ts, where `secret-redacted` is set only when a span was actually
 *  replaced — returning it for an all-exempt record would falsely claim a redaction happened, and
 *  would erase a caller's `personal` (the round-1 Codex counter that shaped this split). */
export function selectWriteRedactions(content: string, spans: SecretSpan[]): SecretSpan[] {
  return spans.filter((s) => !(
    s.tiers.length === 1 && s.tiers[0] === 'entropy' &&
    s.entropyWordChain === true && s.entropyHex !== true &&
    !nearCredential(content, s.start, s.end)
  ));
}
