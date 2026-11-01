/** One path identity for the lock, the append, the rewrite, the read and the alias rules (third fix batch B1,
 *  design 4.1). This file holds the resolver and the helpers moved out of ownership.ts.
 *
 *  This module imports node builtins only (design section 3). */
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Canonical (symlink-resolved) project key so two path spellings of ONE physical project — a symlink,
 *  a case alias — map to a SINGLE registry entry and nonce, matching the realpath-based ledger lock.
 *  Falls back to textual resolve only when neither the root nor its parent exists (never throws, so
 *  the disposition snapshot stays pure). On a normal (unsymlinked) path realpath === resolve, so
 *  existing resolve-keyed entries keep their key — no migration. */
export function canonicalRoot(projectRoot: string): string {
  try { return registryKeyPath(projectRoot); } catch { return resolve(projectRoot); }
}

/** ALIAS-DOTDOT (second fix batch, D4): the body `lock.ts canonical` had before it moved to
 *  `realpathSync.native` — Node's JS `realpathSync`, which collapses a `..` after a symlinked directory
 *  as text. Preserved for registry keys and witness scope keys ONLY (canonicalRoot, and through it
 *  witness-store scopeKeyOf), so every key an older build wrote is still the key this build looks up.
 *  Path IDENTITY — what a lock guards, what an append opens, what the alias rules compare — is the
 *  kernel's (lock.ts canonical, ledgerDestination below), never this. */
function registryKeyPath(target: string): string {
  try { return realpathSync(target); }
  catch { return join(realpathSync(dirname(target)), basename(target)); }
}

/** Linux's MAXSYMLINKS: the most links one path resolution follows before the kernel answers ELOOP. */
const MAX_SYMLINK_HOPS = 40;

/** A Buffer the kernel handed back, as a string, or null when its bytes are not valid UTF-8. Node's
 *  string-returning fs calls decode with replacement, so a name holding 0xff came back as U+FFFD and
 *  the walk then looked for a path that does not exist (ALIAS-NONUTF8). The round trip is the test: a
 *  name survives it iff the decode was lossless. */
function utf8OrNull(b: Buffer): string | null {
  const s = b.toString('utf8');
  return Buffer.from(s, 'utf8').equals(b) ? s : null;
}

const isNameTooLong = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENAMETOOLONG';

/** The path as the kernel resolves it: `realpathSync.native`, which follows a symlinked directory
 *  BEFORE it applies a `..` that comes after it (`path.resolve` and Node's JS `realpathSync` collapse
 *  `dl/..` as text first). The first catch takes every error but ENAMETOOLONG — ENOENT, ENOTDIR,
 *  EACCES, ELOOP, an invalid argument — and answers with the physical parent plus the name, which is
 *  where a write creates a missing file. When the parent does not resolve either, the last resort is
 *  `resolve(p)`: the textual reading this function exists to avoid, reached only when the kernel
 *  cannot resolve that directory either, so the kernel's write fails there too.
 *
 *  Returns null — UNRESOLVABLE — where the kernel and this function part ways (ALIAS-DOTDOT,
 *  ALIAS-NONUTF8, second fix batch D4): a result whose bytes are not valid UTF-8 (both results are
 *  read as Buffers), and ENAMETOOLONG, which realpath answers for a directory physically deeper than
 *  PATH_MAX while the kernel, resolving one component at a time, does not (measured 2026-09-24).
 *  Never throws. */
function physicalPath(p: string): string | null {
  try { return utf8OrNull(realpathSync.native(p, { encoding: 'buffer' })); }
  catch (e) { if (isNameTooLong(e)) return null; /* absent: the physical parent plus the name */ }
  try {
    const parent = utf8OrNull(realpathSync.native(dirname(p), { encoding: 'buffer' }));
    return parent === null ? null : join(parent, basename(p));
  } catch (e) { return isNameTooLong(e) ? null : resolve(p); }
}

