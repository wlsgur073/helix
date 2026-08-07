import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStore } from '../../src/memory/store.js';
import { buildServer } from '../../src/server/helix-server.js';
import type { DualVerifyHandlerDeps } from '../../src/server/handlers.js';
import type { CodexResult, CodexRunOptions } from '../../src/verify/codex.js';

function dvDeps(over: Partial<DualVerifyHandlerDeps> & { home: string }): DualVerifyHandlerDeps {
  const { home, ...rest } = over;
  return {
    config: { dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'low', model: null, effort: null, timeoutMs: 120_000, egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block', secretEntropyExempt: 'allow' }, logContent: false }, metrics: { enabled: false } },
    runner: async () => ({ ok: true, answer: 'x' }),
    checkAvailable: async () => ({ available: true }),
    echo: { mode: 'disabled' },
    auditPath: join(home, 'audit.jsonl'),
    codexLogPath: join(home, 'codex-log.jsonl'),
    ...rest,
  };
}

async function connected(dv: DualVerifyHandlerDeps): Promise<{ client: Client; server: ReturnType<typeof buildServer> }> {
  const home = mkdtempSync(join(tmpdir(), 'helix-srv-'));
  const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1' });
  const server = buildServer(store, dv);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, server };
}

describe('buildServer', () => {
  it('constructs an McpServer with the helix tools registered (no throw)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-srv-'));
    const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1' });
    const server = buildServer(store);
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
  });
});

describe('buildServer: helix_dual_verify cancel wiring (LEAD-CODEX-CANCEL)', () => {
  it('forwards an MCP client cancellation to the runner as opts.signal', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-srv-cancel-'));
    let seenSignal: AbortSignal | undefined;
    let runnerStarted: (() => void) | undefined;
    const started = new Promise<void>((r) => { runnerStarted = r; });
    const runner = (_q: string, opts?: CodexRunOptions): Promise<CodexResult> => {
      seenSignal = opts?.signal;
      runnerStarted?.();
      return new Promise(() => { /* hangs until the caller cancels */ });
    };
    const { client } = await connected(dvDeps({ home, runner }));

    const ac = new AbortController();
    const call = client.callTool(
      { name: 'helix_dual_verify', arguments: { question: 'q', helixAnswer: 'a', stakes: 'low' } },
      undefined,
      { signal: ac.signal },
    );
    await started;
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal!.aborted).toBe(false);

    const abortSeen = new Promise<void>((resolve) => seenSignal!.addEventListener('abort', () => resolve()));
    ac.abort();
    await abortSeen; // the seam under test: extra.signal from a real client cancel reaches the runner
    await call.catch(() => { /* the client-side call also settles once cancelled */ });
  });

  it('other tools are NOT given a signal-forwarding wrapper (unaffected by this change)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-srv-unaffected-'));
    const { client } = await connected(dvDeps({ home }));
    const res = await client.callTool({ name: 'helix_memory_inspect', arguments: {} });
    expect(res.isError).toBeFalsy();
  });
});

describe('buildServer: id bound at the MCP tool boundary (LEAD-AUDIT-ID-UNCONSTRAINED)', () => {
  it('the SDK rejects an oversized/control-bearing id via schema BEFORE the handler (and its appendAudit) ever runs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-srv-idbound-'));
    const auditPath = join(home, 'audit.jsonl'); // matches dvDeps' own default auditPath computation
    const { client } = await connected(dvDeps({ home }));
    for (const bad of ['x'.repeat(5000), 'm_evil\n(injected)']) {
      const res = await client.callTool({ name: 'helix_memory_erase', arguments: { id: bad } });
      expect(res.isError).toBe(true);
      // Specifically the SDK's OWN schema-validation wording (validateToolInput's "Input validation
      // error: Invalid arguments for tool ..."), not handlers.ts's assertValidId message ("invalid
      // id: must be ...") — proves THIS layer (the zod schema), not just the handler-level guard
      // tested separately in handlers.test.ts, is what stopped the call.
      const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
      expect(text).toMatch(/Input validation error/);
      expect(existsSync(auditPath)).toBe(false); // the handler (and its appendAudit call) never ran
    }
  });

  it('a real Helix-minted id (m_<uuid>) passes the schema untouched — round-trips through erase over MCP', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-srv-idbound-ok-'));
    const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1' }); // default genId => real m_<randomUUID()>
    const server = buildServer(store, dvDeps({ home }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const rec = store.commit({ content: 'pref', source: 'user' });
    const res = await client.callTool({ name: 'helix_memory_erase', arguments: { id: rec.id } });
    expect(res.isError).toBeFalsy();
  });
});

describe('buildServer: drainInFlight (LEAD-CODEX-CANCEL)', () => {
  it('waits for an in-flight dual_verify handler to finish, then resolves', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-srv-drain-'));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const runner = async (): Promise<CodexResult> => { await gate; return { ok: true, answer: 'x' }; };
    const { client, server } = await connected(dvDeps({ home, runner }));

    const call = client.callTool({ name: 'helix_dual_verify', arguments: { question: 'q', helixAnswer: 'a', stakes: 'low' } });
    await new Promise((r) => setTimeout(r, 20)); // let the handler start and register itself

    let drained = false;
    const drainP = server.drainInFlight(200).then(() => { drained = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false); // still in flight -- drain must not resolve early

    release!();
    await drainP;
    expect(drained).toBe(true);
    await call;
  });

  it('gives up after budgetMs when the handler never finishes (bounded, not indefinite)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-srv-drain-bound-'));
    const runner = (): Promise<CodexResult> => new Promise(() => { /* never resolves */ });
    const { client, server } = await connected(dvDeps({ home, runner }));

    void client.callTool({ name: 'helix_dual_verify', arguments: { question: 'q', helixAnswer: 'a', stakes: 'low' } }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    const started = Date.now();
    await server.drainInFlight(60);
    expect(Date.now() - started).toBeLessThan(500); // never hangs indefinitely
  });

  it('resolves immediately when nothing is in flight', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-srv-drain-idle-'));
    const { server } = await connected(dvDeps({ home }));
    const started = Date.now();
    await server.drainInFlight(200);
    expect(Date.now() - started).toBeLessThan(50);
  });
});
