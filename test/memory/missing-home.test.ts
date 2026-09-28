// IT-H1: a fresh install has no HELIX_HOME directory yet. Every read surface must behave as it does
// over an empty existing home. The witness read used to throw ENOENT from canonical()'s realpath of
// the missing directory, so the first read of a fresh install returned a raw error, and a commit with
// HELIX_LEDGER set outside the home failed outright.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';

function store(home: string, ledger: string = join(home, 'memory.jsonl')): MemoryStore {
  let n = 0;
  return new MemoryStore(ledger, { sessionId: 's', home, now: () => '2026-09-27T00:00:00.000Z', genId: () => `m_${++n}` });
}

describe('a HELIX_HOME that does not exist yet (IT-H1)', () => {
  it('inspect, recall, history and asOf read it as empty memory and create nothing', () => {
    const base = mkdtempSync(join(tmpdir(), 'helix-nohome-'));
    const home = join(base, 'hh');
    try {
      const s = store(home);
      expect(s.inspect()).toEqual([]);
      const r = s.recall('anything at all');
      expect(r.items).toEqual([]);
      expect(r.appendix).toEqual([]);
      expect(s.historyView().rows).toEqual([]);
      expect(s.asOfView('2026-09-27T00:00:00.000Z').facts).toEqual([]);
      expect(existsSync(home)).toBe(false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('a first commit with the ledger outside the missing home succeeds, and the home is created 0700', () => {
    const base = mkdtempSync(join(tmpdir(), 'helix-nohome-'));
    const home = join(base, 'hh');
    const ledger = join(base, 'ledger-dir', 'memory.jsonl');
    try {
      store(home, ledger).commit({ content: 'the build uses node 24', source: 'user' });
      expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(existsSync(home)).toBe(true);
      if (platform() !== 'win32') expect(statSync(home).mode & 0o777).toBe(0o700);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
