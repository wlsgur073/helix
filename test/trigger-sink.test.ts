// B2a task C1 (ruling F; STATUS TRIGGER-SINK, IT-LOW 11, IT-LOW 16 trigger half): helix-trigger's sink follows the home rule
// (ensureHelixDir, never a recursive mkdir; the sink opened O_NOFOLLOW | O_NONBLOCK and required to be a regular file; a separator
// in front of a record when the last byte is not a newline) and its reads ask what a file is (readLedgerFileBytes) instead of
// stalling on a FIFO or reading a device as an empty ledger. Expected text comes from the owners of the texts (A5's head, A8's
// message), never from a literal here.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync, chmodSync, readdirSync, realpathSync, rmSync, existsSync,
} from 'node:fs';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/trigger-cli.js';
import {
  appendToSink, measureAndRecord, acknowledgeLatest, validateRecordLine, type EvaluationRecord, type MeasureInput,
} from '../scripts/trigger-measure.js';
import type { Leg } from '../scripts/trigger-eval.js';
import { realFsOps, type DurableFsOps } from '../src/memory/fs-ops.js';
import { isHomeRefusalError } from '../src/memory/home-env.js';
import { NotRegularHomeFileError, isNotRegularHomeFileError } from '../src/memory/home-files.js';
import { readLedgerFileBytes, isLedgerNotRegularError } from '../src/memory/ledger.js';
import { bundleCli } from './helpers/bundle-cli.js';

const posix = process.platform !== 'win32';
const NOT_REGULAR = new NotRegularHomeFileError().message;

interface World { base: string; home: string; proj: string; cwd: string; userHome: string }
const made: string[] = [];
function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tsk-')));
  made.push(base);
  const w: World = { base, home: join(base, 'h'), proj: join(base, 'p'), cwd: join(base, 'cwd'), userHome: join(base, 'uh') };
  mkdirSync(w.home);
  chmodSync(w.home, 0o700);
  for (const d of [w.proj, w.cwd, w.userHome]) mkdirSync(d);   // proj has no .helix: the project reads 'absent'
  return w;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sink = (w: World): string => join(w.home, 'trigger.jsonl');
const input = (w: World): MeasureInput => ({ root: w.proj, run: 'r1', serviceResult: null, exitCode: null, exitStatus: null });
const EVAL = (w: World): string[] => ['--root', w.proj, '--run', 'r1'];
const mode = (p: string): number => lstatSync(p).mode & 0o777;
function thrown(f: () => unknown): unknown { try { f(); } catch (e) { return e; } return undefined; }
function mkfifo(p: string): void {
  execFileSync('mkfifo', [p]);
  expect(lstatSync(p).isFIFO()).toBe(true);                    // precondition: the fixture is what the case says it is
}
/** A home that is a symlink to a real 0700 directory: the link is what HELIX_HOME names. */
function linkedHome(w: World): { link: string; target: string } {
  const target = join(w.base, 'real');
  mkdirSync(target);
  chmodSync(target, 0o700);
  const link = join(w.base, 'lnk');
  symlinkSync(target, link);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);         // precondition
  return { link, target };
}

const LEG: Leg = { min: 78, max: 78, threshold: 2500, status: 'false' };
function evalLine(ts: string, overall: EvaluationRecord['overall']): string {
  const r: EvaluationRecord = {
    v: 1, policy: 'T1-2026-07-11', kind: 'evaluation', ts, run: 'r',
    service_result: null, exit_code: null, exit_status: null,
    legs: { rows: LEG, bytes: { ...LEG, threshold: 4194304 }, latency: { min: 5, max: 5, threshold: 3, status: 'true' } },
    latencyN: 83, overall, project: 'absent', metricsState: 'present', unknownLines: 0, unknownMaxOps: 0,
  };
  return JSON.stringify(r);
}

