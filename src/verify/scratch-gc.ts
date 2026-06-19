import { existsSync, readdirSync, lstatSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SCRATCH_PREFIX = 'codex-';
export const FLOOR_MS = 3 * 24 * 60 * 60 * 1000;       // 3 days
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;  // sweep at most once per 24h
export const STAMP_NAME = '.gc-stamp';

export interface ScratchEntry { name: string; isDir: boolean; mtimeMs: number }

/** Pure: names of codex-* directories at least floorMs old. Skips future-dated entries
 *  (clock-jump guard), non-directories, and non-codex names. */
export function selectStaleScratch(entries: ScratchEntry[], nowMs: number, floorMs: number): string[] {
  return entries
    .filter((e) => e.isDir
      && e.name.startsWith(SCRATCH_PREFIX)
      && e.mtimeMs <= nowMs
      && nowMs - e.mtimeMs >= floorMs)
    .map((e) => e.name);
}

/** Pure: sweep now? Yes if there is no stamp, the stamp is older than the interval, or the stamp
 *  is in the future (a bad/edited stamp must never suppress GC forever). */
export function shouldSweep(stampMtimeMs: number | null, nowMs: number, intervalMs: number): boolean {
  if (stampMtimeMs === null) return true;
  if (stampMtimeMs > nowMs) return true;
  return nowMs - stampMtimeMs >= intervalMs;
}

/** IO: best-effort sweep of <root>/codex-* stale directories, rate-limited by <root>/.gc-stamp.
 *  Never throws — a GC failure must not affect the caller (the verify path). */
export function sweepScratchRoot(root: string, nowMs: number = Date.now()): void {
  try {
    if (!existsSync(root)) return;
    const stampPath = join(root, STAMP_NAME);
    let stampMtimeMs: number | null = null;
    try { stampMtimeMs = statSync(stampPath).mtimeMs; } catch { stampMtimeMs = null; }
    if (!shouldSweep(stampMtimeMs, nowMs, SWEEP_INTERVAL_MS)) return;

    const entries: ScratchEntry[] = [];
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.name.startsWith(SCRATCH_PREFIX)) continue;
      try {
        const st = lstatSync(join(root, d.name)); // lstat: classify the link itself, never follow it
        entries.push({ name: d.name, isDir: st.isDirectory(), mtimeMs: st.mtimeMs });
      } catch { /* vanished/unreadable -> skip this entry */ }
    }
    for (const name of selectStaleScratch(entries, nowMs, FLOOR_MS)) {
      try { rmSync(join(root, name), { recursive: true, force: true }); } catch { /* per-entry best-effort */ }
    }
    try { writeFileSync(stampPath, ''); } catch { /* stamp write best-effort */ }
  } catch { /* never throw into the caller */ }
}
