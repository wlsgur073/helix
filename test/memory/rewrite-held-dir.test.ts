// Third fix batch B1, task B3 (14 decision 2, FW-R12): compaction and the permanent erase's rewrite address the judged
// directory through the descriptor A6 holds, like the append. A directory component swapped for a link while the rewrite
// runs changes nothing outside; the orphan sweep belongs to the held directory too. ctx.stillOwned() reads the lock by path, so
// a swap that outlasts either of its two looks answers "lock lost": every swap below ends before the next look.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync, symlinkSync, unlinkSync, rmSync, realpathSync, statSync, lstatSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compactLedger, compactLedgerUnlocked, appendRecordUnlocked, parseLedgerText,
  isLedgerDestinationChangedError, isLedgerProcLostError,
} from '../../src/memory/ledger.js';
import { withFileLock } from '../../src/memory/lock.js';
import { realFsOps, realProcFdSyscalls, type DurableFsOps, type ProcFdSyscalls } from '../../src/memory/fs-ops.js';
import type { MemoryRecord } from '../../src/types.js';

const HAS_PROC = process.platform === 'linux' && existsSync('/proc/self/fd');
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

const rec = (id: string, content = 'c'): MemoryRecord => ({
  id, tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null, type: 'assert', state: 'Fresh', content,
  provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
});
const seed = (f: string, ...rs: MemoryRecord[]): void => writeFileSync(f, rs.map((r) => JSON.stringify(r) + '\n').join(''));
const noKeep = { keepValidVerify: () => false, provesKey: () => false } as const;
const ORPHAN = `memory.jsonl.c-${'a'.repeat(32)}.tmp`;
const enoent = (): never => { throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }); };
const idOf = (p: string): { dev: bigint; ino: bigint } => { const s = statSync(p, { bigint: true }); return { dev: s.dev, ino: s.ino }; };

/** <base>/data holds the ledger; <base>/out is somewhere a replaced folder can lead to, with a decoy ledger. */
interface World { base: string; dir: string; orig: string; ledger: string; outside: string }
function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rh-')));
  made.push(base);
  const w: World = { base, dir: join(base, 'data'), orig: join(base, 'data.orig'), ledger: join(base, 'data', 'memory.jsonl'), outside: join(base, 'out') };
  mkdirSync(w.dir); mkdirSync(w.outside);
  writeFileSync(join(w.outside, 'memory.jsonl'), 'DECOY\n');
  return w;
}
const swapIn = (w: World): void => { renameSync(w.dir, w.orig); symlinkSync(w.outside, w.dir); };
const swapBack = (w: World): void => { unlinkSync(w.dir); renameSync(w.orig, w.dir); };
/** The folder is a link from the tmp's fchmod (just after the first stillOwned look) to the tmp's close (before the second):
 *  every read of the rewrite and the write of the tmp fall inside. */
function swappedWhileReading(w: World): { fsOps: DurableFsOps; swapped(): boolean } {
  let swapped = false;
  return {
    swapped: () => swapped,
    fsOps: {
      ...realFsOps,
      fchmodSync: (fd, mode) => { swapped = true; swapIn(w); realFsOps.fchmodSync(fd, mode); },
      closeSync: (fd) => { realFsOps.closeSync(fd); if (swapped && existsSync(w.orig)) swapBack(w); },
    },
  };
}

