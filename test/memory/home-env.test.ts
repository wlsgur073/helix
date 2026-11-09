// B2a, task A2 (design 4.1, decisions C and D): ONE resolution of HELIX_HOME, HELIX_LEDGER and HELIX_SESSIONS, and the
// one typed home refusal. The function reads the `env` it is given, never process.env.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readlinkSync, realpathSync, chmodSync, existsSync, lstatSync, statSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveHelixPaths, HomeRefusalError, isHomeRefusalError, RELATIVE_VALUE_TEXT, UNRESOLVABLE_HOME_TEXT,
  type HomeRefusalCause, type HomeVariable,
} from '../../src/memory/home-env.js';

const posixOnly = describe.skipIf(process.platform === 'win32');

const d = realpathSync(mkdtempSync(join(tmpdir(), 'helix-henv-')));
const restores: Array<() => void> = [];
afterAll(() => {
  for (const r of restores) { try { r(); } catch { /* best effort */ } }
  try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
});

const FF = Buffer.from([0xff]);
const U = join(d, 'user');                                  // the userHome argument: a real directory inside the fixture
const REAL = join(d, 'real');                               // a real directory, the ordinary home
const P = join(d, 'p');                                     // p/q is the target of the directory link dl
const DL = join(d, 'dl');                                   // dl -> p/q
const LNK = join(d, 'lnk');                                 // lnk -> real: a home that is itself a link
const DANGLING = join(d, 'dangling');                       // dangling -> nowhere: a final link over nothing
const FILE = join(d, 'file');                               // a regular file
mkdirSync(U); mkdirSync(REAL, { mode: 0o700 }); mkdirSync(join(P, 'q'), { recursive: true });
symlinkSync(join(P, 'q'), DL); symlinkSync(REAL, LNK); symlinkSync(join(d, 'nowhere'), DANGLING); writeFileSync(FILE, '');

const thrownBy = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return undefined; };
const codeThrownBy = (f: () => unknown): string | undefined => (thrownBy(f) as NodeJS.ErrnoException | undefined)?.code;
const isRoot = (): boolean => typeof process.getuid === 'function' && process.getuid() === 0;
const homeOf = (HELIX_HOME: string): string => resolveHelixPaths({ HELIX_HOME }, U).home;

describe('the defaults and the values as given', () => {
  it('an unset variable and an empty one both read as unset', () => {
    const want = { home: join(U, '.helix'), globalLedger: join(U, '.helix', 'memory.jsonl'), sessionsFile: join(U, '.helix', 'sessions.jsonl') };
    expect(existsSync(join(U, '.helix'))).toBe(false);       // precondition: nothing stands at the default home
    expect(resolveHelixPaths({}, U)).toEqual(want);
    expect(resolveHelixPaths({ HELIX_HOME: '', HELIX_LEDGER: '', HELIX_SESSIONS: '' }, U)).toEqual(want);
  });

  it('an absolute HELIX_HOME is the home and the two files derive from it', () => {
    expect(resolveHelixPaths({ HELIX_HOME: REAL }, U)).toEqual({
      home: REAL, globalLedger: join(REAL, 'memory.jsonl'), sessionsFile: join(REAL, 'sessions.jsonl'),
    });
  });

  it('an absolute HELIX_LEDGER and HELIX_SESSIONS outside the home are returned as given, not resolved', () => {
    const ledger = `${d}/dl/../elsewhere.jsonl`;              // a dl/.. spelling: only the home's directory part is resolved
    const sessions = join(d, 'shared', 'sessions.jsonl');      // a directory that does not exist
    expect(resolveHelixPaths({ HELIX_HOME: REAL, HELIX_LEDGER: ledger, HELIX_SESSIONS: sessions }, U)).toEqual({
      home: REAL, globalLedger: ledger, sessionsFile: sessions,
    });
  });

  it('process.env is not read', () => {
    const before = process.env.HELIX_HOME;
    process.env.HELIX_HOME = 'relative/from/process-env';
    try { expect(resolveHelixPaths({}, U).home).toBe(join(U, '.helix')); }
    finally { if (before === undefined) delete process.env.HELIX_HOME; else process.env.HELIX_HOME = before; }
  });
});

