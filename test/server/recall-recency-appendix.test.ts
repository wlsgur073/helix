// H1: ranking has no recency component, so the newest records lose to older, longer entries by
// lexical gating — a fact sharing no literal term with the query is UNREACHABLE (mechanism
// confirmed by experiment in the channel's 07-12 entry; 9-entry thread, merge doc 2026-08-10).
// The repair is an APPENDIX, not score blending: recall returns the newest few stored records
// alongside the lexical matches, regardless of rank, and discloses them in a trusted out-of-frame
// note (safeId — handlers.ts round-3 taxonomy). Score blending was rejected because a wall-clock
// decay term would break the A4 rank cache's determinism (the inspect-asof backward-clock lesson);
// the appendix is a pure function of the already-read served set and (since issue #9) the call's clock,
// so a cache HIT serves it too.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
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

  // Issue #9: a caller can turn the appendix off for one call, so that maxItems bounds the response.
  it('recencyAppendix false returns the ranked items alone, with no appendix note', () => {
    const store = storeWith([RANKED_OLD, RANKED_MID, NEWEST_DISJOINT]);
    const out = text(handleRecall(store, { query: 'postgres schema', recencyAppendix: false }));
    expect(out).toContain(RANKED_OLD);
    expect(out).toContain(RANKED_MID);
    expect(out).not.toContain(NEWEST_DISJOINT);
    expect(out).not.toContain('recency appendix');
  });

  it('recencyAppendix true keeps the appendix, as when it is omitted', () => {
    const store = storeWith([RANKED_OLD, RANKED_MID, NEWEST_DISJOINT]);
    const out = text(handleRecall(store, { query: 'postgres schema', recencyAppendix: true }));
    expect(out).toContain(NEWEST_DISJOINT);
    expect(out).toMatch(/recency appendix/);
  });

  it('with recencyAppendix false no trailing note names a record the appendix would have carried', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-h1-'));
    const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1' });
    store.commit({ content: RANKED_OLD, source: 'user' });
    // agent-inference is always flagged for re-verification, so by default its id is in two notes.
    const newest = store.commit({ content: NEWEST_DISJOINT, source: 'agent-inference' });
    expect(text(handleRecall(store, { query: 'postgres schema' }))).toMatch(new RegExp(`needs re-verify before acting: ${newest.id}`));
    expect(text(handleRecall(store, { query: 'postgres schema', recencyAppendix: false }))).not.toContain(newest.id);
  });
});

/** A store whose clock the test sets: commits stamp `clock.t`, and a recall reads it as the call's time. */
function clockedStore(): { store: MemoryStore; path: string; clock: { t: string } } {
  const home = mkdtempSync(join(tmpdir(), 'helix-h1-'));
  const path = join(home, 'm.jsonl');
  const clock = { t: '2026-10-08T05:42:04.416Z' };
  return { store: new MemoryStore(path, { home, sessionId: 's1', now: () => clock.t }), path, clock };
}

/** Appends a copy of the ledger's last fact row under a new id, content and tx, written raw, as a row written
 *  by hand into an adopted ledger would be. */
function plantRow(path: string, id: string, content: string, tx: string): void {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  appendFileSync(path, JSON.stringify({ ...JSON.parse(lines[lines.length - 1]!), id, content, tx }) + '\n');
}

