// Third fix batch B1, task A5 (design 4.1 item 3, 4.2 row 7, 14: decision 9): device and inode are compared as bigint;
// an inode of 0 is never equality, and in the check after the open it skips the identity half only.
import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, lstatSync, statSync, realpathSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as pathIdentityMod from '../../src/memory/path-identity.js';
import { fileIdentityAt, sameFile, hasComparableInode, type FileIdentity } from '../../src/memory/path-identity.js';
import { appendRecordUnlocked, isLedgerDestinationChangedError } from '../../src/memory/ledger.js';
import { realFsOps, type DurableFsOps } from '../../src/memory/fs-ops.js';
import type { MemoryRecord } from '../../src/types.js';

const dir = (): string => mkdtempSync(join(tmpdir(), 'helix-fileid-'));
const thrownBy = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return undefined; };
const rec = (id: string): MemoryRecord => ({
  id, tx: '2026-10-01T00:00:00.000Z', validFrom: '2026-10-01T00:00:00.000Z', validTo: null, type: 'assert', state: 'Fresh',
  content: `fact ${id}`, provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
});
const id = (dev: bigint, ino: bigint): FileIdentity => ({ dev, ino });

describe('sameFile and hasComparableInode', () => {
  it('compares as bigint: two inodes that differ only above 2^53 are two files', () => {
    const a = id(7n, 2n ** 60n); const b = id(7n, 2n ** 60n + 1n);
    expect(Number(a.ino) === Number(b.ino)).toBe(true);        // the premise: JS numbers cannot tell them apart
    expect(sameFile(a, b)).toBe(false);
    expect(sameFile(a, id(7n, 2n ** 60n))).toBe(true);
  });

  it('the device counts: the same inode on another device is another file', () => {
    expect(sameFile(id(1n, 5n), id(2n, 5n))).toBe(false);
  });

  it('an inode of 0 is never equality, not even against itself, and is not comparable', () => {
    expect(hasComparableInode(id(1n, 0n))).toBe(false);
    expect(sameFile(id(1n, 0n), id(1n, 0n))).toBe(false);
    expect(sameFile(id(1n, 0n), id(1n, 5n))).toBe(false);
  });

  it('nothing (null) is never the same as anything', () => {
    expect(hasComparableInode(null)).toBe(false);
    expect(sameFile(null, null)).toBe(false);
    expect(sameFile(null, id(1n, 5n))).toBe(false);
  });
});

describe('fileIdentityAt', () => {
  it('reads device and inode as bigint, null for a missing path, and does not follow a link unless asked', () => {
    const d = dir();
    const f = join(d, 'f'); writeFileSync(f, '');
    symlinkSync(f, join(d, 'l'));
    const st = lstatSync(f, { bigint: true });
    expect(fileIdentityAt(f)).toEqual({ dev: st.dev, ino: st.ino });
    expect(typeof fileIdentityAt(f)!.ino).toBe('bigint');
    expect(fileIdentityAt(join(d, 'absent'))).toBeNull();
    const link = lstatSync(join(d, 'l'), { bigint: true });
    expect(fileIdentityAt(join(d, 'l'))).toEqual({ dev: link.dev, ino: link.ino });                       // the link itself
    expect(sameFile(fileIdentityAt(join(d, 'l')), fileIdentityAt(f))).toBe(false);
    expect(fileIdentityAt(join(d, 'l'), { follow: true })).toEqual({ dev: statSync(f, { bigint: true }).dev, ino: statSync(f, { bigint: true }).ino });
  });

  it('any other error is thrown, not read as absence', () => {
    const d = dir();
    writeFileSync(join(d, 'afile'), '');
    expect((thrownBy(() => fileIdentityAt(join(d, 'afile', 'x'))) as NodeJS.ErrnoException).code).toBe('ENOTDIR');
  });

  it('the stat seam: a probe answering inode 0 or a huge inode is passed through unchanged, with the follow flag', () => {
    const seen: boolean[] = [];
    expect(fileIdentityAt('/x', { probe: (_p, follow) => { seen.push(follow); return id(5n, 0n); } })).toEqual(id(5n, 0n));
    expect(fileIdentityAt('/x', { follow: true, probe: (_p, follow) => { seen.push(follow); return id(5n, 2n ** 62n + 3n); } })).toEqual(id(5n, 2n ** 62n + 3n));
    expect(seen).toEqual([false, true]);
  });
});

