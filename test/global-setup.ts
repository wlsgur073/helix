import { readdirSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_TMP_PREFIX = 'helix-'; // the dash excludes the runtime corral dir named exactly "helix"

export interface TempEntry { name: string; isDir: boolean; mtimeMs: number }

/** Pure: names of helix-* directories created during this run (mtime >= startMs). The timestamp
 *  guard avoids deleting a concurrent `npm test` invocation's in-flight fixtures. */
export function selectRunTempDirs(entries: TempEntry[], startMs: number): string[] {
  return entries
    .filter((e) => e.isDir && e.name.startsWith(TEST_TMP_PREFIX) && e.mtimeMs >= startMs)
    .map((e) => e.name);
}

/** vitest globalSetup: capture run start; the returned teardown removes this run's helix-* temp
 *  dirs. Best-effort and per-entry — never fails the test run. */
export default function setup(): () => void {
  const startMs = Date.now();
  return () => {
    try {
      const root = tmpdir();
      const entries: TempEntry[] = [];
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (!d.name.startsWith(TEST_TMP_PREFIX)) continue;
        try {
          const st = lstatSync(join(root, d.name));
          entries.push({ name: d.name, isDir: st.isDirectory(), mtimeMs: st.mtimeMs });
        } catch { /* vanished -> skip */ }
      }
      for (const name of selectRunTempDirs(entries, startMs)) {
        try { rmSync(join(root, name), { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    } catch { /* teardown is best-effort */ }
  };
}
