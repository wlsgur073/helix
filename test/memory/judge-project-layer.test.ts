import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MemoryStore } from '../../src/memory/store.js';
import { isGlobalLedgerEntry, judgeProjectLayer, projectLedgerPath, type JudgedLayer, type LayerJudgement } from '../../src/memory/ownership.js';

const NOW = '2026-10-01T00:00:00.000Z';
const FF = Buffer.from([0xff]);
const B = (...parts: Array<string | Buffer>): Buffer => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : p)));
const mk = (p: string): string => { fs.mkdirSync(p, { recursive: true }); return p; };
const REC = (id: string): string => JSON.stringify({ id, tx: NOW, validFrom: NOW, validTo: null, type: 'assert', state: 'Fresh', content: `fact ${id}`, provenance: { source: 'user', sessionId: 'pre' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' }) + '\n';
const mkfifo = (p: string): void => { execFileSync('mkfifo', [p]); };
const AS_ROOT = process.getuid?.() === 0;

interface W { b: string; home: string; G: string; root: string; A: string; Broot: string; adopted: boolean; locked: string[] }
const live: W[] = [];
afterEach(() => {
  for (const w of live.splice(0)) {
    for (const p of w.locked) { try { fs.chmodSync(p, 0o700); } catch { /* gone */ } }
    fs.rmSync(w.b, { recursive: true, force: true });
  }
});

/** A world: a global ledger with one record, registered project B (outside A unless a layout moves it) with one
 *  record, and project A (`root`, the physical directory `A`), adopted through a first commit when `adopted`. */
function build(adopted: boolean, place?: (w: W) => void): W {
  const b = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'jpl-')));
  const w: W = { b, home: join(b, 'home'), G: '', root: join(b, 'proj'), A: join(b, 'proj'), Broot: join(b, 'projB'), adopted, locked: [] };
  w.G = join(w.home, 'memory.jsonl');
  live.push(w);
  place?.(w);
  fs.mkdirSync(w.home, { recursive: true, mode: 0o700 });
  mk(w.A); mk(w.Broot);
  const seed = (id: string, root?: string): void => {
    const s = new MemoryStore(w.G, { home: w.home, sessionId: 'seed', now: () => NOW, genId: () => id, project: root === undefined ? undefined : { root, ledger: projectLedgerPath(root), origin: 'cwd' } });
    s.commit({ content: `fact ${id}`, source: 'user' });
  };
  seed('m_g1'); seed('m_b1', w.Broot);
  if (adopted) seed('m_p1', w.root);
  return w;
}
const H = (w: W): string => join(w.A, '.helix');
const M = (w: W): string => join(w.A, '.helix', 'memory.jsonl');
const Bled = (w: W): string => join(w.Broot, '.helix', 'memory.jsonl');
const helix = (w: W): string => mk(H(w));
/** the project's rows: an adopted world's ledger is MOVED to `to`; an unadopted one gets a ledger file there */
const rowsAt = (w: W, to: string | Buffer): void => { mk(dirname(String(to))); if (w.adopted) fs.renameSync(M(w), to); else fs.writeFileSync(to, REC('m_p1')); };
/** take an adopted world's ledger away from the memory path */
const dropLedger = (w: W): void => { helix(w); if (w.adopted) fs.renameSync(M(w), join(w.b, 'stash-ledger.jsonl')); };
const stashHelix = (w: W): void => { if (w.adopted) fs.renameSync(H(w), join(w.b, 'stash-helix')); };
const ownFile = (w: W): void => { helix(w); if (!w.adopted) fs.writeFileSync(M(w), REC('m_p1')); };
const lock = (w: W, p: string): void => { fs.chmodSync(p, 0o000); w.locked.push(p); };
const homeInRoot = (w: W): void => { w.home = join(w.b, 'proj', 'inner', 'home'); w.G = join(w.home, 'memory.jsonl'); };
const bInRoot = (w: W): void => { w.Broot = join(w.b, 'proj', 'nested', 'projB'); };
const customG = (w: W): void => { w.G = join(mk(join(w.b, 'gl')), 'custom.jsonl'); };
const inrootLedger = (w: W): string => { helix(w); const t = join(w.A, 'data', 'mem.jsonl'); rowsAt(w, t); return t; };
/** the global ledger becomes a link the kernel refuses (ENOTDIR): the resolver answers uninspectable */
const gUninspectable = (w: W): void => { fs.renameSync(w.G, join(w.home, 'kept.jsonl')); fs.symlinkSync('kept.jsonl/', w.G); };
/** registered B at <b>/outer with project A inside it */
const bHoldsA = (w: W): void => { w.Broot = join(w.b, 'outer'); w.A = join(w.b, 'outer', 'inner', 'proj'); w.root = w.A; };
/** B's ledger becomes a link to itself: the resolver answers unresolvable */
const selfLoopB = (w: W): void => { fs.renameSync(Bled(w), join(w.Broot, '.helix', 'kept.jsonl')); fs.symlinkSync('memory.jsonl', Bled(w)); };
const regAdd = (w: W, key: string): void => {
  const p = join(w.home, 'projects.json'); const reg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const src = Object.keys(reg).find((k) => k !== '@global')!; reg[key] = { ...reg[src], stamp: 'feedfeedfeedfeedfeedfeedfeedfeed' };
  fs.writeFileSync(p, JSON.stringify(reg, null, 2));
};

interface Exp { state: string; row: string; cause?: string }
const e = (state: string, row: string, cause?: string) => (): Exp => ({ state, row, cause });
/** rows 11 to 13: owned when adopted, otherwise the unadopted state the memory path's file gives */
const ownedOr = (u: 'unadopted-present' | 'inactive') => (adopted: boolean): Exp =>
  adopted ? { state: 'owned', row: '11' } : u === 'inactive' ? { state: 'inactive', row: '13' } : { state: 'unadopted-present', row: '12' };

