// Third fix batch B1, task A15 (design 4.8 item 1, D9, decisions 6 and 7): witness.json is never followed, only a missing
// file is an empty store, and a file that is there and cannot be used is refused by every function that would write the
// store. Verdicts are computed from consequences: the bytes at the name, the bytes at a link's destination, the files of
// the home, never from an error name alone.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, chmodSync, lstatSync,
  realpathSync, copyFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleCli } from '../helpers/bundle-cli.js';
import {
  witnessPath, readScopeWitness, classifyState, advanceWitness, openTransition, completeTransition,
  discardTransition, maybeCleanupClear, isWitnessUnusableError, isWitnessAdvanceError, witnessUnusableRefusal,
  WITNESS_READ_AS_GIVEN, type WitnessUnusableReason, type WitnessUnusableError,
} from '../../src/memory/witness-store.js';
import {
  collectWitnessReadNotes, WITNESS_PATH_UNRESOLVABLE_NOTE, WITNESS_FILE_UNUSABLE_NOTE, WITNESS_MISMATCH_NOTE, WITNESS_TRANSITION_NOTE,
} from '../../src/memory/content-frame.js';
import type { WitnessVerdict } from '../../src/memory/witness-core.js';
import * as ledgerMacMod from '../../src/memory/ledger-mac.js';
import { realFsOps, type DurableFsOps } from '../../src/memory/fs-ops.js';
import { main as rebaseline } from '../../scripts/rebaseline-cli.js';

const isRoot = process.getuid?.() === 0;
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

const A = Buffer.from('row-a\n'); const P = Buffer.from('row-p\n'); const PKEY = '/tmp/proj-key';
/** A home (a realpath, mode 0700) whose witness.json holds an entry for '@global' and one for PKEY. */
function home(): string {
  const h = realpathSync(mkdtempSync(join(tmpdir(), 'wf-')));
  advanceWitness(h, '@global', A, 'tx-a');
  advanceWitness(h, PKEY, P, 'tx-p');
  return h;
}
const W = (h: string): string => witnessPath(h);
const scopesOf = (p: string): string[] => Object.keys((JSON.parse(readFileSync(p, 'utf8')) as { scopes: object }).scopes).sort();

