// Third fix batch B1, task B9c (design section 14 item 22, 4.1 item 3): a memory folder replaced after the append has
// held it and before it opens the file. The descriptor is then the judged file in the renamed folder and the path
// resolves again to the same string, so the check after the open must also look at the file now at that path: for a
// file present when it was judged, as for a created one, it must be the descriptor's file. The swap is planted through
// the DurableFsOps seam at the open of the held folder's bound name; verdicts come from the bytes on disk.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdirSync, renameSync, copyFileSync, constants } from 'node:fs';
import { basename, join } from 'node:path';
import { realFsOps } from '../../src/memory/fs-ops.js';
import * as pathIdentityMod from '../../src/memory/path-identity.js';
import * as dirBoundMod from '../../src/memory/dir-bound.js';
import type { JudgedDirOutcome } from '../../src/memory/dir-bound.js';
import { isLedgerDestinationChangedError } from '../../src/memory/ledger.js';
import { isRecordStoredError } from '../../src/memory/witness-store.js';
import { isOwned, trustStateOf } from '../../src/memory/ownership.js';
import { PROJECT_WRITE_REFUSAL } from '../../src/memory/store.js';
import { fixture, cleanupFixtures, rowsIn, type FirstWriteFixture } from '../helpers/first-write-fixture.js';

afterEach(() => { vi.restoreAllMocks(); cleanupFixtures(); });

const HAS_PROC = process.platform === 'linux' && existsSync('/proc/self/fd');
/** The open of the memory file through the held folder (design 14 decision 2). */
const BOUND_LEDGER = /^\/proc\/self\/fd\/\d+\/memory\.jsonl$/;
/** fileIdentityAt as it is before any spy is installed. */
const realFileIdentityAt = pathIdentityMod.fileIdentityAt;

/** An owned project with one stored row. */
function ownedWithOneRow(): FirstWriteFixture {
  const fx = fixture();
  fx.store('a').commit({ content: 'first fact', source: 'user' });
  expect(rowsIn(fx.ledger)).toEqual(['first fact']);
  expect(trustStateOf(fx.root, fx.home)).toBe('active');
  return fx;
}

/** Runs `swap` once, right before the first open of the held folder's bound name of memory.jsonl, then delegates. */
function swapAtBoundOpen(swap: () => void): { fired: () => boolean } {
  let fired = false;
  const real = realFsOps.openSync;
  vi.spyOn(realFsOps, 'openSync').mockImplementation((p, flags, mode) => {
    if (!fired && BOUND_LEDGER.test(p)) { fired = true; swap(); }
    return real(p, flags, mode);
  });
  return { fired: () => fired };
}

const thrown = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return null; };
const witnessBytes = (fx: FirstWriteFixture): string => readFileSync(join(fx.home, 'witness.json'), 'utf8');

describe.skipIf(!HAS_PROC)('a commit whose memory folder is replaced after it was held (14 item 22)', () => {
  it('(a) .helix renamed away and a new empty folder made at the name: refused as a changed destination, nothing written anywhere, the witness unchanged', () => {
    const fx = ownedWithOneRow();
    const moved = join(fx.root, '.helix-moved');
    const before = readFileSync(fx.ledger);
    const witness = witnessBytes(fx);
    const seam = swapAtBoundOpen(() => { renameSync(fx.helix, moved); mkdirSync(fx.helix); });
    const err = thrown(() => fx.store('b').commit({ content: 'second fact', source: 'user' }));
    vi.restoreAllMocks();
    expect(seam.fired()).toBe(true);
    expect(isLedgerDestinationChangedError(err)).toBe(true);
    expect(isRecordStoredError(err)).toBe(false);
    expect((err as Error).message).toBe(PROJECT_WRITE_REFUSAL.commit.changed);
    expect(readFileSync(join(moved, 'memory.jsonl')).equals(before)).toBe(true);
    expect(existsSync(join(fx.helix, 'memory.jsonl'))).toBe(false);
    expect(witnessBytes(fx)).toBe(witness);
  });

  it('(b) the same, with a copy of the memory file (another inode, the same bytes) in the new folder: refused the same way, both files as they were', () => {
    const fx = ownedWithOneRow();
    const moved = join(fx.root, '.helix-moved');
    const before = readFileSync(fx.ledger);
    const witness = witnessBytes(fx);
    const seam = swapAtBoundOpen(() => {
      renameSync(fx.helix, moved);
      mkdirSync(fx.helix);
      copyFileSync(join(moved, 'memory.jsonl'), join(fx.helix, 'memory.jsonl'));
    });
    const err = thrown(() => fx.store('b').commit({ content: 'second fact', source: 'user' }));
    vi.restoreAllMocks();
    expect(seam.fired()).toBe(true);
    expect(isLedgerDestinationChangedError(err)).toBe(true);
    expect(isRecordStoredError(err)).toBe(false);
    expect((err as Error).message).toBe(PROJECT_WRITE_REFUSAL.commit.changed);
    expect(readFileSync(join(moved, 'memory.jsonl')).equals(before)).toBe(true);
    expect(readFileSync(join(fx.helix, 'memory.jsonl')).equals(before)).toBe(true);
    expect(witnessBytes(fx)).toBe(witness);
  });

  it('(c) control: .helix renamed away and back (the same folder) before the open: the commit stores its row in the original file', () => {
    const fx = ownedWithOneRow();
    const moved = join(fx.root, '.helix-moved');
    const seam = swapAtBoundOpen(() => { renameSync(fx.helix, moved); renameSync(moved, fx.helix); });
    fx.store('b').commit({ content: 'second fact', source: 'user' });
    vi.restoreAllMocks();
    expect(seam.fired()).toBe(true);
    expect(rowsIn(fx.ledger)).toEqual(['first fact', 'second fact']);
    expect(existsSync(moved)).toBe(false);
    expect(isOwned(fx.root, fx.home)).toBe(true);
    expect(trustStateOf(fx.root, fx.home)).toBe('active');
  });
});

