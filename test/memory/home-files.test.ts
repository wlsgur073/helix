// B2a task A8 (J2): the two non-blocking open helpers for the files Helix keeps in its home, and the typed
// refusal they raise. The helpers never block on a FIFO, so these cases run in-process; the call sites are
// proved in test/memory/home-fifo-sites.test.ts, in a child with a deadline, because a site that still uses a
// plain open blocks a synchronous open(2) that no vitest timeout can interrupt.
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openHomeFileForRead, openHomeFileForAppend, NotRegularHomeFileError, isNotRegularHomeFileError, HOME_CONTROL_NAMES, homeControlFileOf,
} from '../../src/memory/home-files.js';
import * as homeFiles from '../../src/memory/home-files.js';
import { assessGradeLoss } from '../../src/memory/trust-store-layout.js';
import { ensureMaster } from '../../src/memory/ledger-mac.js';
import { globalScopeNonce } from '../../src/memory/ownership.js';
import * as pathIdentityMod from '../../src/memory/path-identity.js';
import { OWNED_FILES } from '../../src/memory/home-permissions.js';

const NOT_REGULAR = 'A Helix data file is not a regular file.';   // fixed at the text review
const tmp = (): string => mkdtempSync(join(tmpdir(), 'helix-hfiles-'));
const thrown = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } return undefined; };
const fdCount = (): number => readdirSync('/proc/self/fd').length;

/** The precondition of every FIFO case: the name really is a FIFO (a fixture that fails to make one would pass vacuously). */
function mkfifo(p: string): string {
  execFileSync('mkfifo', [p]);
  expect(lstatSync(p).isFIFO(), 'fixture: the name is a FIFO').toBe(true);
  return p;
}

const posixOnly = describe.skipIf(process.platform === 'win32');

describe('NotRegularHomeFileError', () => {
  it('carries a property marker and a constant text without a path', () => {
    const e = new NotRegularHomeFileError();
    expect(isNotRegularHomeFileError(e)).toBe(true);
    expect(e.name).toBe('NotRegularHomeFileError');
    expect(e.message).toBe(NOT_REGULAR);
  });

  it('is told by its marker, never by class identity or by anything else', () => {
    expect(isNotRegularHomeFileError(Object.assign(new Error('copy from another module instance'), { notRegularHomeFile: true }))).toBe(true);
    expect(isNotRegularHomeFileError(new Error(NOT_REGULAR))).toBe(false);
    expect(isNotRegularHomeFileError({ notRegularHomeFile: true })).toBe(false);
    expect(isNotRegularHomeFileError(null)).toBe(false);
    expect(isNotRegularHomeFileError(undefined)).toBe(false);
  });
});

