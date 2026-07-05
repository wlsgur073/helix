import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStore } from '../../src/memory/store.js';
import { buildServer } from '../../src/server/helix-server.js';
import { createMetricsSink } from '../../src/metrics.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

describe('server op wrapper (spec §5, §9.5)', () => {
  // The brief's tests mutate process.env.HELIX_HOME in-process; no sibling harness does, so none
  // restores it either. Restore it after each test so a leaked temp dir can't flake another file.
  const priorHome = process.env.HELIX_HOME;
  afterEach(() => {
    if (priorHome === undefined) delete process.env.HELIX_HOME;
    else process.env.HELIX_HOME = priorHome;
  });

  it('a recall through the server emits one op record and joined replay records', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-srv-'));
    process.env.HELIX_HOME = home; // isolate the no-deps fallback too
    const captured: string[] = [];
    const sink = createMetricsSink(join(home, 'metrics.jsonl'), true, {
      append: (_p, line) => captured.push(line),
      genId: () => 'o_fixed',
    });
    const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't', metricsSink: sink });
    store.commit({ content: 'the api runs on port 3000', source: 'user' });
    captured.length = 0;

    // Typed deps mirror the sibling e2e harness (no `as never` casts); the dual-verify legs are
    // never reached by recall, so hermetic disabled/unused values suffice. Behavioral assertions
    // below are exactly as briefed.
    const server = buildServer(store, {
      config: DEFAULT_CONFIG,
      runner: async () => ({ ok: false, error: 'unused' }),
      checkAvailable: async () => ({ available: false, reason: 'unused' }),
      echo: { mode: 'disabled' },
      auditPath: join(home, 'audit.jsonl'),
      codexLogPath: join(home, 'codex-log.jsonl'),
    }, sink);

    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([client.connect(ct), server.connect(st)]);
    await client.callTool({ name: 'helix_memory_recall', arguments: { query: 'api port' } });

    const rows = captured.map((l) => JSON.parse(l) as Record<string, unknown>);
    const op = rows.find((r) => r.kind === 'op')!;
    const replays = rows.filter((r) => r.kind === 'replay');
    expect(op).toMatchObject({ 'gen_ai.tool.name': 'helix_memory_recall', ok: true, op_id: 'o_fixed' });
    expect(replays.length).toBeGreaterThanOrEqual(1);
    for (const r of replays) expect(r.op_id).toBe('o_fixed');
    const phaseSum = replays.reduce((s, r) => s + (r.parse_ms as number) + (r.project_ms as number), 0);
    expect((op.duration_ms as number)).toBeGreaterThanOrEqual(phaseSum - 5); // epsilon (spec §9.5)
    await client.close();
    await server.close();
  });

  it('buildServer without a sink still serves (noop default)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-srv-'));
    process.env.HELIX_HOME = home;
    const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't' });
    const server = buildServer(store); // no deps, no metrics
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const res = await client.callTool({ name: 'helix_memory_inspect', arguments: {} });
    expect(res).toBeTruthy();
    await client.close();
    await server.close();
  });
});
