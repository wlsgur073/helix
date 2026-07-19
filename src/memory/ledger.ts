import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import type { MemoryRecord } from '../types.js';
import { buildProjection } from './projection.js';
import { withFileLock, canonical } from './lock.js';
import { realFsOps, writeAll, type DurableFsOps } from './fs-ops.js';
import { sweepOrphanTmps } from './ledger-sweep.js';
import { fenceId, sha256Hex } from './witness-core.js';
import { planTransition, openTransition, completeTransition, classifyState, readScopeWitness, WitnessBlockedError } from './witness-store.js';

export type LedgerPath = string;

/** Fixed sentinel timestamp for the coalesced, unsigned advisory markers. They carry NO honest time
 *  (an unsigned boolean has no chronology), so a CONSTANT makes them byte-identical across compactions
 *  and denies an adversary any preserved bytes. */
const MARKER_SENTINEL_TX = '1970-01-01T00:00:00.000Z';

/** A verify-shaped, unsigned, content-free tombstone with a null target. Both marker kinds share this
 *  shape; the id PREFIX distinguishes them. Predicates are TOTAL (typeof-guarded) so a malformed row
 *  that slipped a parse boundary can never throw here. */
export const isMarkerShape = (r: MemoryRecord): boolean =>
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

/** A content-free epoch fence: the marker-shaped final row of every ledger rewrite (spec §4.9,
 *  witness feature). Unlike canonicalMarker's fixed-id fixpoints, a fence carries its OWN real
 *  transition `tx` (never MARKER_SENTINEL_TX — the fence's chronology IS meaningful: it anchors
 *  which epoch a rewrite belongs to) and a random per-mint nonce (fenceId), so its bytes are
 *  unpredictable and a restored old-era file can never be a byte-prefix of a new one. It is
 *  marker-shaped (isMarkerShape: verify-typed, null target, no mac) so it is excluded from every
 *  live projection with ZERO read-path changes — the same structural exclusion the horizon/
 *  integrity markers already rely on (buildProjection never surfaces a `verify`-typed row as a
 *  fact, regardless of id). Never minted here — planCompaction stays pure; minting a fresh fence
 *  per rewrite is the caller's job (a later task's compactLedger integration). */
export function witnessFenceRecord(epoch: number, nonce: string, tx: string): MemoryRecord {
  return {
    id: fenceId(epoch, nonce), tx, validFrom: tx, validTo: null,
    type: 'verify', state: 'Suspect', content: '',
    provenance: { source: 'user', sessionId: 'witness' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  };
}

/** Append one record as a single JSONL line WITHOUT taking the ledger lock — for callers that
 *  ALREADY hold it (withFileLock is not re-entrant), e.g. the store's signing writeVerify.
 *  Durable + self-repairing (spec Layer 5): sweeps orphan tmps (the fence — a sweep failure ABORTS
 *  the append: an unfenceable predecessor must block us), refuses hard-linked ledgers (two alias
 *  names would carry two locks — no mutual exclusion), repairs a newline-less torn tail by
 *  prefixing its own separator (at-least-once: a complete-but-unacked prior record commits; a torn
 *  fragment is isolated into its own malformed line that parse-health counts), then writes the
 *  whole line, fsyncs the fd, and fsyncs the parent dir so an acknowledged append survives power
 *  loss. */
export function appendRecordUnlocked(rawPath: LedgerPath, record: MemoryRecord, fsOps: DurableFsOps = realFsOps): void {
  mkdirSync(dirname(rawPath), { recursive: true });
  const path = canonical(rawPath);   // resolve the FINAL-component symlink to the real inode's path (write-layer identity, the SAME rule the lock uses) so append and compaction never diverge onto different inodes
  sweepOrphanTmps(path, { fsOps });
  const fd = fsOps.openSync(path, 'a+');
  try {
    const st = fsOps.fstatSync(fd);
    if (st.nlink !== 1) throw new Error(`appendRecord: ledger has ${st.nlink} hard links — aliased ledgers are unsupported (see SECURITY.md); refusing to write`);
    let line = JSON.stringify(record) + '\n';
    if (st.size > 0) {
      const tail = Buffer.alloc(1);
      fsOps.readSync(fd, tail, 0, 1, st.size - 1);
      if (tail[0] !== 0x0a) line = '\n' + line;   // tail repair: separator + record share one write+fsync
    }
    writeAll(fsOps, fd, line);
    fsOps.fsyncSync(fd);
  } finally {
    fsOps.closeSync(fd);
  }
  fsOps.fsyncDir(dirname(path));
}

/** Locked append (see appendRecordUnlocked for the write contract). Parent dir is created BEFORE
 *  the lock: the lock artifact lives next to the ledger, whose directory must exist. */
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
    // Push ONLY object/array children: a primitive contributes nothing to depth, and pushing every
    // element of a huge flat array would hold O(width) wrappers live on the stack — a wide-but-shallow
    // line (e.g. a 20M-element array) would then OOM the guard itself (the very crash it exists to
    // prevent). Skipping primitives keeps the traversal O(depth), not O(width).
    for (const child of Array.isArray(cur) ? cur : Object.values(cur as Record<string, unknown>)) {
      if (child !== null && typeof child === 'object') stack.push({ v: child, d: d + 1 });
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

/** Read the ledger's raw bytes ONLY — no parse. For a caller whose pre-parse phase needs nothing but
 *  bytes (e.g. MemoryStore.recallInput's cache-key digest + subkey fingerprint, computed BEFORE the
 *  cache-hit check), this pays a read cost but a ZERO parse cost — a cache HIT never reaches a parse
 *  at all. The caller re-decodes these SAME bytes only if the key check turns out to be a MISS (Fix
 *  loop 1: restores the A4 cache's original zero-parse-on-HIT invariant, which readLedgerRaw's
 *  eager-parse-every-call composition had traded away). Same ENOENT convention as parseLedger/
 *  readLedgerRaw below: missing file -> an empty buffer, never a throw. */
export function readLedgerBytes(path: LedgerPath): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
    throw err;
  }
}