interface Layout { id: string; variants?: Array<'u' | 'a'>; skipAsRoot?: boolean; place?: (w: W) => void; shape: (w: W) => void; expect: (adopted: boolean) => Exp }
const LAYOUTS: Layout[] = [
  // J1: the table
  { id: 'J1-01 no .helix at all (row 13: a first commit creates it)', variants: ['u'], shape: () => {}, expect: e('inactive', '13') },
  { id: 'J1-02 .helix is an empty directory (row 13)', variants: ['u'], shape: (w) => { helix(w); }, expect: e('inactive', '13') },
  { id: 'J1-03 the memory path is the project\'s own regular file (rows 11, 12)', shape: ownFile, expect: ownedOr('unadopted-present') },
  { id: 'J1-04 .helix is a regular file (row 3)', shape: (w) => { stashHelix(w); fs.writeFileSync(H(w), 'x\n'); }, expect: e('unusable', '3', 'helix-not-directory') },
  { id: 'J1-05 .helix is a link to a directory that holds the rows (row 3)', shape: (w) => { const t = join(mk(join(w.b, 'elsewhere')), 'h'); if (w.adopted) fs.renameSync(H(w), t); else { mk(t); fs.writeFileSync(join(t, 'memory.jsonl'), REC('m_p1')); } fs.symlinkSync(t, H(w)); }, expect: e('unusable', '3', 'helix-not-directory') },
  { id: 'J1-06 .helix is a dangling link (row 3, lstat)', shape: (w) => { stashHelix(w); fs.symlinkSync(join(w.b, 'nowhere', 'h'), H(w)); }, expect: e('unusable', '3', 'helix-not-directory') },
  { id: 'J1-07 .helix is a FIFO (row 3)', shape: (w) => { stashHelix(w); mkfifo(H(w)); }, expect: e('unusable', '3', 'helix-not-directory') },
  { id: 'J1-08 the memory path links to a file whose name is not valid UTF-8 (row 4)', shape: (w) => { helix(w); const t = B(H(w), '/re', FF, 'l.jsonl'); rowsAt(w, t); fs.symlinkSync(t, M(w)); }, expect: e('aliased', '4', 'unresolvable') },
  { id: 'J1-09 the memory path is a link loop (row 4)', shape: (w) => { dropLedger(w); fs.symlinkSync('loopA', M(w)); fs.symlinkSync('loopB', join(H(w), 'loopA')); fs.symlinkSync('loopA', join(H(w), 'loopB')); }, expect: e('aliased', '4', 'unresolvable') },
  { id: 'J1-10 the root lies below a directory whose name is not valid UTF-8 (row 4, the paragraph on row 6\'s root)', variants: ['u'],
    place: (w) => { const real = B(w.b, '/', FF, 'd'); fs.mkdirSync(B(real, '/proj/.helix'), { recursive: true }); fs.writeFileSync(B(real, '/proj/.helix/memory.jsonl'), REC('m_p1')); fs.symlinkSync(real, join(w.b, 'via')); w.root = join(w.b, 'via', 'proj'); w.A = w.root; },
    shape: () => {}, expect: e('aliased', '4', 'unresolvable') },
  { id: 'J1-11 .helix is a directory at mode 000 (row 5)', skipAsRoot: true, shape: (w) => { ownFile(w); lock(w, H(w)); }, expect: e('unusable', '5', 'uninspectable') },
  { id: 'J1-12 the memory path links into a mode-000 directory inside the project (row 5)', skipAsRoot: true, shape: (w) => { helix(w); const t = join(w.A, 'vault', 'x.jsonl'); rowsAt(w, t); fs.symlinkSync(t, M(w)); lock(w, join(w.A, 'vault')); }, expect: e('unusable', '5', 'uninspectable') },
  { id: 'J1-13 the memory path links into a mode-000 directory outside the project (row 5, before row 6)', skipAsRoot: true, shape: (w) => { helix(w); const t = join(w.b, 'out000', 'x.jsonl'); rowsAt(w, t); fs.symlinkSync(t, M(w)); lock(w, join(w.b, 'out000')); }, expect: e('unusable', '5', 'uninspectable') },
  { id: 'J1-14 the memory path links to a path below a regular file (row 5)', shape: (w) => { dropLedger(w); fs.writeFileSync(join(w.A, 'afile'), 'x\n'); fs.symlinkSync(join(w.A, 'afile', 'x.jsonl'), M(w)); }, expect: e('unusable', '5', 'uninspectable') },
  { id: 'J1-15 the link body is an in-project ledger plus a slash (row 5)', shape: (w) => { helix(w); rowsAt(w, join(H(w), 'kept.jsonl')); fs.symlinkSync('kept.jsonl/', M(w)); }, expect: e('unusable', '5', 'uninspectable') },
  { id: 'J1-16 the link body climbs with .. over a directory that does not exist (row 5)', shape: (w) => { helix(w); rowsAt(w, join(H(w), 'kept.jsonl')); fs.symlinkSync('nodir/../kept.jsonl', M(w)); }, expect: e('unusable', '5', 'uninspectable') },
  { id: 'J1-17 link to an unregistered ledger outside the project (row 6, D1)', shape: (w) => { helix(w); const t = join(w.b, 'out', 'other.jsonl'); rowsAt(w, t); fs.symlinkSync(t, M(w)); }, expect: e('aliased', '6', 'outside-root') },
  { id: 'J1-18 link to a non-ledger file outside the project (row 6)', shape: (w) => { dropLedger(w); mk(join(w.b, 'out')); fs.writeFileSync(join(w.b, 'out', 'notes.txt'), 'plain notes\nline two\n'); fs.symlinkSync(join(w.b, 'out', 'notes.txt'), M(w)); }, expect: e('aliased', '6', 'outside-root') },
  { id: 'J1-19 dangling link outside the project, its directory exists (row 6)', shape: (w) => { dropLedger(w); mk(join(w.b, 'out')); fs.symlinkSync(join(w.b, 'out', 'new.jsonl'), M(w)); }, expect: e('aliased', '6', 'outside-root') },
  { id: 'J1-20 dangling link outside the project, its directory is missing (row 6 before row 10)', shape: (w) => { dropLedger(w); fs.symlinkSync(join(w.b, 'nodir', 'new.jsonl'), M(w)); }, expect: e('aliased', '6', 'outside-root') },
  { id: 'J1-21 link to the global ledger, the home is outside the project (row 6)', shape: (w) => { dropLedger(w); fs.symlinkSync(w.G, M(w)); }, expect: e('aliased', '6', 'outside-root') },
  { id: 'J1-22 link to registered B\'s ledger, B outside the project (row 6)', shape: (w) => { dropLedger(w); fs.symlinkSync(Bled(w), M(w)); }, expect: e('aliased', '6', 'outside-root') },
  { id: 'J1-23 link to the global ledger, the home INSIDE the project (row 7, first comparison)', place: homeInRoot, shape: (w) => { dropLedger(w); fs.symlinkSync(w.G, M(w)); }, expect: e('aliased', '7', 'global-ledger') },
  { id: 'J1-24 link to registered B\'s ledger, B INSIDE the project (row 7, second comparison)', place: bInRoot, shape: (w) => { dropLedger(w); fs.symlinkSync(Bled(w), M(w)); }, expect: e('aliased', '7', 'other-project') },
  { id: 'J1-25 own regular file that registered B\'s ledger links to (T7-1 exception)', shape: (w) => { ownFile(w); fs.renameSync(Bled(w), join(w.Broot, '.helix', 'kept.jsonl')); fs.symlinkSync(M(w), Bled(w)); }, expect: ownedOr('unadopted-present') },
  { id: 'J1-26 A and nested B both link (dangling) to one third file inside A (row 7, equal resolved strings)', place: bInRoot, shape: (w) => { dropLedger(w); const third = join(mk(join(w.A, 'shared')), 'third.jsonl'); fs.symlinkSync(third, M(w)); fs.renameSync(Bled(w), join(w.Broot, '.helix', 'kept.jsonl')); fs.symlinkSync(third, Bled(w)); }, expect: e('aliased', '7', 'other-project') },
  { id: 'J1-27 the memory file has a second hard link (row 8, D6)', shape: (w) => { ownFile(w); fs.linkSync(M(w), join(H(w), 'second-name.jsonl')); }, expect: e('aliased', '8', 'hard-link') },
  { id: 'J1-28 a directory stands at the memory path (row 9)', shape: (w) => { dropLedger(w); mk(M(w)); }, expect: e('unusable', '9', 'not-regular') },
  { id: 'J1-29 a FIFO stands at the memory path (row 9, never opened)', shape: (w) => { dropLedger(w); mkfifo(M(w)); }, expect: e('unusable', '9', 'not-regular') },
  { id: 'J1-30 the memory file is a regular file at mode 000 (row 9, the open fails)', skipAsRoot: true, shape: (w) => { ownFile(w); fs.chmodSync(M(w), 0o000); }, expect: e('unusable', '9', 'unreadable') },
  { id: 'J1-31 link to a FIFO inside the project (row 9)', shape: (w) => { dropLedger(w); mk(join(w.A, 'data')); mkfifo(join(w.A, 'data', 'pipe')); fs.symlinkSync(join(w.A, 'data', 'pipe'), M(w)); }, expect: e('unusable', '9', 'not-regular') },
  { id: 'J1-32 link to an in-project file that is not ledger rows (row 9a)', shape: (w) => { dropLedger(w); fs.writeFileSync(join(w.A, 'README.md'), '# readme\nsome text\n'); fs.symlinkSync(join(w.A, 'README.md'), M(w)); }, expect: e('unusable', '9a', 'not-ledger-content') },
  { id: 'J1-33 link to an EMPTY in-project file (row 9a does not apply)', shape: (w) => { dropLedger(w); mk(join(w.A, 'data')); fs.writeFileSync(join(w.A, 'data', 'empty.jsonl'), ''); fs.symlinkSync(join(w.A, 'data', 'empty.jsonl'), M(w)); }, expect: ownedOr('unadopted-present') },
  { id: 'J1-34 link to an in-project ledger file (own-tree link kept)', shape: (w) => { helix(w); const t = join(w.A, 'data', 'mem.jsonl'); rowsAt(w, t); fs.symlinkSync(t, M(w)); }, expect: ownedOr('unadopted-present') },
  { id: 'J1-35 dangling in-project link whose directory is missing (row 10)', shape: (w) => { dropLedger(w); fs.symlinkSync(join(w.A, 'nodir', 'new.jsonl'), M(w)); }, expect: e('unusable', '10', 'target-directory-missing') },
  { id: 'J1-36 dangling in-project link whose directory exists (rows 11, 13)', shape: (w) => { dropLedger(w); mk(join(w.A, 'data')); fs.symlinkSync(join(w.A, 'data', 'new.jsonl'), M(w)); }, expect: ownedOr('inactive') },
  { id: 'J1-37 row 10 through a dangling directory link that leaves the project (the marked path is text)', shape: (w) => { dropLedger(w); mk(join(w.A, 'sub2')); fs.symlinkSync(join(w.b, 'outside-missing'), join(w.A, 'sub2', 'ddl')); fs.symlinkSync(join(w.A, 'sub2', 'ddl', 'absent.jsonl'), M(w)); }, expect: e('unusable', '10', 'target-directory-missing') },
  // J3: row 7 and its comparison targets (decision 6)
  { id: 'J3-02 the home is inside the project, own regular file', place: homeInRoot, shape: ownFile, expect: ownedOr('unadopted-present') },
  { id: 'J3-03 registered B is inside the project, own regular file', place: bInRoot, shape: ownFile, expect: ownedOr('unadopted-present') },
  { id: 'J3-05 nested B\'s ledger is a link the kernel refuses (kept.jsonl/); A links to B\'s kept.jsonl (decision 6, first rule)', place: bInRoot,
    shape: (w) => { dropLedger(w); fs.renameSync(Bled(w), join(w.Broot, '.helix', 'kept.jsonl')); fs.symlinkSync('kept.jsonl/', Bled(w)); fs.symlinkSync(join(w.Broot, '.helix', 'kept.jsonl'), M(w)); }, expect: e('aliased', '7', 'unjudgeable-target') },
  { id: 'J3-06 the same with B OUTSIDE the project (row 6)',
    shape: (w) => { dropLedger(w); fs.renameSync(Bled(w), join(w.Broot, '.helix', 'kept.jsonl')); fs.symlinkSync('kept.jsonl/', Bled(w)); fs.symlinkSync(join(w.Broot, '.helix', 'kept.jsonl'), M(w)); }, expect: e('aliased', '6', 'outside-root') },
  { id: 'J3-07 the global ledger is unresolvable but the kernel reaches a file inside A that A links to (same device and inode)',
    shape: (w) => { dropLedger(w); mk(join(w.A, 'x', 'y')); fs.symlinkSync(join(w.A, 'x', 'y'), B(w.A, '/', FF, 'dl')); fs.renameSync(w.G, join(w.A, 'x', 'g.jsonl')); fs.symlinkSync(B(w.A, '/', FF, 'dl/../g.jsonl'), w.G); fs.symlinkSync(join(w.A, 'x', 'g.jsonl'), M(w)); }, expect: e('aliased', '7', 'global-ledger') },
  { id: 'J3-08 nested B\'s ledger is unresolvable (non-UTF-8 directory link) and the kernel reaches the file A links to', place: bInRoot,
    shape: (w) => { dropLedger(w); const bh = join(w.Broot, '.helix'); mk(join(bh, 'x', 'y')); fs.symlinkSync(join(bh, 'x', 'y'), B(bh, '/', FF, 'dl')); fs.renameSync(Bled(w), join(bh, 'x', 'kept.jsonl')); fs.symlinkSync(B(bh, '/', FF, 'dl/../kept.jsonl'), Bled(w)); fs.symlinkSync(join(bh, 'x', 'kept.jsonl'), M(w)); }, expect: e('aliased', '7', 'other-project') },
  { id: 'J3-09 nested B\'s .helix is at mode 000; A links into it (row 5 before row 7)', skipAsRoot: true, place: bInRoot,
    shape: (w) => { dropLedger(w); fs.symlinkSync(Bled(w), M(w)); lock(w, join(w.Broot, '.helix')); }, expect: e('unusable', '5', 'uninspectable') },
  // J4: row 6's root
  { id: 'J4-17 the root is spelled through a linked parent directory', shape: (w) => { ownFile(w); mk(join(w.b, 'lp')); fs.symlinkSync(w.b, join(w.b, 'lp', 'pl')); w.root = join(w.b, 'lp', 'pl', 'proj'); }, expect: ownedOr('unadopted-present') },
  { id: 'J4-17c the root itself is a symlink to the project', shape: (w) => { ownFile(w); fs.symlinkSync(w.A, join(w.b, 'Al')); w.root = join(w.b, 'Al'); }, expect: ownedOr('unadopted-present') },
  { id: 'J4-22c the root is spelled <b>/dl/../proj, dl a directory link (the kernel reads <b>/p/proj)', shape: (w) => { ownFile(w); mk(join(w.b, 'p', 'q')); fs.symlinkSync(join(w.b, 'p', 'q'), join(w.b, 'dl')); mk(join(w.b, 'p', 'proj', '.helix')); w.root = `${w.b}/dl/../proj`; }, expect: ownedOr('unadopted-present') },
  { id: 'J4-17b linked parent, and the memory path is a relative link to an in-project ledger file', shape: (w) => { inrootLedger(w); fs.symlinkSync('../data/mem.jsonl', M(w)); mk(join(w.b, 'lp')); fs.symlinkSync(w.b, join(w.b, 'lp', 'pl')); w.root = join(w.b, 'lp', 'pl', 'proj'); }, expect: ownedOr('unadopted-present') },
  { id: 'J4-22d the root is spelled through a link whose body has .. after a directory link (the kernel reads <b>/p/real/A2)',
    place: (w) => { mk(join(w.b, 'p', 'q')); fs.symlinkSync(join(w.b, 'p', 'q'), join(w.b, 'dlx')); w.A = mk(join(w.b, 'p', 'real', 'A2')); fs.symlinkSync('dlx/../real', join(w.b, 'pl2')); w.root = join(w.b, 'pl2', 'A2'); },
    shape: ownFile, expect: ownedOr('unadopted-present') },
  { id: 'J4-R5 the root lies below a directory at mode 000 (row 5, a root that cannot be inspected)', skipAsRoot: true,
    place: (w) => { w.A = mk(join(w.b, 'locked', 'proj')); w.root = w.A; }, shape: (w) => { ownFile(w); lock(w, join(w.b, 'locked')); }, expect: e('unusable', '5', 'uninspectable') },
  // V: the skeptic's layouts
  { id: 'V06 HELIX_LEDGER names a custom file outside; the memory path links to it (row 6)', place: customG, shape: (w) => { dropLedger(w); fs.symlinkSync(w.G, M(w)); }, expect: e('aliased', '6', 'outside-root') },
  { id: 'V07 HELIX_LEDGER names a file inside the project; own regular memory file', place: (w) => { w.G = join(mk(join(w.b, 'proj', 'data')), 'g.jsonl'); }, shape: ownFile, expect: ownedOr('unadopted-present') },
  { id: 'V07b HELIX_LEDGER names a file inside the project; the memory path is a relative link to it (row 7)', place: (w) => { w.G = join(mk(join(w.b, 'proj', 'data')), 'g.jsonl'); }, shape: (w) => { dropLedger(w); fs.symlinkSync('../data/g.jsonl', M(w)); }, expect: e('aliased', '7', 'global-ledger') },
  { id: 'V09 the custom global ledger is a second hard link of the project file (row 7 before row 8)', place: customG, shape: (w) => { ownFile(w); fs.unlinkSync(w.G); fs.linkSync(M(w), w.G); }, expect: e('aliased', '7', 'global-ledger') },
  { id: 'V10 relative link to an unregistered ledger outside (row 6)', shape: (w) => { helix(w); rowsAt(w, join(w.b, 'out', 'other.jsonl')); fs.symlinkSync('../../out/other.jsonl', M(w)); }, expect: e('aliased', '6', 'outside-root') },
  { id: 'V11 ../data/mem.jsonl where data is a directory link out of the project (the kernel destination decides, row 6)', shape: (w) => { helix(w); rowsAt(w, join(w.b, 'outdata', 'mem.jsonl')); fs.symlinkSync(join(w.b, 'outdata'), join(w.A, 'data')); fs.symlinkSync('../data/mem.jsonl', M(w)); }, expect: e('aliased', '6', 'outside-root') },
  { id: 'V12 <b>/lnk/mem.jsonl where lnk is a directory link INTO the project (own-tree link kept)', shape: (w) => { inrootLedger(w); fs.symlinkSync(join(w.A, 'data'), join(w.b, 'lnk')); fs.symlinkSync(join(w.b, 'lnk', 'mem.jsonl'), M(w)); }, expect: ownedOr('unadopted-present') },
  { id: 'V13 link into <b>/proj-other, a sibling whose name starts with the root name (row 6 by path component)', shape: (w) => { helix(w); rowsAt(w, join(w.b, 'proj-other', 'mem.jsonl')); fs.symlinkSync(join(w.b, 'proj-other', 'mem.jsonl'), M(w)); }, expect: e('aliased', '6', 'outside-root') },
  { id: 'V14 link with body "." (a directory, row 9)', shape: (w) => { dropLedger(w); fs.symlinkSync('.', M(w)); }, expect: e('unusable', '9', 'not-regular') },
  { id: 'V15 the project lies INSIDE the home directory; the memory path links to the global ledger (row 6)', place: (w) => { w.A = join(w.b, 'home', 'work', 'proj'); w.root = w.A; }, shape: (w) => { dropLedger(w); fs.symlinkSync(w.G, M(w)); }, expect: e('aliased', '6', 'outside-root') },
  { id: 'V15b the project lies INSIDE the home directory; own file (decision 7 leaves the own memory path alone)', place: (w) => { w.A = join(w.b, 'home', 'work', 'proj'); w.root = w.A; }, shape: ownFile, expect: ownedOr('unadopted-present') },
  { id: 'V15c the project lies INSIDE the home directory; an in-tree link to a file that is not its own memory path (decision 9: the exemption is for the own file only)', place: (w) => { w.A = join(w.b, 'home', 'work', 'proj'); w.root = w.A; }, shape: (w) => { inrootLedger(w); fs.symlinkSync('../data/mem.jsonl', M(w)); }, expect: e('aliased', '7', 'home-directory') },
  { id: 'V17 nested B keeps its ledger behind its own in-tree link; A links to B\'s memory path (row 7)', place: bInRoot, shape: (w) => { dropLedger(w); mk(join(w.Broot, 'data')); fs.renameSync(Bled(w), join(w.Broot, 'data', 'real.jsonl')); fs.symlinkSync('../data/real.jsonl', Bled(w)); fs.symlinkSync(Bled(w), M(w)); }, expect: e('aliased', '7', 'other-project') },
  { id: 'V18 in-tree link; the registry also holds a root that does not exist', shape: (w) => { inrootLedger(w); fs.symlinkSync('../data/mem.jsonl', M(w)); regAdd(w, join(w.b, 'gone')); }, expect: ownedOr('unadopted-present') },
  { id: 'V21 A keeps its ledger behind an in-tree link and registered B (outside) links to that same file (row 7)', shape: (w) => { const t = inrootLedger(w); fs.symlinkSync('../data/mem.jsonl', M(w)); fs.renameSync(Bled(w), join(w.Broot, '.helix', 'kept.jsonl')); fs.symlinkSync(t, Bled(w)); }, expect: e('aliased', '7', 'other-project') },
  { id: 'V23 nested B\'s ledger is a self loop (unresolvable); A links to a ledger file inside B\'s .helix (decision 6, first rule)', place: bInRoot, shape: (w) => { dropLedger(w); fs.renameSync(Bled(w), join(w.Broot, '.helix', 'kept.jsonl')); fs.symlinkSync('memory.jsonl', Bled(w)); fs.symlinkSync(join(w.Broot, '.helix', 'kept.jsonl'), M(w)); }, expect: e('aliased', '7', 'unjudgeable-target') },
  { id: 'V24 the global ledger is an unresolvable link whose kernel destination is an ABSENT file inside A that A links to (decision 6, second rule)', shape: (w) => { dropLedger(w); mk(join(w.A, 'x', 'y')); fs.symlinkSync(join(w.A, 'x', 'y'), B(w.A, '/', FF, 'dl')); fs.renameSync(w.G, join(w.b, 'stash-g.jsonl')); fs.symlinkSync(B(w.A, '/', FF, 'dl/../g.jsonl'), w.G); fs.symlinkSync(join(w.A, 'x', 'g.jsonl'), M(w)); }, expect: e('aliased', '7', 'unjudgeable-target') },
  { id: 'V24b the global ledger is UNINSPECTABLE (a link with body kept.jsonl/, the kernel answers ENOTDIR) and the memory path is an in-tree link (decision 6, second rule, read by decision 9)', shape: (w) => { inrootLedger(w); fs.symlinkSync('../data/mem.jsonl', M(w)); gUninspectable(w); }, expect: e('aliased', '7', 'unjudgeable-target') },
  { id: 'V24c the global ledger is uninspectable, the project holds its own regular file (exempt, decision 9)', shape: (w) => { ownFile(w); gUninspectable(w); }, expect: ownedOr('unadopted-present') },
  { id: 'V24d the global ledger is unresolvable, the project holds its own regular file (exempt, decision 9)', shape: (w) => { ownFile(w); mk(join(w.A, 'x', 'y')); fs.symlinkSync(join(w.A, 'x', 'y'), B(w.A, '/', FF, 'dl')); fs.renameSync(w.G, join(w.b, 'stash-g.jsonl')); fs.symlinkSync(B(w.A, '/', FF, 'dl/../g.jsonl'), w.G); }, expect: ownedOr('unadopted-present') },
  { id: 'V25 in-tree link to a ledger file with a second name inside the project (row 8)', shape: (w) => { const t = inrootLedger(w); fs.linkSync(t, join(w.A, 'data', 'second.jsonl')); fs.symlinkSync('../data/mem.jsonl', M(w)); }, expect: e('aliased', '8', 'hard-link') },
  { id: 'V27 in-tree link to a file holding {} only (row 9a)', shape: (w) => { dropLedger(w); mk(join(w.A, 'data')); fs.writeFileSync(join(w.A, 'data', 'x.jsonl'), '{}\n'); fs.symlinkSync('../data/x.jsonl', M(w)); }, expect: e('unusable', '9a', 'not-ledger-content') },
  { id: 'V28 in-tree link to a ledger with garbage lines after the record (one record line is enough)', shape: (w) => { const t = inrootLedger(w); fs.appendFileSync(t, 'not json\n{}\n[1,2]\n'); fs.symlinkSync('../data/mem.jsonl', M(w)); }, expect: ownedOr('unadopted-present') },
  { id: 'V28b in-tree link to a file with garbage lines BEFORE the record', shape: (w) => { const t = inrootLedger(w); fs.writeFileSync(t, 'not json\n\n{}\n' + fs.readFileSync(t, 'utf8')); fs.symlinkSync('../data/mem.jsonl', M(w)); }, expect: ownedOr('unadopted-present') },
  { id: 'V29 in-tree link to a file of blank lines (empty: no non-blank line)', shape: (w) => { dropLedger(w); mk(join(w.A, 'data')); fs.writeFileSync(join(w.A, 'data', 'x.jsonl'), '\n  \n\t\n'); fs.symlinkSync('../data/x.jsonl', M(w)); }, expect: ownedOr('unadopted-present') },
  { id: 'V30 in-tree link to a file with a UTF-8 BOM and ONE record line (the reader skips the BOM line: no record)', shape: (w) => { dropLedger(w); mk(join(w.A, 'data')); fs.writeFileSync(join(w.A, 'data', 'x.jsonl'), '\uFEFF' + REC('m_x1')); fs.symlinkSync('../data/x.jsonl', M(w)); }, expect: e('unusable', '9a', 'not-ledger-content') },
  { id: 'V31 in-tree link to a ledger file with CRLF line ends', shape: (w) => { dropLedger(w); mk(join(w.A, 'data')); fs.writeFileSync(join(w.A, 'data', 'x.jsonl'), REC('m_x1').replace('\n', '\r\n')); fs.symlinkSync('../data/x.jsonl', M(w)); }, expect: ownedOr('unadopted-present') },
  { id: 'V32 in-tree link to a file whose one JSON line has provenance null (row 9a)', shape: (w) => { dropLedger(w); mk(join(w.A, 'data')); fs.writeFileSync(join(w.A, 'data', 'x.jsonl'), JSON.stringify({ id: 'm_x1', content: 'c', tx: NOW, provenance: null }) + '\n'); fs.symlinkSync('../data/x.jsonl', M(w)); }, expect: e('unusable', '9a', 'not-ledger-content') },
  { id: 'V33 the memory path is a real file holding plain text (the content of a memory file that is not a link is not read)', shape: (w) => { dropLedger(w); fs.writeFileSync(M(w), 'plain text\nmore\n'); }, expect: ownedOr('unadopted-present') },
  { id: 'V34 the memory path reaches an in-project ledger through three links', shape: (w) => { inrootLedger(w); fs.symlinkSync('../data/mem.jsonl', join(H(w), 'hop2')); fs.symlinkSync('hop2', join(H(w), 'hop1')); fs.symlinkSync('hop1', M(w)); }, expect: ownedOr('unadopted-present') },
  { id: 'V35 in-tree link to a ledger file at mode 0200 (row 9, the read-only open fails)', skipAsRoot: true, shape: (w) => { const t = inrootLedger(w); fs.symlinkSync('../data/mem.jsonl', M(w)); fs.chmodSync(t, 0o200); }, expect: e('unusable', '9', 'unreadable') },
  { id: 'V37 dangling relative in-tree link with two missing directory levels (row 10)', shape: (w) => { dropLedger(w); fs.symlinkSync('../nodir/sub/new.jsonl', M(w)); }, expect: e('unusable', '10', 'target-directory-missing') },
  // Decision 7 (SW-01): a destination inside the HELIX_HOME directory, the home inside the project
  { id: 'SW-01a the home is inside the project; the memory path links to the home\'s empty audit.jsonl (decision 7)', place: homeInRoot, shape: (w) => { dropLedger(w); fs.writeFileSync(join(w.home, 'audit.jsonl'), ''); fs.symlinkSync(join(w.home, 'audit.jsonl'), M(w)); }, expect: e('aliased', '7', 'home-directory') },
  { id: 'SW-01b the same for metrics.jsonl', place: homeInRoot, shape: (w) => { dropLedger(w); fs.writeFileSync(join(w.home, 'metrics.jsonl'), ''); fs.symlinkSync(join(w.home, 'metrics.jsonl'), M(w)); }, expect: e('aliased', '7', 'home-directory') },
  { id: 'SW-01c control: the home is inside the project; the memory path links to an empty file that is not in the home', place: homeInRoot, shape: (w) => { dropLedger(w); mk(join(w.A, 'data')); fs.writeFileSync(join(w.A, 'data', 'empty.jsonl'), ''); fs.symlinkSync(join(w.A, 'data', 'empty.jsonl'), M(w)); }, expect: ownedOr('unadopted-present') },
  // Decision 10: the home moves below the non-UTF-8 directory AFTER the seeding (a store's witness lock cannot be taken there), and the global ledger stays elsewhere
  { id: 'D10 HELIX_HOME lies below a directory link whose physical name is not valid UTF-8, the global ledger elsewhere, an in-tree link (the home rule has nothing to compare, decision 10)', place: customG, shape: (w) => { inrootLedger(w); fs.symlinkSync('../data/mem.jsonl', M(w)); const real = B(w.b, '/', FF, 'h'); fs.mkdirSync(real); fs.renameSync(w.home, B(real, '/home')); fs.symlinkSync(real, join(w.b, 'hl')); w.home = join(w.b, 'hl', 'home'); }, expect: ownedOr('unadopted-present') },
  // Decision 6 control: an unjudgeable registered project elsewhere does not touch a project that holds its own file
  { id: 'D6c control: nested B\'s ledger is a self loop; A keeps its own regular file (the own-path exception)', place: bInRoot, shape: (w) => { ownFile(w); fs.renameSync(Bled(w), join(w.Broot, '.helix', 'kept.jsonl')); fs.symlinkSync('memory.jsonl', Bled(w)); }, expect: ownedOr('unadopted-present') },
  { id: 'D6d registered B holds A in its root and B\'s ledger is a self loop; A keeps its own regular file (exempt from the first rule, decision 9)', place: bHoldsA, shape: (w) => { ownFile(w); selfLoopB(w); }, expect: ownedOr('unadopted-present') },
  { id: 'D6e the same with an in-tree link: the destination is not A\'s own memory path and lies in B\'s root (decision 6, first rule)', place: bHoldsA, shape: (w) => { inrootLedger(w); fs.symlinkSync('../data/mem.jsonl', M(w)); selfLoopB(w); }, expect: e('aliased', '7', 'unjudgeable-target') },
];

