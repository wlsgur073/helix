/** Pure witnessed-read wrappers (spec 2026-07-17-high-water-counter-decision §4 + §7): the single
 *  seam every grade-assigning reader converges on so a verdict can be computed from the SAME raw bytes
 *  the projection is built from. PURE READS: never call ensureMaster (which mints a master key on
 *  first use — a write), never open/advance/clear a witness transition. A virgin home (no witness
 *  state yet) still yields a valid verdict (`first-contact`) and a valid (absent) identity — these
 *  functions never throw on missing witness state, only on a genuinely broken ledger read.
 *
 *  READ ORDER + RETRY (spec §7 "concurrent reader spanning the two files"). Every witnessed read here
 *  reads the WITNESS snapshot FIRST and the LEDGER bytes SECOND, then RETRIES EXACTLY ONCE on an alarm
 *  verdict (mismatch OR transition-interrupted). Both halves are load-bearing:
 *    - Witness-first makes an ordinary concurrent append BENIGN. A witnessed append grows the ledger
 *      and THEN advances the witness (witness-write.ts). So if we hold a witness snapshot, the ledger
 *      we read afterwards can only be as-new-or-newer than it — an append-preserving suffix, classified
 *      `unwitnessed-suffix`, never the spurious `mismatch` a ledger-first read produced when the witness
 *      advanced between the two reads (Task 8 failpoint, §7).
 *    - Retry-once resolves the rarer concurrent-REWRITE interleave: an in-progress epoch transition
 *      (compaction/erase) momentarily makes the OLD entry not match the already-rewritten bytes
 *      (mismatch) or leaves a pending journal over not-yet-rewritten bytes (transition-interrupted),
 *      until the witness/journal catches up. A single re-read (witness-first again) reclassifies against
 *      the settled state. The retry uses the SECOND verdict UNCONDITIONALLY — it never loops — so a
 *      genuine, STABLE rollback (bytes that truly do not descend from the witness on BOTH reads) still
 *      verdicts `mismatch` and is never masked. */
import type { MemoryRecord } from '../types.js';
import { readLedgerRaw, readLedgerBytes, type LedgerPath } from './ledger.js';
import { classifyState, readScopeWitness, scopeKeyOf, type ScopeWitnessState } from './witness-store.js';
import type { WitnessVerdict } from './witness-core.js';

/** The two alarm verdicts a witnessed read retries on (spec §7). Every other verdict — first-contact,
 *  in-sync, unwitnessed-suffix, transition-heal — is either benign or resolved by a later WRITE, so a
 *  re-read cannot improve it and none is retried. */
export function isWitnessAlarm(v: WitnessVerdict): boolean {
  return v.kind === 'mismatch' || v.kind === 'transition-interrupted';
}

/**
 * The ONE place the §7 order + retry live — a higher-order read so the five witnessed-read sites share
 * a single implementation rather than each duplicating the retry. `readWitness` and `readLedger` are
 * the two reads, injected as closures: production callers pass the real disk reads; tests pass stubs to
 * drive an interleave deterministically (the seam §7 prescribes). CONSISTENCY: the returned `ledger`,
 * `state`, and `verdict` are ALWAYS from the SAME (final) read pair — on a retry the downstream caller
 * uses the RE-READ bytes/records and the RE-READ witness identity, never the first read's.
 */
export function witnessedRead<T extends { bytes: Buffer }>(
  readWitness: () => ScopeWitnessState,
  readLedger: () => T,
): { ledger: T; state: ScopeWitnessState; verdict: WitnessVerdict } {
  let state = readWitness();          // WITNESS FIRST
  let ledger = readLedger();          // ledger SECOND
  let verdict = classifyState(state, ledger.bytes);
  if (isWitnessAlarm(verdict)) {
    // Exactly one retry, same witness-first order. Use the second verdict regardless (never loop):
    // a transient interleave resolves to benign; a stable alarm re-classifies to the same alarm.
    state = readWitness();
    ledger = readLedger();
    verdict = classifyState(state, ledger.bytes);
  }
  return { ledger, state, verdict };
}

