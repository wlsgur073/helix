import { describe, it, expect } from 'vitest';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { parseLedger } from '../../../src/memory/ledger.js';
import type { MemoryRecord } from '../../../src/types.js';
import { projectStore } from './_shared.js';

describe('probe: permanent erase of a project marker routes to the project ledger', () => {
  it('erasing integrity_marker with scope:project targets the project ledger, not global', () => {
    const { store, global, projLedger } = projectStore();
    // Seed a canonical marker SHAPE into the PROJECT ledger (verify-shaped, null target, no mac).
    const marker: MemoryRecord = {
      id: 'integrity_marker', tx: '2026-07-01T00:00:00.000Z', validFrom: '2026-07-01T00:00:00.000Z',
      validTo: null, type: 'verify', state: 'Verified', content: '',
      provenance: { source: 'user', sessionId: 's' }, supersedes: null,
      blastRadius: null, reverifyTrigger: null, classification: 'normal',
    };
    appendFileSync(projLedger, JSON.stringify(marker) + '\n');

    const globalBefore = existsSync(global) ? readFileSync(global, 'utf8') : '';
    store.erase('integrity_marker', { permanent: true, scope: 'project' });
    const globalAfter = existsSync(global) ? readFileSync(global, 'utf8') : '';

    // The marker must be gone from the PROJECT ledger; global must be unaffected (it had none).
    const projHasMarker = parseLedger(projLedger).some((r) => r.id.startsWith('integrity_'));
    expect(projHasMarker).toBe(false);
    expect(globalAfter).toBe(globalBefore);           // global ledger untouched
  });
});
