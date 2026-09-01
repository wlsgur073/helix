// Deterministic lethal-trifecta classifier — sibling of blast-radius.ts. No LLM, no embeddings.
// Defense-in-depth only: the primary trust boundary is the provenance firewall + secret-scan +
// the 2a DATA-quarantine. S1 (classifyEgress) is an enforceable egress gate; S2 (classifyEmission)
// is an advisory flag. detectEcho is a verbatim-copy tripwire, not an exfiltration guard.

import { findSecrets, nearCredential } from '../memory/secret-scan.js';
import { detectPII, type PiiKind } from '../memory/pii-scan.js';
import type { EgressPolicy, EgressLeg } from '../config.js';

export interface LedgerItem {
  id: string;
  content: string;
  /** The record's proof-of-read token, exactly as `inspect()` already returns it
   *  (`store.ts:767`, labelled there as the token for a guarded supersede). REQUIRED rather than
   *  optional so the compiler locates every supplier: an echo source that silently omitted it would
   *  make every quote declaration against its records unresolvable, and the failure mode would be a
   *  block that looks correct. Supplying it is a pass-through — never recompute a digest here. */
  contentDigest: string;
}

/** A memory the caller declares it is deliberately quoting, with the record's `contentDigest` as
 *  proof it actually read the record. NOT an authorization claim: nothing here says who wrote the
 *  record, because `provenance.source` is caller-chosen and reading it to decide an egress question
 *  is the defect `N2-CONTESTED` closed. What this proves is a READ, which is the same instrument
 *  `SECURITY.md:199-206` already uses for a guarded supersede. */
export interface QuotedMemory {
  id: string;
  contentDigest: string;
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
/** Chars scanned per payload FORM. The gate must never inspect less than it transmits: above this, the
 *  payload is REFUSED, not sent unscanned. 200k is ~7x the largest real call (a 30KB design review);
 *  the k-gram window Set is the memory bound, so this is the knob to benchmark if it is ever raised. */
const MAX_FORM_SCAN = 200_000;
/** Aggregate ledger chars scanned. Beyond this the echo leg cannot clear the payload, so it refuses. A
 *  ledger writer can thus cause availability loss -- that is the correct failure direction, and far
 *  cheaper than the alternative (unbounded scanning of adversary-sized rows => heap exhaustion). Sized
 *  ~3x above the persistent-index migration trigger (12k rows), so no legitimate ledger reaches it. */
const MAX_LEDGER_SCAN = 8_000_000;

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
  const maxScan = opts.maxScan ?? MAX_FORM_SCAN;

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
    const norm = normalizeForMatch(item.content);        // no truncation: an unscanned tail is a fail-open
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
  /** H6: memories the caller declares it is quoting (see QuotedMemory). A pair that does not resolve
   *  against `ledger` is discarded, never an error. Absent or empty reproduces the pre-H6 behaviour
   *  byte-for-byte, which is the state the whole freeze window runs in — the tool parameter that
   *  populates this is post-close, because `compareSurfaces` forbids a schema change while `bin/`
   *  holds candidate bytes. */
  quoted?: readonly QuotedMemory[];
}