posixOnly('openHomeFileForRead', () => {
  it('returns a descriptor of a regular file that reads its bytes', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'r'), 'hello');
      const fd = openHomeFileForRead(join(dir, 'r'));
      try { expect(readFileSync(fd, 'utf8')).toBe('hello'); } finally { closeSync(fd); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('lets ENOENT through unchanged, so each caller keeps its absent-file convention', () => {
    const dir = tmp();
    try {
      expect(thrown(() => openHomeFileForRead(join(dir, 'missing')))).toMatchObject({ code: 'ENOENT' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('follows a link at the last component to a regular file (the key read through a link is unchanged)', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'target'), 'via link');
      symlinkSync(join(dir, 'target'), join(dir, 'link'));
      const fd = openHomeFileForRead(join(dir, 'link'));
      try { expect(readFileSync(fd, 'utf8')).toBe('via link'); } finally { closeSync(fd); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a FIFO with no writer at once instead of blocking', () => {
    const dir = tmp();
    try {
      const e = thrown(() => openHomeFileForRead(mkfifo(join(dir, 'f'))));
      expect(isNotRegularHomeFileError(e)).toBe(true);
      expect((e as Error).message).toBe(NOT_REGULAR);
      expect((e as Error).message).not.toContain(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a FIFO that has a writer, a link to a FIFO and a directory', () => {
    const dir = tmp();
    try {
      const fifo = mkfifo(join(dir, 'f'));
      const holder = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);   // a peer on both ends
      try {
        expect(isNotRegularHomeFileError(thrown(() => openHomeFileForRead(fifo))), 'FIFO with a peer').toBe(true);
        symlinkSync(fifo, join(dir, 'link'));
        expect(isNotRegularHomeFileError(thrown(() => openHomeFileForRead(join(dir, 'link')))), 'link to a FIFO').toBe(true);
      } finally { closeSync(holder); }
      mkdirSync(join(dir, 'd'));
      expect(isNotRegularHomeFileError(thrown(() => openHomeFileForRead(join(dir, 'd')))), 'directory').toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a UNIX socket (the open fails with ENXIO)', async () => {
    const dir = mkdtempSync('/tmp/hf-');   // short on purpose: a socket path must fit sun_path (108 bytes); precedent test/memory/ledger-file-type.test.ts:99
    const p = join(dir, 's');
    const srv = createServer();
    await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(p, resolve); });
    try {
      expect(isNotRegularHomeFileError(thrown(() => openHomeFileForRead(p)))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it.skipIf(process.platform !== 'linux')('closes the descriptor it refuses (no leak over 20 refusals)', () => {
    const dir = tmp();
    try {
      const fifo = mkfifo(join(dir, 'f'));
      const before = fdCount();
      for (let i = 0; i < 20; i++) expect(isNotRegularHomeFileError(thrown(() => openHomeFileForRead(fifo)))).toBe(true);
      expect(fdCount()).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

posixOnly('openHomeFileForAppend', () => {
  it('creates a missing file with the given mode and appends to an existing one without touching its mode', () => {
    const dir = tmp();
    try {
      const p = join(dir, 'new.jsonl');
      const fd = openHomeFileForAppend(p, 0o600);
      try { writeFileSync(fd, 'one\n'); } finally { closeSync(fd); }
      expect(statSync(p).mode & 0o777).toBe(0o600);
      const old = join(dir, 'old.jsonl');
      writeFileSync(old, 'first\n', { mode: 0o644 });
      const fd2 = openHomeFileForAppend(old, 0o600);
      try { writeFileSync(fd2, 'second\n'); } finally { closeSync(fd2); }
      expect(readFileSync(old, 'utf8')).toBe('first\nsecond\n');
      expect(statSync(old).mode & 0o777).toBe(0o644);   // the mode argument applies on create only
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('appends through a link at the last component and leaves the link a link', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'target'), 'a\n');
      symlinkSync(join(dir, 'target'), join(dir, 'link'));
      const fd = openHomeFileForAppend(join(dir, 'link'), 0o600);
      try { writeFileSync(fd, 'b\n'); } finally { closeSync(fd); }
      expect(readFileSync(join(dir, 'target'), 'utf8')).toBe('a\nb\n');
      expect(lstatSync(join(dir, 'link')).isSymbolicLink()).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a FIFO with no reader (ENXIO) instead of blocking, and leaves the FIFO in place', () => {
    const dir = tmp();
    try {
      const fifo = mkfifo(join(dir, 'f'));
      const e = thrown(() => openHomeFileForAppend(fifo, 0o600));
      expect(isNotRegularHomeFileError(e)).toBe(true);
      expect((e as Error).message).toBe(NOT_REGULAR);
      expect(lstatSync(fifo).isFIFO()).toBe(true);
      expect(readdirSync(dir)).toEqual(['f']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a FIFO that has a reader (the open succeeds, the fstat refuses) and closes what it opened', () => {
    const dir = tmp();
    try {
      const fifo = mkfifo(join(dir, 'f'));
      const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const before = process.platform === 'linux' ? fdCount() : 0;
        expect(isNotRegularHomeFileError(thrown(() => openHomeFileForAppend(fifo, 0o600)))).toBe(true);
        if (process.platform === 'linux') expect(fdCount()).toBe(before);
      } finally { closeSync(reader); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('lets a directory fail as it does now (EISDIR), not as a typed refusal', () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, 'd'));
      const e = thrown(() => openHomeFileForAppend(join(dir, 'd'), 0o600));
      expect(e).toMatchObject({ code: 'EISDIR' });
      expect(isNotRegularHomeFileError(e)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a UNIX socket (the open fails with ENXIO)', async () => {
    const dir = mkdtempSync('/tmp/hf-');
    const p = join(dir, 's');
    const srv = createServer();
    await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(p, resolve); });
    try {
      expect(isNotRegularHomeFileError(thrown(() => openHomeFileForAppend(p, 0o600)))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('opens through the injected open when one is given, with the flags and the mode it must use', () => {
    const dir = tmp();
    try {
      const seen: Array<{ path: string; flags: number; mode: number }> = [];
      const fd = openHomeFileForAppend(join(dir, 'w.jsonl'), 0o600, (path, flags, mode) => {
        seen.push({ path, flags, mode });
        return openSync(path, flags, mode);
      });
      closeSync(fd);
      expect(seen).toEqual([{
        path: join(dir, 'w.jsonl'),
        flags: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK,
        mode: 0o600,
      }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the registry reads of trust-store-layout go through the helper', () => {
  it('assessGradeLoss opens projects.json twice: the "already established" check and the nonce read', () => {
    // globalNonceAlreadyEstablished (trust-store-layout.ts) and loadRegistry (ownership.ts, via subkeyForScope) each
    // open the registry once per measurement, and measureGradeLoss always calls both. One routed site makes the count 1.
    const base = tmp();
    try {
      const home = join(base, 'home');
      mkdirSync(home, { mode: 0o700 });
      ensureMaster(home);
      expect(typeof globalScopeNonce(home), 'fixture: the registry holds an @global nonce').toBe('string');
      const spy = vi.spyOn(homeFiles, 'openHomeFileForRead');
      try {
        assessGradeLoss(home, join(base, 'memory.jsonl'));
        const opens = spy.mock.calls.filter(([p]) => p === join(home, 'projects.json')).length;
        expect(opens).toBeGreaterThanOrEqual(2);
      } finally { spy.mockRestore(); }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

// ---- B2a task B1 (ruling E, design 4.3): the home's control files and the comparison of a resolved destination with them ----
const hcfBases: string[] = [];
afterAll(() => { for (const b of hcfBases) rmSync(b, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });
/** A real directory (physical path: the resolver answers physical paths) holding a `0700` home. */
function hcf(): { base: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hcf-')));
  hcfBases.push(base);
  const home = join(base, 'home');
  mkdirSync(home, { mode: 0o700 });
  return { base, home };
}
/** Spelled out here, not read from src/: a name added to or dropped from the product's list must fail this file. */
const TEN = ['audit.jsonl', 'sessions.jsonl', 'metrics.jsonl', 'trigger.jsonl', 'codex-log.jsonl', 'witness.json', 'witness-log.jsonl', 'projects.json', 'ledger-mac-master.key', 'config.json'];
const LOCKS = ['memory.jsonl', ...TEN].map((n) => `${n}.lock`);
const HEX32 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';   // 32 hex digits
const HEX16 = '0123456789abcdef';                    // 16 hex digits

describe('HOME_CONTROL_NAMES', () => {
  it('is the ten control files, then the lock name of those ten and of memory.jsonl, and follows OWNED_FILES', () => {
    expect([...HOME_CONTROL_NAMES]).toEqual([...TEN, ...LOCKS]);
    expect(HOME_CONTROL_NAMES).toHaveLength(21);
    expect(HOME_CONTROL_NAMES).not.toContain('memory.jsonl');             // the owner's ledger is the normal path
    expect(OWNED_FILES).toContain('memory.jsonl');
    expect(OWNED_FILES.filter((n) => n !== 'memory.jsonl')).toEqual(TEN); // a persisted file added to OWNED_FILES fails here until the control list names it
  });
  it('holds plain file names only', () => {
    for (const n of HOME_CONTROL_NAMES) expect(n).not.toMatch(/[\\/]/);
  });
});

describe('homeControlFileOf: the path condition (nothing stands at the destination)', () => {
  it.each([...TEN, ...LOCKS])('%s in the home is a control file and is named by itself', (name) => {
    const { home } = hcf();
    expect(readdirSync(home)).toEqual([]);                                // precondition: nothing stands there, so only the path can decide
    expect(homeControlFileOf(home, join(home, name))).toBe(name);
  });

  it.each(['memory.jsonl', 'memory.jsonl.bak', 'projects.jsonl', 'projects.json.bak', 'witness.json.lock.bak', 'config.json.tmp', 'audit.jsonl.1', 'ledger.jsonl', 'sessions.jsonl.lockfile'])('%s in the home is not one (the owner ledger, and names that only look like a control file)', (name) => {
    const { home } = hcf();
    expect(homeControlFileOf(home, join(home, name))).toBeNull();
  });

  it('the owner ledger is not one when it exists either, beside every control file', () => {
    const { home } = hcf();
    for (const n of ['memory.jsonl', ...TEN]) writeFileSync(join(home, n), `${n}\n`);
    expect(homeControlFileOf(home, join(home, 'memory.jsonl'))).toBeNull();
  });

  it.each<[string, string]>([
    ['witness.json', `witness.json.w-${HEX32}.tmp`],
    ['ledger-mac-master.key', `ledger-mac-master.key.k-${HEX32}.tmp`],
    ['config.json', `config.json.lk-${HEX32}.tmp`],
    ['sessions.jsonl', `sessions.jsonl.c-${HEX32}.tmp`],
    ['projects.json', `projects.json.${HEX16}.tmp`],
    ['audit.jsonl', 'audit.jsonl.12345.tmp'],
    ['memory.jsonl', `memory.jsonl.c-${HEX32}.tmp`],
    ['memory.jsonl', `memory.jsonl.lk-${HEX32}.tmp`],
    ['witness.json', 'witness.json.lock.reap.5f3c0a9e-77aa-4c1e-9d3b-0123456789ab'],
  ])('%s: the temporary file %s that Helix mints beside it is a control file, named by the owned file', (stem, file) => {
    const { home } = hcf();
    expect(homeControlFileOf(home, join(home, file))).toBe(stem);
  });

  it('the same name in another directory, or below the home, is not a control file', () => {
    const { base, home } = hcf();
    mkdirSync(join(base, 'elsewhere'));
    mkdirSync(join(home, 'sub'));
    for (const p of [join(base, 'elsewhere', 'projects.json'), join(home, 'sub', 'projects.json'), join(base, 'projects.json'), home, base]) {
      expect(homeControlFileOf(home, p), p).toBeNull();
    }
  });

  it('a home that does not exist yet: its control names are control files by their path, its memory.jsonl is not, and nothing is created', () => {
    const { base } = hcf();
    const home = join(base, 'fresh', 'home');                              // two missing levels
    expect(homeControlFileOf(home, join(home, 'projects.json'))).toBe('projects.json');
    expect(homeControlFileOf(home, join(home, 'witness.json.lock'))).toBe('witness.json.lock');
    expect(homeControlFileOf(home, join(home, 'memory.jsonl'))).toBeNull();
    expect(readdirSync(base)).toEqual(['home']);                            // only the fixture's own home
  });
});

posixOnly('homeControlFileOf: the identity condition and the links', () => {
  it('a second name for a control file (a hard link outside the home) is that control file; a copy with its own inode is not', () => {
    const { base, home } = hcf();
    writeFileSync(join(home, 'witness.json'), '{"v":1}\n');
    linkSync(join(home, 'witness.json'), join(base, 'alias.jsonl'));
    writeFileSync(join(base, 'copy.jsonl'), '{"v":1}\n');                   // same bytes, other inode
    expect(homeControlFileOf(home, join(base, 'alias.jsonl'))).toBe('witness.json');
    expect(homeControlFileOf(home, join(base, 'copy.jsonl'))).toBeNull();
  });

  it('a control file that is itself a link out of the home: its target is that control file', () => {
    const { base, home } = hcf();
    mkdirSync(join(base, 'reg'));
    writeFileSync(join(base, 'reg', 'real-projects.json'), '{}\n');
    symlinkSync(join(base, 'reg', 'real-projects.json'), join(home, 'projects.json'));
    expect(homeControlFileOf(home, join(base, 'reg', 'real-projects.json'))).toBe('projects.json');
  });

  it('a home that is itself a link: the files it reaches are compared at their physical path', () => {
    const { base, home } = hcf();
    const lnk = join(base, 'lnk');
    symlinkSync(home, lnk);
    expect(homeControlFileOf(lnk, join(home, 'witness.json'))).toBe('witness.json');
    expect(homeControlFileOf(lnk, join(home, 'memory.jsonl'))).toBeNull();
    expect(homeControlFileOf(home, join(home, 'witness.json'))).toBe('witness.json');
  });

  it('allow exempts one control file, by path and by identity, and nothing else of its family', () => {
    const { base, home } = hcf();
    writeFileSync(join(home, 'sessions.jsonl'), '');
    writeFileSync(join(home, 'projects.json'), '');
    linkSync(join(home, 'sessions.jsonl'), join(base, 'sessions-alias.jsonl'));
    const allow = { allow: 'sessions.jsonl' };
    expect(homeControlFileOf(home, join(home, 'sessions.jsonl'), allow)).toBeNull();
    expect(homeControlFileOf(home, join(base, 'sessions-alias.jsonl'), allow)).toBeNull();
    expect(homeControlFileOf(home, join(home, 'projects.json'), allow)).toBe('projects.json');
    expect(homeControlFileOf(home, join(home, 'sessions.jsonl.lock'), allow)).toBe('sessions.jsonl.lock');
    expect(homeControlFileOf(home, join(home, `sessions.jsonl.w-${HEX32}.tmp`), allow)).toBe('sessions.jsonl');
    expect(homeControlFileOf(home, join(home, 'sessions.jsonl'))).toBe('sessions.jsonl');   // without allow it is one
  });

  it('a file system that reports inode 0 (decision 9): two different files are never one, a hard link goes unseen, and the path still decides', () => {
    const { base, home } = hcf();
    writeFileSync(join(home, 'projects.json'), '{}\n');
    writeFileSync(join(base, 'relocated.jsonl'), '');
    linkSync(join(home, 'projects.json'), join(base, 'alias.jsonl'));
    expect(homeControlFileOf(home, join(base, 'alias.jsonl'))).toBe('projects.json');   // control: with real inodes the hard link is seen
    const real = pathIdentityMod.fileIdentityAt;
    vi.spyOn(pathIdentityMod, 'fileIdentityAt').mockImplementation((p, o) => {
      const id = real(p, o);
      return id === null ? null : { dev: id.dev, ino: 0n };                           // every existing file answers inode 0 on one device
    });
    expect(homeControlFileOf(home, join(base, 'relocated.jsonl'))).toBeNull();        // a naive device-and-inode compare calls these equal
    expect(homeControlFileOf(home, join(base, 'alias.jsonl'))).toBeNull();            // without an inode a hard link cannot be told
    expect(homeControlFileOf(home, join(home, 'projects.json'))).toBe('projects.json'); // the path condition needs no inode
  });

  it('never throws, whatever the strings are', () => {
    const { home } = hcf();
    const odd = ['', '.', '/', 'a//b/../c', 'x'.repeat(5000)];
    for (const o of odd) expect(() => homeControlFileOf(home, o), `resolved ${o.slice(0, 8)}`).not.toThrow();
    for (const o of odd) expect(() => homeControlFileOf(o, join(home, 'projects.json')), `home ${o.slice(0, 8)}`).not.toThrow();
    writeFileSync(join(home, 'afile'), '');
    expect(() => homeControlFileOf(join(home, 'afile'), join(home, 'afile', 'projects.json'))).not.toThrow();
  });
});

// Segment B disposition item 6 (with Segment A open item 11): the win32 branch, selected by `platform` so it runs on every host
// (precedent: interpretWhereOutput in src/verify/codex.ts). Pure path cases: nothing stands at these names on the test host, so
// the identity condition answers null and only the path condition decides.
describe('homeControlFileOf on win32: the path condition after path.win32 normalisation', () => {
  const W = { platform: 'win32' } as const;
  const H = 'C:\\Users\\k\\.helix';

  it.each([...TEN, ...LOCKS])('%s in the home is a control file and is named by itself', (name) => {
    expect(homeControlFileOf(H, `${H}\\${name}`, W)).toBe(name);
  });

  it('separators, a trailing separator, `.` and `..` are normalised on both sides', () => {
    expect(homeControlFileOf(H, 'C:/Users/k/.helix/projects.json', W)).toBe('projects.json');
    expect(homeControlFileOf(`${H}\\`, `${H}\\.\\witness.json`, W)).toBe('witness.json');
    expect(homeControlFileOf(H, `${H}\\sub\\..\\config.json`, W)).toBe('config.json');
    expect(homeControlFileOf('C:/Users/k/.helix', `${H}/witness.json.lock`, W)).toBe('witness.json.lock');   // the mixed shape resolvePath's `/` join gives there
  });

  it('the owner ledger, another folder, another drive and names that only look like a control file are not one', () => {
    for (const p of [`${H}\\memory.jsonl`, 'C:\\Users\\k\\projects.json', `${H}\\sub\\projects.json`, `${H}\\projects.json.bak`, 'D:\\Users\\k\\.helix\\projects.json']) {
      expect(homeControlFileOf(H, p, W), p).toBeNull();
    }
  });

  it('the temporary-file shapes and allow behave as on POSIX', () => {
    expect(homeControlFileOf(H, `${H}\\witness.json.w-${HEX32}.tmp`, W)).toBe('witness.json');
    expect(homeControlFileOf(H, `${H}\\projects.json.${HEX16}.tmp`, W)).toBe('projects.json');
    expect(homeControlFileOf(H, `${H}\\sessions.jsonl`, { ...W, allow: 'sessions.jsonl' })).toBeNull();
    expect(homeControlFileOf(H, `${H}\\sessions.jsonl.lock`, { ...W, allow: 'sessions.jsonl' })).toBe('sessions.jsonl.lock');
  });

  it('never throws, whatever the strings are', () => {
    for (const o of ['', '.', '\\', 'C:', 'a\\\\b\\..\\c', 'x'.repeat(5000)]) {
      expect(() => homeControlFileOf(H, o, W), `resolved ${o.slice(0, 8)}`).not.toThrow();
      expect(() => homeControlFileOf(o, `${H}\\projects.json`, W), `home ${o.slice(0, 8)}`).not.toThrow();
    }
  });
});
