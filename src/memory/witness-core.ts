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
    return exact ? { kind: 'transition-heal', journal } : { kind: 'transition-interrupted', journal };
  }
  if (!entry) return { kind: 'first-contact', reason: 'no-entry' };
  if (!matchesAt(bytes, entry.byteLength, entry.prefixHash)) return { kind: 'mismatch' };
  return bytes.length === entry.byteLength ? { kind: 'in-sync' } : { kind: 'unwitnessed-suffix' };
}

export function advanceAllowed(v: WitnessVerdict): boolean {
  return v.kind === 'first-contact' || v.kind === 'in-sync' || v.kind === 'unwitnessed-suffix';
}

/** Two-part cleanup predicate: witness monotonicity alone is NOT read containment. */
export function cleanupClearAllowed(
  bytes: Buffer, entry: WitnessEntry | null, journal: JournalEntry,
): boolean {
  if (!entry || entry.epoch < journal.epoch) return false;
  return matchesAt(bytes, entry.byteLength, entry.prefixHash) && bytes.length >= entry.byteLength;
}

export function fenceId(epoch: number, nonce: string): string {
  return `witness_fence_${epoch}_${nonce}`;
}
