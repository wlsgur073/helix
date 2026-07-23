import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// vitest globalSetup: give THIS run a PRIVATE temp root and point the temp-dir env vars at it, so
// every fixture's os.tmpdir() lands inside it WITHOUT any fixture change. Teardown removes ONLY this
// run's root — never a shared helix-* namespace by mtime or age — so:
//   - two concurrent `vitest run` invocations can never delete each other's live fixtures (the
//     cross-run collision that made the suite flake under parallel load);
//   - there is no aging window that can delete a retained fixture mid-use;
//   - a real HELIX_HOME that happens to sit under the system temp dir is never swept.
// The run-root NAME may be high-entropy (mkdtemp) — it is a CLEANUP identity, never committed into
// ledger content, so it does not interact with the write-path secret scanner. The one test that DOES
// commit a temp path into content (compaction's file-contains probe) reads HELIX_TEST_SYS_TMP to place
// that probe under the REAL (unredirected) system temp at a low-entropy fixed name, where it is not
// redacted and — with constant content and no delete — is harmless to share across runs.
/** Restore an env var to a captured prior value, DELETING it when that value was undefined — because
 *  `process.env.X = undefined` stores the literal string "undefined" (Node 24), which would poison
 *  os.tmpdir() for anything sharing the process after teardown. */
export function restoreEnv(key: string, prior: string | undefined): void {
  if (prior === undefined) delete process.env[key];
  else process.env[key] = prior;
}

export default function setup(): () => void {
  const sysTmp = tmpdir(); // the real system temp, captured BEFORE redirect
  const runRoot = mkdtempSync(join(sysTmp, 'helix-testrun-'));
  const prev = {
    TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
    HELIX_TEST_SYS_TMP: process.env.HELIX_TEST_SYS_TMP,
  };
  process.env.HELIX_TEST_SYS_TMP = sysTmp;
  process.env.TMPDIR = runRoot;
  process.env.TMP = runRoot;
  process.env.TEMP = runRoot;
  return () => {
    restoreEnv('TMPDIR', prev.TMPDIR);
    restoreEnv('TMP', prev.TMP);
    restoreEnv('TEMP', prev.TEMP);
    restoreEnv('HELIX_TEST_SYS_TMP', prev.HELIX_TEST_SYS_TMP);
    // Best-effort: a normal-exit run removes its own root; a SIGKILL/crash cannot run teardown and
    // leaves a helix-testrun-* root behind (rare; cleaned by the OS temp policy, not by another run).
    try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* teardown is best-effort */ }
  };
}
