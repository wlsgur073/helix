import { readdirSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_TMP_PREFIX = 'helix-'; // the dash excludes the runtime corral dir named exactly "helix"

// No vitest run takes anywhere near this long, so a helix-* temp dir older than the grace period is
// provably an orphan from a FINISHED (or crashed) run — never a live concurrent one. We deliberately
// NEVER delete recent dirs (this run's OR a concurrent run's): the old teardown deleted every dir
// with mtime >= this run's start, which under a second overlapping `vitest run` yanked that run's
// still-live fixtures out mid-operation (renameSync/linkSync ENOENT, deleted probe files) — the
// cross-run collision that made the suite flake under parallel load. Trade-off: this run's own dirs
// leak until a later run reaps them (CI /tmp is ephemeral; locally the OS temp policy also cleans up).
const REAP_GRACE_MS = 30 * 60 * 1000; // 30 minutes

export interface TempEntry { name: string; isDir: boolean; mtimeMs: number }

/** Pure: names of helix-* directories old enough to be orphans from a finished run (mtime strictly
 *  older than nowMs - graceMs). Recent dirs — this run's and any concurrent run's live fixtures —
 *  are never selected, which is what makes two simultaneous runs safe. */
export function selectReapableTempDirs(entries: TempEntry[], nowMs: number, graceMs: number): string[] {
  const cutoff = nowMs - graceMs;
  return entries
    .filter((e) => e.isDir && e.name.startsWith(TEST_TMP_PREFIX) && e.mtimeMs < cutoff)
    .map((e) => e.name);
}

/** vitest globalSetup: the returned teardown reaps only OLD helix-* temp dirs (orphans), never recent
 *  ones, so concurrent runs can't delete each other's live fixtures. Best-effort — never fails a run.
 *  Residual: a HELIX_HOME pointed at a long-idle <systmp>/helix-* dir could be reaped by a test run;
 *  don't keep real data under the system temp dir's helix-* namespace while running the suite. */
export default function setup(): () => void {
  return () => {
    try {
      const root = tmpdir();
      const now = Date.now();
      const entries: TempEntry[] = [];
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (!d.name.startsWith(TEST_TMP_PREFIX)) continue;
        try {
          const st = lstatSync(join(root, d.name));
          entries.push({ name: d.name, isDir: st.isDirectory(), mtimeMs: st.mtimeMs });
        } catch { /* vanished -> skip */ }
      }
      for (const name of selectReapableTempDirs(entries, now, REAP_GRACE_MS)) {
        try { rmSync(join(root, name), { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    } catch { /* teardown is best-effort */ }
  };
}
