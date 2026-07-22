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

// 2026-07 matcher-asymmetry repair (spec 2026-07-21). Two support-gated rescue matchers for
// query terms the exact/forward-prefix matcher misses. Both are ASCII-only (R3-3: the tokenizer
// routes ALL non-CJK scripts into the latin run, and the stopword guard only knows
// English/Korean) and fire only via semanticCoverage's support-required gate (R3-1).
const INFLECTION_SUFFIXES = new Set(['s', 'es', 'd', 'ed', 'ing']);
const ASCII_TERM = /^[a-z0-9]+$/;

/**
 * B-infl: reverse-inflection rescue. True iff some record token (length >= 4, a PROPER prefix
 * of `t`) leaves a remainder in the inflection allowlist — query `layers`/`tested` reach record
 * `layer`/`test`, the direction the forward prefix cannot see. The allowlist (not a length cap)
 * is what rejects planet<-plan / portal<-port (R-F7). Known residual: suffix SHAPE only, not
 * lemma identity — united<-unit still matches (R2-4; support-gated, fixture-characterized).
 * Guard constants are provisional post-selection values (spec §7): min stem 4, allowlist
 * {s, es, d, ed, ing}.
 */
export function inflectionRescue(t: string, docTokens: string[]): boolean {
  if (!ASCII_TERM.test(t)) return false;
  for (const d of docTokens) {
    if (d.length >= 4 && d.length < t.length && t.startsWith(d) && INFLECTION_SUFFIXES.has(t.slice(d.length))) return true;
  }
  return false;
}

/**
 * A': adjacent-token concatenation rescue. True iff `t` (length >= 6, ASCII) EQUALS the
 * concatenation of >= 2 ADJACENT record tokens where every constituent is >= 3 chars AND a
 * non-stopword. Repairs the class where the record-side tokenizer split an identifier the
 * query carries jammed-lowercase (`completetask` == `complete`+`task` from `completeTask`).
 * Equality only — `search` never matches inside `research` (the substring alternative was
 * measured equal on probes and REJECTED for reintroducing the mid-word class). The
 * constituent guard blocks meaning-inversion joins (`invalid` <- `in`+`valid`: `in` is short
 * AND a stopword). Semantics are honestly token-join, not identifier-only: `complete task`
 * and `complete. Task` tokenize identically, so cross-separator content-word joins match by
 * design (documented residual: `office` <- `off`+`ice`). Min term length 6 is a provisional
 * post-selection guard (spec §7).
 */
