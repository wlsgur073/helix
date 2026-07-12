import { appendFileSync, readFileSync, mkdirSync, openSync, fsyncSync, closeSync, writeSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryRecord } from '../types.js';
import { buildProjection } from './projection.js';
import { withFileLock } from './lock.js';

export type LedgerPath = string;

/** Fixed sentinel timestamp for the coalesced, unsigned advisory markers. They carry NO honest time
 *  (an unsigned boolean has no chronology), so a CONSTANT makes them byte-identical across compactions
 *  and denies an adversary any preserved bytes. */
const MARKER_SENTINEL_TX = '1970-01-01T00:00:00.000Z';

/** A verify-shaped, unsigned, content-free tombstone with a null target. Both marker kinds share this
 *  shape; the id PREFIX distinguishes them. Predicates are TOTAL (typeof-guarded) so a malformed row
 *  that slipped a parse boundary can never throw here. */
const isMarkerShape = (r: MemoryRecord): boolean =>
  r != null && r.type === 'verify' && r.supersedes === null && !r.mac && typeof r.id === 'string';

/** A compaction-horizon marker: a content-free, unsigned, verify-shaped tombstone (mirrors the
 *  integrity tombstone) recording that a compaction dropped closed fact history (spec §3). The
 *  `horizon_` id prefix distinguishes it from the integrity tombstone. It is inert in every replay
 *  path (a verify with a null target) and is counted by buildHistory's truncated heuristic. */
export const isHorizonMarker = (r: MemoryRecord): boolean => isMarkerShape(r) && r.id.startsWith('horizon_');

/** The integrity-incident counterpart to isHorizonMarker: an audit signal that a compaction dropped
 *  >=1 forged verify (spec §5 delta). Module-private — external callers key off the `integrity_`
 *  prefix via parseLedger output (e.g. test assertions), never need the predicate itself. */
const isIntegrityMarker = (r: MemoryRecord): boolean => isMarkerShape(r) && r.id.startsWith('integrity_');

/** Reconstruct a marker CANONICALLY — every field whitelisted, constant id, sentinel timestamps. Never
 *  copies an existing row through, so hostile content/provenance/timestamps/extension fields on a
 *  planted marker cannot survive. `kind` is the stable id, so at most one row per kind can ever exist
 *  and it is byte-identical every time it is (re)minted. */
function canonicalMarker(kind: 'integrity_marker' | 'horizon_marker'): MemoryRecord {
  return {
    id: kind, tx: MARKER_SENTINEL_TX, validFrom: MARKER_SENTINEL_TX, validTo: null,
    type: 'verify', state: 'Suspect', content: '',
    provenance: { source: 'user', sessionId: 'compaction' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  };
}

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

/**
 * Structural guard at the parse boundary. `JSON.parse(line) as MemoryRecord` is a lie to the type
 * checker: a ledger-write adversary appends ANY JSON value and every downstream predicate then
 * dereferences it. A bare `null` line, or `content: null`, throws inside recall (TypeError on `.type` /
 * `.normalize`) and PERMANENTLY BRICKS the tool; `id: null` throws inside the marker predicates; a
 * malformed `tx` throws inside the recall/session-start tie-break sort (`b.rec.tx.localeCompare(a.rec.tx)`
 * in retrieval.ts, `b.record.tx.localeCompare(...)` in format-context.ts) the instant two rows land on
 * an equal score.
 *
 * MINIMAL BY DESIGN. It rejects only values that make a TOTAL function throw — a non-object, or a
 * non-string where downstream calls a string method (`id.startsWith` / `safeId(id).replace`,
 * `content.normalize`, `provenance.source`, `tx.localeCompare`). `tx` is validated for that last reason:
 * it IS dereferenced, not merely compared. It deliberately does NOT validate enums (`type`, `state`),
 * `validFrom`/`validTo`, `supersedes`, or `mac` (the `typeof mac === 'string'` clause was REMOVED, T2-e:
 * `mac` is only ever compared/read by the MAC verifier, never dereferenced here, so a future schema's
 * object-shaped `mac` must not be data-lost): those are only COMPARED, never dereferenced, and rejecting
 * an unknown value there would silently DROP a legitimate row written by a future schema. Data loss is
 * worse than the crash this fixes. The one shape-check that IS added is `withinDepth`: a pathologically
 * nested value (still crash-only — it would throw inside `JSON.stringify` on rewrite/compaction), capped
 * at `MAX_PARSE_DEPTH`. Malformed rows are skipped exactly like torn lines (the existing §10 tolerance).
 */
const MAX_PARSE_DEPTH = 64; // a legitimate record is depth <= ~3; caps pathological nesting that would throw in JSON.stringify. Shape check, not value check.

/** Iterative (never recursive — the probe must not itself overflow) nesting-depth bound. */
function withinDepth(v: unknown, max: number): boolean {
  const stack: Array<{ v: unknown; d: number }> = [{ v, d: 0 }];
  while (stack.length) {
    const { v: cur, d } = stack.pop()!;
    if (cur === null || typeof cur !== 'object') continue;
    if (d >= max) return false;
    for (const child of Array.isArray(cur) ? cur : Object.values(cur as Record<string, unknown>)) {
      stack.push({ v: child, d: d + 1 });
    }
  }
  return true;
}

function isWellFormedRecord(v: unknown): v is MemoryRecord {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string'
    && typeof r.content === 'string'
    && typeof r.tx === 'string'
    && typeof r.provenance === 'object' && r.provenance !== null
    && withinDepth(v, MAX_PARSE_DEPTH);   // D6 shape cap; `mac` clause REMOVED (T2-e: it over-guarded a try/caught deref and dropped a future object-mac)
}

/** Parse already-read ledger TEXT into records PLUS a content-free health signal (count of skipped
 *  non-blank lines — torn JSON or structurally invalid). `parseLedgerText` delegates here and discards
 *  the count; a caller that wants to report parse health (e.g. a future diagnostics surface) can call
 *  this directly instead of re-deriving the count by diffing line counts against records.length. */
export function parseLedgerHealth(text: string): { records: MemoryRecord[]; skippedNonBlank: number } {
  const records: MemoryRecord[] = [];
  let skippedNonBlank = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let v: unknown;
    try { v = JSON.parse(line); } catch { skippedNonBlank++; continue; }
    if (isWellFormedRecord(v)) records.push(v);
    else skippedNonBlank++;   // structurally invalid OR too-deep — same treatment as a torn line, but counted
  }
  return { records, skippedNonBlank };
}

