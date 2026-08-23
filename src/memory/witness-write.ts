/** Witnessed ledger appends (spec 2026-07-17-high-water-counter-decision §4.2): the append itself
 *  is UNCONDITIONAL (availability — an agent's write always lands) EXCEPT for an elevated verify
 *  under a `mismatch` verdict (F2-WRITE, step 3b below), and the witness only advances from a
 *  healthy PRE-append state. A pending transition is resolved (healed, or diagnosed as
 *  interrupted) BEFORE the append is ever attempted, never after.
 *
 *  Protocol (all inside ONE `withFileLock(ledger)` critical section — lock order ledger -> witness,
 *  matching §4.2; the nested witness lock taken by completeTransition/advanceWitness below targets
 *  a DIFFERENT path, `witnessPath(home)`, so nesting is safe — withFileLock is only non-reentrant
 *  PER PATH — enforced by the `reentrant-self` throw in lock.ts's acquireFileLock):
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
 *    3b. mismatch AND the record is an elevated verify -> throw WitnessBlockedError; the ledger and
 *       the witness are both NEVER touched, so the alarm survives (F2-WRITE). Narrow on purpose:
 *       commit, soft erase and reality-check DEMOTIONS still land under the same verdict.
 *    4. append the record (unlocked inner write — we already hold the ledger lock).
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

  // F2-WRITE. The append below is unconditional BY DESIGN (availability) with exactly one exception:
  // an ELEVATED verify must not be minted while the rollback alarm stands. `mismatch` clamps what a
  // read DISPLAYS, never what the write path MINTS, and a signed verify carries no record of the
  // verdict it was minted under — so such a row is indistinguishable from an honest one afterwards.
  // Two consequences made that fatal rather than untidy: the asOf surface is deliberately NOT clamped
  // (store.ts), so it serves the new grade immediately, and the re-baseline ceremony adopts the
  // current bytes wholesale, so the operator's own documented recovery promotes it everywhere.
  // Refusing HERE — after the heal reclassification, before the append — leaves the ledger and the
  // witness both untouched, so the alarm survives to be investigated instead of being written over.
  //
  // Deliberately NARROW, in two ways that are each load-bearing. It reads the RECORD rather than the
  // `op` discriminator, because signVerify does not assert `type` and a mislabelled caller must not
  // be able to route an elevated verify past this. And it keys on the STATE, so a reality-check
  // DEMOTION still lands: refusing every verify would suppress exactly the evidence a scope under
  // suspicion most needs to record. commit and soft erase are untouched.
  const elevatedVerify = record.type === 'verify'
    && (record.state === 'Verified' || record.state === 'Corroborated');
  if (gateVerdict.kind === 'mismatch' && elevatedVerify) {
    throw new WitnessBlockedError(
      op,
      `${op}: scope '${key}' is in a MISMATCH (rollback-alarm) state — refusing to mint an elevated grade over a ledger that does not descend from its witnessed head; establish that the current bytes are yours, then re-baseline the scope (helix-rebaseline) before retrying`,
    );
  }

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
