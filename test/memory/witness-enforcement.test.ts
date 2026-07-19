// Task 7 — read-side witness enforcement: D1 authority clamp, D1b serve-with-note,
// transition-interrupted exclusion, and the witness-aware recall cache (spec
// 2026-07-17-high-water-counter-decision §4). Driven over a REAL MemoryStore + real ledger/witness
// files so a mis-threaded clamp, a wrong per-scope containment, or a cache that ignores the witness
// is observable end to end.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { handleRecall, handleInspect } from '../../src/server/handlers.js';
import {
  WITNESS_MISMATCH_NOTE, WITNESS_TRANSITION_NOTE, WITNESS_INIT_NOTE,
} from '../../src/memory/content-frame.js';
import {
  planTransition, openTransition, advanceWitness, readScopeWitness, scopeKeyOf,
} from '../../src/memory/witness-store.js';
import { witnessFenceRecord, readLedgerBytes } from '../../src/memory/ledger.js';
import { sha256Hex } from '../../src/memory/witness-core.js';
import { gatherScopedRecords } from '../../src/hooks/session-start.js';
import { formatSessionStartContext } from '../../src/hooks/format-context.js';
import type { MetricsSink, ReplayInput } from '../../src/metrics.js';

const FIXED = '2026-07-18T00:00:00.000Z';
const TEXT = (r: { content: Array<{ type: 'text'; text: string }> }): string => r.content.map((c) => c.text).join('');

function newHome(): string { return mkdtempSync(join(tmpdir(), 'helix-witenf-')); }

function makeStore(home: string): { store: MemoryStore; ledger: string } {
  const ledger = join(home, 'memory.jsonl');
  let n = 0;
  const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FIXED, genId: () => `m_${++n}` });
  return { store, ledger };
}

function captureSink(): { sink: MetricsSink; replays: ReplayInput[] } {
  const replays: ReplayInput[] = [];
  return {
    replays,
    sink: { emitReplay: (r) => { replays.push(r); }, emitCompaction: () => {}, runOp: async (_t, fn) => await fn() },
  };
}

/** Open an interrupted transition for `scopeKey`: journal a NEW head that never lands, leaving the
 *  ledger at its OLD bytes so classifyWitness returns transition-interrupted (spec §4.9, crash
 *  window A). Mirrors witness-rewrite.test.ts's R1-F2 recipe. */
function plantInterrupted(home: string, scopeKey: string, ledger: string, tx: string): void {
  const plan = planTransition(home, scopeKey, 'compaction');
  const targetText = readLedgerBytes(ledger).toString('utf8')
    + JSON.stringify(witnessFenceRecord(plan.epoch, plan.nonce, tx)) + '\n';
  const expected = { byteLength: Buffer.byteLength(targetText), prefixHash: sha256Hex(Buffer.from(targetText)) };
  openTransition(home, scopeKey, {
    kind: 'compaction', epoch: plan.epoch, nonce: plan.nonce, predecessor: plan.predecessor,
    supersedes: plan.supersedes, expected, tx,
  });
}

