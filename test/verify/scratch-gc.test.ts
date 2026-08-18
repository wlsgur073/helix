import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  selectStaleScratch, shouldSweep, sweepScratchRoot, ensureScratchRoot,
  FLOOR_MS, SWEEP_INTERVAL_MS, STAMP_NAME,
} from '../../src/verify/scratch-gc.js';

describe('selectStaleScratch (pure)', () => {
  const now = 10_000_000_000;
  it('selects codex- dirs at least floorMs old', () => {
    const entries = [
      { name: 'codex-old', isDir: true, mtimeMs: now - FLOOR_MS - 1 },
      { name: 'codex-edge', isDir: true, mtimeMs: now - FLOOR_MS },     // exactly floor -> stale
      { name: 'codex-fresh', isDir: true, mtimeMs: now - 1000 },
    ];
    expect(selectStaleScratch(entries, now, FLOOR_MS).sort()).toEqual(['codex-edge', 'codex-old']);
  });
  it('skips future-dated, non-codex names, and non-directories', () => {
    const entries = [
      { name: 'codex-future', isDir: true, mtimeMs: now + 5000 },
      { name: 'other-old', isDir: true, mtimeMs: now - FLOOR_MS - 1 },
      { name: 'codex-file', isDir: false, mtimeMs: now - FLOOR_MS - 1 },
    ];
    expect(selectStaleScratch(entries, now, FLOOR_MS)).toEqual([]);
  });
});

describe('shouldSweep (pure)', () => {
  const now = 10_000_000_000;
  it('sweeps when no stamp, when older than interval, and when the stamp is in the future', () => {
    expect(shouldSweep(null, now, SWEEP_INTERVAL_MS)).toBe(true);
    expect(shouldSweep(now - SWEEP_INTERVAL_MS, now, SWEEP_INTERVAL_MS)).toBe(true);
    expect(shouldSweep(now + 10_000, now, SWEEP_INTERVAL_MS)).toBe(true);
  });
  it('skips when the stamp is younger than the interval', () => {
    expect(shouldSweep(now - 1000, now, SWEEP_INTERVAL_MS)).toBe(false);
  });
});

describe('sweepScratchRoot (IO, best-effort)', () => {
  const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;
  it('removes stale codex- dirs, keeps fresh + non-codex + codex- files, writes the stamp', () => {
    const root = mkdtempSync(join(tmpdir(), 'helix-gctest-'));
    const now = Date.now();
    const old = join(root, 'codex-old'); mkdirSync(old);
    utimesSync(old, new Date(now - FOUR_DAYS_MS), new Date(now - FOUR_DAYS_MS));
    const fresh = join(root, 'codex-fresh'); mkdirSync(fresh);
    const other = join(root, 'other-keep'); mkdirSync(other);
    const file = join(root, 'codex-file'); writeFileSync(file, 'x');
    utimesSync(file, new Date(now - FOUR_DAYS_MS), new Date(now - FOUR_DAYS_MS));

    sweepScratchRoot(root, now);

    expect(existsSync(old)).toBe(false);    // stale dir -> removed
    expect(existsSync(fresh)).toBe(true);   // fresh dir -> kept
    expect(existsSync(other)).toBe(true);   // non-codex -> kept
    expect(existsSync(file)).toBe(true);    // codex- FILE (not a dir) -> kept
    expect(existsSync(join(root, STAMP_NAME))).toBe(true);
  });
  it('is rate-limited by a fresh stamp (skips the readdir/delete entirely)', () => {
    const root = mkdtempSync(join(tmpdir(), 'helix-gctest-'));
    const now = Date.now();
    writeFileSync(join(root, STAMP_NAME), '');
    // Back-date the stamp into the recent past, as production does (the stamp is written at the end
    // of one sweep and read at the start of a strictly later call). A stamp written in the same
    // millisecond as `now` has a fractional-ms mtime > integer-ms `now`, which the future-guard
    // would (correctly) treat as a future stamp. This keeps the test skew-immune.
    utimesSync(join(root, STAMP_NAME), new Date(now - 1000), new Date(now - 1000));
    const old = join(root, 'codex-old'); mkdirSync(old);
    utimesSync(old, new Date(now - FOUR_DAYS_MS), new Date(now - FOUR_DAYS_MS));
    sweepScratchRoot(root, now);
    expect(existsSync(old)).toBe(true); // fresh stamp -> not swept this call
  });
  it('a missing root is a no-op and never throws', () => {
    expect(() => sweepScratchRoot(join(tmpdir(), 'helix-gctest-does-not-exist-zzz'), Date.now())).not.toThrow();
  });
});

