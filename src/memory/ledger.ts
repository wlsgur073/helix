import { appendFileSync, readFileSync, mkdirSync, openSync, fsyncSync, closeSync, writeSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryRecord } from '../types.js';
import { buildProjection } from './projection.js';
import { withFileLock } from './lock.js';

export type LedgerPath = string;

/** Append one record as a single JSONL line WITHOUT taking the ledger lock. Creates parent dirs
 *  as needed. For callers that ALREADY hold the ledger lock (withFileLock is not re-entrant), e.g.
 *  the store's signing writeVerify reads the verified projection and appends under one lock. */
export function appendRecordUnlocked(path: LedgerPath, record: MemoryRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + '\n');
}

/** Append one record as a single JSONL line. Creates parent dirs as needed.
 *  Locked so a concurrent compaction (rewrite+rename) in another process can't drop it. */
export function appendRecord(path: LedgerPath, record: MemoryRecord): void {
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
    const kept: MemoryRecord[] = [];
    for (const r of live.values()) {
      if (!opts.erasedIds.has(r.id)) kept.push(r);
    }
    // Keep a content-free tombstone for each erase marker (audit: an erasure happened).
    // NOTE: tombstones persist across compactions, retaining `supersedes: <erasedId>`. With
    // randomUUID ids, reusing an erased id is effectively impossible; but if ids ever become
    // caller-supplied, a reused id would be silently removed by the stale tombstone.
    for (const r of records) {
      if (r.type === 'erase') kept.push({ ...r, content: '' });
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
