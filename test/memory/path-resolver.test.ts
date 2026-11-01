// Third fix batch B1, task A2 (design 4.1 item 1): ONE resolver, three answers, the kernel's way.
import { describe, it, expect, afterAll } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, chmodSync, statSync, existsSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  resolvePath, resolvedPathOrThrow, UnresolvablePathError, isUnresolvablePathError, type PathResolution, type UnresolvableCause,
} from '../../src/memory/path-identity.js';

const d = realpathSync(mkdtempSync(join(tmpdir(), 'helix-resolver-')));
const restores: Array<() => void> = [];
afterAll(() => {
  for (const r of restores) { try { r(); } catch { /* best effort */ } }
  try { execFileSync('rm', ['-rf', '--', d]); } catch { /* best effort: a folder deeper than PATH_MAX needs rm, not rmSync */ }
});

const FF = Buffer.from([0xff]);
const COMP = 'a'.repeat(200);
const B = (...parts: Array<string | Buffer>): Buffer => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : p)));
const w = (p: string | Buffer): void => writeFileSync(p, '');
let n = 0;
interface Fx { sd: string; real: string }
function fresh(): Fx { const sd = join(d, `s${++n}`); mkdirSync(join(sd, 'real'), { recursive: true }); return { sd, real: join(sd, 'real') }; }

type Want =
  | { kind: 'resolved'; path: string; dirMissing?: true }
  | { kind: 'unresolvable'; cause: UnresolvableCause }
  | { kind: 'uninspectable'; code: string };
interface Shape { id: string; build: (f: Fx) => { given: string; want: Want }; skip?: () => boolean }

/** chain(n): real.jsonl plus n links, h1 -> real.jsonl, h2 -> h1, ..., l.jsonl -> h(n-1): n links in all. */
function chain(real: string, links: number): string {
  w(join(real, 'real.jsonl'));
  let prev = 'real.jsonl';
  for (let i = 1; i < links; i++) { symlinkSync(prev, join(real, `h${i}`)); prev = `h${i}`; }
  symlinkSync(prev, join(real, 'l.jsonl'));
  return join(real, 'l.jsonl');
}
/** rd/ holds real.jsonl and l.jsonl -> real.jsonl; d1 -> rd, d2 -> d1, ... dN -> d(N-1). */
function dirChain(real: string, links: number): void {
  mkdirSync(join(real, 'rd')); w(join(real, 'rd', 'real.jsonl')); symlinkSync('real.jsonl', join(real, 'rd', 'l.jsonl'));
  let prev = 'rd';
  for (let i = 1; i <= links; i++) { symlinkSync(prev, join(real, `d${i}`)); prev = `d${i}`; }
}
/** A directory deeper than PATH_MAX, spelled through a short link `pl`; `populate` runs with the deepest folder as the
 *  working directory (names there are relative). Returns the spelling of that folder. */
function inDeepDir(sd: string, populate: () => void): string {
  const here = process.cwd();
  try {
    mkdirSync(join(sd, 'deep')); process.chdir(join(sd, 'deep'));
    let len = Buffer.byteLength(join(sd, 'deep'));
    while (len < 3000) { mkdirSync(COMP); process.chdir(COMP); len += COMP.length + 1; }
    const mid = process.cwd();
    const rel: string[] = []; let extra = 0;
    while (extra < 2000) { mkdirSync(COMP); process.chdir(COMP); rel.push(COMP); extra += COMP.length + 1; }
    populate();
    symlinkSync(mid, join(sd, 'pl'));
    return `${join(sd, 'pl')}/${rel.join('/')}`;
  } finally { process.chdir(here); }
}
const codeThrownBy = (f: () => unknown): string | undefined => { try { f(); } catch (e) { return (e as NodeJS.ErrnoException).code; } return undefined; };
const isRoot = (): boolean => typeof process.getuid === 'function' && process.getuid() === 0;
/** The fixture's precondition for the ENOENT class: stat answers ENOENT for this path (where a trailing `/` on a missing final name is the
 *  refusal, as given or in a link body, the create open answers EISDIR instead). */
