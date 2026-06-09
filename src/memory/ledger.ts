import { appendFileSync, readFileSync, mkdirSync, openSync, fsyncSync, closeSync, writeSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryRecord } from '../types.js';
import { buildProjection } from './projection.js';

export type LedgerPath = string;

/** Append one record as a single JSONL line. Creates parent dirs as needed. */
export function appendRecord(path: LedgerPath, record: MemoryRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + '\n');
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

  const tmp = path + '.tmp';
  const fd = openSync(tmp, 'w');
  try {
    for (const r of kept) writeSync(fd, JSON.stringify(r) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path); // atomic on the same filesystem
}
