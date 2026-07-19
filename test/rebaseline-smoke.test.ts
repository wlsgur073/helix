// Smoke test for the COMPILED re-baseline ceremony CLI artifact (Task 9 — see
// docs/superpowers/plans/2026-07-18-highwater-counter-witness.md). Spawns bin/helix-rebaseline.mjs
// with `node` (child_process spawnSync, piped stdio), never tsx and never the .ts source, so a
// bundling regression (a missing external, a broken relative-import rewrite — this is the first
// bundle in the repo pulling in node:readline/promises) fails here even though
// test/rebaseline-cli.test.ts (which imports the .ts source directly, with promptLine injected)
// would stay green. Piped stdio means neither stdin nor stdout is a TTY, so a spawned run can only
// ever reach the argv-parse / isTTY-gate surface — it can never reach the confirmation prompt.
// Deep behavioral coverage of the ceremony itself (happy path, wrong word, hash-race, lock
// discipline) lives in test/rebaseline-cli.test.ts. Kept to a few spawns total — node spawns are slow.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(root, 'bin', 'helix-rebaseline.mjs');

const tmpHome = (): string => mkdtempSync(join(tmpdir(), 'helix-rebaseline-artifact-home-'));

/** Child env: the real process.env plus a pinned HELIX_HOME, with HELIX_LEDGER stripped so an
 *  ambient value in the test runner's own shell can never leak into the spawned child (mirrors
 *  trigger-artifact-smoke.test.ts's childEnv). */
function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HELIX_HOME: home };
  delete env.HELIX_LEDGER;
  return env;
}

describe('bin/helix-rebaseline.mjs (compiled artifact smoke test)', () => {
  it('--scope global with piped (non-TTY) stdio -> exit 2, refuses before any prompt, no witness/ledger artifacts written', () => {
    const home = tmpHome();
    const res = spawnSync(process.execPath, [BIN, '--scope', 'global'], {
      env: childEnv(home),
      input: '', // piped, empty — never a real TTY regardless of the parent shell
      encoding: 'utf8',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('interactive terminal');
    expect(res.stdout).toBe(''); // the display block never printed — the TTY gate is checked before it
  }, 15_000);

  it('no args / --help -> usage, exit 2, before touching HELIX_HOME at all', () => {
    const home = tmpHome();
    const res = spawnSync(process.execPath, [BIN, '--help'], {
      env: childEnv(home),
      input: '',
      encoding: 'utf8',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('usage');
    expect(res.stderr).toContain('--scope');
  }, 15_000);
});
