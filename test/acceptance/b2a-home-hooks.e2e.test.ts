// Third fix batch B2a, task D1 (design section 5, "hook" and "environment" rows; outline Review Focus 2 and 5): the two COMMITTED hook
// bundles, spawned as Claude Code spawns them (node <bundle>, JSON on stdin), over the home contract, and the shape of
// data/inventory/surface.json after the build. Every child runs with every HELIX_* variable stripped, HOME at a throwaway user home
// and a cwd outside the repository; a case that must not change a tree compares a digest (kind, mode, sha256) taken before and after.
// POSIX only. The same file runs on the e279889 bundles at Step 2 of task D1 and must show the old behaviour.
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPERSEDE_NOTE, SYMLINKED_HOME_NOTE, GLOBAL_LEDGER_READ_ONLY_NOTE } from '../../src/memory/content-frame.js';
import { HOME_REFUSED_START_NOTE, HOME_REFUSED_END_NOTE, SESSION_RECORD_DROPPED_NOTE } from '../../src/hooks/session-record.js';
import { buildControlHome, relocatedLedger, homeDigest, cleanupControlLayouts, CONTROL_FILES, CONTROL_LOCKS } from '../helpers/home-control-layouts.js';
import { BIN, REPO, POSIX, world, cleanupWorlds, envFor, strippedEnv, dotdotLayout, fifo, modeOf, kindOf, treeDigest, runNode } from '../helpers/bundle-run.js';

const suite = describe.skipIf(!POSIX);
afterEach(() => { cleanupWorlds(); cleanupControlLayouts(); });

const record = (content: string): string => JSON.stringify({
  id: `m_${content.slice(0, 6)}`, tx: '2026-06-10T00:00:00.000Z', validFrom: '2026-06-10T00:00:00.000Z', validTo: null,
  type: 'assert', state: 'Fresh', content, provenance: { source: 'user', sessionId: 'seed' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
}) + '\n';
const START_INPUT = (cwd: string, source = 'startup'): string => JSON.stringify({ cwd, hook_event_name: 'SessionStart', source });
const END_INPUT = JSON.stringify({ session_id: 's-d1', reason: 'clear' });
const recordsOf = (path: string): Array<Record<string, unknown>> =>
  readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
/** The cwd of a hook case: a 0755 directory holding a record file that a hook taking it for the home would read or tighten. */
function plantedWork(w: { work: string }): void {
  writeFileSync(join(w.work, 'memory.jsonl'), record('cwd fact'));
  chmodSync(join(w.work, 'memory.jsonl'), 0o664);
}

suite('SessionStart over the home contract', () => {
  it('an empty HELIX_HOME is unset: the hook reads ~/.helix, not the cwd', async () => {
    const w = world();
    const dot = join(w.userHome, '.helix');
    mkdirSync(dot, { mode: 0o700 });
    writeFileSync(join(dot, 'memory.jsonl'), record('default home fact'));
    plantedWork(w);
    const before = treeDigest(w.work);
    const r = await runNode(BIN.start, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: '' }), stdin: '{}' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('default home fact');
    expect(r.stdout).not.toContain('cwd fact');
    expect(treeDigest(w.work)).toEqual(before);
  }, 45_000);

  it.each([
    ['HELIX_HOME', '.'], ['HELIX_HOME', 'x/y'], ['HELIX_LEDGER', 'rel.jsonl'],
  ] as const)('%s=%s: the hook prints the one note, reads and writes nothing, exits 0 (a resume too)', async (name, value) => {
    const w = world();
    plantedWork(w);
    const helix: Record<string, string> = name === 'HELIX_HOME' ? { HELIX_HOME: value } : { HELIX_HOME: w.home, HELIX_LEDGER: value };
    const [workBefore, homeBefore] = [treeDigest(w.work), treeDigest(w.home)];
    for (const source of ['startup', 'resume']) {
      const r = await runNode(BIN.start, [], { cwd: w.work, env: envFor(w, helix), stdin: START_INPUT(w.work, source) });
      expect(r.code).toBe(0);
      expect(r.stdout, source).toBe(`${HOME_REFUSED_START_NOTE}\n`);
    }
    expect(treeDigest(w.work)).toEqual(workBefore);
    expect(treeDigest(w.home)).toEqual(homeBefore);
  }, 45_000);

  it('<link>/../name is the directory the kernel reaches', async () => {
    const w = world();
    const d = dotdotLayout(w);
    writeFileSync(join(d.kernel, 'memory.jsonl'), record('kernel fact'));
    writeFileSync(join(d.flat, 'memory.jsonl'), record('flat fact'));
    const r = await runNode(BIN.start, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: d.spelled }), stdin: '{}' });
    expect(r.stdout).toContain('kernel fact');
    expect(r.stdout).not.toContain('flat fact');
  }, 45_000);

  it('control (outline Review Focus 2): a symlinked home is read and says so', async () => {
    const w = world();
    const real = join(w.base, 'real');
    mkdirSync(real, { mode: 0o700 });
    writeFileSync(join(real, 'memory.jsonl'), record('linked home fact'));
    const link = join(w.base, 'hl');
    symlinkSync(real, link);
    const r = await runNode(BIN.start, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: link }), stdin: '{}' });
    expect(r.stdout).toContain(SYMLINKED_HOME_NOTE);
    expect(r.stdout).toContain('linked home fact');
  }, 45_000);

  it.each(['fifo', 'dir'] as const)('a resumed, compacted or forked session whose global ledger is a %s gets the supersede note alone; a startup gets nothing (ruling G)', async (shape) => {
    const w = world();
    const ledger = join(w.home, 'memory.jsonl');
    if (shape === 'fifo') fifo(ledger); else mkdirSync(ledger);
    expect(kindOf(ledger)).toBe(shape === 'fifo' ? 'fifo' : 'dir');       // the precondition the hook meets
    for (const source of ['resume', 'compact', 'fork']) {
      const r = await runNode(BIN.start, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: w.home }), stdin: START_INPUT(w.work, source), deadlineMs: 20_000 });
      expect(r.killed, source).toBe(false);
      expect(r.code, source).toBe(0);
      expect(r.stdout, source).toBe(`${SUPERSEDE_NOTE}\n`);
    }
    const startup = await runNode(BIN.start, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: w.home }), stdin: START_INPUT(w.work, 'startup') });
    expect(startup.stdout).toBe('');
  }, 90_000);

  it('a resumed session over a ledger that is a control file of the home carries the read-only note (ruling E)', async () => {
    const l = buildControlHome();
    const env = { ...strippedEnv(), HOME: l.base, HELIX_HOME: l.home, HELIX_LEDGER: join(l.home, 'witness.json') };
    const r = await runNode(BIN.start, [], { cwd: l.base, env, stdin: START_INPUT(l.base, 'resume') });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
  }, 45_000);
});

