// Third fix batch B2a, task D1 (design section 5, bundle e2e; outline Review Focus 1 to 5): the COMMITTED server, operator CLIs
// and dogfood script, spawned as Claude Code and systemd spawn them, over the home contract. Every case runs with every HELIX_*
// variable stripped, HOME at a throwaway user home and a cwd outside the repository; a case that must not change a tree
// compares a digest (kind, mode, sha256) taken before and after. POSIX only (FIFOs, modes, links). The hooks are in
// b2a-home-hooks.e2e.test.ts. The same files run on the e279889 bundles at Step 2 of task D1 and must show the old behaviour.
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { GLOBAL_LEDGER_READ_ONLY_NOTE } from '../../src/memory/content-frame.js';
import { GLOBAL_WRITE_REFUSAL, GLOBAL_READ_ONLY_STARTUP_LINE } from '../../src/memory/global-ledger.js';
import { LOCK_FOREIGN_OBJECT_REFUSAL } from '../../src/memory/lock.js';
import { RELATIVE_VALUE_TEXT } from '../../src/memory/home-env.js';
import { NotRegularHomeFileError } from '../../src/memory/home-files.js';
import { HOME_UNWRITABLE_TEXT, AUDIT_UNWRITABLE_TEXT } from '../../src/audit.js';
import { STORED_THEN_FAILED_RESPONSE } from '../../src/server/handlers.js';
import {
  buildControlHome, linkOwnerLedgerTo, relocatedLedger, homeDigest, sha256Of, cleanupControlLayouts, CONTROL_FILES, CONTROL_LOCKS,
  type ControlHome,
} from '../helpers/home-control-layouts.js';
import { rowsIn } from '../helpers/first-write-fixture.js';
import {
  BIN, POSIX, AS_ROOT, world, cleanupWorlds, envFor, strippedEnv, dotdotLayout, fifo, modeOf, kindOf, sizeOrZero, treeDigest,
  runCommand, runNode, viaPty, hasScript, rpc, textOf, isErr, committedId, type World,
} from '../helpers/bundle-run.js';

const suite = describe.skipIf(!POSIX);

// FIXED AT THE TEXT REVIEW (plan A3, text 5): the one line the server prints when it refuses to start on its home variables.
const STARTUP_REFUSAL_LINE = 'helix: REFUSING TO START - HELIX_HOME or HELIX_LEDGER is a relative path or a path that cannot be resolved; only an absolute path is accepted, and an empty value counts as unset';
// FIXED AT THE TEXT REVIEW (plan A5, text 9): the first line of the rebaseline CLI's refusal of a home that does not exist.
const REBASELINE_NO_HOME_LINE = 'helix-rebaseline: REFUSING - the Helix home directory does not exist, so there is no rollback witness to re-baseline.';
const FACT = 'zeta deploy fact';                    // short, no path: a long segment inside a committed fact is redacted
const COMMIT = { name: 'helix_memory_commit', args: { content: FACT, source: 'user' } };
const RECALL = { name: 'helix_memory_recall', args: { query: 'deploy' } };
const NONE_ID = 'm_00000000-0000-4000-8000-000000000001';

/** audit.jsonl and metrics.jsonl legitimately grow with every tool call. */
const stable = (lines: string[]): string[] => lines.filter((l) => !/^(audit|metrics)\.jsonl\|/.test(l));
const lineCount = (path: string): number => readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').length;
/** A control home's environment: HOME at its base (no ~/.helix there), the home, and optionally a relocated ledger. */
const controlEnv = (l: ControlHome, ledger?: string): Record<string, string> =>
  ({ ...strippedEnv(), HOME: l.base, HELIX_HOME: l.home, ...(ledger === undefined ? {} : { HELIX_LEDGER: ledger }) });

let open: Client[] = [];
afterEach(async () => {
  for (const c of open) { try { await c.close(); } catch { /* already closed */ } }
  open = [];
  cleanupWorlds();
  cleanupControlLayouts();
});
async function connect(env: Record<string, string>, cwd: string): Promise<Client> {
  const client = new Client({ name: 'b2a-home-e2e', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN.server], cwd, env }));
  open.push(client);
  return client;
}
const textOfCall = (r: unknown): string => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('');

