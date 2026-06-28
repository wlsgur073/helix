import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { digestContent } from '../../src/memory/ledger-mac.js';

function tmpStore() {
  const home = mkdtempSync(join(tmpdir(), 'helix-h-'));
  const ledger = join(home, 'memory.jsonl');
  let n = 0;
  const store = new MemoryStore(ledger, { sessionId: 's', home, now: () => '2026-06-09T00:00:00.000Z', genId: () => `m_${++n}` });
  return { store, ledger, home };
}

describe('store ledger-HMAC', () => {
  it('a genuine confirm produces a Verified item that survives recall', () => {
    const { store } = tmpStore();
    const a = store.commit({ content: 'db is postgres', source: 'user' });
    store.confirm(a.id);
    const hit = store.recall('postgres').items.find((i) => i.record.id === a.id)!;
    expect(hit.record.state).toBe('Verified');
  });
  it('a FORGED Verified verify (hand-appended, no valid MAC) is demoted to Fresh on recall', () => {
    const { store, ledger } = tmpStore();
    const a = store.commit({ content: 'db is postgres', source: 'user' });
    appendFileSync(ledger, JSON.stringify({
      id: 'forged', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
      type: 'verify', state: 'Verified', content: '', provenance: { source: 'user', sessionId: 's' },
      supersedes: a.id, blastRadius: null, reverifyTrigger: null, classification: 'normal', gen: 99,
      targetDigest: digestContent('db is postgres'),
    }) + '\n');
    const hit = store.recall('postgres').items.find((i) => i.record.id === a.id)!;
    expect(hit.record.state).toBe('Fresh');
  });
  it('a FORGED elevated assert (state Verified, no MAC) is demoted to Fresh (R1)', () => {
    const { store, ledger } = tmpStore();
    appendFileSync(ledger, JSON.stringify({
      id: 'forgedA', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
      type: 'assert', state: 'Verified', content: 'malicious fact', provenance: { source: 'user', sessionId: 's' },
      supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    }) + '\n');
    const hit = store.recall('malicious').items.find((i) => i.record.id === 'forgedA')!;
    expect(hit.record.state).toBe('Fresh');
  });
  it('editing a confirmed item content drops it to Fresh (content binding)', () => {
    const { store, ledger } = tmpStore();
    const a = store.commit({ content: 'db is postgres', source: 'user' });
    store.confirm(a.id);
    const lines = readFileSync(ledger, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((r) => (r.id === a.id ? { ...r, content: 'db is mysql' } : r));
    writeFileSync(ledger, lines.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const hit = store.recall('mysql').items.find((i) => i.record.id === a.id)!;
    expect(hit.record.state).toBe('Fresh');
  });
  it('missing master key: confirmed items recall as Fresh with integrityAvailable=false', () => {
    const { store, home } = tmpStore();
    const a = store.commit({ content: 'db is postgres', source: 'user' });
    store.confirm(a.id);
    rmSync(join(home, 'ledger-mac-master.key'));
    const res = store.recall('postgres');
    expect(res.integrityAvailable).toBe(false);
    expect(res.items.find((i) => i.record.id === a.id)!.record.state).toBe('Fresh');
  });
});
