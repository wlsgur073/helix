import type { MemoryState, Provenance, ProvenanceSource } from '../types.js';

/** Result of running a mechanical reality-check. */
export interface VerifyOutcome {
  ran: boolean;           // did the check actually execute?
  indeterminate: boolean; // ran but produced no clear answer (timeout, error, ambiguous)
  passed: boolean;        // ran, determinate, and confirmed
}

/** Sources that may ever promote an item to Verified. codex-agree is excluded by design. */
const VERIFYING_SOURCES: ReadonlySet<ProvenanceSource> = new Set<ProvenanceSource>(['user', 'reality-check']);

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
