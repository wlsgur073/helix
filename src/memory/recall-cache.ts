// A4 recall cache: content-identity key primitives + the single cached slot's shape.
// The cache is sound against a ledger-write adversary who forges filesystem metadata ONLY because the
// key is a content digest over the exact bytes, plus a fingerprint of the current signing subkey.
import { createHash, createHmac } from 'node:crypto';
import type { ScopedRecord } from '../types.js';
import type { RankArtifacts } from './retrieval.js';

/** One participating scope's cache-key component: ledger content identity + key material + witness
 *  identity. */
export interface ScopeKeyComponent {
  scopeId: string;     // canonical ledger path (I2/I8)
  digest: string;      // SHA256 hex over the exact ledger bytes (I1/I2)
  fingerprint: string; // HMAC over the current subkey, or KEY_ABSENT (I3)
  witness: string;     // the witness entry's own MAC, or 'witness-absent' (W-T7). A re-baseline that
                       // moves the witness WITHOUT changing ledger bytes still forces a rebuild — the
                       // rank cache stays a pure function of (bytes, subkey, witness identity).
}

/** Fingerprint sentinel for "no subkey resolved this call" (no master, or unowned scope). Distinct
 *  from any real HMAC hex, so present<->absent forces a miss. */
export const KEY_ABSENT = 'key-absent';
const FP_LABEL = Buffer.from('helix-recall-cache-fingerprint-v1', 'utf8');

/** SHA256 hex over the raw ledger bytes — the ONLY sound cache validator against an adversary who can
 *  forge mtime/size (spec §3, I2). */
export function ledgerDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Full-width (256-bit) HMAC fingerprint of the CURRENT signing subkey — never the raw key. A null
 *  subkey maps to a fixed sentinel so a present<->absent transition forces a rebuild (I3). */
export function subkeyFingerprint(subkey: Buffer | null): string {
  if (!subkey) return KEY_ABSENT;
  return createHmac('sha256', subkey).update(FP_LABEL).digest('hex');
}

/** Structural equality of two ordered key vectors. A different length (ownership change) or any
 *  differing component forces a rebuild. */
export function keyVectorEqual(a: ScopeKeyComponent[], b: ScopeKeyComponent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.scopeId !== y.scopeId || x.digest !== y.digest || x.fingerprint !== y.fingerprint || x.witness !== y.witness) return false;
  }
  return true;
}

/** The single cached slot (I5): the key it was built under, the scoped verified projection (records +
 *  integrity + availability), and the union rank artifacts. */
export interface RecallCacheEntry {
  key: ScopeKeyComponent[];
  scoped: ScopedRecord[];
  available: boolean;
  artifacts: RankArtifacts;
}
