// Third fix batch B1, task A6 (design 4.1 item 3, decision 2): dir-bound.ts, the held directory descriptor.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, statSync, existsSync, writeFileSync, chmodSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openJudgedDir, boundPath, fsyncDir, closeHeldDir, procFdAvailable, sampleDirIdentity, PROC_SELF_FD,
} from '../../src/memory/dir-bound.js';
import { realFsOps, realProcFdSyscalls, type DurableFsOps, type ProcFdSyscalls } from '../../src/memory/fs-ops.js';

const HAS_PROC = process.platform === 'linux' && existsSync('/proc/self/fd');
const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'db-')));
const idOf = (p: string): { dev: bigint; ino: bigint } => { const s = statSync(p, { bigint: true }); return { dev: s.dev, ino: s.ino }; };
const enoent = (): never => { throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }); };
/** A /proc that is not there (not mounted). */
const noProc = (): ProcFdSyscalls => ({ statSync: enoent, readlinkSync: enoent });

/** The seam with descriptor accounting, an open counter and the directory-fsync targets recorded. */
function counted(procFd?: ProcFdSyscalls): { ops: DurableFsOps; open: Set<number>; opens: () => number; fsyncDirs: string[] } {
  const open = new Set<number>(); const fsyncDirs: string[] = []; let n = 0;
  const ops: DurableFsOps = {
    ...realFsOps,
    openSync: (p, f, m) => { n++; const fd = realFsOps.openSync(p, f, m); open.add(fd); return fd; },
    closeSync: (fd) => { open.delete(fd); realFsOps.closeSync(fd); },
    fsyncDir: (d) => { fsyncDirs.push(d); realFsOps.fsyncDir(d); },
    ...(procFd ? { procFd } : {}),
  };
  return { ops, open, opens: () => n, fsyncDirs };
}

