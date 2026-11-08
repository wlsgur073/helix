// Third fix batch B2a, task B5 (design 4.7, ruling G): when the global half of the SessionStart hook's read throws, a session that
// continues an earlier one (resume, compact, fork) still gets the constant supersede note, once; a fresh session stays silent; a
// closed stdout never turns the hook's exit status into a failure. The hook is bundled FROM SOURCE and spawned as plain node with
// its cwd outside the repository (the home-entry.test.ts discipline), never from the committed bin/.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundleCli } from '../helpers/bundle-cli.js';
import { SUPERSEDE_NOTE, SYMLINKED_HOME_NOTE } from '../../src/memory/content-frame.js';
import { HOME_REFUSED_START_NOTE } from '../../src/hooks/session-record.js';

const posixOnly = describe.skipIf(process.platform === 'win32');

let START = '';
beforeAll(async () => { START = await bundleCli('src/hooks/session-start.ts'); }, 120_000);

/** One case's directories: `u` stands in for $HOME, `w` is the hook's working directory (outside the repository), `h` is the home. */
interface Fx { base: string; userHome: string; work: string; home: string }
const bases: string[] = [];
function fixture(): Fx {
  const base = mkdtempSync(join(tmpdir(), 'sf-'));
  bases.push(base);
  const fx = { base, userHome: join(base, 'u'), work: join(base, 'w'), home: join(base, 'h') };
  mkdirSync(fx.userHome);
  mkdirSync(fx.work);
  mkdirSync(fx.home, { mode: 0o700 });
  return fx;
}
afterEach(() => { for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true }); });

