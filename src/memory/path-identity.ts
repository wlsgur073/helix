/** One path identity for the lock, the append, the rewrite, the read and the alias rules (third fix batch B1,
 *  design 4.1). The resolver arrives in A2; for now this file holds the helpers moved out of ownership.ts.
 *
 *  This module imports node builtins only (design section 3). */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
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