suite('Review Focus 1: the dogfood unit\'s own environment keeps working (a control: green on the e279889 bundles too)', () => {
  it('server, both hooks and helix-trigger through dogfood-postrun.sh, with HOME alone in the environment and cwd the tinytask project', async () => {
    const w = world();
    const tiny = join(w.userHome, 'dev', 'helix-dogfood', 'tinytask');
    mkdirSync(join(tiny, '.helix'), { recursive: true });
    writeFileSync(join(tiny, 'ISSUES.md'), '# issues\n');
    const env = envFor(w);                                   // no HELIX_HOME, no HELIX_SESSIONS: the shape of the systemd unit
    const dot = join(w.userHome, '.helix');

    const r = await rpc(env, tiny, [
      { name: 'helix_memory_commit', args: { content: 'the dogfood global fact', source: 'user', scope: 'global' } },
      { name: 'helix_memory_commit', args: { content: 'the dogfood project fact', source: 'user' } },
    ]);
    expect(r.timedOut).toBe(false);
    for (const id of [2, 3]) expect(isErr(r.responses.get(id)), textOf(r.responses.get(id))).toBe(false);
    // The recall goes to a second server start: calls written together are not answered in the order they were written, so a
    // recall sent with the commits can run before them (seen on the e279889 bundle too).
    const q = await rpc(env, tiny, [{ name: 'helix_memory_recall', args: { query: 'dogfood fact' } }]);
    expect(q.timedOut).toBe(false);
    expect(isErr(q.responses.get(2)), textOf(q.responses.get(2))).toBe(false);
    expect(textOf(q.responses.get(2))).toContain('the dogfood global fact');
    expect(textOf(q.responses.get(2))).toContain('the dogfood project fact');
    expect(rowsIn(join(dot, 'memory.jsonl'))).toEqual(['the dogfood global fact']);
    expect(rowsIn(join(tiny, '.helix', 'memory.jsonl'))).toEqual(['the dogfood project fact']);
    expect(modeOf(dot)).toBe(0o700);
    expect(modeOf(join(dot, 'memory.jsonl'))).toBe(0o600);

    const start = await runNode(BIN.start, [], { cwd: tiny, env, stdin: JSON.stringify({ cwd: tiny, hook_event_name: 'SessionStart', source: 'startup' }) });
    expect(start.code).toBe(0);
    expect(start.stdout).toContain('DATA[Fresh:global]| the dogfood global fact');
    expect(start.stdout).toContain('DATA[Fresh:project]| the dogfood project fact');

    const end = await runNode(BIN.end, [], { cwd: tiny, env, stdin: JSON.stringify({ session_id: 'dogfood-d1', reason: 'clear' }) });
    expect([end.code, end.stdout, end.stderr]).toEqual([0, '', '']);
    const sessions = join(dot, 'sessions.jsonl');
    expect((JSON.parse(readFileSync(sessions, 'utf8').trim()) as { sessionId: string }).sessionId).toBe('dogfood-d1');
    expect(modeOf(sessions)).toBe(0o600);

    const post = await runCommand('bash', [BIN.postrun, tiny], {
      cwd: tiny, env: { ...env, SERVICE_RESULT: 'success', EXIT_CODE: 'exited', EXIT_STATUS: '0', INVOCATION_ID: 'd1-invocation' }, deadlineMs: 60_000,
    });
    expect(post.code).toBe(0);
    const sink = join(dot, 'trigger.jsonl');
    const evaluations = readFileSync(sink, 'utf8').split('\n').filter((l) => l !== '');
    expect(evaluations).toHaveLength(1);
    expect(JSON.parse(evaluations[0]!)).toMatchObject({ kind: 'evaluation', run: 'd1-invocation', project: 'owned' });
    expect(post.stdout).toContain(evaluations[0]!);
    expect(modeOf(sink)).toBe(0o600);
    expect(readFileSync(join(tiny, 'ISSUES.md'), 'utf8')).toBe('# issues\n');   // a successful run files no issue
    expect(modeOf(w.userHome)).toBe(0o755);
  }, 120_000);
});