function quiet(): { out: () => string } {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { out += c.toString(); return true; });
  return { out: () => out };
}
function runMain(argv: string[], env: NodeJS.ProcessEnv): { code: number; out: string; err: string } {
  let out = ''; let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { out += c.toString(); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { err += c.toString(); return true; });
  const code = main(argv, { env, exit: () => {} });
  return { code, out, err };
}

// ---- the sink follows the home rule --------------------------------------------------------------------------------------
describe('appendToSink: the home goes through ensureHelixDir', () => {
  it.skipIf(!posix)('a symlinked home is a home refusal and nothing is written through the link', () => {
    const w = world();
    const { link, target } = linkedHome(w);
    const err = thrown(() => appendToSink(link, '{"a":1}'));
    expect(isHomeRefusalError(err)).toBe(true);
    expect((err as { homeRefusalCause: string }).homeRefusalCause).toBe('symlinked-home');
    expect(readdirSync(target)).toEqual([]);
  });

  it('a home whose parent is missing is a home refusal and the chain is not created', () => {
    const w = world();
    const err = thrown(() => appendToSink(join(w.base, 'x', 'y'), '{"a":1}'));
    expect(isHomeRefusalError(err)).toBe(true);
    expect((err as { homeRefusalCause: string }).homeRefusalCause).toBe('parent-missing');
    expect(existsSync(join(w.base, 'x'))).toBe(false);
  });

  it('a home that is a regular file is a home refusal and the file is left as it was', () => {
    const w = world();
    const f = join(w.base, 'afile');
    writeFileSync(f, 'keep');
    const err = thrown(() => appendToSink(f, '{"a":1}'));
    expect(isHomeRefusalError(err)).toBe(true);
    expect((err as { homeRefusalCause: string }).homeRefusalCause).toBe('not-a-directory');
    expect(readFileSync(f, 'utf8')).toBe('keep');
  });

  it.skipIf(!posix)('control (task A6): an existing group-readable home keeps its mode and takes the line', () => {
    const w = world();
    chmodSync(w.home, 0o755);
    expect(mode(w.home)).toBe(0o755);                           // precondition
    appendToSink(w.home, '{"a":1}');
    expect(mode(w.home)).toBe(0o755);
    expect(readFileSync(sink(w), 'utf8')).toBe('{"a":1}\n');
  });
});

// ---- the sink is a regular file -------------------------------------------------------------------------------------------
describe('appendToSink: what stands at the sink name', () => {
  it('a directory at the sink name is refused as a non-regular file', () => {
    const w = world();
    mkdirSync(sink(w));
    const err = thrown(() => appendToSink(w.home, '{"a":1}'));
    expect(isNotRegularHomeFileError(err)).toBe(true);
    expect((err as Error).message).toBe(NOT_REGULAR);
  });

  it.skipIf(!posix)('a symlink at the sink name is refused and the file it leads to keeps its bytes and its mode', () => {
    const w = world();
    const outside = join(w.base, 'out.jsonl');
    writeFileSync(outside, 'keep\n');
    chmodSync(outside, 0o644);
    symlinkSync(outside, sink(w));
    const err = thrown(() => appendToSink(w.home, '{"a":1}'));
    expect(isNotRegularHomeFileError(err)).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('keep\n');
    expect(mode(outside)).toBe(0o644);
  });

  it.skipIf(!posix)('a dangling symlink at the sink name is refused and its target is not created', () => {
    const w = world();
    const outside = join(w.base, 'never.jsonl');
    symlinkSync(outside, sink(w));
    const err = thrown(() => appendToSink(w.home, '{"a":1}'));
    expect(isNotRegularHomeFileError(err)).toBe(true);
    expect(existsSync(outside)).toBe(false);
  });
});

