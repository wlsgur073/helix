// Pure, dependency-free lexical retrieval for Helix memory (spec 2026-06-13).
// No IO. Scores live projection records for a query.

import type { MemoryRecord, MemoryState } from '../types.js';
import { isVerifyingSource } from './firewall.js';

const CJK = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const ALNUM = /[\p{L}\p{N}]/u;

/** NFKC + lowercase, no tokenization (used for phrase matching on raw text). */
export function normalizeText(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/** Split a cased latin run on camelCase and letter<->digit boundaries. */
function splitIdentifier(run: string): string[] {
  return run
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Tokenize for indexing/scoring. NFKC (case preserved for camelCase) -> scan into
 * latin runs (identifier-split, then lowercased) and CJK chars (per-char + adjacent bigrams).
 */
export function tokenize(text: string): string[] {
  const norm = text.normalize('NFKC'); // keep case so camelCase survives the split
  const out: string[] = [];
  let latin = '';
  const cjk: string[] = [];
  const flushLatin = (): void => {
    if (latin) { for (const t of splitIdentifier(latin)) out.push(t.toLowerCase()); latin = ''; }
  };
  const flushCjk = (): void => {
    if (cjk.length) {
      for (const ch of cjk) out.push(ch);                          // per-character
      for (let i = 0; i + 1 < cjk.length; i++) out.push(`${cjk[i]}${cjk[i + 1]}`); // bigrams
      cjk.length = 0;
    }
  };
  for (const ch of norm) {
    if (CJK.test(ch)) { flushLatin(); cjk.push(ch); }
    else if (ALNUM.test(ch)) { flushCjk(); latin += ch; }
    else { flushLatin(); flushCjk(); }
  }
  flushLatin();
  flushCjk();
  return out;
}

const EN_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from',
  'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'we', 'you', 'my', 'our', 'your', 'what', 'which', 'who', 'when', 'where', 'how',
  'did', 'do', 'does', 'done', 'about', 'into', 'over', 'than', 'then', 'so', 'if', 'but', 'not', 'no',
]);
const KO_PARTICLE = new Set([
  '은', '는', '이', '가', '을', '를', '에', '도', '의', '와', '과', '로', '으로',
  '에서', '에게', '까지', '부터', '만', '한테',
]);

function isStopword(w: string): boolean {
  return EN_STOP.has(w) || KO_PARTICLE.has(w);
}

/** Tokens that may drive a coverage/phrase match — stopwords removed. */
export function meaningfulTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !isStopword(t));
}

/**
 * Fraction of unique meaningful query tokens present in the record.
 * Match = exact token equality, OR (token length >= 3) a record token starts with it
 * (prefix expansion: auth -> authentication; deliberately prefix, not substring, to avoid port -> report).
 */
export function coverageScore(qTerms: string[], docTokens: string[]): number {
  if (qTerms.length === 0) return 0;
  const docSet = new Set(docTokens);
  let matched = 0;
  for (const t of qTerms) {
    if (docSet.has(t)) { matched += 1; continue; }
    if (t.length >= 3 && docTokens.some((d) => d.startsWith(t))) matched += 1;
  }
  return matched / qTerms.length;
}

// EH-3: semantic recall via precomputed synonym expansion.
export interface ExpansionEntry { token: string; w: number }
export type Expansion = ReadonlyMap<string, ReadonlyArray<ExpansionEntry>>;
export interface SemCoverage { score: number; lexicalMatched: number; semanticWeight: number }

/**
 * Generalized coverage: a query term is covered lexically (exact OR prefix, weight 1.0) or, failing
 * that, by its best PRESENT neighbor (weight w<1 from the precomputed expansion table, scaled by
 * `discount`). The neighbor match ALSO prefix-expands (neighbor `delete` matches record token
 * `deletes`) — the build-time table stores canonical synonyms while records carry inflections.
 * Returns the breakdown so the ranker can gate semantic-only rescues. With no `expansion`,
 * semanticWeight is always 0 => score === coverageScore (exact back-compat).
 */
export function semanticCoverage(
  qTerms: string[], docTokens: string[], expansion?: Expansion, discount = 1,
): SemCoverage {
  if (qTerms.length === 0) return { score: 0, lexicalMatched: 0, semanticWeight: 0 };
  const docSet = new Set(docTokens);
  const present = (tok: string): boolean =>
    docSet.has(tok) || (tok.length >= 3 && docTokens.some((d) => d.startsWith(tok)));
  let lexicalMatched = 0;
  let semanticWeight = 0;
  for (const t of qTerms) {
    if (present(t)) { lexicalMatched += 1; continue; }
    const neigh = expansion?.get(t);
    if (neigh) {
      let best = 0;
      for (const n of neigh) if (n.w > best && present(n.token)) best = n.w;
      if (best > 0) semanticWeight += best * discount;
    }
  }
  return { score: (lexicalMatched + semanticWeight) / qTerms.length, lexicalMatched, semanticWeight };
}

// Prefix-anchored (not full proximity): reordered/co-occurring terms are caught by coverageScore, not here.
/**
 * Contiguous-match signal in [0,1] on normalized raw text (sidesteps token/bigram overlap).
 * 1.0 if the whole normalized query is a substring; else (longest query-prefix of length >= minLen
 * that occurs as a substring) / (query length); 0 otherwise. minLen is script-aware: ASCII needs
 * >= 3 chars (else 'id' matches inside 'video'), CJK is meaningful at >= 2 (e.g. 배포).
 */
