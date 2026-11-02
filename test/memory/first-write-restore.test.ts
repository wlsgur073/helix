// Third fix batch B1, task B2 (design 4.3 step 5, 13.3 decision 4, 14 decisions 4, 5 and 10): a first write that stores
// no row puts the ownership records back, `.owner` first and the registry entry second; a write that stored its row
// keeps them. Faults are planted through DurableFsOps (the append) and through the fs-ops module (the ownership writes).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, symlinkSync, renameSync, unlinkSync, rmdirSync, chmodSync, lstatSync, statSync, constants } from 'node:fs';
import { basename, join } from 'node:path';
import * as fsOpsMod from '../../src/memory/fs-ops.js';
import { realFsOps, realProcFdSyscalls, type ProcFdSyscalls } from '../../src/memory/fs-ops.js';
import * as witnessStoreMod from '../../src/memory/witness-store.js';
import { isRecordStoredError } from '../../src/memory/witness-store.js';
import * as ledgerMod from '../../src/memory/ledger.js';
import { isLedgerProcLostError } from '../../src/memory/ledger.js';
import { LockForeignObjectError } from '../../src/memory/lock.js';
import { UnresolvablePathError } from '../../src/memory/path-identity.js';
import * as ownershipMod from '../../src/memory/ownership.js';
import { isOwned, trustStateOf, projectLedgerPath, canonicalRoot } from '../../src/memory/ownership.js';
import { procFdAvailable, openJudgedDir, closeHeldDir, sampleDirIdentity, type JudgedDirOutcome } from '../../src/memory/dir-bound.js';
import { MemoryStore } from '../../src/memory/store.js';
import { fixture, cleanupFixtures, rowsIn, registryKeys, keepWritable, NOW, type FirstWriteFixture } from '../helpers/first-write-fixture.js';

afterEach(() => { vi.restoreAllMocks(); cleanupFixtures(); });

const AS_ROOT = process.getuid?.() === 0;
const PROC = procFdAvailable(realFsOps);
const FOREIGN = '{"foreign":"not written by Helix"}\n';
const errno = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code });

const TEXT = {
  foreign: /a project memory file exists here that Helix did not create/,
  changed: /this project's memory file changed while the write was in progress — nothing was written/,
  undone: /the first write to this project's memory file failed, so the project was not adopted and nothing was written/,
  notUndone: /the first write to this project's memory file failed and the adoption recorded for it could not be undone, so the project may stay adopted, and a file at its memory path would then be read as its memory/,
} as const;

type Path = 'new' | 'recovery' | 'recovery-mismatch';
const PATHS: Path[] = ['new', 'recovery', 'recovery-mismatch'];

/** new: nobody adopted. recovery: adopted once, then `.owner` removed. recovery-mismatch: adopted once, then `.owner`
 *  overwritten with another stamp (a readable regular file whose bytes and mode the restore puts back). */
function prepare(fx: FirstWriteFixture, path: Path): void {
  if (path === 'new') return;
  fx.store('pre').adopt(fx.root);
  if (path === 'recovery') unlinkSync(join(fx.helix, '.owner'));
  else writeFileSync(join(fx.helix, '.owner'), 'OLDSTAMP-not-the-registry-stamp', { mode: 0o600 });
}

interface Snap { registry: string | null; owner: string | null; ownerMode: number | null; owned: boolean | null; trust: string | null }
/** The ownership records as bytes. `ownerDir` is where to look for `.owner` when the folder was replaced. */
function snap(fx: FirstWriteFixture, ownerDir?: string): Snap {
  const reg = join(fx.home, 'projects.json');
  const own = join(ownerDir ?? fx.helix, '.owner');
  return {
    registry: existsSync(reg) ? readFileSync(reg, 'utf8') : null,
    owner: existsSync(own) ? readFileSync(own, 'utf8') : null,
    ownerMode: existsSync(own) ? statSync(own).mode & 0o777 : null,
    owned: ownerDir === undefined ? isOwned(fx.root, fx.home) : null,
    trust: ownerDir === undefined ? trustStateOf(fx.root, fx.home) : null,
  };
}

