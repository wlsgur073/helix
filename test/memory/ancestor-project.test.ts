import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { stampOwnership, canonicalRoot } from '../../src/memory/ownership.js';
import { handleCommit } from '../../src/server/handlers.js';

const made: string[] = [];
const tmp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
const text = (res: { content: Array<{ type: string; text?: string }> }): string => res.content.map((c) => c.text ?? '').join('');
const committed = (out: string): Record<string, unknown> => JSON.parse(out.replace(/^committed /, '')) as Record<string, unknown>;
const registry = (home: string): Record<string, unknown> =>
  existsSync(join(home, 'projects.json')) ? JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')) as Record<string, unknown> : {};
const fileText = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

function below(root: string): { home: string; store: MemoryStore } {
  const home = tmp('helix-ap-home-');
  mkdirSync(join(root, '.helix'), { recursive: true });
  let n = 0;
  const store = new MemoryStore(join(home, 'memory.jsonl'), {
    home, sessionId: 't', genId: () => `m_${++n}`,
    project: { ledger: join(root, '.helix', 'memory.jsonl'), root, origin: 'ancestor' },
  });
  return { home, store };
}

describe('a commit below a parent project that is not adopted', () => {
  it('is refused for an omitted scope, writes nothing anywhere, and claims nothing', () => {
    const root = tmp('helix-ap-proj-'); const { home, store } = below(root);
    expect(() => store.commit({ content: 'alpha project fact', source: 'user' })).toThrow(/not adopted/);
    expect(fileText(join(home, 'memory.jsonl'))).not.toContain('alpha project fact');
    expect(existsSync(join(root, '.helix', 'memory.jsonl'))).toBe(false);
    expect(existsSync(join(root, '.helix', '.owner'))).toBe(false);
    expect(registry(home)[canonicalRoot(root)]).toBeUndefined();
  });

  it("is refused for an explicit 'project' scope the same way", () => {
    const root = tmp('helix-ap-proj-'); const { store } = below(root);
    expect(() => store.commit({ content: 'bravo project fact', source: 'user', scope: 'project' })).toThrow(/not adopted/);
    expect(existsSync(join(root, '.helix', '.owner'))).toBe(false);
  });

  it("goes through for an explicit 'global' scope, and the result says global", () => {
    const root = tmp('helix-ap-proj-'); const { store } = below(root);
    const out = committed(text(handleCommit(store, { content: 'charlie global fact', source: 'user', scope: 'global' })));
    expect(out.scope).toBe('global');
  });

  it('is refused before a superseding commit reads its target', () => {
    const root = tmp('helix-ap-proj-'); const { store } = below(root);
    const g = store.commit({ content: 'delta old global fact', source: 'user', scope: 'global' });
    expect(() => store.commit({ content: 'delta new fact', source: 'user', supersedes: g.id })).toThrow(/not adopted/);
  });

  it("refuses an explicit 'project' erase", () => {
    const root = tmp('helix-ap-proj-'); const { store } = below(root);
    const g = store.commit({ content: 'echo global fact', source: 'user', scope: 'global' });
    expect(() => store.erase(g.id, { scope: 'project' })).toThrow(/not owned/);
  });

  // Review focus 5.
  it('names the root JSON-escaped, so a newline or quote in the path keeps the message on one line', () => {
    const root = join(tmp('helix-ap-odd-'), 'we"ird\nname'); const { store } = below(root);
    let message = '';
    try { store.commit({ content: 'foxtrot fact', source: 'user' }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain(JSON.stringify(root));
    expect(message).not.toContain('\n');
  });
});

describe('a parent project that is adopted', () => {
  it('takes an omitted-scope commit, serves it on recall, and the result says project', () => {
    const root = tmp('helix-ap-proj-'); const { home, store } = below(root);
    stampOwnership(root, home);
    const out = committed(text(handleCommit(store, { content: 'golf project fact', source: 'user' })));
    expect(out.scope).toBe('project');
    expect(store.recall('golf project fact').items.map((i) => i.scope)).toEqual(['project']);
  });

  it('can be adopted from the subdirectory by naming its absolute root, then takes commits', () => {
    const root = tmp('helix-ap-proj-'); const { store } = below(root);
    expect(() => store.commit({ content: 'hotel fact', source: 'user' })).toThrow(/not adopted/);
    expect(store.adopt(root)).toBe(canonicalRoot(root));
    expect(committed(text(handleCommit(store, { content: 'hotel fact', source: 'user' }))).scope).toBe('project');
    expect(existsSync(join(root, '.helix', '.owner'))).toBe(true);
  });
});

describe('commit results name the scope written', () => {
  it('global when no project layer is configured', () => {
    const home = tmp('helix-ap-home-');
    const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't' });
    expect(committed(text(handleCommit(store, { content: 'india fact', source: 'user' }))).scope).toBe('global');
  });

  it('project for a working-directory project, whose first commit still adopts it', () => {
    const home = tmp('helix-ap-home-'), root = tmp('helix-ap-proj-');
    const store = new MemoryStore(join(home, 'memory.jsonl'), {
      home, sessionId: 't', project: { ledger: join(root, '.helix', 'memory.jsonl'), root },
    });
    const out = committed(text(handleCommit(store, { content: 'juliet fact', source: 'user' })));
    expect(Object.keys(out)).toEqual(['id', 'scope', 'state', 'classification']);
    expect(out.scope).toBe('project');
  });
});
