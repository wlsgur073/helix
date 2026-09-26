import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { projectDispositionOf, stampOwnership } from '../../src/memory/ownership.js';
import { handleRecall, handleInspect } from '../../src/server/handlers.js';
import { formatSessionStartContext } from '../../src/hooks/format-context.js';
import { ANCESTOR_UNADOPTED_NOTE, UNADOPTED_LEDGER_NOTE } from '../../src/memory/content-frame.js';

const made: string[] = [];
const tmp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
const text = (res: { content: Array<{ type: string; text?: string }> }): string => res.content.map((c) => c.text ?? '').join('');

function ancestorStore(home: string, root: string): MemoryStore {
  let n = 0;
  return new MemoryStore(join(home, 'memory.jsonl'), {
    home, sessionId: 't', genId: () => `m_${++n}`,
    project: { ledger: join(root, '.helix', 'memory.jsonl'), root, origin: 'ancestor' },
  });
}
function plantLedger(root: string, content: string): void {
  mkdirSync(join(root, '.helix'), { recursive: true });
  writeFileSync(join(root, '.helix', 'memory.jsonl'), JSON.stringify({
    id: 'm_parent', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content, provenance: { source: 'user', sessionId: 'x' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  }) + '\n');
}
/** The as-of cursor from the global ledger's own newest row, never the wall clock (see unadopted-disclosure.test.ts). */
function asOfLatest(ledger: string): string {
  return readFileSync(ledger, 'utf8').split('\n').filter((l) => l.trim() !== '')
    .map((l) => (JSON.parse(l) as { tx: string }).tx).sort().at(-1)!;
}

describe('ancestor-unadopted disposition', () => {
  it('an unowned parent project is ancestor-unadopted, with or without a ledger file', () => {
    const home = tmp('helix-ad-home-'), root = tmp('helix-ad-proj-');
    mkdirSync(join(root, '.helix'));
    const ledger = join(root, '.helix', 'memory.jsonl');
    expect(projectDispositionOf({ root, home, ledger, origin: 'ancestor' })).toBe('ancestor-unadopted');
    plantLedger(root, 'parent fact');
    expect(projectDispositionOf({ root, home, ledger, origin: 'ancestor' })).toBe('ancestor-unadopted');
  });

  it('an owned parent project is owned, exactly like one found at the working directory', () => {
    const home = tmp('helix-ad-home-'), root = tmp('helix-ad-proj-');
    mkdirSync(join(root, '.helix'));
    stampOwnership(root, home);
    expect(projectDispositionOf({ root, home, ledger: join(root, '.helix', 'memory.jsonl'), origin: 'ancestor' })).toBe('owned');
  });

  it('origin cwd, or no origin, keeps the existing states', () => {
    const home = tmp('helix-ad-home-'), root = tmp('helix-ad-proj-');
    const ledger = join(root, '.helix', 'memory.jsonl');
    expect(projectDispositionOf({ root, home, ledger })).toBe('inactive');
    plantLedger(root, 'foreign fact');
    expect(projectDispositionOf({ root, home, ledger, origin: 'cwd' })).toBe('unadopted-present');
  });
});

describe('ANCESTOR_UNADOPTED_NOTE', () => {
  it('is a constant disclosure with no path in it', () => {
    expect(ANCESTOR_UNADOPTED_NOTE).toBe("(a parent directory holds a Helix project that is not adopted; project memory is off for this session and that project's contents are excluded from results; adoption requires explicit user approval)");
    expect(ANCESTOR_UNADOPTED_NOTE).not.toMatch(/[\\/]/);
  });

  it('renders on recall, empty and not, and on every inspect view, while the parent fact stays out', () => {
    const home = tmp('helix-ad-home-'), root = tmp('helix-ad-proj-');
    plantLedger(root, 'zulu parent fact');
    const store = ancestorStore(home, root);
    expect(text(handleRecall(store, { query: 'nothing matches this query at all' }))).toContain(ANCESTOR_UNADOPTED_NOTE);
    store.commit({ content: 'yankee global fact', source: 'user', scope: 'global' });
    const full = text(handleRecall(store, { query: 'yankee global fact' }));
    expect(full).toContain('yankee global fact');
    expect(full).toContain(ANCESTOR_UNADOPTED_NOTE);
    expect(full).not.toContain('zulu parent fact');
    expect(full).not.toContain(UNADOPTED_LEDGER_NOTE);
    expect(text(handleInspect(store, {}))).toContain(ANCESTOR_UNADOPTED_NOTE);
    expect(text(handleInspect(store, { history: true }))).toContain(ANCESTOR_UNADOPTED_NOTE);
    expect(text(handleInspect(store, { asOf: asOfLatest(join(home, 'memory.jsonl')) }))).toContain(ANCESTOR_UNADOPTED_NOTE);
  });

  it('is gone once the parent project is adopted', () => {
    const home = tmp('helix-ad-home-'), root = tmp('helix-ad-proj-');
    mkdirSync(join(root, '.helix'));
    stampOwnership(root, home);
    const store = ancestorStore(home, root);
    expect(text(handleRecall(store, { query: 'anything at all here' }))).not.toContain(ANCESTOR_UNADOPTED_NOTE);
  });

  it('renders alone in the SessionStart block when memory is empty', () => {
    expect(formatSessionStartContext([], 'd'.repeat(32), { ancestorUnadopted: true })).toBe(ANCESTOR_UNADOPTED_NOTE);
  });
});
