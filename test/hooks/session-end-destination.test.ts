// Third fix batch B2a, task B2 (ruling N1, J5; design 4.7): the SessionEnd hook, built from source and spawned as plain node
// (the file-modes.test.ts discipline), refuses a HELIX_SESSIONS that is a control file of the home, the global ledger or a
// project's ledger (plan review of 2026-11-08), and prints one constant stderr line for every record it cannot keep. Never
// the committed bin/ (task D1 repeats the matrix over it).
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync, lstatSync, statSync,
  readdirSync, realpathSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleCli } from '../helpers/bundle-cli.js';
import { fixture as projectFixture, cleanupFixtures as cleanupProjectFixtures, rowsIn } from '../helpers/first-write-fixture.js';
import { HOME_CONTROL_NAMES } from '../../src/memory/home-files.js';
import { HOME_REFUSED_END_NOTE, SESSION_RECORD_DROPPED_NOTE } from '../../src/hooks/session-record.js';

const posixOnly = describe.skipIf(process.platform === 'win32');

let END = '';
beforeAll(async () => { END = await bundleCli('src/hooks/session-end.ts'); }, 120_000);

const NINE = [
  'audit.jsonl', 'metrics.jsonl', 'trigger.jsonl', 'codex-log.jsonl', 'witness.json', 'witness-log.jsonl',
  'projects.json', 'ledger-mac-master.key', 'config.json',
];
const LOCKS = ['witness.json.lock', 'ledger-mac-master.key.lock'];
const REFUSED = [...new Set([...NINE, ...LOCKS, ...HOME_CONTROL_NAMES])].filter((n) => n !== 'sessions.jsonl');

/** `userHome` stands in for $HOME, `work` is the hook's cwd, `home` an ordinary 0700 HELIX_HOME, `out` a 0755 folder outside it. */
interface Fx { base: string; userHome: string; work: string; home: string; out: string }
const bases: string[] = [];
function fixture(): Fx {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sd-')));
  bases.push(base);
  const mk = (n: string, mode: number): string => { const p = join(base, n); mkdirSync(p); chmodSync(p, mode); return p; };   // umask-proof
  return { base, userHome: mk('u', 0o755), work: mk('w', 0o755), home: mk('h', 0o700), out: mk('o', 0o755) };
}
afterEach(() => { for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true }); });

/** Every name under `dir` with its mode and, for a regular file, its sha256 (lstat only: a FIFO is never opened). */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    out.push(`${rel === '' ? '.' : rel} ${(lstatSync(d).mode & 0o7777).toString(8)}`);
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const r = rel === '' ? n : `${rel}/${n}`;
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p, r);
      else out.push(`${r} ${(st.mode & 0o7777).toString(8)} ${st.isFile() ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'not-a-file'}`);
    }
  };
  walk(dir, '');
  return out;
}
const modeOf = (p: string): number => statSync(p).mode & 0o777;
const recordsOf = (file: string): Array<Record<string, unknown>> =>
  readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

const strippedEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_'))) as Record<string, string>;

interface Ran { code: number | null; stdout: string; stderr: string }
const END_STDIN = JSON.stringify({ session_id: 's-b2', reason: 'clear' });
function runEnd(fx: Fx, helix: Record<string, string>, stdin: string = END_STDIN): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [END], { cwd: fx.work, env: { ...strippedEnv(), HOME: fx.userHome, ...helix } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the hook did not exit within 20 s')); }, 20_000);
    child.stdout.on('data', (d: Buffer) => { stdout += String(d); });
    child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
    child.stdin.on('error', () => undefined);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}
/** A dropped record: exit 0, nothing on stdout, exactly the one constant line on stderr (so no path in it). */
function expectDropped(r: Ran): void {
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('');
  expect(r.stderr).toBe(`${SESSION_RECORD_DROPPED_NOTE}\n`);
}
function expectSilent(r: Ran): void {
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('');
  expect(r.stderr).toBe('');
}
const SEED = '{"seed":"control"}\n';

