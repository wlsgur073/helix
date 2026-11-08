// Third fix batch B2a, task A4 (design 4.1, decisions C and D): the two hook entries resolve HELIX_HOME, HELIX_LEDGER and
// HELIX_SESSIONS through resolveHelixPaths. An empty value is unset, a relative or unresolvable value is refused with one
// constant note and nothing is read or written, and `<link>/../name` is the directory the kernel reaches. Both hooks are
// bundled FROM SOURCE and spawned as plain node (the file-modes.test.ts discipline), never from the committed bin/.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync, lstatSync, statSync,
  readdirSync, realpathSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleCli } from '../helpers/bundle-cli.js';
import { SYMLINKED_HOME_NOTE } from '../../src/memory/content-frame.js';
import { HOME_REFUSED_START_NOTE, HOME_REFUSED_END_NOTE } from '../../src/hooks/session-record.js';
import { HOOK_STDIN_MAX_BYTES } from '../../src/limits.js';

const posixOnly = describe.skipIf(process.platform === 'win32');

let START = '';
let END = '';
beforeAll(async () => {
  START = await bundleCli('src/hooks/session-start.ts');
  END = await bundleCli('src/hooks/session-end.ts');
}, 120_000);

/** One case's directories: `u` stands in for $HOME, `w` is the hooks' working directory (0755, outside the repository). */
interface Fx { base: string; userHome: string; work: string }
const bases: string[] = [];
function fixture(): Fx {
  const base = mkdtempSync(join(tmpdir(), 'hh-'));
  bases.push(base);
  const userHome = join(base, 'u');
  const work = join(base, 'w');
  mkdirSync(userHome);
  mkdirSync(work);
  chmodSync(work, 0o755);   // umask-proof: a hook that tightens its working directory shows in the snapshot
  return { base, userHome, work };
}
afterEach(() => { for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true }); });

/** An ordinary absolute home: a real directory the user owns, 0700. */
function ordinaryHome(fx: Fx): string {
  const h = join(fx.base, 'h');
  mkdirSync(h, { mode: 0o700 });
  return h;
}

const TS = '2026-11-08T00:00:00.000Z';
function seed(dir: string, id: string, content: string): void {
  writeFileSync(join(dir, 'memory.jsonl'), JSON.stringify({
    id, tx: TS, validFrom: TS, validTo: null, type: 'assert', state: 'Fresh', content,
    provenance: { source: 'user', sessionId: 'seed' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  }) + '\n');
}

/** Every name under `dir` with its mode and, for a file, its sha256: what "nothing was read-modified or written" is compared on. */
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

const strippedEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_'))) as Record<string, string>;

/** `stdinError` is the code of an `error` the child's stdin raised (`EPIPE` when the child exited without reading it), else null. */
interface Ran { code: number | null; stdout: string; stderr: string; stdinError: string | null }
function runHook(script: string, fx: Fx, helix: Record<string, string>, stdin: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: fx.work, env: { ...strippedEnv(), HOME: fx.userHome, ...helix } });
    let stdout = '';
    let stderr = '';
    let stdinError: string | null = null;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the hook did not exit within 20 s')); }, 20_000);
    child.stdout.on('data', (d: Buffer) => { stdout += String(d); });
    child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
    child.stdin.on('error', (e: NodeJS.ErrnoException) => { stdinError = e.code ?? 'error'; });   // recorded, never thrown
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, stdinError }); });
    child.stdin.end(stdin);
  });
}

const START_STDIN = JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume' });   // a resume: the case where a supersede note could appear
const END_STDIN = JSON.stringify({ session_id: 's-1', reason: 'clear' });

/** `<link>/../name`: the kernel reaches `real/name`, the text fold would reach `name` beside `real`. */
function dotdotLayout(fx: Fx): { home: string; kernelHome: string; collapsedHome: string } {
  const real = join(fx.base, 'real');
  const inner = join(real, 'inner');
  mkdirSync(inner, { recursive: true });
  const kernelHome = join(real, 'name');
  const collapsedHome = join(fx.base, 'name');
  mkdirSync(kernelHome, { mode: 0o700 });
  mkdirSync(collapsedHome, { mode: 0o700 });
  symlinkSync(inner, join(fx.base, 'link'));
  const home = `${fx.base}/link/../name`;   // concatenation: path.join would fold the ".." as text
  expect(lstatSync(join(fx.base, 'link')).isSymbolicLink()).toBe(true);            // precondition
  // realpathSync.native, never the JS realpathSync: the JS version runs path.resolve first and folds `link/..` as text
  // (fix pass 2026-11-08: measured on a scratch mirror, the JS form returned the folded name and this precondition failed).
  expect(realpathSync.native(home)).toBe(realpathSync.native(kernelHome));            // the kernel goes to real/name
  expect(realpathSync.native(home)).not.toBe(realpathSync.native(collapsedHome));     // and not to the folded name
  return { home, kernelHome, collapsedHome };
}