const refusedEnoent = (p: string): string => { expect(codeThrownBy(() => statSync(p))).toBe('ENOENT'); return p; };

const SHAPES: Shape[] = [
  // ---- present and resolvable: the answer is the object the kernel reaches
  { id: 'a file', build: ({ real }) => { w(join(real, 'f.jsonl')); return { given: join(real, 'f.jsonl'), want: { kind: 'resolved', path: join(real, 'f.jsonl') } }; } },
  { id: 'a missing final name in an existing folder', build: ({ real }) => ({ given: join(real, 'absent.jsonl'), want: { kind: 'resolved', path: join(real, 'absent.jsonl') } }) },
  { id: 'a link to a file elsewhere', build: ({ sd, real }) => { mkdirSync(join(sd, 'tgt')); w(join(sd, 'tgt', 'real.jsonl')); symlinkSync(join(sd, 'tgt', 'real.jsonl'), join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'resolved', path: join(sd, 'tgt', 'real.jsonl') } }; } },
  { id: 'a folder', build: ({ real }) => { mkdirSync(join(real, 'sub')); return { given: join(real, 'sub'), want: { kind: 'resolved', path: join(real, 'sub') } }; } },
  { id: 'a name with a literal U+FFFD (valid UTF-8)', build: ({ real }) => { w(join(real, 'has�.jsonl')); return { given: join(real, 'has�.jsonl'), want: { kind: 'resolved', path: join(real, 'has�.jsonl') } }; } },
  { id: 'a link to a multi-byte (valid UTF-8) name', build: ({ sd, real }) => { mkdirSync(join(sd, 't')); w(join(sd, 't', '기록😀.jsonl')); symlinkSync(join(sd, 't', '기록😀.jsonl'), join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'resolved', path: join(sd, 't', '기록😀.jsonl') } }; } },
  { id: 'a body that climbs through a directory link (`dl/..` is the kernel\'s, not the textual one)', build: ({ sd, real }) => { mkdirSync(join(sd, 'p', 'q'), { recursive: true }); symlinkSync(join(sd, 'p', 'q'), join(sd, 'dl')); w(join(sd, 'p', 'real.jsonl')); w(join(sd, 'real.jsonl')); symlinkSync(`${sd}/dl/../real.jsonl`, join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'resolved', path: join(sd, 'p', 'real.jsonl') } }; } },
  { id: 'a given path with `dl/..` (kernel reading)', build: ({ sd }) => { mkdirSync(join(sd, 'p', 'q'), { recursive: true }); symlinkSync(join(sd, 'p', 'q'), join(sd, 'dl')); w(join(sd, 'p', 'real.jsonl')); w(join(sd, 'real.jsonl')); return { given: `${sd}/dl/../real.jsonl`, want: { kind: 'resolved', path: join(sd, 'p', 'real.jsonl') } }; } },
  { id: 'a relative body that climbs through a directory link', build: ({ sd }) => { mkdirSync(join(sd, 'p', 'q'), { recursive: true }); symlinkSync(join(sd, 'p', 'q'), join(sd, 'dl')); w(join(sd, 'p', 'real.jsonl')); w(join(sd, 'real.jsonl')); symlinkSync('dl/../real.jsonl', join(sd, 'l.jsonl')); return { given: join(sd, 'l.jsonl'), want: { kind: 'resolved', path: join(sd, 'p', 'real.jsonl') } }; } },
  { id: 'a relative body is read from the link\'s PHYSICAL folder (the link reached through a directory link)', build: ({ sd }) => { mkdirSync(join(sd, 'p', 'q'), { recursive: true }); symlinkSync(join(sd, 'p', 'q'), join(sd, 'dl')); w(join(sd, 'p', 'real.jsonl')); w(join(sd, 'real.jsonl')); symlinkSync('../real.jsonl', join(sd, 'p', 'q', 'l.jsonl')); return { given: join(sd, 'dl', 'l.jsonl'), want: { kind: 'resolved', path: join(sd, 'p', 'real.jsonl') } }; } },
  { id: 'a chain of 40 links', build: ({ real }) => ({ given: chain(real, 40), want: { kind: 'resolved', path: join(real, 'real.jsonl') } }) },
  { id: '39 directory links and a final link', build: ({ real }) => { dirChain(real, 39); return { given: join(real, 'd39', 'l.jsonl'), want: { kind: 'resolved', path: join(real, 'rd', 'real.jsonl') } }; } },
  { id: '40 directory links and a plain file', build: ({ real }) => { dirChain(real, 40); return { given: join(real, 'd40', 'real.jsonl'), want: { kind: 'resolved', path: join(real, 'rd', 'real.jsonl') } }; } },
  { id: '40 directory links and a missing final name', build: ({ real }) => { dirChain(real, 40); return { given: join(real, 'd40', 'absent.jsonl'), want: { kind: 'resolved', path: join(real, 'rd', 'absent.jsonl') } }; } },
  { id: 'a body ending in `/.` that names a folder', build: ({ real }) => { mkdirSync(join(real, 'sub')); symlinkSync('sub/.', join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'resolved', path: join(real, 'sub') } }; } },
  { id: 'a trailing slash on a folder', build: ({ real }) => { mkdirSync(join(real, 'sub')); return { given: `${join(real, 'sub')}/`, want: { kind: 'resolved', path: join(real, 'sub') } }; } },
  { id: 'a link to a folder', build: ({ real }) => { mkdirSync(join(real, 'sub')); symlinkSync('sub', join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'resolved', path: join(real, 'sub') } }; } },
  // ---- row 1 of the table: a dangling link is followed to the path a write creates (M67)
  { id: 'row 1: a dangling relative link, target folder present', build: ({ real }) => { symlinkSync('absent.jsonl', join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'resolved', path: join(real, 'absent.jsonl') } }; } },
  { id: 'row 1: a dangling absolute link, target folder present', build: ({ sd, real }) => { mkdirSync(join(sd, 'tgt')); symlinkSync(join(sd, 'tgt', 'absent.jsonl'), join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'resolved', path: join(sd, 'tgt', 'absent.jsonl') } }; } },
  { id: 'row 1: a chain of two links ending in nothing', build: ({ real }) => { symlinkSync('absent.jsonl', join(real, 'h1')); symlinkSync('h1', join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'resolved', path: join(real, 'absent.jsonl') } }; } },
  // ---- row 6: the folder that would hold the file is missing
  { id: 'row 6: a missing folder', build: ({ sd }) => ({ given: join(sd, 'nodir', 'absent.jsonl'), want: { kind: 'resolved', path: join(sd, 'nodir', 'absent.jsonl'), dirMissing: true } }) },
  { id: 'row 6: two missing folders', build: ({ sd }) => ({ given: join(sd, 'nodir1', 'nodir2', 'absent.jsonl'), want: { kind: 'resolved', path: join(sd, 'nodir1', 'nodir2', 'absent.jsonl'), dirMissing: true } }) },
  { id: 'row 6: a dangling link into a missing folder', build: ({ sd, real }) => { symlinkSync(join(sd, 'nodir', 'absent.jsonl'), join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'resolved', path: join(sd, 'nodir', 'absent.jsonl'), dirMissing: true } }; } },
  { id: 'row 6: a body through a dangling folder link', build: ({ real }) => { symlinkSync('nowhere', join(real, 'ddl')); symlinkSync('ddl/new.jsonl', join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'resolved', path: join(real, 'ddl', 'new.jsonl'), dirMissing: true } }; } },
  // ---- row 2 of the table: unresolvable
  { id: 'row 2: a link body that is not valid UTF-8', build: ({ sd, real }) => { mkdirSync(join(sd, 't')); const t = B(sd, '/t/re', FF, 'l.jsonl'); w(t); symlinkSync(t, join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'unresolvable', cause: 'non-utf8-name' } }; } },
  { id: 'row 2, the exception of the table: a body through a directory link with a non-UTF-8 NAME whose kernel destination is valid UTF-8 is unresolvable too', build: ({ sd, real }) => { mkdirSync(join(sd, 't')); w(join(sd, 't', 'real.jsonl')); symlinkSync(join(sd, 't'), B(real, '/', FF, 'dl')); symlinkSync(B(FF, 'dl/real.jsonl'), join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'unresolvable', cause: 'non-utf8-name' } }; } },
  { id: 'row 2: a dangling link to a name that is not valid UTF-8', build: ({ sd, real }) => { mkdirSync(join(sd, 't')); symlinkSync(B(sd, '/t/absent', FF, '.jsonl'), join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'unresolvable', cause: 'non-utf8-name' } }; } },
  { id: 'row 2: a folder link whose physical name is not valid UTF-8', build: ({ sd }) => { const ffdir = B(sd, '/', FF, 'dir'); mkdirSync(ffdir); symlinkSync(ffdir, join(sd, 'pl')); w(B(ffdir, '/f.jsonl')); return { given: join(sd, 'pl', 'f.jsonl'), want: { kind: 'unresolvable', cause: 'non-utf8-name' } }; } },
  { id: 'row 2: a chain of 41 links', build: ({ real }) => ({ given: chain(real, 41), want: { kind: 'unresolvable', cause: 'too-many-links' } }) },
  { id: 'row 2: a link to itself', build: ({ real }) => { symlinkSync('l.jsonl', join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'unresolvable', cause: 'too-many-links' } }; } },
  { id: 'row 2 / R-2: a link loop in a PARENT is unresolvable, not uninspectable', build: ({ sd }) => { symlinkSync(join(sd, 'lp'), join(sd, 'lp')); return { given: join(sd, 'lp', 'absent.jsonl'), want: { kind: 'unresolvable', cause: 'too-many-links' } }; } },
  { id: 'row 2: 40 directory links and a FINAL link (41 in all; the limit holds over the whole path)', build: ({ real }) => { dirChain(real, 40); return { given: join(real, 'd40', 'l.jsonl'), want: { kind: 'unresolvable', cause: 'too-many-links' } }; } },
  { id: 'row 2: 41 directory links and a plain file', build: ({ real }) => { dirChain(real, 41); return { given: join(real, 'd41', 'real.jsonl'), want: { kind: 'unresolvable', cause: 'too-many-links' } }; } },
  { id: 'row 2: 41 directory links and a missing final name', build: ({ real }) => { dirChain(real, 41); return { given: join(real, 'd41', 'absent.jsonl'), want: { kind: 'unresolvable', cause: 'too-many-links' } }; } },
  // ---- row 3: a folder deeper than the path limit, the file elsewhere
  { id: 'row 3: a link in a folder deeper than PATH_MAX to a target elsewhere (absolute body)', build: ({ sd }) => { mkdirSync(join(sd, 'tgt')); w(join(sd, 'tgt', 'real.jsonl')); const deep = inDeepDir(sd, () => symlinkSync(join(sd, 'tgt', 'real.jsonl'), 'l.jsonl')); return { given: `${deep}/l.jsonl`, want: { kind: 'resolved', path: join(sd, 'tgt', 'real.jsonl') } }; } },
  { id: 'row 3: the same with a relative body is unresolvable (path-too-long)', build: ({ sd }) => { const deep = inDeepDir(sd, () => { w('real.jsonl'); symlinkSync('real.jsonl', 'l.jsonl'); }); return { given: `${deep}/l.jsonl`, want: { kind: 'unresolvable', cause: 'path-too-long' } }; } },
  { id: 'row 3: a plain file in a folder deeper than PATH_MAX is unresolvable', build: ({ sd }) => { const deep = inDeepDir(sd, () => w('f.jsonl')); return { given: `${deep}/f.jsonl`, want: { kind: 'unresolvable', cause: 'path-too-long' } }; } },
  // ---- row 4: the kernel refuses; the answer carries the kernel's own error
  { id: 'row 4 / R-1: a body ending in `/` over a file (kernel ENOTDIR)', build: ({ real }) => { w(join(real, 'real.jsonl')); symlinkSync('real.jsonl/', join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'uninspectable', code: 'ENOTDIR' } }; } },
  { id: 'row 4: a body ending in `/` over nothing (kernel ENOENT)', build: ({ real }) => { symlinkSync('absent.jsonl/', join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'uninspectable', code: 'ENOENT' } }; } },
  { id: 'row 4: a body ending in `/.` over a file (ENOTDIR)', build: ({ real }) => { w(join(real, 'real.jsonl')); symlinkSync('real.jsonl/.', join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'uninspectable', code: 'ENOTDIR' } }; } },
  { id: 'row 4: a body ending in `/.` over nothing (ENOENT)', build: ({ real }) => { symlinkSync('absent.jsonl/.', join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'uninspectable', code: 'ENOENT' } }; } },
  { id: 'row 4: a body that climbs with `..` after a regular file (ENOTDIR, the existing other.jsonl is NOT the answer)', build: ({ real }) => { w(join(real, 'afile')); w(join(real, 'other.jsonl')); symlinkSync('afile/../other.jsonl', join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'uninspectable', code: 'ENOTDIR' } }; } },
  { id: 'row 4: a body that climbs with `..` after a missing folder (ENOENT, the existing t.jsonl is NOT the answer)', build: ({ real }) => { w(join(real, 't.jsonl')); symlinkSync('nodir/../t.jsonl', join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'uninspectable', code: 'ENOENT' } }; } },
  { id: 'row 4: a given path that climbs after a missing folder', build: ({ real }) => { w(join(real, 'f.jsonl')); return { given: `${real}/nodir/../f.jsonl`, want: { kind: 'uninspectable', code: 'ENOENT' } }; } },
  { id: 'row 4: a given path that climbs after a regular file', build: ({ real }) => { w(join(real, 'afile')); w(join(real, 'f.jsonl')); return { given: `${real}/afile/../f.jsonl`, want: { kind: 'uninspectable', code: 'ENOTDIR' } }; } },
  { id: 'row 4: a regular file in the middle of the path', build: ({ real }) => { w(join(real, 'afile')); return { given: join(real, 'afile', 'x.jsonl'), want: { kind: 'uninspectable', code: 'ENOTDIR' } }; } },
  { id: 'row 4: a folder without search permission (EACCES)', skip: isRoot, build: ({ sd }) => { mkdirSync(join(sd, 'np')); chmodSync(join(sd, 'np'), 0o000); restores.push(() => chmodSync(join(sd, 'np'), 0o700)); return { given: join(sd, 'np', 'f.jsonl'), want: { kind: 'uninspectable', code: 'EACCES' } }; } },
  // ---- row 7: a trailing slash
  { id: 'row 7 / R-1: a trailing slash on a MISSING final name is uninspectable ENOENT (the kernel creates no file through it)', build: ({ real }) => ({ given: `${join(real, 'absent.jsonl')}/`, want: { kind: 'uninspectable', code: 'ENOENT' } }) },
  { id: 'row 7: a trailing slash on a dangling link', build: ({ real }) => { symlinkSync('absent.jsonl', join(real, 'l.jsonl')); return { given: `${join(real, 'l.jsonl')}/`, want: { kind: 'uninspectable', code: 'ENOENT' } }; } },
  { id: 'row 7: a trailing slash on a file (ENOTDIR)', build: ({ real }) => { w(join(real, 'f.jsonl')); return { given: `${join(real, 'f.jsonl')}/`, want: { kind: 'uninspectable', code: 'ENOTDIR' } }; } },
  // ---- sid-02 (decision 8): the kernel's refusal comes before an unresolvable condition
  { id: 'sid-02: a trailing slash on a file behind a folder whose physical name is not valid UTF-8 is the kernel\'s ENOTDIR', build: ({ sd }) => { const ffdir = B(sd, '/', FF, 'dir'); mkdirSync(ffdir); symlinkSync(ffdir, join(sd, 'pl')); w(B(ffdir, '/f.jsonl')); return { given: `${join(sd, 'pl', 'f.jsonl')}/`, want: { kind: 'uninspectable', code: 'ENOTDIR' } }; } },
  { id: 'sid-02: a non-UTF-8 body ending in `/` over a file is the kernel\'s ENOTDIR', build: ({ real }) => { const name = B('re', FF, 'l.jsonl'); w(B(real, '/', name)); symlinkSync(B(name, '/'), join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'uninspectable', code: 'ENOTDIR' } }; } },
  // ---- the exception to the kernel-first order is a class (4.1 item 1; section 14, decisions 10 and 12): where the kernel refuses with ENOENT and
  // a name that is not valid UTF-8 or a path past PATH_MAX also holds, the walk's order decides among three answers: unresolvable, uninspectable, or
  // the path with dirMissing when the walk can name the missing folder. No write happens in any of them. A refusal other than ENOENT stays first (sid-02 above).
  { id: 'decision 10: a non-UTF-8 body ending in `/` over nothing is unresolvable, though the kernel answers ENOENT', build: ({ real }) => { symlinkSync(B('absent', FF, '.jsonl/'), join(real, 'l.jsonl')); return { given: join(real, 'l.jsonl'), want: { kind: 'unresolvable', cause: 'non-utf8-name' } }; } },
  { id: 'the ENOENT class: a given path that climbs after a missing folder behind a non-UTF-8 physical folder is unresolvable, though the kernel answers ENOENT', build: ({ sd }) => { const ffdir = B(sd, '/', FF, 'dir'); mkdirSync(ffdir); symlinkSync(ffdir, join(sd, 'pl')); w(B(ffdir, '/f.jsonl')); return { given: refusedEnoent(`${sd}/pl/nodir/../f.jsonl`), want: { kind: 'unresolvable', cause: 'non-utf8-name' } }; } },
  { id: 'the ENOENT class: a link in a non-UTF-8 physical folder with the VALID body `absent.jsonl/` over nothing is unresolvable, though the kernel answers ENOENT', build: ({ sd }) => { const ffdir = B(sd, '/', FF, 'dir'); mkdirSync(ffdir); symlinkSync(ffdir, join(sd, 'pl')); symlinkSync('absent.jsonl/', B(ffdir, '/l.jsonl')); return { given: refusedEnoent(join(sd, 'pl', 'l.jsonl')), want: { kind: 'unresolvable', cause: 'non-utf8-name' } }; } },
  { id: 'the ENOENT class: a link deeper than PATH_MAX with the VALID body `absent.jsonl/` over nothing is unresolvable (path-too-long), though the kernel answers ENOENT', build: ({ sd }) => { const deep = inDeepDir(sd, () => symlinkSync('absent.jsonl/', 'l.jsonl')); return { given: refusedEnoent(`${deep}/l.jsonl`), want: { kind: 'unresolvable', cause: 'path-too-long' } }; } },
  { id: 'the ENOENT class, control: the same link and body with no unresolvable condition is uninspectable ENOENT', build: ({ sd }) => { mkdirSync(join(sd, 'okdir')); symlinkSync(join(sd, 'okdir'), join(sd, 'pl')); symlinkSync('absent.jsonl/', join(sd, 'okdir', 'l.jsonl')); return { given: refusedEnoent(join(sd, 'pl', 'l.jsonl')), want: { kind: 'uninspectable', code: 'ENOENT' } }; } },
  { id: 'the ENOENT class, the walk\'s order: a given path `pl/absent.jsonl/` behind a non-UTF-8 physical folder is uninspectable ENOENT, the directory condition answers before any folder is decoded', build: ({ sd }) => { const ffdir = B(sd, '/', FF, 'dir'); mkdirSync(ffdir); symlinkSync(ffdir, join(sd, 'pl')); return { given: refusedEnoent(`${join(sd, 'pl', 'absent.jsonl')}/`), want: { kind: 'uninspectable', code: 'ENOENT' } }; } },
  { id: 'the ENOENT class, the walk\'s order: a given path deeper than PATH_MAX ending in `absent.jsonl/` is uninspectable ENOENT, the directory condition answers before any folder is resolved', build: ({ sd }) => { const deep = inDeepDir(sd, () => { /* the final name stays missing */ }); return { given: refusedEnoent(`${deep}/absent.jsonl/`), want: { kind: 'uninspectable', code: 'ENOENT' } }; } },
  { id: 'the ENOENT class, the limit: a link in a non-UTF-8 physical folder with an absolute body into a missing folder is the path with dirMissing, the walk can name that folder', build: ({ sd }) => { const ffdir = B(sd, '/', FF, 'dir'); mkdirSync(ffdir); symlinkSync(ffdir, join(sd, 'pl')); symlinkSync(join(sd, 'nodir', 't.jsonl'), B(ffdir, '/l.jsonl')); return { given: refusedEnoent(join(sd, 'pl', 'l.jsonl')), want: { kind: 'resolved', path: join(sd, 'nodir', 't.jsonl'), dirMissing: true } }; } },
  { id: 'the ENOENT class, the limit: a missing folder reached through a non-UTF-8 physical folder is unresolvable, the walk cannot name that folder', build: ({ sd }) => { const ffdir = B(sd, '/', FF, 'dir'); mkdirSync(ffdir); symlinkSync(ffdir, join(sd, 'pl')); return { given: refusedEnoent(join(sd, 'pl', 'nodir', 'absent.jsonl')), want: { kind: 'unresolvable', cause: 'non-utf8-name' } }; } },
];

