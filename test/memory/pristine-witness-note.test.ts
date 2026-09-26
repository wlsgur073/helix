import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { classifyState, witnessPath } from '../../src/memory/witness-store.js';
import { witnessNoteFor, WITNESS_INIT_NOTE } from '../../src/memory/content-frame.js';
import { handleRecall, handleInspect } from '../../src/server/handlers.js';
import { gatherScopedRecords } from '../../src/hooks/session-start.js';
import { formatSessionStartContext } from '../../src/hooks/format-context.js';

const made: string[] = [];
const tmp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
const text = (res: { content: Array<{ type: string; text?: string }> }): string => res.content.map((c) => c.text ?? '').join('');

// Issue #2: the first-contact note discloses that a scope's CURRENT CONTENTS are unwitnessed and will
// be adopted as its baseline at the next write. An empty scope with no witness state has no contents
// to adopt, so it carries no note — which is what put the note on every session of a user who never
// writes the global scope.
describe('the first-contact note on an empty, never-witnessed scope (issue #2)', () => {
  it('is the plain-language constant, with no path in it', () => {
    expect(WITNESS_INIT_NOTE).toBe('(rollback witness: this memory scope has no verified baseline, so a rollback of its current contents would go undetected; the next write records them as the baseline)');
    expect(WITNESS_INIT_NOTE).not.toMatch(/[\\/]/);
  });

  it('renders nothing for a pristine scope, and still renders for contents without a witness entry or with a MAC-invalid one', () => {
    expect(witnessNoteFor({ kind: 'first-contact', reason: 'pristine' })).toBeNull();
    expect(witnessNoteFor({ kind: 'first-contact', reason: 'no-entry' })).toBe(WITNESS_INIT_NOTE);
    expect(witnessNoteFor({ kind: 'first-contact', reason: 'mac-invalid' })).toBe(WITNESS_INIT_NOTE);
  });

  it('keeps a MAC-invalid witness as mac-invalid even over an empty ledger', () => {
    expect(classifyState({ entry: null, journal: null, macInvalid: true }, Buffer.alloc(0)))
      .toEqual({ kind: 'first-contact', reason: 'mac-invalid' });
  });

  it('a fresh home: recall, inspect and SessionStart carry no witness note', () => {
    const home = tmp('helix-pw-home-');
    const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't' });
    expect(text(handleRecall(store, { query: 'anything at all here' }))).not.toContain(WITNESS_INIT_NOTE);
    expect(text(handleInspect(store, {}))).not.toContain(WITNESS_INIT_NOTE);
    const r = gatherScopedRecords({ home, globalLedger: join(home, 'memory.jsonl') });
    expect(r.witnessNotes).toEqual([]);
    expect(formatSessionStartContext(r.records, 'd'.repeat(32), { witnessNotes: r.witnessNotes })).toBe('');
  });

  it('a project-only user never sees it: the global scope stays empty and the first project write witnesses the project', () => {
    const home = tmp('helix-pw-home-'), root = tmp('helix-pw-proj-'), other = tmp('helix-pw-other-');
    const store = new MemoryStore(join(home, 'memory.jsonl'), {
      home, sessionId: 't', project: { ledger: join(root, '.helix', 'memory.jsonl'), root },
    });
    store.commit({ content: 'papa project fact', source: 'user' }); // adopts the project and witnesses it
    expect(text(handleRecall(store, { query: 'papa project fact' }))).not.toContain(WITNESS_INIT_NOTE);
    for (const cwd of [root, other]) {
      // userHome = the suite's temp root, so the parent-directory walk never leaves it.
      const r = gatherScopedRecords({ home, globalLedger: join(home, 'memory.jsonl'), cwd, userHome: tmpdir() });
      expect(r.witnessNotes, cwd).toEqual([]);
    }
  });

  it('contents with no witness entry still carry the note (a deleted witness file)', () => {
    const home = tmp('helix-pw-home-');
    const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't' });
    store.commit({ content: 'quebec global fact', source: 'user' });
    rmSync(witnessPath(home));
    expect(text(handleRecall(store, { query: 'quebec global fact' }))).toContain(WITNESS_INIT_NOTE);
    expect(gatherScopedRecords({ home, globalLedger: join(home, 'memory.jsonl') }).witnessNotes).toEqual([WITNESS_INIT_NOTE]);
  });
});
