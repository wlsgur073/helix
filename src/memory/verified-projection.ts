import type { MemoryRecord } from '../types.js';
import { buildProjection } from './projection.js';
import { digestContent } from './ledger-mac.js';

export interface VerifiedProjection {
  live: Map<string, MemoryRecord>;
  compromised: Set<string>;
  keyAvailable: boolean;
}

const isPromotion = (s: MemoryRecord['state']): boolean => s === 'Verified' || s === 'Corroborated';

// Ascending trust order; cross-version collisions resolve to the LOWER rank (fail-low, spec §4.5). A
// projection-local constant — the display layer's STATE_ORDER (format-context.ts) is the same total
// order written most-trusted-first, but the hook module is not importable from the memory layer.
const TRUST_RANK: Record<MemoryRecord['state'], number> = { Suspect: 0, Fresh: 1, Corroborated: 2, Verified: 3 };

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
    if (r.type !== 'verify' || !r.supersedes || !opts.verify(r)) continue; // R2: invalid verify ignored
    (byTarget.get(r.supersedes) ?? byTarget.set(r.supersedes, []).get(r.supersedes)!).push(r);
  }

  for (const [target, verifies] of byTarget) {
    const item = live.get(target);
    if (!item) continue; // target not live (superseded/erased) — nothing to elevate

    // Phase 1 (lane-aware, order-independent, fail-closed — spec §4.5). Group this target's valid
    // verifies by gen; within each gen slot, split by MAC-version LANE (v1 vs v2; predicate-injected
    // test records without a numeric macVersion form one 'legacy' lane 0). Lane identity is safe
    // because verifyVerify's numeric whitelist means no VALID record lacks a numeric macVersion.
    //   L1: any WITHIN-lane disagreement on a MAC-covered semantic (state OR coalesced targetDigest) is
    //       two genuine signings of one gen -> tamper evidence -> sticky compromised clamp.
    //   L2: internally-consistent v1 and v2 lanes disagreeing on state -> keep only the LOWER-trust-rank
    //       lane (cross-version fail-low, non-sticky); the collision never elevates and never clamps.
    //   L3: agreeing lanes, or a single populated lane -> today's behavior.
    const laneOf = (v: MemoryRecord): number => (v.macVersion === 1 ? 1 : v.macVersion === 2 ? 2 : 0);
    const byGen = new Map<number, MemoryRecord[]>();
    for (const v of verifies) { const g = v.gen ?? 0; (byGen.get(g) ?? byGen.set(g, []).get(g)!).push(v); }
    let conflict = false;
    const active: MemoryRecord[] = [];
    for (const slot of byGen.values()) {
      const lanes = new Map<number, MemoryRecord[]>();
      for (const v of slot) (lanes.get(laneOf(v)) ?? lanes.set(laneOf(v), []).get(laneOf(v))!).push(v);
      for (const members of lanes.values()) { // L1: within-lane tamper evidence (lane is non-empty by construction)
        const s0 = members[0]!.state, d0 = members[0]!.targetDigest ?? null;
        if (members.some((m) => m.state !== s0 || (m.targetDigest ?? null) !== d0)) { conflict = true; break; }
      }
      if (conflict) break;
      const l1 = lanes.get(1), l2 = lanes.get(2);
      const r1 = l1?.[0], r2 = l2?.[0]; // representative states (each lane is internally consistent past L1)
      if (r1 && r2 && r1.state !== r2.state) { // L2: cross-lane fail-low -> keep the lower-rank lane
        active.push(...(TRUST_RANK[r1.state] <= TRUST_RANK[r2.state] ? l1! : l2!));
        if (lanes.has(0)) active.push(...lanes.get(0)!);
      } else {
        active.push(...slot); // L3: agreement or single lane
      }
    }
    if (conflict) { compromised.add(target); continue; } // stays Fresh (already clamped in `live`)

    // Phase 2: elevate to the highest-gen APPLICABLE grade (R3).
    const liveDigest = digestContent(item.content);
    const sorted = [...active].sort((a, b) => (a.gen ?? 0) - (b.gen ?? 0));
    let winner: MemoryRecord | null = null;
    for (const v of sorted) {
      const applicable = !isPromotion(v.state) || v.targetDigest === liveDigest; // R3
      if (applicable) winner = v;
    }
    if (winner) live.set(target, { ...item, state: winner.state });
  }
  return { live, compromised, keyAvailable: true };
}
