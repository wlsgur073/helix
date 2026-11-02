// Third fix batch B1, task B8 (design 4.10, 4.9, 4.7): the refusals of the two user-only ceremonies, as a matrix. The texts are
// pinned as literals on purpose: they are the plan's final candidates and B9 presents them to the owner once.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, chmodSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as rebaseline } from '../../scripts/rebaseline-cli.js';
import { main as trustResolve } from '../../scripts/trust-resolve-cli.js';
import * as witnessStoreMod from '../../src/memory/witness-store.js';
import { WitnessUnusableError } from '../../src/memory/witness-store.js';
import * as ledgerMod from '../../src/memory/ledger.js';
import { readLedgerBytes, LedgerDestinationChangedError } from '../../src/memory/ledger.js';
import { MemoryStore } from '../../src/memory/store.js';
import { projectLedgerPath, trustStateOf } from '../../src/memory/ownership.js';
import { buildGlobalLayout, cleanupLayouts, snapshotTree, FF, type GlobalLayoutName } from '../helpers/global-layouts.js';

const AS_ROOT = process.getuid?.() === 0;
const bases: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true }); cleanupLayouts(); });

function captureStderr(): { text: () => string } {
  let err = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += chunk.toString(); return true; });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return { text: () => err };
}

// ---- the settled tails (B8 Step 3 item 2) and the cause texts (A13's, unchanged) ----
const TAIL_ELSEWHERE = "Re-baselining it would record a file that is not this project's own under this project's witness identity.\nReplace it with the project's own file, then re-run.\n";
const TAIL_PATH = "Nothing was written. Repair the path (or replace the link with the project's own file), then re-run.\n";
const TAIL_UNUSABLE = "Nothing was written. Repair the project's memory file, then re-run.\n";
const HEAD = (cause: string): string => `helix-rebaseline: REFUSING - ${cause}\n`;

