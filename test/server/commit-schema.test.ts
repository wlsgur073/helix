// Issue #8: every helix_memory_commit input says what it means, read from the schema a host actually gets
// from tools/list, and `classification` is no longer an input: its one non-default value, 'personal', had
// no effect anywhere in Helix.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStore } from '../../src/memory/store.js';
import { buildServer } from '../../src/server/helix-server.js';

function store(): MemoryStore {
  const home = mkdtempSync(join(tmpdir(), 'helix-i8-'));
  return new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1' });
}

async function connected(s: MemoryStore): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'i8', version: '0' });
  await Promise.all([client.connect(ct), buildServer(s).connect(st)]);
  return client;
}

async function commitProperties(): Promise<Record<string, { description?: string }>> {
  const client = await connected(store());
  const { tools } = await client.listTools();
  const commit = tools.find((t) => t.name === 'helix_memory_commit');
  expect(commit, 'helix_memory_commit is listed').toBeDefined();
  return (commit!.inputSchema as { properties: Record<string, { description?: string }> }).properties;
}

describe('helix_memory_commit inputs (issue #8)', () => {
  it('every input carries a description', async () => {
    const props = await commitProperties();
    const bare = Object.entries(props).filter(([, p]) => typeof p.description !== 'string' || p.description.trim() === '').map(([k]) => k);
    expect(bare).toEqual([]);
  });

  it('classification is no longer an input', async () => {
    expect(Object.keys(await commitProperties())).not.toContain('classification');
  });

  it('a classification sent anyway changes nothing: the fact is stored as normal', async () => {
    const s = store();
    const client = await connected(s);
    const result = await client.callTool({
      name: 'helix_memory_commit',
      arguments: { content: 'staging runs postgres 16', source: 'user', classification: 'personal' },
    });
    expect(result.isError ?? false).toBe(false);
    const [only] = s.inspect();
    expect(only?.record.content).toBe('staging runs postgres 16');
    expect(only?.record.classification).toBe('normal');
  });
});