// ---- IT-LOW 11: a torn tail -----------------------------------------------------------------------------------------------
describe('appendToSink: a sink that ends without a newline (IT-LOW 11)', () => {
  /** Runs one append over a sink holding `before` and returns the bytes of every writeSync call and the final file. */
  function appendOver(before: string): { writes: string[]; after: string } {
    const w = world();
    writeFileSync(sink(w), before);
    const writes: string[] = [];
    const wrapped: DurableFsOps = {
      ...realFsOps,
      writeSync: (fd, b, o, l) => { writes.push(b.subarray(o, o + l).toString('utf8')); return realFsOps.writeSync(fd, b, o, l); },
    };
    appendToSink(w.home, '{"b":2}', wrapped);
    return { writes, after: readFileSync(sink(w), 'utf8') };
  }

  it('the separator and the record share one write', () => {
    const r = appendOver('AAA');
    expect(r.after).toBe('AAA\n{"b":2}\n');
    expect(r.writes).toEqual(['\n{"b":2}\n']);
  });
  it('control: a newline-terminated sink gets no separator', () => {
    const r = appendOver('AAA\n');
    expect(r.after).toBe('AAA\n{"b":2}\n');
    expect(r.writes).toEqual(['{"b":2}\n']);
  });
  it('control: an empty sink gets no separator', () => {
    const r = appendOver('');
    expect(r.after).toBe('{"b":2}\n');
    expect(r.writes).toEqual(['{"b":2}\n']);
  });

  it('measureAndRecord after a torn evaluation: the new record is its own last line and the fragment is kept as it was', () => {
    const w = world();
    const full = evalLine('2026-11-01T00:00:00.000Z', 'not-fired');
    const frag = full.slice(0, 150);
    writeFileSync(sink(w), `${full}\n${frag}`);
    quiet();
    measureAndRecord(input(w), { env: { HELIX_HOME: w.home } });
    const lines = readFileSync(sink(w), 'utf8').split('\n');
    expect(lines).toHaveLength(4);                              // full, fragment, new record, the empty piece after the final newline
    expect(lines[1]).toBe(frag);
    expect(() => validateRecordLine(lines[2]!)).not.toThrow();
    expect(lines[3]).toBe('');
  });

  it('--acknowledge over a torn tail writes the acknowledgement as its own line', () => {
    const w = world();
    writeFileSync(sink(w), `${evalLine('2026-11-01T00:00:00.000Z', 'fired')}\n{"v":1,"pol`);
    const r = acknowledgeLatest({ env: { HELIX_HOME: w.home }, now: () => '2026-11-02T00:00:00.000Z' });
    expect(r.ok).toBe(true);
    const lines = readFileSync(sink(w), 'utf8').split('\n');
    expect(lines[1]).toBe('{"v":1,"pol');
    expect(JSON.parse(lines[2]!).kind).toBe('acknowledgement');
    expect(lines[3]).toBe('');
  });

  it('a torn evaluation followed by a new evaluation no longer blocks --acknowledge (the glued line used to)', () => {
    const w = world();
    const torn = evalLine('2026-11-01T01:00:00.000Z', 'fired').slice(0, 150);
    writeFileSync(sink(w), `${evalLine('2026-11-01T00:00:00.000Z', 'fired')}\n${torn}`);
    quiet();
    measureAndRecord(input(w), { env: { HELIX_HOME: w.home } });
    const r = acknowledgeLatest({ env: { HELIX_HOME: w.home }, now: () => '2026-11-02T00:00:00.000Z' });
    expect(r.ok).toBe(true);
  });
});