interface Obj { name: string; reason: WitnessUnusableReason; skip?: boolean; plant: (h: string) => void | Promise<void> }
const swap = (h: string, f: (w: string) => void): void => { unlinkSync(W(h)); f(W(h)); };
const damaged = (h: string, f: (g: Record<string, unknown>) => void): void => {
  const c = JSON.parse(readFileSync(W(h), 'utf8')) as { scopes: Record<string, Record<string, unknown>> };
  f(c.scopes['@global']!); writeFileSync(W(h), JSON.stringify(c));
};
const UNUSABLE: Obj[] = [
  { name: 'link to another JSON file of the home', reason: 'link', plant: (h) => { writeFileSync(join(h, 'config.json'), '{"note":1}'); swap(h, (w) => symlinkSync(join(h, 'config.json'), w)); } },
  { name: 'link to the registry', reason: 'link', plant: (h) => { writeFileSync(join(h, 'projects.json'), '{"v":1,"projects":{}}'); swap(h, (w) => symlinkSync(join(h, 'projects.json'), w)); } },
  { name: 'dangling link into an existing folder', reason: 'link', plant: (h) => { mkdirSync(join(h, 'sub')); swap(h, (w) => symlinkSync(join(h, 'sub', 'w.json'), w)); } },
  { name: 'dangling link into a missing folder', reason: 'link', plant: (h) => swap(h, (w) => symlinkSync(join(h, 'nodir', 'w.json'), w)) },
  { name: 'link to a directory', reason: 'link', plant: (h) => { mkdirSync(join(h, 'sub')); swap(h, (w) => symlinkSync(join(h, 'sub'), w)); } },
  { name: 'directory', reason: 'not-regular', plant: (h) => swap(h, (w) => mkdirSync(w)) },
  { name: 'socket', reason: 'not-regular', plant: async (h) => { unlinkSync(W(h)); const s = createServer(); servers.push(s); await new Promise<void>((r) => s.listen(W(h), r)); } },
  { name: 'mode 000', reason: 'unreadable', skip: isRoot, plant: (h) => chmodSync(W(h), 0o000) },
  { name: 'empty file', reason: 'unparseable', plant: (h) => writeFileSync(W(h), '') },
  { name: 'not JSON', reason: 'unparseable', plant: (h) => writeFileSync(W(h), 'this is not json at all {{{') },
  { name: 'truncated JSON', reason: 'unparseable', plant: (h) => writeFileSync(W(h), '{"v":1,"scopes":{"@global":{"entry":{"epoch":1,') },
  { name: 'v is 2', reason: 'unparseable', plant: (h) => writeFileSync(W(h), JSON.stringify({ v: 2, scopes: {} })) },
  { name: 'scopes is a string', reason: 'unparseable', plant: (h) => writeFileSync(W(h), JSON.stringify({ v: 1, scopes: 'nope' })) },
  { name: 'scopes is null', reason: 'unparseable', plant: (h) => writeFileSync(W(h), JSON.stringify({ v: 1, scopes: null })) },
  { name: 'scopes is an array', reason: 'unparseable', plant: (h) => writeFileSync(W(h), JSON.stringify({ v: 1, scopes: [] })) },
  { name: 'scopes is missing', reason: 'unparseable', plant: (h) => writeFileSync(W(h), JSON.stringify({ v: 1 })) },
];
const CONTROLS: Array<{ name: string; plant: (h: string) => void }> = [
  { name: 'absent', plant: (h) => unlinkSync(W(h)) },
  { name: 'valid', plant: () => {} },
  { name: 'entry without mac', plant: (h) => damaged(h, (g) => { delete (g.entry as Record<string, unknown>).mac; }) },
  { name: 'entry with a wrong-typed epoch', plant: (h) => damaged(h, (g) => { (g.entry as Record<string, unknown>).epoch = 'one'; }) },
  { name: 'entry is a scalar', plant: (h) => damaged(h, (g) => { g.entry = 42; }) },
  { name: 'entry with a wrong mac', plant: (h) => damaged(h, (g) => { const e = g.entry as { mac: string }; e.mac = (e.mac[0] === '0' ? '1' : '0') + e.mac.slice(1); }) },
];
/** What a write must leave alone: the files of the home, the object at the name, what a link leads to, the other scope. */
function snap(h: string): string {
  const at = (p: string): string => {
    let st; try { st = lstatSync(p, { bigint: true }); } catch (e) { return `absent(${(e as NodeJS.ErrnoException).code})`; }
    if (st.isSymbolicLink()) return `link->${readlinkOf(p)}`;
    if (!st.isFile()) return `object ino=${st.ino}`;
    try { return `file ino=${st.ino} ${readFileSync(p).toString('base64')}`; } catch { return `file ino=${st.ino} unreadable`; }
  };
  const w = W(h); let dest = '-';
  try { if (lstatSync(w).isSymbolicLink()) dest = at(readlinkOf(w)); } catch { /* absent */ }
  return JSON.stringify({ name: at(w), dest, home: readdirSync(h).sort(), config: at(join(h, 'config.json')), registry: at(join(h, 'projects.json')) });
}
const readlinkOf = (p: string): string => { try { return readlinkSync(p); } catch { return '?'; } };
const thrown = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return undefined; };

