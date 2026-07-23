import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

// globalSetup redirects the temp base to a PRIVATE per-run root (helix-testrun-*) and removes only
// that root at teardown, so two concurrent `vitest run` invocations never delete each other's live
// fixtures and a real HELIX_HOME under the system temp dir is never swept. These run in a worker, so
// they also prove the redirect reached the worker env. If this regresses, fixtures fall back to the
// shared /tmp helix-* namespace and the cross-run collision (the flaky ENOENT class) returns.
describe('per-run temp isolation (global-setup)', () => {
  it('os.tmpdir() inside a worker resolves to this run private root', () => {
    expect(tmpdir()).toMatch(/helix-testrun-[^/\\]+$/);
  });

  it('a fixture mkdtemp lands inside the per-run root (so teardown removes only this run)', () => {
    const d = mkdtempSync(join(tmpdir(), 'helix-probe-'));
    expect(d).toMatch(/helix-testrun-[^/\\]+[/\\]helix-probe-/);
  });

  it('exposes the real (unredirected) system temp for the rare test that commits a temp path', () => {
    const sys = process.env.HELIX_TEST_SYS_TMP;
    expect(sys).toBeTruthy();
    expect(tmpdir().startsWith(sys!)).toBe(true); // the run root lives under the real system temp
    expect(sys).not.toMatch(/helix-testrun-/);    // ...but the real temp itself is NOT the run root
  });
});
