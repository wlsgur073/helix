import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realFsOps, fsyncDir, writeAll, type DirFsyncSyscalls } from '../../src/memory/fs-ops.js';

/** A DirFsyncSyscalls stand-in whose open/close are harmless no-ops (a dummy fd, never a real
 *  filesystem call) so fsyncSync's coded throw is reached deterministically — a REAL open() on a
 *  placeholder path would fail on its own and never reach fsyncSync, silently passing a "swallow"
 *  assertion for the wrong reason. */
const fsyncThrows = (code: string | undefined, message = `fake ${code}`): DirFsyncSyscalls => ({
  openSync: () => 999,
  closeSync: () => {},
  fsyncSync: () => { throw Object.assign(new Error(message), code === undefined ? {} : { code }); },
});

describe('fs-ops seam', () => {
  it('writeAll completes a multi-chunk write even when writeSync returns short counts', () => {
    const d = mkdtempSync(join(tmpdir(), 'fsops-'));
    const f = join(d, 'x.txt');
    let calls = 0;
    const shortWriting = { ...realFsOps, writeSync: (fd: number, b: Buffer, o: number, l: number) => { calls++; return realFsOps.writeSync(fd, b, o, Math.min(l, 3)); } };
    const fd = realFsOps.openSync(f, 'wx');
    try { writeAll(shortWriting, fd, 'abcdefghij'); } finally { realFsOps.closeSync(fd); }
    expect(readFileSync(f, 'utf8')).toBe('abcdefghij');   // no fragment loss under short writes
    expect(calls).toBeGreaterThan(1);                      // the loop actually looped
  });
  it('swallows the platform-cannot-fsync class: a real open failure, an injected open failure (Windows-style), and EINVAL/EISDIR/ENOTSUP/EOPNOTSUPP on the fsync itself', () => {
    expect(() => fsyncDir('/definitely/not/a/dir')).not.toThrow();     // real open() failure — never attempted, nothing to report
    const openFails: DirFsyncSyscalls = {
      openSync: () => { throw Object.assign(new Error('EPERM fake (Windows-style open failure)'), { code: 'EPERM' }); },
      fsyncSync: () => { throw new Error('unreachable: fsync must never run when open failed'); },
      closeSync: () => { throw new Error('unreachable: close must never run when open failed'); },
    };
    expect(() => fsyncDir('/irrelevant', openFails)).not.toThrow();
    expect(() => fsyncDir('/irrelevant', fsyncThrows('EINVAL'))).not.toThrow();
    expect(() => fsyncDir('/irrelevant', fsyncThrows('EISDIR'))).not.toThrow();
    // fix round 1 (owner ruling): ENOTSUP/EOPNOTSUPP are a second "platform can't do this" pair some
    // filesystems return instead of EINVAL/EISDIR — same value on Linux, distinct symbols elsewhere.
    expect(() => fsyncDir('/irrelevant', fsyncThrows('ENOTSUP'))).not.toThrow();
    expect(() => fsyncDir('/irrelevant', fsyncThrows('EOPNOTSUPP'))).not.toThrow();
  });
  it('propagates an attempted-and-failed directory fsync (EIO class)', () => {
    expect(() => fsyncDir('/irrelevant', fsyncThrows('EIO'))).toThrow(/fake EIO/);
  });
  // fix round 1 (review Important 1): the tests above alone pass equally under an EIO-ONLY allowlist
  // (`if (code === 'EIO') throw e`) as under the real denylist — nothing here exercised a genuine
  // failure OTHER than EIO. That would silently re-swallow ENOSPC/EDQUOT/EBADF/code-less errors,
  // exactly the class ledger-sweep.ts:39-44's own comment names as the reason to discriminate on
  // errno at all. These two pin that a NON-EIO, NON-swallow-listed failure also propagates.
  it('propagates OTHER genuine failures too, not just EIO — an EIO-only allowlist would wrongly re-swallow these', () => {
    expect(() => fsyncDir('/irrelevant', fsyncThrows('ENOSPC'))).toThrow(/fake ENOSPC/);
    expect(() => fsyncDir('/irrelevant', fsyncThrows(undefined, 'fake code-less failure'))).toThrow(/fake code-less failure/);
  });
  it('closes the fd even when the fsync attempt is propagated (no fd leak on the throw path)', () => {
    const calls: string[] = [];
    const sys: DirFsyncSyscalls = {
      openSync: () => 999,
      fsyncSync: () => { calls.push('fsync'); throw Object.assign(new Error('fake EIO'), { code: 'EIO' }); },
      closeSync: (fd) => { calls.push(`close:${fd}`); },
    };
    expect(() => fsyncDir('/irrelevant', sys)).toThrow();
    expect(calls).toEqual(['fsync', 'close:999']);
  });
  it('discriminates by errno code, NOT by message text (the ledger-sweep.ts:39-44 discipline)', () => {
    // A message that NAMES the swallow codes but carries the propagate code must still throw —
    // proves the check reads `.code`, not `/EINVAL|EISDIR/.test(message)`.
    expect(() => fsyncDir('/irrelevant', fsyncThrows('EIO', 'looks like EINVAL or EISDIR but is not')))
      .toThrow(/looks like EINVAL or EISDIR but is not/);
    // And the reverse: a message that NAMES EIO but carries a swallow code must still be swallowed —
    // proves the check does not throw on any message mentioning EIO.
    expect(() => fsyncDir('/irrelevant', fsyncThrows('EINVAL', 'mentions EIO in its text'))).not.toThrow();
  });
  it('writeAll writes raw Buffer bytes verbatim (no utf8 round-trip for binary trust-store writes)', () => {
    const d = mkdtempSync(join(tmpdir(), 'fsops-'));
    const f = join(d, 'key.bin');
    const key = Buffer.from([0xff, 0x00, 0x80, 0xfe, 0x7f]); // bytes a utf8 decode would not preserve
    const fd = realFsOps.openSync(f, 'wx');
    try { writeAll(realFsOps, fd, key); } finally { realFsOps.closeSync(fd); }
    expect(readFileSync(f)).toEqual(key);
  });
  it('writeAll throws on a zero-progress write instead of looping forever', () => {
    const d = mkdtempSync(join(tmpdir(), 'fsops-'));
    const f = join(d, 'z.txt');
    const stuck = { ...realFsOps, writeSync: () => 0 }; // never makes forward progress
    const fd = realFsOps.openSync(f, 'wx');
    try { expect(() => writeAll(stuck, fd, 'abc')).toThrow(/zero-progress/); } finally { realFsOps.closeSync(fd); }
  });
});
