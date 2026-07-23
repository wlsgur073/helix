import { describe, it, expect } from 'vitest';
import { selectReapableTempDirs } from './global-setup.js';

describe('selectReapableTempDirs (pure)', () => {
  const now = 10_000_000;
  const grace = 30 * 60 * 1000;

  it('reaps helix- dirs older than the grace window (orphans from finished runs)', () => {
    const entries = [
      { name: 'helix-old-abc', isDir: true, mtimeMs: now - grace - 1 }, // just past cutoff -> reap
      { name: 'helix-ancient', isDir: true, mtimeMs: now - grace * 10 }, // very old -> reap
    ];
    expect(selectReapableTempDirs(entries, now, grace).sort()).toEqual(['helix-ancient', 'helix-old-abc']);
  });

  it('never reaps recent dirs — this run OR a concurrent run\'s live fixtures', () => {
    const entries = [
      { name: 'helix-mine', isDir: true, mtimeMs: now - 5 },            // this run, seconds old
      { name: 'helix-concurrent', isDir: true, mtimeMs: now - grace + 1 }, // a live concurrent run, just inside grace
      { name: 'helix-edge', isDir: true, mtimeMs: now - grace },        // exactly grace old -> NOT strictly older -> kept
    ];
    expect(selectReapableTempDirs(entries, now, grace)).toEqual([]);
  });

  it('skips non-helix names, the bare "helix" corral, and non-directories even when old', () => {
    const entries = [
      { name: 'other-old', isDir: true, mtimeMs: now - grace * 5 },     // not helix-
      { name: 'helix', isDir: true, mtimeMs: now - grace * 5 },         // runtime corral, no dash
      { name: 'helix-file', isDir: false, mtimeMs: now - grace * 5 },   // not a directory
    ];
    expect(selectReapableTempDirs(entries, now, grace)).toEqual([]);
  });
});