/** Parse already-read ledger TEXT into records (parseLedger's body minus the file read). Lets a
 *  caller that must read the bytes for another purpose (A4 recall cache: hash the exact bytes) parse
 *  the SAME bytes with no second read. Tolerates torn/corrupt lines (spec §10) — skip, don't crash.
 *  Delegates to parseLedgerHealth and discards the skip count. */
export function parseLedgerText(text: string): MemoryRecord[] {
  return parseLedgerHealth(text).records;
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
  return parseLedgerText(text);
}

export interface CompactOptions {
  /** Ids whose CONTENT must be physically erased (right-to-erasure / secrets). Doubles as the
   *  escape hatch for a planted/durable marker (F5): include its canonical id (`integrity_marker` /
   *  `horizon_marker`) to suppress re-minting it on this and every later compaction. Normal
   *  compactions pass an empty set, so the fixpoint behaviour below is unaffected. */
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

/** Keep-set planner: the exact set of records compactLedger writes for `records` + `opts`.
 *  Shared by compactLedger (which writes it) AND the auto-compaction eligibility check (which counts
 *  it), so the two can never disagree — post-compaction reclaimable is exactly zero. Does NO IO and
 *  takes NO lock (safe on the read path). The integrity/horizon markers it mints are CANONICAL
 *  fixpoints (constant id, sentinel timestamps — see canonicalMarker), so, unlike the pre-D2
 *  randomUUID-stamped markers, this function IS pure: two calls over the same `records`/`opts`
 *  produce byte-identical output, and callers may use the kept-set for identity, not just counts. */
export function planCompaction(records: MemoryRecord[], opts: CompactOptions): { kept: MemoryRecord[]; droppedForgedVerifies: number } {
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
  // target is no longer in `live`.
  let droppedForgedVerifies = 0;
  if (opts.keepValidVerify) {
    for (const r of records) {
      if (r.type !== 'verify' || !r.supersedes || !live.has(r.supersedes)) continue;
      if (opts.keepValidVerify(r)) kept.push(r);
      else droppedForgedVerifies++;
    }
  }
  // Integrity marker (D2): coalesced canonical fixpoint, never a copy-through. Emit exactly one iff
  // an existing marker is present (so a genuine prior incident's signal survives a compaction that
  // itself drops nothing forged — the D2 bug this closes) OR this compaction dropped >=1 forged
  // verify. Reconstructed via canonicalMarker, so a planted integrity_* row's hostile
  // content/provenance/timestamp cannot survive and 50 planted rows collapse to one.
  //
  // HONEST RESIDUAL (F5): the marker's PRESENCE is still forgeable — anyone who can append a row
  // whose id starts with `integrity_` mints one, real incident or not — and once minted it is now a
  // DURABLE fixpoint: an ordinary compaction re-mints it forever, it does NOT age out like the
  // pre-D2 randomUUID-stamped rows did. The only way to clear a planted marker is an out-of-band
  // permanent erase of its canonical id (`integrity_marker` in `erasedIds`, checked below) — the
  // `some(isIntegrityMarker)` OR-clause is exactly what makes that necessary: once ANY row with the
  // prefix has ever existed, the canonical id keeps getting re-minted unless explicitly suppressed.
  // KNOWN LIMITATION (not fixed here; separately tracked follow-up): `store.ts`'s `ledgerOf(id)`
  // falls back to the GLOBAL ledger for an id absent from both live projections, and a marker is
  // never in the live projection — so a permanent erase of a PROJECT ledger's planted marker can
  // route to the global ledger instead of the ledger that actually holds it. This hatch only clears
  // the marker when the erase call is routed to the right ledger.
  if ((records.some(isIntegrityMarker) || droppedForgedVerifies > 0) && !opts.erasedIds.has('integrity_marker')) {
    kept.push(canonicalMarker('integrity_marker'));
  }
  // Horizon marker (spec §4): same fixpoint treatment, same escape hatch, and the same honest
  // residual/known-limitation notes as the integrity marker above — coalesced, never preserved
  // verbatim, so a planted horizon_* row's hostile bytes cannot be immortalized. Emit one iff an
  // existing marker is present (signal never reverts) OR this compaction drops a closed FACT row (an
  // assert/supersede absent from live — covers supersede/invalidate/erase closers), UNLESS its
  // canonical id has been explicitly erased.
  if ((records.some(isHorizonMarker) || records.some((r) => (r.type === 'assert' || r.type === 'supersede') && !live.has(r.id))) && !opts.erasedIds.has('horizon_marker')) {
    kept.push(canonicalMarker('horizon_marker'));
  }
  return { kept, droppedForgedVerifies };
}

/** UTF-8 serialized byte length of a record array as written to the ledger (one JSON line + newline each). */
export function serializedBytes(records: MemoryRecord[]): number {
  let n = 0;
  for (const r of records) n += Buffer.byteLength(JSON.stringify(r)) + 1;
  return n;
}

/** What a compaction ACTUALLY did, measured entirely inside its own lock. Never a projection: a
 *  caller may emit these as past-tense metrics. */
export interface CompactionStats {
  /** Physical rows removed: rows read at lock entry minus rows written. Always >= 0 in practice
   *  (planCompaction keeps a subset of the live projection plus fixed-width markers), and never
   *  attributable to another writer — see the lock argument on compactLedger. */
  droppedRows: number;
  /** On-disk bytes reclaimed: file size at lock entry minus file size after the rename.
   *  LEGITIMATELY NEGATIVE when a compaction drops little or nothing but mints a content-free
   *  horizon/integrity tombstone: the file NET-GREW. That is a truthful report, not an error, so it
   *  is not clamped — a clamp would silently turn "this compaction grew the ledger" into "reclaimed
   *  nothing", hiding exactly the case an operator wants to see. */
  reclaimedBytes: number;
  /** Content-free count of forged verify rows DROPPED by this compaction, measured under the lock.
   *  0 when compaction ran with no HMAC subkey (forged and genuine are then indistinguishable — every
   *  live-target verify is kept). The honest forensic counterpart to the unsigned integrity marker:
   *  the marker's mere PRESENCE is forgeable (anyone can append an `integrity_`-prefixed row), but
   *  this count is derived from the keep-set this same lock just computed and written. It is still
   *  NOT a trustworthy forensic trail on its own — metrics are optional and best-effort (spec:
   *  metrics.ts), so with metrics disabled or the sink failing (e.g. disk full), only the forgeable
   *  marker survives. */
  droppedForgedVerifies: number;
}

/** Size of `path` in bytes, or 0 if it does not exist (parseLedger treats a missing ledger as []). */
function fileSize(path: LedgerPath): number {
  try { return statSync(path).size; } catch { return 0; }
}

/**
 * Rewrite the ledger to the canonical current state. Crash-safe: writes <path>.tmp,
 * fsyncs, then atomically renames over <path>.
 *
 * Output = the live projection (superseded/invalidated/erased targets already excluded,
 * verify states applied) MINUS any `erasedIds`, PLUS one content-free tombstone per erase
 * marker (so an erasure leaves an audit trace but no plaintext — satisfies right-to-erasure).
 *
 * Returns what it actually did. BOTH numbers are measured INSIDE the lock — `beforeBytes` before
 * `parseLedger`, `afterBytes` after `renameSync` — so they are attributable to exactly THIS
 * compaction: every appender goes through appendRecord, which takes the SAME lock, so no writer can
 * slip a row in between the two measurements. Measuring `beforeBytes` outside the lock would silently
 * fold a concurrent cross-process append's bytes into this compaction's reclaim (and could report a
 * negative reclaim for a compaction that in fact freed space). No unit test can catch that inversion —
 * it needs a real concurrent appender — so the invariant lives here, in the code that must hold it.
 */
export function compactLedger(path: LedgerPath, opts: CompactOptions): CompactionStats {
  // Hold the lock across read -> rewrite -> rename so a concurrent append can't be lost and a
  // stale snapshot can't resurrect erased content. parseLedger runs INSIDE the lock, so we
  // always compact the latest committed state.
  return withFileLock(path, () => {
    const beforeBytes = fileSize(path);   // inside the lock, BEFORE the read (see above)
    const records = parseLedger(path);
    const { kept, droppedForgedVerifies } = planCompaction(records, opts);
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
    return { droppedRows: records.length - kept.length, reclaimedBytes: beforeBytes - fileSize(path), droppedForgedVerifies };
  });
}