describe('Task 7 — read-side witness enforcement', () => {
  describe('mismatch → D1 clamp + D1b serve-with-note (asOf keeps grades)', () => {
    // Seed a genuine Verified row, witness it, then FORK the ledger tail (a plain assert that is NOT
    // the verify) with a same-length byte change. This makes the witness verdict `mismatch` while
    // keeping the Verified target's verify byte-identical — so the ONLY thing that can demote it on
    // recall is the D1 witness clamp, not R2/R3 (which would fire if we touched the verify itself).
    function forkedMismatch(): { store: MemoryStore; ledger: string; home: string; aId: string } {
      const home = newHome();
      const { store, ledger } = makeStore(home);
      const a = store.commit({ content: 'alpha target deploy fact', source: 'user' });
      store.confirm(a.id);                                                   // A → Verified, witnessed
      store.commit({ content: 'gamma tail filler UNIQUEFORKZ', source: 'user' }); // the fork victim (suffix)
      // sanity: in-sync, A is Verified before the fork
      const bytes = readLedgerBytes(ledger);
      const forked = Buffer.from(bytes.toString('utf8').replace('UNIQUEFORKZ', 'UNIQUEFORKY'), 'utf8');
      expect(forked.length).toBe(bytes.length);                             // same-length fork
      expect(forked.equals(bytes)).toBe(false);
      writeFileSync(ledger, forked);
      return { store, ledger, home, aId: a.id };
    }

    it('recall serves rows (D1b) but the previously-Verified row comes back Fresh (D1) with the mismatch note outside the frame', () => {
      const { store, home, aId } = forkedMismatch();
      try {
        const res = store.recall('alpha');
        const hitA = res.items.find((i) => i.record.id === aId)!;
        expect(hitA).toBeDefined();                       // D1b: still served
        expect(hitA.record.state).toBe('Fresh');          // D1: elevated grade clamped
        expect(res.witnessNotes).toContain(WITNESS_MISMATCH_NOTE);

        const out = TEXT(handleRecall(store, { query: 'alpha' }));
        const closeIdx = out.lastIndexOf('=== ');         // frame close marker prefix
        expect(out).toContain(WITNESS_MISMATCH_NOTE);
        expect(out.indexOf(WITNESS_MISMATCH_NOTE)).toBeGreaterThan(closeIdx); // OUTSIDE the frame
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('discriminating: without the fork (in-sync) the same row is Verified and no mismatch note', () => {
      const home = newHome();
      const { store } = makeStore(home);
      try {
        const a = store.commit({ content: 'alpha target deploy fact', source: 'user' });
        store.confirm(a.id);
        store.commit({ content: 'gamma tail filler UNIQUEFORKZ', source: 'user' });
        const res = store.recall('alpha');
        expect(res.items.find((i) => i.record.id === a.id)!.record.state).toBe('Verified');
        expect(res.witnessNotes).not.toContain(WITNESS_MISMATCH_NOTE);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('asOf on the same mismatched state keeps historical grades but still renders the note', () => {
      const { store, home, aId } = forkedMismatch();
      try {
        const view = store.asOfView('2026-07-19T00:00:00.000Z');
        const factA = view.facts.find((f) => f.record.id === aId)!;
        expect(factA.grade).toBe('Verified');             // asOf is NOT clamped
        expect(view.witnessNotes).toContain(WITNESS_MISMATCH_NOTE);
        const out = TEXT(handleInspect(store, { asOf: '2026-07-19T00:00:00.000Z' }));
        expect(out).toContain(WITNESS_MISMATCH_NOTE);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('currentView + historyView clamp the live row to Fresh under mismatch', () => {
      const { store, home, aId } = forkedMismatch();
      try {
        expect(store.currentView().records.find((s) => s.record.id === aId)!.record.state).toBe('Fresh');
        const hv = store.historyView();
        const liveA = hv.rows.find((r) => r.record.id === aId && r.txTo === null)!;
        expect(liveA.record.state).toBe('Fresh');
        expect(hv.witnessNotes).toContain(WITNESS_MISMATCH_NOTE);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  describe('transition-interrupted → per-scope exclusion from every surface', () => {
    // Global + owned project. Interrupt ONLY the project scope; the global scope must stay fully
    // visible (per-scope containment — a project rewrite must never dark the global scope).
    function twoScopeInterruptProject(): { store: MemoryStore; home: string; root: string; globalId: string; projectId: string } {
      const home = newHome();
      const root = mkdtempSync(join(tmpdir(), 'helix-witenf-proj-'));
      mkdirSync(join(root, '.helix'), { recursive: true });
      const projLedger = join(root, '.helix', 'memory.jsonl');
      let n = 0;
      const store = new MemoryStore(join(home, 'memory.jsonl'), {
        home, sessionId: 't', now: () => FIXED, genId: () => `m_${++n}`,
        project: { ledger: projLedger, root, home },
      });
      const g = store.commit({ content: 'global visible fact keepme', scope: 'global', source: 'user' });
      const pj = store.commit({ content: 'project excluded fact keepme', scope: 'project', source: 'user' });
      plantInterrupted(home, scopeKeyOf(home, root), projLedger, '2026-07-18T00:05:00.000Z');
      return { store, home, root, globalId: g.id, projectId: pj.id };
    }

    it('recall: project records excluded, global served, transition note present', () => {
      const { store, home, root, globalId, projectId } = twoScopeInterruptProject();
      try {
        const res = store.recall('keepme');
        expect(res.items.find((i) => i.record.id === globalId)).toBeDefined();   // global unaffected
        expect(res.items.find((i) => i.record.id === projectId)).toBeUndefined(); // project excluded
        expect(res.witnessNotes).toContain(WITNESS_TRANSITION_NOTE);
        expect(res.witnessNotes).not.toContain(WITNESS_MISMATCH_NOTE);
      } finally { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
    });

    it('currentView / historyView / asOfView all exclude the interrupted project scope, global survives', () => {
      const { store, home, root, globalId, projectId } = twoScopeInterruptProject();
      try {
        const cur = store.currentView();
        expect(cur.records.some((s) => s.record.id === globalId)).toBe(true);
        expect(cur.records.some((s) => s.record.id === projectId)).toBe(false);
        expect(cur.witnessNotes).toContain(WITNESS_TRANSITION_NOTE);

        const hv = store.historyView();
        expect(hv.rows.some((r) => r.record.id === globalId)).toBe(true);
        expect(hv.rows.some((r) => r.record.id === projectId)).toBe(false);
        expect(hv.witnessNotes).toContain(WITNESS_TRANSITION_NOTE);

        const av = store.asOfView('2026-07-19T00:00:00.000Z');
        expect(av.facts.some((f) => f.record.id === globalId)).toBe(true);
        expect(av.facts.some((f) => f.record.id === projectId)).toBe(false);
        expect(av.witnessNotes).toContain(WITNESS_TRANSITION_NOTE);
      } finally { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
    });
  });

  describe('first-contact → INIT note only, no clamp/exclusion', () => {
    it('INIT note appears on a virgin scope recall and disappears after the first commit', () => {
      const home = newHome();
      const { store } = makeStore(home);
      try {
        expect(store.recall('anything').witnessNotes).toContain(WITNESS_INIT_NOTE);
        store.commit({ content: 'first witnessed fact', source: 'user' });
        expect(store.recall('first').witnessNotes).not.toContain(WITNESS_INIT_NOTE);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  describe('witness-aware recall cache: key component + fresh-verdict + pending bypass', () => {
    it('flipping ONLY the witness entry (same ledger bytes) forces a cache MISS', () => {
      const home = newHome();
      const ledger = join(home, 'memory.jsonl');
      const { sink, replays } = captureSink();
      let n = 0;
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FIXED, genId: () => `m_${++n}`, metricsSink: sink });
      try {
        store.commit({ content: 'cacheable deploy fact', source: 'user' });
        replays.length = 0;
        store.recall('deploy');                                   // MISS → parse → emit
        expect(replays.length).toBeGreaterThan(0);
        replays.length = 0;
        store.recall('deploy');                                   // HIT → no parse → no emit
        expect(replays.length).toBe(0);
        // Re-witness the SAME bytes with a different headTx → new entry MAC, ledger bytes unchanged.
        advanceWitness(home, scopeKeyOf(home), readLedgerBytes(ledger), '2030-01-01T00:00:00.000Z');
        replays.length = 0;
        store.recall('deploy');                                   // MISS: witness component changed
        expect(replays.length).toBeGreaterThan(0);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('a pending journal bypasses the cache in BOTH directions (no read, no write)', () => {
      const home = newHome();
      const ledger = join(home, 'memory.jsonl');
      const { sink, replays } = captureSink();
      let n = 0;
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FIXED, genId: () => `m_${++n}`, metricsSink: sink });
      try {
        store.commit({ content: 'cacheable deploy fact', source: 'user' });
        store.recall('deploy');                                   // warm
        replays.length = 0;
        store.recall('deploy');                                   // HIT baseline → 0 emit
        expect(replays.length).toBe(0);
        // Plant a pending journal WITHOUT changing ledger bytes or the entry MAC — so the key would
        // still MATCH; only the journalPending bypass can force the miss.
        plantInterrupted(home, scopeKeyOf(home), ledger, '2026-07-18T00:05:00.000Z');
        expect(readScopeWitness(home, scopeKeyOf(home)).journal).not.toBeNull();
        replays.length = 0;
        store.recall('deploy');                                   // bypass read → parse → emit
        expect(replays.length).toBeGreaterThan(0);
        replays.length = 0;
        store.recall('deploy');                                   // still pending: NOT stored last call → emit again
        expect(replays.length).toBeGreaterThan(0);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  describe('SessionStart hook renders witness notes (incl. the empty-records early return)', () => {
    it('gatherScopedRecords + formatSessionStartContext surface the mismatch note alongside content', () => {
      const home = newHome();
      const { store, ledger } = makeStore(home);
      try {
        const a = store.commit({ content: 'alpha target deploy fact', source: 'user' });
        store.confirm(a.id);
        store.commit({ content: 'gamma tail filler UNIQUEFORKZ', source: 'user' });
        const bytes = readLedgerBytes(ledger);
        writeFileSync(ledger, Buffer.from(bytes.toString('utf8').replace('UNIQUEFORKZ', 'UNIQUEFORKY'), 'utf8'));

        const gr = gatherScopedRecords({ home, globalLedger: ledger });
        expect(gr.witnessNotes).toContain(WITNESS_MISMATCH_NOTE);
        expect(gr.records.length).toBeGreaterThan(0);            // mismatch still serves (D1b)
        const out = formatSessionStartContext(gr.records, 'd'.repeat(32), {
          integrityAvailable: gr.integrityAvailable, witnessNotes: gr.witnessNotes,
        });
        expect(out).toContain(WITNESS_MISMATCH_NOTE);
        const closeIdx = out.indexOf('===HELIX dddddddddddddddddddddddddddddddd END===');
        expect(out.indexOf(WITNESS_MISMATCH_NOTE)).toBeGreaterThan(closeIdx); // trusted, out-of-frame
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('empty-records early return STILL prints the note (transition-interrupted global → zero records)', () => {
      const home = newHome();
      const { store, ledger } = makeStore(home);
      try {
        store.commit({ content: 'about to be excluded fact', source: 'user' });
        plantInterrupted(home, scopeKeyOf(home), ledger, '2026-07-18T00:05:00.000Z');
        const gr = gatherScopedRecords({ home, globalLedger: ledger });
        expect(gr.records).toHaveLength(0);                      // global excluded → empty
        expect(gr.witnessNotes).toContain(WITNESS_TRANSITION_NOTE);
        const out = formatSessionStartContext(gr.records, 'd'.repeat(32), {
          integrityAvailable: gr.integrityAvailable, witnessNotes: gr.witnessNotes,
        });
        expect(out).toBe(WITNESS_TRANSITION_NOTE);               // note-only output, no frame
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });
});
