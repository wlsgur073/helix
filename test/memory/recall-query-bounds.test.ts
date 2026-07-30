import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { MAX_QUERY_CHARS, MAX_QUERY_TERMS } from '../../src/memory/retrieval.js';

// helix_memory_recall is ALWAYS on the agent tool surface with no configuration behind it, and
// ranking costs O(distinct query terms x live records). An uncapped `query` was therefore the most
// directly injection-reachable way to wedge the single-threaded MCP server: at the README's own
// 2,000-row scale advisory a 50,000-term query blocked every other tool call for tens of seconds.
// The bound REJECTS rather than truncates — a silently shortened query would answer a question the
// caller did not ask, which is worse than an error.
const seed = (): MemoryStore => {
  const home = mkdtempSync(join(tmpdir(), 'helix-qbounds-'));
  const store = new MemoryStore(join(home, 'memory.jsonl'), { sessionId: 's', home });
  store.commit({ content: 'staging runs postgres sixteen on port five four three three', source: 'user' });
  return store;
};

describe('recall query bounds', () => {
  it('serves a normal query unchanged', () => {
    const store = seed();
    expect(store.recall('postgres staging port').items.length).toBeGreaterThan(0);
  });

  it('rejects a query past the character bound instead of truncating it', () => {
    const store = seed();
    const long = 'a'.repeat(MAX_QUERY_CHARS + 1);
    expect(() => store.recall(long)).toThrow(/too long/i);
    // The bound is inclusive: exactly at the limit is still served.
    expect(() => store.recall('b'.repeat(MAX_QUERY_CHARS))).not.toThrow();
  });

  it('rejects a query past the distinct-term bound', () => {
    const store = seed();
    // Distinct terms, each short enough that the whole query still fits the character bound — which
    // is exactly why the character bound alone is insufficient and both have to bind.
    const terms = Array.from({ length: MAX_QUERY_TERMS + 1 }, (_, i) => `t${i}`).join(' ');
    expect(terms.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(() => store.recall(terms)).toThrow(/distinct terms/i);
  });

  it('counts DISTINCT terms, so a repetitive query is not penalised', () => {
    const store = seed();
    const repeated = Array.from({ length: MAX_QUERY_TERMS + 50 }, () => 'postgres').join(' ');
    expect(repeated.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(() => store.recall(repeated)).not.toThrow();
  });
});
