// B2a task A5 (rulings C, D, N3; plan decision P2): the three operator CLIs resolve HELIX_HOME and HELIX_LEDGER through
// resolveHelixPaths and refuse what it refuses (exit 2; helix-trigger exit 3), and helix-rebaseline --scope global refuses a
// home that does not exist and creates nothing. The expected stderr is built from the resolver's own message, so these
// cases pin the head, the exit code and the "nothing created" outcome, not the wording that task A2 owns.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, unlinkSync, existsSync, realpathSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as rebaseline } from '../../scripts/rebaseline-cli.js';
import { main as trustResolve } from '../../scripts/trust-resolve-cli.js';
import { main as trigger } from '../../scripts/trigger-cli.js';
import { resolveHelixPaths, isHomeRefusalError, type HomeRefusalCause } from '../../src/memory/home-env.js';
import { MemoryStore } from '../../src/memory/store.js';
import { trustStateOf } from '../../src/memory/ownership.js';
import { bundleCli } from '../helpers/bundle-cli.js';
import { snapshotTree } from '../helpers/global-layouts.js';

interface World { base: string; cwd: string; userHome: string; proj: string }
let w: World;
let startDir: string;

beforeEach(() => {
  startDir = process.cwd();
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cli-he-')));
  w = { base, cwd: join(base, 'cwd'), userHome: join(base, 'uh'), proj: join(base, 'proj') };
  for (const d of [w.cwd, w.userHome, w.proj]) mkdirSync(d);
  process.chdir(w.cwd);                         // a relative or empty value lands here, never in the repository
  vi.stubEnv('HOME', w.userHome);               // os.homedir() reads $HOME at call time
  expect(homedir()).toBe(w.userHome);           // precondition: the default home is below the throwaway directory
});
afterEach(() => {
  process.chdir(startDir);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(w.base, { recursive: true, force: true });
});

function capture(): { out: () => string; err: () => string } {
  let out = ''; let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { out += c.toString(); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { err += c.toString(); return true; });
  return { out: () => out, err: () => err };
}

interface Run { code: number; exits: number[]; out: string; err: string; prompted: boolean }
async function runRebaseline(argv: string[], env: NodeJS.ProcessEnv, answer = 'no'): Promise<Run> {
  const cap = capture(); const exits: number[] = []; let prompted = false;
  const code = await rebaseline(argv, { env, isTTY: true, promptLine: async () => { prompted = true; return answer; }, exit: (c) => { exits.push(c); } });
  return { code, exits, out: cap.out(), err: cap.err(), prompted };
}
async function runTrustResolve(argv: string[], env: NodeJS.ProcessEnv, answer = 'no'): Promise<Run> {
  const cap = capture(); const exits: number[] = []; let prompted = false;
  const code = await trustResolve(argv, { env, isTTY: true, promptLine: async () => { prompted = true; return answer; }, exit: (c) => { exits.push(c); } });
  return { code, exits, out: cap.out(), err: cap.err(), prompted };
}
function runTrigger(argv: string[], env: NodeJS.ProcessEnv): Run {
  const cap = capture(); const exits: number[] = [];
  const code = trigger(argv, { env, exit: (c) => { exits.push(c); } });
  return { code, exits, out: cap.out(), err: cap.err(), prompted: false };
}
const EVAL = (): string[] => ['--root', w.proj, '--run', 'r1'];

/** The resolver's own refusal for this environment: its cause and its constant message. */
function refusalOf(env: NodeJS.ProcessEnv): { cause: HomeRefusalCause; message: string } {
  try {
    resolveHelixPaths(env, w.userHome);
  } catch (e) {
    if (!isHomeRefusalError(e)) throw e;
    return { cause: (e as { homeRefusalCause: HomeRefusalCause }).homeRefusalCause, message: (e as Error).message };
  }
  throw new Error('precondition: the resolver accepted this environment');
}

