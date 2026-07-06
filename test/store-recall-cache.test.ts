import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../src/memory/store.js';
import { noopMetricsSink, type MetricsSink } from '../src/metrics.js';

function newHome(): string { return mkdtempSync(join(tmpdir(), 'helix-recallcache-')); }

describe('MemoryStore recall cache', () => {
  it('warm recall returns the same items as the cold recall', () => {
    const home = newHome();
    try {
      const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't' });
      store.commit({ content: 'deploy timeout config', source: 'user' });
      store.commit({ content: 'branch release commit', source: 'user' });
      const cold = store.recall('timeout').items.map((i) => i.record.id);
      const warm = store.recall('timeout').items.map((i) => i.record.id);
      expect(cold.length).toBe(1);
      expect(warm).toEqual(cold);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a HIT skips the verifying replay (no replay metric on the second identical-state recall)', () => {
    const home = newHome();
    try {
      const box = { replays: 0 };
      const sink: MetricsSink = { ...noopMetricsSink, emitReplay: () => { box.replays += 1; } };
      const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't', metricsSink: sink });
      store.commit({ content: 'deploy timeout config', source: 'user' });
      store.recall('timeout');           // MISS -> emits >=1 replay
      const afterCold = box.replays;
      expect(afterCold).toBeGreaterThanOrEqual(1);
      store.recall('timeout');           // HIT -> no replay
      store.recall('config');            // HIT (same state, different query) -> no replay
      expect(box.replays).toBe(afterCold);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('framing nonce is fresh per call even on a HIT (I7)', () => {
    const home = newHome();
    try {
      const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't' });
      store.commit({ content: 'deploy timeout config', source: 'user' });
      const a = store.recall('timeout').framed;
      const b = store.recall('timeout').framed;   // HIT
      expect(a).not.toBe(b);                       // different nonce -> different framed block
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
