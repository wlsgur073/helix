// Third fix batch B2a, task A6 (design 4.6): the four refusals of ensureHelixDir are the typed home refusal, with the
// texts they have always had. Everything else it throws stays a raw fs error.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, chmodSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { ensureHelixDir } from '../../src/memory/home-permissions.js';
import { isHomeRefusalError } from '../../src/memory/home-env.js';

type Thrown = Error & { homeRefusalCause?: string; code?: string };
const thrown = (f: () => unknown): Thrown | undefined => { try { f(); } catch (e) { return e as Thrown; } return undefined; };
const tmp = (): string => mkdtempSync(join(tmpdir(), 'helix-ehd-'));
const posix = platform() !== 'win32';

describe.skipIf(!posix)('ensureHelixDir: typed refusals with their present texts', () => {
  it('a symlink where the directory belongs: cause symlinked-home', () => {
    const base = tmp(); const elsewhere = join(base, 'other'); mkdirSync(elsewhere);
    const home = join(base, '.helix'); symlinkSync(elsewhere, home);
    const e = thrown(() => ensureHelixDir(home));
    expect(isHomeRefusalError(e)).toBe(true);
    expect(e?.homeRefusalCause).toBe('symlinked-home');
    expect(e?.message).toBe(`refusing to use ${home}: it is a symlink, not a directory Helix owns`);
    rmSync(base, { recursive: true, force: true });
  });

  it('a plain file where the directory belongs: cause not-a-directory', () => {
    const base = tmp(); const home = join(base, '.helix'); writeFileSync(home, 'x');
    const e = thrown(() => ensureHelixDir(home));
    expect(isHomeRefusalError(e)).toBe(true);
    expect(e?.homeRefusalCause).toBe('not-a-directory');
    expect(e?.message).toBe(`refusing to use ${home}: it exists and is not a directory`);
    rmSync(base, { recursive: true, force: true });
  });

  it('a directory of another user: cause foreign-owner, and its mode is not touched', () => {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const base = tmp(); const home = join(base, '.helix'); mkdirSync(home, { mode: 0o700 }); chmodSync(home, 0o755);
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);   // IT-M7 X4: no second uid without root
    try {
      const e = thrown(() => ensureHelixDir(home));
      expect(isHomeRefusalError(e)).toBe(true);
      expect(e?.homeRefusalCause).toBe('foreign-owner');
      expect(e?.message).toBe(`refusing to use ${home}: it is owned by uid ${uid}, not by this user (${uid + 1})`);
      expect(statSync(home).mode & 0o777).toBe(0o755);
    } finally { spy.mockRestore(); }
    rmSync(base, { recursive: true, force: true });
  });

  it('a missing parent: cause parent-missing, and no chain is created', () => {
    const base = tmp(); const parent = join(base, 'missing'); const home = join(parent, '.helix');
    const e = thrown(() => ensureHelixDir(home));
    expect(isHomeRefusalError(e)).toBe(true);
    expect(e?.homeRefusalCause).toBe('parent-missing');
    expect(e?.message).toBe(`refusing to create ${home}: its parent ${parent} does not exist (Helix creates one directory, never a chain)`);
    rmSync(base, { recursive: true, force: true });
  });

  it.skipIf(process.getuid?.() === 0)('control: a parent that cannot be written is not a home refusal; the fs error passes through (EACCES)', () => {
    const base = tmp(); chmodSync(base, 0o500);
    try {
      const e = thrown(() => ensureHelixDir(join(base, '.helix')));
      expect(e?.code).toBe('EACCES');
      expect(isHomeRefusalError(e)).toBe(false);
    } finally { chmodSync(base, 0o700); rmSync(base, { recursive: true, force: true }); }
  });
});
