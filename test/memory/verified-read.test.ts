import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { parseLedger } from '../../src/memory/ledger.js';
import { verifiedLive, verifiedLiveOf } from '../../src/memory/verified-read.js';
import type { MemoryRecord } from '../../src/types.js';

// verifiedLiveOf is the records-in CORE extracted from verifiedLive: it resolves the per-scope subkey
// from `home` and runs buildVerifiedProjection over an ALREADY-PARSED record array, so a caller (the
// store's historyView) can share ONE parseLedger between the verified projection and buildHistory.
// verifiedLive(ledger,…) must remain exactly verifiedLiveOf(parseLedger(ledger),…) — the single source
// of truth the store AND the SessionStart hook both route through (no trust-grade drift between them).

const forgedVerifiedAssert = (id: string): MemoryRecord => ({
  id, tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
  type: 'assert', state: 'Verified', content: 'forged elevated', provenance: { source: 'user', sessionId: 's' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
});

describe('verifiedLiveOf (records-in verifying projection)', () => {
  it('fail-closed: with no master key, a forged Verified assert clamps to Fresh', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-vlo-'));
    const out = verifiedLiveOf([forgedVerifiedAssert('a')], home);
    expect(out.keyAvailable).toBe(false);
    expect(out.live.get('a')!.state).toBe('Fresh');
  });

  it('parity: verifiedLiveOf(parseLedger(L)) equals verifiedLive(L) — the extract is behavior-preserving', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-vlo-'));
    const ledger = join(home, 'memory.jsonl');
    let n = 0;
    const store = new MemoryStore(ledger, {
      sessionId: 's', home, now: () => '2026-06-09T00:00:00.000Z', genId: () => `m_${++n}`,
    });
    const a = store.commit({ content: 'db is postgres', source: 'user' });
    store.confirm(a.id); // mints the master + signs a genuine Verified verify

    const viaPath = verifiedLive(ledger, home);
    const viaRecords = verifiedLiveOf(parseLedger(ledger), home);

    expect(viaRecords.keyAvailable).toBe(true);
    expect(viaRecords.live.get(a.id)!.state).toBe('Verified'); // records-in path elevates identically
    expect([...viaRecords.live.keys()].sort()).toEqual([...viaPath.live.keys()].sort());
    expect(viaRecords.live.get(a.id)!.state).toBe(viaPath.live.get(a.id)!.state);
  });
});
