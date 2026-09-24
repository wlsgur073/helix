import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { stampOwnership, projectLedgerPath } from '../../src/memory/ownership.js';
import { handleRecall, handleInspect } from '../../src/server/handlers.js';
import { ALIASED_LEDGER_NOTE } from '../../src/memory/content-frame.js';
import * as ledgerMod from '../../src/memory/ledger.js';

const text = (res: { content: Array<{ text?: string }> }) => res.content.map((c) => c.text ?? '').join('');

/** Two adopted projects; A's ledger is a symlink to B's. Returns A's store. */
function aliasedPair(opts: { dangling?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'helix-p2pe-home-'));
  const a = mkdtempSync(join(tmpdir(), 'helix-p2pe-proj-'));
  const b = mkdtempSync(join(tmpdir(), 'helix-p2pe-proj-'));
  stampOwnership(a, home, {});
  stampOwnership(b, home, {});
  if (!opts.dangling) writeFileSync(projectLedgerPath(b), '');
  symlinkSync(projectLedgerPath(b), projectLedgerPath(a));
  const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's1', project: { root: a, ledger: projectLedgerPath(a) } });
  return { home, a, b, store };
}

describe('an aliased project layer (ALIAS-P2P, item 7)', () => {
  it('a commit routed to the project (omitted scope) is refused, not written into the other project', () => {
    const { b, store } = aliasedPair();
    expect(() => store.commit({ content: 'a fact for project A', source: 'user' })).toThrow(/resolves to another adopted project/);
    expect(readFileSync(projectLedgerPath(b), 'utf8')).toBe('');
  });

  it('an explicit project scope is refused too; an explicit global scope still writes', () => {
    const { store } = aliasedPair();
    expect(() => store.commit({ content: 'a fact for project A', source: 'user', scope: 'project' })).toThrow(/resolves to another adopted project/);
    expect(() => store.commit({ content: 'a global fact', source: 'user', scope: 'global' })).not.toThrow();
  });

  it('a DANGLING link: the first write is refused and creates no file in the other project', () => {
    const { b, store } = aliasedPair({ dangling: true });
    expect(() => store.commit({ content: 'a fact for project A', source: 'user' })).toThrow(/resolves to another adopted project/);
    expect(existsSync(projectLedgerPath(b))).toBe(false);
  });

  it('recall leaves the layer out and carries the constant aliased note', () => {
    const { store } = aliasedPair();
    store.commit({ content: 'a global fact about staging', source: 'user', scope: 'global' });
    const out = text(handleRecall(store, { query: 'staging' }));
    expect(out).toContain(ALIASED_LEDGER_NOTE);
    expect(text(handleInspect(store, {}))).toContain(ALIASED_LEDGER_NOTE);
  });

  it('an explicit project-scope erase is refused; an unscoped erase never touches the other project', () => {
    const { store } = aliasedPair();
    const g = store.commit({ content: 'a global fact to erase', source: 'user', scope: 'global' });
    expect(() => store.erase(g.id, { scope: 'project' })).toThrow(/resolves to another adopted project/);
    expect(() => store.erase(g.id)).not.toThrow();
  });
});

