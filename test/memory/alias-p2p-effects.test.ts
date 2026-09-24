import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { stampOwnership, projectLedgerPath } from '../../src/memory/ownership.js';
import { handleRecall, handleInspect } from '../../src/server/handlers.js';
import { ALIASED_LEDGER_NOTE } from '../../src/memory/content-frame.js';

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
