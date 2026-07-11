// Deterministic lethal-trifecta classifier — sibling of blast-radius.ts. No LLM, no embeddings.
// Defense-in-depth only: the primary trust boundary is the provenance firewall + secret-scan +
// the 2a DATA-quarantine. S1 (classifyEgress) is an enforceable egress gate; S2 (classifyEmission)
// is an advisory flag. detectEcho is a verbatim-copy tripwire, not an exfiltration guard.

import { findSecrets } from '../memory/secret-scan.js';
import { detectPII, type PiiKind } from '../memory/pii-scan.js';
import type { EgressPolicy, EgressLeg } from '../config.js';

export interface LedgerItem {
  id: string;
  content: string;
}

export interface DetectEchoOptions {
  /** Minimum verbatim run length (normalized chars) that counts as an echo. */
  k?: number;
  /** Cap on payload chars scanned PER FORM (DoS bound). detectEcho slices each element of `forms`
   *  to this length independently, so the real total bound across a call is `forms.length × maxScan`
   *  (classifyEgress passes up to 2 forms: raw and outbound), not maxScan alone. */
  maxScan?: number;
}

const DEFAULT_K = 24;
const DEFAULT_MAX_SCAN = 20_000;
const PER_ITEM_CAP = 10_000;

/** Match-only normalization: NFKC + strip control/format chars + casefold + whitespace-collapse. NOT
 *  normalizeUntrusted (which also breaks fence runs, for safe display).
 *
 *  The Cf strip is load-bearing. normalizeUntrusted (the OUTBOUND normalizer) removes `\p{Cc}\p{Cf}`;
 *  this one used to keep them, because JS `\s` does not match U+200B. So a memory interleaved with
 *  zero-width spaces matched nothing here, and then folded back into the verbatim memory on the wire.
 *  Stripping invisibles can only ever ADD matches (fail-safe): it cannot invent a false echo. */
