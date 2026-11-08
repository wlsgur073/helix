// Third fix batch B2a, task B2 (ruling N1, design 4.3 and 4.7): assertSessionsDestination answers, before the SessionEnd
// hook opens HELIX_SESSIONS, whether the resolved destination is a control file of the home (other than sessions.jsonl),
// the resolved global ledger, or a project's ledger (plan review of 2026-11-08). Called directly; the hook itself is
// spawned in session-end-destination.test.ts.
import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, readdirSync, existsSync, realpathSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSessionsDestination, SESSIONS_DESTINATION_REFUSAL_TEXT } from '../../src/hooks/sessions-destination.js';
import { HOME_CONTROL_NAMES } from '../../src/memory/home-files.js';
import { isHomeRefusalError, type HelixPaths, type HomeRefusalError } from '../../src/memory/home-env.js';
import { isUnresolvablePathError, type IdentityProbe } from '../../src/memory/path-identity.js';

// The nine names of OWNED_FILES (home-permissions.ts) that are neither the ledger nor sessions.jsonl, and two lock files.
const NINE = [
  'audit.jsonl', 'metrics.jsonl', 'trigger.jsonl', 'codex-log.jsonl', 'witness.json', 'witness-log.jsonl',
  'projects.json', 'ledger-mac-master.key', 'config.json',
];
const LOCKS = ['witness.json.lock', 'ledger-mac-master.key.lock'];
const REFUSED = [...new Set([...NINE, ...LOCKS, ...HOME_CONTROL_NAMES])].filter((n) => n !== 'sessions.jsonl');

interface Lay { base: string; home: string; out: string }
const bases: string[] = [];
function mkBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sd-')));
  bases.push(base);
  return base;
}
function layout(): Lay {
  const base = mkBase();
  const home = join(base, 'h');
  const out = join(base, 'o');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(out);
  return { base, home, out };
}
afterEach(() => { for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true }); });

const pathsOf = (l: Lay, sessionsFile: string, globalLedger: string = join(l.home, 'memory.jsonl')): HelixPaths =>
  ({ home: l.home, globalLedger, sessionsFile });

/** The typed refusal's cause and message, null when the destination is allowed; anything else is thrown through. */
function refusalOf(p: HelixPaths, probe?: IdentityProbe): { cause: string; message: string } | null {
  try { assertSessionsDestination(p, probe); } catch (e) {
    if (isHomeRefusalError(e)) return { cause: (e as HomeRefusalError).homeRefusalCause, message: (e as Error).message };
    throw e;
  }
  return null;
}
const REFUSAL = { cause: 'home-control-file', message: SESSIONS_DESTINATION_REFUSAL_TEXT };

describe('the control files of the home are refused as the sessions file', () => {
  it('the control set holds the nine OWNED_FILES names that are neither the ledger nor sessions.jsonl', () => {
    for (const n of NINE) expect(HOME_CONTROL_NAMES, n).toContain(n);
  });

  describe.each(REFUSED)('<home>/%s', (name) => {
    it('is refused when the file exists', () => {
      const l = layout();
      writeFileSync(join(l.home, name), 'x\n');
      expect(refusalOf(pathsOf(l, join(l.home, name)))).toEqual(REFUSAL);
    });
    it('is refused when it does not exist yet, and nothing is created in its place', () => {
      const l = layout();
      expect(refusalOf(pathsOf(l, join(l.home, name)))).toEqual(REFUSAL);
      expect(readdirSync(l.home)).toEqual([]);
    });
  });

  it('a link outside the home to a control file that exists is refused', () => {
    const l = layout();
    writeFileSync(join(l.home, 'projects.json'), '{}\n');
    symlinkSync(join(l.home, 'projects.json'), join(l.out, 's.jsonl'));
    expect(refusalOf(pathsOf(l, join(l.out, 's.jsonl')))).toEqual(REFUSAL);
  });

  it('a link outside the home to a control file that does not exist yet is refused (resolved path)', () => {
    const l = layout();
    symlinkSync(join(l.home, 'witness.json'), join(l.out, 's.jsonl'));
    expect(refusalOf(pathsOf(l, join(l.out, 's.jsonl')))).toEqual(REFUSAL);
    expect(readdirSync(l.home)).toEqual([]);
  });

  it.each([false, true])('<link>/../name is read the kernel\'s way (file present: %s)', (present) => {
    const base = mkBase();
    const home = join(base, 'y', 'h');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(join(base, 'y', 'z'));
    symlinkSync(join(base, 'y', 'z'), join(base, 'lnk'));
    if (present) writeFileSync(join(home, 'witness.json'), 'x\n');
    // Built by concatenation: path.join would fold the ".." as text and name <base>/h/witness.json, a different directory.
    const sessionsFile = `${base}/lnk/../h/witness.json`;
    expect(refusalOf({ home, globalLedger: join(home, 'memory.jsonl'), sessionsFile })).toEqual(REFUSAL);
    expect(existsSync(join(base, 'h'))).toBe(false);
  });
});