/** A pending project scope under `home` (an ambiguous re-adoption: the .owner stamp is gone), built as test/scripts/trust-resolve-cli.test.ts builds it. */
function pendingScope(home: string): void {
  const at = (s: string): MemoryStore => new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: s, project: { root: w.proj, ledger: join(w.proj, '.helix', 'memory.jsonl') } });
  const s1 = at('s1'); s1.adopt(w.proj);
  const rec = s1.commit({ content: 'the db is postgres', source: 'user', scope: 'project' });
  s1.confirm(rec.id);
  unlinkSync(join(w.proj, '.helix', '.owner'));
  at('s2').adopt(w.proj);
  expect(trustStateOf(w.proj, home)).toBe('pending');            // precondition
}

/** The fixed text of ruling N3 (helix-rebaseline, --scope global, no home). */
const NO_HOME =
  'helix-rebaseline: REFUSING - the Helix home directory does not exist, so there is no global memory file or rollback witness to re-baseline.\n' +
  'Nothing was created.\n';

// ---- rulings C and D: what the resolver refuses, refused by every CLI --------------------------------------------------
interface Row { name: string; cause: HomeRefusalCause; env: (w: World) => NodeJS.ProcessEnv; leaks: string[] }
const ROWS: Row[] = [
  { name: 'HELIX_HOME is "."', cause: 'relative-value', env: () => ({ HELIX_HOME: '.' }), leaks: [] },
  { name: 'HELIX_HOME is a relative path', cause: 'relative-value', env: () => ({ HELIX_HOME: 'zq-rel/home' }), leaks: ['zq-rel'] },
  { name: 'HELIX_LEDGER is a relative path beside an absolute home', cause: 'relative-value',
    env: (x) => ({ HELIX_HOME: join(x.base, 'h'), HELIX_LEDGER: 'zq-led.jsonl' }), leaks: ['zq-led'] },
  { name: 'HELIX_HOME lies below a symlink loop', cause: 'unresolvable-home',
    env: (x) => {
      const a = join(x.base, 'zq-loop-a'); const b = join(x.base, 'zq-loop-b');
      symlinkSync(b, a); symlinkSync(a, b);
      return { HELIX_HOME: join(a, 'h') };
    }, leaks: ['zq-loop-a', 'zq-loop-b'] },
  // Final review G2: a value that was not valid UTF-8 reaches Helix with U+FFFD in it.
  { name: 'HELIX_HOME holds U+FFFD (a value that was not valid UTF-8)', cause: 'unresolvable-home',
    env: (x) => ({ HELIX_HOME: join(x.base, `zq-ff${String.fromCharCode(0xfffd)}h`) }), leaks: ['zq-ff'] },
  // Final review G3: the composed home past the system limit.
  { name: 'HELIX_HOME has a final component of 256 bytes', cause: 'unresolvable-home',
    env: (x) => ({ HELIX_HOME: join(x.base, 'zq'.repeat(128)) }), leaks: ['zqzq'] },
  { name: 'HELIX_HOME is past PATH_MAX while its directory part is under it', cause: 'unresolvable-home',
    env: (x) => {
      let deep = join(x.base, 'zq-deep');
      while (deep.length < 3880) deep = join(deep, 'd'.repeat(200));
      mkdirSync(deep, { recursive: true });
      return { HELIX_HOME: join(deep, 'h'.repeat(250)) };
    }, leaks: ['zq-deep'] },
  // Final review G1 (owner, 2026-11-09): a `..` after a folder that cannot be searched. The folder is 0600 (readable, not
  // searchable), so the before-and-after tree snapshot can still list it; skipped as root, which searches any folder.
  ...((typeof process.getuid === 'function' && process.getuid() === 0) ? [] : [{
    name: 'HELIX_HOME has a `..` after a folder that cannot be searched', cause: 'unresolvable-home' as HomeRefusalCause,
    env: (x: World) => {
      const locked = join(x.base, 'zq-locked');
      if (!existsSync(locked)) { mkdirSync(locked); chmodSync(locked, 0o600); }
      return { HELIX_HOME: `${locked}/../h` };
    }, leaks: ['zq-locked'] }]),
];