/** What a cell shares while its faults fire. */
interface State { ledgerOpened: boolean; failed: boolean; rowSynced: boolean; closesAfterRow: number }

function spyOpen(hook: (path: string, flags: string | number) => void): void {
  const real = realFsOps.openSync;
  vi.spyOn(realFsOps, 'openSync').mockImplementation((p, flags, mode) => { hook(p, flags); return real(p, flags, mode); });
}
const isCreateOpen = (p: string, flags: string | number): boolean =>
  basename(p) === 'memory.jsonl' && typeof flags === 'number' && (flags & constants.O_CREAT) !== 0;
const isDirOpen = (flags: string | number): boolean => typeof flags === 'number' && (flags & constants.O_DIRECTORY) !== 0;

/** The write of the row fails with `code`; `then` runs just before the throw. */
function failRowWrite(st: State, code: string, then: () => void = () => undefined): void {
  spyOpen((p, f) => { if (isCreateOpen(p, f)) st.ledgerOpened = true; });
  const real = realFsOps.writeSync;
  vi.spyOn(realFsOps, 'writeSync').mockImplementation((fd, buf, off, len) => {
    if (st.ledgerOpened && !st.failed) { st.failed = true; then(); throw errno(code); }
    return real(fd, buf, off, len);
  });
}
/** Marks the instant the row's fsync returned: everything after it is "after the row is durable". */
function markRowSynced(st: State): void {
  const real = realFsOps.fsyncSync;
  vi.spyOn(realFsOps, 'fsyncSync').mockImplementation((fd) => { real(fd); st.rowSynced = true; });
}
type FsyncDir = typeof fsOpsMod.fsyncDir;
function failModuleFsyncDir(when: (dir: string) => boolean): void {
  const real: FsyncDir = fsOpsMod.fsyncDir;
  vi.spyOn(fsOpsMod, 'fsyncDir').mockImplementation(((dir: string, ...rest: unknown[]) => {
    if (when(dir)) throw errno('EIO');
    return (real as (...a: unknown[]) => void)(dir, ...rest);
  }) as unknown as FsyncDir);
}

/** A /proc seam that can be lost: installed on realFsOps by the caller, removed in its `finally`. */
function losableProc(): { procFd: ProcFdSyscalls; lose(): void } {
  let lost = false;
  return {
    procFd: {
      statSync: (p) => { if (lost) throw errno('ENOENT'); return realProcFdSyscalls.statSync(p); },
      readlinkSync: (p) => realProcFdSyscalls.readlinkSync(p),
    },
    lose: () => { lost = true; },
  };
}

/** A host with no /proc at all (Review Focus 2), at the seam the store and the append share: a fresh stub has no memory, so
 *  its first verification fails and every bind goes by path. Whatever runs in `body` must reach `opened.kind === 'unbound'`
 *  in firstProjectWrite, or the cell says nothing about such a host, so the fixture asserts it. */
function onHostWithoutProc(body: () => void): void {
  const enoent = (): never => { throw errno('ENOENT'); };
  realFsOps.procFd = { statSync: enoent, readlinkSync: enoent };
  const owner = vi.spyOn(ownershipMod, 'openOwnerDir');
  try {
    body();
    expect(owner.mock.results.map((r) => (r.value as JudgedDirOutcome).kind)).toEqual(['unbound']);
    expect(procFdAvailable(realFsOps)).toBe(false);
  } finally { delete realFsOps.procFd; vi.restoreAllMocks(); }
}

interface Cell {
  id: string;
  expect: 'foreign' | 'changed' | 'undone' | 'notUndone' | 'stored';
  file: 'absent' | 'foreign' | 'link' | 'row';
  needsProc?: boolean;
  later?: boolean;                 // the same process can commit again afterwards and the row is stored
  laterForeign?: boolean;          // the file that caused the EEXIST stays, so the next commit gets the foreign-file text
  registryStays?: boolean;         // the restore stopped before its registry step
  ownerDirAfter?: (fx: FirstWriteFixture) => string;
  arm(fx: FirstWriteFixture, st: State): void;
}

