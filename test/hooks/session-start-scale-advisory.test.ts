import { describe, it, expect } from 'vitest';
import { formatSessionStartContext, SCALE_ADVISORY_ROWS } from '../../src/hooks/format-context.js';
import * as sessionStart from '../../src/hooks/session-start.js';
import type { MemoryRecord, ScopedRecord } from '../../src/types.js';

const N = 'd'.repeat(32); // fixed test nonce

// C4.10 (readiness criteria; owner decision Q2 2026-07-22): a LOCAL, content-free scale advisory.
// When the union physical row count crosses a soft threshold BELOW the Stage-1 indexed-storage
// build trigger (2,500 union rows — persistent-recall-index decision), the SessionStart block
// carries one trusted advisory line so an adopter with a bulk/imported ledger is not silently
// carried past the validated envelope (README "Scale"). No telemetry: computed and shown locally.

function rec(over: Partial<MemoryRecord> & { content: string }): MemoryRecord {
  return {
    id: `m_${over.content.slice(0, 8)}`, tx: '2026-06-10T00:00:00.000Z',
    validFrom: '2026-06-10T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', provenance: { source: 'user', sessionId: 's1' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    ...over,
  };
}

const one: ScopedRecord[] = [{ record: rec({ content: 'a real fact' }), scope: 'global' }];

describe('SessionStart scale advisory (C4.10)', () => {
  it('fires AT the threshold, outside the frame, content-free (count + constants only)', () => {
    const out = formatSessionStartContext(one, N, { unionRows: SCALE_ADVISORY_ROWS });
    const line = out.split('\n').find((l) => l.startsWith('(scale advisory:'));
    expect(line).toBeDefined();
    expect(line).toContain(`${SCALE_ADVISORY_ROWS} union ledger rows`);
    // Trusted advisory renders OUTSIDE the quarantined frame, after the close marker.
    const closeIdx = out.indexOf(`===HELIX ${N} END===`);
    expect(out.indexOf('(scale advisory:')).toBeGreaterThan(closeIdx);
    // Content-free: the line never carries record content.
    expect(line).not.toContain('a real fact');
  });

  it('stays silent one row below the threshold', () => {
    const out = formatSessionStartContext(one, N, { unionRows: SCALE_ADVISORY_ROWS - 1 });
    expect(out).not.toContain('(scale advisory:');
  });

  it('renders alone on the empty-records early return (all-superseded fat ledger is exactly the signal)', () => {
    const out = formatSessionStartContext([], N, { unionRows: SCALE_ADVISORY_ROWS + 417 });
    expect(out.startsWith('(scale advisory:')).toBe(true);
    expect(out).toContain(`${SCALE_ADVISORY_ROWS + 417} union ledger rows`);
    expect(out).not.toContain('===HELIX'); // nothing to frame — the advisory stands alone
  });

  it('unionPhysicalRows sums the per-scope physical rows main() feeds the renderer', () => {
    // The same `rows` the replay sensor emits — physical rows, matching the Stage-1 trigger's
    // union-physical-rows definition, so the advisory and the real trigger count the same thing.
    const rows = sessionStart.unionPhysicalRows([
      { rows: 1500 }, { rows: 600 },
    ]);
    expect(rows).toBe(2100);
    expect(sessionStart.unionPhysicalRows([])).toBe(0);
  });

  it('is reserved outside the maxChars truncation accounting, like the other trailer notes', () => {
    const many: ScopedRecord[] = Array.from({ length: 20 }, (_, i) =>
      ({ record: rec({ content: `long fact ${i} ${'x'.repeat(120)}`, id: `m_${i}` }), scope: 'global' }));
    const out = formatSessionStartContext(many, N, { maxChars: 300, unionRows: SCALE_ADVISORY_ROWS + 1 });
    expect(out).toContain('(scale advisory:');
    // Discriminating pair: same saturated input without the row count never mentions it.
    const outWithout = formatSessionStartContext(many, N, { maxChars: 300 });
    expect(outWithout).not.toContain('(scale advisory:');
  });
});