/** A home whose directory part is a link loop: not resolvable (cause 'unresolvable-home'). */
function loopHome(fx: Fx): string {
  symlinkSync(join(fx.base, 'b'), join(fx.base, 'a'));
  symlinkSync(join(fx.base, 'a'), join(fx.base, 'b'));
  expect(() => statSync(join(fx.base, 'a'))).toThrow(/ELOOP/);                        // precondition
  return `${fx.base}/a/name`;
}

describe('the two refusal notes', () => {
  it('are fixed ASCII sentences with no path and no interpolation', () => {
    expect(HOME_REFUSED_START_NOTE).toBe(
      'helix: NOTE - HELIX_HOME or HELIX_LEDGER holds a relative path or a path that cannot be resolved; the session-start hook read and wrote no memory.');
    expect(HOME_REFUSED_END_NOTE).toBe(
      'helix: NOTE - HELIX_HOME, HELIX_LEDGER or HELIX_SESSIONS holds a relative path or a path that cannot be resolved; the session-end hook wrote no record.');
    for (const n of [HOME_REFUSED_START_NOTE, HOME_REFUSED_END_NOTE]) expect(n).toMatch(/^[\x20-\x7e]+$/);
  });
});

posixOnly('SessionStart resolves its environment through resolveHelixPaths', () => {
  it('an empty HELIX_HOME is unset: the default home under HOME is read and the working directory is left alone', async () => {
    const fx = fixture();
    const def = join(fx.userHome, '.helix');
    mkdirSync(def, { mode: 0o700 });
    seed(def, 'm_def', 'default home fact');
    seed(fx.work, 'm_cwd', 'working directory fact');
    const before = snapshot(fx.work);
    const r = await runHook(START, fx, { HELIX_HOME: '' }, '{}');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('DATA[Fresh:global]| default home fact');
    expect(r.stdout).not.toContain('working directory fact');
    expect(snapshot(fx.work)).toEqual(before);
  }, 30_000);

  it.each(['.', 'x/y'])('a relative HELIX_HOME (%s) is refused: the note alone, exit 0, nothing read or written', async (value) => {
    const fx = fixture();
    seed(fx.work, 'm_cwd', 'working directory fact');
    const before = snapshot(fx.work);
    const userBefore = snapshot(fx.userHome);
    const r = await runHook(START, fx, { HELIX_HOME: value }, START_STDIN);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${HOME_REFUSED_START_NOTE}\n`);   // the note alone, even for a resume: no block, no supersede note
    expect(r.stderr).toBe('');
    expect(snapshot(fx.work)).toEqual(before);                // not read-modified, no metrics.jsonl, mode still 0755
    expect(snapshot(fx.userHome)).toEqual(userBefore);        // the default home was not created either
  }, 30_000);

  it('a refused SessionStart drains its stdin before the note, so a large host write never meets a closed pipe (disposition 9)', async () => {
    const fx = fixture();
    const big = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', pad: 'x'.repeat(256 * 1024) });
    expect(Buffer.byteLength(big)).toBeLessThan(HOOK_STDIN_MAX_BYTES);   // precondition: under the cap, so the reader reads it all
    expect(Buffer.byteLength(big)).toBeGreaterThan(64 * 1024);           // precondition: more than a pipe buffer takes without a reader
    const before = snapshot(fx.work);
    const r = await runHook(START, fx, { HELIX_HOME: '.' }, big);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${HOME_REFUSED_START_NOTE}\n`);
    expect(r.stderr).toBe('');
    expect(r.stdinError, 'the host side of the pipe saw no error: the hook read its stdin before it exited').toBeNull();
    expect(snapshot(fx.work)).toEqual(before);
  }, 30_000);

  it('a relative HELIX_LEDGER beside an ordinary home is refused the same way', async () => {
    const fx = fixture();
    const h = ordinaryHome(fx);
    seed(fx.work, 'm_cwd', 'working directory fact');
    const before = snapshot(fx.work);
    const homeBefore = snapshot(h);
    const r = await runHook(START, fx, { HELIX_HOME: h, HELIX_LEDGER: 'memory.jsonl' }, START_STDIN);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${HOME_REFUSED_START_NOTE}\n`);
    expect(snapshot(fx.work)).toEqual(before);
    expect(snapshot(h)).toEqual(homeBefore);
  }, 30_000);

  it('an empty HELIX_LEDGER is unset: the home\'s own memory.jsonl is served', async () => {
    const fx = fixture();
    const h = ordinaryHome(fx);
    seed(h, 'm_home', 'home ledger fact');
    const r = await runHook(START, fx, { HELIX_HOME: h, HELIX_LEDGER: '' }, '{}');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('DATA[Fresh:global]| home ledger fact');
  }, 30_000);

  it('a HELIX_HOME of the form <link>/../name is the directory the kernel reaches, not the folded name', async () => {
    const fx = fixture();
    const { home, kernelHome, collapsedHome } = dotdotLayout(fx);
    seed(kernelHome, 'm_kernel', 'kernel home fact');
    seed(collapsedHome, 'm_fold', 'folded name fact');
    const r = await runHook(START, fx, { HELIX_HOME: home }, '{}');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('DATA[Fresh:global]| kernel home fact');
    expect(r.stdout).not.toContain('folded name fact');
    expect(r.stdout).not.toContain(SYMLINKED_HOME_NOTE);       // real/name is an ordinary directory
  }, 30_000);

  it('a home whose directory part is a link loop is refused with the same note', async () => {
    const fx = fixture();
    const before = snapshot(fx.work);
    const r = await runHook(START, fx, { HELIX_HOME: loopHome(fx) }, START_STDIN);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${HOME_REFUSED_START_NOTE}\n`);
    expect(snapshot(fx.work)).toEqual(before);
  }, 30_000);

  it('a symlinked home keeps today\'s behaviour: its rows are read and the symlink note is printed (Review Focus 2)', async () => {
    const fx = fixture();
    const target = join(fx.base, 't');
    mkdirSync(target, { mode: 0o700 });
    seed(target, 'm_target', 'link target fact');
    const link = join(fx.base, 'l');
    symlinkSync(target, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);        // precondition: the FINAL component is the link
    const r = await runHook(START, fx, { HELIX_HOME: link }, '{}');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(SYMLINKED_HOME_NOTE);
    expect(r.stdout).toContain('DATA[Fresh:global]| link target fact');
  }, 30_000);

  it('control: an ordinary absolute home is served as before', async () => {
    const fx = fixture();
    const h = ordinaryHome(fx);
    seed(h, 'm_home', 'ordinary home fact');
    const r = await runHook(START, fx, { HELIX_HOME: h }, '{}');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('DATA[Fresh:global]| ordinary home fact');
    expect(r.stdout).not.toContain(HOME_REFUSED_START_NOTE);
  }, 30_000);

  it('control: no HELIX_* at all (the dogfood unit\'s shape, Review Focus 1): the default home under HOME is served', async () => {
    const fx = fixture();
    const def = join(fx.userHome, '.helix');
    mkdirSync(def, { mode: 0o700 });
    seed(def, 'm_def', 'default home fact');
    const before = snapshot(fx.work);
    const r = await runHook(START, fx, {}, '{}');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('DATA[Fresh:global]| default home fact');
    expect(r.stdout).not.toContain(HOME_REFUSED_START_NOTE);
    expect(snapshot(fx.work)).toEqual(before);
  }, 30_000);

  it('control: a relative HELIX_SESSIONS, which SessionStart does not read, does not stop it (decision S1)', async () => {
    const fx = fixture();
    const h = ordinaryHome(fx);
    seed(h, 'm_home', 'ordinary home fact');
    const r = await runHook(START, fx, { HELIX_HOME: h, HELIX_SESSIONS: 'rel.jsonl' }, '{}');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('DATA[Fresh:global]| ordinary home fact');
    expect(r.stdout).not.toContain(HOME_REFUSED_START_NOTE);
  }, 30_000);
});

