import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';

function projectStore() {
  const home = mkdtempSync(join(tmpdir(), 'helix-er-'));
  const root = mkdtempSync(join(tmpdir(), 'helix-proj-'));
  const global = join(home, 'memory.jsonl');
  const projLedger = join(root, '.helix', 'memory.jsonl');
  const store = new MemoryStore(global, { sessionId: 's', home, project: { ledger: projLedger, root, home } });
  store.adopt();
  return { store, global, projLedger, home };
}

describe('erase routing', () => {
  it('D5/C6: no-scope erase throws when a candidate ledger has any skipped line', () => {
    const { store, projLedger } = projectStore();
    store.commit({ content: 'proj fact', source: 'user', scope: 'project' });
    appendFileSync(projLedger, '{bad torn line\n');
    expect(() => store.erase('m_absent', {})).toThrow(/skipped lines|explicit scope/);
  });
  it('D7/C4: explicit wrong scope on a clean ledger throws instead of compacting it', () => {
    const { store, global } = projectStore();
    const g = store.commit({ content: 'global fact', source: 'user', scope: 'global' });
    const before = readFileSync(global, 'utf8');
    expect(() => store.erase(g.id, { permanent: true, scope: 'project' })).toThrow(/not found in scope/);
    expect(readFileSync(global, 'utf8')).toBe(before); // global untouched
  });
  it('byte-identity: clearing a project marker leaves the global ledger byte-for-byte unchanged', () => {
    const { store, global, projLedger } = projectStore();
    store.commit({ content: 'g', source: 'user', scope: 'global' });
    store.commit({ content: 'p', source: 'user', scope: 'project' });
    appendFileSync(projLedger, JSON.stringify({ id: 'integrity_planted', tx: '1970-01-01T00:00:00.000Z', validFrom: '1970-01-01T00:00:00.000Z', validTo: null, type: 'verify', state: 'Suspect', content: '', provenance: { source: 'user', sessionId: 'x' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' }) + '\n');
    const globalBefore = readFileSync(global, 'utf8');
    store.erase('integrity_marker', { permanent: true, scope: 'project' }); // C10 family-based presence
    expect(readFileSync(global, 'utf8')).toBe(globalBefore);                 // global byte-identical
    expect(readFileSync(projLedger, 'utf8')).not.toMatch(/integrity_/);      // planted marker cleared
  });
  it('D8: soft-erasing a live id twice appends only one tombstone', () => {
    const { store, global } = projectStore();
    const a = store.commit({ content: 'x', source: 'user', scope: 'global' });
    store.erase(a.id, {});
    store.erase(a.id, {});
    const erases = readFileSync(global, 'utf8').split('\n').filter((l) => l.includes('"type":"erase"'));
    expect(erases).toHaveLength(1);
  });
  // NOTE (deviation from brief): the brief's version of this test only asserted `.not.toThrow()`.
  // That is a false-green — the OLD (pre-fix) erase() ALSO never throws here: ledgerOf() falls back
  // to global and unconditionally appends a spurious tombstone for an id that was never committed
  // anywhere. Old and new code are both non-throwing, so `.not.toThrow()` alone cannot tell them
  // apart. The genuinely discriminating assertion is that a clean+absent erase writes NOTHING: the
  // old code creates `global` (spurious tombstone); the new resolver returns null before any write.
  it('clean + absent no-scope erase is a no-op success (idempotent) — and writes nothing', () => {
    const { store, global } = projectStore();
    expect(() => store.erase('m_nope', {})).not.toThrow();
    expect(existsSync(global)).toBe(false);
  });
});