for (const row of ROWS) {
  describe(`environment refused by the resolver: ${row.name}`, () => {
    it('precondition: the resolver names the cause, and its message is ASCII with no path', () => {
      const ref = refusalOf(row.env(w));
      expect(ref.cause).toBe(row.cause);
      expect(ref.message).toMatch(/^[\x20-\x7e]+$/);
      expect(ref.message).not.toContain(w.base);
      for (const s of row.leaks) expect(ref.message).not.toContain(s);
    });

    it.each([['global', 'global'], ['a project root', 'project']] as const)('helix-rebaseline --scope %s: exit 2, one REFUSING line, no prompt, nothing created', async (_label, which) => {
      const env = row.env(w); const ref = refusalOf(env);
      const before = snapshotTree(w.base);
      const r = await runRebaseline(['--scope', which === 'global' ? 'global' : w.proj], env, 'bless');
      expect(r.code).toBe(2);
      expect(r.exits).toEqual([2]);
      expect(r.err).toBe(`helix-rebaseline: REFUSING - ${ref.message}\n`);
      expect(r.out).toBe('');
      expect(r.prompted).toBe(false);
      expect(snapshotTree(w.base)).toEqual(before);
    });

    it('helix-trust-resolve: exit 2, one REFUSING line, no prompt, nothing created', async () => {
      const env = row.env(w); const ref = refusalOf(env);
      const before = snapshotTree(w.base);
      const r = await runTrustResolve(['--scope', w.proj, '--repair'], env, 'repair');
      expect(r.code).toBe(2);
      expect(r.exits).toEqual([2]);
      expect(r.err).toBe(`helix-trust-resolve: REFUSING - ${ref.message}\n`);
      expect(r.out).toBe('');
      expect(r.prompted).toBe(false);
      expect(snapshotTree(w.base)).toEqual(before);
    });

    it.each([['an evaluation', EVAL], ['--acknowledge', () => ['--acknowledge']]] as const)('helix-trigger %s: exit 3, one REFUSING line, no record, nothing created', (_label, argv) => {
      const env = row.env(w); const ref = refusalOf(env);
      const before = snapshotTree(w.base);
      const r = runTrigger(argv(), env);
      expect(r.code).toBe(3);
      expect(r.exits).toEqual([3]);
      expect(r.err).toBe(`trigger-cli: REFUSING - ${ref.message}\n`);
      expect(r.out).toBe('');
      expect(snapshotTree(w.base)).toEqual(before);
    });
  });
}

// ---- ruling C: an empty value is unset ---------------------------------------------------------------------------------
describe('an empty HELIX_HOME or HELIX_LEDGER is unset: the default below the user home is used', () => {
  it('helix-trigger: the sink and the global ledger are the ones below $HOME/.helix, nothing lands in the working directory', () => {
    const home = join(w.userHome, '.helix');
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, 'memory.jsonl'), 'g1\ng2\ng3\n');
    const r = runTrigger(EVAL(), { HELIX_HOME: '', HELIX_LEDGER: '' });
    expect(r.code).toBe(0);
    const record = JSON.parse(r.out.trim());
    expect(record.legs.rows).toEqual({ min: 3, max: 3, threshold: 2500, status: 'false' });   // read from <home>/memory.jsonl
    expect(readFileSync(join(home, 'trigger.jsonl'), 'utf8')).toBe(r.out);
    expect(snapshotTree(w.cwd)).toEqual([]);
  });

  it('helix-trust-resolve: HELIX_HOME="" finds the scope pending in $HOME/.helix and goes on to the prompt', async () => {
    const home = join(w.userHome, '.helix');
    mkdirSync(home, { mode: 0o700 });
    pendingScope(home);
    const r = await runTrustResolve(['--scope', w.proj, '--repair'], { HELIX_HOME: '' });
    expect(r.prompted).toBe(true);
    expect(r.code).toBe(1);                                      // the typed confirmation was declined; the scope is untouched
    expect(trustStateOf(w.proj, home)).toBe('pending');
    expect(snapshotTree(w.cwd)).toEqual([]);
  });

  it('helix-rebaseline --scope global: HELIX_HOME="" names $HOME/.helix, which does not exist: the no-home refusal, nothing created', async () => {
    const before = snapshotTree(w.base);
    const r = await runRebaseline(['--scope', 'global'], { HELIX_HOME: '' });
    expect(r.code).toBe(2);
    expect(r.err).toBe(NO_HOME);
    expect(r.prompted).toBe(false);
    expect(existsSync(join(w.userHome, '.helix'))).toBe(false);
    expect(snapshotTree(w.base)).toEqual(before);
  });

  it('control, helix-rebaseline --scope global: HELIX_HOME="" with $HOME/.helix present reaches the prompt and writes nothing into the working directory', async () => {
    mkdirSync(join(w.userHome, '.helix'), { mode: 0o700 });
    const r = await runRebaseline(['--scope', 'global'], { HELIX_HOME: '' });
    expect(r.prompted).toBe(true);
    expect(r.code).toBe(1);
    expect(snapshotTree(w.cwd)).toEqual([]);
  });
});

