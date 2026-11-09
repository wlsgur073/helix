import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { hardenHomePermissions, isSymlinkedHome, ensureHelixDir } from '../../src/memory/home-permissions.js';

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

// Third fix batch B2a, task A6 (IT-M7, rulings A and B): the startup pass takes group and other access away and gives
// nothing; the line names the mode it set; and a write path that ran first no longer hides the line (IT-LOW 17).
const oct = (m: number): string => `0${(m & 0o777).toString(8).padStart(3, '0')}`;
const startupLine = (home: string, from: number, to: number): string =>
  `helix: tightened HELIX_HOME ${home} from ${oct(from)} to ${oct(to)} `
  + '(group and other access to the home was removed; another local user could otherwise read or replace files inside it)';
const fullModeOf = (p: string): number => statSync(p).mode & 0o7777;

describe('hardenHomePermissions: only group and other bits go (rulings A and B)', () => {
  // The last row (fix pass 2026-11-08, disposition 4) pins ruling B read literally: a home with group bits and no owner bit
  // loses every bit, 0070 to 0000, and the line says so. A later change to the mask is then a decision, not an accident.
  const rows: Array<{ from: number; to: number }> = [
    { from: 0o555, to: 0o500 }, { from: 0o550, to: 0o500 }, { from: 0o755, to: 0o700 }, { from: 0o750, to: 0o700 },
    { from: 0o775, to: 0o700 }, { from: 0o777, to: 0o700 }, { from: 0o1777, to: 0o700 }, { from: 0o2775, to: 0o700 },
    { from: 0o070, to: 0o000 },
  ];
  for (const { from, to } of rows) {
    it(`a ${from.toString(8)} home becomes ${to.toString(8)} and the line says ${oct(to)}`, () => {
      if (platform() === 'win32') return;
      const home = tmpHome();
      try {
        chmodSync(home, from);
        expect(fullModeOf(home), 'premise').toBe(from);
        const warnings: string[] = [];
        hardenHomePermissions(home, { warn: (m) => warnings.push(m) });
        expect(fullModeOf(home)).toBe(to);
        expect(warnings).toEqual([startupLine(home, from, to)]);
      } finally { chmodSync(home, 0o700); rmSync(home, { recursive: true, force: true }); }
    });
  }

  it('control: homes with no group or other bit are silent and unchanged (0700, and the read-only 0500)', () => {
    if (platform() === 'win32') return;
    for (const m of [0o700, 0o500]) {
      const home = tmpHome();
      try {
        chmodSync(home, m);
        const warnings: string[] = [];
        hardenHomePermissions(home, { warn: (w) => warnings.push(w) });
        expect(warnings, m.toString(8)).toEqual([]);
        expect(fullModeOf(home), m.toString(8)).toBe(m);
      } finally { chmodSync(home, 0o700); rmSync(home, { recursive: true, force: true }); }
    }
  });

  it('a 0555 home still gets its loose files repaired, after the home line', () => {
    if (platform() === 'win32') return;
    const home = tmpHome();
    try {
      writeFileSync(join(home, 'memory.jsonl'), '{}\n');
      chmodSync(join(home, 'memory.jsonl'), 0o664);
      chmodSync(home, 0o555);
      const warnings: string[] = [];
      hardenHomePermissions(home, { warn: (m) => warnings.push(m) });
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toBe(startupLine(home, 0o555, 0o500));
      expect(warnings[1]).toContain(join(home, 'memory.jsonl'));
      expect(modeOf(join(home, 'memory.jsonl'))).toBe(0o600);
      expect(fullModeOf(home)).toBe(0o500);
    } finally { chmodSync(home, 0o700); rmSync(home, { recursive: true, force: true }); }
  });

  // Final review G7 (owner, 2026-11-09, ruling B): the file part of the pass removes group and other bits and adds nothing,
  // as the directory part does, so a file without the owner's write permission stays without it.
  const fileRows: Array<{ from: number; to: number }> = [
    { from: 0o444, to: 0o400 }, { from: 0o440, to: 0o400 }, { from: 0o404, to: 0o400 }, { from: 0o040, to: 0o000 },
    { from: 0o644, to: 0o600 }, { from: 0o664, to: 0o600 }, { from: 0o666, to: 0o600 },
  ];
  for (const { from, to } of fileRows) {
    it(`a ${from.toString(8).padStart(3, '0')} home file becomes ${to.toString(8).padStart(3, '0')} and the line names the mode set`, () => {
      if (platform() === 'win32') return;
      const home = tmpHome();
      const file = join(home, 'memory.jsonl');
      try {
        writeFileSync(file, '{}\n');
        chmodSync(file, from);
        expect(fullModeOf(file), 'premise').toBe(from);
        const warnings: string[] = [];
        hardenHomePermissions(home, { warn: (m) => warnings.push(m) });
        expect(fullModeOf(file)).toBe(to);
        expect(warnings).toEqual([`helix: tightened ${file} from 0${from.toString(8)} to ${oct(to)}`]);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  }

  it('a read-only home (0555) of read-only files (0444): the home becomes 0500, every file 0400, none gains owner write', () => {
    if (platform() === 'win32') return;
    const home = tmpHome();
    const names = ['memory.jsonl', 'metrics.jsonl', 'witness.json', 'config.json', 'ledger-mac-master.key'];
    try {
      for (const n of names) { writeFileSync(join(home, n), 'x'); chmodSync(join(home, n), 0o444); }
      chmodSync(home, 0o555);
      const warnings: string[] = [];
      hardenHomePermissions(home, { warn: (m) => warnings.push(m) });
      expect(fullModeOf(home)).toBe(0o500);
      for (const n of names) expect(fullModeOf(join(home, n)), n).toBe(0o400);
      expect(warnings).toHaveLength(1 + names.length);
      for (const w of warnings.slice(1)) expect(w).toMatch(/ from 0444 to 0400$/);
    } finally { chmodSync(home, 0o700); rmSync(home, { recursive: true, force: true }); }
  });

  it('IT-LOW 17: a write path that runs first leaves a 0777 home as it is, so the startup pass names the repair', () => {
    if (platform() === 'win32') return;
    const home = tmpHome();
    try {
      chmodSync(home, 0o777);
      ensureHelixDir(home);                                    // what a hook or a tool call does before the server starts
      expect(fullModeOf(home)).toBe(0o777);
      const warnings: string[] = [];
      hardenHomePermissions(home, { warn: (m) => warnings.push(m) });
      expect(warnings).toEqual([startupLine(home, 0o777, 0o700)]);
      expect(fullModeOf(home)).toBe(0o700);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