/** Where an append through `ledger` lands: the symlink chain, followed by hand (bounded), then the
 *  endpoint's physicalPath — or null when that cannot be computed the kernel's way (UNRESOLVABLE).
 *  `canonical` returns a DANGLING link's own location, so it cannot answer this for a link — or a
 *  chain of links — into a file that does not exist yet, and following only the first link was not
 *  enough (final review I-1: `A/.helix/memory.jsonl -> A/.helix/hop -> B's absent ledger` read as A's
 *  own file, and the first commit created B's ledger holding A's record). The walk stops at a
 *  non-link, or at a path that does not exist — the path a write would create.
 *
 *  A relative link target is resolved from the link's PHYSICAL directory (`physicalPath(dirname(p))`),
 *  the directory the kernel resolves it from. From the textual `dirname(p)`, a relative target that
 *  climbs (`..`) out of a directory reached through a directory link lands one level off the kernel's
 *  write (measured 2026-09-24: `A/.helix/dl -> A/x/y/z` plus `A/x/y/z/hop ->
 *  ../../../../<B>/.helix/memory.jsonl` read as owned while the append landed in B's file).
 *
 *  The target is joined to that directory as written (an absolute target is taken as written), and
 *  the directory part of the result is resolved with physicalPath, leaving only the final name for
 *  `lstatSync` to classify. realpathSync.native follows each directory link before it applies a `..`
 *  that comes after it, the kernel's way. Collapsed as text instead (`path.resolve`, JS
 *  `realpathSync`), `A/.helix/dl -> A/x` plus a ledger linked to `dl/../../<B>/.helix/memory.jsonl`
 *  read as A's own file (a non-existent `A/<B>/...`) while the append landed in B's ledger (measured
 *  2026-09-24). Handed to `lstatSync` as one string — the physical directory, `/`, the link body, a
 *  string the kernel itself never builds — the hop could outgrow PATH_MAX: a body padded with `./`
 *  made `lstatSync` throw ENAMETOOLONG (measured 2026-09-24, ruling R28).
 *
 *  UNRESOLVABLE (second fix batch D4, ALIAS-DOTDOT / ALIAS-NONUTF8): link bodies are read as Buffers
 *  and must survive a UTF-8 round trip (a body holding 0xff used to decode to U+FFFD, so the walk looked
 *  for a path that does not exist and read the link as this project's own file while the kernel
 *  followed it into another project's); ENAMETOOLONG anywhere on the walk (a hop through a directory
 *  physically deeper than PATH_MAX); and more than MAX_SYMLINK_HOPS links (a loop, or a chain the
 *  kernel itself refuses with ELOOP). Each used to end in a textual fallback that named a file the
 *  kernel does not open. A caller treats null as "cannot be judged": the project layer is excluded
 *  exactly like an aliased one (aliasesAdoptedLedger), and a comparison side that is null is skipped.
 *
 *  Never throws: on any other lstat/readlink error than "does not exist" it falls back to
 *  canonicalRoot(ledger) — the kernel's own answer for that path is an error, so its write fails
 *  too. Each `lstatSync` sees a physical directory plus one name, never a link body. */
export function ledgerDestination(ledger: string): string | null {
  let p = ledger;
  for (let hops = 0; ; hops++) {
    let st;
    try { st = lstatSync(p); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return physicalPath(p);
      return isNameTooLong(e) ? null : canonicalRoot(ledger);
    }
    if (!st.isSymbolicLink()) return physicalPath(p);
    if (hops === MAX_SYMLINK_HOPS) return null;
    let target: string | null;
    try { target = utf8OrNull(readlinkSync(p, { encoding: 'buffer' })); } catch { return canonicalRoot(ledger); }
    if (target === null) return null;
    let q: string;
    if (isAbsolute(target)) q = target;
    else {
      const dir = physicalPath(dirname(p));
      if (dir === null) return null;
      q = `${dir}/${target}`;
    }
    const qDir = physicalPath(dirname(q));
    if (qDir === null) return null;
    p = join(qDir, basename(q));
  }
}

/** Why a path cannot be resolved at all: a name whose bytes are not valid UTF-8 (a link body, or the
 *  kernel's answer for a directory or a file), a path past the system limit, or more links than the
 *  kernel follows in one resolution (a loop included), counted over the WHOLE path. */
export type UnresolvableCause = 'non-utf8-name' | 'path-too-long' | 'too-many-links';

/** The resolver's three answers.
 *  - `resolved`: the path a write through the given path creates or opens, the kernel's way. `dirMissing`
 *    says the folder that would hold the file does not exist (`dirError` is the kernel's own ENOENT for it):
 *    the path is where the file WOULD be, nothing can be opened there, creating the folder is the caller's
 *    decision.
 *  - `unresolvable`: no path can be named, with the cause.
 *  - `uninspectable`: the resolution met another error (EACCES, ENOTDIR, an I/O error, or ENOENT for a
 *    spelling the kernel refuses to create a file through). `error` is that fs error. */
export type PathResolution =
  | { kind: 'resolved'; path: string; dirMissing: boolean; dirError?: NodeJS.ErrnoException }
  | { kind: 'unresolvable'; cause: UnresolvableCause }
  | { kind: 'uninspectable'; error: NodeJS.ErrnoException };