/** Read the ledger's raw bytes ONCE and parse them (parseLedgerHealth) — the single seam every
 *  grade-assigning reader converges on (witness feature, spec §4). Byte-hashing (the witness's
 *  prefix-hash) is only sound over the EXACT raw bytes, never a re-encoded string, so a caller that
 *  needs both records and a byte-faithful hash must get them from ONE read: calling parseLedger
 *  (which decodes internally and never exposes the bytes) or hand-rolling a second readFileSync risks
 *  hashing bytes that differ from the ones that were actually parsed. Missing file -> the same empty
 *  convention parseLedger uses, spelled out over both return channels. Deliberately NOT rewritten in
 *  terms of parseLedger (or vice versa): parseLedger stays untouched for its existing callers. Used
 *  where a caller genuinely wants records unconditionally (historyView/asOfView/verifiedLiveStats —
 *  not a cache-gated path, so there is no HIT to keep parse-free). recallInput is NOT one of these
 *  sites (Fix loop 1) — see readLedgerBytes above. */
export function readLedgerRaw(path: LedgerPath): { bytes: Buffer; records: MemoryRecord[]; skippedNonBlank: number } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: Buffer.alloc(0), records: [], skippedNonBlank: 0 };
    throw err;
  }
  const { records, skippedNonBlank } = parseLedgerHealth(bytes.toString('utf8'));
  return { bytes, records, skippedNonBlank };
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
  /** Injectable durable-fs seam: tests assert the fsync TARGET/ORDER and simulate write failures
   *  (ENOSPC, an unremovable orphan). Production omits it => `realFsOps`. */
  fsOps?: DurableFsOps;
  /** Witness integration (spec §4.9). When present, this rewrite plants a fresh epoch fence as its
   *  final row and drives the witness transition INSIDE the existing ledger lock: planTransition ->
   *  openTransition (journal durable BEFORE the file changes) -> write+rename -> completeTransition
   *  (after the new bytes land). So a crash before the rename is diagnosable as transition-interrupted
   *  (re-drive supersedes it) and a crash after it heals to the new bytes. `now` sources the fence's
   *  own transition tx; `kind` defaults to 'compaction' (the erase path passes 'erase'). Omitted =>
   *  an un-witnessed rewrite (unchanged legacy behavior — used by direct-compaction unit tests). */
  witness?: { home: string; scopeKey: string; now: () => string; kind?: 'compaction' | 'erase' };
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
  // FIXED (was a known limitation): `store.ts`'s erase now routes through `resolveEraseTarget`,
  // which is scope-aware and never falls back to the global ledger for an id it didn't find there —
  // an explicit `scope: 'project'` (or C10's family-prefix presence check for a marker id) resolves
  // to the ledger that actually holds it. This hatch clears the marker as long as the erase call
  // carries the right scope; residual (F5, still true): the marker's PRESENCE is forgeable by
  // anyone who can append an `integrity_`-prefixed row, real incident or not — only its clearing is
  // now correctly routed.
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
  // Epoch fence (spec §4.9, witness feature): each rewrite ends with its OWN fresh fence, minted
  // by the CALLER (a later task's compactLedger integration) — never here, so this function stays
  // pure. A stale `witness_fence_*` row is therefore simply reclaimable, unlike the integrity/
  // horizon fixpoints above (which persist forever once triggered): it is never re-minted, and it
  // cannot reach `kept` via any path above it either — it is `type: 'verify'` so buildProjection
  // never puts it in `live`, it is not `type: 'erase'`, and its null `supersedes` short-circuits
  // the HMAC-aware verify-preserve loop before `keepValidVerify` is ever consulted. The drop is
  // made EXPLICIT here too regardless, so it does not silently depend on the incidental
  // interaction of those two unrelated guards elsewhere in this function.
  const withoutStaleFences = kept.filter((r) => !r.id.startsWith('witness_fence_'));
  return { kept: withoutStaleFences, droppedForgedVerifies };
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
 * Rewrite the ledger to the canonical current state. Crash-safe + self-fencing: writes
 * `<path>.c-<hex32>.tmp` (created BEFORE the read so a successor's sweep can fence a lost-lock
 * compactor — see the fence note in the body), fsyncs the tmp, atomically renames over <path>, then
 * fsyncs the parent dir. The lock is HELD through the final dir fsync.
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
export function compactLedger(rawPath: LedgerPath, opts: CompactOptions): CompactionStats {
  const fsOps = opts.fsOps ?? realFsOps;
  // Hold the lock across read -> rewrite -> rename -> dir fsync so a concurrent append can't be
  // lost and a stale snapshot can't resurrect erased content. The tmp is created BEFORE the read
  // (fence sentinel): any successor's sweep unlinks it, so if OUR lock is ever lost, the final
  // rename-by-pathname fails ENOENT instead of overwriting the successor's state.
  return withFileLock(rawPath, (ctx) => {                   // lock target stays raw — withFileLock canonicalizes internally to the same lock file
    const path = canonical(rawPath);                        // resolve ONCE, under the lock: EVERYTHING below (nlink, tmp, sweep, mode, read, rename, dir fsync) targets the real inode, so a compaction can never replace a symlink alias and strand the erased plaintext on the link's target
    assertSingleLink(path);
    const tmp = `${path}.c-${randomBytes(16).toString('hex')}.tmp`;
    sweepOrphanTmps(path, { fsOps, keep: tmp });
    const fd = fsOps.openSync(tmp, 'wx');
    let closed = false;
    try {
      if (!ctx.stillOwned()) throw new Error('compactLedger: lock lost after tmp creation');
      const mode = modeOf(path);
      if (mode !== null) fsOps.fchmodSync(fd, mode);              // umask-proof: rename replaces the inode
      const beforeBytes = fileSize(path);                          // inside the lock, BEFORE the read
      const records = parseLedger(path);
      const { kept, droppedForgedVerifies } = planCompaction(records, opts);
      // Witness integration (spec §4.9), ALL inside this existing ledger lock — planTransition/
      // openTransition/completeTransition each take the WITNESS lock (a different path, so nesting is
      // safe), never a second ledger lock. Ordering resolution: mint epoch+nonce (planTransition) ->
      // build the fence and the EXACT final bytes -> journal (openTransition) BEFORE the file is
      // written -> write+rename -> completeTransition AFTER the new bytes are durable.
      const w = opts.witness;
      let rows = kept;
      let fenceTx: string | null = null;
      if (w) {
        const kind = w.kind ?? 'compaction';
        // Anti-laundering gate (spec §4.2 PR-1, SECURITY.md "the very next ordinary append after a
        // rollback can never silently launder the alarm away"): a witnessed REWRITE must never advance
        // the witness over a MISMATCH. Advancing onto forked / rolled-back content would bless it into a
        // fresh epoch and silently retire the rollback alarm, permanently re-serving forged Verified
        // grades. Classify the CURRENT on-disk bytes — re-read here under THIS ledger lock, which
        // serializes every witness advance for the scope, so the witness snapshot is stable and the
        // concurrent-reader retry (witness-read.ts §7) does not apply — against the scope witness BEFORE
        // minting the transition. Refuse 'mismatch' ONLY: 'transition-interrupted' stays ALLOWED — it is
        // the legitimate re-drive / journal-supersession path (crash window A) — as do in-sync /
        // unwitnessed-suffix / first-contact / transition-heal (advanceAllowed + the transition
        // verdicts). A naive `!advanceAllowed(v)` would wrongly refuse the interrupted re-drive. The
        // throw lands inside the try below, whose catch closes+unlinks the tmp and rethrows, so the
        // ledger is left byte-identical and no journal is opened — the witness is wholly untouched.
        const verdict = classifyState(readScopeWitness(w.home, w.scopeKey), readLedgerBytes(path));
        if (verdict.kind === 'mismatch') {
          const op = kind === 'erase' ? ('permanent-erase' as const) : ('compaction' as const);
          throw new WitnessBlockedError(
            op,
            `${op}: scope '${w.scopeKey}' is in a MISMATCH (rollback-alarm) state — refusing the rewrite; advancing the witness over forked/rolled-back content would launder the alarm (spec §4.2). Re-baseline the scope (helix-rebaseline) to adopt the current bytes, then retry.`,
          );
        }
        const plan = planTransition(w.home, w.scopeKey, kind);
        const fence = witnessFenceRecord(plan.epoch, plan.nonce, w.now());   // the fence's own real tx
        rows = kept.concat(fence);                                           // fence is the LAST row
        fenceTx = fence.tx;
        // `expected` MUST be computed over byte-identical serialization to what the tmp write below
        // produces (per-row `JSON.stringify(r) + '\n'`, fence last) — completeTransition's exact-bytes
        // assert (below) doubles as a serialization-drift guard if these ever diverge.
        const finalText = rows.map((r) => JSON.stringify(r) + '\n').join('');
        const expected = { byteLength: Buffer.byteLength(finalText), prefixHash: sha256Hex(Buffer.from(finalText)) };
        openTransition(w.home, w.scopeKey, {
          kind, epoch: plan.epoch, nonce: plan.nonce, predecessor: plan.predecessor,
          supersedes: plan.supersedes, expected, tx: fenceTx,
        });
      }
      for (const r of rows) writeAll(fsOps, fd, JSON.stringify(r) + '\n');
      fsOps.fsyncSync(fd);
      fsOps.closeSync(fd);
      closed = true;
      assertSingleLink(path);                                      // re-check immediately before the rename
      if (!ctx.stillOwned()) throw new Error('compactLedger: lock lost before rename');
      fsOps.renameSync(tmp, path);                                 // atomic on the same filesystem
      fsOps.fsyncDir(dirname(path));                               // rename gives visibility, not durability
      if (w && fenceTx !== null) {
        // New bytes are durable; complete the transition (still under the ledger lock). re-read the
        // exact on-disk bytes and hand them to completeTransition — its expected-equality check is the
        // serialization-drift guard: finalBytes MUST equal the finalText that produced `expected`.
        completeTransition(w.home, w.scopeKey, readLedgerBytes(path), fenceTx);
      }
      // droppedRows/reclaimedBytes are PHYSICAL (rows read minus rows WRITTEN, file size delta): the
      // fence is one of the rows written, so it reduces droppedRows and its bytes count against
      // reclaimedBytes — symmetric with the horizon/integrity markers planCompaction already folds
      // into `kept`, and honoring CompactionStats' "rows read at lock entry minus rows written".
      return { droppedRows: records.length - rows.length, reclaimedBytes: beforeBytes - fileSize(path), droppedForgedVerifies };
    } catch (e) {
      if (!closed) { try { fsOps.closeSync(fd); } catch { /* already closed by a throwing close */ } }
      try { fsOps.unlinkSync(tmp); } catch { /* a successor's sweep may have taken it */ }
      throw e;
    }
  });
}

/** Missing ledger counts as a single link (first-write paths stay legal). */
function assertSingleLink(path: LedgerPath): void {
  let nlink: number;
  try { nlink = statSync(path).nlink; } catch { return; }
  if (nlink !== 1) throw new Error(`compactLedger: ledger has ${nlink} hard links — aliased ledgers are unsupported (see SECURITY.md); refusing to rewrite`);
}

/** Permission bits of the current ledger, or null when it does not exist yet. */
function modeOf(path: LedgerPath): number | null {
  try { return statSync(path).mode & 0o777; } catch { return null; }
}