describe('the comparison of the file at the path with the descriptor and an inode of 0 (14 decision 9)', () => {
  it('(d) the file at the path, looked at after the open, reports inode 0: the comparison is skipped and a commit without a swap stores its row', () => {
    const fx = ownedWithOneRow();
    let opened = false;
    let zeroed = 0;
    const realOpen = realFsOps.openSync;
    vi.spyOn(realFsOps, 'openSync').mockImplementation((p, flags, mode) => {
      if (basename(p) === 'memory.jsonl') opened = true;
      return realOpen(p, flags, mode);
    });
    vi.spyOn(pathIdentityMod, 'fileIdentityAt').mockImplementation((p, o) => {
      const id = realFileIdentityAt(p, o);
      if (opened && zeroed === 0 && p === fx.ledger && id !== null) { zeroed++; return { dev: id.dev, ino: 0n }; }
      return id;
    });
    fx.store('b').commit({ content: 'second fact', source: 'user' });
    vi.restoreAllMocks();
    expect(zeroed).toBe(1);   // the look at the file after the open was answered with inode 0
    expect(rowsIn(fx.ledger)).toEqual(['first fact', 'second fact']);
  });
});

describe('a host without /proc (Review Focus 2): the append opens the file by its plain path', () => {
  it('(e) the swap of (a) at the plain open is refused as before, and a commit without a swap stores its row; the unbound route was taken', () => {
    const fx = ownedWithOneRow();
    const moved = join(fx.root, '.helix-moved');
    const enoent = (): never => { throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }); };
    realFsOps.procFd = { statSync: enoent, readlinkSync: enoent };
    try {
      const routes = vi.spyOn(dirBoundMod, 'openJudgedDir');
      const before = readFileSync(fx.ledger);
      let fired = false;
      const real = realFsOps.openSync;
      vi.spyOn(realFsOps, 'openSync').mockImplementation((p, flags, mode) => {
        if (!fired && p === fx.ledger && typeof flags === 'number' && (flags & constants.O_APPEND) !== 0) { fired = true; renameSync(fx.helix, moved); mkdirSync(fx.helix); }   // the append's open, by the plain path
        return real(p, flags, mode);
      });
      const err = thrown(() => fx.store('b').commit({ content: 'second fact', source: 'user' }));
      expect(fired).toBe(true);
      expect(isLedgerDestinationChangedError(err)).toBe(true);
      expect((err as Error).message).toBe(PROJECT_WRITE_REFUSAL.commit.changed);
      expect(readFileSync(join(moved, 'memory.jsonl')).equals(before)).toBe(true);
      expect(existsSync(join(fx.helix, 'memory.jsonl'))).toBe(false);
      renameSync(fx.helix, join(fx.root, '.helix-empty'));
      renameSync(moved, fx.helix);
      fx.store('c').commit({ content: 'third fact', source: 'user' });
      expect(rowsIn(fx.ledger)).toEqual(['first fact', 'third fact']);
      expect(routes.mock.results.length).toBeGreaterThan(0);
      expect(routes.mock.results.map((r) => (r.value as JudgedDirOutcome).kind).every((k) => k === 'unbound')).toBe(true);
    } finally { delete realFsOps.procFd; vi.restoreAllMocks(); }
  });
});
