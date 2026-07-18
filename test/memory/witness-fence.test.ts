import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryRecord } from '../../src/types.js';
import { isMarkerShape, isHorizonMarker, parseLedger, planCompaction, witnessFenceRecord } from '../../src/memory/ledger.js';
import { buildProjection } from '../../src/memory/projection.js';
import { buildVerifiedProjection } from '../../src/memory/verified-projection.js';
import { fenceId } from '../../src/memory/witness-core.js';
import { MemoryStore } from '../../src/memory/store.js';

function rec(p: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content: 'x',
    provenance: { source: 'user', sessionId: 's1' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    ...p,
  };
}

describe('witnessFenceRecord shape (spec §4.9)', () => {
  it('matches the exact 12-field marker shape from the brief', () => {
    const tx = '2026-07-18T12:00:00.000Z';
    const f = witnessFenceRecord(5, 'aa11bb22', tx);
    expect(f).toEqual({
      id: 'witness_fence_5_aa11bb22', tx, validFrom: tx, validTo: null,
      type: 'verify', state: 'Suspect', content: '',
      provenance: { source: 'user', sessionId: 'witness' },
      supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    });
  });

  it('id is fenceId(epoch, nonce) — the SAME id-minting function witness-store uses', () => {
    const f = witnessFenceRecord(7, 'deadbeef', '2026-07-18T00:00:00.000Z');
    expect(f.id).toBe(fenceId(7, 'deadbeef'));
  });

  it('carries its OWN real transition tx, never the marker sentinel (unlike canonicalMarker)', () => {
    const tx = '2026-07-18T01:02:03.000Z';
    const f = witnessFenceRecord(1, 'nonce1', tx);
    expect(f.tx).toBe(tx);
    expect(f.validFrom).toBe(tx);
    expect(f.tx).not.toBe('1970-01-01T00:00:00.000Z'); // MARKER_SENTINEL_TX
  });

  it('satisfies isMarkerShape', () => {
    const f = witnessFenceRecord(3, 'shapecheck', '2026-07-18T00:00:00.000Z');
    expect(isMarkerShape(f)).toBe(true);
  });
});

describe('witnessFenceRecord — structural exclusion from live projections (Step 1a)', () => {
  it('is excluded from buildProjection and buildVerifiedProjection live maps (append to a 2-row ledger)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-fence-'));
    const ledger = join(home, 'memory.jsonl');
    appendFileSync(ledger, JSON.stringify(rec({ id: 'm_1', content: 'alpha' })) + '\n');
    appendFileSync(ledger, JSON.stringify(rec({ id: 'm_2', content: 'bravo' })) + '\n');
    const fence = witnessFenceRecord(1, 'a'.repeat(32), '2026-07-18T00:00:00.000Z');
    appendFileSync(ledger, JSON.stringify(fence) + '\n');

    const records = parseLedger(ledger);
    expect(records).toHaveLength(3); // sanity: the fence really is on disk

    const live = buildProjection(records);
    expect(live.size).toBe(2);
    expect(live.has(fence.id)).toBe(false);
    // Mutation-sensitive (Step 5): if the fence's `supersedes` were ever non-null it would target
    // one of these two ids and buildProjection would overwrite its state — asserting the state is
    // untouched, not just the map size, is what makes that mutation observable here.
    expect(live.get('m_1')!.state).toBe('Fresh');
    expect(live.get('m_2')!.state).toBe('Fresh');

    // Permissive stub predicate on purpose: this test is about STRUCTURAL exclusion (shape alone),
    // independent of MAC validity — the real verifyVerify would reject a mac-less fence anyway
    // (ledger-mac.ts:143 `if (!record.mac || !record.keyId) return false`), which would mask the
    // structural guarantee this test exists to pin down.
    const verified = buildVerifiedProjection(records, { verify: () => true, keyAvailable: true });
    expect(verified.live.size).toBe(2);
    expect(verified.live.has(fence.id)).toBe(false);
    expect(verified.live.get('m_1')!.state).toBe('Fresh');
    expect(verified.live.get('m_2')!.state).toBe('Fresh');
  });
});