posixOnly('SessionEnd resolves its environment through resolveHelixPaths', () => {
  const lines = (file: string): Array<Record<string, unknown>> =>
    readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

  it('an empty HELIX_HOME is unset: the record goes to the default home under HOME and the working directory is left alone', async () => {
    const fx = fixture();
    const before = snapshot(fx.work);
    const r = await runHook(END, fx, { HELIX_HOME: '' }, END_STDIN);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const written = join(fx.userHome, '.helix', 'sessions.jsonl');
    expect(lines(written)).toHaveLength(1);
    expect(lines(written)[0]).toMatchObject({ kind: 'session-end', sessionId: 's-1', reason: 'clear' });
    expect(snapshot(fx.work)).toEqual(before);                // no sessions.jsonl in the cwd, mode still 0755
  }, 30_000);

  it.each(['.', 'x/y'])('a relative HELIX_HOME (%s) is refused: one note on stderr, exit 0, nothing written', async (value) => {
    const fx = fixture();
    const before = snapshot(fx.work);
    const userBefore = snapshot(fx.userHome);
    const r = await runHook(END, fx, { HELIX_HOME: value }, END_STDIN);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(`${HOME_REFUSED_END_NOTE}\n`);
    expect(snapshot(fx.work)).toEqual(before);
    expect(snapshot(fx.userHome)).toEqual(userBefore);
  }, 30_000);

  it('a relative HELIX_SESSIONS is refused: no file in the working directory and no mode change there', async () => {
    const fx = fixture();
    const h = ordinaryHome(fx);
    const before = snapshot(fx.work);
    const homeBefore = snapshot(h);
    const r = await runHook(END, fx, { HELIX_HOME: h, HELIX_SESSIONS: 'rel.jsonl' }, END_STDIN);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(`${HOME_REFUSED_END_NOTE}\n`);
    expect(snapshot(fx.work)).toEqual(before);
    expect(snapshot(h)).toEqual(homeBefore);
  }, 30_000);

  it('a relative HELIX_LEDGER is refused too (SessionEnd passes it, ruling N1 and decision S1): the note, no record', async () => {
    const fx = fixture();
    const h = ordinaryHome(fx);
    const before = snapshot(fx.work);
    const homeBefore = snapshot(h);
    const r = await runHook(END, fx, { HELIX_HOME: h, HELIX_LEDGER: 'memory.jsonl' }, END_STDIN);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(`${HOME_REFUSED_END_NOTE}\n`);
    expect(snapshot(fx.work)).toEqual(before);
    expect(snapshot(h)).toEqual(homeBefore);
  }, 30_000);

  it('an empty HELIX_SESSIONS is unset: the record goes to <home>/sessions.jsonl', async () => {
    const fx = fixture();
    const h = ordinaryHome(fx);
    const before = snapshot(fx.work);
    const r = await runHook(END, fx, { HELIX_HOME: h, HELIX_SESSIONS: '' }, END_STDIN);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(lines(join(h, 'sessions.jsonl'))).toHaveLength(1);
    expect(snapshot(fx.work)).toEqual(before);                // the working directory was not tightened through dirname('')
  }, 30_000);

  it('a HELIX_HOME of the form <link>/../name receives the record at the kernel\'s directory, not the folded name', async () => {
    const fx = fixture();
    const { home, kernelHome, collapsedHome } = dotdotLayout(fx);
    const r = await runHook(END, fx, { HELIX_HOME: home }, END_STDIN);
    expect(r.code).toBe(0);
    expect(lines(join(kernelHome, 'sessions.jsonl'))).toHaveLength(1);
    expect(existsSync(join(collapsedHome, 'sessions.jsonl'))).toBe(false);
  }, 30_000);

  it('a home whose directory part is a link loop is refused with the same note', async () => {
    const fx = fixture();
    const before = snapshot(fx.work);
    const r = await runHook(END, fx, { HELIX_HOME: loopHome(fx) }, END_STDIN);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(`${HOME_REFUSED_END_NOTE}\n`);
    expect(snapshot(fx.work)).toEqual(before);
  }, 30_000);

  it('a symlinked home writes nothing, as today (its stderr line is B2\'s, so only the absence of the record is asserted)', async () => {
    const fx = fixture();
    const target = join(fx.base, 't');
    mkdirSync(target, { mode: 0o700 });
    const link = join(fx.base, 'l');
    symlinkSync(target, link);
    const r = await runHook(END, fx, { HELIX_HOME: link }, END_STDIN);
    expect(r.code).toBe(0);
    expect(readdirSync(target)).toEqual([]);
    expect(r.stderr).not.toContain('Error');
  }, 30_000);

  it('nothing to record stays silent even when the environment is refused (garbage stdin)', async () => {
    const fx = fixture();
    const before = snapshot(fx.work);
    const r = await runHook(END, fx, { HELIX_HOME: '.' }, 'not json');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(snapshot(fx.work)).toEqual(before);
  }, 30_000);

  it('control: an ordinary absolute home gets the record, 0600', async () => {
    const fx = fixture();
    const h = ordinaryHome(fx);
    const r = await runHook(END, fx, { HELIX_HOME: h }, END_STDIN);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(lines(join(h, 'sessions.jsonl'))).toHaveLength(1);
    expect(statSync(join(h, 'sessions.jsonl')).mode & 0o777).toBe(0o600);
  }, 30_000);

  it('control: no HELIX_* at all (the dogfood unit\'s shape, Review Focus 1): the record goes to $HOME/.helix/sessions.jsonl', async () => {
    const fx = fixture();
    const before = snapshot(fx.work);
    const r = await runHook(END, fx, {}, END_STDIN);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(lines(join(fx.userHome, '.helix', 'sessions.jsonl'))).toHaveLength(1);
    expect(snapshot(fx.work)).toEqual(before);
  }, 30_000);
});
