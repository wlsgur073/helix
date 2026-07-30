import { existsSync, readdirSync, lstatSync, statSync, rmSync, writeFileSync, renameSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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

/** Create — or vet — the shared scratch root, and return it, or null if the name cannot be trusted.
 *
 *  The root is a FIXED name directly under a world-writable temp dir, so "create it if missing" is
 *  not enough on a multi-user host. `mkdirSync(root, {recursive:true, mode})` silently ignores its
 *  mode when the directory already exists, which is precisely the attacker's position: pre-create
 *  the name, and every later Helix run adopts whatever was left there. So an existing name is
 *  inspected with lstat rather than assumed:
 *
 *   - not a directory (a symlink, or a plain file) => refuse, and let the caller use a private
 *     unpredictable directory instead. Following a link here is how the .gc-stamp truncation got its
 *     victim in the first place;
 *   - a directory owned by somebody else => refuse, for the same reason;
 *   - our own directory, but group- or world-accessible => harden it in place rather than refuse, so
 *     a root left behind by an older version (or by a pre-creating user who owns nothing else here)
 *     stops leaking without costing the single-corral property that makes leaked scratch easy to
 *     purge.
 */
export function ensureScratchRoot(root: string): string | null {
  try { mkdirSync(root, { recursive: true, mode: 0o700 }); } catch { /* exists, or unwritable — vetted below */ }
  try {
    const st = lstatSync(root);                                   // lstat: judge the NAME, never its target
    if (!st.isDirectory()) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    if ((st.mode & 0o077) !== 0) chmodSync(root, 0o700);
    return root;
  } catch { return null; }
}

/** Publish the rate-limit stamp WITHOUT following whatever currently occupies its name.
 *
 *  The stamp lives at a fixed name under a shared, world-writable temp root, so on a multi-user host
 *  another local user can pre-create the root and plant `.gc-stamp` as a symlink to a file of ours —
 *  a ledger, say. `writeFileSync` follows symlinks, so the victim's next dual-verify run truncated
 *  the target to zero bytes. `rename(2)` replaces the NAME without following it, so a planted link
 *  is destroyed rather than obeyed, and the `wx` source guarantees the thing being renamed into
 *  place is one we just created. This module already refuses to follow links when it classifies
 *  sweep entries ("lstat: classify the link itself, never follow it") — this was the sibling site
 *  the rule had not been applied at.
 *
 *  Best-effort, like the write it replaces: a stamp we fail to publish only means the next run
 *  sweeps again. */
function publishStamp(stampPath: string): void {
  const tmp = `${stampPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, '', { flag: 'wx', mode: 0o600 });
    renameSync(tmp, stampPath);
  } catch {
    try { unlinkSync(tmp); } catch { /* never created, or already gone */ }
  }
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
    publishStamp(stampPath);
  } catch { /* never throw into the caller */ }
}