describe('the descriptor seam and the check after the open', () => {
  it('the real fstat seam answers dev and ino as bigint, the rest as numbers', () => {
    const f = join(dir(), 'f'); writeFileSync(f, 'x');
    const fd = realFsOps.openSync(f, 'r');
    try {
      const s = realFsOps.fstatSync(fd);
      expect(typeof s.dev).toBe('bigint');
      expect(typeof s.ino).toBe('bigint');
      expect(typeof s.size).toBe('number');
      expect(s.ino).toBe(lstatSync(f, { bigint: true }).ino);
    } finally { realFsOps.closeSync(fd); }
  });

  /** Patches the answer for a regular file's descriptor only. From A6 on the append also fstats the held directory, and
   *  A6 compares that answer with a stat of /proc/self/fd/<n>, which this fake does not reach: a patched directory would
   *  read as "/proc was lost", which is not what these cases are about. */
  const withFstat = (patch: (s: ReturnType<DurableFsOps['fstatSync']>) => Partial<ReturnType<DurableFsOps['fstatSync']>>): DurableFsOps =>
    ({ ...realFsOps, fstatSync: (fd) => { const s = realFsOps.fstatSync(fd); return (s.mode & constants.S_IFMT) === constants.S_IFREG ? { ...s, ...patch(s) } : s; } });

  it('a descriptor whose file system gives inode 0: the append of an existing ledger lands (no equality claimed, no refusal)', () => {
    const f = join(dir(), 'memory.jsonl');
    appendRecordUnlocked(f, rec('m_a'));
    appendRecordUnlocked(f, rec('m_b'), withFstat(() => ({ ino: 0n })));
    expect(readFileSync(f, 'utf8')).toContain('"m_b"');
  });

  it('inode 0 on a file this call creates: the append lands too', () => {
    const f = join(dir(), 'memory.jsonl');
    appendRecordUnlocked(f, rec('m_a'), withFstat(() => ({ ino: 0n })));
    expect(readFileSync(f, 'utf8')).toContain('"m_a"');
  });

  it('inode 0 skips the identity half only: a path that re-resolves elsewhere is still refused, and nothing is written', () => {
    const base = realpathSync(dir());
    const data = join(base, 'data'); const other = join(base, 'other');
    mkdirSync(data); mkdirSync(other);
    const f = join(data, 'memory.jsonl');
    appendRecordUnlocked(f, rec('m_a'));
    const before = readFileSync(f, 'utf8');
    let swapped = false;
    const ops = withFstat(() => {
      if (!swapped) { swapped = true; renameSync(data, `${data}.moved`); symlinkSync(other, data); }   // after the open, before the check
      return { ino: 0n };
    });
    expect(isLedgerDestinationChangedError(thrownBy(() => appendRecordUnlocked(f, rec('m_b'), ops)))).toBe(true);
    expect(readFileSync(join(`${data}.moved`, 'memory.jsonl'), 'utf8')).toBe(before);
    expect(readdirSync(other)).toEqual([]);
  });

  it('a comparable inode that differs from the judged one is refused, and nothing is written', () => {
    const f = join(dir(), 'memory.jsonl');
    appendRecordUnlocked(f, rec('m_a'));
    const before = readFileSync(f, 'utf8');
    const e = thrownBy(() => appendRecordUnlocked(f, rec('m_b'), withFstat((s) => ({ ino: s.ino + 1n }))));
    expect(isLedgerDestinationChangedError(e)).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe(before);
  });

  const ledgerIn = (): string => join(realpathSync(dir()), 'memory.jsonl');

  /** The stat of the ledger's name answers this inode while `body` runs. The append takes no probe for that read, so this
   *  goes through the module namespace; it keys on the file name, which A6's bound path keeps. */
  const withInodeAtName = <T>(ino: bigint, body: () => T): T => {
    const real = pathIdentityMod.fileIdentityAt;
    const spy = vi.spyOn(pathIdentityMod, 'fileIdentityAt').mockImplementation((p, o) => {
      const s = real(p, o);
      return s !== null && basename(p) === 'memory.jsonl' ? { ...s, ino } : s;
    });
    try { return body(); } finally { spy.mockRestore(); }
  };

  it('a judged inode and a descriptor that differ only above 2^53 are two files: refused, nothing written', () => {
    const f = ledgerIn();
    appendRecordUnlocked(f, rec('m_a'));
    const before = readFileSync(f, 'utf8');
    const judged = { path: f, identity: id(lstatSync(f, { bigint: true }).dev, 2n ** 60n) };
    const e = thrownBy(() => appendRecordUnlocked(f, rec('m_b'), withFstat(() => ({ ino: 2n ** 60n + 1n })), judged));
    expect(isLedgerDestinationChangedError(e)).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe(before);
    withInodeAtName(2n ** 60n, () => appendRecordUnlocked(f, rec('m_c'), withFstat(() => ({ ino: 2n ** 60n })), judged));   // control: the same inode on both sides lands (the name answers it too: since 14 item 22 a present file is compared with the file at the name)
    expect(readFileSync(f, 'utf8')).toContain('"m_c"');
  });

  it('a file this call created, whose name and descriptor differ only above 2^53: refused, nothing written', () => {
    const f = ledgerIn();
    const e = withInodeAtName(2n ** 60n, () => thrownBy(() => appendRecordUnlocked(f, rec('m_a'), withFstat(() => ({ ino: 2n ** 60n + 1n })), { path: f, identity: null })));
    expect(isLedgerDestinationChangedError(e)).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('');
    const g = ledgerIn();
    withInodeAtName(2n ** 60n, () => appendRecordUnlocked(g, rec('m_a'), withFstat(() => ({ ino: 2n ** 60n })), { path: g, identity: null }));   // control: the same inode on both sides lands
    expect(readFileSync(g, 'utf8')).toContain('"m_a"');
  });

  it('a judged inode of 0 against a comparable descriptor: the append lands (no equality claimed, no refusal)', () => {
    const f = ledgerIn();
    appendRecordUnlocked(f, rec('m_a'));
    appendRecordUnlocked(f, rec('m_b'), realFsOps, { path: f, identity: id(lstatSync(f, { bigint: true }).dev, 0n) });
    expect(readFileSync(f, 'utf8')).toContain('"m_b"');
  });

  it('inode 0 at the name of a file this call created, against a comparable descriptor: the append lands', () => {
    const f = ledgerIn();
    withInodeAtName(0n, () => appendRecordUnlocked(f, rec('m_a'), realFsOps, { path: f, identity: null }));
    expect(readFileSync(f, 'utf8')).toContain('"m_a"');
  });

  /** An absent ledger reached through a link. The link is repointed after the open, so the re-resolution refuses while
   *  the file this call created still stands at the resolved path. */
  const refusedCreate = (patch: () => Partial<ReturnType<DurableFsOps['fstatSync']>>): { refusal: unknown; target: string } => {
    const base = realpathSync(dir());
    const target = join(base, 'memory.jsonl'); const link = join(base, 'link');
    symlinkSync(target, link);
    let repointed = false;
    const ops = withFstat(() => {
      if (!repointed) { repointed = true; rmSync(link); symlinkSync(join(base, 'elsewhere'), link); }
      return patch();
    });
    return { refusal: thrownBy(() => appendRecordUnlocked(link, rec('m_a'), ops)), target };
  };

  it('control: a create refused at a comparable inode removes the file it made', () => {
    const { refusal, target } = refusedCreate(() => ({}));
    expect(isLedgerDestinationChangedError(refusal)).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it('a create refused with inode 0 on the descriptor leaves the empty file in place: it cannot be shown to be this call\'s', () => {
    const { refusal, target } = refusedCreate(() => ({ ino: 0n }));
    expect(isLedgerDestinationChangedError(refusal)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('');
  });

  it('the same with inode 0 at the name too, as such a file system answers: two zeros are no equality, the empty file stays', () => {
    const { refusal, target } = withInodeAtName(0n, () => refusedCreate(() => ({ ino: 0n })));
    expect(isLedgerDestinationChangedError(refusal)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('');
  });
});