// F9: the stamp is written at a FIXED path under a shared, world-writable temp root, so on a shared
// host another local user can pre-create <temp>/helix and plant .gc-stamp as a symlink pointing at
// something of ours. writeFileSync FOLLOWS symlinks, so the victim's next dual-verify run truncated
// the target to zero bytes. The rest of this module already refuses to follow links — the sweep
// classifies entries with lstat "never follow it" — so this was the one site the rule was not
// applied at.
const posixOnly = describe.skipIf(process.platform === 'win32');
posixOnly('stamp publication never follows a planted symlink', () => {
  const plantedStampOver = (victimBody: string): { root: string; victim: string } => {
    const root = mkdtempSync(join(tmpdir(), 'helix-gcsquat-'));
    const victim = join(mkdtempSync(join(tmpdir(), 'helix-gcvictim-')), 'ledger.jsonl');
    writeFileSync(victim, victimBody);
    // Age the victim: the rate-limit stats the stamp PATH, which follows the link to the victim, so
    // a freshly written victim would make shouldSweep decline and the write would never be reached.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(victim, old, old);
    symlinkSync(victim, join(root, STAMP_NAME));
    return { root, victim };
  };

  it('leaves the symlink target byte-identical', () => {
    const body = 'IMPORTANT USER DATA\n';
    const { root, victim } = plantedStampOver(body);
    sweepScratchRoot(root);
    expect(readFileSync(victim, 'utf8')).toBe(body);
  });

  it('replaces the planted link with a real stamp, so the squat does not survive the run', () => {
    const { root } = plantedStampOver('IMPORTANT USER DATA\n');
    sweepScratchRoot(root);
    expect(lstatSync(join(root, STAMP_NAME)).isSymbolicLink()).toBe(false);
  });
});

// The other half of F9: the scratch ROOT is a fixed name directly under a 1777 temp dir, and it was
// created with `mkdirSync(root, {recursive:true})` — no mode. Two consequences. A root we create is
// world-readable and world-traversable, and a root that ALREADY EXISTS is adopted unexamined, which
// is the actual attack: mkdirSync's mode argument does nothing to a directory somebody else made
// first. So the mode has to be asserted on creation AND the existing directory has to be inspected.
posixOnly('scratch root is owner-only, and an existing one is inspected rather than trusted', () => {
  const modeOf = (p: string): number => lstatSync(p).mode & 0o777;

  it('creates a missing root owner-only', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'helix-rootnew-')), 'helix');
    expect(ensureScratchRoot(root)).toBe(root);
    expect(modeOf(root)).toBe(0o700);
  });

  it('hardens an existing root of ours that is too permissive, rather than adopting it as found', () => {
    // mkdirSync's mode is ignored for an existing directory, so this is the state a pre-creating
    // local user leaves behind — and the state an older version of this code left behind too.
    const root = join(mkdtempSync(join(tmpdir(), 'helix-rootperm-')), 'helix');
    mkdirSync(root, { mode: 0o777 });
    expect(ensureScratchRoot(root)).toBe(root);
    expect(modeOf(root)).toBe(0o700);
  });

  it('refuses a symlink standing in for the root', () => {
    const base = mkdtempSync(join(tmpdir(), 'helix-rootlink-'));
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    const root = join(base, 'helix');
    symlinkSync(elsewhere, root);
    expect(ensureScratchRoot(root)).toBeNull();
  });

  it('refuses a plain file squatting the root name', () => {
    const base = mkdtempSync(join(tmpdir(), 'helix-rootfile-'));
    const root = join(base, 'helix');
    writeFileSync(root, '');
    expect(ensureScratchRoot(root)).toBeNull();
  });

  // F9.d — the one vetting conjunct nothing reached: a root owned by ANOTHER uid. Every root the
  // cases above builds is ours, and an unprivileged suite cannot create a foreign-owned directory, so
  // deleting `st.uid !== process.getuid()` left the whole suite green (measured, kills=0).
  //
  // It needs no seam. The branch takes a plain path, and the host already has directories owned by
  // somebody else. Restricting the candidates to modes with NO group or other bits is a SAFETY
  // property, not a stylistic one: the statement immediately after the refusal is
  // `chmodSync(root, 0o700)`, so a candidate like /tmp (mode 1777) would be MODIFIED by this test the
  // moment the guard it measures is removed. A test must never be able to damage the host when the
  // code under measurement is mutated, and the mode-unchanged assertion states that rather than
  // trusting it.
  //
  // The same predicate handles the run-as-root case without a separate check: as uid 0 all three
  // candidates are ours, none qualifies, and the case skips. That is deliberate — the foreign-owned
  // directories available to root are ordinary user directories, whose modes DO carry group and other
  // bits, so selecting one would reintroduce exactly the hazard the mode restriction removes.
  const foreign = ['/root', '/etc/ssl/private', '/var/lib/private'].find((c) => {
    try {
      const st = lstatSync(c);
      return st.isDirectory() && st.uid !== process.getuid?.() && (st.mode & 0o077) === 0;
    } catch { return false; }                          // absent on this host
  });

  it.skipIf(!foreign)('refuses a root owned by another uid, and does not touch it (F9.d)', () => {
    const root = foreign!;
    expect(lstatSync(root).uid, 'the candidate is no longer somebody else\'s').not.toBe(process.getuid?.());
    const before = lstatSync(root).mode;

    expect(ensureScratchRoot(root)).toBeNull();

    // Refused BEFORE the hardening step, which is the point of the ordering: a corral we do not own
    // must be neither adopted nor repaired. On this candidate chmod would be skipped anyway, so this
    // asserts the invariant the candidate rule relies on rather than the branch itself — if a future
    // edit reorders the vetting, the test that proves the reorder is safe is this line.
    expect(lstatSync(root).mode).toBe(before);
  });
});