export function phraseScore(query: string, docContent: string): number {
  const d = normalizeText(docContent);
  // Strip leading stopword words so a leading 'what'/'the' can't anchor a phrase match (spec §5:
  // stopwords never drive a match). Mid/trailing stopwords are harmless to a left-anchored prefix walk.
  const words = normalizeText(query).split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && isStopword(words[i] as string)) i += 1;
  const q = words.slice(i).join(' ');
  if (q.length === 0) return 0;
  const minLen = CJK.test(q) ? 2 : 3; // ASCII >=3 (id !-> video); CJK >=2 (배포)
  if (q.length < minLen) return 0;
  if (d.includes(q)) return 1;
  for (let len = q.length - 1; len >= minLen; len -= 1) {
    if (d.includes(q.slice(0, len))) return len / q.length;
  }
  return 0;
}

export interface Bm25Index {
  tf: Map<string, Map<string, number>>;
  len: Map<string, number>;
  df: Map<string, number>;
  N: number;
  avgdl: number;
}

export function buildIndex(docs: Array<{ id: string; tokens: string[] }>): Bm25Index {
  const tf = new Map<string, Map<string, number>>();
  const len = new Map<string, number>();
  const df = new Map<string, number>();
  let total = 0;
  for (const { id, tokens } of docs) {
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    tf.set(id, counts);
    len.set(id, tokens.length);
    total += tokens.length;
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = docs.length;
  return { tf, len, df, N, avgdl: N ? total / N : 0 };
}

function idf(term: string, idx: Bm25Index): number {
  const d = idx.df.get(term) ?? 0;
  return Math.log(1 + (idx.N - d + 0.5) / (d + 0.5));
}

/** BM25 over the UNIQUE terms in qTerms. k1=1.2; b=0.25 for tiny corpora (N<10) else 0.75. */
export function bm25Score(id: string, qTerms: string[], idx: Bm25Index): number {
  const counts = idx.tf.get(id);
  if (!counts || idx.N === 0) return 0;
  const k1 = 1.2;
  const b = idx.N < 10 ? 0.25 : 0.75;
  const dl = idx.len.get(id) ?? 0;
  const lenNorm = idx.avgdl ? dl / idx.avgdl : 1;
  let score = 0;
  for (const t of new Set(qTerms)) {
    const f = counts.get(t) ?? 0;
    if (f === 0) continue;
    score += idf(t, idx) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * lenNorm));
  }
  return score;
}

const W_PHRASE = 0.5;
const W_COVERAGE = 0.4;
const W_BM25 = 0.1;
const TRUST_PENALTY: Record<MemoryState, number> = { Verified: 0, Corroborated: 0.01, Fresh: 0.02, Suspect: 0.1 };
// A non-authoritative source ranks just below an equally-relevant authoritative Fresh fact.
// A nudge, not a barrier: stronger relevance can still win (intended — recall must stay useful).
const NONAUTH_PENALTY = 0.03;

export interface RankOptions {
  maxItems?: number;
  expansion?: Expansion;   // EH-3 synonym table (absent => pure lexical, byte-identical to before)
  semDiscount?: number;    // scales neighbor weights; default 1 (calibration output)
  semGate?: number;        // min semanticWeight for a semantic-ONLY record to survive; default 0
}

/** Rank live records for a query: relevance (phrase+coverage+bm25) minus an additive trust margin. */
export function rankRecords(records: MemoryRecord[], query: string, opts: RankOptions = {}): MemoryRecord[] {
  const qMeaning = [...new Set(meaningfulTokens(tokenize(query)))];
  if (qMeaning.length === 0 || records.length === 0) return [];

  const docs = records.map((r) => ({ rec: r, tokens: tokenize(r.content) }));
  const idx = buildIndex(docs.map((d) => ({ id: d.rec.id, tokens: d.tokens })));

  const rawBm = new Map<string, number>();
  for (const d of docs) rawBm.set(d.rec.id, bm25Score(d.rec.id, qMeaning, idx));
  const vals = [...rawBm.values()];
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const bm25norm = (id: string): number => (max === min ? 0 : (rawBm.get(id)! - min) / (max - min));

  const semGate = opts.semGate ?? 0;
  const scored = docs
    .map((d) => {
      const cov = semanticCoverage(qMeaning, d.tokens, opts.expansion, opts.semDiscount ?? 1);
      const phrase = phraseScore(query, d.rec.content);
      const bm = bm25norm(d.rec.id);
      const relevance = W_PHRASE * phrase + W_COVERAGE * cov.score + W_BM25 * bm;
      const trust = TRUST_PENALTY[d.rec.state] + (isVerifyingSource(d.rec.provenance.source) ? 0 : NONAUTH_PENALTY);
      // A "semantic-only" record has NO lexical signal (no exact/prefix coverage, no phrase, no bm25)
      // and is rescued purely by neighbors -> it must clear the gate to avoid injecting noise.
      const semanticOnly = cov.lexicalMatched === 0 && phrase === 0 && bm === 0 && cov.semanticWeight > 0;
      const keep = relevance > 0 && (!semanticOnly || cov.semanticWeight >= semGate);
      return { rec: d.rec, relevance, final: relevance - trust, keep };
    })
    .filter((s) => s.keep && s.relevance > 0);

  scored.sort((a, b) => b.final - a.final || b.rec.tx.localeCompare(a.rec.tx));
  return scored.slice(0, opts.maxItems ?? 20).map((s) => s.rec);
}
