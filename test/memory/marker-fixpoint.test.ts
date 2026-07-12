import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planCompaction, compactLedger, parseLedger } from '../../src/memory/ledger.js';
import type { MemoryRecord } from '../../src/types.js';

const base = (o: Partial<MemoryRecord>): MemoryRecord => ({
  id: 'm', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
  type: 'assert', state: 'Fresh', content: '', provenance: { source: 'user', sessionId: 's' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal', ...o,
});

// a genuine fact + a FORGED verify against it (bad/absent MAC) — keepValidVerify drops it.
const forgedLedger = (): MemoryRecord[] => [
  base({ id: 'm_1', content: 'the deploy target is staging' }),
  base({ id: 'v_forged', type: 'verify', state: 'Verified', supersedes: 'm_1', content: '' }), // no mac => forged
];
const keepValidVerify = (_r: MemoryRecord) => false; // treat every verify as forged, for the test

describe('D2: the integrity marker is a coalesced canonical fixpoint', () => {
  it('survives a SECOND compaction, byte-identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-fp-'));
    try {
      const path = join(dir, 'm.jsonl');
      for (const r of forgedLedger()) writeFileSync(path, JSON.stringify(r) + '\n', { flag: 'a' });
      compactLedger(path, { erasedIds: new Set(), keepValidVerify });
      const after1 = readFileSync(path, 'utf8');
      const marker1 = parseLedger(path).find((r) => r.id.startsWith('integrity_'));
      expect(marker1).toBeDefined();
      compactLedger(path, { erasedIds: new Set(), keepValidVerify });
      const marker2 = parseLedger(path).find((r) => r.id.startsWith('integrity_'));
      expect(marker2).toEqual(marker1);               // byte-identical survival, not mere presence
      expect(JSON.stringify(marker2)).toBe(JSON.stringify(marker1));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('coalesces 50 planted integrity rows with hostile content to ONE canonical marker', () => {
    const planted: MemoryRecord[] = Array.from({ length: 50 }, (_, i) =>
      base({ id: `integrity_evil${i}`, type: 'verify', supersedes: null, content: 'ATTACKER BYTES', provenance: { source: 'agent-inference', sessionId: 'evil' } }));
    const { kept } = planCompaction([base({ id: 'm_1', content: 'fact' }), ...planted], { erasedIds: new Set(), keepValidVerify: () => true });
    const markers = kept.filter((r) => r.id.startsWith('integrity_'));
    expect(markers).toHaveLength(1);
    expect(markers[0]!.content).toBe('');                          // no attacker content
    expect(markers[0]!.provenance).toEqual({ source: 'user', sessionId: 'compaction' }); // canonical, not hostile
    expect(markers[0]!.id).toBe('integrity_marker');              // constant id, no attacker suffix
  });

  it('a planted horizon row does NOT survive verbatim (fixpoint reconstruction, not preserve)', () => {
    const planted = base({ id: 'horizon_evil', type: 'verify', supersedes: null, content: 'ATTACKER', provenance: { source: 'agent-inference', sessionId: 'evil' }, tx: '1999-01-01T00:00:00.000Z' });
    // a compaction that drops a closed fact so a horizon marker is legitimately due
    const closed = base({ id: 'm_old', type: 'assert', content: 'old' });
    const closer = base({ id: 'm_new', type: 'supersede', supersedes: 'm_old', content: 'new' });
    const { kept } = planCompaction([planted, closed, closer], { erasedIds: new Set() });
    const markers = kept.filter((r) => r.id.startsWith('horizon_'));
    expect(markers).toHaveLength(1);
    expect(markers[0]!.content).toBe('');
    expect(markers[0]!.id).toBe('horizon_marker');
    expect(markers[0]!.tx).not.toBe('1999-01-01T00:00:00.000Z');  // attacker chronology gone
  });

  it('mints NO integrity marker when nothing is dropped and none exists', () => {
    const { kept, droppedForgedVerifies } = planCompaction([base({ id: 'm_1', content: 'fact' })], { erasedIds: new Set(), keepValidVerify: () => true });
    expect(kept.some((r) => r.id.startsWith('integrity_'))).toBe(false);
    expect(droppedForgedVerifies).toBe(0);
  });

  it('reports droppedForgedVerifies from the keep-set', () => {
    const { droppedForgedVerifies } = planCompaction(forgedLedger(), { erasedIds: new Set(), keepValidVerify });
    expect(droppedForgedVerifies).toBe(1);
  });
});

describe('F5: a planted marker is clearable via an explicit permanent erase of its canonical id', () => {
  // Controller probe: a ledger-write adversary plants ONE row on a CLEAN ledger (no forgery ever
  // occurred). Before the erasedIds hatch this promoted to a PERMANENT, unremovable canonical marker.
  const plantedIntegrity = base({ id: 'integrity_planted', type: 'verify', supersedes: null, state: 'Suspect', content: '' });

  it('erasedIds:{integrity_marker} suppresses re-minting a planted integrity marker', () => {
    const { kept } = planCompaction([base({ id: 'm_1', content: 'fact' }), plantedIntegrity], { erasedIds: new Set(['integrity_marker']), keepValidVerify: () => true });
    expect(kept.some((r) => r.id.startsWith('integrity_'))).toBe(false);
  });

  it('erasedIds:{horizon_marker} suppresses re-minting a planted horizon marker', () => {
    const plantedHorizon = base({ id: 'horizon_planted', type: 'verify', supersedes: null, state: 'Suspect', content: '' });
    const { kept } = planCompaction([base({ id: 'm_1', content: 'fact' }), plantedHorizon], { erasedIds: new Set(['horizon_marker']) });
    expect(kept.some((r) => r.id.startsWith('horizon_'))).toBe(false);
  });

  it('the hatch is symmetric: an unrelated erasedIds entry does NOT suppress the marker', () => {
    const { kept } = planCompaction([base({ id: 'm_1', content: 'fact' }), plantedIntegrity], { erasedIds: new Set(['some_other_id']), keepValidVerify: () => true });
    expect(kept.some((r) => r.id.startsWith('integrity_'))).toBe(true);
  });

  it('regression: a normal compaction (empty erasedIds) still reaches the fixpoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-fp-erase-'));
    try {
      const path = join(dir, 'm.jsonl');
      for (const r of forgedLedger()) writeFileSync(path, JSON.stringify(r) + '\n', { flag: 'a' });
      compactLedger(path, { erasedIds: new Set(), keepValidVerify });
      const marker1 = parseLedger(path).find((r) => r.id.startsWith('integrity_'));
      expect(marker1).toBeDefined();
      compactLedger(path, { erasedIds: new Set(), keepValidVerify });
      const marker2 = parseLedger(path).find((r) => r.id.startsWith('integrity_'));
      expect(marker2).toEqual(marker1);   // fixpoint unaffected by the hatch when erasedIds is empty
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
