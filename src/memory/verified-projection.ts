import type { MemoryRecord, AsOfVerify, MemoryState } from '../types.js';
import { buildProjection } from './projection.js';
import { digestContent } from './ledger-mac.js';
import { isIsoInstant } from './history.js';
import type { WitnessVerdict } from './witness-core.js';

export interface VerifiedProjection {
  live: Map<string, MemoryRecord>;
  compromised: Set<string>;
  keyAvailable: boolean;
}

/** D1 authority rule: an elevated live grade (Verified/Corroborated) drops to Fresh; Fresh/Suspect
 *  are untouched. The single "the witness cannot vouch for this elevation" state map — shared by the
 *  projection-level clampElevated (P1) and the recall path's scoped-record clamp (P2). */
export function clampElevatedState(s: MemoryState): MemoryState {
  return s === 'Verified' || s === 'Corroborated' ? 'Fresh' : s;
}

/** New projection with every elevated live grade clamped to Fresh (D1). Suspect untouched;
 *  compromised/keyAvailable carried through unchanged. A POST-projection transform — the verifying
 *  replay already ran; this is the rollback-witness authority overlaid on a `mismatch`. */
export function clampElevated(p: VerifiedProjection): VerifiedProjection {
  const live = new Map<string, MemoryRecord>();
  for (const [id, rec] of p.live) {
    const state = clampElevatedState(rec.state);
    live.set(id, state === rec.state ? rec : { ...rec, state });
  }
  return { live, compromised: p.compromised, keyAvailable: p.keyAvailable };
}

/** Read-side witness enforcement over a verified projection (spec §4). `mismatch` clamps elevated
 *  grades to Fresh (D1; D1b — rows are still served); `transition-interrupted` excludes the whole
 *  scope (empty live map + no compromised flags); every other verdict passes through untouched.
 *  keyAvailable (the master-key signal) is orthogonal to the witness and always carried. asOf uses a
 *  facts-level rule (exclude only, never clamp), so this projection helper is P1/P2-live only. */
export function enforceWitnessProjection(p: VerifiedProjection, verdict: WitnessVerdict): VerifiedProjection {
  if (verdict.kind === 'transition-interrupted') return { live: new Map(), compromised: new Set(), keyAvailable: p.keyAvailable };
  if (verdict.kind === 'mismatch') return clampElevated(p);
  return p;
}

const isPromotion = (s: MemoryRecord['state']): boolean => s === 'Verified' || s === 'Corroborated';

// Ascending trust order; cross-version collisions resolve to the LOWER rank (fail-low, spec §4.5). A
// projection-local constant — the display layer's STATE_ORDER (format-context.ts) is the same total
// order written most-trusted-first, but the hook module is not importable from the memory layer.
const TRUST_RANK: Record<MemoryRecord['state'], number> = { Suspect: 0, Fresh: 1, Corroborated: 2, Verified: 3 };

const KNOWN_STATES = new Set<MemoryRecord['state']>(['Fresh', 'Corroborated', 'Verified', 'Suspect']);
/** True only for a real MemoryState string. A verify carrying anything else (a MAC-valid array-like
 *  object whose bytes render to an enum name, an unknown future string) must not confer a grade or be
 *  interpolated/property-keyed downstream (D1). Trust-layer check — NOT the parse guard (an enum check
 *  at parse would drop a future state enum). */
export function isKnownState(s: unknown): s is MemoryRecord['state'] {
  return typeof s === 'string' && KNOWN_STATES.has(s as MemoryRecord['state']);
}

/** Resolve ONE target's grade from its VALID verifies (caller pre-filters via the verify predicate)
 *  + the live content digest, emitting the full evidence. The single source of the lane-aware fail-low
 *  grade rule (spec A §4.5): buildVerifiedProjection uses {grade,compromised}; buildAsOfEvidence also
 *  keeps {evidence}. txAuthenticated is computable here without a subkey because inputs are already
 *  valid, so isVerifyTxAuthenticated reduces to (v2 AND canonical instant). */
