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
import { classifyScope, readScopeWitness, scopeKeyOf } from './witness-store.js';
import type { WitnessVerdict } from './witness-core.js';

export interface LedgerWitnessed {
  bytes: Buffer;
  records: MemoryRecord[];
  verdict: WitnessVerdict;
  /** The witnessed entry's own MAC — a stable-per-epoch fingerprint of what the witness currently
   *  attests — or the sentinel `'witness-absent'` when no valid entry exists (none minted yet, or
   *  the stored entry/journal failed its MAC check: classifyScope's macInvalid wholesale-degrade,
   *  witness-store.ts). This is the WITNESS's identity, never a ledger record's own `mac` field. */
  witnessIdentity: string;
  /** True iff a journal is currently pending for this scope (an in-flight rewrite transition was
   *  opened but not yet completed or cleared). Mirrors readScopeWitness's `journal !== null`,
   *  degraded to false under macInvalid — a corrupt journal is treated as absent, same as the
   *  verdict path (classifyScope never consults a macInvalid journal either). */
  journalPending: boolean;
}

/**
 * Read one ledger's raw bytes + records (readLedgerRaw) and classify them against this scope's
 * witness state (classifyScope) — the READ half of the witness protocol; writeVerify/compaction's
 * WRITE half (advanceWitness/openTransition/completeTransition) is untouched by this task. `home` +
 * `projectRoot` resolve the same scope key `scopeKeyOf` derives for witness-store's own callers, so a
 * project-scope caller and a global caller can never cross-classify against the wrong scope's entry.
 */
export function readLedgerWitnessed(path: LedgerPath, home: string, projectRoot?: string): LedgerWitnessed {
  const { bytes, records } = readLedgerRaw(path);
  const scopeKey = scopeKeyOf(home, projectRoot);
  const verdict = classifyScope(home, scopeKey, bytes);
  const state = readScopeWitness(home, scopeKey);
  return {
    bytes,
    records,
    verdict,
    witnessIdentity: state.entry?.mac ?? 'witness-absent',
    journalPending: state.journal !== null,
  };
}
