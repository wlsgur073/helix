// Move 2 (spec 2.C, R5(c)): erase used to decide "is this a marker" from the id's PREFIX. A live,
// normal record whose id wears a marker prefix — possible in an ADOPTED ledger, since the server
// itself mints only m_<uuid> ids — was therefore reported absent (soft erase = silent no-op success)
// or skipped for the tombstone when a genuine marker of that family existed (again a silent
// success). Routing now classifies the parsed ROW: a record's exact id wins over a family-only
// marker match; only a marker row and a record with the SAME exact id are refused as ambiguous.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryRecord } from '../../src/types.js';
import { parseLedger, witnessFenceRecord } from '../../src/memory/ledger.js';
import { MemoryStore } from '../../src/memory/store.js';

const TS = '2026-01-01T00:00:00.000Z';

/** A raw ledger row, the way an adopted or hand-written ledger would carry it. */
function rec(p: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    tx: TS, validFrom: TS, validTo: null,
    type: 'assert', state: 'Fresh', content: 'x',
    provenance: { source: 'user', sessionId: 's1' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    ...p,
  };
}

/** A marker-SHAPED row (verify, null target, no mac) under an arbitrary id — what isMarkerShape sees. */
function markerRow(id: string): MemoryRecord {
  return rec({ id, type: 'verify', supersedes: null, content: '', state: 'Fresh' });
}

function fresh(): { store: MemoryStore; ledger: string } {
  const home = mkdtempSync(join(tmpdir(), 'helix-marker-shape-'));
  const ledger = join(home, 'memory.jsonl');
  return { store: new MemoryStore(ledger, { sessionId: 's', home }), ledger };
}

const appendRaw = (ledger: string, r: MemoryRecord): void => appendFileSync(ledger, JSON.stringify(r) + '\n');
const liveIds = (store: MemoryStore, query: string): string[] => store.recall(query).items.map((i) => i.record.id);

describe('erase routes by the parsed row, not by the id prefix (R5(c))', () => {
  it('a live assert wearing witness_fence_ with NO fence on disk is soft-erased, not silently ignored', () => {
    const { store, ledger } = fresh();
    store.commit({ content: 'anchor fact so the ledger exists', source: 'user' });
    appendRaw(ledger, rec({ id: 'witness_fence_evil', content: 'poisoned adopted row wearing a marker prefix' }));
    expect(liveIds(store, 'poisoned adopted row')).toContain('witness_fence_evil');

    store.erase('witness_fence_evil');                              // soft, no scope — the tool's shape

    expect(liveIds(store, 'poisoned adopted row')).not.toContain('witness_fence_evil');
    // The erase is a real tombstone on disk, not a projection trick.
    expect(parseLedger(ledger).some((r) => r.type === 'erase' && r.supersedes === 'witness_fence_evil')).toBe(true);
  });

  it('a live assert wearing witness_fence_ beside a DIFFERENT genuine fence is erased; the fence stays', () => {
    const { store, ledger } = fresh();
    store.commit({ content: 'anchor fact so the ledger exists', source: 'user' });
    appendRaw(ledger, witnessFenceRecord(1, 'aaaa', TS));            // genuine fence: witness_fence_1_aaaa
    appendRaw(ledger, rec({ id: 'witness_fence_evil', content: 'poisoned adopted row beside a fence' }));

    store.erase('witness_fence_evil');

    expect(liveIds(store, 'poisoned adopted row')).not.toContain('witness_fence_evil');
    expect(parseLedger(ledger).some((r) => r.id === 'witness_fence_1_aaaa')).toBe(true);
  });

  it('a live assert named exactly integrity_marker beside an integrity_-family marker is erased; horizon likewise', () => {
    for (const [canonical, planted] of [['integrity_marker', 'integrity_planted'], ['horizon_marker', 'horizon_planted']] as const) {
      const { store, ledger } = fresh();
      store.commit({ content: 'anchor fact so the ledger exists', source: 'user' });
      appendRaw(ledger, markerRow(planted));
      appendRaw(ledger, rec({ id: canonical, content: `adopted row named ${canonical}` }));

      store.erase(canonical);

      expect(liveIds(store, `adopted row named ${canonical}`), canonical).not.toContain(canonical);
      expect(parseLedger(ledger).some((r) => r.id === planted), canonical).toBe(true);
    }
  });

  it('a genuine fence AND a live assert with that SAME id is refused as ambiguous, with no write', () => {
    const { store, ledger } = fresh();
    store.commit({ content: 'anchor fact so the ledger exists', source: 'user' });
    appendRaw(ledger, witnessFenceRecord(1, 'aaaa', TS));
    appendRaw(ledger, rec({ id: 'witness_fence_1_aaaa', content: 'a record that stole the fence id' }));
    const before = readFileSync(ledger);

    expect(() => store.erase('witness_fence_1_aaaa')).toThrow(/names both a marker row and a record/);

    expect(readFileSync(ledger).equals(before)).toBe(true);
  });
});
