// Third fix batch B2a, task D2: the shipped documents state what the home contract does. Each case pins the shortest
// phrase that carries a claim; the number of owned files is recovered from the code, and the statuses and lines the
// documents promise are recovered by running the entry points built from source (the bundleCli discipline), never the
// committed bin/. A last group pins that the sentences the batch made false are gone.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHelixDir, hardenHomePermissions, OWNED_FILES } from '../../src/memory/home-permissions.js';
import { RELATIVE_VALUE_TEXT } from '../../src/memory/home-env.js';
import { HOME_CONTROL_NAMES } from '../../src/memory/home-files.js';
import { STORED_THEN_FAILED_RESPONSE } from '../../src/server/handlers.js';
import { bundleCli } from '../helpers/bundle-cli.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const flat = (name: string): string => readFileSync(join(ROOT, name), 'utf8').replace(/\s+/g, ' ');
const WORDS: Record<number, string> = { 10: 'ten', 11: 'eleven', 12: 'twelve' };
// Every owned file but the ledger and what the SessionEnd sentence of SECURITY.md calls it. A new owned file has no
// entry here, which fails the case below until the sentence and this table are revisited together.
const NAMED_FOR_SESSION_END: Record<string, string> = {
  'audit.jsonl': 'the audit', 'sessions.jsonl': 'sessions.jsonl', 'metrics.jsonl': 'metrics', 'trigger.jsonl': 'trigger',
  'codex-log.jsonl': 'Codex log files', 'witness.json': 'the rollback witness and its log', 'witness-log.jsonl': 'the rollback witness and its log',
  'projects.json': 'the registry', 'ledger-mac-master.key': 'the signing key', 'config.json': 'the configuration file',
};
// Every owned file but the ledger and what the read-only global ledger sentence of SECURITY.md (S3) calls it, held to the
// same discipline: homeControlFileOf judges each of them, and the locks and temporary files beside them and `memory.jsonl`,
// a control file (home-files.ts CONTROL_FILES, HOME_CONTROL_NAMES, TEMP_FAMILIES).
const NAMED_FOR_READ_ONLY_LEDGER: Record<string, string> = {
  'audit.jsonl': 'the audit', 'sessions.jsonl': 'sessions', 'metrics.jsonl': 'metrics', 'trigger.jsonl': 'trigger',
  'codex-log.jsonl': 'Codex log', 'witness.json': 'the rollback witness', 'witness-log.jsonl': 'the rollback witness or its log',
  'projects.json': 'the registry', 'ledger-mac-master.key': 'the signing key', 'config.json': 'the configuration file',
};

