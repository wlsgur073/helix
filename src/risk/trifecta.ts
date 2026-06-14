// Deterministic lethal-trifecta classifier — sibling of blast-radius.ts. No LLM, no embeddings.
// Defense-in-depth only: the primary trust boundary is the provenance firewall + secret-scan +
// the 2a DATA-quarantine. S1 (classifyEgress) is an enforceable egress gate; S2 (classifyEmission)
// is an advisory flag. detectEcho is a verbatim-copy tripwire, not an exfiltration guard.

import { detectSecret } from '../memory/secret-scan.js';
import { detectPII, type PiiKind } from '../memory/pii-scan.js';

export interface LedgerItem {
  id: string;
  content: string;
}

export interface DetectEchoOptions {
  /** Minimum verbatim run length (normalized chars) that counts as an echo. */
  k?: number;
  /** Cap on total payload chars scanned (DoS bound). */
  maxScan?: number;
}

const DEFAULT_K = 24;
const DEFAULT_MAX_SCAN = 20_000;
const PER_ITEM_CAP = 10_000;

/** Match-only normalization: NFKC + casefold + whitespace-collapse. NOT normalizeUntrusted
 *  (which mutates fence runs for framing). Purpose here is comparison, not safe display. */
function normalizeForMatch(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Bounded sliding-window substring scan: for each (length-capped) ledger item, slide a
 * length-k window over its normalized content and test each window against the normalized,
 * length-capped payload via String.prototype.includes. On the first hit, record the item id
 * and move to the next item. Caps bound the work regardless of input size.
 */
export function detectEcho(
  texts: string[],
  ledger: LedgerItem[],
  opts: DetectEchoOptions = {},
): { memoryIds: string[] } {
  const k = opts.k ?? DEFAULT_K;
  const maxScan = opts.maxScan ?? DEFAULT_MAX_SCAN;
  const haystack = normalizeForMatch(texts.join('\n')).slice(0, maxScan);
  if (haystack.length < k) return { memoryIds: [] };

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of ledger) {
    if (seen.has(item.id)) continue;
    const norm = normalizeForMatch(item.content).slice(0, PER_ITEM_CAP);
    if (norm.length < k) continue;
    for (let i = 0; i + k <= norm.length; i++) {
      if (haystack.includes(norm.slice(i, i + k))) {
        ids.push(item.id);
        seen.add(item.id);
        break;
      }
    }
  }
  return { memoryIds: ids };
}

export type Leg = 'secret' | 'pii' | 'memory_echo';

export interface EgressInput {
  texts: string[];                 // [question, helixAnswer]
  ledger: LedgerItem[] | null;     // null = echo leg explicitly disabled (EchoSource 'disabled')
  policy: 'block' | 'allow';       // dualVerify.memoryEgress
}

export interface EgressVerdict {
  decision: 'pass' | 'blocked' | 'allowed_override';
  legs: Leg[];
  piiKinds: PiiKind[];
  echoMemoryIds: string[];
  reason: string;                  // content-free: counts / labels only, never a matched span
}

/** Bulk low-severity PII threshold: >= N distinct low-sev hits is exfiltration-shaped. */
const BULK_PII_N = 3;

/**
 * S1 egress classifier. Runs secret -> PII -> echo, then applies the §6 decision table in
 * precedence order (first match wins the decision; all detected legs/kinds/ids are still recorded
 * for audit). `reason` is content-free. The secret tier is override-proof (policy='allow' does NOT
 * release secrets). When `ledger` is null the echo leg is skipped (explicit EchoSource:'disabled').
 */
export function classifyEgress(input: EgressInput): EgressVerdict {
  const text = input.texts.join('\n');

  // --- run every detector first; record everything for audit ---
  const secretHit = detectSecret(text).hit;

  const piiHits = detectPII(text);
  const piiKinds: PiiKind[] = [...new Set(piiHits.map((h) => h.kind))];
  const highPii = piiHits.some((h) => h.severity === 'high');
  const lowPiiCount = piiHits.filter((h) => h.severity === 'low').length;
  const bulkLowPii = lowPiiCount >= BULK_PII_N;

  const echo = input.ledger === null ? { memoryIds: [] } : detectEcho(input.texts, input.ledger);
  const echoMemoryIds = echo.memoryIds;
  const echoHit = echoMemoryIds.length > 0;

  const legs: Leg[] = [];
  if (secretHit) legs.push('secret');
  if (piiHits.length > 0) legs.push('pii');
  if (echoHit) legs.push('memory_echo');

  const gated = input.policy === 'allow' ? 'allowed_override' : 'blocked';

  // --- precedence-ordered decision (§6); first match wins ---
  if (secretHit) {
    return { decision: 'blocked', legs, piiKinds, echoMemoryIds, reason: 'blocked: secret token (override-proof)' };
  }
  if (echoHit) {
    return {
      decision: gated, legs, piiKinds, echoMemoryIds,
      reason: `${gated === 'blocked' ? 'blocked' : 'allowed_override'}: memory-echo (${echoMemoryIds.length} items)`,
    };
  }
  if (highPii) {
    return {
      decision: gated, legs, piiKinds, echoMemoryIds,
      reason: `${gated === 'blocked' ? 'blocked' : 'allowed_override'}: high-severity PII (${piiKinds.length} kinds)`,
    };
  }
  if (bulkLowPii) {
    return {
      decision: gated, legs, piiKinds, echoMemoryIds,
      reason: `${gated === 'blocked' ? 'blocked' : 'allowed_override'}: bulk low-severity PII (${lowPiiCount} hits)`,
    };
  }
  if (piiHits.length > 0) {
    // single low-severity standalone PII (< N, no other leg) -> audit-only pass.
    return { decision: 'pass', legs, piiKinds, echoMemoryIds, reason: `pass: low-severity PII (${lowPiiCount} hits, audit-only)` };
  }
  return { decision: 'pass', legs, piiKinds, echoMemoryIds, reason: 'pass: no egress legs' };
}

export interface EmissionFlag {
  flagged: boolean;
}

// Conservative co-occurrence signals. An egress verb AND a sensitive-data reference must BOTH
// appear (within the normalized content) before flagging — either alone is too noisy.
const EGRESS_VERB = /\b(send|post|upload|email|exfiltrate|transmit|leak|forward|fetch)\b/;
const SENSITIVE_REF = /(contents of|read\s+~?\/|password|passwords|secret|api[_-]?key|\bkey\b|all your\b|credentials?)/;

/**
 * S2 advisory classifier: flag injection-shaped content (egress verb AND sensitive-data
 * reference co-occurring). Flag-only — the caller decides what to do; Helix never withholds
 * the item. Normalizes (NFKC + casefold) before matching so confusables/casing do not evade.
 */
export function classifyEmission(content: string): EmissionFlag {
  const norm = content.normalize('NFKC').toLowerCase();
  return { flagged: EGRESS_VERB.test(norm) && SENSITIVE_REF.test(norm) };
}