suite('SessionEnd over the home contract', () => {
  it('an empty HELIX_HOME is unset: the record goes to ~/.helix/sessions.jsonl and nothing to the cwd', async () => {
    const w = world();
    plantedWork(w);
    const before = treeDigest(w.work);
    const r = await runNode(BIN.end, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: '' }), stdin: END_INPUT });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);
    const sessions = join(w.userHome, '.helix', 'sessions.jsonl');
    expect(recordsOf(sessions)).toHaveLength(1);
    expect(modeOf(sessions)).toBe(0o600);
    expect(modeOf(join(w.userHome, '.helix'))).toBe(0o700);
    expect(treeDigest(w.work)).toEqual(before);
  }, 45_000);

  it.each([
    ['HELIX_HOME', '.'], ['HELIX_LEDGER', 'rel.jsonl'], ['HELIX_SESSIONS', 'rel.jsonl'],
  ] as const)('%s=%s: the hook prints the one note on stderr, writes nothing, exits 0', async (name, value) => {
    const w = world();
    plantedWork(w);
    const helix = name === 'HELIX_HOME' ? { HELIX_HOME: value } : { HELIX_HOME: w.home, [name]: value };
    const [workBefore, homeBefore] = [treeDigest(w.work), treeDigest(w.home)];
    const r = await runNode(BIN.end, [], { cwd: w.work, env: envFor(w, helix), stdin: END_INPUT });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(`${HOME_REFUSED_END_NOTE}\n`);
    expect(treeDigest(w.work)).toEqual(workBefore);
    expect(treeDigest(w.home)).toEqual(homeBefore);
  }, 45_000);

  it('<link>/../name is the directory the kernel reaches: the record lands there', async () => {
    const w = world();
    const d = dotdotLayout(w);
    const r = await runNode(BIN.end, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: d.spelled }), stdin: END_INPUT });
    expect(r.code).toBe(0);
    expect(recordsOf(join(d.kernel, 'sessions.jsonl'))).toHaveLength(1);
    expect(kindOf(join(d.flat, 'sessions.jsonl'))).toBe('absent');
  }, 45_000);

  it('a new HELIX_SESSIONS file in a 0755 shared folder is created 0600 and the folder keeps 0755 (ruling A, outline Review Focus 5)', async () => {
    const w = world();
    const file = join(w.out, 's.jsonl');
    const homeBefore = treeDigest(w.home);
    const r = await runNode(BIN.end, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: w.home, HELIX_SESSIONS: file }), stdin: END_INPUT });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);
    expect(modeOf(w.out)).toBe(0o755);
    expect(modeOf(file)).toBe(0o600);
    expect(recordsOf(file)).toHaveLength(1);
    expect(treeDigest(w.home)).toEqual(homeBefore);
  }, 45_000);

  it('control: a home that does not exist yet (its parent does) is made 0700 with the record 0600', async () => {
    const w = world();
    const home = join(w.base, 'nohome');
    const r = await runNode(BIN.end, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: home }), stdin: END_INPUT });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);
    expect(modeOf(home)).toBe(0o700);
    expect(modeOf(join(home, 'sessions.jsonl'))).toBe(0o600);
  }, 45_000);

  it('control: a stdin that holds no record stays silent', async () => {
    const w = world();
    const r = await runNode(BIN.end, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: w.home }), stdin: 'not json' });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);
  }, 45_000);

  // Ruling N1: nine control names (the ten of the home without sessions.jsonl itself) and the eleven lock names (the ten and the
  // global ledger's), spelled out in the helper and not read from src/.
  const REFUSED = [...CONTROL_FILES.filter((n) => n !== 'sessions.jsonl'), ...CONTROL_LOCKS];
  it('the refusal matrix holds twenty names', () => { expect(new Set(REFUSED).size).toBe(20); });
  it.each(REFUSED)('HELIX_SESSIONS at %s: the record is dropped with the one stderr line and the home is as it was', async (name) => {
    const l = buildControlHome();
    const before = homeDigest(l.home);
    const env = { ...strippedEnv(), HOME: l.base, HELIX_HOME: l.home, HELIX_SESSIONS: join(l.home, name) };
    const r = await runNode(BIN.end, [], { cwd: l.base, env, stdin: END_INPUT });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(`${SESSION_RECORD_DROPPED_NOTE}\n`);
    expect(homeDigest(l.home)).toEqual(before);
  }, 45_000);

  it.each(['default', 'relocated', 'relocated, default name'] as const)('HELIX_SESSIONS at the global ledger (%s): dropped, the ledger untouched', async (shape) => {
    const l = buildControlHome();
    const relocated = relocatedLedger(l);
    const named = shape === 'relocated' ? relocated : join(l.home, 'memory.jsonl');
    const env = {
      ...strippedEnv(), HOME: l.base, HELIX_HOME: l.home, HELIX_SESSIONS: named,
      ...(shape === 'default' ? {} : { HELIX_LEDGER: relocated }),
    };
    const [homeBefore, relocatedBefore] = [homeDigest(l.home), readFileSync(relocated)];
    const r = await runNode(BIN.end, [], { cwd: l.base, env, stdin: END_INPUT });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(`${SESSION_RECORD_DROPPED_NOTE}\n`);
    expect(homeDigest(l.home)).toEqual(homeBefore);
    expect(readFileSync(relocated).equals(relocatedBefore)).toBe(true);
  }, 45_000);

  // Plan review of 2026-11-08 (owner, rule M): a project's ledger, a file named memory.jsonl directly inside a folder named .helix,
  // is never a sessions file; a file of that name anywhere else is an ordinary one.
  it("HELIX_SESSIONS at a project's ledger <root>/.helix/memory.jsonl: dropped with the one stderr line, the project's tree unchanged", async () => {
    const w = world();
    const project = join(w.base, 'p');
    mkdirSync(join(project, '.helix'), { recursive: true });
    const ledger = join(project, '.helix', 'memory.jsonl');
    writeFileSync(ledger, record('project fact'));
    const before = treeDigest(project);
    const r = await runNode(BIN.end, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: w.home, HELIX_SESSIONS: ledger }), stdin: END_INPUT });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', `${SESSION_RECORD_DROPPED_NOTE}\n`]);
    expect(treeDigest(project)).toEqual(before);
  }, 45_000);

  it('control: HELIX_SESSIONS=<out>/memory.jsonl, outside any .helix folder, is an ordinary sessions file: created 0600 with one record', async () => {
    const w = world();
    const file = join(w.out, 'memory.jsonl');
    const r = await runNode(BIN.end, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: w.home, HELIX_SESSIONS: file }), stdin: END_INPUT });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);
    expect(recordsOf(file)).toHaveLength(1);
    expect(modeOf(file)).toBe(0o600);
  }, 45_000);

  it('a FIFO at HELIX_SESSIONS does not hold the hook: it ends inside the deadline with the line, and the FIFO stays', async () => {
    const w = world();
    const file = join(w.out, 's.jsonl');
    fifo(file);
    const r = await runNode(BIN.end, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: w.home, HELIX_SESSIONS: file }), stdin: END_INPUT, deadlineMs: 20_000 });
    expect(r.killed).toBe(false);
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', `${SESSION_RECORD_DROPPED_NOTE}\n`]);
    expect(kindOf(file)).toBe('fifo');
  }, 45_000);

  it('a directory at HELIX_SESSIONS: the record is dropped with the line', async () => {
    const w = world();
    const dir = join(w.out, 'd');
    mkdirSync(dir);
    const r = await runNode(BIN.end, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: w.home, HELIX_SESSIONS: dir }), stdin: END_INPUT });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', `${SESSION_RECORD_DROPPED_NOTE}\n`]);
    expect(kindOf(dir)).toBe('dir');
  }, 45_000);

  it('a symlinked home: nothing is written through the link and the line is printed', async () => {
    const w = world();
    const real = join(w.base, 'real');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(w.base, 'hl'));
    const before = treeDigest(real);
    const r = await runNode(BIN.end, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: join(w.base, 'hl') }), stdin: END_INPUT });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', `${SESSION_RECORD_DROPPED_NOTE}\n`]);
    expect(treeDigest(real)).toEqual(before);
  }, 45_000);
});