describe('SECURITY.md states the home contract', () => {
  const sec = flat('SECURITY.md');

  it('the three variables are resolved by one rule, and each program says how it refuses', () => {
    for (const phrase of [
      'are resolved once, by one rule, in each program that reads them',
      'An empty value counts as unset and gives the default',
      'A value that is not an absolute path is refused',
      'A program refuses only a variable it reads',
      'exits with status 78 before it reads a file',
      'a hook prints one fixed note, reads and writes nothing, and exits 0',
      '`helix-rebaseline` and `helix-trust-resolve` exit with status 2',
      '`helix-trigger` exits with status 3',
      'its final component is looked at and never followed',
    ]) expect(sec, phrase).toContain(phrase);
  });
  it('a symlinked home is refused for the writes it lists, and no mode is changed through it', () => {
    expect(sec).toContain('the SessionEnd record and the `helix-trigger` record) before anything is written to a ledger or a sink');
    expect(sec).toContain("no file mode is changed through it, the signing key's included");
    expect(sec).toContain('the SessionEnd hook prints its dropped-record line at every session end');
  });
  it('the SessionEnd hook refuses the files Helix keeps for another purpose and prints one line for a dropped record', () => {
    expect(sec).toContain('The SessionEnd hook does not write its record into a file Helix keeps for another purpose');
    expect(sec).toContain('leads to the global ledger wherever `HELIX_LEDGER` puts it, to `<HELIX_HOME>/memory.jsonl` whatever `HELIX_LEDGER` says');
    expect(sec).toContain("to a project's ledger (a file named `memory.jsonl` directly inside a folder named `.helix`)");   // plan review 2026-11-08
    expect(sec).toContain('is reported by one fixed line on stderr, and the hook exits 0');
  });
  it('the files that sentence names cover every owned file but the ledger, recovered from OWNED_FILES', () => {
    const unnamed = OWNED_FILES.filter((n) => n !== 'memory.jsonl' && !(n in NAMED_FOR_SESSION_END));
    expect(unnamed, 'an owned file has no name in the SessionEnd sentence of SECURITY.md').toEqual([]);
    expect(sec).toContain('(the signing key, the registry, the rollback witness and its log, the audit, metrics, trigger and Codex log files, the configuration file, or a lock or temporary file beside one of them)');
    for (const phrase of new Set(Object.values(NAMED_FOR_SESSION_END))) expect(sec, phrase).toContain(phrase);
  });
  it('a global ledger that leads to another home file is read-only, and a relocated regular file stays writable', () => {
    expect(sec).toContain('or leads to another file of the Helix home');
    expect(sec).toContain('A `HELIX_LEDGER` that names a regular file outside the home stays writable');
    expect(sec).toContain('global memory is read-only');
  });
  it('the files that make global memory read-only cover every owned file but the ledger, and the locks beside memory.jsonl', () => {
    const unnamed = OWNED_FILES.filter((n) => n !== 'memory.jsonl' && !(n in NAMED_FOR_READ_ONLY_LEDGER));
    expect(unnamed, 'an owned file has no name in the read-only global ledger sentence of SECURITY.md').toEqual([]);
    const start = sec.indexOf('The global ledger follows the same rule:');
    const end = sec.indexOf('global memory is read-only.', start);
    expect(start, 'the read-only global ledger sentence').toBeGreaterThanOrEqual(0);
    expect(end, 'the end of that sentence').toBeGreaterThan(start);
    const sentence = sec.slice(start, end);
    for (const phrase of new Set(Object.values(NAMED_FOR_READ_ONLY_LEDGER))) expect(sentence, phrase).toContain(phrase);
    expect(HOME_CONTROL_NAMES).toContain('memory.jsonl.lock');
    expect(sentence).toContain('or a lock or temporary file beside one of them or beside `memory.jsonl`)');
  });
  it('home files are opened as objects', () => {
    expect(sec).toContain('Home files are opened as objects too');
    expect(sec).toContain('no longer stalls the server, a hook or a command-line tool');
  });
  it('two failures moved in front of the row, and the audit row after a stored row is answered', () => {
    expect(sec).toContain('Two failures that used to come after the row now come before it');
    expect(sec).toContain("refuses a commit, erase, confirm, recheck or adopt before any row is stored");
    expect(sec).toContain("An adopt and a project's first commit, which went through before this change, are refused by that look before any ownership is recorded");
    expect(sec).toContain('whose row is stored but whose audit row then cannot be appended is answered the same way');
    expect(sec).toContain('an adopt has a fixed message of its own');
    expect(sec).toContain('is answered with the stored-then-failed message for an adoption that nonetheless stands');
    expect(sec).toContain('at a rejection site it is dropped and the rejection error stands, with no audit row');
    // P5's narrowing, approved at the plan review of 2026-11-08: where nothing was stored, the append's own error is the answer.
    expect(sec).toContain('An erase answered `unchanged` and a recheck that stores no row have stored nothing, so a failed append there is answered with its own error');
    expect(sec).toContain('`helix_dual_verify` writes its row after the Codex call and still throws when that append fails');
  });
  it("the witness lock's name is looked at before an append (B1's W-R4 reversed), and the look is not a hold", () => {
    expect(sec).toContain("The witness lock's name is looked at before every append, a project's first commit and an adopt included");
    expect(sec).toContain('The look is not a hold');
  });
  it('the residuals of the batch are written', () => {
    for (const phrase of [
      'a link swapped in after the second look is not caught',
      'is seen by neither the path rule nor the identity rule',
      'Names are compared case-sensitively',
      'then opens it: two steps, so a link swapped between them is not caught',
      'The lock file beside a ledger placed outside the home with `HELIX_LEDGER` is not among the files compared',
      "A project's ledger is recognized only by the last two names of the path as given or of its resolved destination",
      'does not make global memory read-only, because that normal path is not compared',   // controller ruling after B1, 2026-11-08
      "The lock file and the temporary files beside a project's ledger are not recognized either",   // controller ruling after B2, 2026-11-08
      'reads permissions and file kinds for the running process',
      'an erase through a symlinked home included, leaves no audit row',
    ]) expect(sec, phrase).toContain(phrase);
  });
  it('the startup pass names its files (the count recovered from OWNED_FILES), its scope, and the directory rule', () => {
    const word = WORDS[OWNED_FILES.length];
    expect(word, `OWNED_FILES has ${OWNED_FILES.length} names; add the word to WORDS and the number to SECURITY.md`).toBeDefined();
    expect(sec).toContain(`tightens the ${word} files Helix keeps in \`HELIX_HOME\``);
    for (const phrase of [
      "Only the server's start runs the pass",
      'it warns and stops, so nothing behind the link is changed, the signing key included',
      'removes the group and other permission bits from `HELIX_HOME` itself and says which mode it set',
      "it never adds the owner's write permission",
      'a read-only home (`0555`) becomes `0500`',
      'No other Helix program changes the mode of a directory that already exists',
    ]) expect(sec, phrase).toContain(phrase);
  });
  it('a signing key read through a link or a stray key beside a relocated ledger keeps its mode (A7 with Segment A open item 2)', () => {
    expect(sec).toContain("A signing key read through a link at the key's name, or a stray copy beside a ledger that `HELIX_LEDGER` places elsewhere, keeps its mode as well");
  });
  it('a server-wide allow rule is warned against without naming a host rule syntax, and the tool-level warnings stay', () => {
    expect(sec).toContain('Do not allow-list the Helix server as a whole');
    expect(sec).toContain('leave `helix_memory_confirm` and `helix_memory_adopt` out');
    expect(sec).toContain("Which rule forms the host accepts is the host's behaviour, which Helix neither controls nor observes");
    expect(sec).not.toContain('mcp__');                                // disposition 9d: no unverified host syntax
    expect(readFileSync(join(ROOT, 'SECURITY.md'), 'utf8')).toContain('do **not** allow-list `helix_memory_adopt`');
  });
});

