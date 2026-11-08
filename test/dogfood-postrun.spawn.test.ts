// Spawn tests for the systemd ExecStopPost adapter (Phase 2 Track 2a, Task A4 -- see
// the trigger-governance rollout plan). systemd invokes
// `scripts/dogfood-postrun.sh` directly -- these tests are its ONLY exercise. To exercise the REAL
// relative-location logic (`$(dirname "$0")/../bin/helix-trigger.mjs`), each test copies the adapter
// into a fresh temp tree as `<tmp>/scripts/dogfood-postrun.sh` and places a STUB
// `<tmp>/bin/helix-trigger.mjs` standing in for the compiled measurement artifact -- the real
// artifact's own contract is exercised by test/trigger-artifact-smoke.test.ts; this file proves only
// the ADAPTER's process-management/reporting contract, treating the artifact as a black box.
//
// Matrix (pairwise-reduced, kept lean -- node spawns are slow): artifact {exit 0, crash, hang after a
// partial stdout write, crash-with-unwritable-sink, unreachable-node, missing-root-argument}, plus a
// dedicated SIGPIPE cell (closed stdout reader on the adapter's own final echo). Every cell asserts
// the adapter itself exits 0 (a nonzero ExecStopPost can mark the systemd unit failed). The
// missing-root and SIGPIPE cells lock two fixes made after the initial review: bare `$1`/`$HOME`
// under `set -u`, and bash's default SIGPIPE disposition killing the script (exit 141) on the final
// echo if the stdout reader closes early.
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync, accessSync, symlinkSync, utimesSync, readdirSync, lstatSync, openSync, closeSync, constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTriggerRecord } from './helpers/trigger-record.js';
import type { EvaluationRecord } from '../scripts/trigger-measure.js';
import type { Leg } from '../scripts/trigger-eval.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_SCRIPT = join(repoRoot, 'scripts', 'dogfood-postrun.sh');
/** Every adapter run starts in a directory outside the repository (a spawned script never runs with the
 *  repository as its working directory). */
const OUTSIDE_CWD = mkdtempSync(join(tmpdir(), 'helix-postrun-cwd-'));

const STUB_OK = `process.exit(0);\n`;
// Exit 1 is helix-trigger's own crash code. Exit 3 is its refusal of the home (B2a plan decision P2) and has
// a stub of its own below, because the adapter now reads 3 as a refusal.
const STUB_CRASH = `process.exit(1);\n`;
const STUB_REFUSED = `process.exit(3);\n`;
// Prints an unterminated partial line (no trailing newline), then blocks forever. Node installs no
// default SIGTERM handler, so the process dies promptly on the adapter's `timeout` TERM signal --
// this stub exists to prove a truncated artifact write can never reach the sink (the adapter never
// reads/forwards the artifact's stdout; only the SINK's own content is asserted for this cell).
const STUB_HANG = `process.stdout.write('{"v":1,"kind":"eval'); setInterval(() => {}, 1_000_000_000);\n`;
// Mirrors trigger-cli.ts's own usage-error check (`if (!parsed.root ...) exit(2)`): exits 2 when
// `--root` is present but empty (or has no following value at all), else exits 0. Used only by the
// no-root cell, so that cell exercises the SAME contract shape the real artifact takes on a
// genuinely missing dogfood-root argument, not an ad hoc stand-in reason.
const STUB_USAGE_ON_EMPTY_ROOT = `
const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
process.exit(root ? 0 : 2);
`;
// Stays alive ~300ms (well past the adapter's own scripted work) then exits 1 -- gives a SIGPIPE
// reader time to close the pipe long before the adapter's final stdout echo, making that cell's
// failure window deterministic instead of a race.
const STUB_SLOW_CRASH = `setTimeout(() => process.exit(1), 300);\n`;

/** Fresh <tmp>/{scripts/dogfood-postrun.sh, bin/helix-trigger.mjs} tree per test -- copies the REAL
 *  committed script (not a rewritten copy) so $(dirname "$0") resolves against a genuine sibling
 *  bin/ directory, and each test can swap in a differently-behaving stub without cross-test
 *  interference. chmod is defensive; the test invokes `bash <script>` directly (never execs the file
 *  itself), so the copied script's own executable bit is not load-bearing for these tests -- only for
 *  the real systemd deployment. */
function buildTree(stubSource: string): { scriptPath: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'helix-postrun-'));
  mkdirSync(join(tmp, 'scripts'), { recursive: true });
  mkdirSync(join(tmp, 'bin'), { recursive: true });
  const scriptPath = join(tmp, 'scripts', 'dogfood-postrun.sh');
  copyFileSync(REAL_SCRIPT, scriptPath);
  chmodSync(scriptPath, 0o755);
  writeFileSync(join(tmp, 'bin', 'helix-trigger.mjs'), stubSource);
  return { scriptPath };
}

/** Same tree shape, but bin/ is left empty -- simulates the artifact being entirely absent. Used only
 *  by the launch-failure cell: on its own, an absent file is NOT enough to reach the launch-failure
 *  classification (`node <missing-file>.mjs` exits 1, i.e. "crash" under this contract's reason
 *  mapping -- 126/127 is specifically `timeout` failing to exec `node` itself, verified separately).
 *  Combined with pathWithoutNode() below, this cell reproduces the real-world case of a broken/
 *  incomplete deployment where neither the artifact nor a working `node` is reachable. */