describe('compactLedger through the held directory (14 decision 2)', () => {
  it.skipIf(!HAS_PROC)('a directory swapped for a link while the rewrite reads and writes: the judged file is the one read and replaced, and nothing is created where the link leads', () => {
    const w = world(); seed(w.ledger, rec('m_keep'), rec('m_secret', 'THE SECRET'));
    const { fsOps, swapped } = swappedWhileReading(w);
    compactLedger(w.ledger, { erasedIds: new Set(['m_secret']), ...noKeep, fsOps });
    expect(swapped()).toBe(true);
    expect(readdirSync(w.outside)).toEqual(['memory.jsonl']);
    expect(readFileSync(join(w.outside, 'memory.jsonl'), 'utf8')).toBe('DECOY\n');
    const real = readFileSync(w.ledger, 'utf8');
    expect(real).not.toContain('THE SECRET');
    expect(parseLedgerText(real).map((r) => r.id)).toContain('m_keep');
  });

  it.skipIf(!HAS_PROC)('a directory swapped for a link at the rename itself: the rename lands in the judged directory, and the directory fsync goes through the descriptor', () => {
    const w = world(); seed(w.ledger, rec('m_keep'), rec('m_secret', 'THE SECRET'));
    let swapped = false;
    const synced: string[] = [];
    const fsOps: DurableFsOps = {
      ...realFsOps,
      renameSync: (a, b) => { swapped = true; swapIn(w); try { realFsOps.renameSync(a, b); } finally { swapBack(w); } },
      fsyncDir: (d) => { synced.push(d); realFsOps.fsyncDir(d); },
    };
    compactLedger(w.ledger, { erasedIds: new Set(['m_secret']), ...noKeep, fsOps });
    expect(swapped).toBe(true);
    expect(readdirSync(w.outside)).toEqual(['memory.jsonl']);
    expect(readFileSync(join(w.outside, 'memory.jsonl'), 'utf8')).toBe('DECOY\n');
    expect(readFileSync(w.ledger, 'utf8')).not.toContain('THE SECRET');
    expect(synced.at(-1)).toMatch(/^\/proc\/self\/fd\/\d+$/);
  });

  it.skipIf(!HAS_PROC)('the witness gate of a rewrite reads the judged directory too: a swapped folder does not read as a rollback', () => {
    const w = world(); seed(w.ledger, rec('m_a'), rec('m_b'));
    const home = join(w.base, 'home');
    mkdirSync(home, { mode: 0o700 });
    const witness = { home, scopeKey: '@global', now: () => '2026-01-02T00:00:00.000Z', kind: 'compaction' as const };
    compactLedger(w.ledger, { erasedIds: new Set(), ...noKeep, witness });   // first contact: the witness now holds this file's head
    const { fsOps, swapped } = swappedWhileReading(w);
    compactLedger(w.ledger, { erasedIds: new Set(), ...noKeep, witness, fsOps });
    expect(swapped()).toBe(true);
    expect(readFileSync(join(w.outside, 'memory.jsonl'), 'utf8')).toBe('DECOY\n');
    expect(parseLedgerText(readFileSync(w.ledger, 'utf8')).map((r) => r.id)).toEqual(expect.arrayContaining(['m_a', 'm_b']));
  });

  it('a link that took the memory file\'s name after the judgement is not read through (4.1 item 4): the rewrite is refused as a changed destination', () => {
    const w = world(); seed(w.ledger, rec('m_a'));
    const fsOps: DurableFsOps = {
      ...realFsOps,
      fchmodSync: (fd, mode) => { renameSync(w.ledger, join(w.dir, 'moved.jsonl')); symlinkSync(join(w.outside, 'memory.jsonl'), w.ledger); realFsOps.fchmodSync(fd, mode); },
    };
    let caught: unknown;
    try { compactLedger(w.ledger, { erasedIds: new Set(), ...noKeep, fsOps }); } catch (e) { caught = e; }
    expect(isLedgerDestinationChangedError(caught)).toBe(true);
    expect(readFileSync(join(w.outside, 'memory.jsonl'), 'utf8')).toBe('DECOY\n');
    expect(lstatSync(w.ledger).isSymbolicLink()).toBe(true);                      // the link was not replaced by a rewrite of what it leads to
    expect(readdirSync(w.dir).filter((n) => n.includes('.c-'))).toEqual([]);
  });

  it('a link to a directory takes the same refusal: the read answers ELOOP before anything asks what the link leads to', () => {
    const w = world(); seed(w.ledger, rec('m_a'));
    const fsOps: DurableFsOps = {
      ...realFsOps,
      fchmodSync: (fd, mode) => { renameSync(w.ledger, join(w.dir, 'moved.jsonl')); symlinkSync(w.outside, w.ledger); realFsOps.fchmodSync(fd, mode); },
    };
    let caught: unknown;
    try { compactLedger(w.ledger, { erasedIds: new Set(), ...noKeep, fsOps }); } catch (e) { caught = e; }
    expect(isLedgerDestinationChangedError(caught)).toBe(true);
    expect(readdirSync(w.outside)).toEqual(['memory.jsonl']);
    expect(readdirSync(w.dir).filter((n) => n.includes('.c-'))).toEqual([]);
  });

  it.skipIf(!HAS_PROC)('the close of the held directory fails after the rewrite landed: the rewrite stands (a read-only descriptor loses nothing, and the caller would report that nothing happened)', () => {
    const w = world(); seed(w.ledger, rec('m_keep'), rec('m_secret', 'THE SECRET'));
    let heldFd = -1;
    const fsOps: DurableFsOps = {
      ...realFsOps,
      openSync: (p, f, m) => { const fd = realFsOps.openSync(p, f, m); if (heldFd === -1 && typeof f === 'number' && (f & constants.O_DIRECTORY) !== 0) heldFd = fd; return fd; },
      closeSync: (fd) => { realFsOps.closeSync(fd); if (fd === heldFd) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' }); },
    };
    expect(() => compactLedger(w.ledger, { erasedIds: new Set(['m_secret']), ...noKeep, fsOps })).not.toThrow();
    expect(readFileSync(w.ledger, 'utf8')).not.toContain('THE SECRET');
  });

  it.skipIf(!HAS_PROC)('the orphan sweep belongs to the held directory: the judged directory\'s orphan goes, the decoy orphan of the folder the link leads to stays', () => {
    const w = world(); seed(w.ledger, rec('m_a'), rec('m_b'));
    writeFileSync(join(w.dir, ORPHAN), 'plaintext orphan'); writeFileSync(join(w.outside, ORPHAN), 'decoy orphan');
    let swapped = false;
    const fsOps: DurableFsOps = {
      ...realFsOps,
      readdirSync: (p) => { if (!swapped) { swapped = true; swapIn(w); } return realFsOps.readdirSync(p); },
      openSync: (p, f, m) => { if (swapped && existsSync(w.orig)) swapBack(w); return realFsOps.openSync(p, f, m); },   // the tmp's open: back before the first stillOwned look
    };
    compactLedger(w.ledger, { erasedIds: new Set(['m_a']), ...noKeep, fsOps });
    expect(swapped).toBe(true);
    expect(existsSync(join(w.dir, ORPHAN))).toBe(false);
    expect(existsSync(join(w.outside, ORPHAN))).toBe(true);
  });

  it('a judged path that resolves elsewhere is refused before anything is created', () => {
    const w = world(); seed(w.ledger, rec('m_a'));
    let caught: unknown;
    try {
      withFileLock(w.ledger, (ctx) => compactLedgerUnlocked(w.ledger, { erasedIds: new Set(), ...noKeep }, ctx, { path: join(w.dir, 'other.jsonl'), identity: null }));
    } catch (e) { caught = e; }
    expect(isLedgerDestinationChangedError(caught)).toBe(true);
    expect(readdirSync(w.dir)).toEqual(['memory.jsonl']);
  });

  it.skipIf(!HAS_PROC)('a judged directory identity that is not this directory is refused before anything is created', () => {
    const w = world(); seed(w.ledger, rec('m_a'));
    let caught: unknown;
    try {
      withFileLock(w.ledger, (ctx) => compactLedgerUnlocked(w.ledger, { erasedIds: new Set(), ...noKeep }, ctx, { path: w.ledger, identity: idOf(w.ledger), dir: idOf(w.outside) }));
    } catch (e) { caught = e; }
    expect(isLedgerDestinationChangedError(caught)).toBe(true);
    expect(readdirSync(w.dir)).toEqual(['memory.jsonl']);
    expect(readdirSync(w.outside)).toEqual(['memory.jsonl']);
  });

  it('control (Review Focus 2): without /proc the rewrite works by path and nothing is refused', () => {
    const w = world(); seed(w.ledger, rec('m_keep'), rec('m_secret', 'THE SECRET'));
    const noProc: ProcFdSyscalls = { statSync: enoent, readlinkSync: enoent };
    compactLedger(w.ledger, { erasedIds: new Set(['m_secret']), ...noKeep, fsOps: { ...realFsOps, procFd: noProc } });
    expect(readFileSync(w.ledger, 'utf8')).not.toContain('THE SECRET');
    expect(readdirSync(w.dir)).toEqual(['memory.jsonl']);
  });

  it.skipIf(!HAS_PROC)('a /proc that was usable and is lost refuses the rewrite with the dedicated error; nothing is created or changed', () => {
    let broken = false;
    const procFd: ProcFdSyscalls = {
      statSync: (p) => (broken ? enoent() : realProcFdSyscalls.statSync(p)),
      readlinkSync: (p) => (broken ? enoent() : realProcFdSyscalls.readlinkSync(p)),
    };
    const fsOps: DurableFsOps = { ...realFsOps, procFd };
    const w = world(); seed(w.ledger, rec('m_a'), rec('m_b'));
    compactLedger(w.ledger, { erasedIds: new Set(['m_a']), ...noKeep, fsOps });   // binds once: /proc is remembered as present
    broken = true;
    const before = readFileSync(w.ledger, 'utf8');
    let caught: unknown;
    try { compactLedger(w.ledger, { erasedIds: new Set(['m_b']), ...noKeep, fsOps }); } catch (e) { caught = e; }
    expect(isLedgerProcLostError(caught)).toBe(true);
    expect(readFileSync(w.ledger, 'utf8')).toBe(before);
    expect(readdirSync(w.dir)).toEqual(['memory.jsonl']);
  });
});

describe('the append sweeps the held directory too (the decision A6 left open)', () => {
  it.skipIf(!HAS_PROC)('the judged directory\'s orphan goes, the decoy orphan of the folder a link leads to stays, and the row lands in the judged file', () => {
    const w = world(); seed(w.ledger, rec('m_a'));
    writeFileSync(join(w.dir, ORPHAN), 'plaintext orphan'); writeFileSync(join(w.outside, ORPHAN), 'decoy orphan');
    let swapped = false;
    const fsOps: DurableFsOps = {
      ...realFsOps,
      readdirSync: (p) => { if (!swapped) { swapped = true; swapIn(w); } return realFsOps.readdirSync(p); },
      fsyncDir: (d) => { realFsOps.fsyncDir(d); if (swapped && existsSync(w.orig)) swapBack(w); },
    };
    appendRecordUnlocked(w.ledger, rec('m_new'), fsOps);
    expect(swapped).toBe(true);
    expect(existsSync(join(w.dir, ORPHAN))).toBe(false);
    expect(existsSync(join(w.outside, ORPHAN))).toBe(true);
    expect(parseLedgerText(readFileSync(w.ledger, 'utf8')).map((r) => r.id)).toEqual(['m_a', 'm_new']);
  });
});