export interface EgressVerdict {
  decision: 'pass' | 'blocked' | 'allowed_override';
  legs: Leg[];
  piiKinds: PiiKind[];
  echoMemoryIds: string[];
  /** The subset of `echoMemoryIds` exempted by a RESOLVED quote declaration. `echoMemoryIds` keeps
   *  reporting every DETECTED record so the audit row stays a record of what was in the payload
   *  rather than of what policy allowed; the decision is taken on the remainder. Always present —
   *  `[]` when nothing was declared or nothing resolved. */
  echoExemptIds: string[];
  reason: string;                  // content-free: counts / labels only, never a matched span
  /** The leg that DECIDED (typed, machine-readable): the policy key that blocked or was released,
   *  'named' for the override-proof secret tier, or 'scan_limit' when the payload/ledger was too large to
   *  inspect (fail-closed, no leg). undefined on a clean/audit-only pass. Consumers MUST read this
   *  instead of re-deriving a decider from `legs` — `legs` reports every DETECTED leg (audit), which
   *  after the blocked-dominant fold is no longer the leg that decided. */
  decidedBy?: EgressLeg | 'named' | 'scan_limit';
  /** Gated legs whose policy BLOCKED, canonical order. A leg here is a POLICY KEY (piiHigh), never a
   *  coarse leg. Empty on scan_limit and on a clean pass. NOT necessarily empty on `named`: that
   *  check is deny-dominant and decides regardless of what else blocked, so a named credential
   *  alongside an echoed memory yields `decidedBy: 'named'` with `blockedLegs: ['memoryEcho']`.
   *
   *  NOTHING IN THE SHIPPED TREE READS THIS. An earlier version of this comment named two consumers
   *  — the audit row and the D1 disclosure line — and neither exists: `DualVerifyAudit` has no such
   *  field, and no file outside this one mentions the name. Stated plainly because the cost of the
   *  old wording was not the dead field but the coupling a reader would budget for.
   *
   *  Kept rather than deleted because it is the only place the FULL set of blocking keys survives:
   *  `decidedBy` keeps one, and the audit row coarsens even that to `secret`/`pii`/`memory_echo`, so
   *  an operator asking "which egressPolicy keys must I relax to send this" has no other source.
   *  Wiring it to a durable surface is a separate change. Both halves of this comment are bound in
   *  both directions by test/risk/trifecta.test.ts — add a consumer and the guard asks for the claim
   *  back. */
  blockedLegs: EgressLeg[];
  /** Gated legs a policy RELEASED (allow), canonical order. Meaningful even on a `blocked` decision:
   *  the blocked-dominant fold can release some legs while another blocks. Disjoint from blockedLegs. */
  releasedLegs: EgressLeg[];
  /** Coarse legs DETECTED but never gated: standalone low PII (`pii`), a hex-exempt entropy span
   *  (`secret`). These are the legs in `legs` that are in neither of the two lists above. */
  auditOnlyLegs: Leg[];
}

/** Canonical render + audit order for the typed leg-outcome lists (D1). A single public constant so the
 *  disclosure line and the audit record are deterministic — never incidental push order. Matches the
 *  `gated`-array DECISION precedence below (echo > piiHigh > heuristic > entropy > piiBulk), so
 *  `decidedBy` is always the first leg rendered — NOT config's EGRESS_LEGS order (which places piiBulk
 *  third, not last). */
export const EGRESS_LEG_ORDER: readonly EgressLeg[] = ['memoryEcho', 'piiHigh', 'secretHeuristic', 'secretEntropy', 'secretEntropyExempt', 'piiBulk'];
/** Canonical order for the coarse audit-only legs (detected but never gated). */
export const AUDIT_LEG_ORDER: readonly Leg[] = ['secret', 'pii', 'memory_echo'];

/** Bulk low-severity PII threshold: >= N distinct low-sev hits is exfiltration-shaped. */
const BULK_PII_N = 3;

// EH-4: the credential-context guard for the egress entropy exemptions (a pure-hex or benign
// word-chain entropy token is normally RELEASED on egress, UNLESS a credential keyword sits in the
// SAME statement — then it keeps blocking). The definition lives in secret-scan.ts (imported
// above) as the single copy shared with the W-CITE write-policy selector, so the egress and write
// paths cannot drift apart on what "near a credential" means.

