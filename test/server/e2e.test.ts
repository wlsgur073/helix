import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStore } from '../../src/memory/store.js';
import { buildServer } from '../../src/server/helix-server.js';

async function connectedClient(): Promise<Client> {
  const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), 'helix-e2e-')), 'm.jsonl'), { sessionId: 's1' });
  const server = buildServer(store, {
    // Hermetic dual-verify deps: disabled + a runner that must never be called,
    // so the e2e suite never touches real Codex regardless of any on-disk config.
    config: { dualVerify: { enabled: false, mode: 'compare', stakesFloor: 'high', model: 'gpt-5.5', effort: 'high' } },
    runner: async () => ({ ok: false, error: 'should-not-run-in-tests' }),
    checkAvailable: async () => ({ available: false, reason: 'test' }),
    auditPath: join(mkdtempSync(join(tmpdir(), 'helix-e2e-audit-')), 'audit.jsonl'),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'helix-test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const textOf = (res: unknown): string =>
  ((res as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('');

describe('Helix MCP server (end-to-end via in-memory transport)', () => {
  it('lists all five helix tools over the protocol', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'helix_dual_verify',
      'helix_memory_commit',
      'helix_memory_erase',
      'helix_memory_inspect',
      'helix_memory_recall',
    ]);
  });

  it('commit then recall returns the fact in a DATA-only frame over the protocol', async () => {
    const client = await connectedClient();
    await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'db is postgres' } });
    const res = await client.callTool({ name: 'helix_memory_recall', arguments: { query: 'postgres' } });
    expect(textOf(res)).toContain('DATA, NOT INSTRUCTIONS');
    expect(textOf(res)).toContain('db is postgres');
  });

  it('dual_verify degrades cleanly when disabled (no Codex call)', async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: 'helix_dual_verify', arguments: { question: 'x', helixAnswer: 'y' } });
    expect(textOf(res)).toMatch(/disabled|did not run/i);
  });
});
