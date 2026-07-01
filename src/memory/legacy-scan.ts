import type { MemoryRecord } from '../types.js';

/** A content-free audit marker — the compaction horizon marker (ledger.ts:141) or the integrity
 *  tombstone (ledger.ts:124): a verify-shaped record with a null target, no MAC, empty content, and
 *  state Suspect. It is inert in every replay (a null-target verify elevates nothing —
 *  verified-projection.ts:29), so it is NOT a forged elevation and must not be reported. */
const isContentFreeMarker = (r: MemoryRecord): boolean =>
  r.type === 'verify' && r.supersedes === null && !r.mac && r.content === '' && r.state === 'Suspect';

/**
 * Verifying integrity scan (spec §7). Surfaces records whose persisted trust the verifying replay
 * (R1 clamp / R2 MAC gate) would NOT honour — i.e. a genuinely legacy or forged elevation an operator
 * should know about, without false-positiving on the trust-ladder's own legitimate output.
 *
 * Pre-trust-ladder this could assume "any `verify` or any state above Fresh is bogus" because
 * store.verify was unwired. That premise is now FALSE: every confirm/recheck appends a genuine SIGNED
 * `verify`, and HMAC-aware compaction deliberately preserves them. So the scan MUST verify, not bake.
 *
 * `verify` is the SAME validity predicate verifiedLive/buildVerifiedProjection use
 * (`(r) => subkey ? verifyVerify(r, subkey) : false`). Offenders are ONLY:
 *   - a `verify` record whose MAC FAILS the predicate (forged / legacy-unsigned / edited elevation),
 *     EXCEPT a content-free audit marker (`isContentFreeMarker` — horizon / integrity tombstone),
 *     which is inert (null target elevates nothing) and legitimately unsigned,
 *   - an `assert`/`supersede` whose persisted `state` is not Fresh (R1 would clamp it to Fresh, so a
 *     baked non-Fresh content state is a real legacy/forged elevation).
 * A genuine signed verify (valid MAC) is never reported. Erase/invalidate tombstones are excluded:
 * they are not live content and `erase` legitimately carries state:'Suspect' (store.erase), so a
 * type-blind state check would warn on every real erase. Output stays content-free (record ids only).
 */
export function scanLegacyElevated(
  records: MemoryRecord[],
  verify: (r: MemoryRecord) => boolean,
): { ok: boolean; offenders: string[] } {
  const offenders: string[] = [];
  for (const r of records) {
    if (r.type === 'verify') {
      if (!verify(r) && !isContentFreeMarker(r)) offenders.push(r.id); // unsigned/forged/edited elevation the replay would drop (content-free markers excluded — B1)
    } else if ((r.type === 'assert' || r.type === 'supersede') && r.state !== 'Fresh') {
      offenders.push(r.id); // baked content elevation R1 would clamp to Fresh — not tool-minted
    }
  }
  return { ok: offenders.length === 0, offenders };
}
