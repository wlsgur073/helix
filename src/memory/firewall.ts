import type { MemoryState, Provenance, ProvenanceSource } from '../types.js';

/** Result of running a mechanical reality-check. */
export interface VerifyOutcome {
  ran: boolean;           // did the check actually execute?
  indeterminate: boolean; // ran but produced no clear answer (timeout, error, ambiguous)
  passed: boolean;        // ran, determinate, and confirmed
}

/** Sources that may ever promote an item to Verified. codex-agree is excluded by design. */
const VERIFYING_SOURCES: ReadonlySet<ProvenanceSource> = new Set<ProvenanceSource>(['user', 'reality-check']);

/** True iff `s` may ever verify (reach Verified). Unknown/legacy values are non-authoritative. */
export function isVerifyingSource(s: ProvenanceSource): boolean {
  return VERIFYING_SOURCES.has(s);
}

/** A write requires *some* provenance source. */
export function canCommit(record: { provenance?: Provenance }): boolean {
  return Boolean(record.provenance && record.provenance.source);
}

/**
 * The resulting trust state for an item given its verification provenance + outcome.
 * - Verified only when a verifying source produced a determinate PASS.
 * - codex-agree never verifies (agreement is a hypothesis signal) -> stays Fresh.
 * - Fail-closed: indeterminate / did-not-run / failed -> Suspect, never Verified.
 */
export function promotionFor(provenance: Provenance, outcome: VerifyOutcome): MemoryState {
  if (!VERIFYING_SOURCES.has(provenance.source)) {
    return 'Fresh'; // e.g. codex-agree: weigh it elsewhere, but it cannot verify
  }
  if (outcome.ran && !outcome.indeterminate && outcome.passed) {
    return 'Verified';
  }
  return 'Suspect'; // unverifiable => unproven, never trust
}

export type TransitionResult =
  | { kind: 'state'; state: MemoryState }
  | { kind: 'no-change' }
  | { kind: 'contested' };

/**
 * The single write-side trust-transition authority (spec §5). A reality-check may mint at most
 * Corroborated; only a user vouch mints Verified. Fail-closed; never downgrades a human-Verified
 * item; a determinate fail against a user-source or Verified target is 'contested' (no write).
 */
export function resolveTransition(input: {
  targetSource: ProvenanceSource; targetState: MemoryState;
  evidenceSource: ProvenanceSource; outcome: VerifyOutcome;
}): TransitionResult {
  const { targetSource, targetState, evidenceSource, outcome } = input;
  if (evidenceSource === 'user') return { kind: 'state', state: 'Verified' }; // confirm: human vouch
  if (evidenceSource !== 'reality-check') return { kind: 'no-change' };        // nothing else may transition
  if (!outcome.ran || outcome.indeterminate) return { kind: 'no-change' };     // can't check → no change
  if (outcome.passed) {
    // already >= Corroborated stays put; Fresh/Suspect rise to Corroborated (recovery)
    return targetState === 'Verified' || targetState === 'Corroborated'
      ? { kind: 'no-change' } : { kind: 'state', state: 'Corroborated' };
  }
  // determinate FAIL
  if (targetState === 'Verified' || targetSource === 'user') return { kind: 'contested' }; // guard
  if (targetState === 'Suspect') return { kind: 'no-change' };
  return { kind: 'state', state: 'Suspect' };
}
