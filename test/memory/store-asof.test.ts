import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';

describe('store.asOfView (spec C §5)', () => {
  it('reconstructs the global-scope snapshot at t with grade + evidence', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-asof-'));
    const store = new MemoryStore(join(home, 'memory.jsonl'), { sessionId: 's', home });
    const a = store.commit({ content: 'fact', source: 'user' });
    store.confirm(a.id); // genuine v2 verify (canonical clock)
    const now = new Date().toISOString();
    const view = store.asOfView(now);
    const f = view.facts.find((x) => x.record.id === a.id)!;
    expect(f.scope).toBe('global');
    expect(f.grade).toBe('Verified');
    expect(f.evidence.length).toBeGreaterThanOrEqual(1);
    expect(f.evidence.some((e) => e.winner && e.txAuthenticated)).toBe(true);
    expect(view.keyAvailable).toBe(true);
  });

  it('flags truncated when a compaction tombstone is present', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-asof-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    store.commit({ content: 'fact', source: 'user' });
    const ts = '2026-07-01T00:00:00.000Z'; // content-free horizon tombstone => truncated heuristic fires
    appendFileSync(ledger, JSON.stringify({ id: 'horizon_x', tx: ts, validFrom: ts, validTo: null,
      type: 'verify', state: 'Suspect', content: '', provenance: { source: 'user', sessionId: 'compaction' },
      supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' }) + '\n');
    expect(store.asOfView(new Date().toISOString()).truncated).toBe(true);
  });
});
