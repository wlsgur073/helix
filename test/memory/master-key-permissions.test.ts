// tryReadMaster tightens an over-broad master key to 0600 on every read — defence in depth for a
// key a shipped version created before creation-time modes existed. Nothing measured it. BOTH halves
// matter: a repair that refused the read instead would be a different and worse behaviour, so the
// test asserts the key is still usable after the repair, not only that the mode moved.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, statSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { ensureMaster, tryReadMaster } from '../../src/memory/ledger-mac.js';
import { isNotRegularHomeFileError } from '../../src/memory/home-files.js';
import { compareStrayMasterKey } from '../../src/memory/trust-store-layout.js';

const mode = (p: string): number => statSync(p).mode & 0o777;
const modeOct = (p: string): string => (statSync(p).mode & 0o777).toString(8);

describe('master key permission self-repair', () => {
  it('tightens an over-broad key to 0600 and still reads it', () => {
    if (platform() === 'win32') return;                  // POSIX mode bits only
    const home = mkdtempSync(join(tmpdir(), 'helix-mkperm-'));
    try {
      const first = ensureMaster(home);                    // mints it
      const keyPath = join(home, 'ledger-mac-master.key');

      chmodSync(keyPath, 0o644);                           // what a pre-mode shipped version left behind
      expect(mode(keyPath)).toBe(0o644);

      const second = ensureMaster(home);                   // reads it back through tryReadMaster
      expect(mode(keyPath)).toBe(0o600);                   // repaired
      expect(second.equals(first)).toBe(true);             // and NOT re-minted: same key bytes
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  // Final review G7 (owner, 2026-11-09, ruling B): the repair removes group and other bits and adds nothing, so a key the
  // user made read-only stays read-only (0444 becomes 0400, not 0600).
  it.each([['0444', 0o444, 0o400], ['0440', 0o440, 0o400], ['0640', 0o640, 0o600]] as const)('a %s key loses its group and other bits on a read, and still reads the same bytes', (_label, from, to) => {
    if (platform() === 'win32') return;
    const home = mkdtempSync(join(tmpdir(), 'helix-mkperm-'));
    try {
      const first = ensureMaster(home);
      const keyPath = join(home, 'ledger-mac-master.key');
      chmodSync(keyPath, from);
      expect(mode(keyPath)).toBe(from);                    // premise
      const again = tryReadMaster(home);
      expect(mode(keyPath)).toBe(to);
      expect(again?.equals(first)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// KEY-CHMOD-LINK (B2a ruling J1): the repair above must stay inside the home. statSync and chmodSync both followed a link, so a
// key that was a symlink to an outside file, or a key behind a symlinked HELIX_HOME, had the target set to 0600 on every read,
// silently. Each case first proves its own precondition (a 32-byte target at 0644, a link at the name) so that a pass cannot be
// vacuous; the outside file keeps 0644 and the read is still served.
describe.skipIf(platform() === 'win32')('master key permission self-repair stays inside the home (KEY-CHMOD-LINK, J1)', () => {
  const KEY = 'ledger-mac-master.key';
  const key32 = Buffer.alloc(32, 7);

  function layout(): { base: string; home: string; outside: string } {
    const base = mkdtempSync(join(tmpdir(), 'helix-mkl-'));
    const home = join(base, 'home');
    mkdirSync(home, { mode: 0o700 });
    const outside = join(base, 'out');
    mkdirSync(outside);
    return { base, home, outside };
  }

  it('a key that is a symlink to an outside file is read and the outside file keeps its mode', () => {
    const { base, home, outside } = layout();
    try {
      const target = join(outside, 'k');
      writeFileSync(target, key32);
      chmodSync(target, 0o644);
      symlinkSync(target, join(home, KEY));
      expect(lstatSync(join(home, KEY)).isSymbolicLink()).toBe(true);
      expect(modeOct(target)).toBe('644');

      expect(tryReadMaster(home)?.equals(key32)).toBe(true);        // the read through the link is unchanged
      expect(modeOct(target)).toBe('644');                          // base: '600'
      expect(ensureMaster(home).equals(key32)).toBe(true);          // adopted, not re-minted
      expect(modeOct(target)).toBe('644');
      expect(lstatSync(join(home, KEY)).isSymbolicLink()).toBe(true);
      expect(readdirSync(home)).toEqual([KEY]);                     // no mint, no tmp
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('a key behind a symlinked home is read and keeps its mode, with and without a trailing slash', () => {
    const { base, home } = layout();
    try {
      const key = join(home, KEY);
      writeFileSync(key, key32);
      chmodSync(key, 0o644);
      const link = join(base, 'link');
      symlinkSync(home, link);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(modeOct(key)).toBe('644');

      for (const spelled of [link, link + '/']) {
        expect(tryReadMaster(spelled)?.equals(key32)).toBe(true);
        expect(modeOct(key)).toBe('644');                           // base: '600'
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('control: an over-broad regular key in an ordinary home is still tightened, however the home is spelled', () => {
    const { base, home } = layout();
    try {
      const key = join(home, KEY);
      writeFileSync(key, key32);
      chmodSync(key, 0o644);
      expect(tryReadMaster(home + '/')?.equals(key32)).toBe(true);
      expect(modeOct(key)).toBe('600');                             // passes at base and at head: the repair itself is kept
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

// Disposition 2 (fix pass 2026-11-08; ruling J1, design goal 3): the stray key beside a relocated ledger is not a file of the
// home, so comparing it with HOME's key never changes its mode, even when it is an ordinary regular file. HOME's own key is
// still repaired by the same call (the control half of the first case).
describe.skipIf(platform() === 'win32')('the stray key beside a relocated ledger keeps its mode (disposition 2, J1)', () => {
  const KEY = 'ledger-mac-master.key';
  const key32 = Buffer.alloc(32, 9);

  it('compareStrayMasterKey reads a regular stray key in an ordinary directory and leaves it 0644; HOME\'s own key is tightened', () => {
    const base = mkdtempSync(join(tmpdir(), 'helix-mks-'));
    try {
      const home = join(base, 'home');
      const ledgerDir = join(base, 'repo');
      mkdirSync(home, { mode: 0o700 });
      mkdirSync(ledgerDir);
      writeFileSync(join(home, KEY), key32);
      chmodSync(join(home, KEY), 0o644);
      writeFileSync(join(ledgerDir, KEY), key32);
      chmodSync(join(ledgerDir, KEY), 0o644);
      expect(lstatSync(join(ledgerDir, KEY)).isFile()).toBe(true);    // precondition: a plain regular file, no link anywhere
      expect(modeOct(join(ledgerDir, KEY))).toBe('644');

      expect(compareStrayMasterKey(home, ledgerDir)).toBe('match');    // the stray key was read: same bytes as HOME's
      expect(modeOct(join(ledgerDir, KEY))).toBe('644');               // base: '600'
      expect(modeOct(join(home, KEY))).toBe('600');                    // HOME's own key: repaired, at base and at head
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('a stray key below a directory link further up the ledger path keeps its mode too', () => {
    const base = mkdtempSync(join(tmpdir(), 'helix-mks-'));
    try {
      const home = join(base, 'home');
      mkdirSync(home, { mode: 0o700 });
      writeFileSync(join(home, KEY), key32, { mode: 0o600 });
      const real = join(base, 'real');
      mkdirSync(join(real, 'sub'), { recursive: true });
      writeFileSync(join(real, 'sub', KEY), key32);
      chmodSync(join(real, 'sub', KEY), 0o644);
      symlinkSync(real, join(base, 'dl'));
      const ledgerDir = join(base, 'dl', 'sub');                       // the link is the parent of the ledger directory, not the directory
      expect(lstatSync(ledgerDir).isSymbolicLink()).toBe(false);       // precondition: a one-level look at the directory sees no link
      expect(lstatSync(join(base, 'dl')).isSymbolicLink()).toBe(true);

      expect(compareStrayMasterKey(home, ledgerDir)).toBe('match');
      expect(modeOct(join(real, 'sub', KEY))).toBe('644');             // base: '600'
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

// Final review G11: a key name that is a link which does not resolve is refused with text 11, never minted around. Before
// the fix the mint either failed with a cause that is not the link ("master key vanished during concurrent mint" when the
// target's folder exists, a raw path-bearing ENOENT from the lock when it does not) or, in a fresh home, created nothing
// the caller could use.
describe.skipIf(platform() === 'win32')('a dangling link at the key name (final review G11)', () => {
  it.each([['absent', false], ['present', true]] as const)('target folder %s: ensureMaster throws text 11 and creates nothing', (_label, folderPresent) => {
    const base = mkdtempSync(join(tmpdir(), 'helix-mkdl-'));
    try {
      const home = join(base, 'h');
      mkdirSync(home, { mode: 0o700 });
      if (folderPresent) mkdirSync(join(base, 'keys'));
      symlinkSync(join(base, 'keys', 'k'), join(home, 'ledger-mac-master.key'));
      const before = { home: readdirSync(home).sort(), base: readdirSync(base).sort() };
      let thrown: unknown;
      try { ensureMaster(home); } catch (e) { thrown = e; }
      expect(isNotRegularHomeFileError(thrown)).toBe(true);
      expect((thrown as Error).message).toBe('A Helix data file is not a regular file.');
      expect(readdirSync(home).sort()).toEqual(before.home);
      expect(readdirSync(base).sort()).toEqual(before.base);
      if (folderPresent) expect(readdirSync(join(base, 'keys'))).toEqual([]);
      expect(lstatSync(join(home, 'ledger-mac-master.key')).isSymbolicLink()).toBe(true);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
