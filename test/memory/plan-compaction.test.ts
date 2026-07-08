import { describe, it, expect } from 'vitest';
import type { MemoryRecord } from '../../src/types.js';
import { planCompaction, serializedBytes, isHorizonMarker } from '../../src/memory/ledger.js';

function assert(id: string): MemoryRecord {
  return { id, tx: `2026-01-01T00:00:00.000Z`, validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content: `content ${id}`,
    provenance: { source: 'user', sessionId: 't' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' };
}
function supersede(id: string, target: string): MemoryRecord { return { ...assert(id), type: 'supersede', supersedes: target }; }

describe('planCompaction', () => {
  it('drops a superseded fact and keeps the replacement (no keepValidVerify => legacy)', () => {
    const records = [assert('a'), supersede('b', 'a')];
    const kept = planCompaction(records, { erasedIds: new Set() });
    // 'a' superseded away, 'b' the live replacement. Dropping the closed 'a' row also emits ONE
    // content-free horizon marker (spec B, locked by compaction.test.ts:162) — an audit artifact,
    // not a fact — so filter it out to assert the surviving fact set.
    expect(kept.filter((r) => !isHorizonMarker(r)).map((r) => r.id)).toEqual(['b']);
  });

  it('serializedBytes is UTF-8 byte length plus one newline per record', () => {
    const r = assert('a');
    expect(serializedBytes([r])).toBe(Buffer.byteLength(JSON.stringify(r)) + 1);
  });

  it('serializedBytes counts UTF-8 bytes, not UTF-16 units (multibyte content)', () => {
    // Korean chars are 3 UTF-8 bytes but 1 UTF-16 unit each, so String.length UNDERCOUNTS them.
    const k: MemoryRecord = { ...assert('k'), content: '한글 콘텐츠' };
    const json = JSON.stringify(k);
    expect(serializedBytes([k])).toBe(Buffer.byteLength(json) + 1);
    // A regression to `json.length + 1` (UTF-16 units) would undercount; assert the byte count is
    // strictly larger, so such a regression FAILS here — the UTF-8 path is genuinely exercised.
    expect(serializedBytes([k])).toBeGreaterThan(json.length + 1);
  });
});