// Fix round 1 (2026-09-24): the supersede pre-check (commit()'s `if (input.supersedes)` block) and the
// verify router (writeVerify, via ledgerOf) used to read THROUGH the alias — ledgerOf gated its project
// branch on raw isOwned, which is true for an aliased layer too — before the write-side refusal above
// ever fired. B's OWN store (a separate MemoryStore instance whose project layer is B's own, un-aliased
// ledger) commits a real fact so B's file holds a known, live id to attempt superseding from A.
describe('the supersede pre-check and the verify router never read through an aliased layer (item 7 fix round 1)', () => {
  it("a project-routed commit superseding B's id throws the ALIAS-P2P message, not the Tier-1 accident guard", () => {
    const { home, b, store } = aliasedPair();
    const bStore = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's2', project: { root: b, ledger: projectLedgerPath(b) } });
    const bFact = bStore.commit({ content: "B's own fact", source: 'user' });
    // Omitted scope: project-routed. Were this the Tier-1 accident guard, the message would name
    // "human-authored or verified"; it must instead be the alias refusal, thrown before ledgerOf(id)
    // (and therefore before the target's provenance is ever read) runs at all.
    expect(() => store.commit({ content: 'x', source: 'agent-inference', supersedes: bFact.id }))
      .toThrow(/resolves to another adopted project/);
  });

  it("an explicit global-scope supersede of B's id throws the SAME message as superseding an unknown id, and never touches B's file", () => {
    const { home, b, store } = aliasedPair();
    const bStore = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's2', project: { root: b, ledger: projectLedgerPath(b) } });
    const bFact = bStore.commit({ content: "B's own fact", source: 'user' });
    const before = readFileSync(projectLedgerPath(b), 'utf8');

    let messageForB: string | null = null;
    try {
      store.commit({ content: 'x', source: 'user', scope: 'global', supersedes: bFact.id });
    } catch (e) { messageForB = (e as Error).message; }

    let messageForUnknown: string | null = null;
    try {
      store.commit({ content: 'x', source: 'user', scope: 'global', supersedes: 'm_does-not-exist' });
    } catch (e) { messageForUnknown = (e as Error).message; }

    // No existence or class oracle: superseding B's REAL id and superseding a made-up id are
    // indistinguishable from the outside — both read as "not found", never "found but refused".
    expect(messageForB).not.toBeNull();
    expect(messageForB).toBe(messageForUnknown);
    expect(readFileSync(projectLedgerPath(b), 'utf8')).toBe(before);
  });

  it('confirm on a global id still succeeds and writes only to the global ledger, never touching B', () => {
    const { b, store } = aliasedPair();
    const before = readFileSync(projectLedgerPath(b), 'utf8');
    const g = store.commit({ content: 'a global fact to confirm', source: 'user', scope: 'global' });
    expect(() => store.confirm(g.id)).not.toThrow();
    expect(readFileSync(projectLedgerPath(b), 'utf8')).toBe(before);
  });
});

// Final review I-1 (ruling R24): a dangling chain of TWO links, both inside A's own tree, used to pass
// the one-link rule — the first commit created B's ledger holding A's record (probe B case 3).
describe('a dangling symlink chain inside the linking project (item 7, final review I-1)', () => {
  it("the omitted-scope commit is refused with the alias message and B's .helix gains no memory.jsonl", () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-p2pe-home-'));
    const a = mkdtempSync(join(tmpdir(), 'helix-p2pe-proj-'));
    const b = mkdtempSync(join(tmpdir(), 'helix-p2pe-proj-'));
    stampOwnership(a, home, {});
    stampOwnership(b, home, {});
    const hop = join(a, '.helix', 'hop');
    symlinkSync(projectLedgerPath(b), hop);          // A/.helix/hop -> B/.helix/memory.jsonl (absent)
    symlinkSync(hop, projectLedgerPath(a));          // A/.helix/memory.jsonl -> A/.helix/hop
    const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's1', project: { root: a, ledger: projectLedgerPath(a) } });
    expect(() => store.commit({ content: 'a fact for project A', source: 'user' })).toThrow(/resolves to another adopted project/);
    expect(existsSync(projectLedgerPath(b))).toBe(false);
    expect(readdirSync(join(b, '.helix'))).toEqual(['.owner']);
  });
});

// Final review M-1: healWitness gated the project layer on raw isOwned — true for an aliased layer
// too — so the startup heal took B's ledger lock and read B's bytes under A's scope key. It now uses
// the disposition gate every read path uses.
describe('healWitness leaves an aliased project layer alone (item 7, final review M-1)', () => {
  it("witness.json and B's bytes are unchanged, and the heal never reads through the alias", () => {
    const { home, a, b, store } = aliasedPair();
    store.commit({ content: 'a global fact before the heal', source: 'user', scope: 'global' });
    const witnessBefore = readFileSync(join(home, 'witness.json'));
    const bBefore = readFileSync(projectLedgerPath(b));
    const readSpy = vi.spyOn(ledgerMod, 'readLedgerBytes');
    try {
      store.healWitness();
      expect(readSpy.mock.calls.map((c) => c[0])).not.toContain(projectLedgerPath(a));
    } finally { readSpy.mockRestore(); }
    expect(readFileSync(join(home, 'witness.json')).equals(witnessBefore)).toBe(true);
    expect(readFileSync(projectLedgerPath(b)).equals(bBefore)).toBe(true);
  });
});
