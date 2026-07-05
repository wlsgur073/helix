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
    config: { dualVerify: { enabled: false, mode: 'compare', stakesFloor: 'high', model: 'gpt-5.5', effort: 'high', timeoutMs: 120_000, egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block' }, logContent: false }, metrics: { enabled: true } },
    runner: async () => ({ ok: false, error: 'should-not-run-in-tests' }),
    checkAvailable: async () => ({ available: false, reason: 'test' }),
    echo: { mode: 'disabled' },
    auditPath: join(mkdtempSync(join(tmpdir(), 'helix-e2e-audit-')), 'audit.jsonl'),
    codexLogPath: join(mkdtempSync(join(tmpdir(), 'helix-e2e-clog-')), 'codex-log.jsonl'),
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
  it('lists all nine helix tools over the protocol', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'helix_codex_status',
      'helix_dual_verify',
      'helix_memory_adopt',
      'helix_memory_commit',
      'helix_memory_confirm',
      'helix_memory_erase',
      'helix_memory_inspect',
      'helix_memory_recall',
      'helix_memory_recheck',
    ]);
  });

  it('helix_memory_confirm description states it requires explicit user approval', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const confirm = tools.find((t) => t.name === 'helix_memory_confirm')!;
    expect(confirm.description).toMatch(/requires explicit user approval/i);
    expect(confirm.description).toMatch(/never self-confirm|do not self-confirm/i);
  });

  it('confirm promotes a source=user item to Verified over the protocol', async () => {
    const client = await connectedClient();
    const committed = await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'deploy target is fly.io', source: 'user' } });
    const id = /"id":"(m_[^"]+)"/.exec(textOf(committed))?.[1];
    expect(id).toBeTruthy();
    const confirmed = await client.callTool({ name: 'helix_memory_confirm', arguments: { id } });
    expect(textOf(confirmed)).toMatch(/Verified/);
    const inspected = textOf(await client.callTool({ name: 'helix_memory_inspect', arguments: {} }));
    expect(inspected).toContain('[Verified:');
  });

  it('commit then recall returns the fact in a DATA-only frame over the protocol', async () => {
    const client = await connectedClient();
    await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'db is postgres', source: 'user' } });
    const res = await client.callTool({ name: 'helix_memory_recall', arguments: { query: 'postgres' } });
    expect(textOf(res)).toContain('DATA, NOT INSTRUCTIONS');
    expect(textOf(res)).toContain('db is postgres');
  });

  it('dual_verify degrades cleanly when disabled (no Codex call)', async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: 'helix_dual_verify', arguments: { question: 'x', helixAnswer: 'y' } });
    expect(textOf(res)).toMatch(/disabled|did not run/i);
  });

  it('rejects a commit with no source (required) and a verify-path source', async () => {
    const client = await connectedClient();
    const missing = await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'x' } });
    expect(missing.isError).toBe(true);
    const verifyPath = await client.callTool({
      name: 'helix_memory_commit', arguments: { content: 'x', source: 'reality-check' },
    });
    expect(verifyPath.isError).toBe(true);
  });

  it('accepts source=user-relayed and source=agent-inference and stores them as non-authoritative', async () => {
    const client = await connectedClient();
    const relayed = await client.callTool({
      name: 'helix_memory_commit', arguments: { content: 'pasted: the api base path is v2', source: 'user-relayed' },
    });
    expect(relayed.isError).toBeFalsy();
    const inferred = await client.callTool({
      name: 'helix_memory_commit', arguments: { content: 'i deduced the build runs on esbuild', source: 'agent-inference' },
    });
    expect(inferred.isError).toBeFalsy();
    // Both sources are non-authoritative, so the stored items recall WITH the re-verify note —
    // a behavioral assertion that the declared source survived the tool boundary (a user Fresh
    // item would carry no such note). The contents also round-trip through recall.
    const out = textOf(await client.callTool({ name: 'helix_memory_recall', arguments: { query: 'api base esbuild build' } }));
    expect(out).toContain('the api base path is v2');
    expect(out).toContain('the build runs on esbuild');
    expect(out).toMatch(/needs re-verify before acting/);
  });

  it('commit with supersedes replaces the prior item over the protocol (update, not duplicate)', async () => {
    const client = await connectedClient();
    const first = await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'the db is postgres', source: 'user' } });
    const id = /"id":"([^"]+)"/.exec(textOf(first))?.[1];
    expect(id).toBeTruthy();
    await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'the db is mysql', supersedes: id, source: 'user' } });
    const out = textOf(await client.callTool({ name: 'helix_memory_inspect', arguments: {} }));
    expect(out).toContain('the db is mysql');
    expect(out).not.toContain('postgres'); // the old item was superseded, not duplicated
  });
});