const TS = '2026-11-08T00:00:00.000Z';
function seed(dir: string, id: string, content: string): void {
  writeFileSync(join(dir, 'memory.jsonl'), JSON.stringify({
    id, tx: TS, validFrom: TS, validTo: null, type: 'assert', state: 'Fresh', content,
    provenance: { source: 'user', sessionId: 'seed' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  }) + '\n');
}

/** The three ways the global half of the gather throws that the tests use. Each asserts its own precondition. */
function directoryLedger(dir: string): void {
  mkdirSync(join(dir, 'memory.jsonl'));
  expect(lstatSync(join(dir, 'memory.jsonl')).isDirectory()).toBe(true);
}
function fifoLedger(dir: string): void {
  execFileSync('mkfifo', [join(dir, 'memory.jsonl')]);
  expect(lstatSync(join(dir, 'memory.jsonl')).isFIFO()).toBe(true);
}
function shortKey(dir: string): void {   // a 31-byte key: the read throws "corrupt master key", it is not a ledger read at all
  writeFileSync(join(dir, 'ledger-mac-master.key'), Buffer.alloc(31, 7), { mode: 0o600 });
  expect(lstatSync(join(dir, 'ledger-mac-master.key')).size).toBe(31);
}

const strippedEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_'))) as Record<string, string>;

interface Ran { code: number | null; stdout: string; stderr: string }
interface RunOpts { closeStdout?: boolean; preload?: string }
/** Spawn the hook. A hook that blocks (a FIFO read that waits for a writer) fails the case at 10 s instead of hanging the run. */
function runHook(fx: Fx, helix: Record<string, string>, stdin: unknown, opts: RunOpts = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const args = opts.preload === undefined ? [START] : ['--import', pathToFileURL(opts.preload).href, START];
    const child = spawn(process.execPath, args, { cwd: fx.work, env: { ...strippedEnv(), HOME: fx.userHome, ...helix } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the hook did not exit within 10 s')); }, 10_000);
    if (opts.closeStdout === true) child.stdout.destroy();   // the parent's read end is gone before the hook writes: every writeSync(1, ...) fails with EPIPE
    else child.stdout.on('data', (d: Buffer) => { stdout += String(d); });
    child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
    child.stdin.on('error', () => undefined);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(JSON.stringify(stdin));
  });
}

/** A real cwd in the stdin, as the host sends it: the stand-in for $HOME, so no project layer is looked up above it (first-batch.e2e.test.ts passes the same). */
const stdinOf = (fx: Fx, source?: string): Record<string, unknown> =>
  ({ cwd: fx.userHome, hook_event_name: 'SessionStart', ...(source === undefined ? {} : { source }) });

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

/** A preload that makes the hook's block write fail AFTER its bytes were delivered: it runs the real write, then throws.
 *  The stderr line proves the injected failure happened (a case that never saw it would pass vacuously). */
const PRELOAD_MARK = 'preload: the block write threw after delivering its bytes\n';
function throwAfterBlockWrite(fx: Fx): string {
  const file = join(fx.base, 'throw-after-block.mjs');
  writeFileSync(file, [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const real = fs.writeSync;',
    'fs.writeSync = function (fd, data, ...rest) {',
    '  const n = real.call(this, fd, data, ...rest);',
    "  if (fd === 1 && typeof data === 'string' && data.includes('DATA[')) {",
    `    real.call(this, 2, ${JSON.stringify(PRELOAD_MARK)});`,
    "    throw new Error('the write failed after the bytes were delivered');",
    '  }',
    '  return n;',
    '};',
    'syncBuiltinESMExports();',
  ].join('\n'));
  return file;
}

describe('a failed global read still gives a continued session the supersede note (ruling G)', () => {
  it.each(['resume', 'compact', 'fork'])('a directory as the global ledger: %s prints the note alone', async (source) => {
    const fx = fixture();
    directoryLedger(fx.home);
    const r = await runHook(fx, { HELIX_HOME: fx.home }, stdinOf(fx, source));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${SUPERSEDE_NOTE}\n`);
    expect(r.stderr).toBe('');
  }, 30_000);

  it.each(['startup', 'clear', undefined])('a directory as the global ledger: a fresh session (source %s) prints nothing', async (source) => {
    const fx = fixture();
    directoryLedger(fx.home);
    const r = await runHook(fx, { HELIX_HOME: fx.home }, stdinOf(fx, source));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  }, 30_000);

  posixOnly('POSIX only', () => {
    it.each(['resume', 'compact', 'fork'])('a FIFO as the global ledger: %s prints the note alone, without waiting for a writer', async (source) => {
      const fx = fixture();
      fifoLedger(fx.home);
      const r = await runHook(fx, { HELIX_HOME: fx.home }, stdinOf(fx, source));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`${SUPERSEDE_NOTE}\n`);
      expect(r.stderr).toBe('');
    }, 30_000);

    it('a FIFO as the global ledger: a startup prints nothing', async () => {
      const fx = fixture();
      fifoLedger(fx.home);
      const r = await runHook(fx, { HELIX_HOME: fx.home }, stdinOf(fx, 'startup'));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    }, 30_000);

    it('a master key of the wrong length (a throw that is not a ledger read): a resume prints the note alone', async () => {
      const fx = fixture();
      shortKey(fx.home);
      const r = await runHook(fx, { HELIX_HOME: fx.home }, stdinOf(fx, 'resume'));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`${SUPERSEDE_NOTE}\n`);
    }, 30_000);

    it('a symlinked home whose ledger is a directory: the notes printed before the read stay, and the supersede note follows them', async () => {
      const fx = fixture();
      const link = join(fx.base, 'l');
      symlinkSync(fx.home, link);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);        // precondition: the FINAL component is the link
      directoryLedger(fx.home);
      const r = await runHook(fx, { HELIX_HOME: link }, stdinOf(fx, 'resume'));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`${SYMLINKED_HOME_NOTE}\n${SUPERSEDE_NOTE}\n`);
    }, 30_000);

    it('a throw after the block reached stdout does not add a second note', async () => {
      const fx = fixture();
      seed(fx.home, 'm_seed', 'seeded fact');
      const r = await runHook(fx, { HELIX_HOME: fx.home }, stdinOf(fx, 'resume'), { preload: throwAfterBlockWrite(fx) });
      expect(r.stderr).toBe(PRELOAD_MARK);                        // the injected failure happened
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('DATA[Fresh:global]| seeded fact');
      expect(countOf(r.stdout, SUPERSEDE_NOTE)).toBe(1);          // the block's own trailer, and no second copy from the catch
    }, 30_000);

    it.each<[string, (fx: Fx) => void]>([
      ['the failed read itself (directory ledger)', (fx) => directoryLedger(fx.home)],
      ['the block write (seeded ledger)', (fx) => seed(fx.home, 'm_seed', 'seeded fact')],
    ])('a closed stdout never fails the hook: %s', async (_name, arrange) => {
      const fx = fixture();
      arrange(fx);
      const r = await runHook(fx, { HELIX_HOME: fx.home }, stdinOf(fx, 'resume'), { closeStdout: true });
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');                                  // no stack from a write that the catch itself attempted
    }, 30_000);
  });
});

describe('controls: the paths B5 must leave as they are', () => {
  it('an ordinary seeded ledger: a resume prints the block and the note once, a startup prints the block without it', async () => {
    const fx = fixture();
    seed(fx.home, 'm_seed', 'seeded fact');
    const resumed = await runHook(fx, { HELIX_HOME: fx.home }, stdinOf(fx, 'resume'));
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain('DATA[Fresh:global]| seeded fact');
    expect(countOf(resumed.stdout, SUPERSEDE_NOTE)).toBe(1);
    const fresh = await runHook(fx, { HELIX_HOME: fx.home }, stdinOf(fx, 'startup'));
    expect(fresh.stdout).toContain('DATA[Fresh:global]| seeded fact');
    expect(countOf(fresh.stdout, SUPERSEDE_NOTE)).toBe(0);
  }, 30_000);

  it('a pristine ordinary home: a resume prints nothing (issue #7); the failed-read path differs on purpose, it cannot know', async () => {
    const fx = fixture();
    const r = await runHook(fx, { HELIX_HOME: fx.home }, stdinOf(fx, 'resume'));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  }, 30_000);

  it('a refused environment (task A4): the refusal note alone, even for a resume, and never the supersede note', async () => {
    const fx = fixture();
    const r = await runHook(fx, { HELIX_HOME: '.' }, stdinOf(fx, 'resume'));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${HOME_REFUSED_START_NOTE}\n`);
  }, 30_000);
});
