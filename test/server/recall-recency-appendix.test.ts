// H1: ranking has no recency component, so the newest records lose to older, longer entries by
// lexical gating — a fact sharing no literal term with the query is UNREACHABLE (mechanism
// confirmed by experiment in the channel's 07-12 entry; 9-entry thread, merge doc 2026-08-10).
// The repair is an APPENDIX, not score blending: recall returns the newest few stored records
// alongside the lexical matches, regardless of rank, and discloses them in a trusted out-of-frame
// note (safeId — handlers.ts round-3 taxonomy). Score blending was rejected because a wall-clock
// decay term would break the A4 rank cache's determinism (the inspect-asof backward-clock lesson);
// the appendix is a pure function of the already-read served set, so a cache HIT serves it too.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { handleRecall } from '../../src/server/handlers.js';

const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? '').join('');

/** Commit order = age order (first = oldest). All records land in global scope. */
function storeWith(contents: string[]): MemoryStore {
  const home = mkdtempSync(join(tmpdir(), 'helix-h1-'));
  const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1' });
  for (const c of contents) store.commit({ content: c, source: 'user' });
  return store;
}

// Two records sharing the query's vocabulary, then a newest record sharing NO term with it — and
// none of the disjoint contents contain the query tokens' semantic neighbors ('schema' expands to
// scm/scs/sc/sca only; 'postgres' to nothing), so lexical+semantic rank cannot reach them.
const RANKED_OLD = 'postgres schema owns the users table';
const RANKED_MID = 'the postgres schema migration runs at deploy';
const NEWEST_DISJOINT = 'the codex retry budget is three attempts';

describe('H1: recall appends the newest records regardless of rank', () => {
  it('the newest record is returned even when it shares no term with the query', () => {
    const store = storeWith([RANKED_OLD, RANKED_MID, NEWEST_DISJOINT]);
    const out = text(handleRecall(store, { query: 'postgres schema' }));
    expect(out).toContain(NEWEST_DISJOINT);
  });

  it('the trusted out-of-frame note names the appendix ids', () => {
    const store = storeWith([RANKED_OLD, RANKED_MID, NEWEST_DISJOINT]);
    const out = text(handleRecall(store, { query: 'postgres schema' }));
    expect(out).toMatch(/\(recency appendix — newest records included regardless of rank: m_[^)]+\)/);
  });

  it('a rank-cache hit still serves the appendix (second identical call)', () => {
    const store = storeWith([RANKED_OLD, RANKED_MID, NEWEST_DISJOINT]);
    text(handleRecall(store, { query: 'postgres schema' })); // populate the A4 rank-cache slot
    const out = text(handleRecall(store, { query: 'postgres schema' }));
    expect(out).toContain(NEWEST_DISJOINT);
    expect(out).toMatch(/recency appendix/);
  });

  it('control: no appendix note when every stored record already ranks', () => {
    const store = storeWith([RANKED_OLD, RANKED_MID]);
    const out = text(handleRecall(store, { query: 'postgres schema' }));
    expect(out).not.toContain('recency appendix');
  });

  it('a newest record that already ranks is not duplicated by the appendix', () => {
    const store = storeWith([RANKED_OLD, RANKED_MID]);
    const out = text(handleRecall(store, { query: 'postgres' }));
    expect(out.split('migration runs at deploy').length - 1).toBe(1);
  });

  it('the appendix carries at most the three NEWEST non-ranked records', () => {
    const store = storeWith([
      RANKED_OLD,
      'the kettle whistles when tea is ready',      // oldest disjoint — must NOT appear
      'rain is forecast for tuesday afternoon',     // second-oldest disjoint — must NOT appear
      'the oven preheats to two hundred degrees',
      NEWEST_DISJOINT,
      'the lantern battery lasts four hours',
    ]);
    const out = text(handleRecall(store, { query: 'postgres schema' }));
    expect(out).toContain('the oven preheats to two hundred degrees');
    expect(out).toContain(NEWEST_DISJOINT);
    expect(out).toContain('the lantern battery lasts four hours');
    expect(out).not.toContain('kettle whistles');
    expect(out).not.toContain('rain is forecast');
  });
});