// ---- reads ask what a file is ---------------------------------------------------------------------------------------------
describe('readLedgerFileBytes is importable and keeps its ENOENT convention', () => {
  it('reads a regular file, answers ENOENT for a missing one and refuses a directory', () => {
    const w = world();
    const f = join(w.base, 'f.jsonl');
    writeFileSync(f, 'ab\n');
    expect(readLedgerFileBytes(f).toString('utf8')).toBe('ab\n');
    expect((thrown(() => readLedgerFileBytes(join(w.base, 'none'))) as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(isLedgerNotRegularError(thrown(() => readLedgerFileBytes(w.home)))).toBe(true);
  });
});

describe('measureAndRecord: a participant that is not a regular file is a read error', () => {
  it.skipIf(!posix)('HELIX_LEDGER=/dev/null is unavailable, where it used to count as a ledger of zero rows', () => {
    const w = world();
    expect(lstatSync('/dev/null').isCharacterDevice()).toBe(true);   // precondition
    const q = quiet();
    measureAndRecord(input(w), { env: { HELIX_HOME: w.home, HELIX_LEDGER: '/dev/null' } });
    const rec = validateRecordLine(q.out().trim());
    expect(rec.legs.rows.status).toBe('unavailable');
    expect(rec.legs.bytes.status).toBe('unavailable');
  });

  it('control: an absent global ledger and an absent metrics file keep their clean states', () => {
    const w = world();
    const q = quiet();
    measureAndRecord(input(w), { env: { HELIX_HOME: w.home } });
    const rec = validateRecordLine(q.out().trim());
    expect(rec.legs.rows.status).toBe('false');                 // zero rows read, not unavailable
    expect(rec.metricsState).toBe('absent');
  });

  it.skipIf(!posix)('control: a global ledger that is a symlink to a regular file is read through the link', () => {
    const w = world();
    const real = join(w.base, 'real.jsonl');
    writeFileSync(real, 'g1\ng2\ng3\n');
    symlinkSync(real, join(w.home, 'memory.jsonl'));
    const q = quiet();
    measureAndRecord(input(w), { env: { HELIX_HOME: w.home } });
    expect(validateRecordLine(q.out().trim()).legs.rows.min).toBe(3);
  });
});

// ---- exit codes through main ----------------------------------------------------------------------------------------------
describe('main: a home refusal exits 3, a non-regular sink exits 1', () => {
  it.skipIf(!posix)('--acknowledge over a fired sink behind a symlinked home: exit 3, the target keeps its bytes', () => {
    const w = world();
    const { link, target } = linkedHome(w);
    const fired = `${evalLine('2026-11-01T00:00:00.000Z', 'fired')}\n`;
    writeFileSync(join(target, 'trigger.jsonl'), fired);
    const r = runMain(['--acknowledge'], { HELIX_HOME: link });
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/^trigger-cli: REFUSING - .*symlink.*\n$/);
    expect(r.out).toBe('');
    expect(readFileSync(join(target, 'trigger.jsonl'), 'utf8')).toBe(fired);
  });

  it('an evaluation with a missing parent: exit 3, nothing printed, the chain is not created', () => {
    const w = world();
    const r = runMain(EVAL(w), { HELIX_HOME: join(w.base, 'x', 'y') });
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/^trigger-cli: REFUSING - .*does not exist.*\n$/);
    expect(r.out).toBe('');
    expect(existsSync(join(w.base, 'x'))).toBe(false);
  });

  it('an evaluation with a directory at the sink name: exit 1, the constant line of the non-regular refusal, nothing printed', () => {
    const w = world();
    mkdirSync(sink(w));
    const r = runMain(EVAL(w), { HELIX_HOME: w.home });
    expect(r.code).toBe(1);
    expect(r.err).toBe(`trigger-cli: ${NOT_REGULAR}\n`);
    expect(r.out).toBe('');
  });
});

