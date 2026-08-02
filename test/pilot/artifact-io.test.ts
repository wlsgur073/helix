import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  InvocationError, appendArtifactLine, canonicalPath, isInvocationError, invocationFail,
  parseJsonInput, readInput, readInputBytes, refuseOutputCollisions, writeArtifact,
} from '../../scripts/pilot/artifact-io.js';

/** The shared artifact I/O every pilot CLI writes through.
 *
 *  Two properties are under test, and they are the two the CLIs could not hold on their own:
 *  §9 line 376's "refuses pre-existing outputs / creates every file exclusively", and the exit-code
 *  split (2 = you invoked this wrongly, 1 = what you are recording is refused) that
 *  `release-record.ts` states as an interface promise for an operator's script. */

const temp = () => mkdtempSync(join(tmpdir(), 'artifact-io-'));
const withDir = (fn: (dir: string) => void) => {
  const dir = temp();
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

describe('the invocation / refusal split', () => {
  it('marks an invocation error by a property, not by class identity', () => {
    // Read as a property on purpose. Each pilot CLI is bundled separately, and a bundler that
    // inlined this module into two entry points loaded in one process would mint two unrelated
    // classes — `instanceof` would then answer "no" for a genuine invocation error and the CLI
    // would exit 1, which is the exact confusion X3 is about.
    const mine = new InvocationError('output-exists: …');
    expect(isInvocationError(mine)).toBe(true);
    const structural = Object.assign(new Error('output-exists: …'), { invocation: true });
    expect(isInvocationError(structural)).toBe(true);
  });

  it('does not mistake an ordinary gate refusal for an invocation error', () => {
    expect(isInvocationError(new Error('gate-set-tampered: …'))).toBe(false);
    expect(isInvocationError('gate-set-tampered')).toBe(false);
    expect(isInvocationError(undefined)).toBe(false);
  });

  it('invocationFail throws a slug-prefixed invocation error', () => {
    expect(() => invocationFail('output-exists', 'why')).toThrow(/^output-exists: why$/);
    try { invocationFail('output-exists', 'why'); } catch (e) { expect(isInvocationError(e)).toBe(true); }
  });
});

describe('canonicalPath — the identity of a path as a file, not as a string', () => {
  it('gives two spellings of one existing file the same identity', () => {
    withDir((dir) => {
      const file = join(dir, 'a.json');
      writeFileSync(file, '{}\n');
      expect(canonicalPath(join(dir, '.', 'sub', '..', 'a.json'))).toBe(canonicalPath(file));
      expect(canonicalPath(`${dir}//a.json`)).toBe(canonicalPath(file));
    });
  });

  it('sees through a symlinked directory, which a string comparison cannot', () => {
    withDir((dir) => {
      const real = join(dir, 'real');
      mkdirSync(real);
      writeFileSync(join(real, 'a.json'), '{}\n');
      symlinkSync(real, join(dir, 'link'), 'dir');
      expect(canonicalPath(join(dir, 'link', 'a.json'))).toBe(canonicalPath(join(real, 'a.json')));
    });
  });

  it('sees through a symlinked FILE, not only a symlinked directory', () => {
    // Distinct from the case above and separately load-bearing: resolving the parent and
    // reattaching the basename — which is what an as-yet-uncreated output needs — leaves a final
    // component that is itself a symlink unresolved. Dropping the direct `realpathSync` passed the
    // directory test and failed only here.
    withDir((dir) => {
      writeFileSync(join(dir, 'real.json'), '{}\n');
      symlinkSync(join(dir, 'real.json'), join(dir, 'alias.json'));
      expect(canonicalPath(join(dir, 'alias.json'))).toBe(canonicalPath(join(dir, 'real.json')));
    });
  });

  it('resolves a file that does not exist yet through its parent, because an output usually does not', () => {
    withDir((dir) => {
      const real = join(dir, 'real');
      mkdirSync(real);
      symlinkSync(real, join(dir, 'link'), 'dir');
      expect(canonicalPath(join(dir, 'link', 'new.json'))).toBe(join(canonicalPath(real), 'new.json'));
    });
  });

  it('falls back to the resolved absolute path when even the parent is absent', () => {
    withDir((dir) => {
      expect(canonicalPath(join(dir, 'absent', 'new.json'))).toBe(join(dir, 'absent', 'new.json'));
    });
  });
});

describe('refuseOutputCollisions — checked BEFORE the work, not after it', () => {
  const inputs = (dir: string) => [{ arg: '--score', path: join(dir, 'score.json') }];

  it('accepts a fresh path under an existing directory', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'score.json'), '{}\n');
      expect(() => refuseOutputCollisions({ arg: '--out', path: join(dir, 'out.json') }, inputs(dir))).not.toThrow();
    });
  });

  it('refuses an output that names an input, and names both flags', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'score.json'), '{}\n');
      expect(() => refuseOutputCollisions({ arg: '--out', path: join(dir, 'score.json') }, inputs(dir)))
        .toThrow(/^output-aliases-input: --out .* --score /);
    });
  });

  it('refuses the alias even when the two paths are spelled differently', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'score.json'), '{}\n');
      expect(() => refuseOutputCollisions(
        { arg: '--out', path: join(dir, '.', 'x', '..', 'score.json') }, inputs(dir)))
        .toThrow(/output-aliases-input/);
    });
  });

  it('reports the ALIAS when an input reaches the output through a symlink', () => {
    // The refusal an operator gets has to say the run is unrunnable, not "that file exists" — the
    // second sends them to delete the file, which is the input. `O_EXCL` would still stop the write
    // here, so what this pins is the DIAGNOSIS rather than the protection.
    withDir((dir) => {
      writeFileSync(join(dir, 'real.json'), '{}\n');
      symlinkSync(join(dir, 'real.json'), join(dir, 'alias.json'));
      expect(() => refuseOutputCollisions({ arg: '--out', path: join(dir, 'real.json') },
        [{ arg: '--score', path: join(dir, 'alias.json') }])).toThrow(/output-aliases-input/);
      expect(() => refuseOutputCollisions({ arg: '--out', path: join(dir, 'alias.json') },
        [{ arg: '--score', path: join(dir, 'real.json') }])).toThrow(/output-aliases-input/);
    });
  });

  it('refuses a pre-existing output', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'out.json'), 'PRIOR\n');
      expect(() => refuseOutputCollisions({ arg: '--out', path: join(dir, 'out.json') }, []))
        .toThrow(/^output-exists: /);
      expect(readFileSync(join(dir, 'out.json'), 'utf8')).toBe('PRIOR\n');
    });
  });

  it('keeps the output-exists remedy input-safe: name a new path, never move the old file', () => {
    // The refusal cannot know the existing file is disposable. The collision lists are built from
    // what each CLI opens, but a file can be an input of ANOTHER stage this invocation never reads
    // — and on a case-insensitive mount an aliased input arrives HERE, not at output-aliases-input,
    // because O_EXCL (not canonicalPath) is what fires. "Move the earlier artifact aside" hands the
    // operator a destructive repair for a file that may be load-bearing; the only always-safe
    // remedy is a fresh name.
    withDir((dir) => {
      writeFileSync(join(dir, 'out.json'), 'PRIOR\n');
      let thrown: unknown;
      try { refuseOutputCollisions({ arg: '--out', path: join(dir, 'out.json') }, []); }
      catch (e) { thrown = e; }
      expect(String(thrown)).toMatch(/name a new --out/i);
      expect(String(thrown)).not.toMatch(/move the earlier artifact aside/i);
      expect(String(thrown)).toMatch(/must not be moved or deleted/i);
    });
  });

  it('reports the alias rather than the pre-existence when the output is BOTH', () => {
    // An input that is about to be destroyed is the fact worth reporting: "that file already
    // exists" would send the operator off to delete it, which is the worst possible repair.
    withDir((dir) => {
      writeFileSync(join(dir, 'score.json'), '{}\n');
      expect(() => refuseOutputCollisions({ arg: '--out', path: join(dir, 'score.json') }, inputs(dir)))
        .toThrow(/output-aliases-input/);
    });
  });

  it('refuses an output whose directory does not exist, before any work is done', () => {
    withDir((dir) => {
      expect(() => refuseOutputCollisions({ arg: '--out', path: join(dir, 'absent', 'out.json') }, []))
        .toThrow(/^output-unwritable: /);
    });
  });

  it('refuses an output whose parent is a file rather than a directory', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'notadir'), 'x\n');
      expect(() => refuseOutputCollisions({ arg: '--out', path: join(dir, 'notadir', 'out.json') }, []))
        .toThrow(/^output-unwritable: /);
    });
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'refuses an UNWRITABLE parent up front — the claim is "before the measurement", so it must be tested', (
  ) => {
    // A mode-0500 parent stats fine and is a directory, so the old check passed it — and then
    // freeze-receipt hashed 18 files and shelled git before dying at the write. The comment said
    // "an unwritable destination is reported before the measurement"; only an access check makes
    // that true. (Skipped as root, for whom access(2) answers yes regardless of mode bits.)
    withDir((dir) => {
      const locked = join(dir, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o500);
      try {
        expect(() => refuseOutputCollisions({ arg: '--out', path: join(locked, 'out.json') }, []))
          .toThrow(/^output-unwritable: /);
      } finally { chmodSync(locked, 0o700); }
    });
  });

  it('refuses a DANGLING symlink at the destination as what it is, before the measurement', () => {
    // A stat that follows links reads a dangling symlink as "absent", so the old check passed it
    // and O_EXCL later refused it with the concurrent-run story — but nothing was created between
    // check and write; the link sat there all along.
    withDir((dir) => {
      symlinkSync(join(dir, 'points-nowhere.json'), join(dir, 'out.json'));
      expect(() => refuseOutputCollisions({ arg: '--out', path: join(dir, 'out.json') }, []))
        .toThrow(/^output-is-symlink: /);
    });
  });

  it('ignores an input path that does not exist — an absent input is the reader\'s problem, not the writer\'s', () => {
    withDir((dir) => {
      expect(() => refuseOutputCollisions({ arg: '--out', path: join(dir, 'out.json') },
        [{ arg: '--score', path: join(dir, 'absent.json') }])).not.toThrow();
    });
  });
});

