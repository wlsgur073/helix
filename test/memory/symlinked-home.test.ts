// IT-H2: a symlinked HELIX_HOME is refused (ensureHelixDir), but the refusal used to come from
// advanceWitness AFTER the append had landed: the caller saw an error while the link target's ledger
// already held the row, and a retry wrote it again. The home is now validated before anything is
// written to a ledger on every witnessed write; the cases below cover commit, soft and permanent
// erase, confirm and recheck (the last two take the ledger lock and read the ledger first). The same
// ordering makes ensureHelixDir's non-recursive rule apply to a first commit (spec decision D2): a
// home whose parent is missing is refused, not created as a chain.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, readdirSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  it('a symlinked home spelled with a trailing slash is refused the same way', () => {
    const { base, real, link } = layout();
    try {
      const s = store(link + '/');
      expect(() => s.commit({ content: 'the build uses node 24', source: 'user' })).toThrow(/symlink/);
      expect(bytesOf(join(real, 'memory.jsonl')).length).toBe(0);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // Seed through the REAL path, then read once: a read after the master key exists mints the global
  // nonce, which is the state a home replaced by a symlink is normally in. Without it a write through
  // the link is refused earlier (the nonce mint calls ensureHelixDir) and never reaches the append at
  // all, so each case first proves that a read through the link works.
  function seeded(real: string, content = 'the deploy target is staging'): string {
    const s = store(real);
    const rec = s.commit({ content, source: 'user' });
    s.inspect();
    return rec.id;
  }

  it('a soft erase through the link is refused and leaves the ledger byte-identical', () => {
    const { base, real, link } = layout();
    try {
      const id = seeded(real);
      const before = bytesOf(join(real, 'memory.jsonl'));
      expect(store(link).inspect().map((r) => r.record.id)).toContain(id);
      expect(() => store(link).erase(id)).toThrow(/symlink/);
      expect(bytesOf(join(real, 'memory.jsonl')).equals(before)).toBe(true);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('a permanent erase through the link is refused before its tombstone lands', () => {
    const { base, real, link } = layout();
    try {
      const id = seeded(real);
      const before = bytesOf(join(real, 'memory.jsonl'));
      expect(store(link).inspect().map((r) => r.record.id)).toContain(id);
      expect(() => store(link).erase(id, { permanent: true })).toThrow(/symlink/);
      expect(bytesOf(join(real, 'memory.jsonl')).equals(before)).toBe(true);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // confirm and recheck sign under the ledger lock (store.ts writeVerify), whose ensureMaster returns
  // an existing key before its own ensureHelixDir. Once the key exists, the gate at the top of
  // appendWitnessedUnlocked is the only home check on this path, so each case asserts the key first.
  it('a confirm through the link is refused and leaves the ledger byte-identical', () => {
    const { base, real, link } = layout();
    try {
      const id = seeded(real);
      expect(existsSync(join(real, 'ledger-mac-master.key'))).toBe(true);
      const before = bytesOf(join(real, 'memory.jsonl'));
      expect(store(link).inspect().map((r) => r.record.id)).toContain(id);
      expect(() => store(link).confirm(id)).toThrow(/symlink/);
      expect(bytesOf(join(real, 'memory.jsonl')).equals(before)).toBe(true);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('a recheck through the link is refused and leaves the ledger byte-identical', () => {
    const { base, real, link } = layout();
    try {
      // The fact path is committed into ledger content, so it is a FIXED, low-entropy name under the
      // real system temp: a mkdtemp path would be redacted by the write-path scanner and the
      // file-contains binding would then fail. Constant content and no delete make the one file safe
      // to share across concurrent runs (precedent: compaction.test.ts, the signed-demotion case).
      const factDir = join(process.env.HELIX_TEST_SYS_TMP ?? tmpdir(), 'helix-verify-link-probe');
      mkdirSync(factDir, { recursive: true });
      const fact = join(factDir, 'fact.txt');
      writeFileSync(fact, 'staging\n');
      const id = seeded(real, `the file ${fact} says staging`);
      expect(existsSync(join(real, 'ledger-mac-master.key'))).toBe(true);
      const before = bytesOf(join(real, 'memory.jsonl'));
      expect(store(link).inspect().map((r) => r.record.id)).toContain(id);
      expect(() => store(link).recheck(id, { kind: 'file-contains', path: fact, pattern: 'staging' })).toThrow(/symlink/);
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