suite('environment values over the shipped server (rulings C and D)', () => {
  it('an empty HELIX_HOME is unset: the server starts on the default home below HOME and the cwd is not taken for a home', async () => {
    const w = world();
    writeFileSync(join(w.work, 'config.json'), '{}\n');
    chmodSync(join(w.work, 'config.json'), 0o664);
    const before = treeDigest(w.work);
    const r = await rpc(envFor(w, { HELIX_HOME: '' }), w.work, [COMMIT]);
    expect(r.timedOut).toBe(false);
    expect(isErr(r.responses.get(2)), textOf(r.responses.get(2))).toBe(false);
    expect(rowsIn(join(w.userHome, '.helix', 'memory.jsonl'))).toEqual([FACT]);
    expect(treeDigest(w.work)).toEqual(before);
  }, 45_000);

  it('an empty HELIX_LEDGER is unset: the commit lands in <home>/memory.jsonl', async () => {
    const w = world();
    const r = await rpc(envFor(w, { HELIX_HOME: w.home, HELIX_LEDGER: '' }), w.work, [COMMIT]);
    expect(isErr(r.responses.get(2)), textOf(r.responses.get(2))).toBe(false);
    expect(rowsIn(join(w.home, 'memory.jsonl'))).toEqual([FACT]);
  }, 45_000);

  it.each([['HELIX_HOME', '.'], ['HELIX_HOME', 'x/y'], ['HELIX_LEDGER', 'rel.jsonl'], ['HELIX_LEDGER', './m.jsonl']] as const)(
    '%s=%s: the server refuses to start with the one constant line and exit 78, and reads and writes nothing',
    async (name, value) => {
      const w = world();
      writeFileSync(join(w.work, 'config.json'), '{}\n');
      chmodSync(join(w.work, 'config.json'), 0o664);
      const helix: Record<string, string> = name === 'HELIX_HOME' ? { HELIX_HOME: value } : { HELIX_HOME: w.home, HELIX_LEDGER: value };
      const [workBefore, homeBefore] = [treeDigest(w.work), treeDigest(w.home)];
      const r = await runNode(BIN.server, [], { cwd: w.work, env: envFor(w, helix) });
      expect(r.killed).toBe(false);
      expect(r.code).toBe(78);
      expect(r.stderr).toBe(`${STARTUP_REFUSAL_LINE}\n`);
      expect(r.stdout).toBe('');
      expect(treeDigest(w.work)).toEqual(workBefore);
      expect(treeDigest(w.home)).toEqual(homeBefore);
    }, 45_000);

  it('control (plan decision P4): a relative HELIX_SESSIONS, which the server does not read, does not stop it', async () => {
    const w = world();
    const r = await rpc(envFor(w, { HELIX_HOME: w.home, HELIX_SESSIONS: 'rel.jsonl' }), w.work, [COMMIT]);
    expect(isErr(r.responses.get(2)), textOf(r.responses.get(2))).toBe(false);
    expect(r.stderr).not.toContain('REFUSING');
  }, 45_000);

  it('a HELIX_HOME whose directory part is a link loop cannot be resolved: exit 78 with the same line', async () => {
    const w = world();
    const la = join(w.base, 'la');
    const lb = join(w.base, 'lb');
    symlinkSync(lb, la);
    symlinkSync(la, lb);
    expect(() => statSync(join(la, 'home'))).toThrow(/ELOOP/);          // the kernel's own answer, so the case cannot pass vacuously
    const r = await runNode(BIN.server, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: join(la, 'home') }) });
    expect(r.killed).toBe(false);
    expect(r.code).toBe(78);
    expect(r.stderr).toBe(`${STARTUP_REFUSAL_LINE}\n`);
  }, 45_000);

  it('<link>/../name is the directory the kernel reaches: the commit lands there and not in the text-collapsed directory', async () => {
    const w = world();
    const d = dotdotLayout(w);
    const r = await rpc(envFor(w, { HELIX_HOME: d.spelled }), w.work, [COMMIT]);
    expect(isErr(r.responses.get(2)), textOf(r.responses.get(2))).toBe(false);
    expect(rowsIn(join(d.kernel, 'memory.jsonl'))).toEqual([FACT]);
    expect(existsSync(join(d.flat, 'memory.jsonl'))).toBe(false);
    expect(readdirSync(d.flat)).toEqual([]);
  }, 45_000);

  it('a home that does not exist yet (its parent does) is created 0700 by the first commit, and its files 0600 (a control)', async () => {
    const w = world();
    const home = join(w.base, 'nohome');
    const r = await rpc(envFor(w, { HELIX_HOME: home }), w.work, [COMMIT]);
    expect(isErr(r.responses.get(2)), textOf(r.responses.get(2))).toBe(false);
    expect(modeOf(home)).toBe(0o700);
    expect(modeOf(join(home, 'memory.jsonl'))).toBe(0o600);
    expect(modeOf(join(home, 'ledger-mac-master.key'))).toBe(0o600);
  }, 45_000);
});

suite('directory modes over the shipped server (rulings A and B)', () => {
  it('a 0555 home at start becomes 0500: no write permission is added and the line names the mode it set', async () => {
    const w = world();
    chmodSync(w.home, 0o555);
    const r = await rpc(envFor(w, { HELIX_HOME: w.home }), w.work, []);
    expect(r.timedOut).toBe(false);
    expect(r.stderr).toContain(`helix: tightened HELIX_HOME ${w.home} from 0555 to 0500 `);
    expect(modeOf(w.home)).toBe(0o500);
  }, 45_000);

  it('a 0777 home keeps its mode through a SessionEnd record and is tightened, with the line, by the next server start (IT-LOW 17)', async () => {
    const w = world();
    chmodSync(w.home, 0o777);
    const end = await runNode(BIN.end, [], { cwd: w.work, env: envFor(w, { HELIX_HOME: w.home }), stdin: JSON.stringify({ session_id: 's-d1', reason: 'clear' }) });
    expect(end.code).toBe(0);
    expect(modeOf(w.home)).toBe(0o777);
    const r = await rpc(envFor(w, { HELIX_HOME: w.home }), w.work, []);
    expect(r.stderr).toContain(`helix: tightened HELIX_HOME ${w.home} from 0777 to 0700 `);
    expect(modeOf(w.home)).toBe(0o700);
  }, 45_000);
});