describe('the default read refuses a file that is there and cannot be used; only a missing file is an empty store (D9)', () => {
  it.each(UNUSABLE.filter((o) => !o.skip).map((o) => [o.name, o] as const))('%s: the default read throws WitnessUnusableError with the reason; the read option answers an empty state marked unusable', async (_n, o) => {
    const h = home(); await o.plant(h);
    const e = thrown(() => readScopeWitness(h, '@global')) as WitnessUnusableError;
    expect(isWitnessUnusableError(e)).toBe(true);
    expect(e.reason).toBe(o.reason);
    expect(isWitnessAdvanceError(e)).toBe(false);
    expect(readScopeWitness(h, '@global', WITNESS_READ_AS_GIVEN)).toEqual({ entry: null, journal: null, macInvalid: false, file: 'unusable' });
    expect(classifyState(readScopeWitness(h, '@global', WITNESS_READ_AS_GIVEN), A).kind).toBe('first-contact');
  });

  it.each(CONTROLS.map((o) => [o.name, o] as const))('%s: an ordinary store (or none): read without a mark, and a write works and keeps the other scope', (name, o) => {
    const h = home(); o.plant(h);
    const s = readScopeWitness(h, '@global');
    expect(s.file).toBeUndefined();
    expect(s.macInvalid).toBe(name === 'absent' || name === 'valid' ? false : true);   // entry-level damage is that scope's first contact, as before
    advanceWitness(h, '@global', A, 'tx-b');
    expect(readScopeWitness(h, '@global').entry!.headTx).toBe('tx-b');
    if (name !== 'absent') expect(scopesOf(W(h))).toContain(PKEY);   // the project scope's baseline survives a write to the other scope
  });

  it('the home directory does not exist yet: no state, no mark, nothing created (IT-H1 stays)', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'wf-')));
    expect(readScopeWitness(join(base, 'nohome'), '@global', WITNESS_READ_AS_GIVEN)).toEqual({ entry: null, journal: null, macInvalid: false });
    expect(readdirSync(base)).toEqual([]);
  });

  it('nothing is latched: after the file is restored the next read is an ordinary one, without a restart', () => {
    const h = home(); const good = readFileSync(W(h));
    writeFileSync(W(h), 'garbage {');
    expect(readScopeWitness(h, '@global', WITNESS_READ_AS_GIVEN).file).toBe('unusable');
    writeFileSync(W(h), good);
    const s = readScopeWitness(h, '@global', WITNESS_READ_AS_GIVEN);
    expect(s.file).toBeUndefined(); expect(s.entry!.headTx).toBe('tx-a');
  });
});

describe('every function that would write the store refuses and leaves everything as it was (D9 items 1 and 2; W-R3)', () => {
  const PLAN = { kind: 'compaction' as const, epoch: 9, nonce: 'n'.repeat(32), predecessor: null, supersedes: null, expected: { byteLength: 1, prefixHash: 'x' }, tx: 'tx-x' };
  const CALLS: Array<[string, (h: string) => unknown]> = [
    ['advanceWitness', (h) => advanceWitness(h, '@global', A, 'tx-c')],
    ['openTransition', (h) => openTransition(h, '@global', PLAN)],
    ['completeTransition', (h) => completeTransition(h, '@global', A, 'tx-c')],
    ['discardTransition', (h) => discardTransition(h, '@global', 'n'.repeat(32))],
    ['maybeCleanupClear', (h) => maybeCleanupClear(h, '@global', A)],
  ];
  const cells = UNUSABLE.filter((o) => !o.skip).flatMap((o) => CALLS.map(([fn, call]) => [`${o.name} / ${fn}`, o, fn, call] as const));
  it.each(cells)('%s', async (_n, o, fn, call) => {
    const h = home(); await o.plant(h);
    const before = snap(h);
    const e = thrown(() => call(h)) as WitnessUnusableError;
    expect(isWitnessUnusableError(e), `${fn} threw ${String(e)}`).toBe(true);
    expect(isWitnessAdvanceError(e)).toBe(false);   // a read failure is itself, never "no pending journal"
    expect(e.op).toBe(fn);
    expect(e.message).toBe(witnessUnusableRefusal(fn));
    expect(e.reason).toBe(o.reason);
    expect(snap(h)).toBe(before);
  });

  it('the refusal text is the 4.9 witness row, with the operation in front', () => {
    expect(witnessUnusableRefusal('commit')).toBe(
      'commit: the rollback-witness file cannot be used (its path cannot be resolved, a link stands at its name, it is not a regular file, or it cannot be read or parsed) — the write is refused rather than replacing that file, which would drop the baseline of every scope. Ask the user whether to restore it from a backup or to remove it, which starts every scope again from first contact; do not choose for them.');
  });
});