describe('a value that is not an absolute path is refused (decision C)', () => {
  const VARIABLES: HomeVariable[] = ['HELIX_HOME', 'HELIX_LEDGER', 'HELIX_SESSIONS'];
  const VALUES = ['.', '..', 'x/y', './x', 'x', '~/.helix', ' '];
  for (const variable of VARIABLES) {
    for (const value of VALUES) {
      it(`${variable}=${JSON.stringify(value)}`, () => {
        const e = thrownBy(() => resolveHelixPaths({ HELIX_HOME: REAL, [variable]: value }, U));
        expect(isHomeRefusalError(e)).toBe(true);
        expect((e as HomeRefusalError).homeRefusalCause).toBe('relative-value');
        expect((e as HomeRefusalError).message).toBe(RELATIVE_VALUE_TEXT[variable]);
      });
    }
  }

  it('HELIX_HOME is judged first, then HELIX_LEDGER, then HELIX_SESSIONS', () => {
    const msg = (env: NodeJS.ProcessEnv): string => (thrownBy(() => resolveHelixPaths(env, U)) as Error).message;
    expect(msg({ HELIX_HOME: 'a', HELIX_LEDGER: 'b', HELIX_SESSIONS: 'c' })).toBe(RELATIVE_VALUE_TEXT.HELIX_HOME);
    expect(msg({ HELIX_HOME: REAL, HELIX_LEDGER: 'b', HELIX_SESSIONS: 'c' })).toBe(RELATIVE_VALUE_TEXT.HELIX_LEDGER);
  });

  posixOnly('a relative value is refused before the file system is asked about the home', () => {
    it('a relative HELIX_LEDGER beside an unresolvable home answers the relative value', () => {
      const loop = join(d, 'loop-order');
      symlinkSync(loop, loop);
      const e = thrownBy(() => resolveHelixPaths({ HELIX_HOME: join(loop, 'home'), HELIX_LEDGER: 'rel' }, U));
      expect((e as HomeRefusalError).homeRefusalCause).toBe('relative-value');
    });
  });
});

posixOnly('the home the kernel reaches (decision D)', () => {
  it('<link>/../name is the name under the PARENT OF THE LINK TARGET, and the files derive from it', () => {
    const given = `${DL}/../name`;
    expect(join(DL, '..', 'name')).toBe(join(d, 'name'));    // precondition: the text collapse lands elsewhere (D/name)
    expect(realpathSync.native(`${DL}/..`)).toBe(P);         // precondition: the kernel's `..` after dl is p
    expect(resolveHelixPaths({ HELIX_HOME: given }, U)).toEqual({
      home: join(P, 'name'), globalLedger: join(P, 'name', 'memory.jsonl'), sessionsFile: join(P, 'name', 'sessions.jsonl'),
    });
  });

  it('a link in the directory part is followed', () => {
    expect(homeOf(join(DL, 'home'))).toBe(join(P, 'q', 'home'));
  });

  it('the default home is resolved the same way: a userHome behind a link', () => {
    expect(resolveHelixPaths({}, DL).home).toBe(join(P, 'q', '.helix'));
  });

  it('a home that is itself a link stays that link, however it is spelled', () => {
    expect(lstatSync(LNK).isSymbolicLink()).toBe(true);      // precondition
    expect(realpathSync(LNK)).toBe(REAL);                    // precondition: following it would land elsewhere
    for (const spelling of [LNK, `${LNK}/`, `${LNK}/.`, `${LNK}/./.`, `${LNK}//`]) {
      expect(homeOf(spelling)).toBe(LNK);
    }
    expect(resolveHelixPaths({ HELIX_HOME: `${LNK}/` }, U).globalLedger).toBe(join(LNK, 'memory.jsonl'));
  });

  it('a link behind a directory link stays a link, and a dangling link stays where it stands', () => {
    symlinkSync(REAL, join(P, 'q', 'inner'));
    expect(homeOf(join(DL, 'inner'))).toBe(join(P, 'q', 'inner'));
    expect(lstatSync(DANGLING).isSymbolicLink()).toBe(true);
    expect(codeThrownBy(() => statSync(DANGLING))).toBe('ENOENT');   // precondition: nothing at the end of it
    expect(homeOf(DANGLING)).toBe(DANGLING);
  });

  it('a final `..` names the directory the kernel reaches', () => {
    expect(homeOf(`${DL}/..`)).toBe(P);
    expect(homeOf(`${DL}/../`)).toBe(P);
    expect(homeOf(`${DL}/../..`)).toBe(d);
  });

  it('repeated slashes and `.` components collapse; the root is itself', () => {
    expect(homeOf(`${d}//real///h`)).toBe(join(REAL, 'h'));
    expect(homeOf(`${d}/real/./h`)).toBe(join(REAL, 'h'));
    expect(resolveHelixPaths({ HELIX_HOME: '/' }, U)).toEqual({ home: '/', globalLedger: '/memory.jsonl', sessionsFile: '/sessions.jsonl' });
  });

  it('a missing directory part is named, not created', () => {
    expect(existsSync(join(d, 'nope'))).toBe(false);          // precondition
    expect(homeOf(join(d, 'nope', 'home'))).toBe(join(d, 'nope', 'home'));
    expect(homeOf(join(DL, 'nope', 'home'))).toBe(join(P, 'q', 'nope', 'home'));
    expect(existsSync(join(d, 'nope'))).toBe(false);
    expect(existsSync(join(P, 'q', 'nope'))).toBe(false);
  });
});