suite('a global ledger that leads to a file the home keeps for itself (ruling E)', () => {
  it.each(['witness.json', 'projects.json', 'ledger-mac-master.key', 'config.json'])(
    'G17/G18: the owner ledger is a link to %s: startup says so once, a read carries the note, a commit is refused, no file of the home changes',
    async (name) => {
      const l = buildControlHome();
      const ledger = linkOwnerLedgerTo(l, name);
      expect(lstatSync(ledger).isSymbolicLink()).toBe(true);                 // the link is what stands at the owner's name
      const target = join(l.home, name);
      const moved = join(l.base, 'owner-ledger.jsonl');
      const [targetSha, movedSha] = [sha256Of(target), sha256Of(moved)];
      const before = stable(homeDigest(l.home));
      const r = await rpc(controlEnv(l), l.base, [RECALL, COMMIT]);
      expect(r.timedOut).toBe(false);
      expect(r.stderr.split(GLOBAL_READ_ONLY_STARTUP_LINE).length - 1).toBe(1);
      expect(textOf(r.responses.get(2))).toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
      expect(isErr(r.responses.get(3))).toBe(true);
      expect(textOf(r.responses.get(3))).toContain(GLOBAL_WRITE_REFUSAL.commit);
      expect(sha256Of(target)).toBe(targetSha);
      expect(sha256Of(moved)).toBe(movedSha);
      expect(stable(homeDigest(l.home))).toEqual(before);
    }, 60_000);

  it.each([...CONTROL_FILES, ...CONTROL_LOCKS])(
    'HELIX_LEDGER at %s: the commit is refused, the fact reaches no file of the home, and the home is as it was',
    async (name) => {
      const l = buildControlHome();
      const before = stable(homeDigest(l.home));
      const r = await rpc(controlEnv(l, join(l.home, name)), l.base, [COMMIT]);
      expect(r.timedOut).toBe(false);
      expect(isErr(r.responses.get(2))).toBe(true);
      expect(textOf(r.responses.get(2))).toContain(GLOBAL_WRITE_REFUSAL.commit);
      for (const entry of readdirSync(l.home)) {
        if (lstatSync(join(l.home, entry)).isFile()) expect(readFileSync(join(l.home, entry)).includes(FACT), entry).toBe(false);
      }
      expect(stable(homeDigest(l.home))).toEqual(before);
    }, 60_000);

  it('control (outline Review Focus 3): a ledger relocated outside the home, a regular file, stays writable and carries no startup line', async () => {
    const l = buildControlHome();
    const ledger = relocatedLedger(l);
    const r = await rpc(controlEnv(l, ledger), l.base, [COMMIT]);
    expect(isErr(r.responses.get(2)), textOf(r.responses.get(2))).toBe(false);
    expect(r.stderr).not.toContain(GLOBAL_READ_ONLY_STARTUP_LINE);
    expect(rowsIn(ledger)).toEqual([FACT]);
    expect(lineCount(join(l.home, 'memory.jsonl'))).toBe(2);              // the owner's own ledger is untouched
  }, 60_000);

  it.skipIf(!hasScript)('helix-rebaseline --scope global with the ledger at a control file refuses with exit 2 under a terminal and writes nothing', () => {
    const l = buildControlHome();
    const before = homeDigest(l.home);
    const res = viaPty(BIN.rebaseline, ['--scope', 'global'], { cwd: l.base, env: controlEnv(l, join(l.home, 'witness.json')) });
    expect(res.status, res.out).toBe(2);
    expect(res.out).toContain("helix-rebaseline: REFUSING - the global memory file's path cannot be resolved");
    expect(res.out).toContain('or leads to another file of the Helix home.');
    expect(homeDigest(l.home)).toEqual(before);
  }, 60_000);
});

suite('the master key is read through a link and its mode is left alone (ruling J1)', () => {
  /** The key moved to a 0644 file outside the home, a link left at its name; or the whole home reached through a link. */
  function looseKey(l: ControlHome, how: 'key-link' | 'home-link'): { key: string; env: Record<string, string> } {
    const outside = join(l.base, 'outside');
    mkdirSync(outside);
    const at = join(l.home, 'ledger-mac-master.key');
    const bytes = readFileSync(at);
    expect(bytes.length).toBe(32);
    if (how === 'key-link') {
      const key = join(outside, 'k');
      writeFileSync(key, bytes);
      chmodSync(key, 0o644);
      unlinkSync(at);
      symlinkSync(key, at);
      return { key, env: controlEnv(l) };
    }
    chmodSync(at, 0o644);
    const link = join(l.base, 'hl');
    symlinkSync(l.home, link);
    return { key: at, env: { ...controlEnv(l), HELIX_HOME: link } };
  }

  it.each(['key-link', 'home-link'] as const)('%s: one SessionStart and one server start leave the key at 0644 and the read is still served', async (how) => {
    const l = buildControlHome();
    const { key, env } = looseKey(l, how);
    expect(modeOf(key)).toBe(0o644);
    const hook = await runNode(BIN.start, [], { cwd: l.base, env, stdin: '{}' });
    expect(hook.code).toBe(0);
    expect(hook.stdout).toContain('alpha deploy fact');
    const r = await rpc(env, l.base, [RECALL]);
    expect(textOf(r.responses.get(2))).toContain('alpha deploy fact');
    expect(modeOf(key)).toBe(0o644);
  }, 60_000);
});

