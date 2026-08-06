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
/**
 * `records` with every non-canonical duplicate of a fact id dropped: the FIRST row bearing an id
 * owns it, in file order.
 *
 * Ledger-wide by construction, and that scope is the point — `asof.ts` must resolve ownership over
 * the WHOLE ledger before it windows by `tx`, because a forged duplicate dated before the row it
 * shadows is the only claimant inside its own window and a window-scoped rule sees nothing to
 * arbitrate.
 *
 * Helix never re-uses an id: `store.commit` mints `m_${randomUUID()}` and models every update as a
 * NEW id carrying `supersedes`, so this is a no-op on any ledger the store wrote — it only bites
 * rows some other writer appended to `memory.jsonl` directly. Letting the LAST such row win handed
 * that writer the earlier row's signed grade along with adversary-chosen `provenance`,
 * `classification` and validity bounds, none of which any MAC covers (F2 leg 1). File position is
 * the only ordering signal worth reading here: a non-verify row carries no MAC at all, so its `tx`
 * and `gen` are adversary-chosen, whereas rewriting the witnessed prefix to get in front of the
 * genuine row is what the rollback witness classifies as `mismatch`.
 *
 * `verify`/`invalidate`/`erase` never write the live map and pass through untouched.
 */
export function withoutDuplicateFactIds(records: MemoryRecord[]): MemoryRecord[] {
  const owned = new Set<string>();
  return records.filter((r) => {
    if (r.type === 'verify' || r.type === 'invalidate' || r.type === 'erase') return true;
    if (owned.has(r.id)) return false;
    owned.add(r.id);
    return true;
  });
}

export function buildProjection(records: MemoryRecord[]): Projection {
  const removed = new Set<string>();
  const live = new Map<string, MemoryRecord>();
  for (const r of withoutDuplicateFactIds(records)) {
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