describe('openJudgedDir (4.1 item 3, decision 2)', () => {
  it.skipIf(!HAS_PROC)('binds the judged directory: /proc/self/fd/<fd>/<name> reaches that directory, closing releases the descriptor', () => {
    const d = tmp(); const { ops, open } = counted();
    const r = openJudgedDir(d, idOf(d), ops);
    expect(r.kind).toBe('bound');
    if (r.kind !== 'bound') return;
    expect(r.dir.fd).not.toBeNull();
    expect(PROC_SELF_FD).toBe('/proc/self/fd');
    expect(boundPath(r.dir, 'x.jsonl')).toBe(`/proc/self/fd/${r.dir.fd}/x.jsonl`);
    realFsOps.closeSync(realFsOps.openSync(boundPath(r.dir, 'x.jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
    expect(existsSync(join(d, 'x.jsonl'))).toBe(true);
    closeHeldDir(r.dir, ops);
    expect(open.size).toBe(0);
  });

  it('a judged-no-directory sample (null) is refused in both modes and nothing is opened (o2-04)', () => {
    const d = tmp();
    for (const procFd of [undefined, noProc()]) {
      const { ops, opens } = counted(procFd);
      expect(openJudgedDir(d, null, ops)).toEqual({ kind: 'changed' });
      expect(opens()).toBe(0);
    }
  });

  it.skipIf(!HAS_PROC)('a link at the directory name is refused (O_NOFOLLOW) and no descriptor is left', () => {
    const real = tmp(); const link = join(tmp(), 'ln'); symlinkSync(real, link);
    const { ops, open } = counted();
    expect(openJudgedDir(link, idOf(real), ops)).toEqual({ kind: 'changed' });
    expect(open.size).toBe(0);
  });

  it.skipIf(!HAS_PROC)('a directory with another identity than the judged one is refused', () => {
    const a = tmp(); const b = tmp(); const { ops, open } = counted();
    expect(openJudgedDir(a, idOf(b), ops)).toEqual({ kind: 'changed' });
    expect(open.size).toBe(0);
  });

  it.skipIf(!HAS_PROC)('the readlink binding (o2-01): the right identity under another PATH is refused', () => {
    const real = tmp(); mkdirSync(join(real, 'sub')); const alias = join(tmp(), 'alias'); symlinkSync(real, alias);
    const { ops, open } = counted();
    // alias/sub is a different spelling of real/sub: same device and inode, so the identity check alone passes it.
    expect(openJudgedDir(join(alias, 'sub'), idOf(join(real, 'sub')), ops)).toEqual({ kind: 'changed' });
    expect(open.size).toBe(0);
  });

  it.skipIf(!HAS_PROC)('pid-namespace check (o2-06): a /proc/self/fd/<fd> that names another object is not this process\'s; fall back, close the descriptor, and do not try again', () => {
    const d = tmp();
    const foreign: ProcFdSyscalls = { statSync: () => ({ dev: 1n, ino: 1n }), readlinkSync: (p) => realProcFdSyscalls.readlinkSync(p) };
    const { ops, open, opens } = counted(foreign);
    const r = openJudgedDir(d, idOf(d), ops);
    expect(r.kind).toBe('unbound');
    expect(open.size).toBe(0);
    expect(procFdAvailable(ops)).toBe(false);
    const before = opens();
    expect(openJudgedDir(d, idOf(d), ops).kind).toBe('unbound');
    expect(opens()).toBe(before);   // 'absent' is remembered: no directory open on later calls
  });

  it('no /proc from the start (Review Focus 2): an unbound handle, path-based names, the directory fsync by path, nothing refused', () => {
    const d = tmp(); const { ops, open, fsyncDirs } = counted(noProc());
    const r = openJudgedDir(d, idOf(d), ops);
    expect(r.kind).toBe('unbound');
    if (r.kind !== 'unbound') return;
    expect(r.dir).toEqual({ dir: d, fd: null });
    expect(boundPath(r.dir, 'm.jsonl')).toBe(join(d, 'm.jsonl'));
    fsyncDir(r.dir, ops);
    expect(fsyncDirs).toEqual([d]);
    closeHeldDir(r.dir, ops);
    expect(open.size).toBe(0);
  });

  it.skipIf(!HAS_PROC)('/proc lost after it was seen (Review Focus 3): the outcome is proc-lost, not changed, and no descriptor is left', () => {
    const d = tmp(); let lost = false;
    const stub: ProcFdSyscalls = { statSync: (p) => (lost ? enoent() : realProcFdSyscalls.statSync(p)), readlinkSync: (p) => realProcFdSyscalls.readlinkSync(p) };
    const { ops, open } = counted(stub);
    const first = openJudgedDir(d, idOf(d), ops);
    expect(first.kind).toBe('bound');
    if (first.kind === 'bound') closeHeldDir(first.dir, ops);
    lost = true;
    expect(openJudgedDir(d, idOf(d), ops)).toEqual({ kind: 'proc-lost' });
    expect(open.size).toBe(0);
  });

  it.skipIf(!HAS_PROC)('fsyncDir goes through the held descriptor (o2-05): the seam sees /proc/self/fd/<fd>, not the path', () => {
    const d = tmp(); const { ops, fsyncDirs } = counted();
    const r = openJudgedDir(d, idOf(d), ops);
    if (r.kind !== 'bound') throw new Error('premise: /proc is usable here');
    fsyncDir(r.dir, ops);
    expect(fsyncDirs).toEqual([`/proc/self/fd/${r.dir.fd}`]);
    closeHeldDir(r.dir, ops);
  });
});

describe('openJudgedDir: the edges the table cannot see (decision 9, the inode rule; a folder that cannot be listed)', () => {
  it.skipIf(!HAS_PROC)('an inode of 0 on the held directory (A5: no inode is no identity) skips the identity half and keeps the readlink binding: bound, not refused', () => {
    const d = tmp();
    const zero: ProcFdSyscalls = { statSync: (p) => ({ ...realProcFdSyscalls.statSync(p), ino: 0n }), readlinkSync: (p) => realProcFdSyscalls.readlinkSync(p) };
    const base = counted(zero).ops;
    const ops: DurableFsOps = { ...base, fstatSync: (fd) => ({ ...realFsOps.fstatSync(fd), ino: 0n }) };
    const r = openJudgedDir(d, { dev: idOf(d).dev, ino: 0n }, ops);
    expect(r.kind).toBe('bound');
    if (r.kind === 'bound') closeHeldDir(r.dir, ops);
  });

  it.skipIf(!HAS_PROC)('an inode of 0 on one side only of the namespace check says nothing about whose /proc it is: bound, never proc-lost (decision 9: an uncomparable identity never refuses by itself)', () => {
    const d = tmp();
    const { ops: real } = counted();                                                                // the descriptor answers 0, /proc the real inode
    const ops: DurableFsOps = { ...real, fstatSync: (fd) => ({ ...realFsOps.fstatSync(fd), ino: 0n }) };
    const r = openJudgedDir(d, idOf(d), ops);
    expect(r.kind).toBe('bound');
    if (r.kind === 'bound') closeHeldDir(r.dir, ops);
    const stub: ProcFdSyscalls = { statSync: (p) => ({ ...realProcFdSyscalls.statSync(p), ino: 0n }), readlinkSync: (p) => realProcFdSyscalls.readlinkSync(p) };
    const { ops: z, open } = counted(stub);                                                         // the other way round
    const r2 = openJudgedDir(d, idOf(d), z);
    expect(r2.kind).toBe('bound');
    if (r2.kind === 'bound') closeHeldDir(r2.dir, z);
    expect(open.size).toBe(0);
  });

  it.skipIf(!HAS_PROC || process.getuid?.() === 0)('a folder that cannot be listed (mode 0300): the open\'s EACCES propagates raw and no descriptor is left (the append\'s sweep lists that folder and fails the same way at HEAD, so no append ever worked there)', () => {
    const d = tmp(); chmodSync(d, 0o300);
    try {
      const { ops, open } = counted();
      let code: string | undefined;
      try { openJudgedDir(d, idOf(d), ops); } catch (e) { code = (e as NodeJS.ErrnoException).code; }
      expect(code).toBe('EACCES');
      expect(open.size).toBe(0);
    } finally { chmodSync(d, 0o700); }
  });
});

describe('sampleDirIdentity', () => {
  it('answers a directory\'s identity as bigints; a link to a directory, a file and a missing name answer null', () => {
    const d = tmp(); writeFileSync(join(d, 'f'), 'x'); symlinkSync(d, join(d, 'ln'));
    expect(sampleDirIdentity(d)).toEqual(idOf(d));
    expect(sampleDirIdentity(join(d, 'ln'))).toBeNull();
    expect(sampleDirIdentity(join(d, 'f'))).toBeNull();
    expect(sampleDirIdentity(join(d, 'missing'))).toBeNull();
  });
});