posixOnly('a directory part that cannot be named is refused (unresolvable-home)', () => {
  const refusedFor = (HELIX_HOME: string, userHome: string = U): HomeRefusalError => {
    const e = thrownBy(() => resolveHelixPaths({ HELIX_HOME }, userHome));
    expect(isHomeRefusalError(e)).toBe(true);
    return e as HomeRefusalError;
  };

  it('a link loop in the directory part', () => {
    const loop = join(d, 'loop');
    symlinkSync(loop, loop);
    expect(codeThrownBy(() => statSync(loop))).toBe('ELOOP');   // precondition
    const e = refusedFor(join(loop, 'home'));
    expect(e.homeRefusalCause).toBe('unresolvable-home');
    expect(e.message).toBe(UNRESOLVABLE_HOME_TEXT);
  });

  it('a directory link whose body is not valid UTF-8', () => {
    mkdirSync(join(d, 'ffreal'));
    const link = join(d, 'ffl');
    symlinkSync(Buffer.concat([Buffer.from(`${d}/ffreal`), FF]), link);
    expect(readlinkSync(link, { encoding: 'buffer' }).includes(FF)).toBe(true);   // precondition
    expect(refusedFor(join(link, 'home')).homeRefusalCause).toBe('unresolvable-home');
  });

  it('the default home too: a userHome that is a loop', () => {
    const loop = join(d, 'loop-user');
    symlinkSync(loop, loop);
    expect(refusedFor('', loop).homeRefusalCause).toBe('unresolvable-home');
  });

  // Final review G2: Node decodes a value whose bytes are not valid UTF-8 with U+FFFD, so a home value holding U+FFFD is
  // refused before any file system call (the directory at the replaced name is never created or used).
  it('a HELIX_HOME holding U+FFFD (a value that was not valid UTF-8), and nothing is made at the replaced name', () => {
    const replaced = join(d, `ff${String.fromCharCode(0xfffd)}home`);
    expect(Buffer.from(replaced).includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(true);   // precondition: U+FFFD itself
    const e = refusedFor(replaced);
    expect(e.homeRefusalCause).toBe('unresolvable-home');
    expect(e.message).toBe(UNRESOLVABLE_HOME_TEXT);
    expect(existsSync(replaced)).toBe(false);
    expect(refusedFor(join(replaced, 'sub')).homeRefusalCause).toBe('unresolvable-home');   // anywhere in the value
  });

  it('U+FFFD is judged after the relative values: a relative HELIX_LEDGER beside it answers the relative value', () => {
    const e = thrownBy(() => resolveHelixPaths({ HELIX_HOME: join(d, String.fromCharCode(0xfffd)), HELIX_LEDGER: 'rel.jsonl' }, U));
    expect((e as HomeRefusalError).homeRefusalCause).toBe('relative-value');
    expect((e as Error).message).toBe(RELATIVE_VALUE_TEXT.HELIX_LEDGER);
  });

  // Final review G3: the composed home is looked at once with lstat; ENAMETOOLONG and ELOOP are refused there too.
  it('a final component past the name limit (256 bytes) under a directory that resolves', () => {
    const home = join(REAL, 'n'.repeat(256));
    expect(codeThrownBy(() => lstatSync(home))).toBe('ENAMETOOLONG');   // precondition
    const e = refusedFor(home);
    expect(e.homeRefusalCause).toBe('unresolvable-home');
    expect(e.message).toBe(UNRESOLVABLE_HOME_TEXT);
  });

  it('a whole value past PATH_MAX whose directory part is under it', () => {
    let deep = join(d, 'deep');
    while (deep.length < 3880) deep = join(deep, 'd'.repeat(200));
    mkdirSync(deep, { recursive: true });
    const home = join(deep, 'h'.repeat(250));
    expect(deep.length).toBeLessThan(4095);                                // precondition: the directory part resolves
    expect(home.length).toBeGreaterThan(4095);                             // precondition: the whole value is past PATH_MAX
    expect(realpathSync.native(deep)).toBe(deep);
    expect(codeThrownBy(() => lstatSync(home))).toBe('ENAMETOOLONG');
    expect(refusedFor(home).homeRefusalCause).toBe('unresolvable-home');
  });

  it('control: a 255-byte final component and a missing home are kept (ENOENT is not a refusal)', () => {
    const home = join(REAL, 'n'.repeat(255));
    expect(codeThrownBy(() => lstatSync(home))).toBe('ENOENT');           // precondition
    expect(homeOf(home)).toBe(home);
  });
});

posixOnly('a directory part that cannot be inspected and no `..`: the path is kept as given, and the fs error comes later', () => {
  it('ENOTDIR: a regular file in the directory part', () => {
    const given = `${FILE}/./home`;                           // resolving would give `${FILE}/home`
    expect(codeThrownBy(() => statSync(`${FILE}/.`))).toBe('ENOTDIR');   // precondition
    expect(homeOf(given)).toBe(given);
  });

  it.skipIf(isRoot())('EACCES on the way', () => {
    const closed = join(d, 'closed-plain');
    mkdirSync(join(closed, 'sub'), { recursive: true });
    chmodSync(closed, 0o000);
    restores.push(() => chmodSync(closed, 0o700));
    const given = `${closed}/sub/home`;
    expect(codeThrownBy(() => statSync(`${closed}/sub`))).toBe('EACCES');  // precondition
    expect(homeOf(given)).toBe(given);
  });
});

// Final review G1 (owner, 2026-11-09): every file below the home is joined as text, which folds a `..` over the folder the
// kernel could not pass, so a value with a `..` and a directory part that cannot be inspected is refused with text 4.
posixOnly('a directory part that cannot be inspected and a `..` in the value: refused (unresolvable-home)', () => {
  const refusedFor = (HELIX_HOME: string): HomeRefusalError => {
    const e = thrownBy(() => resolveHelixPaths({ HELIX_HOME }, U));
    expect(isHomeRefusalError(e)).toBe(true);
    expect((e as HomeRefusalError).homeRefusalCause).toBe('unresolvable-home');
    expect((e as Error).message).toBe(UNRESOLVABLE_HOME_TEXT);
    return e as HomeRefusalError;
  };

  it('ENOENT before a `..`: the kernel refuses the path, and the text fold is never used', () => {
    const given = `${d}/nope/../home`;
    expect(codeThrownBy(() => statSync(`${d}/nope/..`))).toBe('ENOENT');   // precondition
    refusedFor(given);
  });

  it.skipIf(isRoot())('EACCES on the way', () => {
    const closed = join(d, 'closed');
    mkdirSync(join(closed, 'sub'), { recursive: true });
    chmodSync(closed, 0o000);
    restores.push(() => chmodSync(closed, 0o700));
    const given = `${closed}/sub/../home`;
    expect(codeThrownBy(() => statSync(`${closed}/sub`))).toBe('EACCES');  // precondition
    refusedFor(given);
  });

  it('ENOTDIR: a regular file followed by `..`', () => {
    const given = `${FILE}/../home`;
    expect(codeThrownBy(() => statSync(`${FILE}/..`))).toBe('ENOTDIR');   // precondition
    refusedFor(given);
  });

  it('a final `..` after a folder that cannot be inspected', () => {
    refusedFor(`${d}/nope/..`);
  });
});

// Fix pass 2026-11-08, disposition 11: on win32 the given absolute path is kept (as ensureHelixDir's win32 branch keeps
// its dir); empty = unset and relative = refused still hold, judged by path.win32. The platform is passed as the third
// argument, so these cases run on every host.
describe('win32: the given absolute path is kept, never resolved the kernel way', () => {
  const WU = 'C:\\Users\\k';

  it('an unset and an empty variable read as unset, and the defaults are joined with win32 separators', () => {
    const want = { home: 'C:\\Users\\k\\.helix', globalLedger: 'C:\\Users\\k\\.helix\\memory.jsonl', sessionsFile: 'C:\\Users\\k\\.helix\\sessions.jsonl' };
    expect(win32.join(WU, '.helix')).toBe(want.home);         // precondition: the expected value is win32's own join
    expect(resolveHelixPaths({}, WU, 'win32')).toEqual(want);
    expect(resolveHelixPaths({ HELIX_HOME: '', HELIX_LEDGER: '', HELIX_SESSIONS: '' }, WU, 'win32')).toEqual(want);
  });

  it('a value path.win32 does not call absolute is refused, for each variable', () => {
    const VARIABLES: HomeVariable[] = ['HELIX_HOME', 'HELIX_LEDGER', 'HELIX_SESSIONS'];
    for (const variable of VARIABLES) {
      for (const value of ['x', '.\\x', 'C:x', '~\\.helix', ' ']) {
        expect(win32.isAbsolute(value), `precondition: ${value} is not absolute on win32`).toBe(false);
        const e = thrownBy(() => resolveHelixPaths({ HELIX_HOME: 'C:\\h', [variable]: value }, WU, 'win32'));
        expect(isHomeRefusalError(e), `${variable}=${JSON.stringify(value)}`).toBe(true);
        expect((e as HomeRefusalError).homeRefusalCause).toBe('relative-value');
        expect((e as HomeRefusalError).message).toBe(RELATIVE_VALUE_TEXT[variable]);
      }
    }
  });

  posixOnly('the directory part is not resolved on win32 (the fixtures need POSIX links)', () => {
    it('a <link>/../name home is kept as given, not taken to the parent of the link target', () => {
      const given = `${DL}/../name`;
      expect(realpathSync.native(`${DL}/..`)).toBe(P);        // precondition: the kernel way would take it to p/name
      expect(resolveHelixPaths({ HELIX_HOME: given }, U, 'win32').home).toBe(given);
    });

    it('a link loop in the directory part is not refused on win32: resolvePath is never asked', () => {
      const loop = join(d, 'loop-win32');
      symlinkSync(loop, loop);
      expect(codeThrownBy(() => statSync(loop))).toBe('ELOOP');   // precondition
      expect(resolveHelixPaths({ HELIX_HOME: join(loop, 'home') }, U, 'win32').home).toBe(join(loop, 'home'));
    });
  });
});

describe('HomeRefusalError and isHomeRefusalError', () => {
  it('carries the cause and the message, and is an Error', () => {
    const e = new HomeRefusalError('home-control-file', 'a text');
    expect(e).toBeInstanceOf(Error);
    expect(e.homeRefusalCause).toBe('home-control-file');
    expect(e.message).toBe('a text');
    expect(e.name).toBe('HomeRefusalError');
    expect(isHomeRefusalError(e)).toBe(true);
  });

  it('names the nine causes the batch uses', () => {
    const causes: HomeRefusalCause[] = [
      'relative-value', 'unresolvable-home', 'symlinked-home', 'not-a-directory', 'foreign-owner', 'parent-missing',
      'home-control-file', 'home-unwritable', 'audit-unwritable',
    ];
    for (const c of causes) expect(new HomeRefusalError(c, 'm').homeRefusalCause).toBe(c);
  });

  it('is read by its marker property, never by class identity', () => {
    expect(isHomeRefusalError(Object.assign(new Error('from another copy of the module'), { homeRefusal: true }))).toBe(true);
    expect(isHomeRefusalError(new Error('plain'))).toBe(false);
    expect(isHomeRefusalError(Object.assign(new Error('only the cause'), { homeRefusalCause: 'relative-value' }))).toBe(false);
    expect(isHomeRefusalError({ homeRefusal: true })).toBe(false);
    expect(isHomeRefusalError(undefined)).toBe(false);
    expect(isHomeRefusalError(null)).toBe(false);
  });
});

describe('the constant texts and the module boundary', () => {
  it('the texts are exactly these, in ASCII, with no path and no interpolation', () => {
    expect(RELATIVE_VALUE_TEXT).toEqual({
      HELIX_HOME: 'HELIX_HOME is not an absolute path, so it is refused',
      HELIX_LEDGER: 'HELIX_LEDGER is not an absolute path, so it is refused',
      HELIX_SESSIONS: 'HELIX_SESSIONS is not an absolute path, so it is refused',
    });
    expect(UNRESOLVABLE_HOME_TEXT).toBe(
      'the Helix home cannot be resolved (a name that is not valid UTF-8, a path past the system limit, too many links, or a `..` after a folder that cannot be searched), so it is refused');
    for (const t of [...Object.values(RELATIVE_VALUE_TEXT), UNRESOLVABLE_HOME_TEXT]) {
      expect(t).toMatch(/^[\x20-\x7e]+$/);
      expect(t).not.toMatch(/[\\/]/);
    }
  });

  it('imports node builtins and path-identity.js only (plan, Global Constraints)', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/memory/home-env.ts', import.meta.url)), 'utf8');
    const specs = [...source.matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(specs.filter((s) => !s.startsWith('node:'))).toEqual(['./path-identity.js']);
    expect(specs).toContain('node:path');
  });
});
