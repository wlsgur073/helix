// The script is CI's Node-20 job body. Running it here keeps it honest on the dev Node too, so a
// bundle that stops answering `initialize` fails in the suite rather than only on a release day.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts/smoke-runtime-floor.mjs');

const smoke = (): { status: number | null; stdout: string; stderr: string } =>
  spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 60_000 });

describe('runtime-floor smoke', () => {
  it('drives all six shipped bundles and exits 0', () => {
    const r = smoke();
    expect(r.stdout, r.stdout + r.stderr).toContain('all six shipped bundles run on this Node');
    expect(r.status).toBe(0);
  }, 60_000);

  it('reports every bundle it drove', () => {
    const { stdout } = smoke();
    for (const b of ['helix-rebaseline', 'helix-trigger', 'helix-trust-resolve',
                     'session-start', 'session-end', 'helix-mcp']) {
      expect(stdout, `${b} was not exercised`).toContain(b);
    }
  }, 60_000);
});