describe('README.md states the home contract', () => {
  const readme = flat('README.md');
  it('the variables are read by one rule, with the statuses', () => {
    for (const phrase of [
      'Every Helix program reads `HELIX_HOME`, `HELIX_LEDGER` and `HELIX_SESSIONS` by one rule',
      'an empty value counts as unset',
      'the server prints one line and exits with status 78',
      '`helix-trigger` with status 3',
      'A program checks only the variables it reads',
    ]) expect(readme, phrase).toContain(phrase);
  });
  it('a symlinked home, a dot-dot after a link, and the directory rule', () => {
    expect(readme).toContain('adopt, the SessionEnd record and the `helix-trigger` record before anything is written');
    expect(readme).toContain('A `..` after a symlinked directory in `HELIX_HOME` leads where the kernel leads');
    expect(readme).toContain("it never adds the owner's write permission, and no other Helix program changes the mode of an existing directory");
    expect(readme).toContain('Helix leaves the mode of an existing folder alone and creates only a missing last folder, `0700`');
    expect(readme).toContain("The hook does not write into the global ledger, into `<HELIX_HOME>/memory.jsonl` even when `HELIX_LEDGER` places the ledger elsewhere, into a project's ledger (`memory.jsonl` directly inside a `.helix` folder), or into any other file of the home");
  });
  it('the trigger and re-baseline commands say how they refuse', () => {
    expect(readme).toContain('It follows the home rules above');
    expect(readme).toContain('is refused with exit 3 and nothing is written');
    expect(readme).toContain('With `--scope global` and no home directory it exits with status 2 and creates nothing');
  });
});

