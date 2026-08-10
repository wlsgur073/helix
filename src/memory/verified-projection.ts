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

/** Rows that can BE a live fact under their own id (assert/supersede), i.e. exactly the population
 *  forgedFactIds compares for a duplicate. A verify targets another row (`supersedes`), and an
 *  invalidate/erase closes one; none of the three is ever surfaced as a fact under its own id.
 *
 *  Exported because compaction (ledger.ts) must PRESERVE precisely the rows this admits when an id is
 *  forged. The detector and the preserver cannot be allowed to drift: a row the detector compares but
 *  the preserver drops is evidence destroyed by a rewrite; a row the preserver keeps but the detector
 *  ignores is unreclaimable bloat that flags nothing. This export is shared by exactly those two -
 *  `forgedFactIds` and the compaction preserver - because a mismatch THERE destroys evidence.
 *  It is NOT the only statement of "fact row": `history.ts` (ledgerTruncated, and buildHistory's own
 *  duplicate-fact-id anomaly scan) and `ledger.ts`'s horizon-marker trigger each restate `assert ||
 *  supersede` positively and independently. All agree today; a sixth RecordType would split them (the
 *  negative form here admits it, the positive forms exclude it). Routing them through this predicate
 *  too is a worthwhile follow-up, but is not what this extraction claims to have done. */
export const isFactRow = (r: MemoryRecord): boolean =>
  r.type !== 'verify' && r.type !== 'invalidate' && r.type !== 'erase';

/** Fact ids carried by two or more DIFFERING records — tamper evidence, never elevated.
 *
 *  Ids are minted server-side per commit (store.id -> randomUUID), so a caller cannot choose one and
 *  a collision is not a state a legitimate write reaches: it takes a boundary append or an adopted
 *  foreign ledger. buildProjection resolves a collision last-write-wins, and the MAC covers neither
 *  `provenance` nor any other unauthenticated field — so a twin carrying byte-identical content and
 *  a forged `provenance.source` clears the digest binding untouched and inherits the grade the
 *  original earned. Which occurrence is genuine is not knowable from the ledger, so the id confers
 *  no grade at all, the same way resolveTargetGrade treats two verifies that disagree inside a lane.
 *
 *  Byte-identical repeats are EXEMPT. Appends are at-least-once by design — a complete but
 *  unacknowledged record commits — so a crash can legitimately replay one line verbatim. A repeat
 *  that carries no difference forges nothing, and clamping it would convert a documented durability
 *  property into silent grade loss.
 *
 *  Shared by the live projection and the as-of reconstruction: a guard on only one of them would
 *  hand the other back as a bypass, and would break as-of's contract that asOf(now) equals live.
 *
 *  DETECTION IS PHYSICAL, so the EVIDENCE must be too. This function infers tampering per read from
 *  two differing rows co-existing in the record array — it reads no durable flag. A rewrite that kept
 *  one row per live id would therefore not hide the alarm but DELETE it, leaving the forger's twin
 *  (buildProjection is last-write-wins and a twin is appended after the original) holding a still-valid
 *  signed verify. planCompaction is the counterpart that makes this durable: it preserves every
 *  occurrence of a forged id VERBATIM instead of collapsing it, and must never normalize ANY field —
 *  not just `state`. The identity here is whole-record JSON, so normalizing whichever field two
 *  occurrences happen to differ in makes them byte-identical and lands them in the exemption above,
 *  destroying the evidence. `state` is only the field the adjacent Fresh-reset would have hit; a
 *  timestamp canonicalizer at the horizon would do the same via `tx`/`validFrom` (measured: the twin
 *  re-grades to Verified), and every other field is equally load-bearing. */
export function forgedFactIds(records: MemoryRecord[]): Set<string> {
  const firstById = new Map<string, string>();
  const forged = new Set<string>();
  for (const r of records) {
    if (!isFactRow(r)) continue; // never live facts
    const serialized = JSON.stringify(r);
    const first = firstById.get(r.id);
    if (first === undefined) firstById.set(r.id, serialized);
    else if (first !== serialized) forged.add(r.id);
  }
  return forged;
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

  const forgedIds = forgedFactIds(nonVerify);

  // Group valid verifies by target, choose the winning grade by generation (R2/R3).
  const byTarget = new Map<string, MemoryRecord[]>();
  for (const r of records) {
    if (r.type !== 'verify' || !r.supersedes || !opts.verify(r) || !isKnownState(r.state)) continue; // R2 + D1 enum gate
    (byTarget.get(r.supersedes) ?? byTarget.set(r.supersedes, []).get(r.supersedes)!).push(r);
  }

  for (const [target, verifies] of byTarget) {
    const item = live.get(target);
    if (!item) continue; // target not live (superseded/erased) — nothing to elevate
    if (forgedIds.has(target)) { compromised.add(target); continue; } // stays Fresh (already clamped in `live`)
    const { grade, compromised: c } = resolveTargetGrade(verifies, digestContent(item.content));
    if (c) { compromised.add(target); continue; } // stays Fresh (already clamped in `live`)
    if (grade) live.set(target, { ...item, state: grade });
  }
  return { live, compromised, keyAvailable: true };
}