// Issue #9, its 2026-10-12 comment: the appendix's "newest" records can be days old on a quiet ledger, and
// nothing showed how old they were. The note now names each one with the time it carries ("dated": a fact
// row's tx carries no MAC, so the note does not call it a commit time). Found while answering it: a
// record dated later than the call held the first appendix slot on every recall, since the order is by tx.
describe('issue #9 follow-up: the time each appendix record carries, and records dated after the call', () => {
  it('the recency note names each appendix record with the time it carries', () => {
    const { store, clock } = clockedStore();
    store.commit({ content: RANKED_OLD, source: 'user' });
    clock.t = '2026-10-08T06:48:09.000Z';
    const newest = store.commit({ content: NEWEST_DISJOINT, source: 'user' });
    clock.t = '2026-10-12T04:52:00.000Z';
    expect(text(handleRecall(store, { query: 'postgres schema' })))
      .toContain(`(recency appendix — newest records included regardless of rank: ${newest.id} (dated 2026-10-08T06:48:09.000Z))`);
  });

  it('a record dated more than five minutes after the call takes no appendix slot, and takes one from five minutes before its time', () => {
    const { store, clock } = clockedStore();
    store.commit({ content: RANKED_OLD, source: 'user' });
    clock.t = '2026-10-09T00:00:00.000Z';
    const later = store.commit({ content: NEWEST_DISJOINT, source: 'user' });
    clock.t = '2026-10-08T23:54:59.999Z';   // five minutes and one millisecond before the record's time
    expect(text(handleRecall(store, { query: 'postgres schema' }))).not.toContain(later.id);
    clock.t = '2026-10-08T23:55:00.000Z';   // exactly five minutes before: inside the tolerance
    expect(text(handleRecall(store, { query: 'postgres schema' }))).toContain(`${later.id} (dated 2026-10-09T00:00:00.000Z)`);
  });

  // The step measured on the WSL2 machine (2026-10-24): Date.now() fell back about 0.78 s every ~32 s, and a
  // record committed just before such a step lost its slot until the tolerance existed (one full-suite failure).
  it('a backward clock step like the one measured (780 ms) does not withhold a record just committed', () => {
    const { store, clock } = clockedStore();
    store.commit({ content: RANKED_OLD, source: 'user' });
    clock.t = '2026-10-24T02:43:01.453Z';
    const just = store.commit({ content: NEWEST_DISJOINT, source: 'user' });
    clock.t = '2026-10-24T02:43:00.673Z';
    expect(text(handleRecall(store, { query: 'postgres schema' }))).toContain(`${just.id} (dated 2026-10-24T02:43:01.453Z)`);
  });

  it('a far-future row written into the ledger by hand takes no appendix slot, however many records follow it', () => {
    const { store, path } = clockedStore();
    store.commit({ content: RANKED_OLD, source: 'user' });
    plantRow(path, 'm_planted_future', 'the kettle whistles when tea is ready', '2999-01-01T00:00:00.000Z');
    for (const c of ['the lantern battery lasts four hours', 'rain is forecast for tuesday afternoon', NEWEST_DISJOINT]) store.commit({ content: c, source: 'user' });
    const out = text(handleRecall(store, { query: 'postgres schema' }));
    expect(out).not.toContain('m_planted_future');
    expect(out).not.toContain('kettle whistles');
    expect(out).toContain(NEWEST_DISJOINT);
  });

  it('a far-future row that matches the query is still ranked: only the regardless-of-rank slot is refused', () => {
    const { store, path } = clockedStore();
    store.commit({ content: RANKED_OLD, source: 'user' });
    plantRow(path, 'm_planted_future', 'the postgres schema backup runs nightly', '2999-01-01T00:00:00.000Z');
    const out = text(handleRecall(store, { query: 'postgres schema' }));
    expect(out).toContain('the postgres schema backup runs nightly');
    expect(out).not.toContain('recency appendix');   // both records rank, so no appendix is rendered at all
  });

  it('a row whose tx is not a canonical instant takes no appendix slot', () => {
    const { store, path } = clockedStore();
    store.commit({ content: RANKED_OLD, source: 'user' });
    plantRow(path, 'm_planted_badtx', 'the kettle whistles when tea is ready', '2026-10-08 05:42');
    const out = text(handleRecall(store, { query: 'postgres schema' }));
    expect(out).not.toContain('m_planted_badtx');
  });

  it('the note prints ?? for a time that is not a canonical instant', () => {
    const { store } = clockedStore();
    store.commit({ content: RANKED_OLD, source: 'user' });
    const real = store.recall('postgres schema');
    const bogus = { ...real.items[0]!, record: { ...real.items[0]!.record, id: 'm_bogus', tx: 'not-a-time' } };
    vi.spyOn(store, 'recall').mockReturnValue({ ...real, appendix: [bogus] });
    expect(text(handleRecall(store, { query: 'postgres schema' }))).toContain('m_bogus (dated ??)');
  });
});
