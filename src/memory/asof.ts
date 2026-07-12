import type { MemoryRecord, AsOfFact } from '../types.js';
import { buildProjection } from './projection.js';
import { digestContent } from './ledger-mac.js';
import { resolveTargetGrade, isKnownState } from './verified-projection.js';

/** Reconstruct the snapshot at system-time `t` with full per-verify evidence (spec C §4). Membership
 *  is DECLARED: filter by raw `tx <= t` (assert/supersede/erase tx is unsigned). Grade + evidence come
 *  from the SAME resolveTargetGrade the live projection uses, so asOf(now) equals the live grade.
 *  Caller resolves `verify`/`keyAvailable` for the scope; `t` is assumed canonical (surface validates). */
export function buildAsOfEvidence(
  records: MemoryRecord[],
  t: string,
  opts: { verify: (r: MemoryRecord) => boolean; keyAvailable: boolean },
): { facts: AsOfFact[]; keyAvailable: boolean } {
  const asOfRecords = records.filter((r) => r.tx <= t);            // declared membership window
  const liveAt = buildProjection(asOfRecords.filter((r) => r.type !== 'verify')); // facts live at t
  const facts: AsOfFact[] = [];

  if (!opts.keyAvailable) { // fail-safe: no key => every grade Fresh, no evidence trusted
    for (const rec of liveAt.values()) facts.push({ record: { ...rec, state: 'Fresh' }, grade: 'Fresh', evidence: [], integrity: 'ok' });
    return { facts, keyAvailable: false };
  }

  const byTarget = new Map<string, MemoryRecord[]>();
  for (const r of asOfRecords) {
    if (r.type !== 'verify' || !r.supersedes || !opts.verify(r) || !isKnownState(r.state)) continue; // R2 + D1
    (byTarget.get(r.supersedes) ?? byTarget.set(r.supersedes, []).get(r.supersedes)!).push(r);
  }

  for (const rec of liveAt.values()) {
    const item: MemoryRecord = { ...rec, state: 'Fresh' }; // R1 base clamp
    const verifies = byTarget.get(rec.id) ?? [];
    if (verifies.length === 0) { facts.push({ record: item, grade: 'Fresh', evidence: [], integrity: 'ok' }); continue; }
    const { grade, compromised, evidence } = resolveTargetGrade(verifies, digestContent(rec.content));
    facts.push({
      record: grade ? { ...item, state: grade } : item,
      grade: grade ?? 'Fresh',
      evidence,
      integrity: compromised ? 'compromised' : 'ok',
    });
  }
  return { facts, keyAvailable: true };
}
