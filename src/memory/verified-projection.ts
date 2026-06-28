import type { MemoryRecord } from '../types.js';
import { buildProjection } from './projection.js';
import { digestContent } from './ledger-mac.js';

export interface VerifiedProjection {
  live: Map<string, MemoryRecord>;
  compromised: Set<string>;
  keyAvailable: boolean;
}

const isPromotion = (s: MemoryRecord['state']): boolean => s === 'Verified' || s === 'Corroborated';

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

    // Phase 1 (order-independent, fail-closed): equal-gen / different-state conflict over ALL valid
    // verifies, BEFORE R3 applicability filtering. Per-target gen is monotonic, so a duplicate gen is
    // anomalous; two valid same-gen verifies disagreeing on state is a MAC conflict regardless of
    // whether one is a non-applicable (digest-mismatched) promotion. Resolve to Fresh + compromised.
    const stateByGen = new Map<number, MemoryRecord['state']>();
    let conflict = false;
    for (const v of verifies) {
      const g = v.gen ?? 0;
      const prev = stateByGen.get(g);
      if (prev === undefined) stateByGen.set(g, v.state);
      else if (prev !== v.state) { conflict = true; break; }
    }
    if (conflict) { compromised.add(target); continue; } // stays Fresh (already clamped in `live`)

    // Phase 2: elevate to the highest-gen APPLICABLE grade (R3).
    const liveDigest = digestContent(item.content);
    const sorted = [...verifies].sort((a, b) => (a.gen ?? 0) - (b.gen ?? 0));
    let winner: MemoryRecord | null = null;
    for (const v of sorted) {
      const applicable = !isPromotion(v.state) || v.targetDigest === liveDigest; // R3
      if (applicable) winner = v;
    }
    if (winner) live.set(target, { ...item, state: winner.state });
  }
  return { live, compromised, keyAvailable: true };
}
