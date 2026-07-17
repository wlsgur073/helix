import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';

// B1: one per-call project disposition snapshot ('inactive' | 'owned' | 'unadopted-present'),
// reused for every project-inclusion decision within a single public read call. These tests lock
// the OBSERVABLE behavior through the store's public surface (recall/commit) — the brief accepts
// this as sufficient when the private predicate itself isn't directly testable; the diff reviewer
// checks the routing structurally.

function newHome(): string { return mkdtempSync(join(tmpdir(), 'helix-pd-home-')); }
function newProjectRoot(): string { return mkdtempSync(join(tmpdir(), 'helix-pd-proj-')); }

describe('project disposition snapshot (B1)', () => {
  it('(a) inactive — no project layer configured: recall sees global only', () => {
    const home = newHome();
    try {
      const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't' });
      store.commit({ content: 'alpha global fact', source: 'user' });
      const items = store.recall('alpha global fact').items;
      expect(items.length).toBe(1);
      expect(items[0]!.scope).toBe('global');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('(b) owned — an adopted project ledger participates in recall', () => {
    const home = newHome();
    const root = newProjectRoot();
    try {
      const ledger = join(root, '.helix', 'memory.jsonl');
      const store = new MemoryStore(join(home, 'memory.jsonl'),
        { home, sessionId: 't', project: { ledger, root, home } });
      store.adopt(); // stamps ownership explicitly (team-shared-ledger flow)
      store.commit({ content: 'bravo project fact', source: 'user', scope: 'project' });
      const items = store.recall('bravo project fact').items;
      expect(items.length).toBe(1);
      expect(items[0]!.scope).toBe('project');
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
  });

  it('(c) unadopted-present — ledger file exists but unowned: recall excludes it AND commit still throws the adopt-hint error (both halves of the asymmetry)', () => {
    const home = newHome();
    const root = newProjectRoot();
    try {
      const ledger = join(root, '.helix', 'memory.jsonl');
      // Plant a foreign ledger file WITHOUT stamping ownership (simulates a team-shared/cloned repo).
      mkdirSync(join(root, '.helix'), { recursive: true });
      writeFileSync(ledger, JSON.stringify({
        id: 'm_foreign', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
        type: 'assert', state: 'Fresh', content: 'charlie foreign fact',
        provenance: { source: 'user', sessionId: 'x' }, supersedes: null, blastRadius: null,
        reverifyTrigger: null, classification: 'normal',
      }) + '\n');
      const store = new MemoryStore(join(home, 'memory.jsonl'),
        { home, sessionId: 't', project: { ledger, root, home } });

      // Read half: unadopted-present is excluded from recall, same as pre-B1 behavior.
      expect(store.recall('charlie foreign fact').items).toEqual([]);

      // Write half: commit to project scope still fails loud with the adopt-hint error — B1 must not
      // change targetLedger()'s independent, fresh commit-side check.
      expect(() => store.commit({ content: 'x', source: 'user', scope: 'project' }))
        .toThrow(/adopt it explicitly.*helix_memory_adopt/);
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
  });

  it('(d) inactive (configured, not owned, no ledger file yet): recall is global-only, and commit still succeeds via the auto-stamp path', () => {
    const home = newHome();
    const root = newProjectRoot();
    try {
      const ledger = join(root, '.helix', 'memory.jsonl');
      // Project layer configured but nothing on disk yet — no .helix dir, no ledger file.
      const store = new MemoryStore(join(home, 'memory.jsonl'),
        { home, sessionId: 't', project: { ledger, root, home } });
      // Disjoint vocabulary from the project fact below — recall's synonym expansion must not bridge
      // unrelated concrete nouns, so each query stays a clean single-record match.
      store.commit({ content: 'umbrella pancake giraffe', source: 'user', scope: 'global' });
      const items = store.recall('umbrella pancake giraffe').items;
      expect(items.length).toBe(1);
      expect(items[0]!.scope).toBe('global');

      // commit to project scope succeeds via the auto-stamp path — today's behavior, unaffected by B1.
      expect(() => store.commit({ content: 'bicycle lantern compass', source: 'user', scope: 'project' })).not.toThrow();
      // ...and having just auto-stamped ownership, disposition is now 'owned': the next recall picks
      // the project fact up too (fresh-per-call, not memoized across calls).
      const after = store.recall('bicycle lantern compass').items;
      expect(after.length).toBe(1);
      expect(after[0]!.scope).toBe('project');
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
  });
});
