import type { MemoryRecord } from '../types.js';
import { isKnownState } from './verified-projection.js';
import { isAcceptedMacVersion, isFutureMacVersion, keyIdOf, verifyVerify } from './ledger-mac.js';

/** A content-free audit marker — the compaction horizon marker (ledger.ts:30) or the integrity
 *  tombstone (ledger.ts:37): a verify-shaped record with a null target, no MAC, empty content, and
 *  state Suspect. It is inert in every replay (a null-target verify elevates nothing —
 *  verified-projection.ts:181), so it is NOT a forged elevation and must not be reported. */
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
      if ((!verify(r) || !isKnownState(r.state)) && !isContentFreeMarker(r)) offenders.push(r.id); // MAC-valid but non-enum state: replay ignores it, so surface it (C9)
    } else if ((r.type === 'assert' || r.type === 'supersede') && r.state !== 'Fresh') {
      offenders.push(r.id); // baked content elevation R1 would clamp to Fresh — not tool-minted
    }
  }
  return { ok: offenders.length === 0, offenders };
}

export interface LegacyOffenderClasses {
  /** A baked non-Fresh assert/supersede, or a verify carrying no `mac` or no `keyId`, or whose
   *  `macVersion` is neither accepted nor a future version: absent or not a number (ruling R8: no build
   *  ever wrote that beside a mac), or a number no Helix writes — 0, negative, fractional, beyond the
   *  safe-integer range (plan refinement P2). */
  forged: string[];
  /** IT-M15: a verify carrying this scope's CURRENT keyId whose MAC fails — altered after signing. */
  tampered: string[];
  /** IT-M15: a verify signed under a DIFFERENT keyId — a nonce rotated by `--fresh`, a master lost and
   *  re-minted, or a forgery; the row alone cannot say which (keyId hashes master and nonce together). */
  otherKey: string[];
  /** IT-M15: a verify whose `macVersion` is a FUTURE version (isFutureMacVersion: a safe integer above
   *  MAC_VERSION, the rows compaction keeps for a newer binary), or whose MAC checks but whose state is
   *  not one this build knows — likely written by a newer version, or forged (the version field is not
   *  MAC-covered, so a forger can set any number). */
  newerVersion: string[];
  /** No subkey resolved for the scope: a verify-typed offender whose verdict was decided by key
   *  availability alone. */
  unverifiable: string[];
}

/** IT-M15 (D3): WHY a verify offender failed, read from the fields the MAC check itself dispatches on,
 *  in verifyVerify's own order. Nothing here is authenticated beyond what verifyVerify authenticates:
 *  the split only chooses the SENTENCE (and WARNING vs NOTE); every class is still an offender whose
 *  grade the replay never applies.
 *
 *  Ruling R8 with plan refinement P2: `macVersion` is not MAC-covered, so a forger can set it. Only a
 *  FUTURE version moves a row to the newer-version NOTE, which names forgery — isFutureMacVersion, the
 *  predicate compaction's keep rule (store.ts keepValidVerifyFor) uses, so a row that reads as newer for
 *  its version is one that rule keeps (the class's other member, a MAC-valid row with an unknown state,
 *  is not). An absent or non-numeric value, and a number no Helix writes (0, negative, fractional,
 *  beyond the safe-integer range), are forged/legacy: signVerify has stamped MAC_VERSION since the first
 *  signing commit (measured when R8 was ruled: a current-key forgery with a garbage MAC was `tampered`
 *  at macVersion 2 but `newerVersion` with the field deleted or set to "2"). */
function classifyVerifyOffender(r: MemoryRecord, subkey: Buffer): 'forged' | 'tampered' | 'otherKey' | 'newerVersion' {
  if (!r.mac || !r.keyId) return 'forged';
  if (isFutureMacVersion(r.macVersion)) return 'newerVersion';
  if (!isAcceptedMacVersion(r.macVersion)) return 'forged';
  if (r.keyId !== keyIdOf(subkey)) return 'otherKey';
  // Current keyId: a MAC that checks means the row is an offender only for its state (C9), which is a
  // format question; a MAC that fails under the key it names was altered after signing.
  if (verifyVerify(r, subkey) && !isKnownState(r.state)) return 'newerVersion';
  return 'tampered';
}

