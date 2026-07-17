// Smoke test for the COMPILED T1 trigger CLI artifact (Phase 2 Track 2a, Task A3 — see
// docs/superpowers/plans/2026-07-17-phase2-trigger-governance-and-disclosure.md). Spawns
// bin/helix-trigger.mjs with `node` (child_process spawnSync), never tsx and never the .ts source,
// so a bundling regression that only manifests in the built artifact (a missing external, a broken
// relative-import rewrite) fails here even though trigger-eval.test.ts / trigger-line.test.ts (which
// import the .ts sources directly) would stay green. Deep behavioral coverage of the measurement
// logic already lives in trigger-line.test.ts; this file only proves the COMPILED bytes behave the
// same way end-to-end. Kept to two spawns total — node spawns are slow.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(root, 'bin', 'helix-trigger.mjs');

const tmpHome = (): string => mkdtempSync(join(tmpdir(), 'helix-trigger-artifact-home-'));
const tmpProjRoot = (): string => mkdtempSync(join(tmpdir(), 'helix-trigger-artifact-root-'));

/** Child env: the real process.env plus a pinned HELIX_HOME, with HELIX_LEDGER stripped so an
 *  ambient value in the test runner's own shell can never leak into the spawned child. */
function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HELIX_HOME: home };
  delete env.HELIX_LEDGER;
  return env;
}

describe('bin/helix-trigger.mjs (compiled artifact smoke test)', () => {
  it('success: prints one evaluation-record line, appends the same line to trigger.jsonl at mode 0600, exit 0', () => {
    const home = tmpHome();
    const projRoot = tmpProjRoot(); // no .helix subdir -> project 'absent'

    writeFileSync(join(home, 'memory.jsonl'), 'g1\ng2\ng3\n'); // a few newline-terminated lines
    const recall = JSON.stringify({ v: 1, kind: 'op', 'gen_ai.tool.name': 'helix_memory_recall', duration_ms: 42, ok: true });
    const otherTool = JSON.stringify({ v: 1, kind: 'op', 'gen_ai.tool.name': 'helix_memory_commit', duration_ms: 5, ok: true });
    writeFileSync(join(home, 'metrics.jsonl'), `${recall}\n${otherTool}\n`);

    const res = spawnSync(process.execPath, [BIN, '--root', projRoot, '--run', 'a3-smoke-1'], {
      env: childEnv(home),
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    const stdoutLines = res.stdout.split('\n').filter((l) => l.length > 0);
    expect(stdoutLines).toHaveLength(1); // exactly one JSON line on stdout
    const record = JSON.parse(stdoutLines[0]!);
    expect(record.kind).toBe('evaluation');
    expect(record.project).toBe('absent');
    expect(record.metricsState).toBe('present');
    expect(record.latencyN).toBe(1); // exactly one recall row; the other-tool row is recognized+excluded
    expect(record.unknownLines).toBe(0);
    // Plausible legs: 3 ledger rows and one fast (42ms) recall both stay well under threshold.
    expect(record.legs.rows).toEqual({ min: 3, max: 3, threshold: 2500, status: 'false' });
    expect(record.legs.bytes).toEqual({ min: 9, max: 9, threshold: 4_194_304, status: 'false' });
    expect(record.legs.latency).toEqual({ min: 0, max: 0, threshold: 3, status: 'false' });
    expect(record.overall).toBe('not-fired');

    const sinkPath = join(home, 'trigger.jsonl');
    expect(existsSync(sinkPath)).toBe(true);
    expect(readFileSync(sinkPath, 'utf8')).toBe(`${stdoutLines[0]}\n`); // same line, sink-appended
    expect(statSync(sinkPath).mode & 0o777).toBe(0o600);
  }, 15_000);

  it('usage crash: no --root -> exit 2, stderr non-empty, no trigger.jsonl created', () => {
    const home = tmpHome();
    const res = spawnSync(process.execPath, [BIN, '--run', 'a3-smoke-2'], {
      env: childEnv(home),
      encoding: 'utf8',
    });
    expect(res.status).toBe(2);
    expect(res.stderr.length).toBeGreaterThan(0);
    expect(existsSync(join(home, 'trigger.jsonl'))).toBe(false); // no record, no sink write
  }, 15_000);
});