function normalizeForMatch(s: string): string {
  return s.normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bounded sliding-window substring scan. Builds the length-k window set from EVERY scanned FORM of the
 * payload (raw AND the exact outbound bytes — see classifyEgress), then tests each ledger item's k-grams
 * against it. O(sum of form lengths + sum of item lengths); caps bound the work regardless of input size.
 */
export function detectEcho(
  forms: string[],
  ledger: LedgerItem[],
  opts: DetectEchoOptions = {},
): { memoryIds: string[] } {
  const k = opts.k ?? DEFAULT_K;
  const maxScan = opts.maxScan ?? DEFAULT_MAX_SCAN;

  const windows = new Set<string>();
  for (const form of forms) {
    const hay = normalizeForMatch(form).slice(0, maxScan);
    for (let i = 0; i + k <= hay.length; i++) windows.add(hay.slice(i, i + k));
  }
  if (windows.size === 0) return { memoryIds: [] };

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of ledger) {
    if (seen.has(item.id)) continue;
    const norm = normalizeForMatch(item.content).slice(0, PER_ITEM_CAP);
    if (norm.length < k) continue;
    for (let i = 0; i + k <= norm.length; i++) {
      if (windows.has(norm.slice(i, i + k))) {
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
  texts: string[];                 // [question, helixAnswer] — the RAW inputs
  /** The EXACT string the caller will transmit. The gate must clear the bytes that actually leave the
   *  machine, not a stand-in: the prompt builder normalizes on the way out (NFKC + control-strip +
   *  fence-break), so a confusable that is inert in the raw form can fold back into a live secret — or a
   *  verbatim memory — inside the outbound prompt. */
  outbound: string;
  ledger: LedgerItem[] | null;     // null = echo leg explicitly disabled (EchoSource 'disabled')
  policy: EgressPolicy;            // dualVerify.egressPolicy (per-leg block/allow; named secrets ignore it)
}

export interface EgressVerdict {
  decision: 'pass' | 'blocked' | 'allowed_override';
  legs: Leg[];
  piiKinds: PiiKind[];
  echoMemoryIds: string[];
  reason: string;                  // content-free: counts / labels only, never a matched span
  /** The leg that DECIDED (typed, machine-readable): the policy key that blocked or was released,
   *  or 'named' for the override-proof secret tier; undefined on a clean/audit-only pass. Consumers
   *  MUST read this instead of re-deriving a decider from `legs` — `legs` reports every DETECTED
   *  leg (audit), which after the blocked-dominant fold is no longer the leg that decided. */
  decidedBy?: EgressLeg | 'named';
}

/** Bulk low-severity PII threshold: >= N distinct low-sev hits is exfiltration-shaped. */
const BULK_PII_N = 3;

// EH-4: credential-context guard for the egress entropy hex-exemption. A pure-hex entropy token
// (git SHA / digest) is normally RELEASED on egress, UNLESS a credential keyword sits in the SAME
// statement within ~CRED_WINDOW chars — then it keeps blocking (bias toward protection). Locked
// tunables (spec §6): boundary set \n . ; ; CRED_WINDOW 24 ; KW_PAD 16 ; keyword set below.
const CREDENTIAL_CONTEXT = /(pass(word|wd)?|secret|credential|api[_-]?key|client[_-]?secret|webhook[_-]?secret|signing[_-]?secret|(access|refresh|auth|session|csrf|bearer)[ _-]?token)/i;
const CRED_WINDOW = 24; // proximity cap (chars)
const KW_PAD = 16;      // longest guard keyword; pad the raw slice so an edge keyword is not truncated
/** A credential keyword within ~CRED_WINDOW chars of [start,end), restricted to the same statement
 *  (window clipped at \n / . / ; — comma is intentionally NOT a boundary). */
function nearCredential(text: string, start: number, end: number): boolean {
  let pre = text.slice(Math.max(0, start - CRED_WINDOW - KW_PAD), start);
  let post = text.slice(end, Math.min(text.length, end + CRED_WINDOW + KW_PAD));
  const b = Math.max(pre.lastIndexOf('\n'), pre.lastIndexOf('.'), pre.lastIndexOf(';'));
  if (b >= 0) pre = pre.slice(b + 1);
  const m = post.search(/[\n.;]/);
  if (m >= 0) post = post.slice(0, m);
  return CREDENTIAL_CONTEXT.test(pre) || CREDENTIAL_CONTEXT.test(post);
}

/** Per-form detector signals. Computed once per scanned FORM of the payload (see classifyEgress). */
interface Scan {
  secretHit: boolean;
  secretNamed: boolean;
  secretHeuristic: boolean;
  secretEntropy: boolean;
  piiKinds: PiiKind[];
  highKinds: PiiKind[];
  highPii: boolean;
  lowPiiCount: number;
}

/** Run every detector over ONE form of the payload. Pure; no policy, no decision. */
function scanText(text: string): Scan {
  const secretSpans = findSecrets(text);
  // Per-tier secret signals (EH-1 Task 2). 'named' is override-proof (deny-dominant); 'heuristic'
  // and 'entropy' are low-confidence and policy-gated by their own legs. An overlapping
  // provider+heuristic span merges to tier='named' (secret-scan.mergeSpans), so secretNamed wins it.
  // EH-4: a hex-shaped entropy span (entropyHex) is released on egress UNLESS a credential keyword
  // is in the same statement. Rich-alphabet entropy spans (!entropyHex) still block.
  const piiHits = detectPII(text);
  const highHits = piiHits.filter((h) => h.severity === 'high');
  return {
    secretHit: secretSpans.length > 0,
    secretNamed: secretSpans.some((s) => s.tier === 'named'),
    secretHeuristic: secretSpans.some((s) => s.tier === 'heuristic'),
    secretEntropy: secretSpans.some(
      (s) => s.tier === 'entropy' && (!s.entropyHex || nearCredential(text, s.start, s.end)),
    ),
    piiKinds: [...new Set(piiHits.map((h) => h.kind))],
    highKinds: [...new Set(highHits.map((h) => h.kind))],
    highPii: highHits.length > 0,
    lowPiiCount: piiHits.filter((h) => h.severity === 'low').length,
  };
}

/**
 * S1 egress classifier. Scans the payload, then applies the §6 decision table BLOCKED-DOMINANTLY
 * (any hit leg whose policy is 'block' blocks, whatever else is released; precedence only names the
 * decider). All detected legs/kinds/ids are recorded for audit; `decidedBy` carries the deciding leg.
 * `reason` is content-free. Only the NAMED secret tier is override-proof (deny-dominant): no
 * egressPolicy leg can release it. The heuristic/entropy secret tiers and the PII/echo legs are each
 * gated by their own egressPolicy key. When `ledger` is null the echo leg is skipped (explicit
 * EchoSource:'disabled').
 *
 * SCANS BOTH FORMS — EVERY leg, echo included (G1). `input.outbound` is the exact string the caller
 * will transmit; the prompt builder normalizes untrusted text on the way out (normalizeUntrusted:
 * NFKC + control-strip + fence-break), so scanning only the raw string is blind to full-width/
 * zero-width confusables that fold back into a live card, API key, or VERBATIM MEMORY inside the
 * outbound prompt — a `pass` verdict on text that leaves as a working secret or an exfiltrated
 * memory. Scanning only the outbound form is not sound either: fence-breaking can destroy a token
 * the raw form reveals, and a caller whose outbound bytes are a strict subset of `texts` (e.g.
 * dual-verify's compare mode, where `helixAnswer` is scanned for audit but never transmitted) would
 * leave part of the payload unscanned. So both forms are scanned and the signals combined
 * CONSERVATIVELY (any-form hit ⇒ hit), while counts take the max per form — never the sum, which
 * would double-count an ASCII email that appears in both forms and could trip the bulk-PII floor on
 * a benign payload. detectEcho normalizes each form internally (normalizeForMatch), so the leg is
 * confusable-safe on WHATEVER forms it is given — but that only helps if the dangerous bytes are in
 * one of the scanned forms in the first place, which is exactly why both are required here.
 */
export function classifyEgress(input: EgressInput): EgressVerdict {
  const raw = input.texts.join('\n');
  const outbound = input.outbound;
  // Two-form, conservative (any-form hit => hit). Neither form alone is sound: the outbound form is
  // blind to a token that fence-breaking destroys, and the raw form is blind to a confusable that
  // normalization folds back into a live secret. Counts take the max per form, never the sum.
  const forms = outbound === raw ? [raw] : [raw, outbound];
  const scans = forms.map(scanText);
  const any = (f: (s: Scan) => boolean): boolean => scans.some(f);

  const secretHit = any((s) => s.secretHit);
  const secretNamed = any((s) => s.secretNamed);
  const secretHeuristic = any((s) => s.secretHeuristic);
  const secretEntropy = any((s) => s.secretEntropy);

  const piiKinds: PiiKind[] = [...new Set(scans.flatMap((s) => s.piiKinds))];
  const highKinds: PiiKind[] = [...new Set(scans.flatMap((s) => s.highKinds))];
  const highPii = any((s) => s.highPii);
  const lowPiiCount = Math.max(...scans.map((s) => s.lowPiiCount));
  const bulkLowPii = lowPiiCount >= BULK_PII_N;

  // The echo leg scans the SAME forms (G1). It used to see only `input.texts` (raw), so a
  // zero-width-padded memory matched nothing here and then reconstituted itself verbatim in the
  // outbound prompt — a `pass` verdict on a payload that left as an exfiltrated memory.
  const echo = input.ledger === null ? { memoryIds: [] } : detectEcho(forms, input.ledger);
  const echoMemoryIds = echo.memoryIds;
  const echoHit = echoMemoryIds.length > 0;
  const piiHit = piiKinds.length > 0;            // kinds is empty iff there were no PII hits

  const legs: Leg[] = [];
  if (secretHit) legs.push('secret');
  if (piiHit) legs.push('pii');
  if (echoHit) legs.push('memory_echo');

  // --- BLOCKED-DOMINANT decision over EVERY applicable leg (§6) ---
  // A NAMED secret (provider pattern, high confidence) is override-proof: no leg can release it.
  // Every other leg is low/medium confidence and gated by its own egressPolicy key, so a false
  // positive cannot permanently wedge dual-verify.
  if (secretNamed) {
    return { decision: 'blocked', legs, piiKinds, echoMemoryIds, decidedBy: 'named', reason: 'blocked: secret token (override-proof)' };
  }
  // Gated legs in PRECEDENCE order (echo > piiHigh > heuristic > entropy > piiBulk > standalone-low-pii).
  // Precedence decides only WHICH leg is named in the reason — never WHETHER we block. An 'allow'
  // releases that leg's OWN hit and nothing else: any other hit leg still gated 'block' blocks the
  // whole payload. This was a first-match-wins chain, so `memoryEcho: allow` silently exfiltrated a
  // card / keyword-secret / bulk-PII sitting in the same payload (every lower leg was never reached).
  const gated: Array<{ hit: boolean; key: EgressLeg; label: string }> = [
    { hit: echoHit, key: 'memoryEcho', label: `memory-echo (${echoMemoryIds.length} items)` },
    { hit: highPii, key: 'piiHigh', label: `high-severity PII (${highKinds.length} kinds)` },
    { hit: secretHeuristic, key: 'secretHeuristic', label: 'secret keyword-assignment (low-confidence)' },
    { hit: secretEntropy, key: 'secretEntropy', label: 'high-entropy token (low-confidence)' },
    { hit: bulkLowPii, key: 'piiBulk', label: `bulk low-severity PII (${lowPiiCount} hits)` },
  ];
  const applicable = gated.filter((g) => g.hit);
  const blocking = applicable.filter((g) => input.policy[g.key] !== 'allow');
  if (blocking.length > 0) {
    // Decider = highest-precedence BLOCKING leg. Released legs are still reported in `legs` for audit.
    const d = blocking[0]!;
    return { decision: 'blocked', legs, piiKinds, echoMemoryIds, decidedBy: d.key, reason: `blocked: ${d.label}` };
  }
  if (applicable.length > 0) {
    // Every hit leg was released by its own policy key. Name the highest-precedence one.
    const d = applicable[0]!;
    return { decision: 'allowed_override', legs, piiKinds, echoMemoryIds, decidedBy: d.key, reason: `allowed_override: ${d.label}` };
  }
  if (piiHit) {
    // single low-severity standalone PII (< N, no other leg) -> audit-only pass.
    return { decision: 'pass', legs, piiKinds, echoMemoryIds, reason: `pass: low-severity PII (${lowPiiCount} hits, audit-only)` };
  }
  // EH-4: an exempt-hex entropy span is the only secret span that reaches this fallthrough with
  // secretHit true (named/heuristic/non-hex-entropy all decide earlier), so label the pass honestly.
  return {
    decision: 'pass',
    legs,
    piiKinds,
    echoMemoryIds,
    reason: secretHit ? 'pass: hex-literal entropy exempt (audit-only)' : 'pass: no egress legs',
  };
}

export interface EmissionFlag {
  flagged: boolean;
}

// Conservative co-occurrence signals. An egress verb AND a sensitive-data reference must BOTH
// appear (within the normalized content) before flagging — either alone is too noisy.
const EGRESS_VERB = /\b(send|post|upload|email|exfiltrate|transmit|leak|forward|fetch)\b/;
const SENSITIVE_REF = /(contents of|read\s+~?\/|password|passwords|secret|api[ _-]?key|\b(?:private|ssh|access|signing|encryption)[ _-]?keys?\b|all your\b|credentials?)/;

/**
 * S2 advisory classifier: flag injection-shaped content (egress verb AND sensitive-data
 * reference co-occurring). Flag-only — the caller decides what to do; Helix never withholds
 * the item. Normalizes (NFKC + casefold) before matching so confusables/casing do not evade.
 */
export function classifyEmission(content: string): EmissionFlag {
  const norm = content.normalize('NFKC').toLowerCase();
  return { flagged: EGRESS_VERB.test(norm) && SENSITIVE_REF.test(norm) };
}