suite('a FIFO at a name of the home answers inside a deadline (rulings J2 and J3)', () => {
  // The deadline (20 s) is well past the lock budget (5 s). On the e279889 bundles the blocking opens never return and the case ends
  // in the hard kill, which is the red of Step 2. codex-log.jsonl is not here: it is reachable only through helix_dual_verify and
  // helix_codex_status, which start the codex CLI, and the bundle matrix does not start it (task A8's child test carries that name).
  const NOT_REGULAR = new NotRegularHomeFileError().message;

  it('a FIFO at the master key: the server starts and a commit is refused before its row', async () => {
    const l = buildControlHome();
    unlinkSync(join(l.home, 'ledger-mac-master.key'));
    fifo(join(l.home, 'ledger-mac-master.key'));
    const ledger = join(l.home, 'memory.jsonl');
    const bytes = sizeOrZero(ledger);
    const r = await rpc(controlEnv(l), l.base, [COMMIT]);
    expect(r.timedOut).toBe(false);
    expect(isErr(r.responses.get(2))).toBe(true);
    expect(textOf(r.responses.get(2))).toContain(NOT_REGULAR);
    expect(sizeOrZero(ledger)).toBe(bytes);
    expect(kindOf(join(l.home, 'ledger-mac-master.key'))).toBe('fifo');
  }, 60_000);

  it('a FIFO at the key lock of a fresh home: the commit is refused with the lock text and no row is stored (WBR-locks L-3)', async () => {
    const w = world();
    fifo(join(w.home, 'ledger-mac-master.key.lock'));
    const r = await rpc(envFor(w, { HELIX_HOME: w.home }), w.work, [COMMIT]);
    expect(r.timedOut).toBe(false);
    expect(isErr(r.responses.get(2))).toBe(true);
    expect(textOf(r.responses.get(2))).toContain(LOCK_FOREIGN_OBJECT_REFUSAL);
    expect(sizeOrZero(join(w.home, 'memory.jsonl'))).toBe(0);
  }, 60_000);

  it('a FIFO at witness.json.lock: the commit is refused with the lock text and the ledger keeps its bytes (WBR-bundle F3)', async () => {
    const l = buildControlHome();
    fifo(join(l.home, 'witness.json.lock'));
    const ledger = join(l.home, 'memory.jsonl');
    const before = readFileSync(ledger);
    const r = await rpc(controlEnv(l), l.base, [COMMIT]);
    expect(r.timedOut).toBe(false);
    expect(isErr(r.responses.get(2))).toBe(true);
    expect(textOf(r.responses.get(2))).toContain(LOCK_FOREIGN_OBJECT_REFUSAL);
    expect(readFileSync(ledger).equals(before)).toBe(true);
  }, 60_000);

  it('a FIFO at metrics.jsonl: two calls in a row are both answered and the FIFO stays', async () => {
    const l = buildControlHome();
    unlinkSync(join(l.home, 'metrics.jsonl'));
    fifo(join(l.home, 'metrics.jsonl'));
    const r = await rpc(controlEnv(l), l.base, [RECALL, { name: 'helix_memory_recall', args: { query: 'beta' } }]);
    expect(r.timedOut).toBe(false);
    expect(isErr(r.responses.get(2)), textOf(r.responses.get(2))).toBe(false);
    expect(isErr(r.responses.get(3)), textOf(r.responses.get(3))).toBe(false);
    expect(kindOf(join(l.home, 'metrics.jsonl'))).toBe('fifo');
  }, 60_000);

  it('a FIFO at projects.json: a recall is answered and the FIFO stays', async () => {
    const l = buildControlHome();
    unlinkSync(join(l.home, 'projects.json'));
    fifo(join(l.home, 'projects.json'));
    const r = await rpc(controlEnv(l), l.base, [RECALL]);
    expect(r.timedOut).toBe(false);
    expect(r.responses.has(2)).toBe(true);
    expect(kindOf(join(l.home, 'projects.json'))).toBe('fifo');
  }, 60_000);

  it('a FIFO at audit.jsonl: a confirm is refused before its row with the audit text', async () => {
    const l = buildControlHome();
    unlinkSync(join(l.home, 'audit.jsonl'));
    fifo(join(l.home, 'audit.jsonl'));
    const ledger = join(l.home, 'memory.jsonl');
    const before = readFileSync(ledger);
    const r = await rpc(controlEnv(l), l.base, [{ name: 'helix_memory_confirm', args: { id: l.ids[0]! } }]);
    expect(r.timedOut).toBe(false);
    expect(isErr(r.responses.get(2))).toBe(true);
    expect(textOf(r.responses.get(2))).toContain(AUDIT_UNWRITABLE_TEXT);
    expect(readFileSync(ledger).equals(before)).toBe(true);
    expect(kindOf(join(l.home, 'audit.jsonl'))).toBe('fifo');
  }, 60_000);
});