const answerOf = (r: PathResolution): Want | { kind: string } =>
  r.kind === 'resolved' ? (r.dirMissing ? { kind: 'resolved', path: r.path, dirMissing: true } : { kind: 'resolved', path: r.path })
    : r.kind === 'unresolvable' ? { kind: 'unresolvable', cause: r.cause }
      : { kind: 'uninspectable', code: r.error.code ?? '?' };

describe('resolvePath: the seven rows of design 4.1 and the shapes of 13.4', () => {
  for (const s of SHAPES) {
    (s.skip?.() ? it.skip : it)(s.id, () => {
      const { given, want } = s.build(fresh());
      expect(answerOf(resolvePath(given))).toEqual(want);
    });
  }

  it('a missing folder carries the kernel\'s own ENOENT as dirError', () => {
    const { sd } = fresh();
    const r = resolvePath(join(sd, 'nodir', 'absent.jsonl'));
    expect(r.kind === 'resolved' && r.dirMissing && r.dirError?.code).toBe('ENOENT');
  });

  it('the empty string reads as the working directory', () => {
    expect(resolvePath('')).toEqual({ kind: 'resolved', path: realpathSync('.'), dirMissing: false });
  });

  it('the root, and a relative path read from the working directory', () => {
    expect(resolvePath('/')).toEqual({ kind: 'resolved', path: '/', dirMissing: false });
    const { real } = fresh();
    w(join(real, 'f.jsonl'));
    const here = process.cwd();
    try {
      process.chdir(real);
      expect(resolvePath('f.jsonl')).toEqual({ kind: 'resolved', path: join(real, 'f.jsonl'), dirMissing: false });
      expect(resolvePath('absent.jsonl')).toEqual({ kind: 'resolved', path: join(real, 'absent.jsonl'), dirMissing: false });
    } finally { process.chdir(here); }
  });
});

