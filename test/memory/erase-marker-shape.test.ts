// Move 2 (spec 2.C, R5(c)): erase used to decide "is this a marker" from the id's PREFIX. A live,
// normal record whose id wears a marker prefix — possible in an ADOPTED ledger, since the server
// itself mints only m_<uuid> ids — was therefore reported absent (soft erase = silent no-op success)
// or skipped for the tombstone when a genuine marker of that family existed (again a silent
// success). Routing now classifies the parsed ROW: a record's exact id wins over a family-only
// marker match.
//
// Final review I-1 / I-2 close the two soft-path defects that routing left behind. I-1: an id carried
// by BOTH a marker-shaped row and a record no longer refuses a SOFT erase — the tombstone acts on the
// id in the projection, marker-shaped rows never enter that projection, so the refusal protected
// nothing and let anyone able to append a row deny a record's erasure. I-2: with two scopes, a
// family-only marker hit (every rewritten ledger carries a witness fence) must not count like a
// record hit in the other scope — a no-scope SOFT erase prefers the candidate holding the record.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryRecord } from '../../src/types.js';
import { parseLedger, witnessFenceRecord, isWitnessFence } from '../../src/memory/ledger.js';
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
    expect(liveIds(store, 'poisoned adopted row')).toContain('witness_fence_evil');

    store.erase('witness_fence_evil');

    expect(liveIds(store, 'poisoned adopted row')).not.toContain('witness_fence_evil');
    expect(parseLedger(ledger).some((r) => r.type === 'erase' && r.supersedes === 'witness_fence_evil')).toBe(true);
    expect(parseLedger(ledger).some((r) => r.id === 'witness_fence_1_aaaa')).toBe(true);
  });

  it('a live assert named exactly integrity_marker beside an integrity_-family marker is erased; horizon likewise', () => {
    for (const [canonical, planted] of [['integrity_marker', 'integrity_planted'], ['horizon_marker', 'horizon_planted']] as const) {
      const { store, ledger } = fresh();
      store.commit({ content: 'anchor fact so the ledger exists', source: 'user' });
      appendRaw(ledger, markerRow(planted));
      appendRaw(ledger, rec({ id: canonical, content: `adopted row named ${canonical}` }));
      expect(liveIds(store, `adopted row named ${canonical}`), canonical).toContain(canonical);

      store.erase(canonical);

      expect(liveIds(store, `adopted row named ${canonical}`), canonical).not.toContain(canonical);
      expect(parseLedger(ledger).some((r) => r.type === 'erase' && r.supersedes === canonical), canonical).toBe(true);
      expect(parseLedger(ledger).some((r) => r.id === planted), canonical).toBe(true);
    }
  });

  it('a genuine fence AND a live assert with that SAME id: a SOFT erase tombstones the record and leaves the fence', () => {
    // I-1. The refusal this replaces protected nothing — a tombstone acts on the id in the projection,
    // and the fence row never enters that projection — while handing anyone who can append a row a way
    // to deny the record's erasure.
    const { store, ledger } = fresh();
    store.commit({ content: 'anchor fact so the ledger exists', source: 'user' });
    appendRaw(ledger, witnessFenceRecord(1, 'aaaa', TS));
    appendRaw(ledger, rec({ id: 'witness_fence_1_aaaa', content: 'a record that stole the fence id' }));
    expect(liveIds(store, 'stole the fence id')).toContain('witness_fence_1_aaaa');

    expect(() => store.erase('witness_fence_1_aaaa')).not.toThrow();

    expect(liveIds(store, 'stole the fence id')).not.toContain('witness_fence_1_aaaa');
    expect(parseLedger(ledger).some((r) => r.type === 'erase' && r.supersedes === 'witness_fence_1_aaaa')).toBe(true);
    // A soft erase removes nothing: BOTH physical rows carrying that id are still on disk.
    expect(parseLedger(ledger).filter((r) => r.id === 'witness_fence_1_aaaa').length).toBe(2);
  });

  it('the same ambiguous state under a PERMANENT erase purges every row carrying the id — the documented escape stays open', () => {
    // compactLedger drops every live row whose id is in erasedIds, marker and record alike, so a
    // permanent erase has one meaning here and remains the out-of-band way to clear a planted marker.
    const { store, ledger } = fresh();
    store.commit({ content: 'anchor fact so the ledger exists', source: 'user' });
    appendRaw(ledger, witnessFenceRecord(1, 'aaaa', TS));
    appendRaw(ledger, rec({ id: 'witness_fence_1_aaaa', content: 'a record that stole the fence id' }));

    expect(() => store.erase('witness_fence_1_aaaa', { permanent: true, scope: 'global' })).not.toThrow();

    expect(parseLedger(ledger).some((r) => r.id === 'witness_fence_1_aaaa')).toBe(false);   // fence AND record gone
    expect(liveIds(store, 'stole the fence id')).toHaveLength(0);
  });

  it('a live assert under an ordinary m_ id beside a planted marker-shaped row with the SAME id is soft-erased — the denial vector is closed', () => {
    // I-1 from the attacker's side: the id is one the SERVER minted, so nothing about it is
    // marker-shaped until a planted row claims it. The erase must still land.
    const { store, ledger } = fresh();
    const rec = store.commit({ content: 'record beside a planted marker row', source: 'user' });
    appendRaw(ledger, markerRow(rec.id));
    expect(liveIds(store, 'record beside a planted marker row')).toContain(rec.id);

    expect(() => store.erase(rec.id)).not.toThrow();

    expect(liveIds(store, 'record beside a planted marker row')).not.toContain(rec.id);
    expect(parseLedger(ledger).some((r) => r.type === 'erase' && r.supersedes === rec.id)).toBe(true);
  });

  it('no-scope SOFT erase: a live record in one scope wins over a family-only fence in the other (fence made by a real rewrite)', () => {
    // I-2. The fence in the global ledger is planted by a REAL compaction, never by appendRaw, so the
    // precondition is the ordinary state of any ledger that has ever been rewritten — not a fixture
    // artefact. A family-only hit there must not read as a second home for the project record.
    const home = mkdtempSync(join(tmpdir(), 'helix-marker-shape-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-marker-shape-proj-'));
    const globalLedger = join(home, 'memory.jsonl');
    const projectLedger = join(root, '.helix', 'memory.jsonl');
    let n = 0;
    const s = new MemoryStore(globalLedger, {
      home, sessionId: 's1', now: () => TS, genId: () => `m_${++n}`,
      project: { ledger: projectLedger, root },
    });
    s.adopt(root);                                                  // adopt creates the project .helix dir

    const anchor = s.commit({ content: 'anchor fact that the global rewrite will purge', source: 'user', scope: 'global' });
    s.erase(anchor.id, { permanent: true, scope: 'global' });        // the rewrite plants the witness fence
    expect(parseLedger(globalLedger).some(isWitnessFence)).toBe(true);   // precondition, proven not assumed

    appendRaw(projectLedger, rec({ id: 'witness_fence_evil', content: 'poisoned adopted row in the project ledger' }));
    expect(liveIds(s, 'poisoned adopted row')).toContain('witness_fence_evil');
    const beforeGlobal = readFileSync(globalLedger);

    expect(() => s.erase('witness_fence_evil')).not.toThrow();       // soft, NO scope — the tool's only shape

    expect(liveIds(s, 'poisoned adopted row')).not.toContain('witness_fence_evil');
    expect(parseLedger(projectLedger).some((r) => r.type === 'erase' && r.supersedes === 'witness_fence_evil')).toBe(true);
    expect(readFileSync(globalLedger).equals(beforeGlobal)).toBe(true);  // the other scope is untouched
  });
});