suite('data/inventory/surface.json after the build (design section 6; plan decision S1, plan decision P4)', () => {
  const surface = JSON.parse(readFileSync(join(REPO, 'data', 'inventory', 'surface.json'), 'utf8')) as {
    tools: Array<{ name: string }>; envVars: unknown; hooks: unknown; clis: unknown;
  };

  // The envVars array of e279889's surface.json as it stands (MEASURED 2026-11-08: `git show e279889:data/inventory/surface.json`).
  const E279889_ENV_VARS: ReadonlyArray<{ name: string; readIn: readonly string[] }> = [
    { name: 'HELIX_HOME', readIn: ['bin/helix-mcp.mjs', 'bin/hooks/session-end.mjs', 'bin/hooks/session-start.mjs'] },
    { name: 'HELIX_LEDGER', readIn: ['bin/helix-mcp.mjs', 'bin/hooks/session-start.mjs'] },
    { name: 'HELIX_SESSION', readIn: ['bin/helix-mcp.mjs'] },
    { name: 'HELIX_SESSIONS', readIn: ['bin/hooks/session-end.mjs'] },
    { name: 'OPENAI_API_KEY', readIn: ['bin/helix-mcp.mjs'] },
  ];

  it('the envVars change from e279889 is exactly one: HELIX_LEDGER gains bin/hooks/session-end.mjs as a reader (plan decision P4)', () => {
    const now = surface.envVars as Array<{ name: string; readIn: string[] }>;
    expect(now.map((e) => e.name)).toEqual(E279889_ENV_VARS.map((e) => e.name));   // no variable added, removed or reordered
    const changes = now.flatMap((e, i) => {
      const was = E279889_ENV_VARS[i]!.readIn;
      const added = e.readIn.filter((r) => !was.includes(r));
      const removed = was.filter((r) => !e.readIn.includes(r));
      return added.length + removed.length === 0 ? [] : [{ name: e.name, added, removed }];
    });
    expect(changes).toEqual([{ name: 'HELIX_LEDGER', added: ['bin/hooks/session-end.mjs'], removed: [] }]);
    expect(now.find((e) => e.name === 'HELIX_LEDGER')!.readIn).toEqual(['bin/helix-mcp.mjs', 'bin/hooks/session-end.mjs', 'bin/hooks/session-start.mjs']);
  });

  it('the nine tools, the two hooks and the three CLI contracts are as at e279889', () => {
    expect(surface.tools.map((t) => t.name).sort()).toEqual([
      'helix_codex_status', 'helix_dual_verify', 'helix_memory_adopt', 'helix_memory_commit', 'helix_memory_confirm',
      'helix_memory_erase', 'helix_memory_inspect', 'helix_memory_recall', 'helix_memory_recheck',
    ]);
    expect(surface.hooks).toEqual([
      { event: 'SessionEnd', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/hooks/session-end.mjs"', timeout: 10, bundle: 'bin/hooks/session-end.mjs' },
      { event: 'SessionStart', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/hooks/session-start.mjs"', timeout: 10, bundle: 'bin/hooks/session-start.mjs' },
    ]);
    expect(surface.clis).toEqual([
      { bundle: 'bin/helix-rebaseline.mjs', usage: 'usage: helix-rebaseline --scope global | --scope <absoluteProjectRoot>', noArgsExitCode: 2 },
      {
        bundle: 'bin/helix-trigger.mjs',
        usage: 'usage: trigger-cli --root <path> --run <id> [--service-result <s>] [--exit-code <s>] [--exit-status <s>]\n       trigger-cli --acknowledge',
        noArgsExitCode: 2,
      },
      { bundle: 'bin/helix-trust-resolve.mjs', usage: 'usage: helix-trust-resolve --scope <absoluteProjectRoot> --repair | --fresh', noArgsExitCode: 2 },
    ]);
  });
});
