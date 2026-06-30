import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, mkdirSync, openSync, fsyncSync, closeSync, writeSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryRecord } from '../types.js';
import { buildProjection } from './projection.js';
import { withFileLock } from './lock.js';

export type LedgerPath = string;

/** A compaction-horizon marker: a content-free, unsigned, verify-shaped tombstone (mirrors the
 *  integrity tombstone) recording that a compaction dropped closed fact history (spec §3). The
 *  `horizon_` id prefix distinguishes it from the integrity tombstone. It is inert in every replay
 *  path (a verify with a null target) and is counted by buildHistory's truncated heuristic. */
export const isHorizonMarker = (r: MemoryRecord): boolean =>
  r.type === 'verify' && r.supersedes === null && !r.mac && r.id.startsWith('horizon_');

/** Append one record as a single JSONL line WITHOUT taking the ledger lock. Creates parent dirs
 *  as needed. For callers that ALREADY hold the ledger lock (withFileLock is not re-entrant), e.g.
 *  the store's signing writeVerify reads the verified projection and appends under one lock. */
export function appendRecordUnlocked(path: LedgerPath, record: MemoryRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + '\n');
}

/** Append one record as a single JSONL line. Creates parent dirs as needed.
 *  Locked so a concurrent compaction (rewrite+rename) in another process can't drop it.
 *  Parent dir is created BEFORE the lock: withFileLock does a NON-recursive mkdir of `<path>.lock`,
 *  which throws ENOENT if the parent doesn't exist yet (e.g. a clean-install first global commit
 *  where neither ensureMaster nor stampOwnership has pre-created the home dir). */
export function appendRecord(path: LedgerPath, record: MemoryRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  withFileLock(path, () => appendRecordUnlocked(path, record));
}

/** Read every record from the ledger, in append order. Missing file -> []. */
export function parseLedger(path: LedgerPath): MemoryRecord[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: MemoryRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as MemoryRecord);
    } catch {
      // Tolerate a torn/corrupt line (spec §10) — skip, don't crash.
      continue;
    }
  }
  return out;
}

export interface CompactOptions {
  /** Ids whose CONTENT must be physically erased (right-to-erasure / secrets). */
  erasedIds: Set<string>;
  /**
   * HMAC-aware compaction. When supplied, genuine SIGNED `verify` records whose target survives
   * compaction are PRESERVED (so R2/R3 re-elevate them on replay) and forged ones are DROPPED.
   * Returns true iff the verify is genuinely signed for the ledger being compacted.
   *
   * Why this is required: the live projection BAKES each verify's elevated state into the asset
   * record and then drops the verify event. But the verifying replay (R1) ignores the `state` of
   * every non-`verify` record and forces Fresh — so a baked elevation would be silently LOST.
   * Preserving the original signed verify is the only way a genuine elevation survives a rewrite.
   * Omitted => legacy behaviour (bake state, drop all verifies) is unchanged.
   */
  keepValidVerify?: (r: MemoryRecord) => boolean;
}

/**
 * Rewrite the ledger to the canonical current state. Crash-safe: writes <path>.tmp,
 * fsyncs, then atomically renames over <path>.
 *
 * Output = the live projection (superseded/invalidated/erased targets already excluded,
 * verify states applied) MINUS any `erasedIds`, PLUS one content-free tombstone per erase
 * marker (so an erasure leaves an audit trace but no plaintext — satisfies right-to-erasure).
 */
export function compactLedger(path: LedgerPath, opts: CompactOptions): void {
  // Hold the lock across read -> rewrite -> rename so a concurrent append can't be lost and a
  // stale snapshot can't resurrect erased content. parseLedger runs INSIDE the lock, so we
  // always compact the latest committed state.
  withFileLock(path, () => {
    const records = parseLedger(path);

    // The live projection already excludes superseded/invalidated/erased targets and applies
    // verify states, so materializing it yields the canonical current facts.
    const live = buildProjection(records);
    // HMAC-aware mode resets each kept asset's baked state to Fresh: the verifying replay (R1)
    // clamps non-verify state to Fresh anyway, so persisting a baked elevation here is misleading —
    // the re-kept signed verify (below) is the SOLE source of trust on replay. Legacy mode (no
    // keepValidVerify) must NOT reset, since it drops verifies and the baked state is all that's left.
    const hmacAware = opts.keepValidVerify !== undefined;
    const kept: MemoryRecord[] = [];
    for (const r of live.values()) {
      if (opts.erasedIds.has(r.id)) continue;
      kept.push(hmacAware ? { ...r, state: 'Fresh' } : r);
    }
    // Keep a content-free tombstone for each erase marker (audit: an erasure happened).
    // NOTE: tombstones persist across compactions, retaining `supersedes: <erasedId>`. With
    // randomUUID ids, reusing an erased id is effectively impossible; but if ids ever become
    // caller-supplied, a reused id would be silently removed by the stale tombstone.
    for (const r of records) {
      if (r.type === 'erase') kept.push({ ...r, content: '' });
    }

    // HMAC-aware: preserve genuine signed verifies (so R2/R3 re-elevate the asset on replay) and
    // drop forged ones. A verify whose target was superseded/erased is naturally excluded — its
    // target is no longer in `live`. If any forgery is discarded, emit ONE content-free integrity
    // tombstone as an audit signal (no MAC: it confers no trust, and R2 never treats it as a
    // transition because supersedes is null).
    if (opts.keepValidVerify) {
      let droppedForged = 0;
      for (const r of records) {
        if (r.type !== 'verify' || !r.supersedes || !live.has(r.supersedes)) continue;
        if (opts.keepValidVerify(r)) kept.push(r);
        else droppedForged++;
      }
      if (droppedForged > 0) {
        const ts = new Date().toISOString();
        kept.push({
          id: `integrity_${randomUUID()}`, tx: ts, validFrom: ts, validTo: null,
          type: 'verify', state: 'Suspect', content: '',
          provenance: { source: 'user', sessionId: 'compaction' },
          supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
        });
      }
    }

    // Compaction-horizon marker (spec §4): keep at most one. Preserve an existing one (tx-blind: the
    // first in append order) so the signal never reverts; otherwise emit one iff this compaction drops a
    // closed FACT row (an assert/supersede absent from live — covers supersede/invalidate/erase closers).
    const existingHorizon = records.find(isHorizonMarker);
    if (existingHorizon) {
      kept.push(existingHorizon);
    } else if (records.some((r) => (r.type === 'assert' || r.type === 'supersede') && !live.has(r.id))) {
      const hts = new Date().toISOString();
      kept.push({
        id: `horizon_${randomUUID()}`, tx: hts, validFrom: hts, validTo: null,
        type: 'verify', state: 'Suspect', content: '',
        provenance: { source: 'user', sessionId: 'compaction' },
        supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
      });
    }

    // Per-process tmp name: even if the lock is ever stolen, two processes never share a
    // half-written tmp file (the rename stays atomic on the same filesystem).
    const tmp = `${path}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      for (const r of kept) writeSync(fd, JSON.stringify(r) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path); // atomic on the same filesystem
  });
}
