import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import type { MetricsSink, ReplayInput } from '../../src/metrics.js';

function captureSink(): { sink: MetricsSink; replays: ReplayInput[] } {
  const replays: ReplayInput[] = [];
  return {
    replays,
    sink: {
      emitReplay: (r) => { replays.push(r); },
      emitCompaction: () => {},
      runOp: async (_t, fn) => await fn(),
    },
  };
}

describe('store metrics wiring (spec §5)', () => {
  it('recall emits >=1 store-caller replay records with real counts', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-sm-'));
    const ledger = join(home, 'memory.jsonl');
    const { sink, replays } = captureSink();
    const store = new MemoryStore(ledger, { home, sessionId: 't', metricsSink: sink });
    store.commit({ content: 'the deploy target is fly.io', source: 'user' });
    replays.length = 0; // commit's own reads are not under test
    store.recall('deploy target');
    expect(replays.length).toBeGreaterThanOrEqual(1);
    const r = replays[0]!;
    // A plain commit never mints the master, so the verifying read runs key-absent
    // (see history-store.test.ts "integrityAvailable is false ... true once a signing verify mints it").
    expect(r).toMatchObject({ scope: 'global', caller: 'store', keyAvailable: false });
    expect(r.rows).toBe(1);
    expect(r.liveRows).toBe(1);
    expect(r.bytes).toBeGreaterThan(0);
  });

  it('a missing ledger file emits a zero-row replay and never throws (spec §9.9)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-sm-'));
    const { sink, replays } = captureSink();
    const store = new MemoryStore(join(home, 'absent.jsonl'), { home, sessionId: 't', metricsSink: sink });
    expect(() => store.recall('anything')).not.toThrow();
    expect(replays[0]).toMatchObject({ rows: 0, liveRows: 0, bytes: 0, scope: 'global', caller: 'store' });
  });

  it('no sink (default) emits nothing and behavior is unchanged', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-sm-'));
    const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't' });
    store.commit({ content: 'plain fact', source: 'user' });
    expect(store.recall('plain').items).toHaveLength(1); // just works, no sink involved
  });
});
