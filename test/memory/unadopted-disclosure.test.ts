import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { handleRecall, handleInspect } from '../../src/server/handlers.js';
import { UNADOPTED_LEDGER_NOTE, WITNESS_INIT_NOTE } from '../../src/memory/content-frame.js';
import { noopMetricsSink, type MetricsSink } from '../../src/metrics.js';

// B2: the informational unadopted-ledger disclosure note, threaded through recall / inspect
// (current+history+asOf) from the B1 project-disposition snapshot. Codex R2 #8 (SECURITY): the note
// is a CONSTANT string (locked below) and must never be dropped by, or interpolate, attacker-
// controlled bytes — a malicious clone controls whether the condition (and the note) appears at all.

function newHome(): string { return mkdtempSync(join(tmpdir(), 'helix-ud-home-')); }
function newProjectRoot(): string { return mkdtempSync(join(tmpdir(), 'helix-ud-proj-')); }
const text = (res: { content: Array<{ type: string; text?: string }> }) => res.content.map((c) => c.text ?? '').join('');
function cleanup(...dirs: string[]): void { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }

function foreignLedgerPath(root: string): string { return join(root, '.helix', 'memory.jsonl'); }

/** Plant a foreign (unowned) project ledger file directly — simulates a team-shared/cloned repo,
 *  the same fixture pattern as project-disposition.test.ts's unadopted-present case. */
function plantForeignLedger(root: string, content = 'charlie foreign fact'): void {
  mkdirSync(join(root, '.helix'), { recursive: true });
  writeFileSync(foreignLedgerPath(root), JSON.stringify({
    id: 'm_foreign', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content,
    provenance: { source: 'user', sessionId: 'x' }, supersedes: null, blastRadius: null,
    reverifyTrigger: null, classification: 'normal',
  }) + '\n');
}

function layeredStore(root: string, home: string): MemoryStore {
  let n = 0;
  return new MemoryStore(join(home, 'memory.jsonl'), {
    home, sessionId: 't', genId: () => `m_${++n}`,
    project: { ledger: foreignLedgerPath(root), root, home },
  });
}