function buildTreeMissingArtifact(): { scriptPath: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'helix-postrun-'));
  mkdirSync(join(tmp, 'scripts'), { recursive: true });
  const scriptPath = join(tmp, 'scripts', 'dogfood-postrun.sh');
  copyFileSync(REAL_SCRIPT, scriptPath);
  chmodSync(scriptPath, 0o755);
  return { scriptPath };
}

/** Every external command scripts/dogfood-postrun.sh runs (cd/pwd/printf/read/[ are bash builtins),
 *  plus `bash` itself, which this test's own spawnSync resolves against the CHILD's env.PATH. */
const ADAPTER_TOOLS = ['bash', 'timeout', 'date', 'dirname', 'grep', 'head', 'tail', 'cut', 'sed', 'sort', 'tr', 'mkdir'];

/** A PATH that resolves every tool in ADAPTER_TOOLS but NOT `node`: a fresh directory holding one
 *  symlink per tool, each pointing at the first executable of that name on the runner's PATH. Used
 *  only for the launch-failure cell, so the adapter's `timeout -k ... node ...` fails to exec `node`
 *  (exit 127) while `bash`/`timeout`/coreutils stay resolvable.
 *
 *  It deliberately does NOT drop the PATH directories that contain `node`: where node is installed
 *  by a distro or NodeSource package it lives in /usr/bin (and /bin, a symlink to it on merged-/usr
 *  systems) next to bash, timeout and coreutils, so dropping those directories left nothing to run
 *  and spawnSync('bash', ...) failed with ENOENT (status null) before the script ever started. */
function pathWithoutNode(): string {
  const dirs = (process.env.PATH ?? '').split(':').filter((d) => d.length > 0);
  const shim = mkdtempSync(join(tmpdir(), 'helix-postrun-path-'));
  for (const tool of ADAPTER_TOOLS) {
    const found = dirs.map((d) => join(d, tool)).find((p) => {
      try { accessSync(p, fsConstants.X_OK); return true; } catch { return false; }
    });
    if (found === undefined) throw new Error(`test setup: ${tool} is not on PATH`);
    symlinkSync(found, join(shim, tool));
  }
  return shim;
}

/** Minimal env for one adapter invocation: PATH (node/timeout/coreutils) + a per-test HELIX_HOME so
 *  the sink never touches the real ~/.helix, plus the two test-only budget overrides (documented in
 *  the script itself) so the hang cell finishes in ~1-2s instead of the real 45s/5s. */
function baseEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    HELIX_HOME: home,
    HELIX_POSTRUN_TIMEOUT: '1',
    HELIX_POSTRUN_KILL_AFTER: '1',
  };
}