describe('writeArtifact — exclusive creation is the enforcement, the check above is the courtesy', () => {
  it('writes a file that does not exist', () => {
    withDir((dir) => {
      writeArtifact({ arg: '--out', path: join(dir, 'out.json') }, '{"a":1}\n');
      expect(readFileSync(join(dir, 'out.json'), 'utf8')).toBe('{"a":1}\n');
    });
  });

  it('refuses to overwrite, even when the file appeared after the up-front check passed', () => {
    // The real enforcement, and the reason the up-front check is not sufficient on its own: the
    // window between `refuseOutputCollisions` and the write is exactly where a concurrent run
    // lands. O_EXCL closes it in the kernel.
    withDir((dir) => {
      const out = { arg: '--out', path: join(dir, 'out.json') };
      refuseOutputCollisions(out, []);
      writeFileSync(out.path, 'A CONCURRENT RUN GOT HERE FIRST\n');
      let thrown: unknown;
      try { writeArtifact(out, '{"a":1}\n'); } catch (e) { thrown = e; }
      expect(String(thrown)).toMatch(/output-exists: /);
      // The race wording is reserved for THIS path — a regular file that appeared after a clean
      // check — where "created between" is the literal truth.
      expect(String(thrown)).toMatch(/created between/);
      expect(readFileSync(out.path, 'utf8')).toBe('A CONCURRENT RUN GOT HERE FIRST\n');
    });
  });

  it('refuses a symlink that points at an existing file, naming it as a symlink, and does not follow it', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'victim.json'), 'PRIOR\n');
      symlinkSync(join(dir, 'victim.json'), join(dir, 'out.json'));
      expect(() => writeArtifact({ arg: '--out', path: join(dir, 'out.json') }, '{"a":1}\n'))
        .toThrow(/^output-is-symlink: /);
      expect(readFileSync(join(dir, 'victim.json'), 'utf8')).toBe('PRIOR\n');
    });
  });

  it('does NOT tell the race story for a dangling symlink that sat there all along', () => {
    // Reproduced: nothing was "created between check and write" — O_EXCL refuses symlinks (correct
    // behaviour), and the message blamed a concurrent run that never existed (wrong story). An
    // operator sent chasing a phantom race would rerun and hit the same wall forever.
    withDir((dir) => {
      symlinkSync(join(dir, 'points-nowhere.json'), join(dir, 'out.json'));
      let thrown: unknown;
      try { writeArtifact({ arg: '--out', path: join(dir, 'out.json') }, '{"a":1}\n'); }
      catch (e) { thrown = e; }
      expect(String(thrown)).toMatch(/output-is-symlink: /);
      expect(String(thrown)).not.toMatch(/created between/);
      expect(isInvocationError(thrown)).toBe(true);
    });
  });

  it('reports an unwritable destination as an invocation error', () => {
    withDir((dir) => {
      let thrown: unknown;
      try { writeArtifact({ arg: '--out', path: join(dir, 'absent', 'out.json') }, 'x'); }
      catch (e) { thrown = e; }
      expect(String(thrown)).toMatch(/output-unwritable: /);
      expect(isInvocationError(thrown)).toBe(true);
    });
  });
});