export function resolveTargetGrade(
  verifies: MemoryRecord[],
  liveDigest: string,
): { grade: MemoryRecord['state'] | null; compromised: boolean; evidence: AsOfVerify[] } {
  const laneOf = (v: MemoryRecord): 0 | 1 | 2 => (v.macVersion === 1 ? 1 : v.macVersion === 2 ? 2 : 0);
  const canonGen = (g: MemoryRecord['gen']): bigint => BigInt((g ?? 0) as number); // exact 64-bit match to the MAC's int(gen ?? 0); inputs are verify-filtered so this cannot throw
  const byGen = new Map<bigint, MemoryRecord[]>();
  for (const v of verifies) { const g = canonGen(v.gen); (byGen.get(g) ?? byGen.set(g, []).get(g)!).push(v); }
  let conflict = false;
  const active: MemoryRecord[] = [];
  for (const slot of byGen.values()) {
    const lanes = new Map<number, MemoryRecord[]>();
    for (const v of slot) (lanes.get(laneOf(v)) ?? lanes.set(laneOf(v), []).get(laneOf(v))!).push(v);
    for (const members of lanes.values()) { // L1: within-lane tamper evidence (state OR digest)
      const s0 = members[0]!.state, d0 = members[0]!.targetDigest ?? null;
      if (members.some((m) => m.state !== s0 || (m.targetDigest ?? null) !== d0)) { conflict = true; break; }
    }
    if (conflict) break;
    const l1 = lanes.get(1), l2 = lanes.get(2);
    const r1 = l1?.[0], r2 = l2?.[0];
    if (r1 && r2 && r1.state !== r2.state) { // L2: cross-lane fail-low -> keep the lower-rank lane
      active.push(...(TRUST_RANK[r1.state] <= TRUST_RANK[r2.state] ? l1! : l2!));
      if (lanes.has(0)) active.push(...lanes.get(0)!);
    } else {
      active.push(...slot); // L3
    }
  }
  const toEvidence = (v: MemoryRecord, winner: boolean): AsOfVerify => ({
    gen: v.gen ?? 0, state: v.state, tx: v.tx, macVersion: v.macVersion ?? 0,
    txAuthenticated: v.macVersion === 2 && typeof v.tx === 'string' && isIsoInstant(v.tx),
    applicable: !isPromotion(v.state) || v.targetDigest === liveDigest,
    winner, lane: laneOf(v),
  });
  if (conflict) return { grade: null, compromised: true, evidence: verifies.map((v) => toEvidence(v, false)) };
  const sorted = [...active].sort((a, b) => { const ga = canonGen(a.gen), gb = canonGen(b.gen); return ga < gb ? -1 : ga > gb ? 1 : 0; });
  let winner: MemoryRecord | null = null;
  for (const v of sorted) { if (!isPromotion(v.state) || v.targetDigest === liveDigest) winner = v; }
  return { grade: winner ? winner.state : null, compromised: false, evidence: verifies.map((v) => toEvidence(v, v === winner)) };
}

export function buildVerifiedProjection(
  records: MemoryRecord[],
  opts: { verify: (r: MemoryRecord) => boolean; keyAvailable: boolean },
): VerifiedProjection {
  // Base content/identity view: project non-verify records and CLAMP every state to Fresh (R1).
  // buildProjection already drops superseded/erased ids and keeps the live content records.
  const nonVerify = records.filter((r) => r.type !== 'verify');
  const live = new Map<string, MemoryRecord>();
  for (const [id, rec] of buildProjection(nonVerify)) live.set(id, { ...rec, state: 'Fresh' });

  const compromised = new Set<string>();
  if (!opts.keyAvailable) return { live, compromised, keyAvailable: false };

  // Group valid verifies by target, choose the winning grade by generation (R2/R3).
  const byTarget = new Map<string, MemoryRecord[]>();
  for (const r of records) {
    if (r.type !== 'verify' || !r.supersedes || !opts.verify(r) || !isKnownState(r.state)) continue; // R2 + D1 enum gate
    (byTarget.get(r.supersedes) ?? byTarget.set(r.supersedes, []).get(r.supersedes)!).push(r);
  }

  for (const [target, verifies] of byTarget) {
    const item = live.get(target);
    if (!item) continue; // target not live (superseded/erased) — nothing to elevate
    const { grade, compromised: c } = resolveTargetGrade(verifies, digestContent(item.content));
    if (c) { compromised.add(target); continue; } // stays Fresh (already clamped in `live`)
    if (grade) live.set(target, { ...item, state: grade });
  }
  return { live, compromised, keyAvailable: true };
}
