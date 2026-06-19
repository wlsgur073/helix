import { describe, it, expect } from 'vitest';
import { selectRunTempDirs } from './global-setup.js';

describe('selectRunTempDirs (pure)', () => {
  const start = 1_000_000;
  it('selects helix- directories created at or after start', () => {
    const entries = [
      { name: 'helix-cfg-abc', isDir: true, mtimeMs: start + 5 },
      { name: 'helix-hook-xyz', isDir: true, mtimeMs: start }, // == start -> included
    ];
    expect(selectRunTempDirs(entries, start).sort()).toEqual(['helix-cfg-abc', 'helix-hook-xyz']);
  });
  it('skips dirs older than start, non-helix names, the bare "helix" dir, and non-directories', () => {
    const entries = [
      { name: 'helix-old', isDir: true, mtimeMs: start - 1 },   // previous/concurrent run
      { name: 'other-new', isDir: true, mtimeMs: start + 5 },   // not helix-
      { name: 'helix', isDir: true, mtimeMs: start + 5 },       // runtime corral, no dash -> skip
      { name: 'helix-file', isDir: false, mtimeMs: start + 5 }, // not a directory
    ];
    expect(selectRunTempDirs(entries, start)).toEqual([]);
  });
});
