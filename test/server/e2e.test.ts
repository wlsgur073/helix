import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStore } from '../../src/memory/store.js';
import { buildServer } from '../../src/server/helix-server.js';
import {
  MAX_COMMIT_CONTENT_CHARS, MAX_DV_QUESTION_CHARS, MAX_DV_ANSWER_CHARS,
  MAX_RECHECK_PATH_CHARS, MAX_RECHECK_PATTERN_CHARS,
} from '../../src/limits.js';
import type { MetricsSink } from '../../src/metrics.js';

// Optional metrics sink (H3 schema-precedes-handler case below): every other caller omits it and
// gets the same server as before (buildServer defaults to noopMetricsSink), so this is additive.
async function connectedClient(metrics?: MetricsSink): Promise<Client> {
  const home = mkdtempSync(join(tmpdir(), 'helix-e2e-'));
  const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1' });
  const server = buildServer(store, {
    // Hermetic dual-verify deps: disabled + a runner that must never be called,
    // so the e2e suite never touches real Codex regardless of any on-disk config.
    config: { dualVerify: { enabled: false, mode: 'compare', stakesFloor: 'high', model: 'gpt-5.5', effort: 'high', timeoutMs: 120_000, egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block', secretEntropyExempt: 'allow' }, logContent: false }, persistence: { releaseWordChains: true }, metrics: { enabled: true } },
    runner: async () => ({ ok: false, error: 'should-not-run-in-tests' }),
    checkAvailable: async () => ({ available: false, reason: 'test' }),
    echo: { mode: 'disabled' },
    auditPath: join(mkdtempSync(join(tmpdir(), 'helix-e2e-audit-')), 'audit.jsonl'),
    codexLogPath: join(mkdtempSync(join(tmpdir(), 'helix-e2e-clog-')), 'codex-log.jsonl'),
  }, metrics);
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

  it('helix_memory_adopt description states adoption is an explicit user decision and must not be allow-listed (D3)', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const adopt = tools.find((t) => t.name === 'helix_memory_adopt')!;
    expect(adopt.description).toMatch(/explicit user (instruction|approval)/i);
    expect(adopt.description).toMatch(/do not allow-list/i);
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

  it('accepts source=agent-test-verified and stores it as non-authoritative (needs re-verify)', async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: 'helix_memory_commit',
      arguments: { content: 'the scoped sweep passes on node 24', source: 'agent-test-verified' },
    });
    expect(res.isError).toBeFalsy();
    // Non-authoritative: the recall must carry the re-verify note — proof the mechanically-verified
    // label did NOT elevate trust past the boundary.
    const out = textOf(await client.callTool({ name: 'helix_memory_recall', arguments: { query: 'scoped sweep node 24' } }));
    expect(out).toContain('the scoped sweep passes on node 24');
    expect(out).toMatch(/needs re-verify before acting/);
  });

  it('rejects an out-of-enum source string at the tool boundary (zod, previously untested)', async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: 'helix_memory_commit', arguments: { content: 'x', source: 'made-up-source' },
    });
    expect(res.isError).toBe(true);
  });

  it('a legal at-cap commit runs the handler and registers its op, so the rejection below is not a silent sink (H3)', async () => {
    // Non-vacuity leg for the case below (mirrors schema-bound-precedes-handler.test.ts:51-55, the
    // N2-QUERY-DOS.c "reaches the handler" case): through the SAME sink-wired client, a legal
    // commit at exactly the cap must reach the handler and be recorded, or the over-cap case's
    // "not in ops" assertion below could pass for the wrong reason -- e.g. if connectedClient's
    // metrics sink ever silently stopped reaching buildServer, ops would stay empty regardless of
    // whether the schema, the handler, or nothing at all ran.
    const ops: string[] = [];
    const sink: MetricsSink = {
      emitReplay: () => {},
      emitCompaction: () => {},
      runOp: async (tool, fn) => { ops.push(tool); return await fn(); },
    };
    const client = await connectedClient(sink);
    const res = await client.callTool({
      name: 'helix_memory_commit',
      arguments: { content: 'x'.repeat(MAX_COMMIT_CONTENT_CHARS), source: 'user' },
    });
    expect(res.isError, 'a legal at-cap commit was rejected').toBeFalsy();
    expect(ops, 'the handler ran and its op should be recorded by the sink').toContain('helix_memory_commit');
  });

  it('rejects an over-cap commit content at the schema, BEFORE the handler runs (H3)', async () => {
    // Mirrors N2-QUERY-DOS.c (schema-bound-precedes-handler.test.ts): "the call fails" does not
    // discriminate schema rejection from the store's own throw, since both fail today. What
    // discriminates them is WHETHER the handler ran at all -- a counting metrics sink is the
    // observable, since runOp (and its audit/timing side effects) only wraps an entered handler.
    const ops: string[] = [];
    const sink: MetricsSink = {
      emitReplay: () => {},
      emitCompaction: () => {},
      runOp: async (tool, fn) => { ops.push(tool); return await fn(); },
    };
    const client = await connectedClient(sink);
    const res = await client.callTool({
      name: 'helix_memory_commit',
      arguments: { content: 'x'.repeat(MAX_COMMIT_CONTENT_CHARS + 1), source: 'user' },
    });
    expect(res.isError, 'an over-cap commit was accepted').toBe(true);
    expect(ops, 'the handler ran, so the bound was enforced inside rather than at the boundary').not.toContain('helix_memory_commit');
  });

  // H3: dual-verify's question/helixAnswer caps. `stakes: 'high'` is declared explicitly on every
  // call below (matching connectedClient's stakesFloor: 'high') so an omitted-stakes floor refusal
  // can never be mistaken for the schema bound under test -- connectedClient's dualVerify.enabled
  // is false regardless, so every accepted call is gated out at the 'enabled' step (no spawn, no
  // egress check reached), but the schema validation these tests probe runs BEFORE that gate.
  it('a legal at-cap dual_verify call runs the handler and registers its op (H3)', async () => {
    const ops: string[] = [];
    const sink: MetricsSink = {
      emitReplay: () => {},
      emitCompaction: () => {},
      runOp: async (tool, fn) => { ops.push(tool); return await fn(); },
    };
    const client = await connectedClient(sink);
    const res = await client.callTool({
      name: 'helix_dual_verify',
      arguments: { question: 'q'.repeat(MAX_DV_QUESTION_CHARS), helixAnswer: 'a'.repeat(MAX_DV_ANSWER_CHARS), stakes: 'high' },
    });
    expect(res.isError, 'a legal at-cap dual_verify call was rejected').toBeFalsy();
    expect(ops, 'the handler ran and its op should be recorded by the sink').toContain('helix_dual_verify');
  });

  it('rejects an over-cap dual_verify question at the schema, BEFORE the handler runs (H3)', async () => {
    const ops: string[] = [];
    const sink: MetricsSink = {
      emitReplay: () => {},
      emitCompaction: () => {},
      runOp: async (tool, fn) => { ops.push(tool); return await fn(); },
    };
    const client = await connectedClient(sink);
    const res = await client.callTool({
      name: 'helix_dual_verify',
      arguments: { question: 'q'.repeat(MAX_DV_QUESTION_CHARS + 1), helixAnswer: 'a', stakes: 'high' },
    });
    expect(res.isError, 'an over-cap dual_verify question was accepted').toBe(true);
    expect(ops, 'the handler ran, so the bound was enforced inside rather than at the boundary').not.toContain('helix_dual_verify');
  });

  it('rejects an over-cap dual_verify helixAnswer at the schema, BEFORE the handler runs (H3)', async () => {
    const ops: string[] = [];
    const sink: MetricsSink = {
      emitReplay: () => {},
      emitCompaction: () => {},
      runOp: async (tool, fn) => { ops.push(tool); return await fn(); },
    };
    const client = await connectedClient(sink);
    const res = await client.callTool({
      name: 'helix_dual_verify',
      arguments: { question: 'q', helixAnswer: 'a'.repeat(MAX_DV_ANSWER_CHARS + 1), stakes: 'high' },
    });
    expect(res.isError, 'an over-cap dual_verify helixAnswer was accepted').toBe(true);
    expect(ops, 'the handler ran, so the bound was enforced inside rather than at the boundary').not.toContain('helix_dual_verify');
  });

  // H3: recheck's check.path/check.pattern caps. The positive control commits an item whose content
  // literally contains the at-cap path AND pattern strings, so store.recheck's checkBinding gate
  // passes and the call returns cleanly (isError false) -- not just "reached the handler while
  // throwing", the same clean-success bar Task 3's commit positive control set.
  it('a legal at-cap recheck call runs the handler and registers its op (H3)', async () => {
    const ops: string[] = [];
    const sink: MetricsSink = {
      emitReplay: () => {},
      emitCompaction: () => {},
      runOp: async (tool, fn) => { ops.push(tool); return await fn(); },
    };
    const client = await connectedClient(sink);
    const path = 'p'.repeat(MAX_RECHECK_PATH_CHARS);
    const pattern = 'q'.repeat(MAX_RECHECK_PATTERN_CHARS);
    const committed = await client.callTool({
      name: 'helix_memory_commit', arguments: { content: path + pattern, source: 'user' },
    });
    const id = /"id":"(m_[^"]+)"/.exec(textOf(committed))?.[1];
    expect(id).toBeTruthy();
    const res = await client.callTool({
      name: 'helix_memory_recheck',
      arguments: { id, check: { kind: 'file-contains', path, pattern } },
    });
    expect(res.isError, 'a legal at-cap recheck call was rejected').toBeFalsy();
    expect(ops, 'the handler ran and its op should be recorded by the sink').toContain('helix_memory_recheck');
  });

  it('rejects an over-cap recheck check.path at the schema, BEFORE the handler runs (H3)', async () => {
    const ops: string[] = [];
    const sink: MetricsSink = {
      emitReplay: () => {},
      emitCompaction: () => {},
      runOp: async (tool, fn) => { ops.push(tool); return await fn(); },
    };
    const client = await connectedClient(sink);
    const res = await client.callTool({
      name: 'helix_memory_recheck',
      arguments: { id: 'm_test', check: { kind: 'file-contains', path: 'p'.repeat(MAX_RECHECK_PATH_CHARS + 1), pattern: 'q' } },
    });
    expect(res.isError, 'an over-cap recheck check.path was accepted').toBe(true);
    expect(ops, 'the handler ran, so the bound was enforced inside rather than at the boundary').not.toContain('helix_memory_recheck');
  });

  it('rejects an over-cap recheck check.pattern at the schema, BEFORE the handler runs (H3)', async () => {
    const ops: string[] = [];
    const sink: MetricsSink = {
      emitReplay: () => {},
      emitCompaction: () => {},
      runOp: async (tool, fn) => { ops.push(tool); return await fn(); },
    };
    const client = await connectedClient(sink);
    const res = await client.callTool({
      name: 'helix_memory_recheck',
      arguments: { id: 'm_test', check: { kind: 'file-contains', path: 'p', pattern: 'q'.repeat(MAX_RECHECK_PATTERN_CHARS + 1) } },
    });
    expect(res.isError, 'an over-cap recheck check.pattern was accepted').toBe(true);
    expect(ops, 'the handler ran, so the bound was enforced inside rather than at the boundary').not.toContain('helix_memory_recheck');
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
