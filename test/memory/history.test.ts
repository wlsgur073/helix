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

  it('isIsoInstant rejects shaped-but-impossible instants (semantic, not shape-only)', async () => {
    const { isIsoInstant } = await import('../../src/memory/history.js');
    // Well-shaped but impossible calendar values must NOT enter a trusted label — a shape-only
    // regex would pass them; the semantic check (valid Date + exact round-trip) rejects (spec §6).
    expect(isIsoInstant('2026-99-99T99:99:99.999Z')).toBe(false);
    expect(isIsoInstant('2026-13-01T00:00:00.000Z')).toBe(false); // month 13 is impossible
    // Genuine rows are unaffected: canonical still true, non-canonical shape still false.
    expect(isIsoInstant('2026-06-09T00:00:00.000Z')).toBe(true);
    expect(isIsoInstant('2026-06-09T00:00:00Z')).toBe(false);
  });
});

describe('buildHistory — anomaly + truncation signals', () => {
  it('(c) a closer that appears BEFORE its target: row is closed, clamped, flagged', () => {
    // marker appended before the target it names (forged). buildProjection removes order-independently.
    const e = rec({ id: 'e', type: 'erase', supersedes: 'a', content: '', tx: '2026-06-09T00:00:01.000Z' });
    const a = rec({ id: 'a', content: 'late', tx: '2026-06-09T00:00:02.000Z' });
    const { rows, anomalies } = buildHistory([e, a]);
    const ra = rows.find((r) => r.record.id === 'a')!;
    expect(ra.txTo).toBe('2026-06-09T00:00:02.000Z'); // clamped to R.tx
    expect(ra.closedBy!.kind).toBe('erase');
    expect(anomalies.has('a')).toBe(true);
  });

  it('a before-R marker is flagged even when a valid after-R marker is the closer', () => {
    const before = rec({ id: 'm0', type: 'invalidate', supersedes: 'a', tx: '2026-06-09T00:00:01.000Z' });
    const a = rec({ id: 'a', tx: '2026-06-09T00:00:02.000Z' });
    const after = rec({ id: 'm1', type: 'supersede', supersedes: 'a', tx: '2026-06-09T00:00:03.000Z' });
    const { rows, anomalies } = buildHistory([before, a, after]);
    const ra = rows.find((r) => r.record.id === 'a')!;
    expect(ra.closedBy).toEqual({ kind: 'supersede', markerId: 'm1' }); // after-marker is the closer
    expect(anomalies.has('a')).toBe(true);                              // before-marker still flagged
  });

  it('duplicate fact id is flagged and emitted once', () => {
    const a1 = rec({ id: 'dup', content: 'first', tx: '2026-06-09T00:00:01.000Z' });
    const a2 = rec({ id: 'dup', content: 'second', tx: '2026-06-09T00:00:02.000Z' });
    const { rows, anomalies } = buildHistory([a1, a2]);
    expect(rows.filter((r) => r.record.id === 'dup')).toHaveLength(1);
    expect(anomalies.has('dup')).toBe(true);
  });

  it('truncated=false on a soft-erase (target row still present)', () => {
    const a = rec({ id: 'a', tx: '2026-06-09T00:00:01.000Z' });
    const e = rec({ id: 'e', type: 'erase', supersedes: 'a', content: '', tx: '2026-06-09T00:00:02.000Z' });
    expect(buildHistory([a, e]).truncated).toBe(false);
  });

  it('truncated=true when an erase tombstone has no surviving target (past compaction)', () => {
    // a permanent-erase compaction drops the fact row, keeps the content-free tombstone.
    const e = rec({ id: 'e', type: 'erase', supersedes: 'gone', content: '', tx: '2026-06-09T00:00:02.000Z' });
    expect(buildHistory([e]).truncated).toBe(true);
  });

  it('truncated=true when an integrity tombstone is present', () => {
    const t = rec({ id: 'integrity_x', type: 'verify', supersedes: null, content: '', state: 'Suspect' });
    expect(buildHistory([t]).truncated).toBe(true);
  });

  it('determinism: same records -> identical rows + anomalies', () => {
    const input = [
      rec({ id: 'a', tx: '2026-06-09T00:00:01.000Z' }),
      rec({ id: 'b', type: 'supersede', supersedes: 'a', tx: '2026-06-09T00:00:02.000Z' }),
    ];
    expect(JSON.stringify(buildHistory(input).rows)).toBe(JSON.stringify(buildHistory(input).rows));
  });
});