const CELLS: Cell[] = [
  { id: 'owner-write-fails (the directory fsync after the .owner rename fails)', expect: 'undone', file: 'absent', later: true,
    arm: (fx, st) => failModuleFsyncDir((dir) => { if (dir !== fx.home && !st.failed) { st.failed = true; return true; } return false; }) },
  { id: 'create-EEXIST-file (a foreign file appears before the exclusive creation)', expect: 'foreign', file: 'foreign', laterForeign: true,
    arm: (fx, st) => spyOpen((p, f) => { if (!st.ledgerOpened && isCreateOpen(p, f)) { st.ledgerOpened = true; writeFileSync(fx.ledger, FOREIGN); } }) },
  { id: 'create-EEXIST-link (a link appears: EEXIST for the exclusive open)', expect: 'foreign', file: 'link',
    arm: (fx, st) => spyOpen((p, f) => {
      if (!st.ledgerOpened && isCreateOpen(p, f)) {
        st.ledgerOpened = true;
        writeFileSync(join(fx.outside, 'target'), FOREIGN);
        symlinkSync(join(fx.outside, 'target'), fx.ledger);
      }
    }) },
  { id: 'create-ELOOP-injected', expect: 'foreign', file: 'absent', later: true,
    arm: (_fx, st) => spyOpen((p, f) => { if (!st.ledgerOpened && isCreateOpen(p, f)) { st.ledgerOpened = true; throw errno('ELOOP'); } }) },
  { id: 'folder-replaced (.helix becomes a link right before the append opens its directory)', expect: 'changed', file: 'absent', needsProc: true,
    ownerDirAfter: (fx) => join(fx.root, 'helix-real'),
    arm: (fx, st) => {
      let dirOpens = 0;
      spyOpen((_p, f) => {
        if (isDirOpen(f) && ++dirOpens === 2) {      // the first held directory is the .owner's, the second the append's
          st.failed = true;
          renameSync(fx.helix, join(fx.root, 'helix-real'));
          symlinkSync(fx.outside, fx.helix);
        }
      });
    } },
  { id: 'check-after-the-open-refuses (.helix becomes a link right after the exclusive creation: the created file goes through the held directory)', expect: 'changed', file: 'absent', needsProc: true,
    ownerDirAfter: (fx) => join(fx.root, 'helix-real'),
    arm: (fx, st) => {
      spyOpen((p, f) => { if (isCreateOpen(p, f)) st.ledgerOpened = true; });
      const real = realFsOps.fstatSync;
      vi.spyOn(realFsOps, 'fstatSync').mockImplementation((fd) => {
        const stat = real(fd);
        if (st.ledgerOpened && !st.failed) {      // the first fstat after the creation is the check's
          st.failed = true;
          renameSync(fx.helix, join(fx.root, 'helix-real'));
          symlinkSync(fx.outside, fx.helix);
        }
        return stat;
      });
    } },
  { id: 'write-ENOSPC', expect: 'undone', file: 'absent', later: true, arm: (_fx, st) => failRowWrite(st, 'ENOSPC') },
  { id: 'write-EIO', expect: 'undone', file: 'absent', later: true, arm: (_fx, st) => failRowWrite(st, 'EIO') },
  { id: 'created-file-replaced (another party replaced the created file before the write failed)', expect: 'undone', file: 'foreign',
    arm: (fx, st) => failRowWrite(st, 'ENOSPC', () => { unlinkSync(fx.ledger); writeFileSync(fx.ledger, FOREIGN); }) },
  { id: 'witness-advance-fails (after the row: stored)', expect: 'stored', file: 'row',
    arm: () => { vi.spyOn(witnessStoreMod, 'advanceWitness').mockImplementationOnce(() => { throw errno('EIO'); }); } },
  { id: 'directory-fsync-fails-after-the-row (14 decision 10: stored)', expect: 'stored', file: 'row',
    arm: (_fx, st) => {
      markRowSynced(st);
      const real = realFsOps.fsyncDir;
      vi.spyOn(realFsOps, 'fsyncDir').mockImplementation((dir) => { if (st.rowSynced && !st.failed) { st.failed = true; throw errno('EIO'); } real(dir); });
    } },
  { id: 'file-close-fails-after-the-row (stored)', expect: 'stored', file: 'row',
    arm: (_fx, st) => {
      markRowSynced(st);
      const real = realFsOps.closeSync;
      vi.spyOn(realFsOps, 'closeSync').mockImplementation((fd) => { real(fd); if (st.rowSynced && !st.failed) { st.failed = true; throw errno('EIO'); } });
    } },
  { id: 'held-directory-close-fails-after-the-row (stored)', expect: 'stored', file: 'row', needsProc: true,
    arm: (_fx, st) => {
      markRowSynced(st);
      const real = realFsOps.closeSync;
      vi.spyOn(realFsOps, 'closeSync').mockImplementation((fd) => {
        real(fd);
        if (st.rowSynced && !st.failed && ++st.closesAfterRow === 2) { st.failed = true; throw errno('EIO'); }   // the first close after the row is the file's
      });
    } },
  { id: 'restore-fails-at-registry', expect: 'notUndone', file: 'absent',
    arm: (fx, st) => { failRowWrite(st, 'ENOSPC'); failModuleFsyncDir((dir) => st.failed && dir === fx.home); } },
  { id: 'restore-fails-at-owner (the first step: nothing after it runs)', expect: 'notUndone', file: 'absent', registryStays: true,
    arm: (fx, st) => { failRowWrite(st, 'ENOSPC'); failModuleFsyncDir((dir) => st.failed && dir !== fx.home); } },
];

