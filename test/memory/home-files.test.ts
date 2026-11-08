// B2a task A8 (J2): the two non-blocking open helpers for the files Helix keeps in its home, and the typed
// refusal they raise. The helpers never block on a FIFO, so these cases run in-process; the call sites are
// proved in test/memory/home-fifo-sites.test.ts, in a child with a deadline, because a site that still uses a
// plain open blocks a synchronous open(2) that no vitest timeout can interrupt.
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openHomeFileForRead, openHomeFileForAppend, NotRegularHomeFileError, isNotRegularHomeFileError,
} from '../../src/memory/home-files.js';
import * as homeFiles from '../../src/memory/home-files.js';
import { assessGradeLoss } from '../../src/memory/trust-store-layout.js';
import { ensureMaster } from '../../src/memory/ledger-mac.js';
import { globalScopeNonce } from '../../src/memory/ownership.js';

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
