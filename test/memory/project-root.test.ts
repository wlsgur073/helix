import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectLayer } from '../../src/memory/project-root.js';

// Every case keeps the fake home, the working directory and every .helix inside one temp directory,
// and bounds each walk with a fake home inside it, so a stray .helix on the machine running the suite
// (say /tmp/.helix) can never change a result.
const made: string[] = [];
function base(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'helix-proot-')));
  made.push(d);
  return d;
}
function dir(...parts: string[]): string { const d = join(...parts); mkdirSync(d, { recursive: true }); return d; }
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
const globalIn = (home: string): string => join(home, '.helix', 'memory.jsonl');

describe('resolveProjectLayer', () => {
  it("uses the working directory's own .helix unchanged (origin cwd)", () => {
    const b = base(); const home = dir(b, 'home');
    const proj = dir(home, 'proj'); dir(proj, '.helix');
    expect(resolveProjectLayer({ cwd: proj, userHome: home, globalLedger: globalIn(home) }))
      .toEqual({ root: proj, ledger: join(proj, '.helix', 'memory.jsonl'), origin: 'cwd' });
  });

  it('finds the nearest parent project for a session started in a subdirectory (origin ancestor)', () => {
    const b = base(); const home = dir(b, 'home');
    const proj = dir(home, 'proj'); dir(proj, '.helix');
    const sub = dir(proj, 'packages', 'api');
    expect(resolveProjectLayer({ cwd: sub, userHome: home, globalLedger: globalIn(home) }))
      .toEqual({ root: proj, ledger: join(proj, '.helix', 'memory.jsonl'), origin: 'ancestor' });
  });

  it('takes the nearest .helix when several parents have one', () => {
    const b = base(); const home = dir(b, 'home');
    const outer = dir(home, 'outer'); dir(outer, '.helix');
    const inner = dir(outer, 'inner'); dir(inner, '.helix');
    expect(resolveProjectLayer({ cwd: dir(inner, 'sub'), userHome: home, globalLedger: globalIn(home) })?.root).toBe(inner);
  });

  it('never treats the home directory, or anything above it, as a parent project', () => {
    const b = base(); const home = dir(b, 'home');
    dir(home, '.helix'); dir(b, '.helix');
    expect(resolveProjectLayer({ cwd: dir(home, 'a', 'b'), userHome: home, globalLedger: join(b, 'elsewhere.jsonl') })).toBeUndefined();
  });

  it('a session in the home directory itself never walks above it', () => {
    const b = base(); const home = dir(b, 'home'); dir(b, '.helix');
    expect(resolveProjectLayer({ cwd: home, userHome: home, globalLedger: join(b, 'elsewhere.jsonl') })).toBeUndefined();
  });

  it('outside the home directory the walk keeps going upward', () => {
    const b = base(); const home = dir(b, 'home');
    const work = dir(b, 'work'); dir(work, '.helix');
    expect(resolveProjectLayer({ cwd: dir(work, 'a', 'b'), userHome: home, globalLedger: globalIn(home) }))
      .toEqual({ root: work, ledger: join(work, '.helix', 'memory.jsonl'), origin: 'ancestor' });
  });

  it('a .helix that holds the global ledger is the global store, not a project', () => {
    const b = base(); const home = dir(b, 'home');
    const proj = dir(home, 'proj'); dir(proj, '.helix');
    expect(resolveProjectLayer({ cwd: dir(proj, 'sub'), userHome: home, globalLedger: join(proj, '.helix', 'memory.jsonl') })).toBeUndefined();
  });

  // Ruling R6 of the second fix batch is retired by decision D5: a project's memory file that is a LINK
  // to the global ledger, dangling or not, keeps its layer, the cwd's own folder and a parent's alike, and
  // the judgement excludes it (pinned through the server bundle in
  // test/acceptance/global-link-store.e2e.test.ts).
  it.each([['existing', true], ['absent (a dangling link)', false]] as const)(
    'a .helix whose memory file links to the %s global ledger keeps its project layer, for the cwd and for a parent (the judgement excludes it: D5)', (_l, existing) => {
      const b = base(); const home = dir(b, 'home');
      const globalLedger = join(dir(b, 'helixhome'), 'memory.jsonl');
      if (existing) writeFileSync(globalLedger, '');
      const proj = dir(home, 'proj'); dir(proj, '.helix');
      symlinkSync(globalLedger, join(proj, '.helix', 'memory.jsonl'));
      expect(resolveProjectLayer({ cwd: proj, userHome: home, globalLedger })).toEqual({ root: proj, ledger: join(proj, '.helix', 'memory.jsonl'), origin: 'cwd' });
      expect(resolveProjectLayer({ cwd: dir(proj, 'sub'), userHome: home, globalLedger })).toEqual({ root: proj, ledger: join(proj, '.helix', 'memory.jsonl'), origin: 'ancestor' });
    });

  it('returns undefined when no .helix exists below the home boundary', () => {
    const b = base(); const home = dir(b, 'home');
    expect(resolveProjectLayer({ cwd: dir(home, 'a', 'b'), userHome: home, globalLedger: globalIn(home) })).toBeUndefined();
  });

  it('follows the physical parents of a symlinked working directory', () => {
    const b = base(); const home = dir(b, 'home');
    const proj = dir(home, 'real', 'proj'); dir(proj, '.helix');
    const link = join(home, 'link'); symlinkSync(dir(proj, 'sub'), link);
    // Textually link's parent is <home>, which the walk may not check; physically it is <proj>.
    expect(resolveProjectLayer({ cwd: link, userHome: home, globalLedger: globalIn(home) })?.root).toBe(proj);
  });

  // Review focus 3.
  it('a working directory that no longer exists resolves by its textual parents without throwing', () => {
    const b = base(); const home = dir(b, 'home');
    const proj = dir(home, 'proj'); dir(proj, '.helix');
    expect(resolveProjectLayer({ cwd: join(proj, 'deleted', 'deeper'), userHome: home, globalLedger: globalIn(home) })?.root).toBe(proj);
  });

  // Review focus 4.
  it('a home directory given through a symlink still bounds the walk', () => {
    const b = base(); const realHome = dir(b, 'realhome'); dir(realHome, '.helix');
    const homeLink = join(b, 'homelink'); symlinkSync(realHome, homeLink);
    expect(resolveProjectLayer({ cwd: dir(realHome, 'a'), userHome: homeLink, globalLedger: join(b, 'elsewhere.jsonl') })).toBeUndefined();
  });

  // Review focus 2.
  it('a .helix FILE in a parent is not a project folder', () => {
    const b = base(); const home = dir(b, 'home');
    const proj = dir(home, 'proj'); writeFileSync(join(proj, '.helix'), 'not a folder');
    expect(resolveProjectLayer({ cwd: dir(proj, 'sub'), userHome: home, globalLedger: globalIn(home) })).toBeUndefined();
  });

  // Review focus 1 (D6).
  it("passes over another tool's .helix folder and keeps walking (the Helix editor keeps settings there)", () => {
    const b = base(); const home = dir(b, 'home');
    const repo = dir(home, 'repo'); dir(repo, '.helix'); writeFileSync(join(repo, '.helix', 'memory.jsonl'), '');
    const pkg = dir(repo, 'pkg'); dir(pkg, '.helix'); writeFileSync(join(pkg, '.helix', 'languages.toml'), '[x]\n');
    expect(resolveProjectLayer({ cwd: dir(pkg, 'src'), userHome: home, globalLedger: globalIn(home) })?.root).toBe(repo);
  });

  // Final review: an empty or relative HOME gives no boundary to trust. Resolving it against each
  // process's own cwd would let the server and the hook walk to different places (issue #1 again).
  it('skips the parent walk when the home directory is not an absolute path', () => {
    const b = base(); const home = dir(b, 'home');
    const proj = dir(home, 'proj'); dir(proj, '.helix');
    const sub = dir(proj, 'sub');
    for (const userHome of ['', 'relative/home']) {
      expect(resolveProjectLayer({ cwd: sub, userHome, globalLedger: globalIn(home) }), `userHome=${JSON.stringify(userHome)}`).toBeUndefined();
    }
    // The working directory's own folder is not a walk, so it still counts.
    expect(resolveProjectLayer({ cwd: proj, userHome: '', globalLedger: globalIn(home) })?.origin).toBe('cwd');
  });

  it('an empty parent .helix (a fresh mkdir opt-in) and one holding only .owner both count (D6)', () => {
    const b = base(); const home = dir(b, 'home');
    const a = dir(home, 'a'); dir(a, '.helix');
    expect(resolveProjectLayer({ cwd: dir(a, 's'), userHome: home, globalLedger: globalIn(home) })?.root).toBe(a);
    const c = dir(home, 'c'); dir(c, '.helix'); writeFileSync(join(c, '.helix', '.owner'), 'x');
    expect(resolveProjectLayer({ cwd: dir(c, 's'), userHome: home, globalLedger: globalIn(home) })?.root).toBe(c);
  });

  // Design 4.2, the paragraph on resolveProjectLayer: the same directory entry is no project, however the home is spelled.
  it('the global ledger spelled through a linked parent directory is the same entry: no layer (home through a symlink)', () => {
    const b = base(); const realHome = dir(b, 'real', 'u'); dir(realHome, '.helix');
    const linked = join(b, 'pl'); symlinkSync(join(b, 'real'), linked);
    const cwd = join(linked, 'u');                                          // the same folder, spelled through the link
    expect(resolveProjectLayer({ cwd, userHome: b, globalLedger: join(realHome, '.helix', 'memory.jsonl') })).toBeUndefined();
  });

  it.each([['the global ledger exists', true], ['the global ledger does not exist yet', false]] as const)(
    '.helix as a DIRECTORY link to the home is the global store (decision 16: "no link" applies to the memory file only): %s', (_l, existing) => {
      const b = base(); const home = dir(b, 'home'); const proj = dir(home, 'proj');
      if (existing) writeFileSync(join(home, 'memory.jsonl'), '');
      symlinkSync(home, join(proj, '.helix'));
      expect(resolveProjectLayer({ cwd: proj, userHome: home, globalLedger: join(home, 'memory.jsonl') })).toBeUndefined();
    });

  it('a global ledger that is itself a link keeps the layer when .helix is the home (decision 8, R5): the table judges it', () => {
    const b = base(); const home = dir(b, 'home'); const proj = dir(home, 'proj'); dir(proj, '.helix');
    const elsewhere = join(dir(b, 'elsewhere'), 'g.jsonl'); writeFileSync(elsewhere, '');
    symlinkSync(elsewhere, join(proj, '.helix', 'memory.jsonl'));
    const globalLedger = join(proj, '.helix', 'memory.jsonl');             // the same string, and its last component is a link
    expect(resolveProjectLayer({ cwd: proj, userHome: home, globalLedger })).toEqual({ root: proj, ledger: globalLedger, origin: 'cwd' });
  });

  it('a DANGLING .helix link at the working directory is a layer (lstat; row 3 judges it unusable), a regular file too', () => {
    const b = base(); const home = dir(b, 'home');
    const dangling = dir(home, 'dangling'); symlinkSync(join(b, 'nowhere', 'h'), join(dangling, '.helix'));
    const file = dir(home, 'file'); writeFileSync(join(file, '.helix'), 'x\n');
    for (const proj of [dangling, file]) {
      expect(resolveProjectLayer({ cwd: proj, userHome: home, globalLedger: globalIn(home) })).toEqual({ root: proj, ledger: join(proj, '.helix', 'memory.jsonl'), origin: 'cwd' });
    }
  });

  it.skipIf(process.getuid?.() === 0)('a working directory below a mode-000 folder finds no layer: its .helix cannot be looked at (decision 8, R15)', () => {
    const b = base(); const home = dir(b, 'home');
    const locked = dir(home, 'locked'); const proj = dir(locked, 'proj'); dir(proj, '.helix');
    chmodSync(locked, 0o000);
    try { expect(resolveProjectLayer({ cwd: proj, userHome: home, globalLedger: globalIn(home) })).toBeUndefined(); }
    finally { chmodSync(locked, 0o700); }
  });
});
