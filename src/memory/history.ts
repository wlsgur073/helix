import type { MemoryRecord, HistoricalRecord } from '../types.js';
import { buildProjection } from './projection.js';

export interface History {
  rows: HistoricalRecord[];
  anomalies: Set<string>;
  truncated: boolean;
}

/** Strict canonical-UTC instant, matching `new Date().toISOString()`. Used by the surface to
 *  sentinelize a forged/non-canonical timestamp before it enters a trusted label (spec §6). */
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const isIsoInstant = (s: string): boolean => {
  if (!ISO_Z.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString() === s; // reject shaped-but-impossible instants
};

type Closer = { kind: 'supersede' | 'invalidate' | 'erase'; i: number; tx: string; markerId: string };
const isClosing = (t: MemoryRecord['type']): t is Closer['kind'] =>
  t === 'supersede' || t === 'invalidate' || t === 'erase';

/** Materialize [tx, txTo) for every fact row (assert + supersede replacement rows). Liveness comes
 *  from the SINGLE buildProjection call (spec §4.1); the marker scan only annotates closed rows.
 *  A "marker" is a closing record (supersede/invalidate/erase); verify is never a marker. */
export function buildHistory(records: MemoryRecord[]): History {
  const live = buildProjection(records);
  const anomalies = new Set<string>();

  // First pass: index fact rows by append position; collect closing markers per target.
  const factIndex = new Map<string, number>();
  const markersByTarget = new Map<string, Closer[]>();
  records.forEach((r, i) => {
    if (r.type === 'assert' || r.type === 'supersede') {
      if (factIndex.has(r.id)) anomalies.add(r.id); // duplicate fact id (forged; randomUUID precludes it)
      else factIndex.set(r.id, i);
    }
    if (isClosing(r.type) && r.supersedes) {
      const arr = markersByTarget.get(r.supersedes) ?? [];
      arr.push({ kind: r.type, i, tx: r.tx, markerId: r.id });
      markersByTarget.set(r.supersedes, arr);
    }
  });

  // Second pass: emit one HistoricalRecord per fact row (first occurrence, append order).
  const rows: HistoricalRecord[] = [];
  const emitted = new Set<string>();
  for (const r of records) {
    if (r.type !== 'assert' && r.type !== 'supersede') continue;
    if (emitted.has(r.id)) continue;
    emitted.add(r.id);

    if (live.has(r.id)) { rows.push({ record: r, txTo: null, closedBy: null }); continue; }

    // Closed (per §4.1). Select the closer by APPEND POSITION only; tx never selects.
    const ri = factIndex.get(r.id)!;
    const markers = markersByTarget.get(r.id) ?? [];
    const after = markers.filter((m) => m.i > ri).sort((x, y) => x.i - y.i);
    const C = after[0];
    if (markers.some((m) => m.i < ri)) anomalies.add(r.id); // a before-target marker is always anomalous

    let txTo: string;
    let closedBy: HistoricalRecord['closedBy'];
    if (C) {
      closedBy = { kind: C.kind, markerId: C.markerId };
      if (C.tx >= r.tx) { txTo = C.tx; }                 // (a) normal
      else { txTo = r.tx; anomalies.add(r.id); }         // (b) tx-before -> clamp + flag
    } else {                                             // (c) only a before-R marker removed it
      const earliest = [...markers].sort((x, y) => x.i - y.i)[0];
      closedBy = earliest ? { kind: earliest.kind, markerId: earliest.markerId } : null;
      txTo = r.tx; anomalies.add(r.id);
    }

    const record = closedBy?.kind === 'erase' ? { ...r, content: '' } : r; // §6 redaction
    rows.push({ record, txTo, closedBy });
  }

  const factIds = new Set(factIndex.keys());
  const truncated = records.some((r) => {
    // integrity tombstone (content-free, unsigned, no target) => HMAC-aware compaction ran
    if (r.type === 'verify' && r.supersedes === null && !r.mac && r.content === '') return true;
    // orphan erase tombstone (target row no longer present) => permanent-erase compaction ran
    return r.type === 'erase' && r.supersedes !== null && !factIds.has(r.supersedes);
  });

  return { rows, anomalies, truncated };
}
