import { appendFileSync, readFileSync, mkdirSync, openSync, fsyncSync, closeSync, writeSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryRecord } from '../types.js';

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
 * Rewrite the ledger, dropping dead records and erasing content where required.
 * Crash-safe: writes <path>.tmp, fsyncs, then atomically renames over <path>.
 *
 * Live-record rules (order matters):
 * 1. An id in `erasedIds` is kept as a single content-free audit row
 *    (classification 'secret-redacted'); its content payload is removed.
 * 2. 'invalidate' / 'erase' markers are consumed by compaction, not retained.
 *    ('supersede' is NOT a marker — it is the live replacement fact, so it is kept.)
 * 3. A record whose id is the target of any supersede/invalidate/erase is dropped.
 */
export function compactLedger(path: LedgerPath, opts: CompactOptions): void {
  const records = parseLedger(path);

  const supersededIds = new Set<string>();
  for (const r of records) if (r.supersedes) supersededIds.add(r.supersedes);

  const kept: MemoryRecord[] = [];
  for (const r of records) {
    if (opts.erasedIds.has(r.id)) {
      kept.push({
        ...r,
        content: '',
        classification: 'secret-redacted',
        provenance: { ...r.provenance, verifier: undefined },
      });
      continue;
    }
    if (r.type === 'invalidate' || r.type === 'erase') continue; // markers -> drop
    if (supersededIds.has(r.id)) continue;                       // replaced/removed fact -> drop
    kept.push(r);
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
