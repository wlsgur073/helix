import type { MemoryState, Provenance, ProvenanceSource } from '../types.js';

/** Result of running a mechanical reality-check. */
export interface VerifyOutcome {
  ran: boolean;           // did the check actually execute?
  indeterminate: boolean; // ran but produced no clear answer (timeout, error, ambiguous)
  passed: boolean;        // ran, determinate, and confirmed
}

/** Item sources that are *human-authoritative* on the read side (recall ranking / reverify-skip /
 *  RESERVE floor). `reality-check` is listed because a verify EVENT may carry it, but no live ITEM
 *  ever does (it is never a commit source). Promotion policy lives in resolveTransition, not here. */
const VERIFYING_SOURCES: ReadonlySet<ProvenanceSource> = new Set<ProvenanceSource>(['user', 'reality-check']);

/** True iff `s` may ever verify (reach Verified). Unknown/legacy values are non-authoritative. */
export function isVerifyingSource(s: ProvenanceSource): boolean {
  return VERIFYING_SOURCES.has(s);
}

/** A write requires *some* provenance source. */
export function canCommit(record: { provenance?: Provenance }): boolean {
  return Boolean(record.provenance && record.provenance.source);
}

export type TransitionResult =
  | { kind: 'state'; state: MemoryState }
  | { kind: 'no-change' }
  | { kind: 'contested' };

/**
 * The single write-side trust-transition authority (spec §5). A reality-check may mint at most
 * Corroborated; only a user vouch mints Verified. Fail-closed; never downgrades a human-Verified
 * item; a determinate fail against a Verified target is 'contested' (no write).
 *
 * READS NO PROVENANCE OF THE TARGET (N2-CONTESTED). `provenance` is one of the fields the ledger MAC
 * never covers (ledger-mac.ts: "none of these unauthenticated fields may EVER drive a trust or
 * gen-ordering decision"), the verified projection spreads it through unclamped
 * (verified-projection.ts clamps `state` only), and at the MCP boundary the calling model picks it
 * outright (helix-server.ts) — so the old `targetSource === 'user'` disjunct was a trust decision
 * resting on an unauthenticated self-declaration: any item merely CLAIMING user authorship became
 * permanently undemotable by a reality-check, no file write required. `targetState` carries the same
 * intent in AUTHENTICATED form: only confirm() (an explicit human act) mints Verified, and that grade
 * survives projection only through a MAC-verified verify record. The human vouch is still protected;
 * the unbacked claim of one is not. `evidenceSource` is the CALLER's own assertion about the evidence
 * it is presenting — not a property read back off untrusted storage — so it stays.
 */
export function resolveTransition(input: {
  targetState: MemoryState;
  evidenceSource: ProvenanceSource; outcome: VerifyOutcome;
  /** ACCEPTED AND IGNORED. Callers still pass the target's claimed source; it must never reach a
   *  branch. Declared (rather than dropped) only because `src/memory/store.ts` is pinned by
   *  `docs/release/v2-freeze-receipt-2026-08.json` for the v2 pilot window and cannot be edited to
   *  stop passing it — removing the field outright would fail tsc's excess-property check at that
   *  frozen call site. POST-FREEZE: delete this field and the two `targetSource:` arguments in
   *  store.ts, so the invariant is enforced by the signature instead of by review. "Post-freeze"
   *  is `payload.txClose` in that receipt, READ FROM IT rather than repeated here — the first
   *  window was reset and re-issued on 2026-08-14, and a date copied into this comment would have
   *  invited the deletion four weeks early, inside a live window, against a pinned file. */
  targetSource?: ProvenanceSource;
}): TransitionResult {
  const { targetState, evidenceSource, outcome } = input; // targetSource deliberately not destructured
  if (evidenceSource === 'user') return { kind: 'state', state: 'Verified' }; // confirm: human vouch
  if (evidenceSource !== 'reality-check') return { kind: 'no-change' };        // nothing else may transition
  if (!outcome.ran || outcome.indeterminate) return { kind: 'no-change' };     // can't check → no change
  if (outcome.passed) {
    // already >= Corroborated stays put; Fresh/Suspect rise to Corroborated (recovery)
    return targetState === 'Verified' || targetState === 'Corroborated'
      ? { kind: 'no-change' } : { kind: 'state', state: 'Corroborated' };
  }
  // determinate FAIL
  if (targetState === 'Verified') return { kind: 'contested' }; // guard: never overrule a human vouch
  if (targetState === 'Suspect') return { kind: 'no-change' };
  return { kind: 'state', state: 'Suspect' };
}
