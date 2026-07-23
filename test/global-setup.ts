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
export default function setup(): () => void {
  const sysTmp = tmpdir(); // the real system temp, captured BEFORE redirect
  const runRoot = mkdtempSync(join(sysTmp, 'helix-testrun-'));
  const prev = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.HELIX_TEST_SYS_TMP = sysTmp;
  process.env.TMPDIR = runRoot;
  process.env.TMP = runRoot;
  process.env.TEMP = runRoot;
  return () => {
    process.env.TMPDIR = prev.TMPDIR;
    process.env.TMP = prev.TMP;
    process.env.TEMP = prev.TEMP;
    try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* teardown is best-effort */ }
  };
}
