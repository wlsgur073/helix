import type { MemoryRecord } from '../types.js';

export type Projection = Map<string, MemoryRecord>;

/**
 * Replay the ledger into a map of currently-live items.
 * supersede/invalidate/erase markers remove the item they reference; they are not facts.
 * A 'supersede' record is itself the live replacement, so it stays.
 */
export function buildProjection(records: MemoryRecord[]): Projection {
  const removed = new Set<string>();
  const live = new Map<string, MemoryRecord>();
  for (const r of records) {
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
 * Return the live items relevant to a query. v1 ranking is simple lexical term-overlap;
 * ranked FTS/BM25 retrieval is summoned later (spec §6). Results are capped so injected
 * tokens stay bounded regardless of total memory size (spec §8).
 */
export function recall(projection: Projection, query: string, opts: RecallOptions = {}): MemoryRecord[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: Array<{ rec: MemoryRecord; score: number }> = [];
  for (const rec of projection.values()) {
    const text = rec.content.toLowerCase();
    const score = terms.reduce((n, t) => (text.includes(t) ? n + 1 : n), 0);
    if (score > 0) scored.push({ rec, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const max = opts.maxItems ?? 20;
  return scored.slice(0, max).map((s) => s.rec);
}
