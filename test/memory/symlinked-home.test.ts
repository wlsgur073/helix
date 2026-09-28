// IT-H2: a symlinked HELIX_HOME is refused (ensureHelixDir), but the refusal used to come from
// advanceWitness AFTER the append had landed: the caller saw an error while the link target's ledger
// already held the row, and a retry wrote it again. The home is now validated before the ledger is
// touched on every witnessed write. The same ordering makes ensureHelixDir's non-recursive rule apply
// to a first commit (spec decision D2): a home whose parent is missing is refused, not created as a
// chain.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';

function store(home: string, ledger: string = join(home, 'memory.jsonl')): MemoryStore {
  let n = 0;
  return new MemoryStore(ledger, { sessionId: 's', home, now: () => '2026-09-27T00:00:00.000Z', genId: () => `m_${++n}` });
}
const bytesOf = (p: string): Buffer => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0));

const posixOnly = describe.skipIf(process.platform === 'win32');

posixOnly('a symlinked HELIX_HOME is refused before any ledger write (IT-H2)', () => {
  function layout(): { base: string; real: string; link: string } {
    const base = mkdtempSync(join(tmpdir(), 'helix-linkhome-'));
    const real = join(base, 'real');
    mkdirSync(real, { mode: 0o700 });
    const link = join(base, 'link');
    symlinkSync(real, link);
    return { base, real, link };
  }

  it('commit is refused and the link target ledger stays empty, on the first try and on a retry', () => {
    const { base, real, link } = layout();
    try {
      const s = store(link);
      expect(() => s.commit({ content: 'the build uses node 24', source: 'user' })).toThrow(/symlink/);
      expect(() => s.commit({ content: 'the build uses node 24', source: 'user' })).toThrow(/symlink/);
      expect(bytesOf(join(real, 'memory.jsonl')).length).toBe(0);
      expect(readdirSync(real).filter((n) => n.endsWith('.lock'))).toEqual([]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // Seed through the REAL path, then read once: a read after the master key exists mints the global
  // nonce, which is the state a home replaced by a symlink is normally in. Without it the erase is
  // refused earlier (the nonce mint calls ensureHelixDir) and never reaches the append at all.
  function seeded(real: string): string {
    const s = store(real);
    const rec = s.commit({ content: 'the deploy target is staging', source: 'user' });
    s.inspect();
    return rec.id;
  }

  it('a soft erase through the link is refused and leaves the ledger byte-identical', () => {
    const { base, real, link } = layout();
    try {
      const id = seeded(real);
      const before = bytesOf(join(real, 'memory.jsonl'));
      expect(() => store(link).erase(id)).toThrow(/symlink/);
      expect(bytesOf(join(real, 'memory.jsonl')).equals(before)).toBe(true);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('a permanent erase through the link is refused before its tombstone lands', () => {
    const { base, real, link } = layout();
    try {
      const id = seeded(real);
      const before = bytesOf(join(real, 'memory.jsonl'));
      expect(() => store(link).erase(id, { permanent: true })).toThrow(/symlink/);
      expect(bytesOf(join(real, 'memory.jsonl')).equals(before)).toBe(true);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('a dangling-symlink home reads as empty memory, refuses a commit, and creates nothing at the target', () => {
    const base = mkdtempSync(join(tmpdir(), 'helix-danglinghome-'));
    const target = join(base, 'never-created');
    const link = join(base, 'link');
    symlinkSync(target, link);
    try {
      const s = store(link);
      expect(s.inspect()).toEqual([]);
      expect(() => s.commit({ content: 'the queue is sqs', source: 'user' })).toThrow(/symlink/);
      expect(existsSync(target)).toBe(false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe('the home is validated before the ledger is touched (D2)', () => {
  it('a HELIX_HOME whose parent does not exist refuses the first commit and creates nothing', () => {
    const base = mkdtempSync(join(tmpdir(), 'helix-noparent-'));
    const home = join(base, 'missing-parent', 'hh');
    try {
      expect(() => store(home).commit({ content: 'the queue is sqs', source: 'user' })).toThrow(/refusing to create .*parent/);
      expect(existsSync(join(base, 'missing-parent'))).toBe(false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // Review Focus: the home gate and the ledger directory's own mkdir must compose.
  it('a missing home plus a HELIX_LEDGER directory that does not exist yet: the first commit creates both and succeeds', () => {
    const base = mkdtempSync(join(tmpdir(), 'helix-bothmissing-'));
    const home = join(base, 'hh');
    const ledger = join(base, 'ledgers', 'deep', 'memory.jsonl');
    try {
      store(home, ledger).commit({ content: 'the queue is sqs', source: 'user' });
      if (platform() !== 'win32') expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