// ---- the shipped shape: the CLI built from source and spawned ------------------------------------------------------------
describe.skipIf(!posix)('helix-trigger built from source (scripts/trigger-cli.ts), spawned with cwd outside the repository', () => {
  let bin: string;
  beforeAll(async () => { bin = await bundleCli('scripts/trigger-cli.ts'); }, 60_000);

  function childEnv(w: World, extra: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('HELIX_')) delete env[k];
    return { ...env, HOME: w.userHome, ...extra };
  }
  /** `umask0` runs the CLI under umask 0, so a directory created at the umask's mode shows 0777 and not an accident of the runner. */
  function spawnTrigger(w: World, argv: string[], extra: Record<string, string>, umask0 = false): SpawnSyncReturns<string> {
    const cmd = umask0 ? '/bin/sh' : process.execPath;
    const args = umask0 ? ['-c', 'umask 0; exec "$0" "$@"', process.execPath, bin, ...argv] : [bin, ...argv];
    return spawnSync(cmd, args, { cwd: w.cwd, env: childEnv(w, extra), encoding: 'utf8', timeout: 10_000 });
  }

  it('a FIFO at the sink: exit 1 within the deadline, the constant line, nothing printed', () => {
    const w = world();
    mkfifo(sink(w));
    const res = spawnTrigger(w, EVAL(w), { HELIX_HOME: w.home });
    expect(res.error).toBeUndefined();                          // the base is blocked in open(2) until the deadline: ETIMEDOUT
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe(`trigger-cli: ${NOT_REGULAR}\n`);
  }, 30_000);

  it('a FIFO as the global ledger: exit 0 within the deadline and the ledger legs are unavailable', () => {
    const w = world();
    mkfifo(join(w.home, 'memory.jsonl'));
    const res = spawnTrigger(w, EVAL(w), { HELIX_HOME: w.home });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    const rec = validateRecordLine(res.stdout.trim());
    expect(rec.legs.rows.status).toBe('unavailable');
    expect(rec.legs.bytes.status).toBe('unavailable');
  }, 30_000);

  it('a FIFO as metrics.jsonl: exit 0 within the deadline and metricsState is read-error', () => {
    const w = world();
    mkfifo(join(w.home, 'metrics.jsonl'));
    const res = spawnTrigger(w, EVAL(w), { HELIX_HOME: w.home });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(validateRecordLine(res.stdout.trim()).metricsState).toBe('read-error');
  }, 30_000);

  it('--acknowledge over a FIFO sink: exit 2 within the deadline, the existing no-sink refusal, nothing appended', () => {
    const w = world();
    mkfifo(sink(w));
    const res = spawnTrigger(w, ['--acknowledge'], { HELIX_HOME: w.home });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('trigger-cli: no trigger sink to acknowledge\n');
  }, 30_000);

  it('a symlinked home: process exit status 3, the REFUSING line, nothing written into the target', () => {
    const w = world();
    const { link, target } = linkedHome(w);
    const res = spawnTrigger(w, EVAL(w), { HELIX_HOME: link });
    expect(res.status).toBe(3);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^trigger-cli: REFUSING - .*symlink.*\n$/);
    expect(readdirSync(target)).toEqual([]);
  }, 30_000);

  it('a missing home whose parent exists is created 0700 under umask 0, and the sink 0600 (IT-LOW 16, trigger half)', () => {
    const w = world();
    const home = join(w.base, 'nh');
    const res = spawnTrigger(w, EVAL(w), { HELIX_HOME: home }, true);
    expect(res.status).toBe(0);
    expect(mode(home)).toBe(0o700);                             // the base: 0777 & ~0 = 0777
    expect(mode(join(home, 'trigger.jsonl'))).toBe(0o600);
  }, 30_000);

  it('an unset HELIX_HOME creates ~/.helix 0700 under umask 0 when only $HOME exists', () => {
    const w = world();
    const res = spawnTrigger(w, EVAL(w), {}, true);
    expect(res.status).toBe(0);
    expect(mode(join(w.userHome, '.helix'))).toBe(0o700);
  }, 30_000);

  it('control (Review Focus 1): the dogfood unit shape, no HELIX_* at all, an existing 0700 ~/.helix, cwd the tinytask directory', () => {
    const w = world();
    const home = join(w.userHome, '.helix');
    mkdirSync(home);
    chmodSync(home, 0o700);
    const res = spawnTrigger(w, ['--root', w.cwd, '--run', 'r1'], {});
    expect(res.status).toBe(0);
    expect(readFileSync(join(home, 'trigger.jsonl'), 'utf8')).toBe(res.stdout);
    expect(mode(join(home, 'trigger.jsonl'))).toBe(0o600);
    expect(readdirSync(w.cwd)).toEqual([]);                     // nothing lands in the working directory
  }, 30_000);
});
