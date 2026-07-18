/** Pure witnessed-read wrapper (spec 2026-07-17-high-water-counter-decision §4): the single seam
 *  every grade-assigning reader converges on so a verdict can be computed from the SAME raw bytes the
 *  projection is built from (readLedgerRaw, ledger.ts). This task (W-T4) only EXPOSES the verdict —
 *  no caller acts on it yet (no clamping, no exclusion, no notes); wiring enforcement into store.ts's
 *  read paths is a later task (W-T7). PURE READ: never calls ensureMaster (which mints a master key
 *  on first use — a write), never opens/advances/clears a witness transition. A virgin home (no
 *  witness state yet) still yields a valid verdict (`first-contact`) and a valid (absent) identity —
 *  this function never throws on missing witness state, only on a genuinely broken ledger read. */
import type { MemoryRecord } from '../types.js';
import { readLedgerRaw, type LedgerPath } from './ledger.js';
import { classifyState, readScopeWitness, scopeKeyOf } from './witness-store.js';
import type { WitnessVerdict } from './witness-core.js';

export interface LedgerWitnessed {
  bytes: Buffer;
  records: MemoryRecord[];
  verdict: WitnessVerdict;
  /** The witnessed entry's own MAC — a stable-per-epoch fingerprint of what the witness currently
   *  attests — or the sentinel `'witness-absent'` when no valid entry exists (none minted yet, or
   *  the stored entry/journal failed its MAC check: classifyState's macInvalid wholesale-degrade,
   *  witness-store.ts). This is the WITNESS's identity, never a ledger record's own `mac` field. */
  witnessIdentity: string;
  /** True iff a journal is currently pending for this scope (an in-flight rewrite transition was
   *  opened but not yet completed or cleared). Mirrors readScopeWitness's `journal !== null`,
   *  degraded to false under macInvalid — a corrupt journal is treated as absent, same as the
   *  verdict path (classifyState never consults a macInvalid journal either). */
  journalPending: boolean;
}

/**
 * Read one ledger's raw bytes + records (readLedgerRaw) and classify them against this scope's
 * witness state — the READ half of the witness protocol; writeVerify/compaction's WRITE half
 * (advanceWitness/openTransition/completeTransition) is untouched by this task. `home` +
 * `projectRoot` resolve the same scope key `scopeKeyOf` derives for witness-store's own callers, so a
 * project-scope caller and a global caller can never cross-classify against the wrong scope's entry.
 *
 * Fix loop 1: takes exactly ONE witness.json snapshot (readScopeWitness) and derives `verdict`,
 * `witnessIdentity`, AND `journalPending` all from that SAME state object — not classifyScope's own
 * internal (second) read. This makes the three fields provably CONSISTENT with each other: a
 * concurrent writer (advanceWitness/openTransition/completeTransition, all lock-held) landing between
 * two separate reads could otherwise make `verdict` reflect one witness.json revision while
 * `witnessIdentity`/`journalPending` reflect a later one — a lock-free read accepts a race against the
 * DISK, but must never race against ITSELF.
 */
export function readLedgerWitnessed(path: LedgerPath, home: string, projectRoot?: string): LedgerWitnessed {
  const { bytes, records } = readLedgerRaw(path);
  const scopeKey = scopeKeyOf(home, projectRoot);
  const state = readScopeWitness(home, scopeKey);   // ONE witness.json snapshot for this whole call
  const verdict = classifyState(state, bytes);
  return {
    bytes,
    records,
    verdict,
    witnessIdentity: state.entry?.mac ?? 'witness-absent',
    journalPending: state.journal !== null,
  };
}