describe('the destinations that stay allowed', () => {
  it.each([false, true])('<home>/sessions.jsonl, the default (file present: %s)', (present) => {
    const l = layout();
    if (present) writeFileSync(join(l.home, 'sessions.jsonl'), 'x\n');
    expect(refusalOf(pathsOf(l, join(l.home, 'sessions.jsonl')))).toBeNull();
  });

  it('a new file in a folder outside the home', () => {
    const l = layout();
    expect(refusalOf(pathsOf(l, join(l.out, 's.jsonl')))).toBeNull();
  });

  it('a file under a folder that does not exist yet: allowed, and nothing is created', () => {
    const l = layout();
    expect(refusalOf(pathsOf(l, join(l.out, 'newdir', 'deep', 's.jsonl')))).toBeNull();
    expect(existsSync(join(l.out, 'newdir'))).toBe(false);
  });

  it('a link outside the home to <home>/sessions.jsonl', () => {
    const l = layout();
    symlinkSync(join(l.home, 'sessions.jsonl'), join(l.out, 's.jsonl'));
    expect(refusalOf(pathsOf(l, join(l.out, 's.jsonl')))).toBeNull();
  });

  it('a ledger relocated outside the home does not stop the default sessions file (outline Review Focus 3 and 5)', () => {
    const l = layout();
    writeFileSync(join(l.out, 'led.jsonl'), '{}\n');
    expect(refusalOf(pathsOf(l, join(l.home, 'sessions.jsonl'), join(l.out, 'led.jsonl')))).toBeNull();
  });

  it('an unresolvable global ledger names no file, so it cannot be the destination', () => {
    const l = layout();
    symlinkSync(join(l.out, 'b'), join(l.out, 'a'));
    symlinkSync(join(l.out, 'a'), join(l.out, 'b'));
    expect(refusalOf(pathsOf(l, join(l.out, 's.jsonl'), join(l.out, 'a')))).toBeNull();
  });
});

describe('the global ledger is refused as the sessions file', () => {
  it.each([false, true])('the default ledger <home>/memory.jsonl (file present: %s)', (present) => {
    const l = layout();
    if (present) writeFileSync(join(l.home, 'memory.jsonl'), '{}\n');
    expect(refusalOf(pathsOf(l, join(l.home, 'memory.jsonl')))).toEqual(REFUSAL);
  });

  it.each([false, true])('a ledger relocated outside the home, named as the sessions file (file present: %s)', (present) => {
    const l = layout();
    const led = join(l.out, 'led.jsonl');
    if (present) writeFileSync(led, '{}\n');
    expect(refusalOf(pathsOf(l, led, led))).toEqual(REFUSAL);
  });

  it('a ledger given through a link, the sessions file named by its target', () => {
    const l = layout();
    writeFileSync(join(l.out, 'led.jsonl'), '{}\n');
    symlinkSync(join(l.out, 'led.jsonl'), join(l.out, 'lk'));
    expect(refusalOf(pathsOf(l, join(l.out, 'led.jsonl'), join(l.out, 'lk')))).toEqual(REFUSAL);
  });

  it('a sessions file that is a link to the ledger', () => {
    const l = layout();
    writeFileSync(join(l.out, 'led.jsonl'), '{}\n');
    symlinkSync(join(l.out, 'led.jsonl'), join(l.out, 's.jsonl'));
    expect(refusalOf(pathsOf(l, join(l.out, 's.jsonl'), join(l.out, 'led.jsonl')))).toEqual(REFUSAL);
  });

  it('a sessions file that is a hard link to the ledger (identity, not path)', () => {
    const l = layout();
    writeFileSync(join(l.out, 'led.jsonl'), '{}\n');
    linkSync(join(l.out, 'led.jsonl'), join(l.out, 'hl.jsonl'));
    expect(refusalOf(pathsOf(l, join(l.out, 'hl.jsonl'), join(l.out, 'led.jsonl')))).toEqual(REFUSAL);
  });

  it('HELIX_LEDGER set to <home>/sessions.jsonl makes the default sessions file the ledger: refused', () => {
    const l = layout();
    const f = join(l.home, 'sessions.jsonl');
    expect(refusalOf(pathsOf(l, f, f))).toEqual(REFUSAL);
  });

  // Disposition item 7: <home>/memory.jsonl is compared whatever HELIX_LEDGER says.
  it.each([false, true])('<home>/memory.jsonl while the ledger is relocated outside the home (file present: %s): refused all the same', (present) => {
    const l = layout();
    const led = join(l.out, 'led.jsonl');
    writeFileSync(led, '{}\n');
    if (present) writeFileSync(join(l.home, 'memory.jsonl'), '{}\n');
    expect(refusalOf(pathsOf(l, join(l.home, 'memory.jsonl'), led))).toEqual(REFUSAL);
  });

  it('a hard link outside the home to <home>/memory.jsonl while the ledger is relocated: refused by identity', () => {
    const l = layout();
    const led = join(l.out, 'led.jsonl');
    writeFileSync(led, '{}\n');
    writeFileSync(join(l.home, 'memory.jsonl'), '{}\n');
    linkSync(join(l.home, 'memory.jsonl'), join(l.out, 'hm.jsonl'));
    expect(refusalOf(pathsOf(l, join(l.out, 'hm.jsonl'), led))).toEqual(REFUSAL);
  });

  it('an inode of 0 never makes two paths one file: the hard-linked pair is not refused, the same path still is', () => {
    const zero: IdentityProbe = () => ({ dev: 1n, ino: 0n });
    const l = layout();
    writeFileSync(join(l.out, 'led.jsonl'), '{}\n');
    linkSync(join(l.out, 'led.jsonl'), join(l.out, 'hl.jsonl'));
    expect(refusalOf(pathsOf(l, join(l.out, 'hl.jsonl'), join(l.out, 'led.jsonl')), zero)).toBeNull();
    expect(refusalOf(pathsOf(l, join(l.out, 'led.jsonl'), join(l.out, 'led.jsonl')), zero)).toEqual(REFUSAL);
  });
});