export function concatRescue(t: string, docTokens: string[]): boolean {
  if (t.length < 6 || !ASCII_TERM.test(t)) return false;
  for (let i = 0; i < docTokens.length; i += 1) {
    const first = docTokens[i]!;
    if (first.length < 3 || isStopword(first) || !t.startsWith(first) || first.length >= t.length) continue;
    let acc = first;
    for (let j = i + 1; j < docTokens.length && acc.length < t.length; j += 1) {
      const next = docTokens[j]!;
      if (next.length < 3 || isStopword(next)) break;
      acc += next;
      if (!t.startsWith(acc)) break;
      if (acc === t) return true;
    }
  }
  return false;
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
 *
 * `weights` (2026-07 pilot fix): optional per-term weight — the ranker passes idf so a
 * corpus-unique term carries the coverage mass a generic term cannot (equal-weight coverage let
 * records matching MORE generic terms outrank the one record matching the query's naming token).
 * A term's weight scales BOTH its numerator credit (lexical = w, semantic rescue = w·nw·discount)
 * and its denominator share, so the score stays in [0,1] and CONSTANT weights reduce to the
 * unweighted formula exactly. `lexicalMatched`/`semanticWeight` stay UNWEIGHTED — they feed the
 * semantic-only gate, whose semantics this change must not move.
 *
 * 2026-07 matcher repair (spec 2026-07-21): a direct-missed term can be rescued by two
 * ASCII-only matchers — concatRescue (A') and inflectionRescue (B-infl) — but ONLY on a record
 * already holding >= 1 independent direct match on ANOTHER query term (support-required, R3-1:
 * rescue evidence for records already in the query's lexical neighborhood, never a standalone
 * anchor). A rescue is therefore never a record's FIRST lexical evidence, so the semantic-only
 * gate classification is identical to the pre-rescue scorer by construction. Rescued terms get
 * FULL weight and count in `lexicalMatched`; `semanticWeight` never includes rescues. The
 * neighbor `present` predicate deliberately stays exact/forward-prefix (R-F5 predicate split —
 * widening it would silently widen synonym matching).
 */
export function semanticCoverage(
  qTerms: string[], docTokens: string[], expansion?: Expansion, discount = 1,
  weights?: (t: string) => number,
): SemCoverage {
  if (qTerms.length === 0) return { score: 0, lexicalMatched: 0, semanticWeight: 0 };
  const docSet = new Set(docTokens);
  const present = (tok: string): boolean =>
    docSet.has(tok) || (tok.length >= 3 && docTokens.some((d) => d.startsWith(tok)));
  // Pass 1 — direct evidence only (exact/forward-prefix). Rescues below may fire only when at
  // least one OTHER term matched directly; a term being rescued is by definition not direct,
  // so `some(Boolean)` over all terms is exactly "another term anchors this record".
  const direct = qTerms.map((t) => present(t));
  const support = direct.some(Boolean);
  let lexicalMatched = 0;
  let semanticWeight = 0;
  let num = 0;
  let den = 0;
  for (let i = 0; i < qTerms.length; i += 1) {
    const t = qTerms[i]!;
    const w = weights ? weights(t) : 1;
    den += w;
    if (direct[i]) { lexicalMatched += 1; num += w; continue; }
    if (support && (concatRescue(t, docTokens) || inflectionRescue(t, docTokens))) {
      lexicalMatched += 1; num += w; continue;
    }
    const neigh = expansion?.get(t);
    if (neigh) {
      let best = 0;
      for (const n of neigh) if (n.w > best && present(n.token)) best = n.w;
      if (best > 0) { semanticWeight += best * discount; num += w * best * discount; }
    }
  }
  return { score: den === 0 ? 0 : num / den, lexicalMatched, semanticWeight };
}

// Prefix-anchored (not full proximity): reordered/co-occurring terms are caught by coverageScore, not here.
/**
 * Contiguous-match signal in [0,1] on normalized raw text (sidesteps token/bigram overlap).
 * 1.0 if the whole normalized query is a substring; else (longest query-prefix of length >= minLen
 * that occurs as a substring) / (query length); 0 otherwise. minLen is script-aware: ASCII needs
 * >= 3 chars (else 'id' matches inside 'video'), CJK is meaningful at >= 2 (e.g. 배포).
 */
export function phraseScore(query: string, docContent: string): number {
  return phraseScoreNorm(query, normalizeText(docContent));
}

/** phraseScore over ALREADY-normalized doc content (NFKC + lowercase). Lets the A4 cache precompute
 *  normContent once per record instead of per query. Identical result to phraseScore. */
export function phraseScoreNorm(query: string, d: string): number {
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

export interface RankArtifacts {
  docs: Array<{ id: string; tokens: string[]; normContent: string }>;
  idx: Bm25Index;
}

/** Query-INDEPENDENT rank pre-computation: per-record tokens + normalized content, plus the union
 *  BM25 index. A pure function of the record SET — the A4 cache reuses it while the set is unchanged. */
export function buildRankArtifacts(records: MemoryRecord[]): RankArtifacts {
  const docs = records.map((r) => ({ id: r.id, tokens: tokenize(r.content), normContent: normalizeText(r.content) }));
  const idx = buildIndex(docs.map((d) => ({ id: d.id, tokens: d.tokens })));
  return { docs, idx };
}

/** Query-DEPENDENT scoring over pre-built artifacts. `records` supplies live state/provenance (the
 *  trust margin); `artifacts.docs` supplies tokens/normContent, paired to `records` BY POSITION
 *  (buildRankArtifacts preserves record order — callers must pass the same record set/order the
 *  artifacts were built from). BM25 stays id-keyed via the shared union index. */
export function rankWithArtifacts(records: MemoryRecord[], artifacts: RankArtifacts, query: string, opts: RankOptions = {}): MemoryRecord[] {
  const qMeaning = [...new Set(meaningfulTokens(tokenize(query)))];
  if (qMeaning.length === 0 || records.length === 0) return [];
  const { idx, docs } = artifacts;

  const rawBm = new Map<string, number>();
  for (const r of records) rawBm.set(r.id, bm25Score(r.id, qMeaning, idx));
  const vals = [...rawBm.values()];
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const bm25norm = (id: string): number => (max === min ? 0 : (rawBm.get(id)! - min) / (max - min));

  const semGate = opts.semGate ?? 0;
  const scored = records
    .map((r, i) => {
      // Pair each record with its OWN doc positionally, not via an id-keyed map: duplicate ids
      // (reachable only by an adversarial cross-scope collision — honest ids are random UUIDs)
      // would collapse last-wins and score a record against another record's content. Positional
      // pairing is byte-identical to pre-A4 rankRecords, which scored each record against itself.
      const d = docs[i]!;
      // idf-weighted coverage (2026-07 pilot fix): rarity lives in the coverage leg itself.
      // Rarity is also visible to the small bm25 leg (0.1) — accepted, documented in the fix spec.
      const cov = semanticCoverage(qMeaning, d.tokens, opts.expansion, opts.semDiscount ?? 1, (t) => idf(t, idx));
      const phrase = phraseScoreNorm(query, d.normContent);
      const bm = bm25norm(r.id);
      const relevance = W_PHRASE * phrase + W_COVERAGE * cov.score + W_BM25 * bm;
      const trust = TRUST_PENALTY[r.state] + (isVerifyingSource(r.provenance.source) ? 0 : NONAUTH_PENALTY);
      // A "semantic-only" record has NO lexical signal (no exact/prefix coverage, no phrase, no bm25)
      // and is rescued purely by neighbors -> it must clear the gate to avoid injecting noise.
      const semanticOnly = cov.lexicalMatched === 0 && phrase === 0 && bm === 0 && cov.semanticWeight > 0;
      const keep = relevance > 0 && (!semanticOnly || cov.semanticWeight >= semGate);
      return { rec: r, relevance, final: relevance - trust, keep };
    })
    .filter((s) => s.keep && s.relevance > 0);

  scored.sort((a, b) => b.final - a.final || b.rec.tx.localeCompare(a.rec.tx));
  return scored.slice(0, opts.maxItems ?? 20).map((s) => s.rec);
}

/** Rank live records for a query (build artifacts + score). Retained for callers/tests that do not
 *  cache; byte-identical to the pre-A4 implementation. */
export function rankRecords(records: MemoryRecord[], query: string, opts: RankOptions = {}): MemoryRecord[] {
  return rankWithArtifacts(records, buildRankArtifacts(records), query, opts);
}