describe('CHANGELOG.md lists the changed behaviour', () => {
  const changelog = flat('CHANGELOG.md');
  it('each changed behaviour has its entry', () => {
    for (const phrase of [
      'or a path that leads to another file of the Helix home',
      'an erase, adopt, recheck or confirm whose audit row cannot be appended after its record was stored is answered the same way (an adopt with a message of its own)',
      'lies behind a symlinked home is read as before and no longer tightened',   // no key-beside-a-relocated-ledger clause: no shipped path read that key (B2a plan review)
      'into `<HELIX_HOME>/memory.jsonl` (also when `HELIX_LEDGER` places the ledger elsewhere)',
      "into a project's ledger (a file named `memory.jsonl` directly inside a folder named `.helix`)",
      'The three home variables are read by one rule in the server, both hooks and the three command-line tools',
      'so `<link>/../name` is the directory the kernel reaches and no longer the folded name',
      "Only the server's start changes the mode of an existing directory, and only `HELIX_HOME`'s",
      'The SessionEnd hook reads `HELIX_LEDGER`',
      'opened non-blocking and used only when they are regular files',
      'Before this change the row could be stored and the call fail after it, and an adopt or a project\'s first commit went through',
      'An audit row that cannot be appended no longer replaces the refusal or the stored-then-failed answer it follows',
      '`helix-trigger` follows the same home rules',
      'A resumed, compacted or forked session whose memory read fails still gets the supersede note',
    ]) expect(changelog, phrase).toContain(phrase);
  });
  it('the surface bullet lists the helix-trigger record among the refused writes', () => {
    expect(changelog).toContain('the SessionEnd record and the `helix-trigger` record are refused through a symlinked home before anything is written');
  });
});

describe('docs/release/README.md corrects its open-defects sentence and notes the closed C3.3 gap', () => {
  const rel = flat('docs/release/README.md');
  it('the C3.3 row keeps its dated words and gains one resolution note', () => {
    expect(rel).toContain("Two gaps disclosed, not fixed: `metrics.jsonl` is on by default and uncapped, and an empty `HELIX_HOME` lets a project's files stand in for the global ones.");
    expect(rel).toContain('Resolution note: the second gap is closed in code by the home-contract part of the third fix batch');
    expect(rel).toContain('an empty `HELIX_HOME` counts as unset and gives `~/.helix`');
  });
  it('says both defects are closed, with the dates', () => {
    expect(rel).toContain('Two defects stayed open in code after the C3.1 delta of 2026-09-25');
    expect(rel).toContain('Both are closed in code');
    expect(rel).toContain('with the second fix batch (2026-10-05)');
    expect(rel).toContain('with the third fix batch (merged 2026-11-03)');
  });
});

describe('the sentences the batch made false are gone', () => {
  it('from SECURITY.md', () => {
    const sec = flat('SECURITY.md');
    for (const phrase of [
      'are used exactly as given, so set them to absolute paths',
      'an empty `HELIX_HOME` makes that directory stand in for the home',
      'a failed append returns an error for an adoption that nonetheless stands',
      'makes the handler throw after its operation already succeeded',
      'tightens every Helix-owned file in `~/.helix`',
    ]) expect(sec, phrase).not.toContain(phrase);
  });
  it('from README.md', () => {
    const readme = flat('README.md');
    expect(readme).not.toContain('adopt and the SessionEnd record before anything is written to a ledger');
  });
  it('from CHANGELOG.md and the release record', () => {
    const changelog = flat('CHANGELOG.md');
    expect(changelog).not.toContain('adopt and the SessionEnd record are refused through a symlinked home');
    expect(changelog).not.toContain('An unresolvable global ledger path (');
    expect(flat('docs/release/README.md')).not.toContain('Two defects stay open in code and are disclosed');
  });
});

