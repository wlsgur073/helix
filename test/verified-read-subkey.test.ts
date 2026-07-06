import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MemoryRecord } from '../src/types.js';
import { ensureMaster } from '../src/memory/ledger-mac.js';
import { subkeyForScope, verifiedLiveOf, verifiedProjectionWithSubkey } from '../src/memory/verified-read.js';

function assertRec(id: string): MemoryRecord {
  return {
    id, tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content: `c-${id}`,
    provenance: { source: 'user', sessionId: 't' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  };
}

describe('verifiedProjectionWithSubkey', () => {
  it('with the resolved subkey equals verifiedLiveOf (parity)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-vpsub-'));
    try {
      ensureMaster(home);
      const records = [assertRec('a'), assertRec('b')];
      const sub = subkeyForScope(home);
      const viaSub = verifiedProjectionWithSubkey(records, sub);
      const viaLive = verifiedLiveOf(records, home);
      expect([...viaSub.live.keys()].sort()).toEqual([...viaLive.live.keys()].sort());
      expect(viaSub.keyAvailable).toBe(viaLive.keyAvailable);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('with a null subkey clamps every state to Fresh and reports key-absent', () => {
    const proj = verifiedProjectionWithSubkey([assertRec('a')], null);
    expect(proj.keyAvailable).toBe(false);
    expect([...proj.live.values()].every((r) => r.state === 'Fresh')).toBe(true);
  });
});
