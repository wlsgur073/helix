// runReal (`bench-replay --real`) benches the ACTUAL ledgers read-only. Its scope selection must
// honour the same rule every other multi-scope surface does: one physical file is never two
// participants (src/memory/scope-target.ts). The default install layout makes the collision
// reachable with no attacker at all — HELIX_HOME is `$HOME/.helix`, so `projectLedgerPath($HOME)`
// IS the global ledger, and a user who once adopted their home directory would otherwise get the
// one file benched twice: once as `global`, once as a phantom `project` row.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/store.js';
import { stampOwnership, isOwned, projectLedgerPath } from '../src/memory/ownership.js';
import { runReal } from '../scripts/bench-replay.js';

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function captureStdout(): { stdout: () => string; restore: () => void } {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += chunk.toString(); return true; });
  return { stdout: () => out, restore: () => spy.mockRestore() };
}

describe('bench-replay runReal — scope selection', () => {
  it('cwd == $HOME collision: exactly ONE scope row (global), no phantom project row', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'helix-bench-real-'));  // stands in for $HOME == cwd
    homes.push(fakeHome);
    const helixHome = join(fakeHome, '.helix');                         // HELIX_HOME, default layout
    const globalLedger = join(helixHome, 'memory.jsonl');
    mkdirSync(helixHome, { recursive: true });
    let n = 0;
    const store = new MemoryStore(globalLedger, { home: helixHome, sessionId: 'bench-real', genId: () => `m_${++n}` });
    store.commit({ content: 'a global-signed fact', source: 'user' });
    stampOwnership(fakeHome, helixHome, { genStamp: () => 'stamp' });   // real dual-key adoption
    expect(isOwned(fakeHome, helixHome)).toBe(true);                    // premise: the ownership gate alone would pass
    expect(projectLedgerPath(fakeHome)).toBe(globalLedger);             // premise: the collision itself

    const cap = captureStdout();
    try {
      runReal({ env: { HELIX_HOME: helixHome } as NodeJS.ProcessEnv, cwd: () => fakeHome });
    } finally { cap.restore(); }

    expect(cap.stdout()).toContain(`home=${helixHome}`);                // the injected home, not the ambient one
    const scopeRows = cap.stdout().split('\n').filter((l) => l.startsWith('scope='));
    expect(scopeRows).toHaveLength(1);
    expect(scopeRows[0]).toContain('scope=global');
  });

  it('symlinked project ledger: still ONE row — the rule is one INODE, not one path spelling', () => {
    // The textual compare a reader might reach for (`projectLedgerPath(cwd) !== globalLedger`)
    // passes here and puts the same inode on the report twice. scope-target.ts resolves both sides
    // first for exactly this reason. A normal adoption is used — the `.helix` DIRECTORY cannot be a
    // symlink (stampOwnership refuses one), so the reachable alias is the ledger FILE.
    const base = mkdtempSync(join(tmpdir(), 'helix-bench-real-'));
    homes.push(base);
    const helixHome = join(base, 'dot-helix');
    const projRoot = join(base, 'proj');
    const globalLedger = join(helixHome, 'memory.jsonl');
    mkdirSync(helixHome, { recursive: true });
    mkdirSync(join(projRoot, '.helix'), { recursive: true });
    let n = 0;
    const store = new MemoryStore(globalLedger, { home: helixHome, sessionId: 'bench-real3', genId: () => `m_${++n}` });
    store.commit({ content: 'a global-signed fact', source: 'user' });
    stampOwnership(projRoot, helixHome, { genStamp: () => 'stamp' });
    symlinkSync(globalLedger, projectLedgerPath(projRoot));
    expect(isOwned(projRoot, helixHome)).toBe(true);                     // premise: the ownership gate alone would pass
    expect(projectLedgerPath(projRoot)).not.toBe(globalLedger);          // premise: textually distinct, one inode

    const cap = captureStdout();
    try {
      runReal({ env: { HELIX_HOME: helixHome } as NodeJS.ProcessEnv, cwd: () => projRoot });
    } finally { cap.restore(); }

    const scopeRows = cap.stdout().split('\n').filter((l) => l.startsWith('scope='));
    expect(scopeRows).toHaveLength(1);
    expect(scopeRows[0]).toContain('scope=global');
  });

  it('a genuinely distinct owned project still benches as its own scope', () => {
    const base = mkdtempSync(join(tmpdir(), 'helix-bench-real-'));
    homes.push(base);
    const helixHome = join(base, 'dot-helix');                          // NOT under the project root
    const projRoot = join(base, 'proj');
    const globalLedger = join(helixHome, 'memory.jsonl');
    mkdirSync(helixHome, { recursive: true });
    mkdirSync(join(projRoot, '.helix'), { recursive: true });
    let n = 0;
    const store = new MemoryStore(globalLedger, {
      home: helixHome, sessionId: 'bench-real2', genId: () => `m_${++n}`,
      project: { ledger: projectLedgerPath(projRoot), root: projRoot },
    });
    store.commit({ content: 'a global fact', source: 'user' });
    stampOwnership(projRoot, helixHome, { genStamp: () => 'stamp' });

    const cap = captureStdout();
    try {
      runReal({ env: { HELIX_HOME: helixHome } as NodeJS.ProcessEnv, cwd: () => projRoot });
    } finally { cap.restore(); }

    const scopeRows = cap.stdout().split('\n').filter((l) => l.startsWith('scope='));
    expect(scopeRows).toHaveLength(2);
    expect(scopeRows[1]).toContain('scope=project');
  });
});
