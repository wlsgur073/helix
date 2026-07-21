// Spawn tests for the systemd ExecStopPost adapter (Phase 2 Track 2a, Task A4 -- see
// docs/superpowers/plans/2026-07-17-phase2-trigger-governance-and-disclosure.md). systemd invokes
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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync, accessSync, constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTriggerRecord } from './helpers/trigger-record.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_SCRIPT = join(repoRoot, 'scripts', 'dogfood-postrun.sh');

const STUB_OK = `process.exit(0);\n`;
const STUB_CRASH = `process.exit(3);\n`;
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
// Stays alive ~300ms (well past the adapter's own scripted work) then exits 3 -- gives a SIGPIPE
// reader time to close the pipe long before the adapter's final stdout echo, making that cell's
// failure window deterministic instead of a race.
const STUB_SLOW_CRASH = `setTimeout(() => process.exit(3), 300);\n`;

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

/** PATH with every directory containing an executable literally named `node` removed. Used only for
 *  the launch-failure cell, so the adapter's `timeout -k ... node ...` fails to exec `node` (exit
 *  126/127) while `bash`/`timeout`/coreutils remain fully resolvable. IMPORTANT: this test's own
 *  spawnSync('bash', ...) call below resolves the `bash` executable using THIS SAME env.PATH -- Node
 *  resolves a bare command name against the env passed to the child, not the test runner's own
 *  process.env -- so stripping too much here would fail the spawnSync call itself (an ENOENT at the
 *  Node layer) rather than exercising the intended in-script failure. */
function pathWithoutNode(): string {
  const dirs = (process.env.PATH ?? '').split(':').filter((d) => d.length > 0);
  const kept = dirs.filter((d) => {
    try {
      accessSync(join(d, 'node'), fsConstants.X_OK);
      return false;
    } catch {
      return true;
    }
  });
  return kept.join(':');
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

function runAdapter(scriptPath: string, root: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('bash', [scriptPath, root], { env, encoding: 'utf8', timeout: 10_000 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const sinkLines = (home: string): string[] => readFileSync(join(home, 'trigger.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0);

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

  it('artifact exit 3 (crash), env set, sink writable -> adapter exit 0; exactly one reporter-failure record, reason "crash", quoted lifecycle values, parses under the shared grammar', () => {
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

  it('artifact exit 3, sink path occupied by a DIRECTORY (unwritable) -> adapter exit 0; stdout still carries the reporter-failure line (the journald-only trace)', () => {
    const { scriptPath } = buildTree(STUB_CRASH);
    const home = mkdtempSync(join(tmpdir(), 'helix-postrun-home-'));
    mkdirSync(join(home, 'trigger.jsonl')); // occupies the sink path -- the append can only fail (EISDIR)
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

    const { status } = runAdapter(scriptPath, root, env);

    expect(status).toBe(0);
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
    const res = spawnSync('bash', [scriptPath], { env, encoding: 'utf8', timeout: 10_000 });

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
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(res.stdout).toBe('0'); // the expected stderr noise ("printf: write error: Broken pipe") is not asserted -- status only
  });
});

describe('ISSUES.md auto-file on run-level failure (issue-tracking decision 2026-07-20)', () => {
  it('service failure + ISSUES.md present -> one OPEN high-severity auto-filed entry with the next sequential id', () => {
    const { scriptPath } = buildTree(STUB_OK); // reporter succeeds — auto-file keys on SERVICE_RESULT, not artifact status
    const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-root-'));
    writeFileSync(join(root, 'ISSUES.md'), '# Issues\n\n## ISSUE-0003 — 2026-07-20 — CLOSED — severity: low\n- symptom: old\n');
    const env = { ...baseEnv(home), INVOCATION_ID: 'inv-if1', SERVICE_RESULT: 'signal', EXIT_CODE: 'killed', EXIT_STATUS: 'TERM' };
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
    const env = { ...baseEnv(home), INVOCATION_ID: 'inv-if3', SERVICE_RESULT: 'signal', EXIT_CODE: 'killed', EXIT_STATUS: 'KILL' };
    const res = runAdapter(scriptPath, root, env);
    expect(res.status).toBe(0);
    expect(existsSync(join(root, 'ISSUES.md'))).toBe(false);
  });
  it('zero-padded high id (0008) increments decimally to 0009 — locks the 10# octal guard', () => {
    const { scriptPath } = buildTree(STUB_OK);
    const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-root-'));
    writeFileSync(join(root, 'ISSUES.md'), '# Issues\n\n## ISSUE-0008 \u2014 2026-07-20 \u2014 CLOSED \u2014 severity: low\n- symptom: old\n');
    const env = { ...baseEnv(home), INVOCATION_ID: 'inv-if5', SERVICE_RESULT: 'signal', EXIT_CODE: 'killed', EXIT_STATUS: 'TERM' };
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
