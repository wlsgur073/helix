import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  selectStaleScratch, shouldSweep, sweepScratchRoot,
  FLOOR_MS, SWEEP_INTERVAL_MS, STAMP_NAME,
} from '../../src/verify/scratch-gc.js';

describe('selectStaleScratch (pure)', () => {
  const now = 10_000_000_000;
  it('selects codex- dirs at least floorMs old', () => {
    const entries = [
      { name: 'codex-old', isDir: true, mtimeMs: now - FLOOR_MS - 1 },
      { name: 'codex-edge', isDir: true, mtimeMs: now - FLOOR_MS },     // exactly floor -> stale
      { name: 'codex-fresh', isDir: true, mtimeMs: now - 1000 },
    ];
    expect(selectStaleScratch(entries, now, FLOOR_MS).sort()).toEqual(['codex-edge', 'codex-old']);
  });
  it('skips future-dated, non-codex names, and non-directories', () => {
    const entries = [
      { name: 'codex-future', isDir: true, mtimeMs: now + 5000 },
      { name: 'other-old', isDir: true, mtimeMs: now - FLOOR_MS - 1 },
      { name: 'codex-file', isDir: false, mtimeMs: now - FLOOR_MS - 1 },
    ];
    expect(selectStaleScratch(entries, now, FLOOR_MS)).toEqual([]);
  });
});

describe('shouldSweep (pure)', () => {
  const now = 10_000_000_000;
  it('sweeps when no stamp, when older than interval, and when the stamp is in the future', () => {
    expect(shouldSweep(null, now, SWEEP_INTERVAL_MS)).toBe(true);
    expect(shouldSweep(now - SWEEP_INTERVAL_MS, now, SWEEP_INTERVAL_MS)).toBe(true);
    expect(shouldSweep(now + 10_000, now, SWEEP_INTERVAL_MS)).toBe(true);
  });
  it('skips when the stamp is younger than the interval', () => {
    expect(shouldSweep(now - 1000, now, SWEEP_INTERVAL_MS)).toBe(false);
  });
});

describe('sweepScratchRoot (IO, best-effort)', () => {
  const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;
  it('removes stale codex- dirs, keeps fresh + non-codex + codex- files, writes the stamp', () => {
    const root = mkdtempSync(join(tmpdir(), 'helix-gctest-'));
    const now = Date.now();
    const old = join(root, 'codex-old'); mkdirSync(old);
    utimesSync(old, new Date(now - FOUR_DAYS_MS), new Date(now - FOUR_DAYS_MS));
    const fresh = join(root, 'codex-fresh'); mkdirSync(fresh);
    const other = join(root, 'other-keep'); mkdirSync(other);
    const file = join(root, 'codex-file'); writeFileSync(file, 'x');
    utimesSync(file, new Date(now - FOUR_DAYS_MS), new Date(now - FOUR_DAYS_MS));

    sweepScratchRoot(root, now);

    expect(existsSync(old)).toBe(false);    // stale dir -> removed
    expect(existsSync(fresh)).toBe(true);   // fresh dir -> kept
    expect(existsSync(other)).toBe(true);   // non-codex -> kept
    expect(existsSync(file)).toBe(true);    // codex- FILE (not a dir) -> kept
    expect(existsSync(join(root, STAMP_NAME))).toBe(true);
  });
  it('is rate-limited by a fresh stamp (skips the readdir/delete entirely)', () => {
    const root = mkdtempSync(join(tmpdir(), 'helix-gctest-'));
    const now = Date.now();
    writeFileSync(join(root, STAMP_NAME), '');
    // Back-date the stamp into the recent past, as production does (the stamp is written at the end
    // of one sweep and read at the start of a strictly later call). A stamp written in the same
    // millisecond as `now` has a fractional-ms mtime > integer-ms `now`, which the future-guard
    // would (correctly) treat as a future stamp. This keeps the test skew-immune.
    utimesSync(join(root, STAMP_NAME), new Date(now - 1000), new Date(now - 1000));
    const old = join(root, 'codex-old'); mkdirSync(old);
    utimesSync(old, new Date(now - FOUR_DAYS_MS), new Date(now - FOUR_DAYS_MS));
    sweepScratchRoot(root, now);
    expect(existsSync(old)).toBe(true); // fresh stamp -> not swept this call
  });
  it('a missing root is a no-op and never throws', () => {
    expect(() => sweepScratchRoot(join(tmpdir(), 'helix-gctest-does-not-exist-zzz'), Date.now())).not.toThrow();
  });
});
