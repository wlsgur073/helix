import { describe, it, expect } from 'vitest';
import { buildHistory } from '../../src/memory/history.js';
import type { MemoryRecord } from '../../src/types.js';

let seq = 0;
function rec(p: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  seq += 1;
  return {
    tx: `2026-06-09T00:00:00.${String(seq).padStart(3, '0')}Z`,
    validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content: 'x',
    provenance: { source: 'user', sessionId: 's1' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    ...p,
  };
}

describe('buildHistory — core', () => {
  it('a live assert has txTo=null, closedBy=null', () => {
    const { rows } = buildHistory([rec({ id: 'a' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.txTo).toBeNull();
    expect(rows[0]!.closedBy).toBeNull();
  });

  it('(a) normal: a supersede closes its predecessor at the marker tx; replacement stays live', () => {
    const a = rec({ id: 'a', tx: '2026-06-09T00:00:01.000Z' });
    const b = rec({ id: 'b', type: 'supersede', supersedes: 'a', tx: '2026-06-09T00:00:02.000Z' });
    const { rows } = buildHistory([a, b]);
    const ra = rows.find((r) => r.record.id === 'a')!;
    const rb = rows.find((r) => r.record.id === 'b')!;
    expect(ra.txTo).toBe('2026-06-09T00:00:02.000Z');
    expect(ra.closedBy).toEqual({ kind: 'supersede', markerId: 'b' });
    expect(rb.txTo).toBeNull();
  });

  it('invalidate and erase also close their target', () => {
    const a = rec({ id: 'a', tx: '2026-06-09T00:00:01.000Z' });
    const inv = rec({ id: 'i', type: 'invalidate', supersedes: 'a', tx: '2026-06-09T00:00:02.000Z' });
    expect(buildHistory([a, inv]).rows.find((r) => r.record.id === 'a')!.closedBy)
      .toEqual({ kind: 'invalidate', markerId: 'i' });
  });

  it('(b) append-after but tx-before clamps txTo to the row tx (zero-length)', () => {
    const a = rec({ id: 'a', tx: '2026-06-09T00:00:05.000Z' });
    const b = rec({ id: 'b', type: 'supersede', supersedes: 'a', tx: '2026-06-09T00:00:01.000Z' });
    const ra = buildHistory([a, b]).rows.find((r) => r.record.id === 'a')!;
    expect(ra.txTo).toBe('2026-06-09T00:00:05.000Z'); // clamped to R.tx, not the earlier marker tx
    expect(ra.closedBy).toEqual({ kind: 'supersede', markerId: 'b' });
  });

  it('a supersede chain closes each predecessor at its successor tx', () => {
    const a = rec({ id: 'a', tx: '2026-06-09T00:00:01.000Z' });
    const b = rec({ id: 'b', type: 'supersede', supersedes: 'a', tx: '2026-06-09T00:00:02.000Z' });
    const c = rec({ id: 'c', type: 'supersede', supersedes: 'b', tx: '2026-06-09T00:00:03.000Z' });
    const { rows } = buildHistory([a, b, c]);
    expect(rows.find((r) => r.record.id === 'a')!.txTo).toBe('2026-06-09T00:00:02.000Z');
    expect(rows.find((r) => r.record.id === 'b')!.txTo).toBe('2026-06-09T00:00:03.000Z');
    expect(rows.find((r) => r.record.id === 'c')!.txTo).toBeNull();
  });

  it('erase-closed rows are content-redacted', () => {
    const a = rec({ id: 'a', content: 'secret-ish note', tx: '2026-06-09T00:00:01.000Z' });
    const e = rec({ id: 'e', type: 'erase', supersedes: 'a', content: '', tx: '2026-06-09T00:00:02.000Z' });
    const ra = buildHistory([a, e]).rows.find((r) => r.record.id === 'a')!;
    expect(ra.closedBy!.kind).toBe('erase');
    expect(ra.record.content).toBe('');
  });

  it('verify never closes and is never emitted as a fact row', () => {
    const a = rec({ id: 'a' });
    const v = rec({ id: 'v', type: 'verify', supersedes: 'a', state: 'Verified', content: '' });
    const { rows } = buildHistory([a, v]);
    expect(rows.map((r) => r.record.id)).toEqual(['a']);
    expect(rows[0]!.closedBy).toBeNull();
  });

  it('isIsoInstant accepts canonical Z form, rejects others', async () => {
    const { isIsoInstant } = await import('../../src/memory/history.js');
    expect(isIsoInstant('2026-06-09T00:00:00.000Z')).toBe(true);
    expect(isIsoInstant('2026-06-09T00:00:00Z')).toBe(false);
    expect(isIsoInstant('nonsense')).toBe(false);
  });
});
