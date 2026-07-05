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

  it('excludes a verify minted at tx > t (store-layer membership window, M4)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-asof-'));
    let clock = '2026-06-09T00:00:01.000Z';
    const store = new MemoryStore(join(home, 'memory.jsonl'), { sessionId: 's', home, now: () => clock });
    const a = store.commit({ content: 'fact', source: 'user' }); // assert tx = 00:01
    clock = '2026-06-09T00:00:05.000Z';
    store.confirm(a.id);                                          // verify tx = 00:05, gen 1 Verified
    // as-of 00:03: the fact is live (assert 00:01 <= 00:03) but the verify (00:05) is NOT yet minted.
    const early = store.asOfView('2026-06-09T00:00:03.000Z').facts.find((x) => x.record.id === a.id)!;
    expect(early.grade).toBe('Fresh');   // no verify in-window
    expect(early.evidence).toEqual([]);  // the tx>t verify is excluded at the store layer
    // sanity: as-of 00:09 the SAME verify IS in-window -> Verified, proving 00:03 is genuine window-exclusion
    // (not an invalid verify). Discriminating: dropping the tx<=t filter grades 00:03 Verified -> fails.
    expect(store.asOfView('2026-06-09T00:00:09.000Z').facts.find((x) => x.record.id === a.id)!.grade).toBe('Verified');
  });

  it('aggregate keyAvailable is false when a scope has no master key (M4)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-asof-'));
    const store = new MemoryStore(join(home, 'memory.jsonl'), { sessionId: 's', home });
    const a = store.commit({ content: 'fact', source: 'user' }); // committed, NEVER confirmed -> no master key minted
    const view = store.asOfView(new Date().toISOString());
    expect(view.keyAvailable).toBe(false);                                       // aggregate reflects the keyless scope
    expect(view.facts.find((x) => x.record.id === a.id)!.grade).toBe('Fresh');   // key-absent clamps every grade Fresh
  });
});
