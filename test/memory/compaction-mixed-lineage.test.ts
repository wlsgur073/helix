import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { planCompaction, parseLedger } from '../../src/memory/ledger.js';
import type { MemoryRecord } from '../../src/types.js';

// Round-4 (Codex compare) blocker: a MIXED-KEY ledger defeats the existential `keyProven` chokepoint.
// The prior gate proved "some verify validates under the resolved key" and then deleted every OTHER
// invalid verify — but a genuine cross-lineage verify (signed under a lost/rotated nonce) is invalid
// under the resolved key yet is NOT a forgery. One new confirmation signed under the replacement
// nonce makes the resolved key "proven" and licenses deletion of the entire prior lineage. Forgery
// needs the master key; a competing lineage does not. The fix: only drop when the ledger is a SINGLE
// proven lineage (all eligible verifies share one keyId AND the resolved key validates one).

const rec = (o: Partial<MemoryRecord>): MemoryRecord => ({
  id: 'r', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
  type: 'assert', state: 'Fresh', content: '', provenance: { source: 'user', sessionId: 's' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal', ...o,
});

describe('compaction: mixed-lineage never deletes a genuine cross-lineage verify', () => {
  it('INTEGRATION: a genuine N1 verify survives one confirmation signed under a rotated nonce N2', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-mix-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });

    const keep = store.commit({ content: 'keep me alpha', source: 'user' });
    store.confirm(keep.id); // genuine signed verify under N1

    // rotate the @global nonce to a different value (a lost/aliased/changed registry -> N2)
    const regPath = join(home, 'projects.json');
    const reg = JSON.parse(readFileSync(regPath, 'utf8'));
    reg['@global'].macNonce = 'ffffffffffffffffffffffffffffffff';
    writeFileSync(regPath, JSON.stringify(reg));

    // Helix itself signs ONE new verify under N2 (the transition the old regression test missed)
    const other = store.commit({ content: 'other fact under N2', source: 'user' });
    store.confirm(other.id);

    // trigger a compaction (permanent erase resolves the now-N2 key)
    const gone = store.commit({ content: 'erase me beta', source: 'user' });
    store.erase(gone.id, { permanent: true });

    const after = parseLedger(ledger);
    // the genuine N1 verify MUST survive — a competing lineage is not proof of forgery
    expect(after.some((r) => r.type === 'verify' && r.supersedes === keep.id)).toBe(true);
    // and no FALSE integrity marker is minted from a bogus mass "forgery" drop
    expect(after.filter((r) => r.id.startsWith('integrity_'))).toHaveLength(0);
  });

  it('UNIT: a competing-keyId verify is preserved (not counted as forged) even when the key is proven', () => {
    const target = rec({ id: 'm_1', type: 'assert', content: 'fact' });
    const vA = rec({ id: 'vA', type: 'verify', state: 'Verified', supersedes: 'm_1', keyId: 'a'.repeat(64) });
    const vB = rec({ id: 'vB', type: 'verify', state: 'Verified', supersedes: 'm_1', keyId: 'b'.repeat(64) });
    // resolved key = lineage A: it proves vA and validates vA; vB is a DIFFERENT lineage (not forged)
    const provesKey = (r: MemoryRecord) => r.keyId === 'a'.repeat(64);
    const keepValidVerify = (r: MemoryRecord) => r.keyId === 'a'.repeat(64);
    const { kept, droppedForgedVerifies } = planCompaction([target, vA, vB], { erasedIds: new Set(), keepValidVerify, provesKey });
    expect(kept.some((r) => r.id === 'vA')).toBe(true);
    expect(kept.some((r) => r.id === 'vB')).toBe(true);   // competing lineage preserved, NOT deleted
    expect(droppedForgedVerifies).toBe(0);                // and no false forgery-drop => no false marker
  });

  it('UNIT: provesKey is fail-closed — absent provesKey with keepValidVerify preserves all (never drops)', () => {
    const target = rec({ id: 'm_1', type: 'assert', content: 'fact' });
    const vX = rec({ id: 'vX', type: 'verify', state: 'Verified', supersedes: 'm_1', keyId: 'a'.repeat(64) });
    const keepValidVerify = () => false; // would drop everything it is consulted on
    // NO provesKey passed: continuity is unproven, so compaction must NOT delete
    const { kept, droppedForgedVerifies } = planCompaction([target, vX], { erasedIds: new Set(), keepValidVerify });
    expect(kept.some((r) => r.id === 'vX')).toBe(true);
    expect(droppedForgedVerifies).toBe(0);
  });

  it('UNIT: a single-lineage forgery is STILL dropped when the key is proven (behavior preserved)', () => {
    const target = rec({ id: 'm_1', type: 'assert', content: 'fact' });
    const vGenuine = rec({ id: 'vG', type: 'verify', state: 'Verified', supersedes: 'm_1', keyId: 'a'.repeat(64) });
    const vForged = rec({ id: 'vF', type: 'verify', state: 'Verified', supersedes: 'm_1', keyId: 'a'.repeat(64) }); // same lineage, bad MAC
    const provesKey = (r: MemoryRecord) => r.id === 'vG';
    const keepValidVerify = (r: MemoryRecord) => r.id === 'vG';
    const { kept, droppedForgedVerifies } = planCompaction([target, vGenuine, vForged], { erasedIds: new Set(), keepValidVerify, provesKey });
    expect(kept.some((r) => r.id === 'vG')).toBe(true);
    expect(kept.some((r) => r.id === 'vF')).toBe(false);  // proven single lineage => real forgery dropped
    expect(droppedForgedVerifies).toBe(1);
  });
});
