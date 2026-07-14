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
  it('fsyncDir is best-effort: never throws, even on a non-directory path', () => {
    expect(() => fsyncDir('/definitely/not/a/dir')).not.toThrow();
  });
});