describe('appendArtifactLine — the ordering log is the one write that must NOT be exclusive', () => {
  it('creates the log on the first line and grows it afterwards', () => {
    withDir((dir) => {
      const log = { arg: '--log', path: join(dir, 'ordering.log') };
      appendArtifactLine(log, 'one\n');
      appendArtifactLine(log, 'two\n');
      expect(readFileSync(log.path, 'utf8')).toBe('one\ntwo\n');
    });
  });

  it('reports an unwritable log as an invocation error', () => {
    withDir((dir) => {
      expect(() => appendArtifactLine({ arg: '--log', path: join(dir, 'absent', 'ordering.log') }, 'x\n'))
        .toThrow(/^output-unwritable: /);
    });
  });
});

describe('reading inputs — a path the operator got wrong is not a gate refusal', () => {
  it('reads a file', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'a.json'), '{"a":1}\n');
      expect(readInput({ arg: '--score', path: join(dir, 'a.json') })).toBe('{"a":1}\n');
      expect(readInputBytes({ arg: '--config', path: join(dir, 'a.json') }).toString('utf8')).toBe('{"a":1}\n');
    });
  });

  it('refuses an absent file with a slug naming the flag and the path', () => {
    withDir((dir) => {
      let thrown: unknown;
      try { readInput({ arg: '--score', path: join(dir, 'absent.json') }); } catch (e) { thrown = e; }
      expect(String(thrown)).toMatch(/^InvocationError: input-unreadable: --score /);
      expect(isInvocationError(thrown)).toBe(true);
    });
  });

  it('refuses a directory handed in where a file was expected', () => {
    withDir((dir) => {
      expect(() => readInput({ arg: '--score', path: dir })).toThrow(/^input-unreadable: /);
      expect(() => readInputBytes({ arg: '--config', path: dir })).toThrow(/^input-unreadable: /);
    });
  });

  it('refuses a file that is not JSON, naming the flag rather than a position in an unnamed string', () => {
    // `JSON.parse` reports "Unexpected token … in JSON at position 9" and names no file at all, so
    // an operator holding four `--` inputs learns nothing about which one is broken.
    let thrown: unknown;
    try { parseJsonInput({ arg: '--score', path: '/somewhere/score.json' }, 'not json{'); }
    catch (e) { thrown = e; }
    expect(String(thrown)).toMatch(/^InvocationError: input-unparsable: --score \/somewhere\/score\.json/);
    expect(isInvocationError(thrown)).toBe(true);
  });

  it('returns the parsed value when it is JSON', () => {
    expect(parseJsonInput({ arg: '--score', path: 'p' }, '{"a":1}')).toEqual({ a: 1 });
  });
});