function expectFile(fx: FirstWriteFixture, cell: Cell): void {
  if (cell.file === 'absent') expect(existsSync(fx.ledger)).toBe(false);
  else if (cell.file === 'foreign') expect(readFileSync(fx.ledger, 'utf8')).toBe(FOREIGN);
  else if (cell.file === 'link') {
    expect(lstatSync(fx.ledger).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(fx.outside, 'target'), 'utf8')).toBe(FOREIGN);
  } else expect(rowsIn(fx.ledger)).toEqual(['a fact']);
}

describe.each(PATHS)('the restore matrix, path: %s', (path) => {
  for (const cell of CELLS) {
    const run = cell.needsProc === true && !PROC ? it.skip : it;
    run(cell.id, () => {
      const fx = fixture();
      prepare(fx, path);
      const ownerDir = cell.ownerDirAfter?.(fx);
      const before = snap(fx);
      const st: State = { ledgerOpened: false, failed: false, rowSynced: false, closesAfterRow: 0 };
      cell.arm(fx, st);
      let error: unknown;
      try { fx.store().commit({ content: 'a fact', source: 'user' }); } catch (e) { error = e; }
      vi.restoreAllMocks();

      expect(error, 'the commit must fail').toBeInstanceOf(Error);
      if (cell.expect === 'stored') {
        expect(isRecordStoredError(error)).toBe(true);
        expectFile(fx, cell);
        expect(isOwned(fx.root, fx.home)).toBe(true);        // the ownership stays: the row is in the ledger
        return;
      }
      expect((error as Error).message).toMatch(TEXT[cell.expect]);
      expect(isRecordStoredError(error)).toBe(false);
      expectFile(fx, cell);
      const after = snap(fx, ownerDir);
      if (cell.expect !== 'notUndone') {
        // Byte for byte as before the call: both records, and what a reader concludes from them.
        expect(after.registry).toBe(before.registry);
        expect(after.owner).toBe(before.owner);
        expect(after.ownerMode).toBe(before.ownerMode);
        if (ownerDir === undefined) { expect(after.owned).toBe(before.owned); expect(after.trust).toBe(before.trust); }
      } else if (cell.registryStays === true) {
        expect(registryKeys(fx.home)).toHaveLength(1);       // the restore stopped at `.owner`; the registry step did not run
      }
      if (ownerDir !== undefined) {
        expect(readdirSync(fx.outside)).toEqual([]);                  // nothing lands where the link leads
        expect(existsSync(join(ownerDir, 'memory.jsonl'))).toBe(false);
      }
      if (cell.laterForeign === true) expect(() => fx.store('b').commit({ content: 'later fact', source: 'user' })).toThrow(TEXT.foreign);
      if (cell.later === true) {
        // The restore left a project that can be written: the same process commits again and the row is stored. The mismatch
        // the restore kept makes a later adoption on the recovery path trust-pending again (design 4.3 step 5).
        fx.store('b').commit({ content: 'later fact', source: 'user' });
        expect(rowsIn(fx.ledger)).toEqual(['later fact']);
        expect(isOwned(fx.root, fx.home)).toBe(true);
        expect(trustStateOf(fx.root, fx.home)).toBe(path === 'new' ? 'active' : 'pending');
      }
    });
  }
});