type Failure = Extract<PathResolution, { kind: 'unresolvable' | 'uninspectable' }>;
type DirAnswer = { kind: 'dir'; path: string; missing: NodeJS.ErrnoException | null } | Failure;

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

/** An error met on the walk, as an answer: ENAMETOOLONG and ELOOP are unresolvable (every ELOOP, R-2), the rest
 *  is "cannot be inspected". */
function failureOf(e: unknown): Failure {
  const code = codeOf(e);
  if (code === 'ENAMETOOLONG') return { kind: 'unresolvable', cause: 'path-too-long' };
  if (code === 'ELOOP') return { kind: 'unresolvable', cause: 'too-many-links' };
  return { kind: 'uninspectable', error: e as NodeJS.ErrnoException };
}

/** Does this spelling name a DIRECTORY (a trailing slash, or a last component of `.` or `..`)? The kernel opens
 *  such a path only when a directory stands there and never creates a file through it; `dirname`/`basename`
 *  drop exactly that condition, so it is answered before any split. */
function namesDirectory(p: string): boolean {
  const last = p.slice(p.lastIndexOf('/') + 1);
  return last === '' || last === '.' || last === '..';
}

const under = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`);

/** A directory the kernel's way: `realpathSync.native`, which follows a symlinked directory BEFORE it applies a
 *  `..` that comes after it. Nothing is ever collapsed as text over a component that could not be inspected:
 *  when the directory does not exist, the answer is the deepest part that does resolve plus the names below it
 *  (`missing` carries the kernel's ENOENT), and a `..` among those names is "cannot be inspected". */
function physicalDir(dir: string): DirAnswer {
  let real: Buffer;
  try { real = realpathSync.native(dir, { encoding: 'buffer' }); }
  catch (e) { return codeOf(e) === 'ENOENT' ? missingDir(dir, e as NodeJS.ErrnoException) : failureOf(e); }
  const text = utf8OrNull(real);
  return text === null ? { kind: 'unresolvable', cause: 'non-utf8-name' } : { kind: 'dir', path: text, missing: null };
}

function missingDir(dir: string, error: NodeJS.ErrnoException): DirAnswer {
  const parts = dir.split('/');
  for (let keep = parts.length - 1; keep >= 0; keep--) {
    const head = parts.slice(0, keep).join('/');
    const prefix = head !== '' ? head : (isAbsolute(dir) ? '/' : '.');
    let real: Buffer;
    try { real = realpathSync.native(prefix, { encoding: 'buffer' }); }
    catch (e) { if (codeOf(e) === 'ENOENT') continue; return failureOf(e); }
    const text = utf8OrNull(real);
    if (text === null) return { kind: 'unresolvable', cause: 'non-utf8-name' };
    const rest = parts.slice(keep).filter((c) => c !== '' && c !== '.');
    if (rest.includes('..')) return { kind: 'uninspectable', error };
    return { kind: 'dir', path: rest.length === 0 ? text : under(text, rest.join('/')), missing: rest.length === 0 ? null : error };
  }
  return { kind: 'uninspectable', error };   // not even the root or the working directory resolves
}

/** A spelling that names a directory: the kernel's own verdict first (one resolution of the path as written, so
 *  its error is the answer and not realpath's), then the physical path of the directory that stands there. */
function directoryAnswer(p: string): PathResolution {
  try { statSync(p); } catch (e) { return failureOf(e); }
  return existingAnswer(p);
}

/** Something stands at `p` and is not a link: its physical path. */
function existingAnswer(p: string): PathResolution {
  let real: Buffer;
  try { real = realpathSync.native(p, { encoding: 'buffer' }); } catch (e) { return failureOf(e); }
  const text = utf8OrNull(real);
  return text === null ? { kind: 'unresolvable', cause: 'non-utf8-name' } : { kind: 'resolved', path: text, dirMissing: false };
}

/** Nothing stands at `p`, a plain name in some directory: the path a write would create. */
function creationAnswer(p: string): PathResolution {
  const d = physicalDir(dirname(p));
  if (d.kind !== 'dir') return d;
  const path = under(d.path, basename(p));
  return d.missing === null ? { kind: 'resolved', path, dirMissing: false } : { kind: 'resolved', path, dirMissing: true, dirError: d.missing };
}

/** THE resolver: where a write through `input` lands, the kernel's way. Never throws for a string argument.
 *
 *  The final link chain is followed by hand (bounded by MAX_SYMLINK_HOPS), each hop's directory is resolved with
 *  `realpathSync.native`, link bodies and the kernel's answers are read as Buffers and must survive a UTF-8 round
 *  trip, ENAMETOOLONG anywhere is unresolvable. A relative link body is resolved from the link's PHYSICAL
 *  directory. The first `lstatSync` sees the input as given; each later one sees a physical directory plus one
 *  name, never a link body.
 *
 *  Where the kernel refuses to open the path as given, this answers no path (design 4.1 item 1): a body ending in
 *  `/` or `/.` keeps the directory condition (namesDirectory); a body that crosses a missing directory or a regular
 *  file and then climbs with `..` is uninspectable (physicalDir never collapses it as text); and the link limit
 *  holds for the WHOLE path, so the kernel is asked once about the path as given (`statSync`) before the hand walk
 *  starts and its ELOOP is `too-many-links`. That one `statSync` also carries EACCES/ENOTDIR/EIO from anywhere on
 *  the chain into the third answer. ENOENT is the one error that does not decide there: a dangling chain is followed
 *  by hand to the path a write creates. The kernel's refusal comes first when it and an unresolvable condition both
 *  hold (14: decision 8, sid-02), with one class of exception (4.1 item 1; 14: decisions 10 and 12): where the
 *  kernel refuses with ENOENT and a name that is not valid UTF-8 or a path past PATH_MAX also holds, the resolver
 *  answers no path, and the walk's order decides between unresolvable and uninspectable. A missing folder the walk
 *  can name is not a refusal: the answer is the path with `dirMissing`. */
export function resolvePath(input: string): PathResolution {
  const given = input === '' ? '.' : input;   // the empty string reads as the working directory, as it did
  if (namesDirectory(given)) return directoryAnswer(given);
  let p = given;
  for (let hops = 0; ; hops++) {
    let isLink: boolean;
    try { isLink = lstatSync(p).isSymbolicLink(); }
    catch (e) { return codeOf(e) === 'ENOENT' ? creationAnswer(p) : failureOf(e); }
    if (!isLink) return existingAnswer(p);
    if (hops === 0) {
      try { statSync(p); } catch (e) { if (codeOf(e) !== 'ENOENT') return failureOf(e); }
    }
    if (hops === MAX_SYMLINK_HOPS) return { kind: 'unresolvable', cause: 'too-many-links' };
    let body: string | null;
    try { body = utf8OrNull(readlinkSync(p, { encoding: 'buffer' })); } catch (e) { return failureOf(e); }
    if (body === null) return { kind: 'unresolvable', cause: 'non-utf8-name' };
    let q: string;
    if (isAbsolute(body)) q = body;
    else {
      const from = physicalDir(dirname(p));
      if (from.kind !== 'dir') return from;
      q = `${from.path}/${body}`;
    }
    if (namesDirectory(q)) return directoryAnswer(q);
    const dir = physicalDir(dirname(q));
    if (dir.kind !== 'dir') return dir;
    const next = under(dir.path, basename(q));
    if (dir.missing !== null) return { kind: 'resolved', path: next, dirMissing: true, dirError: dir.missing };
    p = next;
  }
}

/** The one text of an unresolvable path. A constant: no path, no interpolation (design section 3). */
const UNRESOLVABLE_PATH_MESSAGE =
  'the path cannot be resolved (a name that is not valid UTF-8, a path past the system limit, or too many links)';

/** An unresolvable path, as the lock, the append, the rewrite and the read raise it. */
export class UnresolvablePathError extends Error {
  /** The marker isUnresolvablePathError reads (a property, never class identity). */
  readonly unresolvablePath = true;
  constructor(readonly reason: UnresolvableCause) {
    super(UNRESOLVABLE_PATH_MESSAGE);
    this.name = 'UnresolvablePathError';
  }
}

export const isUnresolvablePathError = (e: unknown): boolean =>
  e instanceof Error && (e as { unresolvablePath?: unknown }).unresolvablePath === true;

/** The resolver's answer as a write path, or a throw: unresolvable is UnresolvablePathError, uninspectable is the
 *  original fs error, a missing folder is the kernel's own ENOENT for it (what `canonical` threw there), so nothing
 *  is ever published into a folder that is not there. No rule of its own (R-8: every caller reads resolvePath this way). */
export function resolvedPathOrThrow(path: string): string {
  const r = resolvePath(path);
  if (r.kind === 'unresolvable') throw new UnresolvablePathError(r.cause);
  if (r.kind === 'uninspectable') throw r.error;
  if (r.dirMissing) throw r.dirError ?? Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  return r.path;
}
