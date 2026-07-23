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

/** Best-effort fsync of a directory fd so a create/rename/unlink is durably persisted. On Windows
 *  (and some FS) a directory cannot be opened/fsynced — skip; never a correctness issue. */
export function fsyncDir(dir: string): void {
  let dfd: number;
  try { dfd = openSync(dir, 'r'); } catch { return; }
  try { fsyncSync(dfd); } catch { /* EINVAL/EISDIR on some FS — durability only */ }
  finally { closeSync(dfd); }
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
