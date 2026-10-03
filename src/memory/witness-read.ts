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
 *    - Retry-once resolves the SHORT concurrent-REWRITE interleaves: a rewrite's rename landing between
 *      the two reads of a pair makes the OLD entry not match the already-rewritten bytes (mismatch)
 *      until the witness catches up, and an immediate re-read (witness-first again) sees the settled
 *      state. The retry uses the SECOND verdict UNCONDITIONALLY — it never loops — so a genuine,
 *      STABLE rollback (bytes that truly do not descend from the witness on BOTH reads) still verdicts
 *      `mismatch` and is never masked.
 *    - An immediate re-read does NOT outlast a rewrite's journal window (compactLedger publishes the
 *      journal, then renames the new bytes into place; in between the bytes still sit at the
 *      predecessor and classify `transition-interrupted`). IT-M6: when the retry still verdicts
 *      `transition-interrupted`, the scope's LEDGER lock is consulted — every rewrite holds it from
 *      before the journal until after completion. A holder that classifies alive or alive-unknown is
 *      waited for (every 25 ms, at most 2,000 ms, lock.ts awaitLiveHolder); no lock, a dead holder or
 *      this thread's own lock means there is no writer to wait for. Ruling R5: WHATEVER the
 *      consultation found — none, released, timeout — the scope is then read ONCE more, witness-first,
 *      and that verdict is used unchanged. "No lock" at the consultation does not mean nothing landed:
 *      a rewriter can rename, complete the transition and release in the gap after the retry's read
 *      pair, and a reader that read again only after a wait returned the stale interrupted verdict
 *      for a scope already in sync. The third read costs one more read pair only where the verdict is
 *      still `transition-interrupted` after the retry, i.e. a scope whose journal outlived its writer
 *      or whose rewrite is in flight.
 *      The wait reads only the lock file and /proc; it never changes a verdict, and a scope that is
 *      still interrupted after the third read is withheld exactly as before. */
import type { MemoryRecord } from '../types.js';
import { readLedgerRaw, readLedgerBytes, type LedgerPath } from './ledger.js';
import { awaitLiveHolder, type HolderWaitOutcome } from './lock.js';
import { classifyState, readScopeWitness, scopeKeyOf, type ScopeWitnessState } from './witness-store.js';
import type { WitnessVerdict } from './witness-core.js';

/** IT-M6 reader-wait budget: how long a witnessed read waits for a live holder of the scope's ledger
 *  lock before it re-reads, and how often it looks. The SessionStart hook runs under a 10 s limit
 *  (hooks/hooks.json) and reads at most two scopes. */
export const REWRITER_WAIT_MAX_MS = 2_000;
export const REWRITER_WAIT_POLL_MS = 25;

/** The production rewriter wait for one ledger: waits for a live holder of its lock (lock.ts
 *  awaitLiveHolder) and reports what it found. The caller reads once more whatever the answer (R5);
 *  the answer is returned for observability only. Pure read — see awaitLiveHolder. */
export function awaitLedgerRewriter(ledger: LedgerPath): HolderWaitOutcome {
  return awaitLiveHolder(ledger, { maxWaitMs: REWRITER_WAIT_MAX_MS, pollMs: REWRITER_WAIT_POLL_MS });
}

/** The two alarm verdicts a witnessed read retries on (spec §7). Every other verdict — first-contact,
 *  in-sync, unwitnessed-suffix, transition-heal — is either benign or resolved by a later WRITE, so a
 *  re-read cannot improve it and none is retried. */
export function isWitnessAlarm(v: WitnessVerdict): boolean {
  return v.kind === 'mismatch' || v.kind === 'transition-interrupted';
}

/**
 * The ONE place the §7 order + retry live — a higher-order read so every witnessed read (the two
 * helpers below, and through them every lock-free grade-assigning reader) shares a single
 * implementation rather than each duplicating the retry. `readWitness` and `readLedger` are
 * the two reads, injected as closures: production callers pass the real disk reads; tests pass stubs to
 * drive an interleave deterministically (the seam §7 prescribes). CONSISTENCY: the returned `ledger`,
 * `state`, and `verdict` are ALWAYS from the SAME (final) read pair — on a retry the downstream caller
 * uses the RE-READ bytes/records and the RE-READ witness identity, never the first read's.
 * `awaitRewriter` is the IT-M6 lock consultation (module header), injected like the two reads so a
 * test can drive it without a lock or a clock: called at most once, only when the retry still verdicts
 * `transition-interrupted`, and followed by exactly one more read pair WHATEVER it returns (R5) — its
 * return value is not read. Omitted, the read behaves exactly as before IT-M6 (two read pairs at most).
 */
export function witnessedRead<T extends { bytes: Buffer }>(
  readWitness: () => ScopeWitnessState,
  readLedger: () => T,
  awaitRewriter?: () => unknown,
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
    // IT-M6: a journal still over the old bytes may be a rewrite in progress — or one that landed and
    // released after the read pair above. Consult the ledger lock (waiting for a LIVE holder), then read
    // once more whatever it found (R5), and keep that verdict as it is (never loop, never relax).
    if (verdict.kind === 'transition-interrupted' && awaitRewriter) {
      awaitRewriter();
      state = readWitness();
      ledger = readLedger();
      verdict = classifyState(state, ledger.bytes);
    }
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
 * state, witness-FIRST with a single alarm retry and, for a scope still transition-interrupted, the
 * ledger-lock consultation and one more read (witnessedRead — see the module header). `home` +
 * `projectRoot` resolve the same scope key `scopeKeyOf` derives for witness-store's own callers, so a
 * project-scope caller and a global caller can never cross-classify against the wrong scope's entry.
 * verdict, witnessIdentity, and journalPending all derive from the SAME final witness state snapshot.
 */
export function readLedgerWitnessed(path: LedgerPath, home: string, projectRoot?: string): LedgerWitnessed {
  const scopeKey = scopeKeyOf(home, projectRoot);
  const { ledger, state, verdict } = witnessedRead(
    () => readScopeWitness(home, scopeKey),
    () => { const t0 = performance.now(); const r = readLedgerRaw(path); return { ...r, parseMs: performance.now() - t0 }; },
    () => awaitLedgerRewriter(path),
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
 * `readLedgerBytes` (NO parse), classifies, retries once, and for a scope still transition-interrupted
 * consults the ledger lock and reads once more (witnessedRead). This is what preserves
 * recall's zero-parse cache-HIT invariant (Task 4): the cache key's digest + the witness verdict are
 * computed from raw bytes alone, so a HIT never pays a parse. The caller re-decodes these SAME final
 * bytes only on a MISS. Deliberately NOT built on readLedgerRaw (which parses unconditionally).
 */
export function readLedgerBytesWitnessed(path: LedgerPath, home: string, projectRoot?: string): LedgerBytesWitnessed {
  const scopeKey = scopeKeyOf(home, projectRoot);
  const { ledger, state, verdict } = witnessedRead(
    () => readScopeWitness(home, scopeKey),
    () => { const t0 = performance.now(); const bytes = readLedgerBytes(path); return { bytes, readMs: performance.now() - t0 }; },
    () => awaitLedgerRewriter(path),
  );
  return {
    bytes: ledger.bytes,
    verdict,
    witnessIdentity: state.entry?.mac ?? 'witness-absent',
    journalPending: state.journal !== null,
    readMs: ledger.readMs,
  };
}
