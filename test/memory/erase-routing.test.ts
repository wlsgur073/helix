import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { isOwned } from '../../src/memory/ownership.js';

function projectStore() {
  const home = mkdtempSync(join(tmpdir(), 'helix-er-'));
  const root = mkdtempSync(join(tmpdir(), 'helix-proj-'));
  const global = join(home, 'memory.jsonl');
  const projLedger = join(root, '.helix', 'memory.jsonl');
  const store = new MemoryStore(global, { sessionId: 's', home, project: { ledger: projLedger, root, home } });
  store.adopt();
  return { store, global, projLedger, home };
}

/** Same shape as projectStore(), but WITHOUT the store.adopt() call — the project layer is active
 *  (an `opts.project` is configured) but unowned, for testing the unowned-project throw path. */
function unownedProjectStore() {
  const home = mkdtempSync(join(tmpdir(), 'helix-er-'));
  const root = mkdtempSync(join(tmpdir(), 'helix-proj-'));
  const global = join(home, 'memory.jsonl');
  const projLedger = join(root, '.helix', 'memory.jsonl');
  const store = new MemoryStore(global, { sessionId: 's', home, project: { ledger: projLedger, root, home } });
  return { store, global, projLedger, home, root };
}

/** A canonical-marker-shaped, unsigned verify row — same shape planted by the existing
 *  byte-identity test above, factored out so both new tests below can reuse it verbatim. */
function plantedMarker(id: string) {
  return {
    id, tx: '1970-01-01T00:00:00.000Z', validFrom: '1970-01-01T00:00:00.000Z', validTo: null,
    type: 'verify', state: 'Suspect', content: '',
    provenance: { source: 'user', sessionId: 'x' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  };
}

describe('erase routing', () => {
  it('D5/C6: a no-scope PERMANENT erase throws when a candidate ledger has any skipped line', () => {
    const { store, projLedger } = projectStore();
    store.commit({ content: 'proj fact', source: 'user', scope: 'project' });
    appendFileSync(projLedger, '{bad torn line\n');
    // A physical purge must not silently miss a secret hiding in a corrupt line -> throw, ask for scope.
    expect(() => store.erase('m_absent', { permanent: true })).toThrow(/skipped lines|explicit scope/);
  });
  it('finding 2: a SOFT erase of a live id is NOT bricked by an unrelated torn line', () => {
    const { store, global } = projectStore();
    const a = store.commit({ content: 'erase me', source: 'user', scope: 'global' });
    appendFileSync(global, '{"id":"torn_partial\n'); // a torn/partial line (e.g. a crash mid-append)
    // The MCP tool only ever issues soft, no-scope erases and cannot pass a scope; an unrelated torn
    // line must never make right-to-erasure unavailable. Soft erase only tombstones (parseLedger
    // tolerates the torn line), so this must succeed, not throw.
    expect(() => store.erase(a.id)).not.toThrow();
    expect(readFileSync(global, 'utf8')).toMatch(/"type":"erase"/); // the tombstone was appended
  });
  it('D7/C4: explicit wrong scope on a clean ledger throws instead of compacting it', () => {
    const { store, global } = projectStore();
    const g = store.commit({ content: 'global fact', source: 'user', scope: 'global' });
    const before = readFileSync(global, 'utf8');
    expect(() => store.erase(g.id, { permanent: true, scope: 'project' })).toThrow(/not found in scope/);
    expect(readFileSync(global, 'utf8')).toBe(before); // global untouched
  });
  it('finding 1: erase(integrity_marker, scope) with a NON-marker integrity_-prefixed row throws not-found (no false success)', () => {
    const { store, global } = projectStore();
    store.commit({ content: 'real fact', source: 'user', scope: 'global' });
    // a NON-marker row (type assert) whose id merely SHARES the marker family prefix
    appendFileSync(global, JSON.stringify({ id: 'integrity_x', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null, type: 'assert', state: 'Fresh', content: 'not a marker', provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' }) + '\n');
    const before = readFileSync(global, 'utf8');
    // presence is marker-SHAPE, not family-prefix: no canonical marker lives here, so this must throw
    // rather than report success + compact a scope where the marker does not live.
    expect(() => store.erase('integrity_marker', { permanent: true, scope: 'global' })).toThrow(/not found in scope/);
    expect(readFileSync(global, 'utf8')).toBe(before); // untouched — no compaction ran
  });
  it('finding 1: a non-marker integrity_-prefixed row in global does NOT cause a false no-scope ambiguity for a real project marker', () => {
    const { store, global, projLedger } = projectStore();
    store.commit({ content: 'g', source: 'user', scope: 'global' });
    store.commit({ content: 'p', source: 'user', scope: 'project' });
    appendFileSync(global, JSON.stringify({ id: 'integrity_x', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null, type: 'assert', state: 'Fresh', content: 'not a marker', provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' }) + '\n');
    appendFileSync(projLedger, JSON.stringify(plantedMarker('integrity_planted')) + '\n'); // a REAL marker, project only
    const globalBefore = readFileSync(global, 'utf8');
    // the non-marker integrity_x must NOT count as a marker present in global, so the real project
    // marker is a UNIQUE hit and clears without demanding an explicit scope; global stays untouched.
    expect(() => store.erase('integrity_marker', { permanent: true })).not.toThrow();
    expect(readFileSync(global, 'utf8')).toBe(globalBefore);
    expect(readFileSync(projLedger, 'utf8')).not.toMatch(/integrity_/); // real marker cleared
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
  it('store.ts:595 — explicit project scope on an UNOWNED project throws and never auto-adopts', () => {
    const { store, root, home } = unownedProjectStore();
    expect(isOwned(root, home)).toBe(false); // sanity: genuinely unowned before the call
    expect(() => store.erase('anything', { scope: 'project' }))
      .toThrow(/not owned.*helix_memory_adopt/); // erase must never silently adopt to satisfy itself
    expect(isOwned(root, home)).toBe(false); // still unowned — the throw did not adopt as a side effect
  });
  it('store.ts:606 — no-scope erase throws when the id is present in more than one scope, and touches neither ledger', () => {
    const { store, global, projLedger } = projectStore();
    const marker = plantedMarker('integrity_planted');
    appendFileSync(global, JSON.stringify(marker) + '\n');
    appendFileSync(projLedger, JSON.stringify(marker) + '\n');
    const globalBefore = readFileSync(global, 'utf8');
    const projBefore = readFileSync(projLedger, 'utf8');
    expect(() => store.erase('integrity_marker', {})).toThrow(/more than one scope|ambiguous/);
    expect(readFileSync(global, 'utf8')).toBe(globalBefore);       // global untouched — no partial compaction
    expect(readFileSync(projLedger, 'utf8')).toBe(projBefore);     // project untouched — no partial compaction
  });
  it('D9: a supersede of an id live in BOTH scopes throws ambiguity instead of silently binding global', () => {
    const { store, projLedger } = projectStore();
    const g = store.commit({ content: 'dup', source: 'user', scope: 'global' });
    // hand-plant the SAME id live in the project ledger (only reachable via a forged/edited ledger)
    appendFileSync(projLedger, JSON.stringify({ id: g.id, tx: '2026-01-05T00:00:00.000Z', validFrom: '2026-01-05T00:00:00.000Z', validTo: null, type: 'assert', state: 'Fresh', content: 'dup', provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' }) + '\n');
    expect(() => store.commit({ content: 'replacement', source: 'user', supersedes: g.id, scope: 'global' })).toThrow(/more than one scope|ambiguous/);
  });
});