describe('the dropped-record line', () => {
  it('is one ASCII line with no path, no interpolation marker and no leading instruction', () => {
    expect(SESSION_RECORD_DROPPED_NOTE).toMatch(/^helix: NOTE - [\x20-\x7e]+$/);
    expect(SESSION_RECORD_DROPPED_NOTE).not.toMatch(/[\\/]|\$\{/);
  });
});

posixOnly('SessionEnd refuses a control file of the home as HELIX_SESSIONS (ruling N1)', () => {
  describe.each(REFUSED)('HELIX_SESSIONS=<home>/%s', (name) => {
    it('present: refused, one dropped line, the file and every other byte of the tree unchanged', async () => {
      const fx = fixture();
      writeFileSync(join(fx.home, name), SEED, { mode: 0o600 });
      const before = snapshot(fx.base);
      const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_SESSIONS: join(fx.home, name) });
      expectDropped(r);
      expect(readFileSync(join(fx.home, name), 'utf8')).toBe(SEED);
      expect(snapshot(fx.base)).toEqual(before);
    }, 30_000);

    it('absent: refused, one dropped line, nothing is created in its place', async () => {
      const fx = fixture();
      const before = snapshot(fx.base);
      const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_SESSIONS: join(fx.home, name) });
      expectDropped(r);
      expect(existsSync(join(fx.home, name))).toBe(false);
      expect(snapshot(fx.base)).toEqual(before);
    }, 30_000);
  });

  it('a link outside the home to <home>/projects.json is refused, the registry unchanged', async () => {
    const fx = fixture();
    writeFileSync(join(fx.home, 'projects.json'), SEED, { mode: 0o600 });
    symlinkSync(join(fx.home, 'projects.json'), join(fx.out, 's.jsonl'));
    const before = snapshot(fx.base);
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_SESSIONS: join(fx.out, 's.jsonl') });
    expectDropped(r);
    expect(snapshot(fx.base)).toEqual(before);
  }, 30_000);

  it('<link>/../name names the control file the kernel reaches, not the folded name', async () => {
    const fx = fixture();
    const home = join(fx.base, 'y', 'h');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(join(fx.base, 'y', 'z'));
    symlinkSync(join(fx.base, 'y', 'z'), join(fx.base, 'lnk'));
    writeFileSync(join(home, 'witness.json'), SEED, { mode: 0o600 });
    const before = snapshot(fx.base);
    const sessionsFile = `${fx.base}/lnk/../h/witness.json`;   // concatenation: join() would fold the ".." as text
    const r = await runEnd(fx, { HELIX_HOME: home, HELIX_SESSIONS: sessionsFile });
    expectDropped(r);
    expect(snapshot(fx.base)).toEqual(before);
    expect(readFileSync(join(home, 'witness.json'), 'utf8')).toBe(SEED);
  }, 30_000);
});

posixOnly('SessionEnd refuses the global ledger as HELIX_SESSIONS (ruling N1)', () => {
  it.each([true, false])('the default ledger <home>/memory.jsonl (file present: %s)', async (present) => {
    const fx = fixture();
    if (present) writeFileSync(join(fx.home, 'memory.jsonl'), SEED, { mode: 0o600 });
    const before = snapshot(fx.base);
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_SESSIONS: join(fx.home, 'memory.jsonl') });
    expectDropped(r);
    expect(snapshot(fx.base)).toEqual(before);
  }, 30_000);

  it('a ledger relocated outside the home with HELIX_LEDGER, named as HELIX_SESSIONS', async () => {
    const fx = fixture();
    const led = join(fx.out, 'led.jsonl');
    writeFileSync(led, SEED, { mode: 0o600 });
    const before = snapshot(fx.base);
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_LEDGER: led, HELIX_SESSIONS: led });
    expectDropped(r);
    expect(snapshot(fx.base)).toEqual(before);
  }, 30_000);

  it('HELIX_LEDGER=<home>/sessions.jsonl makes the default sessions file the ledger: refused', async () => {
    const fx = fixture();
    writeFileSync(join(fx.home, 'sessions.jsonl'), SEED, { mode: 0o600 });
    const before = snapshot(fx.base);
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_LEDGER: join(fx.home, 'sessions.jsonl') });
    expectDropped(r);
    expect(snapshot(fx.base)).toEqual(before);
  }, 30_000);

  it('HELIX_SESSIONS=<home>/memory.jsonl while HELIX_LEDGER relocates the ledger: refused all the same (disposition item 7)', async () => {
    const fx = fixture();
    const led = join(fx.out, 'led.jsonl');
    writeFileSync(led, SEED, { mode: 0o600 });
    writeFileSync(join(fx.home, 'memory.jsonl'), SEED, { mode: 0o600 });
    const before = snapshot(fx.base);
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_LEDGER: led, HELIX_SESSIONS: join(fx.home, 'memory.jsonl') });
    expectDropped(r);
    expect(snapshot(fx.base)).toEqual(before);
  }, 30_000);
});