describe('resolvePath agrees with the kernel (E2 of the prototype sweep: COUNT 1 and COUNT 2 are both 0)', () => {
  // The spellings of every shape: as given, with a trailing slash, with noise (`//` and `/./`).
  const spellings = (p: string): string[] => [p, `${p}/`, `${d}/./${p.slice(d.length + 1).split('/').join('//')}`];
  const kstat = (p: string): { id: string } | { code: string } => {
    try { const s = statSync(p, { bigint: true }); return { id: `${s.dev}:${s.ino}` }; } catch (e) { return { code: (e as NodeJS.ErrnoException).code ?? '?' }; }
  };

  it('never answers a path where the kernel refuses; an answered path is the object the kernel reaches', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const s of SHAPES) {
      if (s.skip?.()) continue;
      const { given } = s.build(fresh());
      for (const p of spellings(given)) {
        const r = resolvePath(p);
        const k = kstat(p);
        checked++;
        const tag = `${s.id} | ${p.slice(d.length)} | ${r.kind}`;
        if (r.kind !== 'resolved') continue;
        if ('code' in k && (k.code === 'ENOTDIR' || k.code === 'ELOOP' || k.code === 'EACCES')) offenders.push(`COUNT 1 (kernel ${k.code}) ${tag}`);
        if (r.dirMissing) { if (!('code' in k) || k.code !== 'ENOENT') offenders.push(`dirMissing but the kernel reaches something ${tag}`); continue; }
        const a = kstat(r.path);
        if ('id' in k) { if (!('id' in a) || a.id !== k.id) offenders.push(`COUNT 2 (not the kernel's object) ${tag}`); continue; }
        // The kernel found nothing at the given path: the answer is the place a write creates, so it must not exist
        // yet, must not be spelled as a folder, and must sit in a folder that exists.
        if ('id' in a) offenders.push(`answer exists but the kernel did not reach it ${tag}`);
        if (/\/(\.{1,2})?$/.test(p)) offenders.push(`answered a path for a spelling that names a folder ${tag}`);
        let parentIsDir = false;
        try { parentIsDir = statSync(dirname(r.path)).isDirectory(); } catch { /* not a folder */ }
        if (!parentIsDir) offenders.push(`creation folder missing ${tag}`);
      }
    }
    expect(checked).toBeGreaterThan(120);
    expect(offenders).toEqual([]);
  });
});