suite('answers match the ledger (ruling J4)', () => {
  it.skipIf(AS_ROOT)('a project confirm after the home turned 0500 is refused before its row with the home text, and the project ledger keeps its bytes', async () => {
    const w = world();
    const proj = join(w.base, 'proj');
    mkdirSync(join(proj, '.helix'), { recursive: true });
    const client = await connect(envFor(w, { HELIX_HOME: w.home }), proj);
    const id = committedId({ result: await client.callTool({ name: 'helix_memory_commit', arguments: { content: FACT, source: 'user' } }) });
    const ledger = join(proj, '.helix', 'memory.jsonl');
    const before = readFileSync(ledger);
    chmodSync(w.home, 0o500);
    const res = await client.callTool({ name: 'helix_memory_confirm', arguments: { id } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOfCall(res)).toContain(HOME_UNWRITABLE_TEXT);
    expect(readFileSync(ledger).equals(before)).toBe(true);
  }, 60_000);

  // Final review G10 (revising plan decision B4-2): the look in front of the row answers a home whose own name is a link with
  // ensureHelixDir's symlinked-home refusal. Before, a self-loop home was left to the store, whose answers named another cause.
  it('HELIX_HOME a self-loop link: erase, confirm and recheck answer the symlinked-home refusal of the look (final review G10)', async () => {
    const w = world();
    const loop = join(w.base, 'hl');
    symlinkSync(loop, loop);
    expect(() => statSync(loop)).toThrow(/ELOOP/);
    const probe = join(w.work, 'probe.txt');                              // the recheck's file: present, so the check itself is well-formed
    writeFileSync(probe, 'zeta\n');
    const r = await rpc(envFor(w, { HELIX_HOME: loop }), w.work, [
      { name: 'helix_memory_erase', args: { id: NONE_ID } },
      { name: 'helix_memory_confirm', args: { id: NONE_ID } },
      { name: 'helix_memory_recheck', args: { id: NONE_ID, check: { kind: 'file-contains', path: probe, pattern: 'zeta' } } },
    ]);
    expect(r.timedOut).toBe(false);
    for (const id of [2, 3, 4]) {
      expect(isErr(r.responses.get(id))).toBe(true);
      expect(textOf(r.responses.get(id))).toBe(`refusing to use ${loop}: it is a symlink, not a directory Helix owns`);
    }
  }, 60_000);

  it('the home relinked to a missing target after the start: erase, confirm and recheck answer the symlinked-home refusal and nothing is written (final review G10)', async () => {
    const w = world();
    const probe = join(w.work, 'probe.txt');
    writeFileSync(probe, 'zeta\n');
    const client = await connect(envFor(w, { HELIX_HOME: w.home }), w.work);
    const userId = committedId({ result: await client.callTool({ name: 'helix_memory_commit', arguments: { content: FACT, source: 'user', scope: 'global' } }) });
    const relayedId = committedId({ result: await client.callTool({ name: 'helix_memory_commit', arguments: { content: `${FACT} relayed`, source: 'user-relayed', scope: 'global' } }) });
    const real = `${w.home}.real`;
    renameSync(w.home, real);
    symlinkSync(join(w.base, 'gone', 'helix'), w.home);                   // a link to a target that does not exist
    expect(lstatSync(w.home).isSymbolicLink()).toBe(true);
    const before = treeDigest(real);
    const answers = [
      await client.callTool({ name: 'helix_memory_erase', arguments: { id: userId } }),
      await client.callTool({ name: 'helix_memory_confirm', arguments: { id: userId } }),
      await client.callTool({ name: 'helix_memory_recheck', arguments: { id: relayedId, check: { kind: 'file-contains', path: probe, pattern: 'zeta' } } }),
    ];
    for (const res of answers) {
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(textOfCall(res)).toBe(`refusing to use ${w.home}: it is a symlink, not a directory Helix owns`);
    }
    expect(treeDigest(real), 'no row and no audit row in the real home').toEqual(before);
    expect(existsSync(join(w.base, 'gone')), 'nothing was created at the link target').toBe(false);
  }, 60_000);

  // Plan decision P5 at the bundle: the server runs under a file-size limit and audit.jsonl already holds that many bytes, so the
  // look before the row passes (kinds and permissions only) and the audit append after the stored confirmation fails with EFBIG
  // (Node ignores SIGXFSZ). Every other file the call writes stays far below the limit.
  const hasPrlimit = POSIX && spawnSync('prlimit', ['--version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!hasPrlimit)('P5: a confirm whose audit row cannot be appended after its row is stored answers the stored-then-failed text, and the row stays', async () => {
    const LIMIT = 1_048_576;
    const l = buildControlHome();
    const audit = join(l.home, 'audit.jsonl');
    writeFileSync(audit, Buffer.alloc(LIMIT, 0x0a));
    const probe = join(l.base, 'probe');
    writeFileSync(probe, Buffer.alloc(LIMIT, 0x0a));
    const p = spawnSync('prlimit', [`--fsize=${LIMIT}`, process.execPath, '-e', "require('node:fs').appendFileSync(process.argv[1], 'x')", probe], { encoding: 'utf8' });
    expect(p.status).not.toBe(0);                                           // the precondition: under the limit a node child cannot grow
    expect(p.stderr).toContain('EFBIG');                                    // a file that already holds LIMIT bytes
    expect(statSync(probe).size).toBe(LIMIT);
    const ledger = join(l.home, 'memory.jsonl');
    const rowsBefore = lineCount(ledger);
    const client = new Client({ name: 'b2a-home-e2e', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: 'prlimit', args: [`--fsize=${LIMIT}`, process.execPath, BIN.server], cwd: l.base, env: controlEnv(l) }));
    open.push(client);
    const res = await client.callTool({ name: 'helix_memory_confirm', arguments: { id: l.ids[0]! } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOfCall(res)).toContain(STORED_THEN_FAILED_RESPONSE.confirm);
    expect(lineCount(ledger)).toBe(rowsBefore + 1);                         // the confirmation was stored
    expect(statSync(audit).size).toBe(LIMIT);                               // and no part of an audit row was written
  }, 60_000);
});

suite('the operator CLIs resolve their environment like the server (rulings C, D and N3; plan decision P2)', () => {
  const relativeLine = (head: string, variable: 'HELIX_HOME' | 'HELIX_LEDGER'): string => `${head}REFUSING - ${RELATIVE_VALUE_TEXT[variable]}`;

  it.skipIf(!hasScript)('helix-rebaseline --scope global with a relative HELIX_HOME refuses with exit 2 and creates nothing', () => {
    const w = world();
    const before = treeDigest(w.work);
    const res = viaPty(BIN.rebaseline, ['--scope', 'global'], { cwd: w.work, env: envFor(w, { HELIX_HOME: 'x/y' }) });
    expect(res.status, res.out).toBe(2);
    expect(res.out).toContain(relativeLine('helix-rebaseline: ', 'HELIX_HOME'));
    expect(treeDigest(w.work)).toEqual(before);
  }, 60_000);

  it.skipIf(!hasScript)('helix-rebaseline --scope global with a home that does not exist refuses with exit 2 and creates nothing (N3)', () => {
    const w = world();
    const home = join(w.base, 'nohome');
    const res = viaPty(BIN.rebaseline, ['--scope', 'global'], { cwd: w.work, env: envFor(w, { HELIX_HOME: home }) });
    expect(res.status, res.out).toBe(2);
    expect(res.out).toContain(REBASELINE_NO_HOME_LINE);
    expect(res.out).toContain('Nothing was created.');
    expect(kindOf(home)).toBe('absent');
  }, 60_000);

  it.skipIf(!hasScript)('helix-trust-resolve with a relative HELIX_HOME refuses with exit 2', () => {
    const w = world();
    const res = viaPty(BIN.trustResolve, ['--scope', w.work, '--repair'], { cwd: w.work, env: envFor(w, { HELIX_HOME: 'x/y' }) });
    expect(res.status, res.out).toBe(2);
    expect(res.out).toContain(relativeLine('helix-trust-resolve: ', 'HELIX_HOME'));
  }, 60_000);
});

suite('helix-trigger and its sink (rulings C, D and F; plan decision P2)', () => {
  const triggerArgs = (w: World): string[] => {
    const root = join(w.base, 'proj');
    mkdirSync(root, { recursive: true });
    return ['--root', root, '--run', 'd1-run'];
  };
  const sinkLines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');

  it('a relative HELIX_HOME is refused with exit 3 and the one line; nothing is written under the cwd', async () => {
    const w = world();
    const before = treeDigest(w.work);
    const r = await runNode(BIN.trigger, triggerArgs(w), { cwd: w.work, env: envFor(w, { HELIX_HOME: 'x/y' }) });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe(`trigger-cli: REFUSING - ${RELATIVE_VALUE_TEXT.HELIX_HOME}\n`);
    expect(r.stdout).toBe('');
    expect(treeDigest(w.work)).toEqual(before);
  }, 45_000);

  it('an empty HELIX_HOME is unset: the evaluation goes to ~/.helix/trigger.jsonl at 0600 and nothing to the cwd', async () => {
    const w = world();
    const r = await runNode(BIN.trigger, triggerArgs(w), { cwd: w.work, env: envFor(w, { HELIX_HOME: '' }) });
    expect(r.code, r.stderr).toBe(0);
    const sink = join(w.userHome, '.helix', 'trigger.jsonl');
    expect(JSON.parse(sinkLines(sink)[0]!)).toMatchObject({ kind: 'evaluation', run: 'd1-run' });
    expect(modeOf(sink)).toBe(0o600);
    expect(existsSync(join(w.work, 'trigger.jsonl'))).toBe(false);
  }, 45_000);

  it('<link>/../name is the directory the kernel reaches: the evaluation is appended there', async () => {
    const w = world();
    const d = dotdotLayout(w);
    const r = await runNode(BIN.trigger, triggerArgs(w), { cwd: w.work, env: envFor(w, { HELIX_HOME: d.spelled }) });
    expect(r.code, r.stderr).toBe(0);
    expect(sinkLines(join(d.kernel, 'trigger.jsonl'))).toHaveLength(1);
    expect(readdirSync(d.flat)).toEqual([]);
  }, 45_000);

  it('a symlinked home is refused with exit 3 and the link target gains nothing', async () => {
    const w = world();
    const real = join(w.base, 'real');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(w.base, 'hl'));
    const before = treeDigest(real);
    const r = await runNode(BIN.trigger, triggerArgs(w), { cwd: w.work, env: envFor(w, { HELIX_HOME: join(w.base, 'hl') }) });
    expect(r.code).toBe(3);
    expect(r.stderr.startsWith('trigger-cli: REFUSING - ')).toBe(true);
    expect(r.stdout).toBe('');
    expect(treeDigest(real)).toEqual(before);
  }, 45_000);

  it('a home whose parent chain does not exist is refused with exit 3 and no chain is made', async () => {
    const w = world();
    const r = await runNode(BIN.trigger, triggerArgs(w), { cwd: w.work, env: envFor(w, { HELIX_HOME: join(w.base, 'no', 'such', 'home') }) });
    expect(r.code).toBe(3);
    expect(r.stderr.startsWith('trigger-cli: REFUSING - ')).toBe(true);
    expect(r.stdout).toBe('');
    expect(kindOf(join(w.base, 'no'))).toBe('absent');
  }, 45_000);

  it('a FIFO at the sink is not opened for a hang: exit 1 inside the deadline with the constant line of a non-regular file, no record, and the FIFO stays', async () => {
    const w = world();
    fifo(join(w.home, 'trigger.jsonl'));
    const r = await runNode(BIN.trigger, triggerArgs(w), { cwd: w.work, env: envFor(w, { HELIX_HOME: w.home }), deadlineMs: 20_000 });
    expect(r.killed).toBe(false);
    expect(r.code).toBe(1);                                                   // task C1, plan decision C1-1: a crash-class exit, not 3
    expect(r.stderr).toBe(`trigger-cli: ${new NotRegularHomeFileError().message}\n`);
    expect(r.stdout).toBe('');
    expect(kindOf(join(w.home, 'trigger.jsonl'))).toBe('fifo');
  }, 45_000);

  it('a sink whose last line was torn (no final newline) gets a separator before the new record', async () => {
    const w = world();
    const sink = join(w.home, 'trigger.jsonl');
    writeFileSync(sink, '{"torn":1', { mode: 0o600 });
    const r = await runNode(BIN.trigger, triggerArgs(w), { cwd: w.work, env: envFor(w, { HELIX_HOME: w.home }) });
    expect(r.code, r.stderr).toBe(0);
    const content = readFileSync(sink, 'utf8');
    expect(content.startsWith('{"torn":1\n{"v":1,')).toBe(true);
    expect(content.endsWith('\n')).toBe(true);
    expect(sinkLines(sink)).toHaveLength(2);
  }, 45_000);

  it.skipIf((process.umask() & 0o077) === 0o077)('a home that does not exist yet (its parent does) is made 0700, not at the umask\'s mode, and the sink 0600', async () => {
    const w = world();
    const home = join(w.base, 'newhome');
    const r = await runNode(BIN.trigger, triggerArgs(w), { cwd: w.work, env: envFor(w, { HELIX_HOME: home }) });
    expect(r.code, r.stderr).toBe(0);
    expect(modeOf(home)).toBe(0o700);
    expect(modeOf(join(home, 'trigger.jsonl'))).toBe(0o600);
  }, 45_000);

  it('dogfood-postrun.sh with ~/.helix a symlink: exit 0, the link target gains nothing, and the reporter-failure line still reaches stdout', async () => {
    const w = world();
    const real = join(w.base, 'real');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(w.userHome, '.helix'));
    const tiny = join(w.base, 'tiny');
    mkdirSync(tiny);
    writeFileSync(join(tiny, 'ISSUES.md'), '# issues\n');
    const before = treeDigest(real);
    const post = await runCommand('bash', [BIN.postrun, tiny], {
      cwd: tiny, env: { ...envFor(w), SERVICE_RESULT: 'success', EXIT_CODE: 'exited', EXIT_STATUS: '0', INVOCATION_ID: 'd1-link' }, deadlineMs: 60_000,
    });
    expect(post.code).toBe(0);
    expect(treeDigest(real)).toEqual(before);
    const failures = post.stdout.split('\n').filter((l) => l.includes('"kind":"reporter-failure"'));
    expect(failures).toHaveLength(1);
    // helix-trigger refused the home (exit 3); task C2 keeps reason "crash" (plan decision P1) and adds the optional field.
    expect(failures[0]!.endsWith('"reason":"crash","home_refused":true}')).toBe(true);
    expect(readFileSync(join(tiny, 'ISSUES.md'), 'utf8')).toBe('# issues\n');
  }, 90_000);

  it('dogfood-postrun.sh with a relative HELIX_HOME: exit 0, nothing is written below the cwd, and one reporter-failure line with home_refused reaches stdout', async () => {
    const w = world();
    const tiny = join(w.base, 'tiny');
    mkdirSync(tiny);
    writeFileSync(join(tiny, 'ISSUES.md'), '# issues\n');
    const before = treeDigest(tiny);
    const post = await runCommand('bash', [BIN.postrun, tiny], {
      cwd: tiny, env: { ...envFor(w, { HELIX_HOME: 'rel' }), SERVICE_RESULT: 'success', EXIT_CODE: 'exited', EXIT_STATUS: '0', INVOCATION_ID: 'd1-rel' }, deadlineMs: 60_000,
    });
    expect(post.code).toBe(0);
    expect(treeDigest(tiny)).toEqual(before);                                // the cwd gains no rel/trigger.jsonl
    const failures = post.stdout.split('\n').filter((l) => l.includes('"kind":"reporter-failure"'));
    expect(failures).toHaveLength(1);
    expect(failures[0]!.endsWith('"reason":"crash","home_refused":true}')).toBe(true);
  }, 90_000);
});
