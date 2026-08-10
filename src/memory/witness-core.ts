/** Pure rollback-witness state machine (spec 2026-07-17-high-water-counter-decision §4).
 *  Zero IO. classifyWitness is TOTAL over its inputs and journal-first: a pending journal
 *  takes precedence over the plain entry comparison (a completed-but-uncleared transition
 *  plus a boundary restore makes ledger and witness agree while the journal is the only
 *  evidence something is wrong). */
import { createHash } from 'node:crypto';

export interface WitnessEntry {
  epoch: number; byteLength: number; prefixHash: string; headTx: string | null; mac: string;
}
export interface JournalEntry {
  kind: 'compaction' | 'erase' | 'rebaseline';
  epoch: number;
  predecessor: { byteLength: number; prefixHash: string } | null;
  expected: { byteLength: number; prefixHash: string };
  nonce: string; tx: string; supersedes: string | null; mac: string;
}
export type WitnessVerdict =
  | { kind: 'first-contact'; reason: 'no-entry' | 'mac-invalid' }
  | { kind: 'in-sync' }
  | { kind: 'unwitnessed-suffix' }
  | { kind: 'transition-heal'; journal: JournalEntry }
  | { kind: 'transition-interrupted'; journal: JournalEntry }
  | { kind: 'mismatch' };

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function matchesAt(bytes: Buffer, byteLength: number, prefixHash: string): boolean {
  if (bytes.length < byteLength) return false;
  return sha256Hex(bytes.subarray(0, byteLength)) === prefixHash;
}

export function classifyWitness(
  bytes: Buffer, entry: WitnessEntry | null, journal: JournalEntry | null,
): WitnessVerdict {
  if (journal) {
    const exact = bytes.length === journal.expected.byteLength
      && matchesAt(bytes, journal.expected.byteLength, journal.expected.prefixHash);
    if (exact) return { kind: 'transition-heal', journal };
    // The rewrite did not land whole. A journal knows BOTH ends of the transition it opened, so it
    // can still say whether these bytes are on that lineage at all: `predecessor` is what the ledger
    // held at open, `expected` is what the rewrite would have produced. Bytes carrying either as a
    // prefix are a real interruption — the re-drive path, which the rewrite gate must not refuse.
    // Bytes carrying NEITHER are a fork: neither the before nor the after. Classifying those as an
    // interruption was how a rollback laundered itself clean — the rewrite gate refuses 'mismatch'
    // only, so a fork under a pending journal was blessed into a fresh epoch, and the alarm the
    // witness exists to raise went with it. Suffix tolerance mirrors the entry path below, where
    // appended bytes are 'unwitnessed-suffix' rather than an alarm: divergence is a changed PREFIX.
    //
    // A null predecessor keeps the old verdict. It is null only when there is no witness entry
    // (planTransition derives it from one), and with no established lineage there is nothing to
    // fork FROM — a writer there is at first contact and could set the bytes regardless.
    const onLineage = matchesAt(bytes, journal.expected.byteLength, journal.expected.prefixHash)
      || journal.predecessor === null
      || matchesAt(bytes, journal.predecessor.byteLength, journal.predecessor.prefixHash);
    return onLineage ? { kind: 'transition-interrupted', journal } : { kind: 'mismatch' };
  }
  if (!entry) return { kind: 'first-contact', reason: 'no-entry' };
  if (!matchesAt(bytes, entry.byteLength, entry.prefixHash)) return { kind: 'mismatch' };
  return bytes.length === entry.byteLength ? { kind: 'in-sync' } : { kind: 'unwitnessed-suffix' };
}

export function advanceAllowed(v: WitnessVerdict): boolean {
  return v.kind === 'first-contact' || v.kind === 'in-sync' || v.kind === 'unwitnessed-suffix';
}

/** Two-part cleanup predicate: witness monotonicity alone is NOT read containment.
 *  matchesAt() alone suffices for the byte check: its short-input guard (first line) implies
 *  bytes.length >= entry.byteLength on any true return — locked by the "forged over-length
 *  entry" contract test in witness-core.test.ts, which goes RED if that guard is removed. */
export function cleanupClearAllowed(
  bytes: Buffer, entry: WitnessEntry | null, journal: JournalEntry,
): boolean {
  if (!entry || entry.epoch < journal.epoch) return false;
  return matchesAt(bytes, entry.byteLength, entry.prefixHash);
}

export function fenceId(epoch: number, nonce: string): string {
  return `witness_fence_${epoch}_${nonce}`;
}
