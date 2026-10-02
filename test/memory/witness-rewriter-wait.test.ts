// IT-M6 (second fix batch §4.2), part (1): a witnessed compaction writes + fsyncs its tmp BEFORE
// openTransition publishes the journal, so the lock-free "journal over old bytes" window (window A)
// no longer spans the row writes and the tmp fsync.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { compactLedger, readLedgerBytes } from '../../src/memory/ledger.js';
import { realFsOps, type DurableFsOps } from '../../src/memory/fs-ops.js';
import * as witnessStoreMod from '../../src/memory/witness-store.js';
import { readScopeWitness } from '../../src/memory/witness-store.js';
import { readLedgerWitnessed } from '../../src/memory/witness-read.js';

const FIXED = '2026-10-01T00:00:00.000Z';
function newHome(): string { return mkdtempSync(join(tmpdir(), 'helix-rwwait-')); }
function store(home: string): { store: MemoryStore; ledger: string } {
  const ledger = join(home, 'memory.jsonl');
  let n = 0;
  return { store: new MemoryStore(ledger, { home, sessionId: 't', now: () => FIXED, genId: () => `m_${++n}` }), ledger };
}

describe('IT-M6 (1): compaction writes the tmp before it publishes the journal', () => {
  it('the tmp fsync happens while no journal is visible, then openTransition, then the rename', () => {
    const home = newHome();
    const { store: s, ledger } = store(home);
    const realOpen = witnessStoreMod.openTransition;
    const events: string[] = [];
    const openSpy = vi.spyOn(witnessStoreMod, 'openTransition').mockImplementation((...a) => { events.push('openTransition'); return realOpen(...a); });
    try {
      s.commit({ content: 'alpha deploy fact', source: 'user' });
      s.commit({ content: 'bravo deploy fact', source: 'user' });
      const logFs: DurableFsOps = {
        ...realFsOps,
        fsyncSync: (fd) => { events.push(readScopeWitness(home, '@global').journal ? 'tmp-fsync:journal-visible' : 'tmp-fsync:no-journal'); realFsOps.fsyncSync(fd); },
        renameSync: (from, to) => { events.push('rename'); realFsOps.renameSync(from, to); },
      };
      compactLedger(ledger, {
        erasedIds: new Set(), fsOps: logFs, legacyBakeAndDrop: true,
        witness: { home, scopeKey: '@global', now: () => FIXED, kind: 'compaction' },
      });
      expect(events).toEqual(['tmp-fsync:no-journal', 'openTransition', 'rename']);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('in-sync');
    } finally { openSpy.mockRestore(); rmSync(home, { recursive: true, force: true }); }
  });

  it('a tmp fsync failure opens no journal: nothing to retract, the scope stays where it was', () => {
    const home = newHome();
    const { store: s, ledger } = store(home);
    const openSpy = vi.spyOn(witnessStoreMod, 'openTransition');
    const discardSpy = vi.spyOn(witnessStoreMod, 'discardTransition');
    try {
      s.commit({ content: 'alpha deploy fact', source: 'user' });
      const before = readLedgerBytes(ledger);
      const failFs: DurableFsOps = { ...realFsOps, fsyncSync: () => { throw new Error('injected tmp fsync failure'); } };
      expect(() => compactLedger(ledger, {
        erasedIds: new Set(), fsOps: failFs, legacyBakeAndDrop: true,
        witness: { home, scopeKey: '@global', now: () => FIXED, kind: 'compaction' },
      })).toThrow(/injected tmp fsync failure/);
      expect(openSpy).not.toHaveBeenCalled();
      expect(discardSpy).not.toHaveBeenCalled();
      expect(readScopeWitness(home, '@global').journal).toBeNull();
      expect(readLedgerBytes(ledger).equals(before)).toBe(true);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('in-sync');
    } finally { openSpy.mockRestore(); discardSpy.mockRestore(); rmSync(home, { recursive: true, force: true }); }
  });
});