// ---- ruling D: the home is the kernel's, for every join ---------------------------------------------------------------
describe('HELIX_HOME of the form <symlinked dir>/../name is the home the kernel reaches', () => {
  /** <base>/ln -> <base>/real/sub, so <base>/ln/../h is <base>/real/h to the kernel and <base>/h to a text fold. Built by concatenation: path.join would fold it. */
  function dotdotHome(): { spelled: string; kernel: string; folded: string } {
    mkdirSync(join(w.base, 'real', 'sub'), { recursive: true });
    symlinkSync(join(w.base, 'real', 'sub'), join(w.base, 'ln'));
    return { spelled: `${w.base}/ln/../h`, kernel: join(w.base, 'real', 'h'), folded: join(w.base, 'h') };
  }

  it('helix-trigger writes its sink into the kernel home, not the folded one', () => {
    const h = dotdotHome();
    mkdirSync(h.kernel, { mode: 0o700 });
    const r = runTrigger(EVAL(), { HELIX_HOME: h.spelled });
    expect(r.code).toBe(0);
    expect(readFileSync(join(h.kernel, 'trigger.jsonl'), 'utf8')).toBe(r.out);
    expect(existsSync(h.folded)).toBe(false);
  });

  it('helix-trust-resolve reads the registry of the kernel home (the folded home exists and holds nothing)', async () => {
    const h = dotdotHome();
    mkdirSync(h.kernel, { mode: 0o700 });
    mkdirSync(h.folded, { mode: 0o700 });
    pendingScope(h.kernel);
    const r = await runTrustResolve(['--scope', w.proj, '--repair'], { HELIX_HOME: h.spelled });
    expect(r.prompted).toBe(true);
    expect(r.code).toBe(1);
    expect(trustStateOf(w.proj, h.kernel)).toBe('pending');
  });

  it('helix-rebaseline --scope global judges the kernel home: it does not exist, so the no-home refusal (the folded home exists)', async () => {
    const h = dotdotHome();
    mkdirSync(h.folded, { mode: 0o700 });
    const before = snapshotTree(w.base);
    const r = await runRebaseline(['--scope', 'global'], { HELIX_HOME: h.spelled });
    expect(r.code).toBe(2);
    expect(r.err).toBe(NO_HOME);
    expect(existsSync(h.kernel)).toBe(false);
    expect(snapshotTree(w.base)).toEqual(before);
  });
});

// ---- ruling N3: helix-rebaseline --scope global without a home --------------------------------------------------------
describe('helix-rebaseline --scope global when the home does not exist (N3)', () => {
  it('exit 2, the fixed text, no prompt, and the missing home, its parent and the working directory are as they were', async () => {
    const home = join(w.base, 'nohome');
    const before = snapshotTree(w.base);
    const r = await runRebaseline(['--scope', 'global'], { HELIX_HOME: home }, 'bless');
    expect(r.code).toBe(2);
    expect(r.exits).toEqual([2]);
    expect(r.err).toBe(NO_HOME);
    expect(r.out).toBe('');
    expect(r.prompted).toBe(false);
    expect(existsSync(home)).toBe(false);
    expect(snapshotTree(w.base)).toEqual(before);
  });

  it('a global ledger relocated outside the missing home is left alone too (the witness lives in the home)', async () => {
    mkdirSync(join(w.base, 'elsewhere'));
    const ledger = join(w.base, 'elsewhere', 'memory.jsonl');
    writeFileSync(ledger, 'not a ledger row\n');
    const before = snapshotTree(w.base);
    const r = await runRebaseline(['--scope', 'global'], { HELIX_HOME: join(w.base, 'nohome'), HELIX_LEDGER: ledger }, 'bless');
    expect(r.code).toBe(2);
    expect(r.err).toBe(NO_HOME);
    expect(readFileSync(ledger, 'utf8')).toBe('not a ledger row\n');
    expect(snapshotTree(w.base)).toEqual(before);                 // no lock file, no home, no folder
  });

  it('control: a home that exists, empty, reaches the prompt as before', async () => {
    const home = join(w.base, 'home');
    mkdirSync(home, { mode: 0o755 });
    const r = await runRebaseline(['--scope', 'global'], { HELIX_HOME: home });
    expect(r.prompted).toBe(true);
    expect(r.code).toBe(1);
    expect(r.err).toContain('confirmation not given');
    expect(r.err).not.toContain('REFUSING');
  });

  it('the refusal belongs to the global scope: a project scope over the same missing home still reaches the prompt', async () => {
    const r = await runRebaseline(['--scope', w.proj], { HELIX_HOME: join(w.base, 'nohome') });
    expect(r.prompted).toBe(true);
    expect(r.code).toBe(1);
    expect(r.err).not.toContain(NO_HOME);
  });
});

