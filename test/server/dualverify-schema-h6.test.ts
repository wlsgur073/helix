// H6 wiring (the post-close half) + the DV-STAKES-OMIT description residue: the tool SURFACE must
// carry what the handler already honours. The proof-of-read mechanism (7f05232..20786a6) resolves
// declared { id, contentDigest } pairs against the ledger and exempts them from the memory-echo
// guard — but until the registered inputSchema admits `quotedMemory`, the SDK's zod layer strips
// the field before the handler sees it, so a caller's declaration is silently discarded and the
// observable is an echo refusal that still lists the proven record. These tests therefore run
// through the REGISTERED schema (client.callTool over the in-memory transport), never the handler
// directly: the schema is exactly the layer under test.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStore } from '../../src/memory/store.js';
import { buildServer } from '../../src/server/helix-server.js';
import { digestContent } from '../../src/memory/ledger-mac.js';
import { MAX_DV_QUOTED_ITEMS } from '../../src/limits.js';
import type { LedgerItem } from '../../src/risk/trifecta.js';
import type { MetricsSink } from '../../src/metrics.js';

const MEMO = 'the deploy uses the blue cluster in us-east-1'; // >= k=24 normalized chars
const item = (id: string, content: string): LedgerItem => ({ id, content, contentDigest: digestContent(content) });
const textOf = (res: unknown): string =>
  ((res as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('');

/** Counts every handler entry (same observable as schema-bound-precedes-handler.test.ts): a
 *  schema refusal must leave no op behind, while a handler-level refusal records one. */
function countingSink(): MetricsSink & { ops: string[] } {
  const ops: string[] = [];
  return {
    ops,
    emitReplay: () => {},
    emitCompaction: () => {},
    runOp: async <T,>(tool: string, fn: () => T | Promise<T>): Promise<T> => { ops.push(tool); return await fn(); },
  };
}

async function connected(sink?: MetricsSink): Promise<Client> {
  const home = mkdtempSync(join(tmpdir(), 'helix-h6s-'));
  const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1' });
  const server = buildServer(store, {
    // Echo-armed dual-verify deps: enabled, floor 'low' so an explicit stakes passes, echo leg
    // enforcing over one known record, and a runner that answers so a cleared call visibly RUNS.
    config: { dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'low', model: 'gpt-5.5', effort: 'high', timeoutMs: 120_000, egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block', secretEntropyExempt: 'allow' }, logContent: false }, persistence: { releaseWordChains: true }, metrics: { enabled: true } },
    runner: async () => ({ ok: true, answer: 'agreed' }),
    checkAvailable: async () => ({ available: true }),
    echo: { mode: 'enforce', ledgerTexts: () => [item('m_1', MEMO)] },
    auditPath: join(mkdtempSync(join(tmpdir(), 'helix-h6s-audit-')), 'audit.jsonl'),
    codexLogPath: join(mkdtempSync(join(tmpdir(), 'helix-h6s-clog-')), 'codex-log.jsonl'),
  }, sink);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'h6-schema-test', version: '0' });
  await client.connect(ct);
  return client;
}

const quotingArgs = (quoted: boolean): Record<string, unknown> => ({
  question: `restate: ${MEMO}`,
  helixAnswer: 'ok',
  stakes: 'high',
  ...(quoted ? { quotedMemory: [{ id: 'm_1', contentDigest: digestContent(MEMO) }] } : {}),
});

describe('helix_dual_verify carries the H6 quotedMemory declaration on its registered schema', () => {
  // Non-vacuity control (passes before AND after the fix): without a declaration the echo leg is
  // armed and refuses, listing the matched record. If this stops holding, the admission test below
  // proves nothing.
  it('control: the same call without a declaration is refused with the record listed', async () => {
    const client = await connected();
    const out = textOf(await client.callTool({ name: 'helix_dual_verify', arguments: quotingArgs(false) }));
    expect(out).toContain('echoed memories (not sent):');
    expect(out).toContain('m_1');
  });

  it('a declaration on the WIRE reaches the guard: the proven record is exempted and the call runs', async () => {
    const client = await connected();
    const out = textOf(await client.callTool({ name: 'helix_dual_verify', arguments: quotingArgs(true) }));
    // Pre-fix: the SDK strips the unknown key, the declaration never reaches classifyEgress, and
    // this call is refused exactly like the control. Post-fix: the echo leg exempts m_1 (nothing
    // else matched), the egress verdict is pass, and the call proceeds to the runner and reports a
    // verdict. (Which verdict is the ALIGNER's business — a zero-pair comparison is honestly
    // `indeterminate`, never `agree` — so only the verdict line's presence is asserted here.)
    expect(out).not.toContain('echoed memories (not sent):');
    expect(out).toContain('egress: pass');
    expect(out).toContain('verdict:');
  });

  it('an oversized declaration is refused by the schema WITHOUT entering the handler', async () => {
    const sink = countingSink();
    const client = await connected(sink);
    const over = Array.from({ length: MAX_DV_QUOTED_ITEMS + 1 }, (_, i) => ({ id: `m_${i}`, contentDigest: digestContent(String(i)) }));
    const res = await client.callTool({ name: 'helix_dual_verify', arguments: { ...quotingArgs(false), quotedMemory: over } });
    expect((res as { isError?: boolean }).isError, 'an oversized quotedMemory array was accepted').toBe(true);
    expect(sink.ops, 'the handler ran — the bound is not enforced at the schema').not.toContain('helix_dual_verify');
  });

  // Bound non-vacuity (passes pre-fix only by accident of stripping; pins the cap from the admit
  // side post-fix): a declaration AT the cap must still reach the handler.
  it('a declaration at the cap reaches the handler', async () => {
    const sink = countingSink();
    const client = await connected(sink);
    const atCap = Array.from({ length: MAX_DV_QUOTED_ITEMS }, (_, i) => ({ id: `m_${i}`, contentDigest: digestContent(String(i)) }));
    await client.callTool({ name: 'helix_dual_verify', arguments: { ...quotingArgs(false), quotedMemory: atCap } });
    expect(sink.ops).toContain('helix_dual_verify');
  });
});

describe('helix_dual_verify description matches the shipped behaviour', () => {
  it('names the omitted-stakes default (DV-STAKES-OMIT residue)', async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    const dv = tools.find((t) => t.name === 'helix_dual_verify')!;
    expect(dv.description).toMatch(/omitted stakes counts as 'low'/i);
  });

  it('names quotedMemory as a proof of read feeding the echo exemption', async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    const dv = tools.find((t) => t.name === 'helix_dual_verify')!;
    expect(dv.description).toMatch(/quotedMemory/);
    expect(dv.description).toMatch(/proof of read/i);
  });
});
