import type { MemoryRecord } from '../types.js';

/**
 * One-time integrity scan (spec §7). Before the trust-ladder feature, no production ledger should
 * contain a `verify` record or any item above `Fresh` (store.verify was unwired). Any such record
 * is a legacy/forged elevation the operator should know about — pure replay would surface it.
 */
export function scanLegacyElevated(records: MemoryRecord[]): { ok: boolean; offenders: string[] } {
  const offenders: string[] = [];
  for (const r of records) {
    if (r.type === 'verify' || r.state === 'Verified' || r.state === 'Corroborated') offenders.push(r.id);
  }
  return { ok: offenders.length === 0, offenders };
}
