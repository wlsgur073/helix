/** Witnessed ledger appends (spec 2026-07-17-high-water-counter-decision §4.2): the append itself
 *  is UNCONDITIONAL (availability — an agent's write always lands), but the witness only advances
 *  from a healthy PRE-append state. A pending transition is resolved (healed, or diagnosed as
 *  interrupted) BEFORE the append is ever attempted, never after.
 *
 *  Protocol (all inside ONE `withFileLock(ledger)` critical section — lock order ledger -> witness,
 *  matching §4.2; the nested witness lock taken by completeTransition/advanceWitness below targets
 *  a DIFFERENT path, `witnessPath(home)`, so nesting is safe — withFileLock is only non-reentrant
 *  PER PATH, lock.ts:107):
 *    1. read current bytes and classify them against this scope's witness state (PRE-append verdict).
 *    2. transition-heal        -> completeTransition FIRST (resolve-before-any-write), using the
 *       bytes just read (classifyState already proved they match journal.expected exactly) and the
 *       journal's OWN tx as the healed entry's headTx — the transition's timestamp, not the
 *       upcoming append's (mirrors the later compactLedger integration's `completeTransition(...,
 *       fence.tx)`). A heal never touches the ledger, so the bytes are unchanged; re-read the witness
 *       state and RE-classify those same bytes to get the real gating verdict, rather than assuming
 *       it is now in-sync.
 *    3. transition-interrupted -> throw WitnessBlockedError; the ledger is NEVER touched (checked
 *       before step 4 runs).
 *    4. append the record (unconditional; unlocked inner write — we already hold the ledger lock).
 *    5. re-read bytes (tail-repair safe: appendRecordUnlocked may have prefixed a repair newline for
 *       a torn predecessor tail).
 *    6. advance the witness iff the GATING verdict (step 1, or step 2's post-heal reclassification)
 *       was advance-allowed (first-contact / in-sync / unwitnessed-suffix). A pre-append MISMATCH
 *       means the append lands but the witness stays untouched — the alarm persists and is never
 *       silently retired by the next legitimate write (anti-laundering invariant, spec §4.2).
 *  advanceWitness independently RE-classifies from disk under the witness lock (Task 2 contract) as
 *  a second, authoritative check. If it throws WitnessAdvanceError despite our gate above (a racing
 *  writer moved the witness between our read and now), that throw PROPAGATES — never swallowed. */
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { MemoryRecord } from '../types.js';
import { appendRecordUnlocked, readLedgerBytes, type LedgerPath } from './ledger.js';
import { withFileLock } from './lock.js';
import { advanceAllowed, type WitnessVerdict } from './witness-core.js';
import {
  classifyState, readScopeWitness, scopeKeyOf, advanceWitness, completeTransition,
  WitnessBlockedError,
} from './witness-store.js';

/** Unlocked inner variant — for a caller that ALREADY holds `withFileLock(ledger)` (store.ts's
 *  signing `writeVerify`; withFileLock is not re-entrant per path). Never takes the ledger lock
 *  itself; the nested witness-lock calls inside (completeTransition/advanceWitness) are a different
 *  path and safe to acquire regardless of who holds the ledger lock. */
export function appendWitnessedUnlocked(ledger: LedgerPath, record: MemoryRecord, home: string, projectRoot: string | undefined, op: 'commit' | 'erase' | 'verify'): void {
  const key = scopeKeyOf(home, projectRoot);
  const bytes = readLedgerBytes(ledger);
  const preVerdict = classifyState(readScopeWitness(home, key), bytes);

  if (preVerdict.kind === 'transition-interrupted') {
    throw new WitnessBlockedError(
      op,
      `${op}: scope '${key}' has an interrupted transition pending — writes are blocked until it resolves (re-drive the operation, or run a re-baseline)`,
    );
  }

  let gateVerdict: WitnessVerdict = preVerdict;
  if (preVerdict.kind === 'transition-heal') {
    completeTransition(home, key, bytes, preVerdict.journal.tx);
    gateVerdict = classifyState(readScopeWitness(home, key), bytes); // bytes unchanged; state moved
  }
  const shouldAdvance = advanceAllowed(gateVerdict);

  appendRecordUnlocked(ledger, record);
  const after = readLedgerBytes(ledger); // re-read under the same lock — tail-repair safe

  if (shouldAdvance) {
    // Second-layer safety (Task 2 contract): re-classifies from CURRENT disk state under the
    // witness lock and throws WitnessAdvanceError if a racing writer invalidated our gate between
    // the read above and now. Left to propagate — never caught here.
    advanceWitness(home, key, after, record.tx);
  }
  // else: the pre-append verdict was 'mismatch' — the append above still landed (availability), but
  // the witness is untouched. The mismatch signal persists for the next reader (anti-laundering).
}

/** Locked wrapper — for a caller that does NOT already hold the ledger lock (store.ts's `commit`
 *  and `erase` tombstone append). Mirrors `appendRecord`'s own mkdir-before-lock convention
 *  (ledger.ts): the parent directory must exist before `withFileLock` can resolve the lock path. */
export function appendWitnessed(ledger: LedgerPath, record: MemoryRecord, home: string, projectRoot: string | undefined, op: 'commit' | 'erase' | 'verify'): void {
  mkdirSync(dirname(ledger), { recursive: true });
  withFileLock(ledger, () => appendWitnessedUnlocked(ledger, record, home, projectRoot, op));
}
