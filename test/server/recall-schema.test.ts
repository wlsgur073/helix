// Issue #9: helix_memory_recall says before the call that up to three of the newest records can follow the
// ranked matches, read from the schema a host actually gets from tools/list, and `recencyAppendix: false`
// returns the ranked matches alone, so that `maxItems` bounds the whole response.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStore } from '../../src/memory/store.js';
import { buildServer } from '../../src/server/helix-server.js';

function store(): MemoryStore {
  const home = mkdtempSync(join(tmpdir(), 'helix-i9-'));
  return new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1' });
}

async function connected(s: MemoryStore): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'i9', version: '0' });
  await Promise.all([client.connect(ct), buildServer(s).connect(st)]);
  return client;
}

type Listed = { description?: string; inputSchema: { properties: Record<string, { type?: string; description?: string }>; required?: string[] } };

async function recallTool(): Promise<Listed> {
  const client = await connected(store());
  const { tools } = await client.listTools();
  const recall = tools.find((t) => t.name === 'helix_memory_recall');
  expect(recall, 'helix_memory_recall is listed').toBeDefined();
  return recall as Listed;
}

const text = (r: unknown): string =>
  ((r as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('');
const records = (t: string): number => (t.match(/^PROOF\[/gm) ?? []).length;

// The issue's own facts: one shares the query's words, five share none.
const MATCHING = 'The alpha build tool on this machine needs the flag --offline.';
const OTHERS = [
  'Bravo: the printer on the second floor needs the legacy driver.',
  'Charlie: the staging database is restored every Monday morning.',
  'Delta: screenshots time out in the headless browser here.',
  'Echo: the package registry mirror is reachable only over the VPN.',
  'Foxtrot: the linter config lives in the repository root.',
];

describe('helix_memory_recall inputs (issue #9)', () => {
  it('maxItems gives its default and says that up to three of the newest records can follow the matches', async () => {
    const { maxItems } = (await recallTool()).inputSchema.properties;
    expect(maxItems?.description).toMatch(/\(default 20\)/);
    expect(maxItems?.description).toMatch(/up to 3 of the newest records the ranking did not return/);
    expect(maxItems?.description).toMatch(/up to maxItems \+ 3 records/);
  });

  // The description types the default out; the ranker's own default lives in retrieval.ts. This holds them equal.
  it('maxItems omitted ranks at most 20 matches, the default its description names', () => {
    const s = store();
    for (let i = 0; i < 25; i++) s.commit({ content: `alpha build note number ${i}`, source: 'user' });
    expect(s.recall('alpha build note').items).toHaveLength(20);
  });

  it('recencyAppendix is an optional boolean that says what false does', async () => {
    const { inputSchema } = await recallTool();
    expect(inputSchema.properties.recencyAppendix?.type).toBe('boolean');
    expect(inputSchema.required ?? []).not.toContain('recencyAppendix');
    expect(inputSchema.properties.recencyAppendix?.description).toMatch(/^Set to false to get the ranked matches alone, so that maxItems bounds the whole response\./);
  });

  it('the tool description mentions the appendix before the call', async () => {
    expect((await recallTool()).description).toMatch(/up to 3 of the newest other records unless recencyAppendix is false/);
    expect((await recallTool()).description).toMatch(/names them in a trailing note with the time each record carries/);
  });

  it('recencyAppendix false returns the ranked matches alone, so maxItems bounds the response', async () => {
    const s = store();
    s.commit({ content: MATCHING, source: 'agent-inference' });
    for (const content of OTHERS) s.commit({ content, source: 'agent-inference' });
    const client = await connected(s);
    const byDefault = text(await client.callTool({ name: 'helix_memory_recall', arguments: { query: 'alpha build tool', maxItems: 1 } }));
    const alone = text(await client.callTool({ name: 'helix_memory_recall', arguments: { query: 'alpha build tool', maxItems: 1, recencyAppendix: false } }));
    expect(records(byDefault)).toBe(4);
    expect(byDefault).toContain('recency appendix');
    expect(records(alone)).toBe(1);
    expect(alone).toContain(MATCHING);
    expect(alone).not.toContain('recency appendix');
  });
});
