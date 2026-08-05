import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { hardenHomePermissions } from '../../src/memory/home-permissions.js';

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