// What the documents promise, run from source. The entries are bundled once (bundleCli) and spawned as plain node with the
// cwd in an empty throwaway directory; each case asserts its own precondition first. The statuses of the two ceremonies
// (helix-rebaseline, helix-trust-resolve) are not spawned here: both refuse a non-terminal stdin before they read the
// home, so their status 2 is carried by A5's test/scripts/cli-home-env.test.ts.
describe.skipIf(process.platform === 'win32')('the refusals and modes the documents state, run from source', () => {
  const work = mkdtempSync(join(tmpdir(), 'b2adoc-'));
  const cwd = join(work, 'w');
  const userHome = join(work, 'u');
  const bins = { server: '', trigger: '', start: '', end: '' };
  const END_INPUT = JSON.stringify({ session_id: 's1', reason: 'other' });

  beforeAll(async () => {
    mkdirSync(cwd); mkdirSync(userHome);
    bins.server = await bundleCli('src/server/index.ts');
    bins.trigger = await bundleCli('scripts/trigger-cli.ts');
    bins.start = await bundleCli('src/hooks/session-start.ts');
    bins.end = await bundleCli('src/hooks/session-end.ts');
  }, 180_000);
  afterAll(() => { try { chmodSync(join(work, 'ro'), 0o700); } catch { /* absent */ } rmSync(work, { recursive: true, force: true }); });

  const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('HELIX_')) env[k] = v;
    return { ...env, HOME: userHome, ...extra };
  };
  const run = (bin: string, args: string[], extra: Record<string, string>, input = ''): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, [bin, ...args], { cwd, env: childEnv(extra), input, encoding: 'utf8', timeout: 30_000 });
  const oneLine = (s: string): boolean => s.trim() !== '' && s.trim().split('\n').length === 1;
  const mkHome = (name: string): string => { const h = join(work, name); mkdirSync(h, { mode: 0o700 }); return h; };

  it('the server refuses a relative HELIX_HOME with status 78, one line, and leaves the working directory empty', () => {
    expect(readdirSync(cwd)).toEqual([]);
    const r = run(bins.server, [], { HELIX_HOME: 'rel/home' });
    expect(r.status).toBe(78);
    expect(r.stdout).toBe('');
    expect(oneLine(r.stderr)).toBe(true);
    expect(readdirSync(cwd)).toEqual([]);
  });
  it('an empty HELIX_HOME counts as unset: the server starts on the default home and does not use the working directory', () => {
    const r = run(bins.server, [], { HELIX_HOME: '' });
    expect(r.status).toBe(0);
    expect(readdirSync(cwd)).toEqual([]);
  });
  it('helix-trigger refuses it with status 3 and names the variable', () => {
    const r = run(bins.trigger, ['--root', cwd, '--run', 'r1'], { HELIX_HOME: 'rel/home' });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain(RELATIVE_VALUE_TEXT.HELIX_HOME);
  });
  it('the SessionStart hook prints one note, reads and writes nothing, and exits 0', () => {
    const r = run(bins.start, [], { HELIX_HOME: 'rel/home' }, '{}');
    expect(r.status).toBe(0);
    expect(oneLine(r.stdout)).toBe(true);
    expect(r.stdout).toMatch(/^helix: NOTE - /);
    expect(readdirSync(cwd)).toEqual([]);
  });
  it('the SessionEnd hook prints one line for a relative HELIX_SESSIONS and exits 0', () => {
    const r = run(bins.end, [], { HELIX_HOME: mkHome('h1'), HELIX_SESSIONS: 'rel/s.jsonl' }, END_INPUT);
    expect(r.status).toBe(0);
    expect(oneLine(r.stderr)).toBe(true);
    expect(r.stderr).toMatch(/^helix: NOTE - /);
    expect(readdirSync(cwd)).toEqual([]);
  });
  it('the SessionEnd hook does not write into a control file of the home, and prints one line', () => {
    const h = mkHome('h2');
    const control = join(h, 'projects.json');
    writeFileSync(control, '{}');
    const r = run(bins.end, [], { HELIX_HOME: h, HELIX_SESSIONS: control }, END_INPUT);
    expect(r.status).toBe(0);
    expect(readFileSync(control, 'utf8')).toBe('{}');
    expect(oneLine(r.stderr)).toBe(true);
  });
  it('the SessionEnd hook does not write into the global ledger path, wherever it is, and prints one line', () => {
    const h = mkHome('h3');
    const r = run(bins.end, [], { HELIX_HOME: h, HELIX_SESSIONS: join(h, 'memory.jsonl') }, END_INPUT);
    expect(r.status).toBe(0);
    expect(readdirSync(h)).toEqual([]);
    expect(oneLine(r.stderr)).toBe(true);
  });
  it('the SessionEnd hook does not write into <HELIX_HOME>/memory.jsonl when HELIX_LEDGER places the ledger elsewhere, and prints one line', () => {
    const h = mkHome('h5');
    const r = run(bins.end, [], { HELIX_HOME: h, HELIX_LEDGER: join(work, 'elsewhere.jsonl'), HELIX_SESSIONS: join(h, 'memory.jsonl') }, END_INPUT);
    expect(r.status).toBe(0);
    expect(readdirSync(h)).toEqual([]);
    expect(oneLine(r.stderr)).toBe(true);
  });
  it("the SessionEnd hook does not write into a project's ledger (<root>/.helix/memory.jsonl), and prints one line", () => {
    const h = mkHome('h6');
    const helixDir = join(work, 'proj', '.helix');
    mkdirSync(helixDir, { recursive: true });
    const ledger = join(helixDir, 'memory.jsonl');
    writeFileSync(ledger, '{}\n');
    const r = run(bins.end, [], { HELIX_HOME: h, HELIX_SESSIONS: ledger }, END_INPUT);
    expect(r.status).toBe(0);
    expect(readFileSync(ledger, 'utf8')).toBe('{}\n');
    expect(oneLine(r.stderr)).toBe(true);
  });
  it('a FIFO where the sessions file goes does not stall the SessionEnd hook', () => {
    const h = mkHome('h4');
    execFileSync('mkfifo', [join(h, 'sessions.jsonl')]);
    const r = run(bins.end, [], { HELIX_HOME: h }, END_INPUT);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(oneLine(r.stderr)).toBe(true);
  });
  it('the startup pass removes the group and other bits of a read-only home and never adds owner write', () => {
    const d = join(work, 'ro');
    mkdirSync(d); chmodSync(d, 0o555);
    const warnings: string[] = [];
    hardenHomePermissions(d, { warn: (m) => warnings.push(m) });
    expect(statSync(d).mode & 0o777).toBe(0o500);
    expect(warnings.join('\n')).toContain('0500');
  });
  it('ensureHelixDir leaves the mode of an existing folder alone', () => {
    const d = join(work, 'shared');
    mkdirSync(d); chmodSync(d, 0o755);
    ensureHelixDir(d);
    expect(statSync(d).mode & 0o777).toBe(0o755);
  });
  it('the stored-then-failed answer the documents state exists for erase, adopt, recheck and confirm (plan decision P5)', () => {
    const texts = STORED_THEN_FAILED_RESPONSE as Readonly<Record<string, string | undefined>>;
    for (const op of ['erase', 'adopt', 'recheck', 'confirm']) expect(texts[op], op).toMatch(/\S/);
  });
});
