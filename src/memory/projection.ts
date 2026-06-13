import type { MemoryRecord } from '../types.js';
import { rankRecords } from './retrieval.js';

export type Projection = Map<string, MemoryRecord>;

/**
 * Replay the ledger into a map of currently-live items.
 * supersede/invalidate/erase markers remove the item they reference; they are not facts.
 * A 'supersede' record is itself the live replacement, so it stays.
 *
 * 'verify' records update their target's state (referenced via `supersedes`) and are NOT
 * surfaced as live facts — a verify event is not itself recallable.
 */
export function buildProjection(records: MemoryRecord[]): Projection {
  const removed = new Set<string>();
  const live = new Map<string, MemoryRecord>();
  for (const r of records) {
    if (r.type === 'verify') {
      const target = r.supersedes;
      if (target && live.has(target)) {
        const cur = live.get(target)!;
        live.set(target, { ...cur, state: r.state });
      }
      continue; // a verify is not itself a recallable fact
    }
    if (r.type === 'supersede' || r.type === 'invalidate' || r.type === 'erase') {
      if (r.supersedes) removed.add(r.supersedes);
      if (r.type === 'supersede') live.set(r.id, r); // the replacement fact stays live
      continue;
    }
    live.set(r.id, r);
  }
  for (const id of removed) live.delete(id);
  return live;
}

export interface RecallOptions {
  maxItems?: number; // bound how many items can be injected into context
}

/**
 * Return the live items relevant to a query, ranked by the lexical scorer
 * (phrase/coverage-first, BM25-assisted, trust-margin). See src/memory/retrieval.ts.
 */
export function recall(projection: Projection, query: string, opts: RecallOptions = {}): MemoryRecord[] {
  return rankRecords([...projection.values()], query, opts);
}