export interface LedgerWitnessed {
  bytes: Buffer;
  records: MemoryRecord[];
  verdict: WitnessVerdict;
  /** The witnessed entry's own MAC — a stable-per-epoch fingerprint of what the witness currently
   *  attests — or the sentinel `'witness-absent'` when no valid entry exists (none minted yet, or
   *  the stored entry/journal failed its MAC check: classifyState's macInvalid wholesale-degrade,
   *  witness-store.ts). This is the WITNESS's identity, never a ledger record's own `mac` field.
   *  Derived from the SAME (final) witness state object the verdict is — never a third read. */
  witnessIdentity: string;
  /** True iff a journal is currently pending for this scope (an in-flight rewrite transition was
   *  opened but not yet completed or cleared). Mirrors the final witness state's `journal !== null`,
   *  degraded to false under macInvalid — a corrupt journal is treated as absent, same as the verdict
   *  path (classifyState never consults a macInvalid journal either). */
  journalPending: boolean;
  /** Read+parse time of the FINAL ledger read (readLedgerRaw), in ms — for stats-emitting callers
   *  (verifiedLiveWitnessed's parseMs) that must time the ledger read WITHOUT the witness read/classify/
   *  retry folded in, keeping the A3 replay curve comparable across surfaces. Ignored by others. */
  parseMs: number;
}

/**
 * Read one ledger's raw bytes + records (readLedgerRaw) and classify them against this scope's witness
 * state, witness-FIRST with a single alarm retry (witnessedRead — see the module header). `home` +
 * `projectRoot` resolve the same scope key `scopeKeyOf` derives for witness-store's own callers, so a
 * project-scope caller and a global caller can never cross-classify against the wrong scope's entry.
 * verdict, witnessIdentity, and journalPending all derive from the SAME final witness state snapshot.
 */
export function readLedgerWitnessed(path: LedgerPath, home: string, projectRoot?: string): LedgerWitnessed {
  const scopeKey = scopeKeyOf(home, projectRoot);
  const { ledger, state, verdict } = witnessedRead(
    () => readScopeWitness(home, scopeKey),
    () => { const t0 = performance.now(); const r = readLedgerRaw(path); return { ...r, parseMs: performance.now() - t0 }; },
  );
  return {
    bytes: ledger.bytes,
    records: ledger.records,
    verdict,
    witnessIdentity: state.entry?.mac ?? 'witness-absent',
    journalPending: state.journal !== null,
    parseMs: ledger.parseMs,
  };
}

export interface LedgerBytesWitnessed {
  bytes: Buffer;
  verdict: WitnessVerdict;
  witnessIdentity: string;   // the witness entry's own MAC, or 'witness-absent' (see LedgerWitnessed)
  journalPending: boolean;   // an in-flight rewrite transition is open (see LedgerWitnessed)
  readMs: number;            // time of the FINAL readLedgerBytes call, in ms (recall's parseMs component)
}

/**
 * The BYTES-ONLY sibling of readLedgerWitnessed — reads the witness first, then the ledger bytes with
 * `readLedgerBytes` (NO parse), classifies, and retries once (witnessedRead). This is what preserves
 * recall's zero-parse cache-HIT invariant (Task 4): the cache key's digest + the witness verdict are
 * computed from raw bytes alone, so a HIT never pays a parse. The caller re-decodes these SAME final
 * bytes only on a MISS. Deliberately NOT built on readLedgerRaw (which parses unconditionally).
 */
export function readLedgerBytesWitnessed(path: LedgerPath, home: string, projectRoot?: string): LedgerBytesWitnessed {
  const scopeKey = scopeKeyOf(home, projectRoot);
  const { ledger, state, verdict } = witnessedRead(
    () => readScopeWitness(home, scopeKey),
    () => { const t0 = performance.now(); const bytes = readLedgerBytes(path); return { bytes, readMs: performance.now() - t0 }; },
  );
  return {
    bytes: ledger.bytes,
    verdict,
    witnessIdentity: state.entry?.mac ?? 'witness-absent',
    journalPending: state.journal !== null,
    readMs: ledger.readMs,
  };
}