describe('UnresolvablePathError and resolvedPathOrThrow', () => {
  it('an unresolvable path is a typed error with a constant message that names no path', () => {
    const { sd, real } = fresh();
    mkdirSync(join(sd, 't')); const t = B(sd, '/t/re', FF, 'l.jsonl'); w(t); symlinkSync(t, join(real, 'l.jsonl'));
    let caught: unknown;
    try { resolvedPathOrThrow(join(real, 'l.jsonl')); } catch (e) { caught = e; }
    expect(isUnresolvablePathError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(UnresolvablePathError);
    expect((caught as UnresolvablePathError).reason).toBe('non-utf8-name');
    expect((caught as Error).message).not.toContain(sd);
    expect((caught as Error).message).toBe(new UnresolvablePathError('too-many-links').message);   // one constant text for every cause
  });

  it('the predicate reads a property marker, never the class (a second copy of the module would mint a second class)', () => {
    expect(isUnresolvablePathError(Object.assign(new Error('x'), { unresolvablePath: true }))).toBe(true);
    expect(isUnresolvablePathError(new Error('x'))).toBe(false);
    expect(isUnresolvablePathError({ unresolvablePath: true })).toBe(false);
    expect(isUnresolvablePathError(null)).toBe(false);
  });

  it('an uninspectable path throws the original fs error', () => {
    const { real } = fresh();
    w(join(real, 'afile'));
    expect(codeThrownBy(() => resolvedPathOrThrow(join(real, 'afile', 'x.jsonl')))).toBe('ENOTDIR');
  });

  it('a missing folder throws the kernel\'s ENOENT (nothing may be published into it)', () => {
    const { sd } = fresh();
    expect(codeThrownBy(() => resolvedPathOrThrow(join(sd, 'nodir', 'absent.jsonl')))).toBe('ENOENT');
  });

  it('a resolved path is returned, and a dangling link is followed to the path a write creates', () => {
    const { real } = fresh();
    symlinkSync('absent.jsonl', join(real, 'l.jsonl'));
    expect(resolvedPathOrThrow(join(real, 'l.jsonl'))).toBe(join(real, 'absent.jsonl'));
    expect(existsSync(join(real, 'absent.jsonl'))).toBe(false);   // resolving creates nothing
  });
});