function runAdapter(scriptPath: string, root: string, env: NodeJS.ProcessEnv, cwd: string = OUTSIDE_CWD): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('bash', [scriptPath, root], { env, cwd, encoding: 'utf8', timeout: 10_000 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const sinkLines = (home: string): string[] => readFileSync(join(home, 'trigger.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0);

/** The reporter-failure lines among the adapter's stdout (what journald receives). */
const reporterLines = (stdout: string): string[] => stdout.split('\n').filter((l) => l.includes('"kind":"reporter-failure"'));

/** A directory holding a stub `systemctl` that answers `is-system-running` with `system` for the system
 *  manager and `user` for `--user`, put first on PATH so no case depends on the host's init (the same
 *  construction as test/dogfood-watch.spawn.test.ts). */
function withSystemctl(env: NodeJS.ProcessEnv, system: string, user: string = system): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'helix-postrun-ctl-'));
  const stub = join(dir, 'systemctl');
  writeFileSync(stub, `#!/bin/sh\nif [ "$1" = "--user" ]; then printf '%s\\n' '${user}'; else printf '%s\\n' '${system}'; fi\nexit 0\n`);
  chmodSync(stub, 0o755);
  return { ...env, PATH: `${dir}:${process.env.PATH ?? ''}` };
}

/** `<root>/runs/<name>` holding `text`, its mtime `ageSeconds` in the past (the runner's tee target). */
function writeRunLog(root: string, name: string, text: string, ageSeconds = 5): void {
  mkdirSync(join(root, 'runs'), { recursive: true });
  const path = join(root, 'runs', name);
  writeFileSync(path, text);
  const t = Date.now() / 1000 - ageSeconds;
  utimesSync(path, t, t);
}
const limitLine = (kind: string): string => `You've hit your ${kind} limit \u00b7 resets 10:30pm (Asia/Seoul)\n`;
// The two journald lines (fixed at the text review).
const NOTE_USAGE_LIMIT = 'dogfood-postrun: no issue filed, the run stopped at a usage limit';
const NOTE_HOST_SHUTDOWN = 'dogfood-postrun: no issue filed, the host was shutting down';

/** One evaluation-kind sink line, built from the REAL `EvaluationRecord` shape and `JSON.stringify`
 *  (Task 12) -- same field set and same compact no-space form scripts/trigger-measure.ts:317-323
 *  itself writes, so the fired-history reporter's fixed-string parse is exercised against genuine
 *  production bytes rather than a hand-formatted approximation. Only `kind`/`ts`/`overall` are read
 *  by that parse, so every leg is the same inert placeholder. */
function evalLine(ts: string, overall: EvaluationRecord['overall'], run: string): string {
  const leg: Leg = { min: null, max: null, threshold: 0, status: 'unavailable' };
  const record: EvaluationRecord = {
    v: 1, policy: 'T1-2026-07-11', kind: 'evaluation',
    ts, run,
    service_result: null, exit_code: null, exit_status: null,
    legs: { rows: leg, bytes: leg, latency: leg },
    latencyN: null, overall,
    project: 'owned', metricsState: 'present', unknownLines: 0, unknownMaxOps: 0,
  };
  return JSON.stringify(record);
}

describe('scripts/dogfood-postrun.sh (ExecStopPost adapter spawn tests)', () => {
  it('artifact exit 0, lifecycle env set -> adapter exit 0, NO reporter-failure record in the sink', () => {
    const { scriptPath } = buildTree(STUB_OK);
    const home = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    const env = { ...baseEnv(home), INVOCATION_ID: 'inv-1', SERVICE_RESULT: 'success', EXIT_CODE: '0', EXIT_STATUS: '0/SUCCESS' };

    const { status } = runAdapter(scriptPath, root, env);

    expect(status).toBe(0);
    expect(existsSync(join(home, 'trigger.jsonl'))).toBe(false);
  });

  it('artifact exit 1 (crash), env set, sink writable -> adapter exit 0; exactly one reporter-failure record, reason "crash" and no home_refused, quoted lifecycle values, parses under the shared grammar', () => {
    const { scriptPath } = buildTree(STUB_CRASH);
    const home = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    const env = { ...baseEnv(home), INVOCATION_ID: 'inv-2', SERVICE_RESULT: 'exit-code', EXIT_CODE: '3', EXIT_STATUS: '3' };

    const { status } = runAdapter(scriptPath, root, env);

    expect(status).toBe(0);
    const lines = sinkLines(home);
    expect(lines).toHaveLength(1);
    const record = parseTriggerRecord(lines[0]!);
    expect(record.kind).toBe('reporter-failure');
    if (record.kind !== 'reporter-failure') throw new Error('unreachable');
    expect(record.reason).toBe('crash');
    expect(record.home_refused).toBeUndefined();
    expect(record.run).toBe('inv-2');
    expect(record.service_result).toBe('exit-code');
    expect(record.exit_code).toBe('3');
    expect(record.exit_status).toBe('3');
  });

  it('artifact hangs after a partial stdout write, lifecycle env UNSET -> adapter exit 0; reason "timeout"; lifecycle fields are JSON null; run falls back to p<pid>-<epoch>; sink holds ONLY the reporter-failure record', () => {
    const { scriptPath } = buildTree(STUB_HANG);
    const home = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    const env = baseEnv(home); // no INVOCATION_ID / SERVICE_RESULT / EXIT_CODE / EXIT_STATUS

    const { status } = runAdapter(scriptPath, root, env);

    expect(status).toBe(0);
    const lines = sinkLines(home);
    expect(lines).toHaveLength(1); // the stub never writes the sink -- this is the adapter's ONE record
    const record = parseTriggerRecord(lines[0]!);
    expect(record.kind).toBe('reporter-failure');
    if (record.kind !== 'reporter-failure') throw new Error('unreachable');
    expect(record.reason).toBe('timeout');
    expect(record.service_result).toBeNull();
    expect(record.exit_code).toBeNull();
    expect(record.exit_status).toBeNull();
    expect(record.run).toMatch(/^p[0-9]+-[0-9]+$/);
  }, 10_000);

  it('artifact exit 1, sink path occupied by a DIRECTORY (unwritable) -> adapter exit 0; stdout still carries the reporter-failure line (the journald-only trace)', () => {
    const { scriptPath } = buildTree(STUB_CRASH);
    const home = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
    mkdirSync(join(home, 'trigger.jsonl')); // occupies the sink path -- not a regular file, so the adapter skips the append (sink_file_usable)
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    const env = { ...baseEnv(home), INVOCATION_ID: 'inv-4' };

    const { status, stdout } = runAdapter(scriptPath, root, env);

    expect(status).toBe(0);
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1); // STUB_CRASH writes nothing to stdout -- only the adapter's echo
    const record = parseTriggerRecord(lines[0]!);
    expect(record.kind).toBe('reporter-failure');
    if (record.kind !== 'reporter-failure') throw new Error('unreachable');
    expect(record.reason).toBe('crash');
  });

  it('launch-failure: node unreachable on PATH -> adapter exit 0; reason "launch-failure"', () => {
    const { scriptPath } = buildTreeMissingArtifact();
    const home = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    const env = { ...baseEnv(home), PATH: pathWithoutNode(), INVOCATION_ID: 'inv-5' };
    // The constructed PATH must really hide node, or the cell below proves nothing.
    expect(spawnSync('node', ['--version'], { env }).error).toMatchObject({ code: 'ENOENT' });

    const { status, stderr } = runAdapter(scriptPath, root, env);

    expect(status).toBe(0);
    // The 127 must come from `timeout` failing to exec node, not from bash failing to find `timeout`
    // (bash's own "command not found" is also 127 and would map to the same reason). Only the line
    // prefix is asserted: GNU coreutils says "failed to run command", uutils (Ubuntu 26.04) says
    // "failed to execute process".
    expect(stderr).toMatch(/^timeout: /m);
    expect(stderr).not.toMatch(/command not found/);
    const lines = sinkLines(home);
    expect(lines).toHaveLength(1);
    const record = parseTriggerRecord(lines[0]!);
    expect(record.kind).toBe('reporter-failure');
    if (record.kind !== 'reporter-failure') throw new Error('unreachable');
    expect(record.reason).toBe('launch-failure');
  });

  it('no positional argument at all (missing dogfood-root) -> adapter exit 0; the artifact degrades via its own usage-error path; exactly one reporter-failure record, reason "crash"', () => {
    const { scriptPath } = buildTree(STUB_USAGE_ON_EMPTY_ROOT);
    const home = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
    const env = { ...baseEnv(home), INVOCATION_ID: 'inv-noroot', SERVICE_RESULT: 'success', EXIT_CODE: '0', EXIT_STATUS: '0/SUCCESS' };

    // No root argument at all -- `$1` is entirely unset in the adapter, exercising the `${1:-}` fix.
    const res = spawnSync('bash', [scriptPath], { env, cwd: OUTSIDE_CWD, encoding: 'utf8', timeout: 10_000 });

    expect(res.status).toBe(0);
    const lines = sinkLines(home);
    expect(lines).toHaveLength(1);
    const record = parseTriggerRecord(lines[0]!);
    expect(record.kind).toBe('reporter-failure');
    if (record.kind !== 'reporter-failure') throw new Error('unreachable');
    expect(record.reason).toBe('crash');
  });

  it("SIGPIPE on the final stdout echo does not kill the adapter -- trap '' PIPE holds, PIPESTATUS[0] is 0", () => {
    const { scriptPath } = buildTree(STUB_SLOW_CRASH);
    const home = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    // `head -c 0` wants zero bytes and exits almost immediately, closing the pipe's read end long
    // before the stub's 300ms sleep elapses -- by the time the adapter's trailing `printf` writes its
    // reporter-failure line to stdout, the reader is guaranteed gone. PIPESTATUS[0] is the ADAPTER's
    // own exit status (the left side of the pipe), not head's. Without the `trap '' PIPE` fix, bash's
    // default SIGPIPE disposition kills the script outright and this would be 141 (128+SIGPIPE) --
    // verified separately against the pre-fix script.
    const env: NodeJS.ProcessEnv = { ...baseEnv(home), INVOCATION_ID: 'inv-sigpipe', script: scriptPath, root };

    const res = spawnSync('bash', ['-c', '"$script" "$root" | head -c 0; printf %s "${PIPESTATUS[0]}"'], {
      env,
      cwd: OUTSIDE_CWD,
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(res.stdout).toBe('0'); // the expected stderr noise ("printf: write error: Broken pipe") is not asserted -- status only
  });
});

describe('ISSUES.md auto-file on run-level failure (issue-tracking decision 2026-07-20)', () => {
  it('service failure (a TERM while the host is running) + ISSUES.md present -> one OPEN high-severity auto-filed entry with the next sequential id', () => {
    const { scriptPath } = buildTree(STUB_OK); // reporter succeeds — auto-file keys on SERVICE_RESULT, not artifact status
    const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-root-'));
    writeFileSync(join(root, 'ISSUES.md'), '# Issues\n\n## ISSUE-0003 — 2026-07-20 — CLOSED — severity: low\n- symptom: old\n');
    const env = withSystemctl({ ...baseEnv(home), INVOCATION_ID: 'inv-if1', SERVICE_RESULT: 'signal', EXIT_CODE: 'killed', EXIT_STATUS: 'TERM' }, 'running');
    const res = runAdapter(scriptPath, root, env);
    expect(res.status).toBe(0);
    const issues = readFileSync(join(root, 'ISSUES.md'), 'utf8');
    expect(issues).toMatch(/## ISSUE-0004 — \d{4}-\d{2}-\d{2} — OPEN — severity: high/);
    expect(issues).toContain('auto-filed by postrun adapter');
    expect(issues).toContain('service_result=signal');
    expect(issues).toContain('exit_status=TERM');
    expect(issues).toContain('inv-if1');
  });
  it('service success -> ISSUES.md byte-untouched', () => {
    const { scriptPath } = buildTree(STUB_OK);
    const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-root-'));
    const before = '# Issues\n\n(no issues yet)\n';
    writeFileSync(join(root, 'ISSUES.md'), before);
    const env = { ...baseEnv(home), INVOCATION_ID: 'inv-if2', SERVICE_RESULT: 'success', EXIT_CODE: '0', EXIT_STATUS: '0' };
    runAdapter(scriptPath, root, env);
    expect(readFileSync(join(root, 'ISSUES.md'), 'utf8')).toBe(before);
  });
  it('ISSUES.md absent -> nothing created, adapter still exit 0', () => {
    const { scriptPath } = buildTree(STUB_OK);
    const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-root-'));
    const env = withSystemctl({ ...baseEnv(home), INVOCATION_ID: 'inv-if3', SERVICE_RESULT: 'signal', EXIT_CODE: 'killed', EXIT_STATUS: 'KILL' }, 'running');
    const res = runAdapter(scriptPath, root, env);
    expect(res.status).toBe(0);
    expect(existsSync(join(root, 'ISSUES.md'))).toBe(false);
  });
  it('zero-padded high id (0008) increments decimally to 0009 — locks the 10# octal guard', () => {
    const { scriptPath } = buildTree(STUB_OK);
    const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-root-'));
    writeFileSync(join(root, 'ISSUES.md'), '# Issues\n\n## ISSUE-0008 \u2014 2026-07-20 \u2014 CLOSED \u2014 severity: low\n- symptom: old\n');
    const env = withSystemctl({ ...baseEnv(home), INVOCATION_ID: 'inv-if5', SERVICE_RESULT: 'signal', EXIT_CODE: 'killed', EXIT_STATUS: 'TERM' }, 'running');
    const res = runAdapter(scriptPath, root, env);
    expect(res.status).toBe(0);
    const issues = readFileSync(join(root, 'ISSUES.md'), 'utf8');
    expect(issues).toMatch(/## ISSUE-0009 \u2014/u); // without 10#, bash arithmetic rejects "0008" (octal) and the id silently renders 0000
    expect(issues).not.toContain('ISSUE-0000');
  });
  it('run failure + reporter crash together -> BOTH the issue entry and the reporter-failure sink record; exit 0', () => {
    const { scriptPath } = buildTree(STUB_CRASH);
    const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-root-'));
    writeFileSync(join(root, 'ISSUES.md'), '# Issues\n');
    const env = { ...baseEnv(home), INVOCATION_ID: 'inv-if4', SERVICE_RESULT: 'exit-code', EXIT_CODE: '1', EXIT_STATUS: '1' };
    const res = runAdapter(scriptPath, root, env);
    expect(res.status).toBe(0);
    expect(readFileSync(join(root, 'ISSUES.md'), 'utf8')).toMatch(/## ISSUE-0001 .* OPEN .* high/);
    const lines = sinkLines(home);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('reporter-failure');
  });
});

describe('reporter-failure records and the home rule (B2a ruling F, plan decisions P1 and P2)', () => {
  it('artifact exit 3 (helix-trigger refused the home) -> adapter exit 0; one record, reason "crash" plus home_refused true, parses under the shared grammar, and the stdout line is that record', () => {
    const { scriptPath } = buildTree(STUB_REFUSED);
    const home = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    const env = { ...baseEnv(home), INVOCATION_ID: 'inv-r1', SERVICE_RESULT: 'exit-code', EXIT_CODE: '1', EXIT_STATUS: '1' };

    const { status, stdout } = runAdapter(scriptPath, root, env);

    expect(status).toBe(0);
    const lines = sinkLines(home);
    expect(lines).toHaveLength(1);
    const record = parseTriggerRecord(lines[0]!);
    expect(record.kind).toBe('reporter-failure');
    if (record.kind !== 'reporter-failure') throw new Error('unreachable');
    expect(record.reason).toBe('crash'); // the sink's three reasons are unchanged (plan decision P1)
    expect(record.home_refused).toBe(true);
    expect(lines[0]!.endsWith('"reason":"crash","home_refused":true}')).toBe(true);
    expect(stdout.trim()).toBe(lines[0]);
  });

  /** A real directory, and a symlink to it inside a second directory. */
  function symlinkedHome(): { target: string; link: string } {
    const target = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
    const link = join(mkdtempSync(join(tmpdir(), 'helix-postrun-link-')), 'home-link');
    symlinkSync(target, link);
    return { target, link };
  }

  it.each([['crash, exit 1', STUB_CRASH], ['home refusal, exit 3', STUB_REFUSED]] as const)(
    'artifact %s and HELIX_HOME is a symlink -> adapter exit 0; nothing is written through the link; the record still reaches stdout',
    (_label, stub) => {
      const { scriptPath } = buildTree(stub);
      const { target, link } = symlinkedHome();
      const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
      const env = { ...baseEnv(link), INVOCATION_ID: 'inv-l1' };

      const { status, stdout } = runAdapter(scriptPath, root, env);

      expect(status).toBe(0);
      expect(readdirSync(target)).toEqual([]);
      expect(reporterLines(stdout)).toHaveLength(1);
      expect(parseTriggerRecord(reporterLines(stdout)[0]!).kind).toBe('reporter-failure');
    },
  );

  it('HELIX_HOME is a symlink written with a trailing slash -> nothing is written through it either (the slash would make a plain look follow the link)', () => {
    const { scriptPath } = buildTree(STUB_CRASH);
    const { target, link } = symlinkedHome();
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    const env = { ...baseEnv(`${link}/`), INVOCATION_ID: 'inv-l2' };

    const { status, stdout } = runAdapter(scriptPath, root, env);

    expect(status).toBe(0);
    expect(readdirSync(target)).toEqual([]);
    expect(reporterLines(stdout)).toHaveLength(1);
  });

  // Plan review of 2026-11-08 (owner): the adapter cuts a trailing "/." as resolveHelixPaths does, so the look sees the link.
  it('HELIX_HOME is a symlink written as "<link>/." -> nothing is written through it either (the "/." is cut before the look, as A2 cuts it)', () => {
    const { scriptPath } = buildTree(STUB_CRASH);
    const { target, link } = symlinkedHome();
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    const env = { ...baseEnv(`${link}/.`), INVOCATION_ID: 'inv-l3' };

    const { status, stdout } = runAdapter(scriptPath, root, env);

    expect(status).toBe(0);
    expect(readdirSync(target)).toEqual([]);
    expect(reporterLines(stdout)).toHaveLength(1);
  });

  it('a FIFO named trigger.jsonl inside a real home -> adapter exit 0; the FIFO is neither read nor appended to and stays; the record still reaches stdout', () => {
    const { scriptPath } = buildTree(STUB_CRASH);
    const home = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
    const sink = join(home, 'trigger.jsonl');
    execFileSync('mkfifo', [sink]);
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    const env = { ...baseEnv(home), INVOCATION_ID: 'inv-f1' };

    const { status, stdout } = runAdapter(scriptPath, root, env);
    // A grep or an append that an unguarded script left blocked on the FIFO is released here, so no process outlives the case.
    try { closeSync(openSync(sink, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)); } catch { /* no reader: ENXIO */ }
    try { closeSync(openSync(sink, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)); } catch { /* nothing to release */ }

    expect(status).toBe(0);
    expect(lstatSync(sink).isFIFO()).toBe(true);
    expect(reporterLines(stdout)).toHaveLength(1);
  }, 20_000);

  it.each([['to a regular file outside the home', true], ['that dangles', false]] as const)(
    'trigger.jsonl inside a real home is a symlink %s -> nothing is read or written through it; the record still reaches stdout',
    (_label, targetExists) => {
      const { scriptPath } = buildTree(STUB_CRASH);
      const home = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
      const target = join(mkdtempSync(join(tmpdir(), 'helix-postrun-out-')), 'elsewhere.jsonl');
      const fired = evalLine('2026-11-01T09:00:00.000Z', 'fired', 'r1') + '\n';
      if (targetExists) writeFileSync(target, fired);
      symlinkSync(target, join(home, 'trigger.jsonl'));
      const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
      const env = { ...baseEnv(home), INVOCATION_ID: 'inv-sl' };

      const { status, stdout } = runAdapter(scriptPath, root, env);

      expect(status).toBe(0);
      if (targetExists) expect(readFileSync(target, 'utf8')).toBe(fired);
      else expect(existsSync(target)).toBe(false);
      expect(stdout).not.toContain('Trigger-1 has fired since'); // the fired-history summary did not read through the link
      expect(reporterLines(stdout)).toHaveLength(1);
    },
  );

  it.each([['one missing level', ['absent']], ['a missing chain', ['a', 'b']]] as const)(
    'HELIX_HOME names %s -> nothing is created; the record still reaches stdout',
    (_label, parts) => {
      const { scriptPath } = buildTree(STUB_CRASH);
      const parent = mkdtempSync(join(tmpdir(), 'helix-postrun-parent-'));
      const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
      const env = { ...baseEnv(join(parent, ...parts)), INVOCATION_ID: 'inv-m1' };

      const { status, stdout } = runAdapter(scriptPath, root, env);

      expect(status).toBe(0);
      expect(readdirSync(parent)).toEqual([]);
      expect(reporterLines(stdout)).toHaveLength(1);
    },
  );

  it.each(['rel-home', '.'])('HELIX_HOME is the relative path "%s" -> nothing is written below the working directory; the record still reaches stdout', (value) => {
    const { scriptPath } = buildTree(STUB_REFUSED);
    const cwd = mkdtempSync(join(tmpdir(), 'helix-postrun-cwd-'));
    mkdirSync(join(cwd, 'rel-home'));
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    const env = { ...baseEnv(value), INVOCATION_ID: 'inv-rel' };

    const { status, stdout } = runAdapter(scriptPath, root, env, cwd);

    expect(status).toBe(0);
    expect(readdirSync(cwd)).toEqual(['rel-home']);
    expect(readdirSync(join(cwd, 'rel-home'))).toEqual([]);
    expect(reporterLines(stdout)).toHaveLength(1);
  });

  /** The dogfood unit's own shape: no HELIX_HOME, HOME holds `.helix`. The environment is built from nothing,
   *  so no HELIX_* variable of the developer's shell reaches the run. */
  const unitEnv = (fakeHome: string, helixHome?: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: fakeHome, HELIX_POSTRUN_TIMEOUT: '1', HELIX_POSTRUN_KILL_AFTER: '1', INVOCATION_ID: 'inv-u1' };
    if (helixHome !== undefined) env.HELIX_HOME = helixHome;
    return env;
  };

  it.each([['unset', undefined], ['empty', '']] as const)('HELIX_HOME %s and the HOME/.helix directory exists (the dogfood unit shape) -> the record lands in it', (_label, value) => {
    const { scriptPath } = buildTree(STUB_CRASH);
    const fakeHome = mkdtempSync(join(tmpdir(), 'helix-postrun-uhome-'));
    mkdirSync(join(fakeHome, '.helix'), { mode: 0o700 });
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));

    const { status } = runAdapter(scriptPath, root, unitEnv(fakeHome, value));

    expect(status).toBe(0);
    expect(sinkLines(join(fakeHome, '.helix'))).toHaveLength(1);
  });

  it('HELIX_HOME unset and HOME/.helix does not exist -> nothing is created; the record still reaches stdout', () => {
    const { scriptPath } = buildTree(STUB_CRASH);
    const fakeHome = mkdtempSync(join(tmpdir(), 'helix-postrun-uhome-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));

    const { status, stdout } = runAdapter(scriptPath, root, unitEnv(fakeHome));

    expect(status).toBe(0);
    expect(readdirSync(fakeHome)).toEqual([]);
    expect(reporterLines(stdout)).toHaveLength(1);
  });

  it('HELIX_HOME is "<link>/../name" -> the record lands where the kernel goes (the home the server resolves), not at the collapsed text', () => {
    const { scriptPath } = buildTree(STUB_CRASH);
    const base = mkdtempSync(join(tmpdir(), 'helix-postrun-dd-'));
    mkdirSync(join(base, 'x', 'y'), { recursive: true });
    mkdirSync(join(base, 'x', 'h'));
    mkdirSync(join(base, 'h'));
    symlinkSync(join(base, 'x', 'y'), join(base, 'lnk')); // lnk/.. is base/x, so lnk/../h is base/x/h; the text collapses to base/h
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    const env = { ...baseEnv(`${base}/lnk/../h`), INVOCATION_ID: 'inv-dd' }; // concatenation: path.join would fold the ".." as text

    const { status } = runAdapter(scriptPath, root, env);

    expect(status).toBe(0);
    expect(existsSync(join(base, 'x', 'h', 'trigger.jsonl'))).toBe(true);
    expect(existsSync(join(base, 'h', 'trigger.jsonl'))).toBe(false);
  });
});

describe('a usage-limit stop and a host shutdown file no issue (B2a ruling H, decision N2)', () => {
  const ISSUES_BEFORE = '# Issues\n\n## ISSUE-0003 — 2026-07-20 — CLOSED — severity: low\n- symptom: old\n';
  function setup(stub: string): { scriptPath: string; home: string; root: string } {
    const { scriptPath } = buildTree(stub);
    const home = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    writeFileSync(join(root, 'ISSUES.md'), ISSUES_BEFORE);
    return { scriptPath, home, root };
  }
  const issues = (root: string): string => readFileSync(join(root, 'ISSUES.md'), 'utf8');
  const failed = (home: string, id: string): NodeJS.ProcessEnv =>
    withSystemctl({ ...baseEnv(home), INVOCATION_ID: id, SERVICE_RESULT: 'exit-code', EXIT_CODE: '1', EXIT_STATUS: '1' }, 'running');

  it.each(['session', 'weekly'])('the newest run log opens with the %s limit message -> ISSUES.md is byte-untouched and stdout (journald) carries only the usage-limit line', (kind) => {
    const { scriptPath, home, root } = setup(STUB_OK);
    writeRunLog(root, '2026-11-08T09-00-00.log', limitLine(kind));

    const { status, stdout } = runAdapter(scriptPath, root, failed(home, 'inv-lim'));

    expect(status).toBe(0);
    expect(issues(root)).toBe(ISSUES_BEFORE);
    expect(stdout.split('\n').filter((l) => l.length > 0)).toEqual([NOTE_USAGE_LIMIT]);
  });

  it('a limit stop with a crashing reporter -> still no issue, and the reporter-failure record is still written', () => {
    const { scriptPath, home, root } = setup(STUB_CRASH);
    writeRunLog(root, '2026-11-08T09-00-00.log', limitLine('session'));

    const { status, stdout } = runAdapter(scriptPath, root, failed(home, 'inv-lim2'));

    expect(status).toBe(0);
    expect(issues(root)).toBe(ISSUES_BEFORE);
    expect(stdout).toContain(NOTE_USAGE_LIMIT);
    expect(sinkLines(home)).toHaveLength(1);
  });

  it('the limit message is in a log older than ten minutes (the run died before writing one) -> the failure is filed as OPEN high, with no usage-limit line', () => {
    const { scriptPath, home, root } = setup(STUB_OK);
    writeRunLog(root, '2026-11-07T09-00-00.log', limitLine('session'), 7200);

    const { stdout } = runAdapter(scriptPath, root, failed(home, 'inv-stale'));

    expect(issues(root)).toMatch(/## ISSUE-0004 — \d{4}-\d{2}-\d{2} — OPEN — severity: high/u);
    expect(stdout).not.toContain(NOTE_USAGE_LIMIT);
  });

  it('the limit message is not the log\'s first line (an agent quoting it) -> filed as OPEN high', () => {
    const { scriptPath, home, root } = setup(STUB_OK);
    writeRunLog(root, '2026-11-08T09-00-00.log', `Working on the roadmap item.\nA test failed.\n${limitLine('session')}`);

    const { stdout } = runAdapter(scriptPath, root, failed(home, 'inv-quote'));

    expect(issues(root)).toMatch(/## ISSUE-0004 /);
    expect(stdout).not.toContain(NOTE_USAGE_LIMIT);
  });

  it('an older log holds the limit message but the newest log does not -> filed as OPEN high', () => {
    const { scriptPath, home, root } = setup(STUB_OK);
    writeRunLog(root, '2026-11-07T09-00-00.log', limitLine('weekly'), 120);
    writeRunLog(root, '2026-11-08T09-00-00.log', 'Session complete.\n', 30);

    const { stdout } = runAdapter(scriptPath, root, failed(home, 'inv-old'));

    expect(issues(root)).toMatch(/## ISSUE-0004 /);
    expect(stdout).not.toContain(NOTE_USAGE_LIMIT);
  });

  it('the newest log by mtime is a retry log (-attempt2, which sorts BEFORE the first log by name) and it opens with the limit message -> no issue', () => {
    const { scriptPath, home, root } = setup(STUB_OK);
    writeRunLog(root, '2026-11-08T09-00-00.log', 'transient failure, retrying in 180s\n', 400);
    writeRunLog(root, '2026-11-08T09-00-00-attempt2.log', limitLine('session'), 20);

    const { stdout } = runAdapter(scriptPath, root, failed(home, 'inv-retry'));

    expect(issues(root)).toBe(ISSUES_BEFORE);
    expect(stdout).toContain(NOTE_USAGE_LIMIT);
  });

  it.each([['the system manager', 'stopping', 'running'], ['the user manager', 'running', 'stopping']] as const)(
    'the unit ended by a signal while %s reports "stopping" -> ISSUES.md is byte-untouched and stdout carries the host-shutdown line',
    (_label, system, user) => {
      const { scriptPath, home, root } = setup(STUB_OK);
      const env = withSystemctl({ ...baseEnv(home), INVOCATION_ID: 'inv-down', SERVICE_RESULT: 'signal', EXIT_CODE: 'killed', EXIT_STATUS: 'TERM' }, system, user);

      const { status, stdout } = runAdapter(scriptPath, root, env);

      expect(status).toBe(0);
      expect(issues(root)).toBe(ISSUES_BEFORE);
      expect(stdout.split('\n').filter((l) => l.length > 0)).toEqual([NOTE_HOST_SHUTDOWN]);
    },
  );

  it('the system reports "stopping" but the unit failed with an exit code, not a signal -> filed as OPEN high (only a signal can be a shutdown)', () => {
    const { scriptPath, home, root } = setup(STUB_OK);
    const env = withSystemctl({ ...baseEnv(home), INVOCATION_ID: 'inv-code', SERVICE_RESULT: 'exit-code', EXIT_CODE: '1', EXIT_STATUS: '1' }, 'stopping');

    const { stdout } = runAdapter(scriptPath, root, env);

    expect(issues(root)).toMatch(/## ISSUE-0004 /);
    expect(stdout).not.toContain(NOTE_HOST_SHUTDOWN);
  });
});

describe('Trigger-1 fired-history summary (Task 12 derived reporter)', () => {
  it('sink whose LAST evaluation is not-fired but has earlier fired rows -> stdout still names the first fired ts and the fired count', () => {
    const { scriptPath } = buildTree(STUB_OK);
    const home = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    const fixtureLines = [
      evalLine('2026-08-26T13:18:49.278Z', 'fired', 'r1'),
      evalLine('2026-08-27T09:00:00.000Z', 'fired', 'r2'),
      evalLine('2026-09-05T09:00:00.000Z', 'not-fired', 'r3'), // LAST evaluation is not-fired
    ];
    writeFileSync(join(home, 'trigger.jsonl'), fixtureLines.join('\n') + '\n');
    const env = { ...baseEnv(home), INVOCATION_ID: 'inv-fired-history', SERVICE_RESULT: 'success', EXIT_CODE: '0', EXIT_STATUS: '0/SUCCESS' };

    const { status, stdout } = runAdapter(scriptPath, root, env);

    expect(status).toBe(0);
    // first-fired ts is the earliest fired row (r1); count is over the last 14 evaluation lines seen
    // (only 3 exist here, 2 of them fired) -- the LAST evaluation being not-fired must not suppress it.
    expect(stdout).toContain('Trigger-1 has fired since 2026-08-26T13:18:49.278Z; 2 of the last 3 evaluations fired.');
  });

  it('a sink with MORE than 14 evaluations reports the count over the last 14 and names 14 as the window', () => {
    const { scriptPath } = buildTree(STUB_OK);
    const home = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    // 15 rows: 1-10 fired, 11-15 not-fired. The last 14 are rows 2-15, of which rows 2-10 fired (9).
    const fixtureLines: string[] = [];
    for (let i = 1; i <= 15; i++) {
      const day = String(i).padStart(2, '0');
      fixtureLines.push(evalLine(`2026-08-${day}T09:00:00.000Z`, i <= 10 ? 'fired' : 'not-fired', `r${i}`));
    }
    writeFileSync(join(home, 'trigger.jsonl'), fixtureLines.join('\n') + '\n');
    const env = { ...baseEnv(home), INVOCATION_ID: 'inv-fired-window', SERVICE_RESULT: 'success', EXIT_CODE: '0', EXIT_STATUS: '0/SUCCESS' };

    const { status, stdout } = runAdapter(scriptPath, root, env);

    expect(status).toBe(0);
    expect(stdout).toContain('Trigger-1 has fired since 2026-08-01T09:00:00.000Z; 9 of the last 14 evaluations fired.');
  });

  it('an acknowledged fire -> the adapter logs the acknowledged line (item 7)', () => {
    const { scriptPath } = buildTree(STUB_OK);
    const home = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-postrun-root-'));
    const off = { min: 1, max: 1, threshold: 2500, status: 'false' as const };
    const legs = { rows: off, bytes: { ...off, threshold: 4194304 }, latency: { min: 5, max: 5, threshold: 3, status: 'true' as const } };
    const ack = JSON.stringify({ v: 1, policy: 'T1-2026-07-11', kind: 'acknowledgement', ts: '2026-09-23T12:00:00.000Z', evaluationTs: '2026-09-23T08:30:18.147Z', legs });
    writeFileSync(join(home, 'trigger.jsonl'), [evalLine('2026-09-23T08:30:18.147Z', 'fired', 'r1'), ack].join('\n') + '\n');
    const env = { ...baseEnv(home), INVOCATION_ID: 'inv-ack', SERVICE_RESULT: 'success', EXIT_CODE: '0', EXIT_STATUS: '0/SUCCESS' };
    const { status, stdout } = runAdapter(scriptPath, root, env);
    expect(status).toBe(0);
    expect(stdout).toContain('Acknowledged 2026-09-23T12:00:00.000Z: no new slow recall or size crossing since.');
  });
});