/**
 * Split a scan's offenders by what the evidence actually supports, so the caller can say each cause
 * accurately instead of naming one and printing both.
 *
 * The validity predicate every caller passes is `(r) => subkey ? verifyVerify(r, subkey) : false`.
 * When no subkey resolves — key lost, HELIX_HOME moved, an adopted ledger — it answers false for
 * every record, so EVERY `verify` becomes an offender no matter how correctly it was signed. That
 * outcome is right for `assessGradeLoss`, whose question is "would starting here lose a grade?"
 * (it would: a fresh nonce would be minted that none of them were signed under). It is wrong for the
 * startup advisory, whose sentence accuses the ledger of forgery — on the sole evidence that a key
 * was unavailable.
 *
 * The split is not "everything is excused when the key is gone". A baked non-Fresh `assert`/
 * `supersede` is a real legacy elevation that R1 would clamp regardless of any key, so it stays in
 * `forged` either way. Only the verify-typed offenders — the ones whose verdict was decided ENTIRELY
 * by key availability — move to `unverifiable`.
 *
 * IT-M15 (second fix batch, D3): with the key's bytes handed over, a verify offender is split further
 * by the fields verifyVerify dispatches on — no mac/keyId, or a macVersion that is neither accepted nor
 * a future version (forged/legacy, R8 and P2), a future macVersion or a state this build does not accept
 * (newerVersion), a different keyId (otherKey: `--fresh`, a re-minted master, or a forgery), or the
 * current keyId with a failing MAC (tampered). Before this split every one of them was printed as
 * forged/legacy, so a documented `--fresh` or key re-mint accused the ledger of forgery at every start,
 * and compaction keeps those rows while their facts live.
 */
export function classifyLegacyOffenders(
  records: MemoryRecord[],
  offenders: string[],
  keyResolved: boolean,
  subkey?: Buffer | null,
): LegacyOffenderClasses {
  const out: LegacyOffenderClasses = { forged: [], tampered: [], otherKey: [], newerVersion: [], unverifiable: [] };
  const key = keyResolved ? (subkey ?? null) : null;
  if (keyResolved && !key) {
    // A caller that states a key resolved but does not hand over its bytes cannot have the verify
    // offenders split by key id: the pre-IT-M15 reading, every offender forged/legacy.
    out.forged.push(...offenders);
    return out;
  }
  // Walk the records in ledger order and match each offender id to the record it came from, so two
  // rows sharing one id (a genuine verify and a forged copy) are each classified on their own fields.
  // The scan pushes offender ids in record order, and the rule below is the scan's own rule under the
  // same predicate, so the i-th offender record is the i-th offender id. Anything left unmatched (a
  // caller whose scan used a different predicate) falls back to forged/legacy. The rule must move
  // together with scanLegacyElevated's.
  let i = 0;
  const isOffender = (r: MemoryRecord): boolean => {
    if (r.type === 'verify') {
      const valid = key ? verifyVerify(r, key) : false;
      return (!valid || !isKnownState(r.state)) && !isContentFreeMarker(r);
    }
    return (r.type === 'assert' || r.type === 'supersede') && r.state !== 'Fresh';
  };
  for (const r of records) {
    if (i >= offenders.length) break;
    if (r.id !== offenders[i] || !isOffender(r)) continue;
    i++;
    if (r.type !== 'verify') { out.forged.push(r.id); continue; }
    if (!key) { out.unverifiable.push(r.id); continue; }
    out[classifyVerifyOffender(r, key)].push(r.id);
  }
  for (; i < offenders.length; i++) out.forged.push(offenders[i]!);
  return out;
}