describe('unadopted-ledger disclosure note (B2)', () => {
  describe('recall', () => {
    it('renders on a NON-EMPTY result when the project layer is unadopted-present', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        plantForeignLedger(root);
        const store = layeredStore(root, home);
        store.commit({ content: 'hello galaxy global fact', source: 'user', scope: 'global' });
        const out = text(handleRecall(store, { query: 'hello galaxy' }));
        expect(out).toContain('hello galaxy global fact');
        expect(out).toContain(UNADOPTED_LEDGER_NOTE);
        expect(out).not.toContain('charlie foreign fact'); // the foreign fact itself stays excluded
      } finally { cleanup(home, root); }
    });

    it('renders on an EMPTY result when the project layer is unadopted-present', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        plantForeignLedger(root);
        const store = layeredStore(root, home);
        const out = text(handleRecall(store, { query: 'nothing will ever match this query text' }));
        expect(out).toContain('(no relevant memory)');
        expect(out).toContain(UNADOPTED_LEDGER_NOTE);
      } finally { cleanup(home, root); }
    });

    it('is absent when the project is owned', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        const store = layeredStore(root, home);
        store.adopt();
        store.commit({ content: 'hello galaxy global fact', source: 'user', scope: 'global' });
        const out = text(handleRecall(store, { query: 'hello galaxy' }));
        expect(out).not.toContain(UNADOPTED_LEDGER_NOTE);
      } finally { cleanup(home, root); }
    });

    it('is absent when inactive: no project layer configured at all', () => {
      const home = newHome();
      try {
        const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't' });
        store.commit({ content: 'hello galaxy global fact', source: 'user' });
        const out = text(handleRecall(store, { query: 'hello galaxy' }));
        expect(out).not.toContain(UNADOPTED_LEDGER_NOTE);
      } finally { cleanup(home); }
    });

    it('is absent when inactive: project configured but no ledger file exists yet', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        const store = layeredStore(root, home); // configured; nothing planted on disk
        // scope: 'global' is load-bearing here, not decoration: an unscoped commit against a
        // configured-but-absent project layer auto-stamps ownership on first use (targetLedger's
        // claim-on-first-use path), which would flip disposition to 'owned' and defeat the very
        // 'inactive' case this test means to cover.
        store.commit({ content: 'hello galaxy global fact', source: 'user', scope: 'global' });
        const out = text(handleRecall(store, { query: 'hello galaxy' }));
        expect(out).not.toContain(UNADOPTED_LEDGER_NOTE);
      } finally { cleanup(home, root); }
    });
  });

  describe('inspect current view', () => {
    it('renders on a NON-EMPTY current view', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        plantForeignLedger(root);
        const store = layeredStore(root, home);
        store.commit({ content: 'inspect current fact', source: 'user', scope: 'global' });
        const out = text(handleInspect(store, {}));
        expect(out).toContain('CURRENT MEMORY');
        expect(out).toContain(UNADOPTED_LEDGER_NOTE);
      } finally { cleanup(home, root); }
    });

    it('renders on an EMPTY current view, exact composition', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        plantForeignLedger(root);
        const store = layeredStore(root, home); // no global commit either -> current view is empty
        const out = text(handleInspect(store, {}));
        // W-T7: the virgin global scope is first-contact (never witnessed), so the INIT note trails
        // the unadopted note — both are trusted out-of-band disclosures on the empty view.
        expect(out).toBe(`(memory is empty)\n\n${UNADOPTED_LEDGER_NOTE}\n\n${WITNESS_INIT_NOTE}`);
      } finally { cleanup(home, root); }
    });

    it('is absent on the current view when owned', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        const store = layeredStore(root, home);
        store.adopt();
        const out = text(handleInspect(store, {}));
        expect(out).not.toContain(UNADOPTED_LEDGER_NOTE);
      } finally { cleanup(home, root); }
    });
  });

  describe('inspect history view', () => {
    it('renders on a NON-EMPTY history view', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        plantForeignLedger(root);
        const store = layeredStore(root, home);
        store.commit({ content: 'history fact', source: 'user', scope: 'global' });
        const out = text(handleInspect(store, { history: true }));
        expect(out).toContain('MEMORY HISTORY');
        expect(out).toContain(UNADOPTED_LEDGER_NOTE);
      } finally { cleanup(home, root); }
    });

    it('renders on an EMPTY history view, exact composition', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        plantForeignLedger(root);
        const store = layeredStore(root, home);
        const out = text(handleInspect(store, { history: true }));
        expect(out).toBe(`(memory is empty)\n\n${UNADOPTED_LEDGER_NOTE}\n\n${WITNESS_INIT_NOTE}`); // virgin global -> first-contact INIT note
      } finally { cleanup(home, root); }
    });

    it('is absent on the history view when owned', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        const store = layeredStore(root, home);
        store.adopt();
        const out = text(handleInspect(store, { history: true }));
        expect(out).not.toContain(UNADOPTED_LEDGER_NOTE);
      } finally { cleanup(home, root); }
    });
  });

  describe('inspect asOf view', () => {
    it('renders on a NON-EMPTY asOf snapshot', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        plantForeignLedger(root);
        const store = layeredStore(root, home);
        store.commit({ content: 'asof fact', source: 'user', scope: 'global' });
        const out = text(handleInspect(store, { asOf: new Date().toISOString() }));
        expect(out).toContain('MEMORY AS OF');
        expect(out).toContain(UNADOPTED_LEDGER_NOTE);
      } finally { cleanup(home, root); }
    });

    it('renders on an EMPTY asOf snapshot, exact composition', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        plantForeignLedger(root);
        const store = layeredStore(root, home);
        const t = new Date().toISOString();
        const out = text(handleInspect(store, { asOf: t }));
        expect(out).toBe(`(memory is empty as of ${t})\n\n${UNADOPTED_LEDGER_NOTE}\n\n${WITNESS_INIT_NOTE}`); // virgin global -> first-contact INIT note
      } finally { cleanup(home, root); }
    });

    it('is absent on the asOf view when owned', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        const store = layeredStore(root, home);
        store.adopt();
        const out = text(handleInspect(store, { asOf: new Date().toISOString() }));
        expect(out).not.toContain(UNADOPTED_LEDGER_NOTE);
      } finally { cleanup(home, root); }
    });
  });

  describe('cache-HIT flip (Codex R2 #8: the A4 key vector only covers PARTICIPATING scopes)', () => {
    it('the note flips absent -> present -> absent while the SAME cached recall data is served (verified as a real HIT via the replay metric)', () => {
      const home = newHome(), root = newProjectRoot();
      const box = { replays: 0 };
      const sink: MetricsSink = { ...noopMetricsSink, emitReplay: () => { box.replays += 1; } };
      try {
        let n = 0;
        const store = new MemoryStore(join(home, 'memory.jsonl'), {
          home, sessionId: 't', genId: () => `m_${++n}`, metricsSink: sink,
          project: { ledger: foreignLedgerPath(root), root, home }, // configured; nothing on disk yet
        });
        // scope: 'global' is load-bearing: an unscoped commit here would auto-stamp project ownership
        // on first use (nothing is on disk yet, so targetLedger's claim-on-first-use path fires) and
        // flip disposition to 'owned' before the cache is even warmed.
        store.commit({ content: 'zephyr marker unique phrase', source: 'user', scope: 'global' });

        const before = store.recall('zephyr'); // MISS -> warms the cache
        expect(before.projectDisposition).toBe('inactive');
        const beforeIds = before.items.map((i) => i.record.id);
        expect(beforeIds.length).toBe(1);
        const afterFirstMiss = box.replays;
        expect(afterFirstMiss).toBeGreaterThanOrEqual(1);
        expect(text(handleRecall(store, { query: 'zephyr' }))).not.toContain(UNADOPTED_LEDGER_NOTE);

        // Plant a foreign, unowned ledger. The rank-cache key vector only covers PARTICIPATING scopes
        // (global only, since the project scope participates iff OWNED) — so this does NOT change the
        // key, and the next recall for the same query is a cache HIT, not a re-read.
        plantForeignLedger(root);

        const after = store.recall('zephyr');
        expect(box.replays).toBe(afterFirstMiss); // no NEW replay emitted -> this really was a cache HIT
        expect(after.projectDisposition).toBe('unadopted-present'); // disposition is fresh every call...
        expect(after.items.map((i) => i.record.id)).toEqual(beforeIds); // ...but the served DATA is byte-identical
        const afterOut = text(handleRecall(store, { query: 'zephyr' }));
        expect(afterOut).toContain(UNADOPTED_LEDGER_NOTE);
        expect(afterOut).toContain('zephyr marker unique phrase');

        // Remove the foreign file — disposition reverts, and the SAME unaffected key still hits.
        rmSync(foreignLedgerPath(root), { force: true });
        const finalRes = store.recall('zephyr');
        expect(box.replays).toBe(afterFirstMiss); // still no new replay
        expect(finalRes.projectDisposition).toBe('inactive');
        expect(finalRes.items.map((i) => i.record.id)).toEqual(beforeIds);
        expect(text(handleRecall(store, { query: 'zephyr' }))).not.toContain(UNADOPTED_LEDGER_NOTE);
      } finally { cleanup(home, root); }
    });
  });

  describe('adoption transition', () => {
    it('unadopted-present -> adopt() drops the note AND the project rows appear (I4 key-vector rebuild)', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        plantForeignLedger(root, 'juniper foreign phrase');
        const store = layeredStore(root, home);

        const before = text(handleRecall(store, { query: 'juniper foreign phrase' }));
        expect(before).toContain(UNADOPTED_LEDGER_NOTE);
        expect(before).not.toContain('juniper foreign phrase'); // excluded pre-adopt

        store.adopt();

        const after = text(handleRecall(store, { query: 'juniper foreign phrase' }));
        expect(after).not.toContain(UNADOPTED_LEDGER_NOTE);
        expect(after).toContain('juniper foreign phrase'); // now included: project scope participates
      } finally { cleanup(home, root); }
    });
  });

  describe('constant-string lock + byte non-disclosure', () => {
    it('matches the exact spec byte-string (no drift)', () => {
      expect(UNADOPTED_LEDGER_NOTE).toBe(
        '(an unadopted project memory file is present and excluded from results; adoption requires explicit user approval)',
      );
    });

    it('renders as its OWN exact line on recall — nothing interpolated onto it — and discloses neither the project root path nor its name', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        plantForeignLedger(root);
        const store = layeredStore(root, home);
        store.commit({ content: 'disclosure probe fact', source: 'user', scope: 'global' });
        const out = text(handleRecall(store, { query: 'disclosure probe fact' }));

        // The note occupies its own line, byte-exact — no untrusted interpolation glued onto it.
        const noteLine = out.split('\n').find((l) => l.includes('unadopted project memory file'));
        expect(noteLine).toBe(UNADOPTED_LEDGER_NOTE);

        // Byte non-disclosure: neither the absolute project root nor its leaf directory name appears
        // anywhere in the output (defense-in-depth beyond the note text itself).
        expect(out).not.toContain(root);
        expect(out).not.toContain(basename(root));
      } finally { cleanup(home, root); }
    });

    it('holds on every surface: inspect current/history/asOf too', () => {
      const home = newHome(), root = newProjectRoot();
      try {
        plantForeignLedger(root);
        const store = layeredStore(root, home);
        store.commit({ content: 'multi surface probe', source: 'user', scope: 'global' });
        const outs = [
          text(handleInspect(store, {})),
          text(handleInspect(store, { history: true })),
          text(handleInspect(store, { asOf: new Date().toISOString() })),
        ];
        for (const out of outs) {
          expect(out).toContain(UNADOPTED_LEDGER_NOTE);
          expect(out).not.toContain(root);
          expect(out).not.toContain(basename(root));
        }
      } finally { cleanup(home, root); }
    });
  });
});