// Plan review of 2026-11-08 (owner, rule M): a project's ledger is <root>/.helix/memory.jsonl (ownership.ts projectLedgerPath).
// The hook has no project scope, so it knows one by the two last names of the resolved destination or of the path as given.
describe("a project's ledger is refused as the sessions file", () => {
  const projectLedgerIn = (base: string): string => join(base, 'p', '.helix', 'memory.jsonl');

  it.each([false, true])('<root>/.helix/memory.jsonl outside the home (file present: %s): refused, and nothing is created', (present) => {
    const l = layout();
    const led = projectLedgerIn(l.base);
    mkdirSync(join(l.base, 'p', '.helix'), { recursive: true });
    if (present) writeFileSync(led, '{}\n');
    expect(refusalOf(pathsOf(l, led))).toEqual(REFUSAL);
    expect(readdirSync(join(l.base, 'p', '.helix'))).toEqual(present ? ['memory.jsonl'] : []);
  });

  it('a link outside the project to a project ledger is refused (the resolved destination is the ledger)', () => {
    const l = layout();
    const led = projectLedgerIn(l.base);
    mkdirSync(join(l.base, 'p', '.helix'), { recursive: true });
    writeFileSync(led, '{}\n');
    symlinkSync(led, join(l.out, 's.jsonl'));
    expect(refusalOf(pathsOf(l, join(l.out, 's.jsonl')))).toEqual(REFUSAL);
  });

  it("a project's memory.jsonl that is itself a link to a file of another name is refused by the path as given", () => {
    const l = layout();
    const led = projectLedgerIn(l.base);
    mkdirSync(join(l.base, 'p', '.helix'), { recursive: true });
    writeFileSync(join(l.out, 'kept.jsonl'), '{}\n');
    symlinkSync(join(l.out, 'kept.jsonl'), led);   // the resolved destination is kept.jsonl, outside any .helix folder
    expect(refusalOf(pathsOf(l, led))).toEqual(REFUSAL);
  });

  it('control: a file named memory.jsonl outside any .helix folder is an ordinary sessions file', () => {
    const l = layout();
    expect(refusalOf(pathsOf(l, join(l.out, 'memory.jsonl')))).toBeNull();
  });

  it('control: a home named .helix (the default ~/.helix shape) keeps sessions.jsonl as its sessions file; only memory.jsonl there is a ledger', () => {
    const base = mkBase();
    const home = join(base, '.helix');
    mkdirSync(home, { mode: 0o700 });
    expect(refusalOf({ home, globalLedger: join(home, 'memory.jsonl'), sessionsFile: join(home, 'sessions.jsonl') })).toBeNull();
  });
});

describe('a destination that cannot be named', () => {
  it('a link loop throws the unresolvable-path error (not a home refusal), so the hook drops the record', () => {
    const l = layout();
    symlinkSync(join(l.out, 'b'), join(l.out, 'a'));
    symlinkSync(join(l.out, 'a'), join(l.out, 'b'));
    let thrown: unknown;
    try { assertSessionsDestination(pathsOf(l, join(l.out, 'a'))); } catch (e) { thrown = e; }
    expect(isUnresolvablePathError(thrown)).toBe(true);
    expect(isHomeRefusalError(thrown)).toBe(false);
  });
});