describe('the look is made again under the witness lock and again at the replace (decision 6, W-R3)', () => {
  it('M1: a link planted after the pre-lock check and before the locked read: refused, the destination does not move, the link stays', () => {
    const h = home(); const victim = join(h, 'elsewhere.json'); writeFileSync(victim, '{"note":"another file"}');
    const real = ledgerMacMod.ensureMaster;
    const spy = vi.spyOn(ledgerMacMod, 'ensureMaster').mockImplementationOnce((hm: string) => { swap(hm, (w) => symlinkSync(victim, w)); return real(hm); });
    try {
      const e = thrown(() => advanceWitness(h, '@global', A, 'tx-m1')) as WitnessUnusableError;
      expect(isWitnessUnusableError(e)).toBe(true); expect(e.reason).toBe('link');
    } finally { spy.mockRestore(); }
    expect(lstatSync(W(h)).isSymbolicLink()).toBe(true);
    expect(readFileSync(victim, 'utf8')).toBe('{"note":"another file"}');
  });

  it('M2: a link planted after the locked read, when the replace\'s tmp is about to be created: refused, the link stays, no tmp is left', () => {
    const h = home(); const victim = join(h, 'elsewhere.json'); writeFileSync(victim, '{"note":"another file"}');
    let fired = 0;
    const ops: DurableFsOps = { ...realFsOps, openSync: (p, f, m) => {
      if (fired === 0 && /\/witness\.json\.w-[0-9a-f]{32}\.tmp$/.test(p)) { fired++; swap(h, (w) => symlinkSync(victim, w)); }
      return realFsOps.openSync(p, f, m);
    } };
    const e = thrown(() => advanceWitness(h, '@global', A, 'tx-m2', ops)) as WitnessUnusableError;
    expect(fired).toBe(1);
    expect(isWitnessUnusableError(e)).toBe(true); expect(e.reason).toBe('link');
    expect(lstatSync(W(h)).isSymbolicLink()).toBe(true);
    expect(readFileSync(victim, 'utf8')).toBe('{"note":"another file"}');
    expect(readdirSync(h).filter((n) => n.includes('.w-'))).toEqual([]);
  });

  it('M2 with a directory taking the name: refused the same way (a non-regular object, not only a link)', () => {
    const h = home();
    let fired = 0;
    const ops: DurableFsOps = { ...realFsOps, openSync: (p, f, m) => {
      if (fired === 0 && /\.w-[0-9a-f]{32}\.tmp$/.test(p)) { fired++; swap(h, (w) => mkdirSync(w)); }
      return realFsOps.openSync(p, f, m);
    } };
    const e = thrown(() => advanceWitness(h, '@global', A, 'tx-m2d', ops)) as WitnessUnusableError;
    expect(isWitnessUnusableError(e)).toBe(true); expect(e.reason).toBe('not-regular');
    expect(readdirSync(h).filter((n) => n.includes('.w-'))).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('a FIFO at witness.json is answered, never waited on', () => {
  it('the read finishes inside a deadline and marks the file unusable (the child is killed at 10 s otherwise)', async () => {
    const h = realpathSync(mkdtempSync(join(tmpdir(), 'wf-')));
    execFileSync('mkfifo', [W(h)]);
    const child = await bundleCli(join(process.cwd(), 'test/helpers/witness-read-child.ts'));
    const r = spawnSync(process.execPath, [child, h], { timeout: 10_000, killSignal: 'SIGKILL', encoding: 'utf8' });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ entry: null, journal: null, macInvalid: false, file: 'unusable' });
  }, 60_000);   // the bundling is the slow part (A7's matrix gives it the same budget)
});

describe.skipIf(process.platform === 'win32')('a home below an unresolvable path (D3; W-R1): reads open the file as written, writes are refused', () => {
  /** <d>/real<0xff>/ holds a copy of a valid home; <d>/home is a link to it, so the home's path crosses a link whose body is not UTF-8. */
  function lowHome(): string {
    const src = home(); const d = realpathSync(mkdtempSync(join(tmpdir(), 'wf-')));
    const dir = Buffer.concat([Buffer.from(`${d}/real`), Buffer.from([0xff])]);
    mkdirSync(dir, { mode: 0o700 });
    for (const n of ['witness.json', 'ledger-mac-master.key']) copyFileSync(join(src, n), Buffer.concat([dir, Buffer.from(`/${n}`)]));
    symlinkSync(dir, join(d, 'home'));
    return join(d, 'home');
  }
  it('the read computes the real verdict from the file as written and says so with the mark', () => {
    const h = lowHome();
    const s = readScopeWitness(h, '@global', WITNESS_READ_AS_GIVEN);
    expect(s.file).toBe('as-given');
    expect(s.macInvalid).toBe(false);
    expect(classifyState(s, A).kind).toBe('in-sync');
    const e = thrown(() => readScopeWitness(h, '@global')) as WitnessUnusableError;
    expect(isWitnessUnusableError(e)).toBe(true); expect(e.reason).toBe('unresolvable');
  });
  it('every writer refuses before it creates anything', () => {
    const h = lowHome();
    const e = thrown(() => advanceWitness(h, '@global', A, 'tx-u')) as WitnessUnusableError;
    expect(isWitnessUnusableError(e)).toBe(true); expect(e.reason).toBe('unresolvable');
  });
});

describe('the rebaseline ceremony does not replace a witness file that cannot be used', () => {
  it('exits 2 before it prompts or writes (the text is pinned in cli-refusal-matrix.test.ts)', async () => {
    const h = home(); const ledger = join(h, 'memory.jsonl'); writeFileSync(ledger, '{"id":"m_1"}\n');
    writeFileSync(W(h), 'garbage {');
    let prompted = false; let code: number | null = null;
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const ret = await rebaseline(['--scope', 'global'], { env: { HELIX_HOME: h }, isTTY: true, promptLine: async () => { prompted = true; return 'bless'; }, exit: (c: number) => { code = c; } });
      expect(ret).toBe(2); expect(code).toBe(ret);
    } finally { err.mockRestore(); }
    expect(prompted).toBe(false);
    expect(readFileSync(W(h), 'utf8')).toBe('garbage {');
  });
});

describe('what a read says beside the mark (W-R1, W-R2; section 14 item 16)', () => {
  const firstContact: WitnessVerdict = { kind: 'first-contact', reason: 'no-entry' };
  const mismatch: WitnessVerdict = { kind: 'mismatch' };
  const interrupted = { kind: 'transition-interrupted', journal: {} } as unknown as WitnessVerdict;

  it('as-given with a first contact: the path note alone (the first-contact note promises a baseline at a write that is refused)', () => {
    expect(collectWitnessReadNotes([{ verdict: firstContact, witnessFile: 'as-given' }])).toEqual([WITNESS_PATH_UNRESOLVABLE_NOTE]);
  });
  it('as-given with a mismatch or an interrupted transition: the verdict\'s own note stands beside the path note, both are true', () => {
    expect(collectWitnessReadNotes([{ verdict: mismatch, witnessFile: 'as-given' }])).toEqual([WITNESS_PATH_UNRESOLVABLE_NOTE, WITNESS_MISMATCH_NOTE]);
    expect(collectWitnessReadNotes([{ verdict: interrupted, witnessFile: 'as-given' }])).toEqual([WITNESS_PATH_UNRESOLVABLE_NOTE, WITNESS_TRANSITION_NOTE]);
  });
  it('the as-of view limits no grade, so it carries no path note; a real verdict keeps its note there', () => {
    expect(collectWitnessReadNotes([{ verdict: firstContact, witnessFile: 'as-given' }], { asOf: true })).toEqual([]);
    expect(collectWitnessReadNotes([{ verdict: mismatch, witnessFile: 'as-given' }], { asOf: true })).toEqual([WITNESS_MISMATCH_NOTE]);
  });
  it('an unusable file keeps its own rule: the one note on a live read, none in the as-of view', () => {
    expect(collectWitnessReadNotes([{ verdict: firstContact, witnessFile: 'unusable' }])).toEqual([WITNESS_FILE_UNUSABLE_NOTE]);
    expect(collectWitnessReadNotes([{ verdict: firstContact, witnessFile: 'unusable' }], { asOf: true })).toEqual([]);
  });
});
