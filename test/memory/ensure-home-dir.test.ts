// S3: HELIX_HOME was created by whichever of seven call sites got there first, every one of them
// `mkdirSync(dir, { recursive: true })` with no mode. A brand-new install therefore ran its ENTIRE
// first session with the home at the umask-derived mode — 0755, or 0775 under umask 002, which is
// group-writable — and was tightened to 0700 only at the NEXT start. POSIX puts unlink permission on
// the PARENT, so a 0600 master key inside a 0775 directory can still be replaced by any group member.
//
// The fix is one initializer every site calls, not a mode argument repeated seven times: the eighth
// site would be the next exposure. Its requirements are behavioural, not locational — trusted
// existing parent, non-recursive create at 0700, and an EEXIST path that validates type, symlink and
// ownership before anything writes a secret inside.
//
// SCOPED TO NEW HOMES, deliberately. A home that already ran group-writable may have had its key or
// registry replaced while it was exposed; tightening the directory afterwards locks those objects in
// rather than restoring trust. That is a separate legacy-remediation question and is NOT closed here.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, statSync, symlinkSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { ensureHelixDir } from '../../src/memory/home-permissions.js';

const mode = (p: string): number => statSync(p).mode & 0o777;
const tmp = (): string => mkdtempSync(join(tmpdir(), 'helix-ensuredir-'));

describe('ensureHelixDir', () => {
  it('creates a missing directory owner-only, whatever the umask would have given it', () => {
    if (platform() === 'win32') return;                 // POSIX mode bits only
    const base = tmp();
    const home = join(base, '.helix');
    const old = process.umask(0o002);                   // the group-writable case S3 names
    try { ensureHelixDir(home); } finally { process.umask(old); }
    expect(mode(home)).toBe(0o700);
    rmSync(base, { recursive: true, force: true });
  });

  it('is a no-op on a directory that is already owner-only', () => {
    const base = tmp();
    const home = join(base, '.helix');
    mkdirSync(home, { mode: 0o700 });
    ensureHelixDir(home);
    expect(mode(home)).toBe(0o700);
    rmSync(base, { recursive: true, force: true });
  });

  it('repairs an over-broad mode on an existing directory', () => {
    if (platform() === 'win32') return;
    const base = tmp();
    const home = join(base, '.helix');
    mkdirSync(home, { mode: 0o700 });
    chmodSync(home, 0o775);                             // what a shipped version already created
    ensureHelixDir(home);
    expect(mode(home)).toBe(0o700);
    rmSync(base, { recursive: true, force: true });
  });

  it('REFUSES a symlink standing where the directory should be', () => {
    if (platform() === 'win32') return;
    const base = tmp();
    const elsewhere = join(base, 'attacker-owned');
    mkdirSync(elsewhere);
    const home = join(base, '.helix');
    symlinkSync(elsewhere, home);                       // planted before Helix ever ran
    expect(() => ensureHelixDir(home)).toThrow(/symlink|not a directory/i);
    rmSync(base, { recursive: true, force: true });
  });

  it('REFUSES a plain file standing where the directory should be', () => {
    const base = tmp();
    const home = join(base, '.helix');
    writeFileSync(home, 'not a directory');
    expect(() => ensureHelixDir(home)).toThrow(/not a directory/i);
    rmSync(base, { recursive: true, force: true });
  });

  it('REFUSES to create when the parent does not exist — no recursive walk over untrusted ancestors', () => {
    const base = tmp();
    const home = join(base, 'missing', 'deeper', '.helix');
    expect(() => ensureHelixDir(home)).toThrow(/parent/i);
    rmSync(base, { recursive: true, force: true });
  });
});

// The finding itself, end to end. Everything above tests the initializer in isolation; this drives a
// REAL first run — a home that does not exist yet, created by whichever site the store reaches first
// — under the umask that made S3 group-writable rather than merely world-readable.
describe('S3: a brand-new HELIX_HOME is owner-only from its first session', () => {
  it('a first commit into a home that did not exist leaves it 0700, not the umask mode', async () => {
    if (platform() === 'win32') return;
    const { MemoryStore } = await import('../../src/memory/store.js');
    const base = tmp();
    const home = join(base, '.helix');            // deliberately absent: this is the first run
    const old = process.umask(0o002);             // 0775 without the fix — group-writable
    try {
      const s = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's1' });
      s.commit({ content: 'the first fact of a brand-new install', source: 'user' });
    } finally { process.umask(old); }
    expect(mode(home)).toBe(0o700);
    rmSync(base, { recursive: true, force: true });
  });
});
