import type { BlastRadius, MemoryState, ProvenanceSource } from '../types.js';
import { isVerifyingSource } from './firewall.js';

/** An observed reality change demotes an item to Suspect, regardless of prior state. */
export function markSuspect(_current: MemoryState): MemoryState {
  return 'Suspect';
}

/** The low-blast tiers that may be used on an aged Suspect copy. */
const LOW_BLAST: ReadonlySet<BlastRadius> = new Set<BlastRadius>(['read-only', 'local-reversible']);

/**
 * Read-side gate (spec §7.4 + 2026-06-25 provenance update). A non-authoritative item is ALWAYS
 * flagged (its blastRadius is caller-supplied and could otherwise be set low to suppress this).
 * A Suspect authoritative item is flagged on non-low-blast use; unknown blast radius fails safe.
 */
export function requiresReverifyBeforeUse(item: {
  state: MemoryState; blastRadius: BlastRadius | null; source: ProvenanceSource;
}): boolean {
  if (!isVerifyingSource(item.source)) return true;     // non-authoritative → always flag
  if (item.state !== 'Suspect') return false;
  if (item.blastRadius === null) return true;            // unknown danger → fail-safe
  return !LOW_BLAST.has(item.blastRadius);
}
