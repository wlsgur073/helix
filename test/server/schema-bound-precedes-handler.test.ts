// N2-QUERY-DOS.c — the character bound is declared at the MCP BOUNDARY as well as enforced in the
// store, so an oversized query is refused by schema validation before any handler runs.
//
// The store's own bound (retrieval.ts, MAX_QUERY_CHARS) already makes an oversized recall fail, so
// "the call fails" does not discriminate between the two enforcement points. What separates them is
// WHERE it fails: with the schema bound the handler is never entered, so no op is timed, no metrics
// row is emitted and no audit side effect runs; without it the handler runs and throws from inside.
// A metrics sink counting runOp calls is therefore the observable, not the error itself.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStore } from '../../src/memory/store.js';
import { buildServer } from '../../src/server/helix-server.js';
import { MAX_QUERY_CHARS } from '../../src/memory/retrieval.js';
import type { MetricsSink } from '../../src/metrics.js';

/** Counts every handler entry. runOp still runs the handler, so behaviour is unchanged. */
function countingSink(): MetricsSink & { ops: string[] } {
  const ops: string[] = [];
  return {
    ops,
    emitReplay: () => {},
    emitCompaction: () => {},
    runOp: async <T,>(tool: string, fn: () => T | Promise<T>): Promise<T> => { ops.push(tool); return await fn(); },
  };
}

async function recallOfLength(n: number): Promise<{ ops: string[]; failed: boolean }> {
  const home = mkdtempSync(join(tmpdir(), 'helix-qdos-'));
  const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1' });
  const sink = countingSink();
  const server = buildServer(store, undefined, sink);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'qdos', version: '0' });
  await Promise.all([client.connect(ct), server.connect(st)]);

  let failed = false;
  try {
    const res = await client.callTool({ name: 'helix_memory_recall', arguments: { query: 'q'.repeat(n) } });
    failed = res.isError === true;
  } catch { failed = true; }
  return { ops: sink.ops, failed };
}

describe('the recall query bound is declared at the MCP boundary (N2-QUERY-DOS.c)', () => {
  // Non-vacuity: a query AT the bound must reach the handler, or "no op recorded" below would be
  // satisfied by the tool simply never working.
  it('a query at the limit reaches the handler', async () => {
    const { ops, failed } = await recallOfLength(MAX_QUERY_CHARS);
    expect(failed, 'a query exactly at the limit was refused').toBe(false);
    expect(ops).toContain('helix_memory_recall');
  }, 30_000);

  it('a query one character over the limit is refused WITHOUT entering the handler', async () => {
    const { ops, failed } = await recallOfLength(MAX_QUERY_CHARS + 1);
    expect(failed, 'an oversized query was accepted').toBe(true);
    // The point of the leg: dropping .max() from the schema leaves the store's throw as the only
    // guard, and the handler — with its metrics and audit side effects — runs before it fires.
    expect(ops, 'the handler ran, so the bound was enforced inside rather than at the boundary').not.toContain('helix_memory_recall');
  }, 30_000);
});
