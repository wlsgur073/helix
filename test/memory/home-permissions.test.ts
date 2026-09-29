import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { hardenHomePermissions, isSymlinkedHome } from '../../src/memory/home-permissions.js';

// Creation-time modes fix new files only. Everything a shipped version already wrote keeps the mode
// it was born with, so a creation-only fix leaves every existing install untouched — including the
// developer box, where all five over-broad files predated the fix.
//
// The directory matters more than the files: POSIX puts unlink permission on the PARENT, so a 0600
// master key inside a 0775 directory can still be replaced wholesale by any group member. A
// file-mode-only fix does not close the finding.

const tmpHome = (): string => mkdtempSync(join(tmpdir(), 'helix-perm-'));
const modeOf = (p: string): number => statSync(p).mode & 0o777;

describe('hardenHomePermissions', () => {
  it('tightens a group-writable HELIX_HOME directory to owner-only', () => {
    if (platform() === 'win32') return;
    const home = tmpHome();
    try {
      chmodSync(home, 0o775);
      const warnings: string[] = [];
      hardenHomePermissions(home, { warn: (m) => warnings.push(m) });
      expect(modeOf(home)).toBe(0o700);
      expect(warnings).toHaveLength(1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('repairs an over-broad legacy file and warns once per path', () => {
    if (platform() === 'win32') return;
    const home = tmpHome();
    try {
      for (const f of ['memory.jsonl', 'audit.jsonl', 'sessions.jsonl']) {
        writeFileSync(join(home, f), '{}\n');
        chmodSync(join(home, f), 0o664);
      }
      const warnings: string[] = [];
      hardenHomePermissions(home, { warn: (m) => warnings.push(m) });
      for (const f of ['memory.jsonl', 'audit.jsonl', 'sessions.jsonl']) expect(modeOf(join(home, f))).toBe(0o600);
      expect(warnings).toHaveLength(3);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('is silent and idempotent when everything is already owner-only', () => {
    if (platform() === 'win32') return;
    const home = tmpHome();
    try {
      chmodSync(home, 0o700);
      writeFileSync(join(home, 'memory.jsonl'), '{}\n', { mode: 0o600 });
      const warnings: string[] = [];
      hardenHomePermissions(home, { warn: (m) => warnings.push(m) });
      hardenHomePermissions(home, { warn: (m) => warnings.push(m) });
      expect(warnings).toEqual([]);
      expect(modeOf(join(home, 'memory.jsonl'))).toBe(0o600);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('refuses to chmod through a symlink and reports it instead', () => {
    if (platform() === 'win32') return;
    const home = tmpHome();
    const outside = tmpHome();
    try {
      const victim = join(outside, 'victim');
      writeFileSync(victim, 'not helix data\n', { mode: 0o644 });
      symlinkSync(victim, join(home, 'memory.jsonl'));
      const warnings: string[] = [];
      hardenHomePermissions(home, { warn: (m) => warnings.push(m) });
      // The symlink target must be untouched: a repair pass that follows links is an arbitrary-chmod
      // primitive for anyone who can create a name inside HELIX_HOME.
      expect(modeOf(victim)).toBe(0o644);
      expect(warnings.join(' ')).toMatch(/symlink|not a regular file/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('never touches a project .helix tree — those are boundary-writable by design', () => {
    if (platform() === 'win32') return;
    const home = tmpHome();
    const project = tmpHome();
    try {
      const projHelix = join(project, '.helix');
      mkdirSync(projHelix);
      writeFileSync(join(projHelix, 'memory.jsonl'), '{}\n');
      chmodSync(join(projHelix, 'memory.jsonl'), 0o664);
      hardenHomePermissions(home, { warn: () => {} });
      expect(modeOf(join(projHelix, 'memory.jsonl'))).toBe(0o664);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('never throws — a repair failure must not break startup', () => {
    if (platform() === 'win32') return;
    expect(() => hardenHomePermissions('/nonexistent/helix/home', { warn: () => {} })).not.toThrow();
  });
});

describe('a symlinked HELIX_HOME (IT-H2)', () => {
  it('hardenHomePermissions warns once when the home itself is a symlink, and does not throw', () => {
    if (platform() === 'win32') return;
    const base = tmpHome();
    try {
      const real = join(base, 'real');
      mkdirSync(real, { mode: 0o700 });
      const link = join(base, 'link');
      symlinkSync(real, link);
      const warnings: string[] = [];
      hardenHomePermissions(link, { warn: (m) => warnings.push(m) });
      expect(warnings.filter((w) => w.includes('is a symlink') && w.includes('refuses to write through it'))).toHaveLength(1);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('isSymlinkedHome is true only for a symlink standing at the home path', () => {
    if (platform() === 'win32') return;
    const base = tmpHome();
    try {
      const real = join(base, 'real');
      mkdirSync(real);
      const link = join(base, 'link');
      symlinkSync(real, link);
      expect(isSymlinkedHome(link)).toBe(true);
      expect(isSymlinkedHome(real)).toBe(false);
      expect(isSymlinkedHome(join(base, 'absent'))).toBe(false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('a trailing slash on the symlinked home is detected and warned about the same way', () => {
    if (platform() === 'win32') return;
    const base = tmpHome();
    try {
      const real = join(base, 'real');
      mkdirSync(real, { mode: 0o700 });
      const link = join(base, 'link');
      symlinkSync(real, link);
      expect(isSymlinkedHome(link + '/')).toBe(true);
      const warnings: string[] = [];
      hardenHomePermissions(link + '/', { warn: (m) => warnings.push(m) });
      expect(warnings.filter((w) => w.includes('is a symlink') && w.includes('refuses to write through it'))).toHaveLength(1);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // The warning says Helix will not write through the link, so the per-file repair must not reach
  // through it either: the loop used to chmod every over-broad Helix file behind the link to 0600,
  // in the same call that printed the warning.
  it('chmods nothing behind a symlinked home, spelled with or without a trailing slash', () => {
    if (platform() === 'win32') return;
    const base = tmpHome();
    try {
      const real = join(base, 'real');
      mkdirSync(real, { mode: 0o700 });
      writeFileSync(join(real, 'memory.jsonl'), '{}\n');
      chmodSync(join(real, 'memory.jsonl'), 0o644);
      writeFileSync(join(real, 'config.json'), '{}\n');
      chmodSync(join(real, 'config.json'), 0o664);
      const link = join(base, 'link');
      symlinkSync(real, link);
      for (const home of [link, link + '/']) {
        const warnings: string[] = [];
        hardenHomePermissions(home, { warn: (m) => warnings.push(m) });
        expect(modeOf(join(real, 'memory.jsonl')), home).toBe(0o644);
        expect(modeOf(join(real, 'config.json')), home).toBe(0o664);
        expect(warnings, home).toHaveLength(1);
        expect(warnings[0], home).toContain('is a symlink');
        expect(warnings.filter((w) => w.includes('tightened')), home).toEqual([]);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
