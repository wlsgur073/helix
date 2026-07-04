import type { MemoryRecord } from '../types.js';
import { verifyVerify } from './ledger-mac.js';
import { isIsoInstant } from './history.js';
import { subkeyForScope } from './verified-read.js';

/** MAC versions whose `tx` is authenticated (bound into the MAC). v2 added tx-binding; a future
 *  version must opt IN here explicitly — never trust tx via `macVersion >= n`. */
const TX_AUTHENTICATING_VERSIONS = new Set<number>([2]);

/** The single trust-gate for a verify record's system-time `tx`: the MAC is valid, the scheme version
 *  authenticates tx, AND tx is a canonical ISO-8601 instant (a valid MAC over a malformed/injected tx
 *  is NOT authenticated — fail-closed). Consumers that time-travel on tx (e.g. asOf) MUST gate on this,
 *  never on verifyVerify alone: dual-accept keeps v1 (tx-unauthenticated) records valid. NOTE: `tx` is
 *  authenticity (signed-at-mint local-clock bytes), not accuracy — a skewed honest clock passes. */
export function isVerifyTxAuthenticated(record: MemoryRecord, subkey: Buffer): boolean {
  return verifyVerify(record, subkey)
    && typeof record.macVersion === 'number'
    && TX_AUTHENTICATING_VERSIONS.has(record.macVersion)
    && typeof record.tx === 'string'
    && isIsoInstant(record.tx);
}

/** What consumers should actually call: resolves the per-scope subkey exactly like the read paths
 *  (verifiedLive et al.), fail-closed when no key is resolvable. Keeping subkey wiring here — inside
 *  the security boundary — prevents each future consumer from re-deriving it wrong. */
export function isVerifyTxAuthenticatedForScope(record: MemoryRecord, home: string, projectRoot?: string): boolean {
  const sk = subkeyForScope(home, projectRoot);
  return sk ? isVerifyTxAuthenticated(record, sk) : false;
}
