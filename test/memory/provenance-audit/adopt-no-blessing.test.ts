import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { MemoryStore } from '../../../src/memory/store.js';
import type { MemoryRecord } from '../../../src/types.js';

const CLK = '2026-07-01T00:00:00.000Z';
const seededVerified = (id: string): MemoryRecord => ({
  id, tx: CLK, validFrom: CLK, validTo: null, type: 'assert', state: 'Verified',
  content: 'pre-seeded elevated', provenance: { source: 'user-relayed', sessionId: 'x' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
});

describe('probe (a): adopt() blesses nothing pre-existing', () => {
  it('a pre-seeded Verified assert in an unowned ledger replays Fresh even after adopt()', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-a-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-a-proj-'));
    const global = join(home, 'memory.jsonl');
    const projLedger = join(root, '.helix', 'memory.jsonl');
    mkdirSync(dirname(projLedger), { recursive: true });
    writeFileSync(projLedger, JSON.stringify(seededVerified('planted')) + '\n');

    const store = new MemoryStore(global, {
      sessionId: 's', home, now: () => CLK, genId: () => 'm_1',
      project: { ledger: projLedger, root, home },
    });
    store.adopt(); // stamps ownership + ensures master; must NOT sign the planted row
    const live = store.inspect().find((s) => s.record.id === 'planted');
    expect(live?.record.state).toBe('Fresh'); // clamped: no valid MAC exists for it
  });
});