const judge = (w: W, extra: Partial<JudgedLayer> = {}, opts: { forAdopt?: boolean } = {}): LayerJudgement =>
  judgeProjectLayer({ root: w.root, ledger: projectLedgerPath(w.root), home: w.home, globalLedger: w.G, origin: 'cwd', ...extra }, opts);

describe('judgeProjectLayer: the table of design 4.2, one layout at a time', () => {
  for (const l of LAYOUTS) {
    for (const v of l.variants ?? ['u', 'a']) {
      (l.skipAsRoot && AS_ROOT ? it.skip : it)(`${l.id} [${v === 'a' ? 'adopted' : 'unadopted'}]`, () => {
        const w = build(v === 'a', l.place);
        l.shape(w);
        const j = judge(w);
        expect({ state: j.state, row: j.row, cause: j.cause }).toEqual(l.expect(v === 'a'));
      });
    }
  }
});

describe('judgeProjectLayer: rows 1 and 2, adopt, and the fields a write relies on', () => {
  it('row 1: no layer', () => {
    expect(judgeProjectLayer(undefined)).toEqual({ state: 'inactive', row: '1' });
  });

  it('row 2: an unadopted project found in a parent directory is not inspected (a FIFO at its memory path does not block)', () => {
    const w = build(false);
    helix(w); mkfifo(M(w));
    expect(judge(w, { origin: 'ancestor' })).toEqual({ state: 'ancestor-unadopted', row: '2' });
  });

  it('adopt applies rows 3 to 10 to that parent project directly (forAdopt): the FIFO is row 9', () => {
    const w = build(false);
    helix(w); mkfifo(M(w));
    const j = judge(w, { origin: 'ancestor' }, { forAdopt: true });
    expect({ state: j.state, row: j.row, cause: j.cause }).toEqual({ state: 'unusable', row: '9', cause: 'not-regular' });
  });

  it('an ADOPTED project found in a parent directory is judged by the table (row 2 is for the unadopted only)', () => {
    const w = build(true);
    expect(judge(w, { origin: 'ancestor' })).toMatchObject({ state: 'owned', row: '11' });
  });

  it('destination and identity: an owned plain file names its kernel path and its device and inode as bigints', () => {
    const w = build(true);
    const j = judge(w);
    const st = fs.lstatSync(M(w), { bigint: true });
    expect(j.destination).toBe(join(fs.realpathSync(w.A), '.helix', 'memory.jsonl'));
    expect(j.identity).toEqual({ dev: st.dev, ino: st.ino });
    expect(typeof j.identity!.ino).toBe('bigint');
    const dir = fs.lstatSync(H(w), { bigint: true });
    expect(j.dirIdentity).toEqual({ dev: dir.dev, ino: dir.ino });
  });

  it('dirIdentity names the directory that holds the DESTINATION, for an in-tree link the link target\'s directory', () => {
    const w = build(true);
    inrootLedger(w); fs.symlinkSync('../data/mem.jsonl', M(w));
    const dir = fs.lstatSync(join(w.A, 'data'), { bigint: true });
    expect(judge(w).dirIdentity).toEqual({ dev: dir.dev, ino: dir.ino });
  });

  it('dirIdentity is null when no directory stands there (row 13 with no .helix yet: decision 2, the append refuses a judged-no-directory sample)', () => {
    expect(judge(build(false))).toMatchObject({ state: 'inactive', row: '13', identity: null, dirIdentity: null });
  });

  it('identity is null when nothing stands at the destination (row 13), and the destination is still named', () => {
    const w = build(false);
    helix(w);
    const j = judge(w);
    expect(j).toMatchObject({ state: 'inactive', row: '13', identity: null });
    expect(j.destination).toBe(join(fs.realpathSync(w.A), '.helix', 'memory.jsonl'));
  });

  it('an excluded layer carries no identity (rows 3 to 10 answer before the identity is part of the answer)', () => {
    const w = build(true);
    dropLedger(w); fs.symlinkSync(join(w.b, 'out', 'x.jsonl'), M(w));
    expect(judge(w)).not.toHaveProperty('identity');
    expect(judge(w)).not.toHaveProperty('dirIdentity');
  });

  it('never throws: a caller that omits the global ledger gets the uninspectable answer, not an exception', () => {
    const w = build(true);
    expect(judgeProjectLayer({ root: w.root, ledger: projectLedgerPath(w.root), home: w.home } as unknown as JudgedLayer))
      .toMatchObject({ state: 'unusable', row: '5', cause: 'uninspectable' });
  });

  it('a registry entry for a root that is gone never matches and never throws (V18 without the link)', () => {
    const w = build(true);
    regAdd(w, join(w.b, 'gone'));
    expect(judge(w)).toMatchObject({ state: 'owned', row: '11' });
  });
});

