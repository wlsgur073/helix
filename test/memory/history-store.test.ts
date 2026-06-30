import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';

function tmpStore() {
  const home = mkdtempSync(join(tmpdir(), 'helix-hist-'));
  const ledger = join(home, 'memory.jsonl');
  let n = 0, t = 0;
  const store = new MemoryStore(ledger, {
    sessionId: 's', home,
    now: () => `2026-06-09T00:00:00.${String(++t).padStart(3, '0')}Z`,
    genId: () => `m_${++n}`,
  });
  return { store, ledger, home };
}

// A layered store (global + an owned project ledger) — the first default-scope commit claims the
// project and creates its .helix/ dir, after which both ledgers are readable by historyView.
function tmpLayered() {
  const home = mkdtempSync(join(tmpdir(), 'helix-histL-'));
  const proj = mkdtempSync(join(tmpdir(), 'helix-histP-'));
  const globalLedger = join(home, 'memory.jsonl');
  const projLedger = join(proj, '.helix', 'memory.jsonl');
  let n = 0, t = 0;
  const store = new MemoryStore(globalLedger, {
    sessionId: 's', home, genStamp: () => 'STAMP',
    now: () => `2026-06-09T00:00:00.${String(++t).padStart(3, '0')}Z`,
    genId: () => `m_${++n}`,
    project: { ledger: projLedger, root: proj, home },
  });
  return { store, globalLedger, projLedger };
}

// Forge a raw ledger line directly (bypassing store.commit). Mirrors inspect-history.test.ts: a
// ledger-write adversary controls id / type / supersedes / content.
const RAW = {
  tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
  type: 'assert', state: 'Fresh', content: 'x', provenance: { source: 'user', sessionId: 's' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
};
function appendRaw(ledger: string, over: Record<string, unknown>): void {
  appendFileSync(ledger, JSON.stringify({ ...RAW, ...over }) + '\n');
}

describe('MemoryStore.historyView', () => {
  it('live rows carry txTo=null + their graded state; superseded rows appear closed', () => {
    const { store } = tmpStore();
    const a = store.commit({ content: 'old fact', source: 'user' });
    store.commit({ content: 'new fact', source: 'user', supersedes: a.id });

    const { rows } = store.historyView();
    const closed = rows.find((r) => r.record.id === a.id)!;
    expect(closed.closedBy!.kind).toBe('supersede');
    expect(closed.txTo).not.toBeNull();
    const live = rows.find((r) => r.closedBy === null)!;
    expect(live.txTo).toBeNull();
    expect(live.scope).toBe('global');
  });

  it('an UNVERIFIED live row is never dropped (left-join totality; defaults Fresh/ok)', () => {
    const { store } = tmpStore();
    store.commit({ content: 'plain fresh fact', source: 'user' }); // no verify -> Fresh
    const { rows } = store.historyView();
    const live = rows.filter((r) => r.closedBy === null);
    expect(live).toHaveLength(1);
    expect(live[0]!.record.state).toBe('Fresh');
    expect(live[0]!.integrity).toBe('ok');
  });

  it('a live row and its closed predecessor never both appear for the same id', () => {
    const { store } = tmpStore();
    const a = store.commit({ content: 'v1', source: 'user' });
    store.commit({ content: 'v2', source: 'user', supersedes: a.id });
    const { rows } = store.historyView();
    const sameId = rows.filter((r) => r.record.id === a.id);
    expect(sameId).toHaveLength(1);
    expect(sameId[0]!.closedBy).not.toBeNull(); // it is the closed one
  });

  it('a forged id present in BOTH scopes surfaces as two scope-distinct rows (identity is (scope,id))', () => {
    // The single-read fix makes EACH scope's ledger internally atomic, NOT the global+project pair. A
    // forged id in both ledgers (randomUUID precludes a genuine collision; only a ledger-write adversary
    // can do it) must therefore surface as two rows distinguished by scope, never collapsed to one. This
    // LOCKS the (scope,id) identity through the refactor (Codex code-review #3).
    const { store, globalLedger, projLedger } = tmpLayered();
    store.commit({ content: 'project fact', source: 'user' });                // claims project + makes .helix/
    store.commit({ content: 'global fact', source: 'user', scope: 'global' });
    const dupId = 'm_dup';
    appendRaw(globalLedger, { id: dupId, content: 'in global' });
    appendRaw(projLedger, { id: dupId, content: 'in project' });
    const dupRows = store.historyView().rows.filter((r) => r.record.id === dupId);
    expect(dupRows).toHaveLength(2);
    expect(new Set(dupRows.map((r) => r.scope))).toEqual(new Set(['global', 'project']));
  });

  it('integrityAvailable is false when no master key exists, true once a signing verify mints it', () => {
    // A plain commit never mints the master, so the verifying replay ran key-absent (every grade
    // clamped Fresh fail-safe). historyView reports that so the surface can flag it (mirrors recall).
    const { store } = tmpStore();
    const a = store.commit({ content: 'db is postgres', source: 'user' });
    expect(store.historyView().integrityAvailable).toBe(false);
    store.confirm(a.id); // mints the master key + signs a genuine verify
    expect(store.historyView().integrityAvailable).toBe(true);
  });
});