describe('planCompaction — fence drop (Step 1b)', () => {
  it('drops a stale fence row from kept, but keeps horizon markers exactly as before', () => {
    const stale = witnessFenceRecord(1, 'b'.repeat(32), '2026-01-01T00:00:00.000Z');
    // A compaction that legitimately triggers a horizon marker mint (a closed fact is dropped) —
    // the same shape as marker-fixpoint.test.ts / compaction.test.ts's horizon-marker fixtures.
    const closed = rec({ id: 'm_old', content: 'old' });
    const closer = rec({ id: 'm_new', type: 'supersede', supersedes: 'm_old', content: 'new' });
    const { kept } = planCompaction([closed, closer, stale], { erasedIds: new Set() });

    expect(kept.some((r) => r.id.startsWith('witness_fence_'))).toBe(false);
    const horizonMarkers = kept.filter(isHorizonMarker);
    expect(horizonMarkers).toHaveLength(1);
    expect(horizonMarkers[0]!.id).toBe('horizon_marker');
    expect(kept.map((r) => r.id)).toEqual(['m_new', 'horizon_marker']); // fence contributes nothing
  });

  it('drops MULTIPLE stale fences accumulated across several rewrites, without minting a replacement', () => {
    const f1 = witnessFenceRecord(1, 'd'.repeat(32), '2026-01-01T00:00:00.000Z');
    const f2 = witnessFenceRecord(2, 'e'.repeat(32), '2026-01-02T00:00:00.000Z');
    const { kept } = planCompaction([rec({ id: 'm_1', content: 'live' }), f1, f2], { erasedIds: new Set() });
    expect(kept.filter((r) => r.id.startsWith('witness_fence_'))).toHaveLength(0);
    expect(kept.map((r) => r.id)).toEqual(['m_1']); // planCompaction stays pure: no fence minted here
  });

  it('drops a stale fence even in HMAC-aware mode (null supersedes short-circuits before keepValidVerify runs)', () => {
    const stale = witnessFenceRecord(3, 'f'.repeat(32), '2026-01-01T00:00:00.000Z');
    const live = rec({ id: 'm_1', content: 'live fact' });
    // A maximally HOSTILE predicate: `() => false` would count as "forged" any verify it actually
    // sees. If a fence ever reached this predicate it would inflate droppedForgedVerifies and
    // spuriously mint an integrity_marker — proving the drop happens before that call is the point.
    const { kept, droppedForgedVerifies } = planCompaction([live, stale], { erasedIds: new Set(), keepValidVerify: () => false });
    expect(kept.filter((r) => r.id.startsWith('witness_fence_'))).toHaveLength(0);
    expect(droppedForgedVerifies).toBe(0);
    expect(kept.some((r) => r.id === 'integrity_marker')).toBe(false);
  });
});

describe('store.recall — a fence row never surfaces (Step 1c)', () => {
  it('a raw fence row appended to the ledger never appears in recall results', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-fence-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    store.commit({ content: 'deploy target is staging', source: 'user' });
    store.commit({ content: 'deploy target is production', source: 'user' });
    const fence = witnessFenceRecord(1, 'c'.repeat(32), '2026-07-18T00:00:00.000Z');
    appendFileSync(ledger, JSON.stringify(fence) + '\n');

    const results = store.recall('deploy target');
    expect(results.items.length).toBe(2);
    expect(results.items.some((i) => i.record.id === fence.id)).toBe(false);
    expect(results.items.every((i) => !i.record.id.startsWith('witness_fence_'))).toBe(true);
  });
});

// Task title scope: "fence rows — mint, drop-on-rewrite, ERASE ROUTING". markerFamilyOf routes
// witness_fence_ ids by PREFIX (unlike the two exact-match fixpoint families) because a fence has
// no single canonical id — one exists per epoch+nonce. Mirrors erase-routing.test.ts's style.
describe('erase routing — witness_fence_ family (markerFamilyOf)', () => {
  it('C10 family-prefix presence: an erase call resolves via ANY on-disk fence, even a different nonce than queried', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-fence-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    store.commit({ content: 'real fact', source: 'user' });
    const onDisk = witnessFenceRecord(1, 'aaaa', '2026-01-01T00:00:00.000Z');
    appendFileSync(ledger, JSON.stringify(onDisk) + '\n');
    const queried = fenceId(2, 'bbbb'); // a DIFFERENT epoch/nonce — never written to this ledger
    expect(() => store.erase(queried, { permanent: true, scope: 'global' })).not.toThrow();
    expect(readFileSync(ledger, 'utf8')).not.toMatch(/witness_fence_/); // the on-disk fence is gone
  });

  it('a fence-shaped id absent from the ledger still throws not-found (family presence is not unconditional)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-fence-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    store.commit({ content: 'real fact', source: 'user' });
    expect(() => store.erase(fenceId(9, 'nope'), { permanent: true, scope: 'global' })).toThrow(/not found in scope/);
  });

  it('T1-g precedent: soft-erasing a fence-shaped id does not append a tombstone (markers are tombstone-exempt)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-fence-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    store.commit({ content: 'real fact', source: 'user' });
    const fence = witnessFenceRecord(1, 'cccc', '2026-01-01T00:00:00.000Z');
    appendFileSync(ledger, JSON.stringify(fence) + '\n');
    store.erase(fence.id, { scope: 'global' }); // soft (non-permanent)
    expect(readFileSync(ledger, 'utf8')).not.toMatch(/"type":"erase"/);
  });
});
