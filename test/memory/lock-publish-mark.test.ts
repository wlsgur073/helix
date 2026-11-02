// Third fix batch B1, task B1 (design 4.3 step 2; 13.3 decision 5): LockContext.path, and the mark that tells a lock
// whose PUBLICATION was refused (EACCES, EROFS) from an error raised inside the held section. No test can stand on a
// read-only file system, so the two errnos a mode bit cannot give come from a file-wide mock of linkSync, in the form of
// A7's lock-absent-publish.test.ts. With no errno armed it passes through, so the other cases see the real call.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, symlinkSync, chmodSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooks = vi.hoisted(() => ({ linkErrno: null as string | null }));   // armed: the publication's linkSync fails with this code
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    linkSync: (src: unknown, dest: unknown) => {
      if (hooks.linkErrno !== null && typeof dest === 'string' && dest.endsWith('.lock')) throw Object.assign(new Error(`${hooks.linkErrno}: injected`), { code: hooks.linkErrno });
      return (real.linkSync as (...a: unknown[]) => unknown)(src, dest);
    },
  };
});
import { withFileLock, isLockPublishRefusedError } from '../../src/memory/lock.js';

const made: string[] = [];
afterEach(() => { hooks.linkErrno = null; for (const d of made.splice(0)) { try { chmodSync(d, 0o700); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } });
const dir = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'lpm-'))); made.push(d); return d; };
const AS_ROOT = process.getuid?.() === 0;

describe('LockContext.path', () => {
  it('is the resolved path the lock stands beside, a dangling link included (M67)', () => {
    const d = dir();
    const real = join(d, 'real.jsonl');
    symlinkSync(real, join(d, 'link.jsonl'));
    expect(withFileLock(join(d, 'link.jsonl'), (ctx) => ctx.path)).toBe(real);
  });
});

describe('the publication mark', () => {
  it.skipIf(AS_ROOT)('an EACCES at the publication carries the mark and keeps its code', () => {
    const d = dir();
    chmodSync(d, 0o555);
    let caught: unknown;
    try { withFileLock(join(d, 'x.jsonl'), () => 1); } catch (e) { caught = e; }
    expect(isLockPublishRefusedError(caught)).toBe(true);
    expect((caught as NodeJS.ErrnoException).code).toBe('EACCES');
  });

  it('an EROFS at the publication carries the mark and keeps its code (a read-only file system, design 4.3 step 2)', () => {
    const d = dir();
    hooks.linkErrno = 'EROFS';
    let caught: unknown;
    try { withFileLock(join(d, 'e.jsonl'), () => 1); } catch (e) { caught = e; }
    expect(isLockPublishRefusedError(caught)).toBe(true);
    expect((caught as NodeJS.ErrnoException).code).toBe('EROFS');
  });

  it('an EIO at the publication is not marked: every other errno stays raw (design 4.3 step 5, the paragraph on the texts)', () => {
    const d = dir();
    hooks.linkErrno = 'EIO';
    let caught: unknown;
    try { withFileLock(join(d, 'f.jsonl'), () => 1); } catch (e) { caught = e; }
    expect(isLockPublishRefusedError(caught)).toBe(false);
    expect((caught as NodeJS.ErrnoException).code).toBe('EIO');
  });

  it('an error raised inside the held section is never marked, whatever its code', () => {
    const d = dir();
    let caught: unknown;
    try { withFileLock(join(d, 'y.jsonl'), () => { throw Object.assign(new Error('boom'), { code: 'EACCES' }); }); } catch (e) { caught = e; }
    expect(isLockPublishRefusedError(caught)).toBe(false);
  });
});
