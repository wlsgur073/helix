import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';

// The as-of cursor is compared against each record's `tx` (asof.ts: `r.tx <= t`), and BOTH sides
// used to come from the wall clock: `tx` from the store's default `now()`, the cursor from a bare
// `new Date().toISOString()` taken just after the commit. That is only safe while the clock moves
// forward — and on this project's primary platform (WSL2) it does not: the same non-monotonicity
// that destabilizes the cross-process lock tests can hand back an EARLIER instant across a
// scheduling boundary, putting the just-committed fact outside its own window. `find()` then
// returns undefined and a non-null `!` turns that into an opaque TypeError instead of a grade
// assertion. Every test below therefore drives the store's clock explicitly and reads at a cursor
// one millisecond later, so membership is decided by the fixture rather than by the host.
const T = '2026-06-09T00:00:01.000Z';
const AFTER_T = '2026-06-09T00:00:01.001Z';

describe('store.asOfView (spec C §5)', () => {
  it('reconstructs the global-scope snapshot at t with grade + evidence', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-asof-'));
    const store = new MemoryStore(join(home, 'memory.jsonl'), { sessionId: 's', home, now: () => T });
    const a = store.commit({ content: 'fact', source: 'user' });
    store.confirm(a.id); // genuine v2 verify (canonical clock)
    const view = store.asOfView(AFTER_T);
    const f = view.facts.find((x) => x.record.id === a.id);
    expect(f, 'the committed fact must be inside its own as-of window').toBeDefined();
    expect(f!.scope).toBe('global');
    expect(f!.grade).toBe('Verified');
    expect(f!.evidence.length).toBeGreaterThanOrEqual(1);
    expect(f!.evidence.some((e) => e.winner && e.txAuthenticated)).toBe(true);
    expect(view.keyAvailable).toBe(true);
  });

  it('flags truncated when a compaction tombstone is present', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-asof-'));
    const ledger = join(home, 'memory.jsonl');
    const ts = '2026-07-01T00:00:00.000Z'; // content-free horizon tombstone => truncated heuristic fires
    const store = new MemoryStore(ledger, { sessionId: 's', home, now: () => ts });
    store.commit({ content: 'fact', source: 'user' });
    appendFileSync(ledger, JSON.stringify({ id: 'horizon_x', tx: ts, validFrom: ts, validTo: null,
      type: 'verify', state: 'Suspect', content: '', provenance: { source: 'user', sessionId: 'compaction' },
      supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' }) + '\n');
    expect(store.asOfView('2026-07-01T00:00:00.001Z').truncated).toBe(true);
  });

  it('excludes a verify minted at tx > t (store-layer membership window, M4)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-asof-'));
    let clock = '2026-06-09T00:00:01.000Z';
    const store = new MemoryStore(join(home, 'memory.jsonl'), { sessionId: 's', home, now: () => clock });
    const a = store.commit({ content: 'fact', source: 'user' }); // assert tx = 00:01
    clock = '2026-06-09T00:00:05.000Z';
    store.confirm(a.id);                                          // verify tx = 00:05, gen 1 Verified
    // as-of 00:03: the fact is live (assert 00:01 <= 00:03) but the verify (00:05) is NOT yet minted.
    const early = store.asOfView('2026-06-09T00:00:03.000Z').facts.find((x) => x.record.id === a.id);
    expect(early, 'the assert predates the cursor, so the fact must be live at 00:03').toBeDefined();
    expect(early!.grade).toBe('Fresh');   // no verify in-window
    expect(early!.evidence).toEqual([]);  // the tx>t verify is excluded at the store layer
    // sanity: as-of 00:09 the SAME verify IS in-window -> Verified, proving 00:03 is genuine window-exclusion
    // (not an invalid verify). Discriminating: dropping the tx<=t filter grades 00:03 Verified -> fails.
    const late = store.asOfView('2026-06-09T00:00:09.000Z').facts.find((x) => x.record.id === a.id);
    expect(late, 'the fact must still be live at 00:09').toBeDefined();
    expect(late!.grade).toBe('Verified');
  });

  it('aggregate keyAvailable is false when a scope has no master key (M4)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-asof-'));
    const store = new MemoryStore(join(home, 'memory.jsonl'), { sessionId: 's', home, now: () => T });
    const a = store.commit({ content: 'fact', source: 'user' }); // committed, never confirmed
    // W-T5 note: the commit's OWN witnessed append now mints the master key too (advanceWitness MACs
    // the witness entry via the same ensureMaster) — force genuine absence to exercise M4.
    rmSync(join(home, 'ledger-mac-master.key'));
    const view = store.asOfView(AFTER_T);
    expect(view.keyAvailable).toBe(false);                                       // aggregate reflects the keyless scope
    const f = view.facts.find((x) => x.record.id === a.id);
    expect(f, 'the committed fact must be inside its own as-of window').toBeDefined();
    expect(f!.grade).toBe('Fresh');                                              // key-absent clamps every grade Fresh
  });
});
