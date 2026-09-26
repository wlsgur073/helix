import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('an empty parent .helix (a fresh mkdir opt-in) and one holding only .owner both count (D6)', () => {
    const b = base(); const home = dir(b, 'home');
    const a = dir(home, 'a'); dir(a, '.helix');
    expect(resolveProjectLayer({ cwd: dir(a, 's'), userHome: home, globalLedger: globalIn(home) })?.root).toBe(a);
    const c = dir(home, 'c'); dir(c, '.helix'); writeFileSync(join(c, '.helix', '.owner'), 'x');
    expect(resolveProjectLayer({ cwd: dir(c, 's'), userHome: home, globalLedger: globalIn(home) })?.root).toBe(c);
  });
});