describe('isGlobalLedgerEntry: the same directory entry (the paragraph on resolveProjectLayer, decision 16)', () => {
  const tree = (): string => fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'jgl-')));
  it('one path is one entry, whatever stands there (a file, or nothing yet)', () => {
    const d = tree(); mk(join(d, 'h'));
    expect(isGlobalLedgerEntry(join(d, 'h', 'memory.jsonl'), join(d, 'h', 'memory.jsonl'))).toBe(true);
    fs.writeFileSync(join(d, 'h', 'memory.jsonl'), '');
    expect(isGlobalLedgerEntry(join(d, 'h', 'memory.jsonl'), join(d, 'h', 'memory.jsonl'))).toBe(true);
  });
  it('the home spelled through a linked parent directory is the same entry', () => {
    const d = tree(); mk(join(d, 'real', 'u', '.helix')); fs.symlinkSync(join(d, 'real'), join(d, 'pl'));
    expect(isGlobalLedgerEntry(join(d, 'real', 'u', '.helix', 'memory.jsonl'), join(d, 'pl', 'u', '.helix', 'memory.jsonl'))).toBe(true);
  });
  it('.helix as a directory link to the home is the same entry (decision 16)', () => {
    const d = tree(); mk(join(d, 'home')); mk(join(d, 'u')); fs.symlinkSync(join(d, 'home'), join(d, 'u', '.helix'));
    expect(isGlobalLedgerEntry(join(d, 'u', '.helix', 'memory.jsonl'), join(d, 'home', 'memory.jsonl'))).toBe(true);
  });
  it('a memory path that is itself a link is not the global entry, even when it leads to the global ledger (D5)', () => {
    const d = tree(); mk(join(d, 'u', '.helix')); mk(join(d, 'home')); fs.writeFileSync(join(d, 'home', 'memory.jsonl'), '');
    fs.symlinkSync(join(d, 'home', 'memory.jsonl'), join(d, 'u', '.helix', 'memory.jsonl'));
    expect(isGlobalLedgerEntry(join(d, 'u', '.helix', 'memory.jsonl'), join(d, 'home', 'memory.jsonl'))).toBe(false);
  });
  it('the global ledger itself a link keeps the layer: the same string is one entry only when its last component is not a link (decision 8, R5)', () => {
    const d = tree(); mk(join(d, 'u', '.helix')); fs.writeFileSync(join(d, 'real.jsonl'), '');
    fs.symlinkSync(join(d, 'real.jsonl'), join(d, 'u', '.helix', 'memory.jsonl'));
    expect(isGlobalLedgerEntry(join(d, 'u', '.helix', 'memory.jsonl'), join(d, 'u', '.helix', 'memory.jsonl'))).toBe(false);
  });
  it('different last names, or different directories, are different entries', () => {
    const d = tree(); mk(join(d, 'a')); mk(join(d, 'b'));
    expect(isGlobalLedgerEntry(join(d, 'a', 'memory.jsonl'), join(d, 'a', 'other.jsonl'))).toBe(false);
    expect(isGlobalLedgerEntry(join(d, 'a', 'memory.jsonl'), join(d, 'b', 'memory.jsonl'))).toBe(false);
  });
  it('two strings whose directories cannot be resolved are different entries, never an exception', () => {
    const d = tree(); const bad = B(d, '/', FF, 'bad'); fs.mkdirSync(bad); fs.symlinkSync(bad, join(d, 'lnk'));
    expect(isGlobalLedgerEntry(join(d, 'lnk', 'memory.jsonl'), join(d, 'other', 'memory.jsonl'))).toBe(false);
  });
  it('a global ledger spelled <d>/dl/../u/.helix/memory.jsonl, dl a directory link, is the entry the kernel reads (<d>/p/u/.helix), not the folded text (ALIAS-DOTDOT)', () => {
    const d = tree(); mk(join(d, 'p', 'q')); fs.symlinkSync(join(d, 'p', 'q'), join(d, 'dl'));
    mk(join(d, 'u', '.helix')); mk(join(d, 'p', 'u', '.helix'));
    const spelled = d + '/dl/../u/.helix/memory.jsonl';   // concatenated: join would fold it, which is the bug
    expect(isGlobalLedgerEntry(join(d, 'u', '.helix', 'memory.jsonl'), spelled)).toBe(false);
    expect(isGlobalLedgerEntry(join(d, 'p', 'u', '.helix', 'memory.jsonl'), spelled)).toBe(true);
  });
});
