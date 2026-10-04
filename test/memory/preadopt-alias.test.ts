// Δ4-37 (second fix batch, C1): the first commit of a project not yet adopted used to claim it with no
// alias check, so a dangling link to another adopted project's (or the global) ledger created that
// other file holding the record. Linked to another project's ledger, the project was excluded only
// from then on; linked to the global ledger, it stayed in use until the next server start. Both rules
// now run before ownership is stamped: refused, no ownership recorded, no file created.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { stampOwnership, projectLedgerPath, isOwned } from '../../src/memory/ownership.js';

const text = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '<absent>');

/** An adopted project B with NO ledger yet, and an unadopted project U with a `.helix/` folder. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'helix-d437-home-'));
  const b = mkdtempSync(join(tmpdir(), 'helix-d437-proj-'));
  const u = mkdtempSync(join(tmpdir(), 'helix-d437-proj-'));
  stampOwnership(b, home, {});
  mkdirSync(join(u, '.helix'));
  const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's', project: { root: u, ledger: projectLedgerPath(u), origin: 'cwd' } });
  return { home, b, u, store };
}

function refusalOf(f: () => unknown): string {
  try { f(); } catch (e) { return (e as Error).message; }
  return '<no refusal>';
}

describe('the pre-adopt alias check (Δ4-37)', () => {
  it("a dangling link to another adopted project's absent ledger: refused, B's ledger not created, U not adopted", () => {
    const { home, b, u, store } = fixture();
    symlinkSync(projectLedgerPath(b), projectLedgerPath(u));
    const registryBefore = text(join(home, 'projects.json'));
    expect(() => store.commit({ content: 'a fact for U', source: 'user' })).toThrow(/resolves to another adopted project/);
    expect(existsSync(projectLedgerPath(b))).toBe(false);
    expect(readdirSync(join(b, '.helix'))).toEqual(['.owner']);
    expect(text(join(home, 'projects.json'))).toBe(registryBefore);
    expect(isOwned(u, home)).toBe(false);
    expect(existsSync(join(u, '.helix', '.owner'))).toBe(false);
  });

  it("the same through `dl/..` inside U: refused before any byte moves", () => {
    const { home, b, u, store } = fixture();
    mkdirSync(join(u, 'x'));
    symlinkSync(join(u, 'x'), join(u, '.helix', 'dl'));
    symlinkSync(['dl', '..', '..', basename(b), '.helix', 'memory.jsonl'].join('/'), projectLedgerPath(u));
    expect(() => store.commit({ content: 'a fact for U', source: 'user' })).toThrow(/resolves to another adopted project/);
    expect(existsSync(projectLedgerPath(b))).toBe(false);
    expect(isOwned(u, home)).toBe(false);
  });

  // A store built with this layer by hand is the shape a link that appears AFTER the server started
  // leaves behind: at startup project-root.ts gives a `.helix` that holds the global ledger no project
  // layer at all (ruling R6, test/acceptance/global-link-store.e2e.test.ts), so the commit is global there.
  it('a dangling link to the global ledger that does not exist yet: refused, the global ledger not created', () => {
    const { home, u, store } = fixture();
    symlinkSync(join(home, 'memory.jsonl'), projectLedgerPath(u));
    expect(() => store.commit({ content: 'a fact for U', source: 'user' })).toThrow(/to the global memory file/);
    expect(existsSync(join(home, 'memory.jsonl'))).toBe(false);
    expect(isOwned(u, home)).toBe(false);
  });

  it('the same post-start shape with the global ledger EXISTING: refused as a foreign memory file (the link resolves to a file Helix did not create here)', () => {
    const { home, u, store } = fixture();
    store.commit({ content: 'a global fact first', source: 'user', scope: 'global' });            // creates the global ledger
    symlinkSync(join(home, 'memory.jsonl'), projectLedgerPath(u));
    const before = readFileSync(join(home, 'memory.jsonl'), 'utf8');
    expect(() => store.commit({ content: 'a fact for U', source: 'user' })).toThrow(/a project memory file exists here that Helix did not create/);
    expect(readFileSync(join(home, 'memory.jsonl'), 'utf8')).toBe(before);
    expect(isOwned(u, home)).toBe(false);
  });

  it('an unresolvable ledger (a non-UTF-8 link body) is refused before adoption too', () => {
    const { home, u, store } = fixture();
    symlinkSync(Buffer.from([0xff]), projectLedgerPath(u));
    expect(() => store.commit({ content: 'a fact for U', source: 'user' })).toThrow(/resolves to another adopted project/);
    expect(isOwned(u, home)).toBe(false);
  });

  it('a plain unadopted project still auto-adopts on its first commit (no regression)', () => {
    const { home, u, store } = fixture();
    expect(store.commitScoped({ content: 'a fact for U', source: 'user' }).scope).toBe('project');
    expect(isOwned(u, home)).toBe(true);
    expect(text(projectLedgerPath(u))).toContain('a fact for U');
  });

  it("a link inside U's own tree to a file in U's own tree still auto-adopts", () => {
    const { home, u, store } = fixture();
    mkdirSync(join(u, 'data'));
    symlinkSync(join(u, 'data', 'mem.jsonl'), projectLedgerPath(u));
    expect(store.commitScoped({ content: 'a fact for U', source: 'user' }).scope).toBe('project');
    expect(isOwned(u, home)).toBe(true);
    expect(text(join(u, 'data', 'mem.jsonl'))).toContain('a fact for U');
  });

  it("the first shape with an EXPLICIT scope 'project': refused, B's ledger not created, U not adopted", () => {
    const { home, b, u, store } = fixture();
    symlinkSync(projectLedgerPath(b), projectLedgerPath(u));
    expect(() => store.commit({ content: 'a fact for U', source: 'user', scope: 'project' })).toThrow(/resolves to another adopted project/);
    expect(existsSync(projectLedgerPath(b))).toBe(false);
    expect(isOwned(u, home)).toBe(false);
  });

  it('an explicit global commit is untouched by the check', () => {
    const { home, b, u, store } = fixture();
    symlinkSync(projectLedgerPath(b), projectLedgerPath(u));
    expect(store.commitScoped({ content: 'a global fact', source: 'user', scope: 'global' }).scope).toBe('global');
    expect(text(join(home, 'memory.jsonl'))).toContain('a global fact');
    expect(existsSync(projectLedgerPath(b))).toBe(false);
  });

  it("a project that is the TARGET of another adopted project's link is not refused itself: the linking side is the aliased one", () => {
    const { home, b, u, store } = fixture();
    symlinkSync(projectLedgerPath(u), projectLedgerPath(b));          // B's file leads into U's own (absent) file
    expect(store.commitScoped({ content: 'a fact for U', source: 'user' }).scope).toBe('project');
    expect(isOwned(u, home)).toBe(true);
    expect(text(projectLedgerPath(u))).toContain('a fact for U');
  });
});

// Ruling R7 with plan refinement P1: the pre-adopt refusal is the one alias write refusal, so an
// unresolvable ledger met before adoption gets the text that names that cause too.
describe('the pre-adopt refusal is the alias refusal (R7, P1)', () => {
  const ALIAS_REFUSAL =
    "commit: this project's memory file resolves to another adopted project's memory file, to the global memory file, " +
    'or through a path Helix cannot resolve, so the project layer is disabled here — the write is refused rather than ' +
    "written into the other project's memory. Ask the user whether to store this fact in global memory, which every " +
    "project sees, or to replace the link with the project's own file; do not choose for them.";

  it('pre-adopt, unresolvable (a non-UTF-8 link body): the exact text', () => {
    const { u, store } = fixture();
    symlinkSync(Buffer.from([0xff]), projectLedgerPath(u));
    expect(refusalOf(() => store.commit({ content: 'a fact for U', source: 'user' }))).toBe(ALIAS_REFUSAL);
  });
});
