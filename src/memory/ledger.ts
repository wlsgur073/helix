import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
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
