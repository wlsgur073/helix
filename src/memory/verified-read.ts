// Shared verifying-read helper: the SINGLE source of truth for turning a ledger file into its
// verified live projection. Both the MemoryStore (recall/inspect) and the SessionStart hook route
// through these two functions so the trust grades they show can never drift — a forged or edited
// ledger record replays as Fresh on EVERY read surface, not just the tool surface.
import type { LedgerPath } from './ledger.js';
import { readLedgerRaw } from './ledger.js';
import type { MemoryRecord } from '../types.js';
import { tryReadMaster, deriveSubkey, verifyVerify } from './ledger-mac.js';
import { scopeNonce, globalScopeNonce } from './ownership.js';
import { buildVerifiedProjection, type VerifiedProjection } from './verified-projection.js';

/**
 * Resolve the per-scope HMAC subkey that verifies a ledger's signed `verify` records. Mirrors
 * MemoryStore.subkeyForLedger EXACTLY. Returns null when no master key exists yet OR the scope
 * nonce is unresolvable (e.g. an unowned project) — a null subkey forces the verifying replay into
 * key-absent mode (every state clamps to Fresh).
 *
 * `projectRoot` omitted => the global ledger's home-stored scope nonce; present => that project's
 * home-only macNonce. The master key + nonce registry both live under `home`, which the threat-model
 * adversary (who can write the repo ledger) cannot read.
 */
export function subkeyForScope(home: string, projectRoot?: string): Buffer | null {
  const master = tryReadMaster(home);
  if (!master) return null;
  const nonce = projectRoot ? scopeNonce(projectRoot, home) : globalScopeNonce(home);
  return nonce ? deriveSubkey(master, nonce) : null;
}

/** The verifying projection over ALREADY-RESOLVED key material (R1 clamp / R2 MAC gate / R3 content
 *  binding). The single source of truth both verifiedLiveOf AND the A4 recall cache route through, so
 *  a resolved-subkey caller and a home+scope caller can never diverge. A null subkey => keyAvailable
 *  false and every state clamps to Fresh (fail-closed). */
export function verifiedProjectionWithSubkey(records: MemoryRecord[], subkey: Buffer | null): VerifiedProjection {
  return buildVerifiedProjection(records, {
    verify: (r) => (subkey ? verifyVerify(r, subkey) : false),
    keyAvailable: subkey !== null,
  });
}

export function verifiedLiveOf(records: MemoryRecord[], home: string, projectRoot?: string): VerifiedProjection {
  return verifiedProjectionWithSubkey(records, subkeyForScope(home, projectRoot));
}

/** Per-read replay decomposition captured by verifiedLiveStats (spec §4). Pure data — the caller
 *  decides whether to emit it (store/hook sinks); library/test callers observe no side effects. */
export interface ReplayStats {
  rows: number;       // parsed record count (tolerant parse — the projection's actual input)
  liveRows: number;   // projection.live.size (future compaction dirty-ratio numerator)
  bytes: number;      // exact length of the raw bytes read (readLedgerRaw) — no separate stat call,
                      // so no stat-vs-read race against a concurrent append; 0 when the file is missing.
  parseMs: number;    // readLedgerRaw body: file read + decode + line split + JSON.parse
  projectMs: number;  // verifiedLiveOf body: subkey resolution + HMAC verifies + projection build
  keyAvailable: boolean;
}

/**
 * verifiedLive plus the replay decomposition. This wrapper is the ONLY place parse and project are
 * timed — callers must never re-compose readLedgerRaw + verifiedLiveOf to measure (the same
 * single-source-of-truth rule verifiedLive exists for). historyView/asOfView compose over one
 * parsed array by design (atomic read) and are deliberately NOT covered (spec §4 documented gaps).
 */
export function verifiedLiveStats(
  ledger: LedgerPath,
  home: string,
  projectRoot?: string,
): { projection: VerifiedProjection; stats: ReplayStats } {
  const t0 = performance.now();
  const { bytes, records } = readLedgerRaw(ledger);   // single raw-read seam (witness feature, W-T4): ENOENT -> bytes.length 0, matching the prior statSync tolerance
  const t1 = performance.now();
  const projection = verifiedLiveOf(records, home, projectRoot);
  const t2 = performance.now();
  return {
    projection,
    stats: {
      rows: records.length,
      liveRows: projection.live.size,
      bytes: bytes.length,
      parseMs: t1 - t0,
      projectMs: t2 - t1,
      keyAvailable: projection.keyAvailable,
    },
  };
}

/**
 * The verifying projection for one ledger PATH — exactly verifiedLiveOf over its parsed records.
 * Mirrors MemoryStore.verifiedOf EXACTLY. This is the shared single-source-of-truth the store read
 * path AND the SessionStart hook both route through, so the trust grades they show can never drift.
 * Thin delegation to verifiedLiveStats — parity-locked by test.
 */
export function verifiedLive(ledger: LedgerPath, home: string, projectRoot?: string): VerifiedProjection {
  return verifiedLiveStats(ledger, home, projectRoot).projection;
}