interface Project { root: string; home: string; base: string; env: NodeJS.ProcessEnv }
function project(): Project {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cli-')));
  bases.push(base);
  const root = join(base, 'proj'); const home = join(base, 'home');
  mkdirSync(join(root, '.helix'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  return { root, home, base, env: { HELIX_HOME: home } };
}
const ledgerOf = (p: Project): string => projectLedgerPath(p.root);

interface Row { cause: string; head: string; tail: string; resolved: boolean; skip?: boolean; build(p: Project): Project }
const ROWS: Row[] = [
  { cause: 'outside-root', head: HEAD("this project's memory file resolves outside this project."), tail: TAIL_ELSEWHERE, resolved: true,
    build: (p) => { mkdirSync(join(p.base, 'other')); writeFileSync(join(p.base, 'other', 'o.jsonl'), ''); symlinkSync(join(p.base, 'other', 'o.jsonl'), ledgerOf(p)); return p; } },
  { cause: 'home-directory', head: HEAD("this project's memory file resolves into the Helix home directory."), tail: TAIL_ELSEWHERE, resolved: true,
    build: (p) => {                                                                   // decision 7: the home lies INSIDE the project (SW-01), the link leads into it
      const home = join(p.root, 'hh');
      mkdirSync(home, { mode: 0o700 });
      writeFileSync(join(home, 'h.jsonl'), '');
      symlinkSync(join(home, 'h.jsonl'), ledgerOf(p));
      return { ...p, home, env: { HELIX_HOME: home } };
    } },
  { cause: 'hard-link', head: HEAD("this project's memory file has more than one hard link."), tail: TAIL_ELSEWHERE, resolved: true,
    build: (p) => { writeFileSync(ledgerOf(p), ''); linkSync(ledgerOf(p), join(p.base, 'second.jsonl')); return p; } },
  { cause: 'unresolvable', head: HEAD("this project's memory file cannot be resolved (a name that is not valid UTF-8, a path past the system limit, or too many links)."), tail: TAIL_PATH, resolved: false,
    build: (p) => { symlinkSync(FF, ledgerOf(p)); return p; } },
  { cause: 'unjudgeable-target', head: HEAD("this project's memory file cannot be told from another Helix memory file, because that file's path cannot be resolved."), tail: TAIL_PATH, resolved: true,
    build: (p) => {
      mkdirSync(join(p.base, 't'));
      const target = Buffer.concat([Buffer.from(`${p.base}/t/re`), FF, Buffer.from('l.jsonl')]);
      writeFileSync(target, '');
      symlinkSync(target, join(p.base, 'g.jsonl'));                                  // a global ledger whose path cannot be resolved
      writeFileSync(join(p.root, 'in.jsonl'), '');
      symlinkSync(join(p.root, 'in.jsonl'), ledgerOf(p));                            // a link layout while it cannot be: aliased (decision 6)
      return { ...p, env: { HELIX_HOME: p.home, HELIX_LEDGER: join(p.base, 'g.jsonl') } };
    } },
  { cause: 'uninspectable', head: HEAD("this project's memory file cannot be inspected (a folder on the way cannot be read, or is not a directory)."), tail: TAIL_UNUSABLE, resolved: false,
    build: (p) => { writeFileSync(join(p.base, 'afile'), 'x'); symlinkSync(join(p.base, 'afile', 'x'), ledgerOf(p)); return p; } },
  { cause: 'helix-not-directory', head: HEAD("this project's .helix is not a real directory (a file, a link or another object stands at that name)."), tail: TAIL_UNUSABLE, resolved: false,
    build: (p) => { rmSync(join(p.root, '.helix'), { recursive: true }); writeFileSync(join(p.root, '.helix'), 'x'); return p; } },
  { cause: 'not-regular', head: HEAD("this project's memory file is not a regular file."), tail: TAIL_UNUSABLE, resolved: true,
    build: (p) => { execFileSync('mkfifo', [ledgerOf(p)]); return p; } },
  { cause: 'unreadable', head: HEAD("this project's memory file cannot be opened for reading."), tail: TAIL_UNUSABLE, resolved: true, skip: AS_ROOT,
    build: (p) => { writeFileSync(ledgerOf(p), ''); chmodSync(ledgerOf(p), 0o000); return p; } },
  { cause: 'not-ledger-content', head: HEAD("this project's memory file is a link to a file that does not hold Helix memory records."), tail: TAIL_UNUSABLE, resolved: true,
    build: (p) => { writeFileSync(join(p.root, 'notes.txt'), 'hello\n'); symlinkSync(join(p.root, 'notes.txt'), ledgerOf(p)); return p; } },
  { cause: 'target-directory-missing', head: HEAD("this project's memory file is a link into a folder that does not exist."), tail: TAIL_UNUSABLE, resolved: true,
    build: (p) => { symlinkSync(join(p.root, 'nodir', 'x.jsonl'), ledgerOf(p)); return p; } },
];

describe('rebaseline --scope <project>: one text per cause, exit 2 before the lock, the display and the prompt', () => {
  it.each(ROWS.filter((r) => !r.skip).map((r) => [r.cause, r] as const))('%s', async (_cause, row) => {
    const p = row.build(project());
    const before = snapshotTree(p.base);
    const cap = captureStderr();
    let prompted = false;
    const code = await rebaseline(['--scope', p.root], { env: p.env, isTTY: true, promptLine: async () => { prompted = true; return 'bless'; }, exit: () => {} });
    const err = cap.text();
    expect(code).toBe(2);
    expect(prompted).toBe(false);
    expect(err.startsWith(row.head)).toBe(true);
    expect(err.endsWith(row.tail)).toBe(true);
    const middle = err.slice(row.head.length, err.length - row.tail.length);
    expect(middle).toMatch(row.resolved ? /^ {2}resolved ledger: \S.*\n$/ : /^$/);
    expect(err.replace(middle, '')).not.toContain(p.root);                   // the one line that may carry a path is the resolved-ledger line
    expect(snapshotTree(p.base)).toEqual(before);
  });

  it('other-project: HEAD\'s project text, with the destination', async () => {
    const p = project();
    const nested = join(p.root, 'nested');
    mkdirSync(join(nested, '.helix'), { recursive: true });
    const b = new MemoryStore(join(p.home, 'memory.jsonl'), { home: p.home, sessionId: 'b', project: { root: nested, ledger: projectLedgerPath(nested), origin: 'cwd' } });
    b.adopt(nested);
    b.commit({ content: 'a nested project fact', source: 'user', scope: 'project' });
    symlinkSync(projectLedgerPath(nested), ledgerOf(p));
    const cap = captureStderr();
    const code = await rebaseline(['--scope', p.root], { env: p.env, isTTY: true, promptLine: async () => 'bless', exit: () => {} });
    expect(code).toBe(2);
    expect(cap.text()).toContain("resolves to another adopted project's ledger file.");
    expect(cap.text()).toMatch(/\n {2}resolved ledger: \S.*\n/);
    expect(cap.text().endsWith("Replace the link with the project's own file, then re-run.\n")).toBe(true);
  });

  it.each(['global-ledger', 'global-store'] as const)('%s: HEAD\'s global text, both ledgers named, with the way out', async (which) => {
    const p = project();
    let env = p.env;
    if (which === 'global-ledger') {                                          // an in-tree link to a global ledger that lies inside the project (row 7, first comparison)
      mkdirSync(join(p.root, 'data'));
      writeFileSync(join(p.root, 'data', 'g.jsonl'), '');
      symlinkSync(join(p.root, 'data', 'g.jsonl'), ledgerOf(p));
      env = { HELIX_HOME: p.home, HELIX_LEDGER: join(p.root, 'data', 'g.jsonl') };
    } else {                                                                  // the memory path IS the global ledger
      writeFileSync(ledgerOf(p), '');
      env = { HELIX_HOME: p.home, HELIX_LEDGER: ledgerOf(p) };
    }
    const cap = captureStderr();
    const code = await rebaseline(['--scope', p.root], { env, isTTY: true, promptLine: async () => 'bless', exit: () => {} });
    expect(code).toBe(2);
    expect(cap.text()).toContain('resolves to the global ledger, not a separate project ledger.');
    expect(cap.text()).toMatch(/\n {2}resolved ledger: \S.*\n {2}global ledger {2}: \S.*\n/);
    expect(cap.text().endsWith('Use: --scope global\n')).toBe(true);
  });
});

describe('rebaseline --scope global over a global ledger that cannot be used (spec 4.10 and 4.7; exit 2, in front of everything)', () => {
  const REFUSAL = "helix-rebaseline: REFUSING - the global memory file's path cannot be resolved (a name that is not valid UTF-8, a path past the system limit, too many links, or a link into a directory that does not exist).\nNothing was written. Repair that path (HELIX_LEDGER, or a link on it), then re-run.\n";
  const LAYOUTS: GlobalLayoutName[] = ['nonutf8-link-body', 'nonutf8-dir-link', 'chain-41', 'loop', 'dangling-target-dir-missing', 'below-dangling-dir-link'];

  it.each(LAYOUTS)('%s: the fixed text, no prompt, no lock, no folder, nothing created', async (name) => {
    const l = buildGlobalLayout(name);
    const before = snapshotTree(l.base);
    const cap = captureStderr();
    let prompted = false;
    const code = await rebaseline(['--scope', 'global'], { env: { HELIX_HOME: l.home, HELIX_LEDGER: l.ledger }, isTTY: true, promptLine: async () => { prompted = true; return 'bless'; }, exit: () => {} });
    expect(code).toBe(2);
    expect(cap.text()).toBe(REFUSAL);
    expect(prompted).toBe(false);
    expect(snapshotTree(l.base)).toEqual(before);
  });

  it('the usage and TTY checks come first: a non-interactive shell and a malformed call keep their own messages', async () => {
    const l = buildGlobalLayout('nonutf8-link-body');
    const env = { HELIX_HOME: l.home, HELIX_LEDGER: l.ledger };
    let cap = captureStderr();
    expect(await rebaseline(['--scope', 'global'], { env, isTTY: false, exit: () => {} })).toBe(2);
    expect(cap.text()).toContain('interactive terminal');
    expect(cap.text()).not.toContain('REFUSING');
    vi.restoreAllMocks();
    cap = captureStderr();
    expect(await rebaseline(['--scope'], { env, isTTY: true, exit: () => {} })).toBe(2);
    expect(cap.text()).toContain('usage');
  });

  it('a project scope is not refused because the global ledger is read-only', async () => {
    const l = buildGlobalLayout('nonutf8-link-body');
    const root = join(l.base, 'proj');
    mkdirSync(root);
    const cap = captureStderr();
    const code = await rebaseline(['--scope', root], { env: { HELIX_HOME: l.home, HELIX_LEDGER: l.ledger }, isTTY: true, promptLine: async () => 'bless', now: () => '2026-11-01T00:00:00.000Z', exit: () => {} });
    expect(cap.text()).not.toContain('REFUSING');
    expect(code).toBe(0);
  });

  it('control: a global ledger that can be used goes on to the prompt', async () => {
    const l = buildGlobalLayout('plain');
    captureStderr();
    expect(await rebaseline(['--scope', 'global'], { env: { HELIX_HOME: l.home, HELIX_LEDGER: l.ledger }, isTTY: true, promptLine: async () => 'bless', exit: () => {} })).toBe(0);
  });
});

describe('rebaseline over a witness file that cannot be used (A15 handed the text to B8): exit 2 before the prompt', () => {
  const WITNESS_REFUSAL = "helix-rebaseline: REFUSING - the rollback-witness file cannot be used (its path cannot be resolved, a link stands at its name, it is not a regular file, or it cannot be read or parsed).\nA re-baseline would replace that file and drop the baseline of every other scope. Nothing was written. Restore the file from a backup, or, if you accept that every scope starts again from first contact, remove it; then re-run.\n";
  it.each(['a directory', 'garbage'] as const)('%s at witness.json', async (kind) => {
    const l = buildGlobalLayout('plain');
    const w = join(l.home, 'witness.json');
    unlinkSync(w);
    if (kind === 'a directory') mkdirSync(w); else writeFileSync(w, 'garbage {');
    const before = snapshotTree(l.base);
    const cap = captureStderr();
    let prompted = false;
    const code = await rebaseline(['--scope', 'global'], { env: { HELIX_HOME: l.home }, isTTY: true, promptLine: async () => { prompted = true; return 'bless'; }, exit: () => {} });
    expect(code).toBe(2);
    expect(cap.text()).toBe(WITNESS_REFUSAL);
    expect(prompted).toBe(false);
    expect(snapshotTree(l.base)).toEqual(before);
  });

  it('a transient read error is not that refusal: the generic catch, exit 1, and no advice to remove the file (D9, sixth item)', async () => {
    const l = buildGlobalLayout('plain');
    vi.spyOn(witnessStoreMod, 'readScopeWitness').mockImplementationOnce(() => { throw new WitnessUnusableError('witness', 'transient'); });
    const cap = captureStderr();
    expect(await rebaseline(['--scope', 'global'], { env: { HELIX_HOME: l.home }, isTTY: true, promptLine: async () => 'bless', exit: () => {} })).toBe(1);
    expect(cap.text()).not.toContain('REFUSING');
    expect(cap.text()).not.toContain('remove it');
  });

  it('a witness file that fails after the fence landed is not that refusal either: "Nothing was written" would be false', async () => {
    const l = buildGlobalLayout('plain');
    const before = readLedgerBytes(l.ledger);
    vi.spyOn(witnessStoreMod, 'completeTransition').mockImplementationOnce(() => { throw new WitnessUnusableError('completeTransition', 'unparseable'); });
    const cap = captureStderr();
    expect(await rebaseline(['--scope', 'global'], { env: { HELIX_HOME: l.home }, isTTY: true, promptLine: async () => 'bless', exit: () => {} })).toBe(1);
    expect(cap.text()).not.toContain('Nothing was written');
    expect(readLedgerBytes(l.ledger).equals(before)).toBe(false);            // the fence is in the ledger
  });
});

describe('rebaseline when the destination changes under the ceremony (rulings H R-6): the operator never reads the commit tool\'s text', () => {
  const CHANGED = 'helix-rebaseline: REFUSING - the memory file changed while the re-baseline was in progress, so no fence was written.\nCheck what the memory path leads to now, then re-run.\n';
  it('the fixed text, true for either scope, exit 2, after the journal was retracted', async () => {
    const l = buildGlobalLayout('plain');
    const before = readLedgerBytes(l.ledger);
    vi.spyOn(ledgerMod, 'appendRecordUnlocked').mockImplementationOnce(() => { throw new LedgerDestinationChangedError(); });
    const cap = captureStderr();
    const code = await rebaseline(['--scope', 'global'], { env: { HELIX_HOME: l.home }, isTTY: true, promptLine: async () => 'bless', exit: () => {} });
    expect(code).toBe(2);
    expect(cap.text().endsWith(CHANGED)).toBe(true);
    expect(cap.text()).not.toContain('commit');
    expect(cap.text()).not.toContain('this project');
    expect(readLedgerBytes(l.ledger).equals(before)).toBe(true);
  });
});

describe('trust-resolve: three fixed refusals, exit 2 before the banner and the prompt', () => {
  const ALIASED = "helix-trust-resolve: REFUSING - this project's memory file resolves outside this project, to another Helix memory file, to a file with more than one hard link, or through a path Helix cannot resolve. Nothing was changed. Replace it with the project's own file, then re-run.\n";
  const UNUSABLE = "helix-trust-resolve: REFUSING - this project's memory file cannot be used as it is (it is not a regular file, it or its folder cannot be read, that folder is missing or not a directory, or it is a link to a file that does not hold Helix memory records). Nothing was changed. Repair the project's memory file, then re-run.\n";
  const GLOBAL_STORE = "helix-trust-resolve: REFUSING - this project's memory file is the global memory file itself, so there is no separate project scope to resolve. Nothing was changed.\n";

  /** The fixture of trust-resolve-cli.test.ts: an adopted project whose .owner was lost, then re-adopted: trust-pending. */
  function pending(): { home: string; root: string; base: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'tr-')));
    bases.push(base);
    const home = join(base, 'home'); const root = join(base, 'proj');
    mkdirSync(home, { mode: 0o700 }); mkdirSync(join(root, '.helix'), { recursive: true });
    const at = (s: string) => new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: s, project: { root, ledger: projectLedgerPath(root), origin: 'cwd' } });
    const s1 = at('s1'); s1.adopt(root);
    const rec = s1.commit({ content: 'the db is postgres', source: 'user', scope: 'project' });
    s1.confirm(rec.id);
    unlinkSync(join(root, '.helix', '.owner'));
    at('s2').adopt(root);
    expect(trustStateOf(root, home)).toBe('pending');
    return { home, root, base };
  }
  const swapLedger = (root: string, make: (ledger: string) => void): void => { rmSync(projectLedgerPath(root)); make(projectLedgerPath(root)); };

  const CASES: Array<[string, string, (t: { home: string; root: string; base: string }) => NodeJS.ProcessEnv]> = [
    ['aliased: the memory file links out of the project', ALIASED, (t) => { mkdirSync(join(t.base, 'o')); writeFileSync(join(t.base, 'o', 'x.jsonl'), ''); swapLedger(t.root, (l) => symlinkSync(join(t.base, 'o', 'x.jsonl'), l)); return { HELIX_HOME: t.home }; }],
    ['aliased: the memory file cannot be resolved (R-2: it used to show 0 rows and go on)', ALIASED, (t) => { swapLedger(t.root, (l) => symlinkSync(FF, l)); return { HELIX_HOME: t.home }; }],
    ['unusable: a link to a file that holds no memory records', UNUSABLE, (t) => { writeFileSync(join(t.root, 'notes.txt'), 'hello\n'); swapLedger(t.root, (l) => symlinkSync(join(t.root, 'notes.txt'), l)); return { HELIX_HOME: t.home }; }],
    ['global store: HELIX_LEDGER is the project\'s own memory path', GLOBAL_STORE, (t) => ({ HELIX_HOME: t.home, HELIX_LEDGER: projectLedgerPath(t.root) })],
  ];
  it.each(CASES)('%s', async (_label, text, setup) => {
    const t = pending();
    const env = setup(t);
    const before = snapshotTree(t.base);
    const cap = captureStderr();
    let prompted = false;
    const code = await trustResolve(['--scope', t.root, '--repair'], { env, isTTY: true, promptLine: async () => { prompted = true; return 'repair'; }, exit: () => {} });
    expect(code).toBe(2);
    expect(cap.text()).toBe(text);
    expect(prompted).toBe(false);
    expect(trustStateOf(t.root, t.home)).toBe('pending');
    expect(snapshotTree(t.base)).toEqual(before);
  });
});
