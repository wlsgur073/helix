import { openSync, readSync, writeSync, fsyncSync, closeSync, fstatSync, renameSync, unlinkSync, linkSync, fchmodSync, readdirSync } from 'node:fs';

/** Injectable seam for the durable-write paths. It exists so tests can assert fsync TARGET AND
 *  ORDER: durability has no behavioral observable (a SIGKILLed process's page cache survives, so
 *  removing every fsync stays green behaviorally) — only the syscall sequence can be pinned.
 *  Production code always receives `realFsOps`. Keep this seam exactly as thin as the write path. */
export interface DurableFsOps {
  openSync(path: string, flags: string, mode?: number): number;
  readSync(fd: number, buf: Buffer, offset: number, length: number, position: number): number;
  writeSync(fd: number, buf: Buffer, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  fstatSync(fd: number): { size: number; nlink: number; mode: number };
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  linkSync(from: string, to: string): void;
  fchmodSync(fd: number, mode: number): void;
  readdirSync(dir: string): string[];
  fsyncDir(dir: string): void;
}

/** Thin, test-only seam over the three raw syscalls fsyncDir itself makes. Kept separate from
 *  DurableFsOps — fsyncDir IS one of that interface's members, not a caller of it — so a test can
 *  drive fsyncDir's OWN errno branch below without a directory or filesystem that actually produces
 *  the failure. Production always uses the real syscalls (the default). */
export interface DirFsyncSyscalls {
  openSync(path: string, flags: string): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
}
const realDirFsyncSyscalls: DirFsyncSyscalls = { openSync, fsyncSync, closeSync };

/** Errno codes meaning "this platform/filesystem does not support fsyncing a directory at all" —
 *  the SWALLOWED class below. EINVAL/EISDIR are the POSIX-common pair; ENOTSUP/EOPNOTSUPP are a
 *  second, distinct pair some filesystems return instead (they share one numeric value on Linux but
 *  are DISTINCT symbols on other platforms — list both, never assume they coincide; fix round 1,
 *  owner ruling). Deliberately over-inclusive: an unrecognized "can't do this" code landing here only
 *  restores the OLD shipped behavior (a silent durability loss) for that one code, whereas the
 *  opposite mistake — a genuine platform limit misclassified as PROPAGATED — makes memory unusable on
 *  that platform. The two directions are not symmetric, so when the classification is a guess about
 *  the world, err toward the failure mode already shipped. */
const SWALLOWED_FSYNC_CODES = new Set(['EINVAL', 'EISDIR', 'ENOTSUP', 'EOPNOTSUPP']);

/** Fsync a directory fd so a create/rename/unlink is durably persisted — EXCEPT a genuinely failed
 *  attempt, which propagates instead of being reported as success (2026-08-06, owner decision).
 *
 *  Two classes, split on errno ALONE, never on the message (the discipline ledger-sweep.ts:39-44
 *  already uses for its own ENOENT check):
 *  - SWALLOWED: the platform cannot fsync a directory at all. An open() failure (e.g. Windows, which
 *    cannot open a directory for reading) means fsync was never even attempted, so nothing was
 *    "tried" — any errno swallows here. A code in SWALLOWED_FSYNC_CODES from the fsync() call itself
 *    means the syscall WAS attempted but this filesystem does not support it — a platform limit, not
 *    a real failure.
 *  - PROPAGATED: fsync() was attempted and genuinely failed — any code NOT in SWALLOWED_FSYNC_CODES
 *    (EIO, ENOSPC, EDQUOT, EBADF, a code-less error, ...) — a real durability loss the caller must
 *    not silently report as success. See SECURITY.md's "Appends are durable" bullet for the
 *    caller-facing consequence. */
export function fsyncDir(dir: string, sys: DirFsyncSyscalls = realDirFsyncSyscalls): void {
  let dfd: number;
  try { dfd = sys.openSync(dir, 'r'); } catch { return; }
  try {
    sys.fsyncSync(dfd);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === undefined || !SWALLOWED_FSYNC_CODES.has(code)) throw e;
  } finally {
    sys.closeSync(dfd);
  }
}

export const realFsOps: DurableFsOps = {
  openSync, readSync, writeSync, fsyncSync, closeSync,
  fstatSync: (fd) => { const s = fstatSync(fd); return { size: s.size, nlink: s.nlink, mode: s.mode }; },
  renameSync, unlinkSync, linkSync, fchmodSync,
  readdirSync: (d) => readdirSync(d),
  fsyncDir,
};

/** Write the whole payload to fd, looping on short writes (a partial write followed by a bare return
 *  would tear a JSONL line even without concurrency). Accepts a Buffer for binary trust-store writes
 *  (the master key) — a utf8 round-trip would risk corrupting non-text bytes. Throws on a zero-progress
 *  write rather than spinning forever: writeSync must make forward progress on a regular file, so a
 *  0 return signals a broken fd/seam, not a transient short write. */
export function writeAll(fs: DurableFsOps, fd: number, data: string | Buffer): void {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw new Error(`writeAll: zero-progress write (${n} of ${buf.length - off} remaining bytes)`);
    off += n;
  }
}