posixOnly("SessionEnd refuses a project's ledger as HELIX_SESSIONS (plan review of 2026-11-08, rule M)", () => {
  afterEach(() => { cleanupProjectFixtures(); });

  it("a real project's ledger <root>/.helix/memory.jsonl (owned, one row written through the store): refused, one dropped line, its bytes unchanged", async () => {
    const p = projectFixture();
    p.store('b2').commit({ content: 'a project fact', source: 'user' });       // the first commit makes the project owned
    expect(rowsIn(p.ledger), 'fixture: the project ledger holds the one row').toEqual(['a project fact']);
    const bytes = readFileSync(p.ledger);
    const before = snapshot(p.base);
    const fx = fixture();                                                        // the hook's cwd and HOME only
    const r = await runEnd(fx, { HELIX_HOME: p.home, HELIX_SESSIONS: p.ledger });
    expectDropped(r);
    expect(readFileSync(p.ledger).equals(bytes)).toBe(true);
    expect(snapshot(p.base)).toEqual(before);
  }, 30_000);

  it('control: HELIX_SESSIONS=<out>/memory.jsonl, outside any .helix folder, is an ordinary sessions file: created 0600 with one record', async () => {
    const fx = fixture();
    const file = join(fx.out, 'memory.jsonl');
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_SESSIONS: file });
    expectSilent(r);
    expect(recordsOf(file)).toEqual([expect.objectContaining({ kind: 'session-end', sessionId: 's-b2', reason: 'clear' })]);
    expect(modeOf(file)).toBe(0o600);
    expect(modeOf(fx.out)).toBe(0o755);
  }, 30_000);
});

posixOnly('SessionEnd still writes where it may (outline Review Focus 5, ruling A)', () => {
  it('the default destination: <home>/sessions.jsonl is created 0600 with one record and no output', async () => {
    const fx = fixture();
    const r = await runEnd(fx, { HELIX_HOME: fx.home });
    expectSilent(r);
    const file = join(fx.home, 'sessions.jsonl');
    expect(recordsOf(file)).toEqual([expect.objectContaining({ kind: 'session-end', sessionId: 's-b2', reason: 'clear' })]);
    expect(modeOf(file)).toBe(0o600);
  }, 30_000);

  it('a new file in a 0755 shared folder is created 0600 and the folder keeps 0755; the home is not touched', async () => {
    const fx = fixture();
    const file = join(fx.out, 's.jsonl');
    const homeBefore = snapshot(fx.home);
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_SESSIONS: file });
    expectSilent(r);
    expect(recordsOf(file)).toHaveLength(1);
    expect(modeOf(file)).toBe(0o600);
    expect(modeOf(fx.out)).toBe(0o755);
    expect(snapshot(fx.home)).toEqual(homeBefore);
  }, 30_000);

  it('a ledger relocated outside the home does not stop the default sessions file, and the ledger is untouched', async () => {
    const fx = fixture();
    const led = join(fx.out, 'led.jsonl');
    writeFileSync(led, SEED, { mode: 0o600 });
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_LEDGER: led });
    expectSilent(r);
    expect(recordsOf(join(fx.home, 'sessions.jsonl'))).toHaveLength(1);
    expect(readFileSync(led, 'utf8')).toBe(SEED);
  }, 30_000);

  it('a last folder that does not exist yet is created 0700 (the one directory Helix makes), the file 0600, the parent 0755', async () => {
    const fx = fixture();
    const file = join(fx.out, 'newdir', 's.jsonl');
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_SESSIONS: file });
    expectSilent(r);
    expect(recordsOf(file)).toHaveLength(1);
    expect(modeOf(join(fx.out, 'newdir'))).toBe(0o700);
    expect(modeOf(file)).toBe(0o600);
    expect(modeOf(fx.out)).toBe(0o755);
  }, 30_000);

  it('a home that does not exist yet (its parent does) is created 0700 with the record 0600', async () => {
    const fx = fixture();
    const newHome = join(fx.base, 'nh');
    const r = await runEnd(fx, { HELIX_HOME: newHome });
    expectSilent(r);
    expect(modeOf(newHome)).toBe(0o700);
    expect(modeOf(join(newHome, 'sessions.jsonl'))).toBe(0o600);
    expect(recordsOf(join(newHome, 'sessions.jsonl'))).toHaveLength(1);
  }, 30_000);
});

