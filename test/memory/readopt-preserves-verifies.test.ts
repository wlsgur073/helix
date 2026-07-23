import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { parseLedger } from '../../src/memory/ledger.js';
import { verifiedLiveOf } from '../../src/memory/verified-read.js';

// The severe end of PR-1 (Codex round 1): re-adopting an already-owned project used to rotate its
// MAC nonce, so genuine verifies — signed under the old subkey — failed verification and the next
// compaction DELETED them as "forged" AND minted a durable false integrity marker. Restoring the
// registry afterward could not bring the deleted history back. This locks the fixed behavior.
describe('re-adoption preserves signed verifies through compaction (PR-1 deletion chain)', () => {
  it('keeps Verified records instead of deleting them + minting a false integrity marker', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-h-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-proj-'));
    const projLedger = join(root, '.helix', 'memory.jsonl');
    mkdirSync(join(root, '.helix'), { recursive: true });
    const store = new MemoryStore(join(home, 'memory.jsonl'), {
      sessionId: 's', home, project: { ledger: projLedger, root, home },
    });
    store.adopt();                                          // mint the project nonce (call it N1)
    const keep = store.commit({ content: 'keep me alpha', source: 'user' });
    store.confirm(keep.id);                                 // a genuine signed verify under N1
    const gone = store.commit({ content: 'erase me beta', source: 'user' });

    store.adopt();                                          // RE-adopt: must NOT rotate N1 -> a new nonce
    store.erase(gone.id, { permanent: true });             // permanent-erase compacts the project ledger

    const after = parseLedger(projLedger);
    // The genuine signed verify physically survives compaction (the bug dropped it as "forged").
    expect(after.some((r) => r.type === 'verify' && r.supersedes === keep.id)).toBe(true);
    // No FALSE integrity marker was minted from a bogus "forged verify" drop.
    expect(after.filter((r) => r.id.startsWith('integrity_'))).toHaveLength(0);
    // The fact still grades Verified under the preserved nonce.
    const proj = verifiedLiveOf(after, home, root);
    expect(proj.live.get(keep.id)!.state).toBe('Verified');
  });
});