// ---- decision S1: a variable no CLI reads stops none ------------------------------------------------------------------
describe('HELIX_SESSIONS, which no CLI reads, does not stop one (decision S1)', () => {
  it('control: helix-trigger with a relative HELIX_SESSIONS records as usual and writes nothing into the working directory', () => {
    const home = join(w.base, 'h');
    mkdirSync(home, { mode: 0o700 });
    const r = runTrigger(EVAL(), { HELIX_HOME: home, HELIX_SESSIONS: 'zq-sess.jsonl' });
    expect(r.code).toBe(0);
    expect(readFileSync(join(home, 'trigger.jsonl'), 'utf8')).toBe(r.out);
    expect(snapshotTree(w.cwd)).toEqual([]);
  });
});

// ---- the shipped shape: the entry point built from source and spawned ------------------------------------------------
describe('helix-trigger built from source (scripts/trigger-cli.ts), spawned with cwd outside the repository', () => {
  let bin: string;
  beforeAll(async () => { bin = await bundleCli('scripts/trigger-cli.ts'); }, 60_000);

  function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('HELIX_')) delete env[k];
    return { ...env, HOME: w.userHome, ...extra };
  }
  const spawnTrigger = (extra: Record<string, string>): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, [bin, ...EVAL()], { cwd: w.cwd, env: childEnv(extra), encoding: 'utf8', timeout: 30_000 });

  it('HELIX_HOME="" with HOME naming a throwaway directory: exit 0, the sink below $HOME/.helix, nothing in the working directory', () => {
    const home = join(w.userHome, '.helix');
    mkdirSync(home, { mode: 0o700 });
    const res = spawnTrigger({ HELIX_HOME: '' });
    expect(res.status).toBe(0);
    expect(readFileSync(join(home, 'trigger.jsonl'), 'utf8')).toBe(res.stdout);
    expect(snapshotTree(w.cwd)).toEqual([]);
  });

  // Final review G3: before the fix this home reached the sink's mkdir and the process crashed with exit 1 and a raw,
  // path-bearing ENAMETOOLONG.
  it('a HELIX_HOME whose final component is 256 bytes: exit 3, stdout empty, the one REFUSING line without the path, nothing created', () => {
    const before = snapshotTree(w.base);
    const res = spawnTrigger({ HELIX_HOME: join(w.base, 'zq'.repeat(128)) });
    expect(res.status).toBe(3);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^trigger-cli: REFUSING - [\x20-\x7e]+\n$/);
    expect(res.stderr).not.toContain('zqzq');
    expect(snapshotTree(w.base)).toEqual(before);
  });

  it('a relative HELIX_HOME: the process exit status is 3, stdout is empty, stderr is the one REFUSING line, nothing is created', () => {
    const before = snapshotTree(w.base);
    const res = spawnTrigger({ HELIX_HOME: 'zq-rel/home' });
    expect(res.status).toBe(3);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^trigger-cli: REFUSING - [\x20-\x7e]+\n$/);
    expect(res.stderr).not.toContain('zq-rel');
    expect(snapshotTree(w.base)).toEqual(before);
  });
});