/** Per-form detector signals. Computed once per scanned FORM of the payload (see classifyEgress). */
interface Scan {
  secretHit: boolean;
  secretNamed: boolean;
  secretHeuristic: boolean;
  /** Entropy spans the exemption does NOT cover — gated by `secretEntropy`. */
  secretEntropy: boolean;
  /** Entropy spans the EH-4/C2.2 exemption DOES cover (hex core or benign word-chain, no credential
   *  keyword in the statement). Reported as its own signal instead of being subtracted here: the
   *  detector must not decide, or the policy layer can never gate what the detector already dropped. */
  secretEntropyExempt: boolean;
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
  // is in the same statement. C2.2 extends the same shape to benign word-chains (entropyWordChain —
  // dated filenames / governance paths, the FP class that fired on real artifact names), under the
  // SAME keyword guard. Rich-alphabet, non-chain entropy spans still block.
  const piiHits = detectPII(text);
  const highHits = piiHits.filter((h) => h.severity === 'high');
  return {
    secretHit: secretSpans.length > 0,
    // Read `tiers` (every tier that matched these bytes), NOT `tier` (the highest-CONFIDENCE one).
    // `tier` is for display and redaction kinds; gating on it let a merge decide policy, because
    // confidence rank is not blocking strength — see SecretSpan.tiers.
    secretNamed: secretSpans.some((s) => s.tiers.includes('named')),
    secretHeuristic: secretSpans.some((s) => s.tiers.includes('heuristic')),
    secretEntropy: secretSpans.some(
      (s) => s.tiers.includes('entropy') && (!(s.entropyHex || s.entropyWordChain) || nearCredential(text, s.start, s.end)),
    ),
    // The exact complement of the line above: report the exempt subclass, do not silently drop it.
    secretEntropyExempt: secretSpans.some(
      (s) => s.tiers.includes('entropy') && (s.entropyHex || s.entropyWordChain) && !nearCredential(text, s.start, s.end),
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
  // Fail CLOSED: we cannot clear bytes we did not inspect. Checked before any scanning so an oversized
  // payload costs O(1), not O(n). Content-free reason (a length, never a span).
  if (raw.length > MAX_FORM_SCAN || outbound.length > MAX_FORM_SCAN) {
    return {
      decision: 'blocked', legs: [], piiKinds: [], echoMemoryIds: [], echoExemptIds: [], decidedBy: 'scan_limit',
      reason: `blocked: payload exceeds the egress scan limit (${MAX_FORM_SCAN} chars)`,
      blockedLegs: [], releasedLegs: [], auditOnlyLegs: [],
    };
  }
  if (input.ledger !== null) {
    let ledgerChars = 0;
    for (const item of input.ledger) ledgerChars += item.content.length;
    if (ledgerChars > MAX_LEDGER_SCAN) {
      return {
        decision: 'blocked', legs: [], piiKinds: [], echoMemoryIds: [], echoExemptIds: [], decidedBy: 'scan_limit',
        reason: `blocked: ledger exceeds the egress scan limit (${MAX_LEDGER_SCAN} chars)`,
        blockedLegs: [], releasedLegs: [], auditOnlyLegs: [],
      };
    }
  }
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
  const secretEntropyExempt = any((s) => s.secretEntropyExempt);

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
  // H6: honour a quote declaration only when a record with that id exists AND its digest matches.
  // A pair that fails either test is DISCARDED rather than rejected: a stale digest (the caller read
  // the record, the record was then superseded) is indistinguishable from a wrong one, and the safe
  // fallback is the behaviour that already exists — not exempt, so the leg fires and the diagnosis
  // names it. Resolution happens HERE and not in detectEcho: the detector answers a pure content
  // question, and keeping the subtraction in its caller is what lets `echoMemoryIds` stay a report
  // of the payload rather than of the policy.
  const proven = new Set<string>();
  if (input.quoted && input.quoted.length > 0 && input.ledger !== null) {
    const digestById = new Map(input.ledger.map((i) => [i.id, i.contentDigest]));
    for (const q of input.quoted) {
      if (digestById.get(q.id) === q.contentDigest) proven.add(q.id);
    }
  }
  const echoExemptIds = proven.size === 0 ? [] : echoMemoryIds.filter((id) => proven.has(id));
  const echoEffectiveIds = proven.size === 0 ? echoMemoryIds : echoMemoryIds.filter((id) => !proven.has(id));
  const echoHit = echoEffectiveIds.length > 0;
  const piiHit = piiKinds.length > 0;            // kinds is empty iff there were no PII hits

  const legs: Leg[] = [];
  if (secretHit) legs.push('secret');
  if (piiHit) legs.push('pii');
  if (echoHit) legs.push('memory_echo');

  // ONE outcome table (D1): classify every gated leg as blocked/released, ONCE, before the decision
  // fold, so the disclosure line and the audit record never re-derive attribution from `legs`.
  // Gated legs in PRECEDENCE order (echo > piiHigh > heuristic > entropy > piiBulk > standalone-low-pii).
  // Precedence decides only WHICH leg is named in the reason — never WHETHER we block. An 'allow'
  // releases that leg's OWN hit and nothing else: any other hit leg still gated 'block' blocks the
  // whole payload. This was a first-match-wins chain, so `memoryEcho: allow` silently exfiltrated a
  // card / keyword-secret / bulk-PII sitting in the same payload (every lower leg was never reached).
  const gated: Array<{ hit: boolean; key: EgressLeg; label: string }> = [
    { hit: echoHit, key: 'memoryEcho', label: `memory-echo (${echoEffectiveIds.length} items${echoExemptIds.length > 0 ? `, ${echoExemptIds.length} quoted` : ''})` },
    { hit: highPii, key: 'piiHigh', label: `high-severity PII (${highKinds.length} kinds)` },
    { hit: secretHeuristic, key: 'secretHeuristic', label: 'secret keyword-assignment (low-confidence)' },
    { hit: secretEntropy, key: 'secretEntropy', label: 'high-entropy token (low-confidence)' },
    // OPT-IN leg (deliberately unlike the four above, which are applicable whenever they hit). The
    // exemption ships released, so making it applicable by default would relabel every design-prose
    // SHA from `pass` to `allowed_override` and move the coarse `secret` leg out of auditOnlyLegs —
    // churn on the exact false-positive class the exemption exists to serve, with nothing new
    // transmitted. Applicable only when the operator asks for it, so `allow` reproduces the pre-D2
    // audit-only pass byte-for-byte and `block` makes it a first-class blocking leg. Consulting the
    // policy HERE is sound; the D2 defect was consulting it in the detector, where no leg can reach.
    { hit: secretEntropyExempt && input.policy.secretEntropyExempt === 'block', key: 'secretEntropyExempt', label: 'hex/word-chain entropy token (exemption closed by policy)' },
    { hit: bulkLowPii, key: 'piiBulk', label: `bulk low-severity PII (${lowPiiCount} hits)` },
  ];
  const applicable = gated.filter((g) => g.hit);
  const blocking = applicable.filter((g) => input.policy[g.key] !== 'allow');
  const released = applicable.filter((g) => input.policy[g.key] === 'allow');
  const inOrder = (keys: EgressLeg[]): EgressLeg[] => EGRESS_LEG_ORDER.filter((k) => keys.includes(k));
  const blockedLegs = inOrder(blocking.map((g) => g.key));
  const releasedLegs = inOrder(released.map((g) => g.key));
  // audit-only = a coarse leg detected but with NO gated policy-key applicable to it.
  const gatedCoarse = new Set<Leg>(applicable.map((g) => (g.key === 'memoryEcho' ? 'memory_echo' : g.key.startsWith('pii') ? 'pii' : 'secret')));
  const auditOnlyLegs = AUDIT_LEG_ORDER.filter((l) => legs.includes(l) && !gatedCoarse.has(l));
  const outcome = { blockedLegs, releasedLegs, auditOnlyLegs };

  // --- BLOCKED-DOMINANT decision over EVERY applicable leg (§6) ---
  // A NAMED secret (provider pattern, high confidence) is override-proof: no leg can release it.
  // Every other leg is low/medium confidence and gated by its own egressPolicy key, so a false
  // positive cannot permanently wedge dual-verify.
  if (secretNamed) {
    return { decision: 'blocked', legs, piiKinds, echoMemoryIds, echoExemptIds, decidedBy: 'named', reason: 'blocked: secret token (override-proof)', ...outcome };
  }
  if (blocking.length > 0) {
    // Decider = highest-precedence BLOCKING leg. Released legs are still reported in `legs` for audit.
    const d = blocking[0]!;
    return { decision: 'blocked', legs, piiKinds, echoMemoryIds, echoExemptIds, decidedBy: d.key, reason: `blocked: ${d.label}`, ...outcome };
  }
  if (applicable.length > 0) {
    // Every hit leg was released by its own policy key. Name the highest-precedence one.
    const d = applicable[0]!;
    return { decision: 'allowed_override', legs, piiKinds, echoMemoryIds, echoExemptIds, decidedBy: d.key, reason: `allowed_override: ${d.label}`, ...outcome };
  }
  if (piiHit) {
    // single low-severity standalone PII (< N, no other leg) -> audit-only pass.
    return { decision: 'pass', legs, piiKinds, echoMemoryIds, echoExemptIds, reason: `pass: low-severity PII (${lowPiiCount} hits, audit-only)`, ...outcome };
  }
  // EH-4 + C2.2: an exempt entropy span (hex literal or benign word-chain) is the only secret span
  // that reaches this fallthrough with secretHit true (named/heuristic/non-exempt-entropy all decide
  // earlier), so label the pass honestly.
  return {
    decision: 'pass',
    legs,
    piiKinds,
    echoMemoryIds,
    echoExemptIds,
    reason: secretHit ? 'pass: exempt entropy (hex or word-chain, audit-only)' : 'pass: no egress legs',
    ...outcome,
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
