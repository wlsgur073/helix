// Pure eligibility gates for the auto-compaction trigger (spec 2026-07-09). No IO, no clock read.
import type { CompactionConfig } from '../config.js';

export type DeferReason = 'notAuto' | 'tooSmall' | 'tooBig' | 'notQuiescent';

/** Cheap gates evaluated from free signals (`rows`, plus one statSync for bytes+mtime) BEFORE the
 *  expensive planCompaction pass, so that pass is reached at most once per session.
 *
 *  `rows` is the ledger's TOTAL PHYSICAL row count (every line), never liveRows.
 *
 *  Guard ORDER is part of the contract, because `reason` is a shipped observable that labels the
 *  compaction metric: disabled-ness dominates every diagnostic, since telling a user who merely set
 *  `auto: false` that their ledger is `tooSmall` is actively misleading. `proceed` itself is an
 *  order-invariant conjunction. Order (pinned by tests): notAuto -> tooSmall -> tooBig -> notQuiescent.
 *
 *  Quiescence compares the ledger FILE's mtime against nowMs, never a record's declared `tx`. A
 *  declared `tx` is author-controlled and forgeable in BOTH directions: dated forward it defers
 *  compaction indefinitely (a deadlock an attacker chooses), dated backward it makes a genuinely
 *  active ledger look idle. mtime is OS-maintained, updated on writes and not on reads, and no
 *  record author can set it. It is NOT skew-proof, and the two skew directions are asymmetric:
 *    - a FUTURE-dated mtime (archive restored with its stamps, NTP step-back) drives
 *      `nowMs - mtimeMs` negative, so the ledger always reads `notQuiescent` and compaction DEFERS
 *      until the wall clock passes `mtimeMs + graceMs` — bounded and self-clearing;
 *    - a FORWARD clock step inflates the same difference and can make a just-written ledger look
 *      quiescent early.
 *  The consequences of that early fire are NOT the same for both properties, and must not be conflated:
 *    - LEDGER INTEGRITY is never at risk, in either direction. compactLedger holds the ledger lock
 *      across read -> rewrite -> rename (ledger.ts), so an early fire can never lose a concurrent
 *      append or resurrect an erased record.
 *    - The UNDO GUARANTEE is degraded, in the forward direction only. planCompaction has no
 *      per-record age filter: it keeps the live projection (plus content-free erase tombstones and
 *      genuine verifies) and drops EVERY dead record, however recently it died. So an early fire
 *      physically destroys recently-dead records — closing the soft-erase undo window and dropping
 *      recent asOf/history rows before the grace window the user was promised. That is the exact
 *      loss `graceMs` exists to prevent, not a redundant rewrite. Detecting it would need a
 *      monotonic clock reference the read path does not have; it is an ACCEPTED, NAMED v1
 *      limitation (spec 2026-07-09 section 7), not a harmless one.
 *  Backward skew (a future-dated mtime) stays the benign direction: it only defers. */
export function cheapGate(a: { rows: number; totalBytes: number; mtimeMs: number; nowMs: number; cfg: CompactionConfig }): { proceed: boolean; reason?: DeferReason } {
  if (!a.cfg.auto) return { proceed: false, reason: 'notAuto' };
  if (a.rows < a.cfg.minRows) return { proceed: false, reason: 'tooSmall' };
  if (a.totalBytes > a.cfg.maxBytes) return { proceed: false, reason: 'tooBig' };
  if (a.nowMs - a.mtimeMs < a.cfg.graceMs) return { proceed: false, reason: 'notQuiescent' };
  return { proceed: true };
}

/** The reclaim branch (run only after cheapGate proceeds and planCompaction has produced the counts).
 *  Ratio OR byte-exact absolute — the absolute branch catches a big-and-meaningfully-dirty ledger the
 *  ratio misses, while reclaimableBytes (exact, not proportional) avoids firing on a huge near-zero-
 *  ratio ledger.
 *
 *  `rows` is the TOTAL PHYSICAL row count (the same quantity cheapGate takes), and
 *  `0 <= reclaimable <= rows` is a caller PRECONDITION, not validated here: planCompaction derives
 *  both counts from one pass over the same rows. Feeding liveRows to one function and total rows to
 *  the other silently redefines the ratio and can push it above 1. The `rows === 0` guard is a
 *  TOTALITY guard, not a precondition check: without it an empty ledger leaks `0/0 = NaN` (or
 *  `n/0 = Infinity`) into a boolean. */
export function dirtyGate(a: { rows: number; reclaimable: number; reclaimableBytes: number; cfg: CompactionConfig }): boolean {
  if (a.rows === 0) return false;
  return a.reclaimable / a.rows >= a.cfg.dirtyRatio || a.reclaimableBytes >= a.cfg.minDirtyBytes;
}
