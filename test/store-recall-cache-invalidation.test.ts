import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../src/memory/store.js';
import { noopMetricsSink, type MetricsSink } from '../src/metrics.js';

function newHome(): string { return mkdtempSync(join(tmpdir(), 'helix-inval-')); }
function ids(store: MemoryStore, q: string): string[] { return store.recall(q).items.map((i) => i.record.id); }

describe('recall cache invalidation matrix', () => {
  it('append (commit) is reflected on the next recall', () => {
    const home = newHome();
    try {
      const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't' });
      store.commit({ content: 'deploy timeout config', source: 'user' });
      expect(ids(store, 'retry')).toEqual([]);          // warm the cache; nothing matches "retry"
      store.commit({ content: 'retry backoff policy', source: 'user' });
      expect(ids(store, 'retry').length).toBe(1);        // MISS -> new fact visible
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('soft erase is reflected on the next recall', () => {
    const home = newHome();
    try {
      const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't' });
      const r = store.commit({ content: 'deploy timeout config', source: 'user' });
      expect(ids(store, 'timeout').length).toBe(1);      // warm
      store.erase(r.id);
      expect(ids(store, 'timeout')).toEqual([]);          // gone (self-erase cleared the slot)
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('ADVERSARIAL: a same-length in-place edit with mtime restored is NOT served from cache (I1/I2)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = new MemoryStore(ledger, { home, sessionId: 't' });
      store.commit({ content: 'deploy timeout config', source: 'user' });
      expect(ids(store, 'timeout').length).toBe(1);       // warm the cache

      // Adversary: change the fact's content in place, SAME byte length, and restore mtime.
      const before = statSync(ledger);
      const text = readFileSync(ledger, 'utf8');
      const edited = text.replace('timeout', 'backoff');  // 7 chars -> 7 chars, file length unchanged
      expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(text));
      writeFileSync(ledger, edited);
      utimesSync(ledger, before.atime, before.mtime);     // forge the timestamp back
      expect(statSync(ledger).size).toBe(before.size);    // size unchanged too

      // A metadata-keyed cache would HIT and still return the fact for "timeout".
      // The content-digest key MUST miss and re-read the edited bytes:
      expect(ids(store, 'timeout')).toEqual([]);           // no longer matches -> cache saw the edit
      expect(ids(store, 'backoff').length).toBe(1);        // the new content is what recall ranks
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('master-key change re-grades on the next recall (fingerprint flip)', () => {
    const home = newHome();
    try {
      const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't' });
      const r = store.commit({ content: 'deploy timeout config', source: 'user' });
      store.confirm(r.id);                                 // signed verify -> elevated grade
      const graded = store.recall('timeout').items[0]!.record.state;
      expect(graded).not.toBe('Fresh');                    // warm cache holds the elevated grade
      // Remove the master key: the same ledger bytes now replay key-absent (all Fresh).
      rmSync(join(home, 'ledger-mac-master.key'), { force: true });
      expect(store.recall('timeout').items[0]!.record.state).toBe('Fresh');  // fingerprint sentinel -> miss -> re-grade
      expect(store.recall('timeout').integrityAvailable).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('I4: losing project ownership drops project-scope rows on the next recall (fresh isOwned per call)', () => {
    const home = newHome();
    const proj = mkdtempSync(join(tmpdir(), 'helix-inval-proj-'));
    try {
      const store = new MemoryStore(join(home, 'memory.jsonl'),
        { home, sessionId: 't', project: { ledger: join(proj, '.helix', 'memory.jsonl'), root: proj, home } });
      store.commit({ content: 'deploy timeout config', scope: 'project', source: 'user' }); // claims ownership
      expect(ids(store, 'timeout').length).toBe(1);        // warm: project row present
      // Revoke ownership by dropping the home registry entry -> isOwned() flips to false.
      rmSync(join(home, 'projects.json'), { force: true });
      expect(ids(store, 'timeout')).toEqual([]);           // project scope no longer participates (key shrinks -> MISS)
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
  });

  it('I4: adopting a foreign project ledger includes its rows on the next recall', () => {
    const home = newHome();
    const proj = mkdtempSync(join(tmpdir(), 'helix-inval-proj-'));
    try {
      // Foreign (unowned) project ledger present: a plain Fresh assert, no ownership stamp.
      mkdirSync(join(proj, '.helix'), { recursive: true });
      writeFileSync(join(proj, '.helix', 'memory.jsonl'),
        JSON.stringify({ id: 'm_foreign', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z',
          validTo: null, type: 'assert', state: 'Fresh', content: 'deploy timeout config',
          provenance: { source: 'user', sessionId: 'x' }, supersedes: null, blastRadius: null,
          reverifyTrigger: null, classification: 'normal' }) + '\n');
      const store = new MemoryStore(join(home, 'memory.jsonl'),
        { home, sessionId: 't', project: { ledger: join(proj, '.helix', 'memory.jsonl'), root: proj, home } });
      expect(ids(store, 'timeout')).toEqual([]);           // warm: unowned project ignored on read
      store.adopt();                                       // trust the project ledger's current contents
      expect(ids(store, 'timeout').length).toBe(1);        // key grows to include project -> MISS -> row included
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
  });

  it('I6: the cache does not survive store reconstruction (a second store starts cold -> replay)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store1 = new MemoryStore(ledger, { home, sessionId: 't' });
      store1.commit({ content: 'deploy timeout config', source: 'user' });
      expect(ids(store1, 'timeout').length).toBe(1);       // warm store1's per-instance slot
      // A second store over the SAME ledger must build its OWN projection, not reuse store1's slot;
      // a module/global cache would let it HIT with zero replay.
      const box = { replays: 0 };
      const sink: MetricsSink = { ...noopMetricsSink, emitReplay: () => { box.replays += 1; } };
      const store2 = new MemoryStore(ledger, { home, sessionId: 't', metricsSink: sink });
      expect(ids(store2, 'timeout').length).toBe(1);
      expect(box.replays).toBeGreaterThanOrEqual(1);       // cold: it replayed (did not inherit a warm slot)
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
