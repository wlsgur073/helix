import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realFsOps, fsyncDir, writeAll } from '../../src/memory/fs-ops.js';

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
  it('fsyncDir: a missing directory rethrows on POSIX — the entry it should persist cannot exist (fsyncDir-swallow finding)', () => {
    expect(() => fsyncDir('/definitely/not/a/dir', undefined, 'linux')).toThrow();
  });

  it('fsyncDir swallows only directory-unsupported codes; real I/O failures propagate; win32 stays wholesale best-effort', () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    const io = (over: Partial<{ openSync: () => number; fsyncSync: () => void; closeSync: () => void }>) =>
      ({ openSync: () => 7, fsyncSync: () => {}, closeSync: () => {}, ...over }) as never;
    expect(() => fsyncDir('/d', io({ fsyncSync: () => { throw err('EINVAL'); } }), 'linux')).not.toThrow();
    expect(() => fsyncDir('/d', io({ openSync: () => { throw err('EACCES'); } }), 'linux')).not.toThrow();
    expect(() => fsyncDir('/d', io({ fsyncSync: () => { throw err('EIO'); } }), 'linux')).toThrow('EIO');
    expect(() => fsyncDir('/d', io({ openSync: () => { throw err('ENOENT'); } }), 'linux')).toThrow('ENOENT');
    expect(() => fsyncDir('/d', io({ openSync: () => { throw err('EIO'); } }), 'win32')).not.toThrow();
    let closed = 0;
    expect(() => fsyncDir('/d', io({ fsyncSync: () => { throw err('EIO'); }, closeSync: () => { closed++; } }), 'linux')).toThrow();
    expect(closed).toBe(1); // the fd is released even on the propagate path
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
