import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
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
});