describe('single cells', () => {
  it('an .owner that is a directory: the first commit is refused, the registry is as before, and the commit works once the directory is gone', () => {
    const fx = fixture();
    mkdirSync(join(fx.helix, '.owner'));
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(TEXT.undone);
    expect(registryKeys(fx.home)).toEqual([]);
    expect(existsSync(join(fx.home, 'projects.json'))).toBe(false);
    expect(lstatSync(join(fx.helix, '.owner')).isDirectory()).toBe(true);
    expect(existsSync(fx.ledger)).toBe(false);
    rmdirSync(join(fx.helix, '.owner'));
    fx.store('b').commit({ content: 'later fact', source: 'user' });
    expect(rowsIn(fx.ledger)).toEqual(['later fact']);
    expect(isOwned(fx.root, fx.home)).toBe(true);
    expect(trustStateOf(fx.root, fx.home)).toBe('active');
  });

  it.skipIf(AS_ROOT)('a read-only home on a used home: the raw EACCES of the registry lock, nothing recorded, never the project-folder text', () => {
    const fx = fixture();
    fx.store('g').commitScoped({ content: 'global fact', source: 'user', scope: 'global' });   // mints the key and the witness file
    keepWritable(fx.home);
    chmodSync(fx.home, 0o500);
    let message = '';
    try { fx.store().commit({ content: 'a fact', source: 'user' }); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/EACCES/);
    expect(message).not.toMatch(/memory folder cannot be written/);
    chmodSync(fx.home, 0o700);
    expect(registryKeys(fx.home)).toEqual([]);
    expect(existsSync(join(fx.helix, '.owner'))).toBe(false);
    expect(existsSync(fx.ledger)).toBe(false);
  });

  it('a foreign object at the witness lock: the row is stored, the error carries the stored mark, and the ownership is kept (W-R4)', () => {
    const fx = fixture();
    symlinkSync(join(fx.base, 'nowhere'), join(fx.home, 'witness.json.lock'));
    let error: unknown;
    try { fx.store().commit({ content: 'a fact', source: 'user' }); } catch (e) { error = e; }
    expect(isRecordStoredError(error)).toBe(true);
    expect(rowsIn(fx.ledger)).toEqual(['a fact']);
    expect(isOwned(fx.root, fx.home)).toBe(true);
  });

  it('a .helix folder this call created is removed when the call is refused (FW-R6)', () => {
    const fx = fixture({ helix: false });
    spyOpen((p, f) => { if (isCreateOpen(p, f)) throw errno('ELOOP'); });
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(TEXT.foreign);
    expect(existsSync(fx.helix)).toBe(false);
    expect(existsSync(join(fx.home, 'projects.json'))).toBe(false);
  });

  it('a .helix folder that was already there is kept when the call is refused', () => {
    const fx = fixture();
    spyOpen((p, f) => { if (isCreateOpen(p, f)) throw errno('ELOOP'); });
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(TEXT.foreign);
    expect(existsSync(fx.helix)).toBe(true);
    expect(existsSync(join(fx.helix, '.owner'))).toBe(false);
  });

  it.skipIf(!PROC)('v2-firstwrite-01, before the stamp: a .helix replaced by a link to ANOTHER adopted project\'s folder before the first held directory is opened leaves that project\'s .owner untouched', () => {
    const fx = fixture();
    const root2 = join(fx.base, 'proj2');
    mkdirSync(join(root2, '.helix'), { recursive: true });
    new MemoryStore(fx.globalLedger, { home: fx.home, sessionId: 's2', project: { root: root2, ledger: projectLedgerPath(root2) } }).adopt(root2);
    const owner2 = readFileSync(join(root2, '.helix', '.owner'), 'utf8');
    const listing2 = readdirSync(join(root2, '.helix')).sort();
    const registryBefore = registryKeys(fx.home);
    let swapped = false;
    spyOpen((_p, f) => {
      if (!swapped && isDirOpen(f)) {
        swapped = true;
        renameSync(fx.helix, join(fx.root, 'helix-real'));
        symlinkSync(join(root2, '.helix'), fx.helix);
      }
    });
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(TEXT.changed);
    vi.restoreAllMocks();
    expect(readFileSync(join(root2, '.helix', '.owner'), 'utf8')).toBe(owner2);
    expect(readdirSync(join(root2, '.helix')).sort()).toEqual(listing2);
    expect(registryKeys(fx.home)).toEqual(registryBefore);
    expect(registryKeys(fx.home)).toEqual([canonicalRoot(root2)]);
  });

  it.skipIf(!PROC)('v2-firstwrite-01, the measured window: a .helix replaced by a link to ANOTHER adopted project\'s folder between the stamp\'s look at the folder and its .owner write leaves that project\'s .owner untouched, and the records go back through the held directory', () => {
    const fx = fixture();
    const root2 = join(fx.base, 'proj2');
    mkdirSync(join(root2, '.helix'), { recursive: true });
    new MemoryStore(fx.globalLedger, { home: fx.home, sessionId: 's2', project: { root: root2, ledger: projectLedgerPath(root2) } }).adopt(root2);
    const owner2 = readFileSync(join(root2, '.helix', '.owner'), 'utf8');
    const listing2 = readdirSync(join(root2, '.helix')).sort();
    const registry = join(fx.home, 'projects.json');
    const key = JSON.stringify(canonicalRoot(fx.root));
    const real: FsyncDir = fsOpsMod.fsyncDir;
    let swapped = false;
    vi.spyOn(fsOpsMod, 'fsyncDir').mockImplementation(((dir: string, ...rest: unknown[]) => {
      // The registry write of this commit has just landed; the .owner write is the next step.
      if (!swapped && dir === fx.home && readFileSync(registry, 'utf8').includes(key)) {
        swapped = true;
        renameSync(fx.helix, join(fx.root, 'helix-real'));
        symlinkSync(join(root2, '.helix'), fx.helix);
      }
      return (real as (...a: unknown[]) => void)(dir, ...rest);
    }) as unknown as FsyncDir);
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(TEXT.changed);
    vi.restoreAllMocks();
    expect(swapped).toBe(true);
    expect(readFileSync(join(root2, '.helix', '.owner'), 'utf8')).toBe(owner2);
    expect(readdirSync(join(root2, '.helix')).sort()).toEqual(listing2);
    expect(existsSync(join(fx.root, 'helix-real', '.owner'))).toBe(false);
    expect(registryKeys(fx.home)).toEqual([canonicalRoot(root2)]);
  });

  it.skipIf(!PROC)('the close of the held .owner directory fails after the row is stored: the commit stands (a read-only descriptor loses nothing, and an unmarked error would make a retry store the row again)', () => {
    const fx = fixture();
    const realOpen = realFsOps.openSync;
    let ownerFd = -1;
    vi.spyOn(realFsOps, 'openSync').mockImplementation((p, flags, mode) => {
      const fd = realOpen(p, flags, mode);
      if (ownerFd === -1 && isDirOpen(flags)) ownerFd = fd;     // the first held directory is the .owner's
      return fd;
    });
    const realClose = realFsOps.closeSync;
    vi.spyOn(realFsOps, 'closeSync').mockImplementation((fd) => { realClose(fd); if (fd === ownerFd) throw errno('EIO'); });
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).not.toThrow();
    vi.restoreAllMocks();
    expect(rowsIn(fx.ledger)).toEqual(['a fact']);
    expect(isOwned(fx.root, fx.home)).toBe(true);
  });

  it('FW-R3: a heal that fails before the row (a WitnessAdvanceError) is thrown as it is, after the records went back', () => {
    const fx = fixture();
    const before = snap(fx);
    vi.spyOn(witnessStoreMod, 'classifyState').mockReturnValueOnce({ kind: 'transition-heal', journal: { tx: NOW } } as never);
    vi.spyOn(witnessStoreMod, 'completeTransition').mockImplementationOnce(() => { throw new witnessStoreMod.WitnessAdvanceError('raced'); });
    let error: unknown;
    try { fx.store().commit({ content: 'a fact', source: 'user' }); } catch (e) { error = e; }
    vi.restoreAllMocks();
    expect(witnessStoreMod.isWitnessAdvanceError(error)).toBe(true);
    expect(isRecordStoredError(error)).toBe(false);
    expect(snap(fx)).toEqual(before);
    expect(existsSync(fx.ledger)).toBe(false);
  });

  it('FW-R3: an interrupted transition (a WitnessBlockedError) is thrown as it is, after the records went back', () => {
    const fx = fixture();
    const before = snap(fx);
    vi.spyOn(witnessStoreMod, 'classifyState').mockReturnValueOnce({ kind: 'transition-interrupted' } as never);
    let error: unknown;
    try { fx.store().commit({ content: 'a fact', source: 'user' }); } catch (e) { error = e; }
    vi.restoreAllMocks();
    expect(witnessStoreMod.isWitnessBlockedError(error)).toBe(true);
    expect(snap(fx)).toEqual(before);
    expect(existsSync(fx.ledger)).toBe(false);
  });

  it.each([
    ['a lock object (a LockForeignObjectError)', (): Error => new LockForeignObjectError()],
    ['a path that cannot be resolved (an UnresolvablePathError)', (): Error => new UnresolvablePathError('too-many-links')],
    ['a witness file that cannot be used (a WitnessUnusableError)', (): Error => new witnessStoreMod.WitnessUnusableError('commit', 'unparseable')],
  ] as const)('FW-R3: %s raised behind the ownership record is thrown as it is, after the records went back', (_label, make) => {
    const fx = fixture();
    const before = snap(fx);
    const refusal = make();
    vi.spyOn(ledgerMod, 'appendRecordUnlocked').mockImplementationOnce(() => { throw refusal; });
    let error: unknown;
    try { fx.store().commit({ content: 'a fact', source: 'user' }); } catch (e) { error = e; }
    vi.restoreAllMocks();
    expect(error).toBe(refusal);                             // that exact error: never the first-write-failed text
    expect(isRecordStoredError(error)).toBe(false);
    expect(snap(fx)).toEqual(before);
    expect(existsSync(fx.ledger)).toBe(false);
  });

  it.skipIf(!PROC)('a /proc lost between the two held directories: the dedicated refusal, after the records went back', () => {
    const fx = fixture();
    const before = snap(fx);
    const proc = losableProc();
    realFsOps.procFd = proc.procFd;
    let error: unknown;
    try {
      let dirOpens = 0;
      spyOpen((_p, f) => { if (isDirOpen(f) && ++dirOpens === 2) proc.lose(); });
      try { fx.store().commit({ content: 'a fact', source: 'user' }); } catch (e) { error = e; }
    } finally { delete realFsOps.procFd; vi.restoreAllMocks(); }
    expect(isLedgerProcLostError(error)).toBe(true);
    expect(snap(fx)).toEqual(before);
    expect(existsSync(fx.ledger)).toBe(false);
  });

  it.skipIf(!PROC)('a /proc lost before the .owner directory is opened: the dedicated refusal, and nothing was recorded', () => {
    const fx = fixture();
    const proc = losableProc();
    realFsOps.procFd = proc.procFd;
    const synced: string[] = [];
    failModuleFsyncDir((dir) => { synced.push(dir); return false; });   // a record made and put back again leaves only this trace
    let error: unknown;
    try {
      const seen = openJudgedDir(fx.outside, sampleDirIdentity(fx.outside), realFsOps);    // this process has seen /proc through this object
      if (seen.kind !== 'bound') throw new Error('premise: /proc is usable here');
      closeHeldDir(seen.dir, realFsOps);
      proc.lose();
      try { fx.store().commit({ content: 'a fact', source: 'user' }); } catch (e) { error = e; }
    } finally { delete realFsOps.procFd; }
    expect(isLedgerProcLostError(error)).toBe(true);
    expect(synced).not.toContain(fx.helix);                  // no .owner was written, not even one the restore took away
    expect(registryKeys(fx.home)).toEqual([]);
    expect(existsSync(join(fx.helix, '.owner'))).toBe(false);
    expect(existsSync(fx.ledger)).toBe(false);
  });
});

