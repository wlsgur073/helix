import type { BlastRadius, MemoryState } from '../types.js';

/** An observed reality change demotes an item to Suspect, regardless of prior state. */
export function markSuspect(_current: MemoryState): MemoryState {
  return 'Suspect';
}

/** The low-blast tiers that may be used on an aged Suspect copy. */
const LOW_BLAST: ReadonlySet<BlastRadius> = new Set<BlastRadius>(['read-only', 'local-reversible']);

/**
 * Read-side gate (spec §7.4). A Suspect item used on a high-blast-radius path must be
 * re-verified synchronously (K=0) BEFORE use. Fail-safe: unknown blast radius -> require it.
 */
export function requiresReverifyBeforeUse(item: { state: MemoryState; blastRadius: BlastRadius | null }): boolean {
  if (item.state !== 'Suspect') return false;
  if (item.blastRadius === null) return true; // unknown danger -> re-verify
  return !LOW_BLAST.has(item.blastRadius);
}