posixOnly('SessionEnd prints the one line for every other record it cannot keep (J5)', () => {
  it('a FIFO at HELIX_SESSIONS: exit inside the deadline, the line, the FIFO stays', async () => {
    const fx = fixture();
    const fifo = join(fx.out, 's.jsonl');
    execFileSync('mkfifo', [fifo]);
    const before = snapshot(fx.base);
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_SESSIONS: fifo });
    expectDropped(r);
    expect(lstatSync(fifo).isFIFO()).toBe(true);
    expect(snapshot(fx.base)).toEqual(before);
  }, 30_000);

  it('a directory at HELIX_SESSIONS', async () => {
    const fx = fixture();
    mkdirSync(join(fx.out, 's.jsonl'));
    const before = snapshot(fx.base);
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_SESSIONS: join(fx.out, 's.jsonl') });
    expectDropped(r);
    expect(snapshot(fx.base)).toEqual(before);
  }, 30_000);

  it.skipIf(process.getuid?.() === 0)('a file the user cannot write (0400)', async () => {
    const fx = fixture();
    const file = join(fx.out, 's.jsonl');
    writeFileSync(file, SEED, { mode: 0o400 });
    const before = snapshot(fx.base);
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_SESSIONS: file });
    expectDropped(r);
    expect(snapshot(fx.base)).toEqual(before);
  }, 30_000);

  it('a symlinked home: nothing is written into the target, the line is printed', async () => {
    const fx = fixture();
    const target = join(fx.base, 't');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(fx.base, 'l'));
    const r = await runEnd(fx, { HELIX_HOME: join(fx.base, 'l') });
    expectDropped(r);
    expect(readdirSync(target)).toEqual([]);
  }, 30_000);

  it('a destination that is a link loop', async () => {
    const fx = fixture();
    symlinkSync(join(fx.out, 'b'), join(fx.out, 'a'));
    symlinkSync(join(fx.out, 'a'), join(fx.out, 'b'));
    const before = snapshot(fx.base);
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_SESSIONS: join(fx.out, 'a') });
    expectDropped(r);
    expect(snapshot(fx.base)).toEqual(before);
  }, 30_000);

  it('a folder chain that does not exist: Helix makes one directory, never a chain', async () => {
    const fx = fixture();
    const before = snapshot(fx.base);
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_SESSIONS: join(fx.out, 'a', 'b', 's.jsonl') });
    expectDropped(r);
    expect(existsSync(join(fx.out, 'a'))).toBe(false);
    expect(snapshot(fx.base)).toEqual(before);
  }, 30_000);
});

posixOnly('SessionEnd keeps its other outputs distinct', () => {
  it('a refused environment prints the environment note alone, never the dropped line as well', async () => {
    const fx = fixture();
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_SESSIONS: 'rel.jsonl' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(`${HOME_REFUSED_END_NOTE}\n`);
  }, 30_000);

  it('a stdin with nothing to record stays silent even when the destination would be refused', async () => {
    const fx = fixture();
    writeFileSync(join(fx.home, 'witness.json'), SEED, { mode: 0o600 });
    const before = snapshot(fx.base);
    const r = await runEnd(fx, { HELIX_HOME: fx.home, HELIX_SESSIONS: join(fx.home, 'witness.json') }, 'not json');
    expectSilent(r);
    expect(snapshot(fx.base)).toEqual(before);
  }, 30_000);
});