describe('a first commit on a host without /proc (Review Focus 2: every write works, nothing is refused because /proc is missing)', () => {
  /** `.helix` becomes a link right before the exclusive creation. By path the file lands where the link leads, the check
   *  after the open refuses it and the removal by path finds it there; `.owner` stays in the real folder, out of reach. */
  const replaceFolderAtCreation = (fx: FirstWriteFixture): void => {
    let swapped = false;
    spyOpen((p, f) => {
      if (!swapped && isCreateOpen(p, f)) {
        swapped = true;
        renameSync(fx.helix, join(fx.root, 'helix-real'));
        symlinkSync(fx.outside, fx.helix);
      }
    });
  };

  it('the first commit stores its row and adopts the project', () => {
    const fx = fixture();
    onHostWithoutProc(() => { fx.store().commit({ content: 'a fact', source: 'user' }); });
    expect(rowsIn(fx.ledger)).toEqual(['a fact']);
    expect(isOwned(fx.root, fx.home)).toBe(true);
    expect(trustStateOf(fx.root, fx.home)).toBe('active');
  });

  it('a failed row write answers the undone text, with both records gone and no file', () => {
    const fx = fixture();
    const st: State = { ledgerOpened: false, failed: false, rowSynced: false, closesAfterRow: 0 };
    onHostWithoutProc(() => {
      failRowWrite(st, 'ENOSPC');
      expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(TEXT.undone);
    });
    expect(st.failed).toBe(true);
    expect(existsSync(join(fx.home, 'projects.json'))).toBe(false);
    expect(existsSync(join(fx.helix, '.owner'))).toBe(false);
    expect(existsSync(fx.ledger)).toBe(false);
  });

  it('the folder replaced on a new adoption answers the changed-destination text: the entry is removed, the stamp\'s .owner stays in the real folder (FW-R15)', () => {
    const fx = fixture();
    onHostWithoutProc(() => {
      replaceFolderAtCreation(fx);
      expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(TEXT.changed);
    });
    expect(registryKeys(fx.home)).toEqual([]);
    expect(existsSync(join(fx.root, 'helix-real', '.owner'))).toBe(true);
    expect(readdirSync(fx.outside)).toEqual([]);             // nothing lands where the link leads
  });

  it('the folder replaced on the recovery path answers the cancel-failed text: the entry stays, and the returned folder is not owned-and-active (14 decision 11)', () => {
    const fx = fixture();
    prepare(fx, 'recovery');
    onHostWithoutProc(() => {
      replaceFolderAtCreation(fx);
      expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(TEXT.notUndone);
    });
    expect(registryKeys(fx.home)).toHaveLength(1);
    expect(existsSync(join(fx.root, 'helix-real', '.owner'))).toBe(true);
    expect(readdirSync(fx.outside)).toEqual([]);             // nothing lands where the link leads
    unlinkSync(fx.helix);
    renameSync(join(fx.root, 'helix-real'), fx.helix);
    expect(trustStateOf(fx.root, fx.home)).toBe('pending');
  });
});
