import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, lstatSync, readlinkSync, openSync, writeSync, fsyncSync, closeSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import { withFileLock } from './lock.js';
import { ensureHelixDir } from './home-permissions.js';
import { fsyncDir } from './fs-ops.js';

/** The single predicate BOTH enforcement layers use (MemoryStore.adopt, and helix-server.ts's
 *  PROJECT_ROOT_SCHEMA via `z.string().refine(...)`) — one rule, not a zod chain that could drift
 *  from the store's independently, exactly as isValidId/ID_SCHEMA already pair.
 *
 *  WHY ABSOLUTENESS IS THE WHOLE RULE. `adopt` has no approval gate and can carry none: MCP gives a
 *  server no user-presence signal. What stands in for one is that the call NAMES the ledger it is
 *  about to trust, so the client's approval prompt has a target to render (the reasoning is spelled
 *  out in test/memory/adopt-requires-its-target.test.ts). A relative spelling is resolved against
 *  the SERVER's cwd — and the server's cwd is the active project root or, for a session started below
 *  a project, a directory inside it (src/memory/project-root.ts). So `''`, `'.'`, `'./'`,
 *  `'../<name-of-cwd>'` — and `'..'` from a subdirectory — can all resolve back to the active scope
 *  and clear the equality check below, while showing the approving user
 *  nothing: the prompt renders `projectRoot: ""`, and the user can only approve the act, never the
 *  target. Requiring an absolute path is precisely the property that makes the argument mean the
 *  same thing to the caller, to the approval prompt, and to this process.
 *
 *  REJECTS rather than resolving: silently expanding `''` to cwd would hand back a root the caller
 *  never named, which is the failure this is here to prevent. A caller that genuinely means the
 *  active project already knows its absolute path — the server is running in it. */
export function isReviewableRoot(projectRoot: string): boolean {
  return isAbsolute(projectRoot);
}

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

/** The in-repo project ledger path for a project root. */
export function projectLedgerPath(projectRoot: string): string {
  return join(projectRoot, '.helix', 'memory.jsonl');
}

interface RegistryEntry { stamp: string; adoptedAt: string; macNonce: string; trustState?: TrustState }

/** C1.4-③: a scope's trust disposition. `active` (default; absent field reads as active, so every
 *  pre-existing registry entry is active) grants the nonce-derived subkey full signing/verifying
 *  trust. `pending` is entered by an AMBIGUOUS re-adoption — a registered path whose `.owner` stamp
 *  is missing or mismatched, indistinguishable from a lost-`.owner` repair vs a path reused for new
 *  content. Pending PRESERVES the nonce (a repair must stay possible) but the read path clamps the
 *  scope's elevated grades to Fresh, so old Verified rows cannot launder into reused-path content
 *  before a human resolves the scope (repair → active, or fresh → rotate the nonce). */
export type TrustState = 'active' | 'pending';
type Registry = Record<string, RegistryEntry>;

/** Reserved registry key for the global ledger's project-binding nonce. */
const GLOBAL_KEY = '@global';

function registryPath(home: string): string { return join(home, 'projects.json'); }
function ownerFile(projectRoot: string): string { return join(projectRoot, '.helix', '.owner'); }

/** Load the registry, DISTINGUISHING absent (never created — safe to mint into) from corrupt
 *  (present but unparseable — must NOT be silently overwritten, or a torn concurrent write would
 *  cost every prior adoption's nonce). Read-only callers collapse both non-ok cases to {}. */
type RegistryRead = { kind: 'ok'; reg: Registry } | { kind: 'absent' } | { kind: 'corrupt' };

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
/** Runtime shape gate: a registry MUST be a plain object whose every entry has string stamp/
 *  adoptedAt/macNonce. Valid JSON is not enough — an array accepts `reg['@global']=…` and then
 *  serializes back to `[]`, dropping the nonce (so every read re-mints a different one); `null`/a
 *  primitive makes lock-free readers throw. Anything off-shape is treated as corrupt (fail closed). */
function isValidRegistry(x: unknown): x is Registry {
  if (!isPlainObject(x)) return false;
  for (const v of Object.values(x)) {
    if (!isPlainObject(v)) return false;
    if (typeof v.stamp !== 'string' || typeof v.adoptedAt !== 'string' || typeof v.macNonce !== 'string') return false;
    // trustState is OPTIONAL (absent = active, so pre-C1.4-③ registries validate unchanged), but when
    // PRESENT it must be a known value — an off-value would otherwise read as active and silently
    // re-grant trust a pending scope withheld.
    if (v.trustState !== undefined && v.trustState !== 'active' && v.trustState !== 'pending') return false;
  }
  return true;
}

function loadRegistry(home: string): RegistryRead {
  const path = registryPath(home);
  let st;
  // Only a genuinely MISSING file (ENOENT) is "first use" and safe to mint into. Any other lstat
  // failure means the registry is PRESENT but unreadable — minting over it would overwrite live
  // nonces and drive compaction to delete genuine verifies, so fail closed.
  try { st = lstatSync(path); }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'corrupt' }; }
  if (st.isSymbolicLink()) return { kind: 'corrupt' }; // never FOLLOW a symlinked registry (lock-split)
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch { return { kind: 'corrupt' }; } // present but unreadable (EISDIR / EACCES / I/O error)
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return { kind: 'corrupt' }; } // present but not JSON
  if (!isValidRegistry(parsed)) return { kind: 'corrupt' }; // valid JSON, wrong shape
  return { kind: 'ok', reg: parsed };
}

function readRegistry(home: string): Registry {
  const r = loadRegistry(home);
  return r.kind === 'ok' ? r.reg : {}; // read-only callers fail-closed to empty (not owned / null nonce)
}

function assertNotSymlink(path: string, what: string): void {
  let st;
  try { st = lstatSync(path); } catch { return; } // absent/unreadable -> nothing to reject here
  if (st.isSymbolicLink()) throw new Error(`refusing to write through a symlinked ${what}: ${path}`);
}

/** writeSync may write FEWER bytes than requested (a short write, e.g. at ENOSPC or on a signal).
 *  Loop until every byte lands, or the truncated tmp would be renamed over the live registry. */
function writeAll(fd: number, data: string): void {
  const buf = Buffer.from(data, 'utf8');
  for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off);
}

/** Atomic, crash-durable, symlink-safe write: create a fresh tmp with owner-only mode (never briefly
 *  world-readable), write it in FULL, fsync it, rename over the destination — which REPLACES a symlink
 *  at the name rather than following it, so a hostile `.owner -> arbitrary-file` symlink cannot
 *  redirect a write — then fsync the directory so the rename survives power loss. Lock-free readers
 *  therefore see EITHER the old file OR the new one, never a torn or partial write. */
function atomicWriteFile(path: string, data: string, mode: number): void {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', mode);
  try { writeAll(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, path); }
  catch (e) { try { unlinkSync(tmp); } catch { /* orphan tmp — harmless */ } throw e; }
  // D-55: a swallowed directory fsync hid EIO and ENOSPC behind a reported success. fsyncDir keeps
  // the platform tolerance (win32 and unsupported return silently) and propagates everything else,
  // so a caller learns that the rename it just made may not survive a power loss.
  fsyncDir(dirname(path));
}

function atomicWriteRegistry(home: string, reg: Registry): void {
  const path = registryPath(home);
  assertNotSymlink(path, 'registry'); // a symlinked registry would split the file lock across processes
  atomicWriteFile(path, JSON.stringify(reg, null, 2), 0o600);
}

function atomicWriteOwner(projectRoot: string, stamp: string): void {
  atomicWriteFile(ownerFile(projectRoot), stamp, 0o600);
}

/** The repo-side half of the ownership pair. lstat FIRST, never a bare read: `readFileSync` resolves
 *  a final-component symlink, so a `.owner -> anywhere` link let the ownership DECISION be satisfied
 *  by bytes living outside the repo — and a project judged owned that way is read, injected into
 *  session context and written to, with the unadopted-present disclosure suppressed.
 *
 *  This is the READ-side counterpart of a defense the write path already had: `assertNotSymlink`
 *  refuses to write THROUGH a symlinked `.owner`, and `stampOwnership` replaces the link with a real
 *  file, but nothing stopped `isOwned` from following one. `trust-store-layout.ts`'s `looksLikeOurs`
 *  states the same rule for the same reason — lstat throughout, so a symlink standing in for the
 *  file is rejected outright rather than followed.
 *
 *  Not a clone-forge on its own: the target's bytes must still equal the home-side registry stamp,
 *  which a foreign checkout cannot read. Defense in depth, applied where the project already applies
 *  it everywhere else. */
function readOwner(projectRoot: string): string | null {
  const path = ownerFile(projectRoot);
  try {
    // The PARENT first. A `.helix -> elsewhere` symlink redirects the whole store out of the repo,
    // and `stampOwnership` already refuses to write through exactly that shape — so it can never
    // have been adopted legitimately, and refusing it here strands no working layout (pinned by the
    // sibling case in ownership.test.ts). What it does close is the swap AFTER adoption: nothing
    // re-checked the parent, so an owned project could have its store relocated behind a link, and
    // then reads served out-of-repo bytes with no disclosure while commits wrote the user's memory
    // into that directory — invisible to `git status`, which sees only the link.
    if (lstatSync(dirname(path)).isSymbolicLink()) return null;
    const st = lstatSync(path);
    if (!st.isFile()) return null;                // symlink, directory, socket -> not our stamp
    // A hard link is a real file to lstat, so the rule above cannot see it — but a second name means
    // some other path keeps live, in-place write control over the bytes that decide ownership, which
    // is the property the symlink rule exists to deny, reached by a different spelling. Our own
    // writer renames a fresh inode into place, so a legitimate stamp always has exactly one link.
    if (st.nlink > 1) return null;
    return readFileSync(path, 'utf8').trim();
  } catch { return null; }                        // absent or unreadable -> not owned
}

/** Owned iff the home registry has an entry for this absolute path whose stamp equals the
 *  repo-side .owner file. The registry lives in the user's home, so a cloned repo cannot forge it. */
export function isOwned(projectRoot: string, home: string): boolean {
  const entry = readRegistry(home)[canonicalRoot(projectRoot)];
  if (!entry) return false;
  const stamp = readOwner(projectRoot);
  return stamp !== null && stamp === entry.stamp;
}

/** Where a configured project layer was found (src/memory/project-root.ts): the session's own working
 *  directory, or a parent of it. Only the ownership gate reads it — a parent's folder is never claimed
 *  automatically, so an unowned one discloses itself instead of staying silent. */
export type ProjectOrigin = 'cwd' | 'ancestor';

/** A project layer's read-side participation state (B1/B2). 'unadopted-present' is a disclosure
 *  trigger: a foreign, un-owned ledger file sits where Helix would read one, and is excluded from
 *  every read surface. 'aliased' (item 7) is the second disclosure trigger: an OWNED project whose
 *  ledger leads to another adopted project's ledger file, excluded from every read surface the same
 *  way, with its own constant note. */
export type ProjectDisposition = 'inactive' | 'owned' | 'unadopted-present' | 'aliased' | 'ancestor-unadopted';

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

/** ALIAS-P2P (item 7): does this project's ledger lead to ANOTHER adopted project's ledger file?
 *  The global rule (scope-target.ts aliasesGlobalLedger) compares a project ledger with the global
 *  ledger only, so project A's `memory.jsonl` symlinked to project B's file was witnessed under two
 *  scope keys against one inode. Hard links are refused at the write layer by link count and are not
 *  this rule's business. BOTH sides are read the kernel's way (ledgerDestination: the symlink chain
 *  followed by hand, bounded, and a `..` after a symlinked directory applied to that directory's
 *  physical target): this project's side is where the append lands, and each registered project's
 *  ledger is compared at where ITS append lands (second fix batch D4 — the comparison side used to be
 *  canonicalRoot, which collapses that `..` as text and returns a dangling link's own location, so two
 *  projects linked to one not-yet-created third file, or a project whose own ledger reached a third
 *  file through `dl/..`, both read `owned` and both wrote the file). The project whose ledger path IS
 *  the real file is never aliased by this rule — the linking side is, and both sides are when both
 *  lead to a third file.
 *
 *  UNRESOLVABLE counts as aliased (second fix batch D4): a ledger whose destination cannot be computed
 *  the kernel's way (ledgerDestination null) is excluded exactly like one leading to another project's
 *  file — reads leave it out, writes are refused. A registered project whose OWN ledger is
 *  unresolvable is excluded from its own judgement, so it is skipped as a comparison side. Pure reads,
 *  never throws: the walk falls back on every error, and the registry comes through readRegistry
 *  (absent/corrupt → no other roots). */
export function aliasesAdoptedLedger(project: { root: string; home: string; ledger: string }): boolean {
  const real = ledgerDestination(project.ledger);
  if (real === null) return true;
  const ownKey = canonicalRoot(project.root);
  if (real === projectLedgerPath(ownKey)) return false;
  for (const key of Object.keys(readRegistry(project.home))) {
    if (key === GLOBAL_KEY || key === ownKey) continue;
    const other = ledgerDestination(projectLedgerPath(key));
    if (other !== null && other === real) return true;
  }
  return false;
}

/** Shared, side-effect-free four-state snapshot of a project layer's disposition — the SAME predicate
 *  MemoryStore (read paths) and the SessionStart hook (which does not go through MemoryStore) both
 *  route through, so the two surfaces can never disagree about what 'unadopted-present' or 'aliased'
 *  means. Pure: isOwned's registry+.owner reads, then existsSync, and — for an owned project —
 *  aliasesAdoptedLedger's own registry read and the symlink chain, followed by hand (bounded); no
 *  writes, never throws (isOwned and aliasesAdoptedLedger already swallow their own read errors;
 *  existsSync never throws).
 *
 *  - 'owned': isOwned(project.root, project.home) — true regardless of whether the ledger FILE exists
 *    yet (an owned project with no ledger file still participates).
 *  - 'aliased' (item 7): owned, but its ledger leads to another adopted project's ledger file
 *    (aliasesAdoptedLedger). Excluded from every read like 'unadopted-present', with its own constant
 *    note; writes are refused in store.ts.
 *  - 'ancestor-unadopted' (issue #1): a project found in a PARENT directory (origin 'ancestor') that is
 *    not owned — excluded from every read with its own constant note, and never claimed
 *    automatically; commits there are refused in store.ts.
 *  - 'unadopted-present': a descriptor is given, NOT owned, and a ledger file exists at project.ledger
 *    — the exact condition MemoryStore's targetLedger() throws the adopt-hint error on for commit.
 *  - 'inactive': no descriptor (no project layer configured), OR configured but neither owned nor a
 *    ledger file present — nothing to read, nothing to disclose.
 *
 *  A SNAPSHOT, not a lock: call fresh each time — see MemoryStore.projectDisposition's doc-comment for
 *  the full per-call self-consistency rationale (B1). */
export function projectDispositionOf(
  project: { root: string; home: string; ledger: string; origin?: ProjectOrigin } | undefined,
): ProjectDisposition {
  if (!project) return 'inactive';
  if (isOwned(project.root, project.home)) return aliasesAdoptedLedger(project) ? 'aliased' : 'owned';
  if (project.origin === 'ancestor') return 'ancestor-unadopted';
  return existsSync(project.ledger) ? 'unadopted-present' : 'inactive';
}

/** Does the server's startup integrity scan (src/server/index.ts) read this project layer's ledger?
 *  The scan reads the file under this project's subkey, so it may read only what is this project's own:
 *
 *  - 'owned': yes.
 *  - 'aliased' (owned, but the ledger leads to another adopted project's file or cannot be resolved the
 *    kernel's way): no, exactly as every read path leaves it out (IT-M15, second fix batch §4.3 item 3).
 *  - 'ancestor-unadopted': no — nothing of an unadopted parent project is read.
 *  - an UNADOPTED working-directory project ('unadopted-present' or 'inactive'): yes, its own foreign
 *    file is scanned as before, UNLESS its ledger leads — kernel-resolved, ledgerDestination — to
 *    another registered project's ledger, or cannot be resolved (ruling R9). aliasesAdoptedLedger is
 *    that predicate: it never needed ownership, and an unadopted project has no registry entry of its
 *    own to skip. Before R9 the scan read the other project's file there and printed it under this
 *    project's ledger path (measured: `unverifiable verify record(s) in <U's ledger>` for B's rows).
 *
 *  A missing `origin` reads as 'cwd', as everywhere else. Pure reads, never throws. */
export function startupScanReadsProject(project: { root: string; ledger: string; origin?: ProjectOrigin }, home: string): boolean {
  const d = projectDispositionOf({ root: project.root, ledger: project.ledger, home, origin: project.origin });
  if (d === 'owned') return true;
  if (d === 'aliased' || d === 'ancestor-unadopted') return false;
  return !aliasesAdoptedLedger({ root: project.root, home, ledger: project.ledger });
}

/** Stamp a project as owned: write the repo-side .owner and the home-side registry entry. */
export function stampOwnership(
  projectRoot: string,
  home: string,
  opts: { now?: () => string; genStamp?: () => string; autoAdoptLedger?: string } = {},
): void {
  const gen = opts.genStamp ?? (() => randomBytes(16).toString('hex'));
  const key = canonicalRoot(projectRoot);
  ensureHelixDir(home); // the registry lock file needs `home` to exist first
  // Serialize every registry writer across concurrent sessions and publish atomically. Both the
  // .owner and the registry entry are written INSIDE the one lock, so they cannot mismatch and a
  // concurrent adopt cannot drop this (or its own) entry via a read-modify-write race.
  withFileLock(registryPath(home), () => {
    const loaded = loadRegistry(home);
    // Fail closed on a present-but-corrupt registry: writing a fresh {this-project-only} map would
    // silently drop every other project's adoption (and its macNonce). Surface it instead.
    if (loaded.kind === 'corrupt')
      throw new Error(`stampOwnership: registry at ${registryPath(home)} is present but unparseable — restore it before adopting (refusing to overwrite and lose other projects)`);
    const reg = loaded.kind === 'ok' ? loaded.reg : {};
    const existing = reg[key];
    // Auto-adopt TOCTOU guard: targetLedger only auto-adopts when NO ledger exists yet. Re-check that
    // under the registry lock (as close to the write as possible) so a foreign ledger that appeared in
    // the caller's check-then-stamp window is refused, not silently adopted past the explicit barrier.
    // Deliberately NOT gated on `!existing`: a registry entry surviving is not proof this ledger is
    // ours — a lost/overwritten .owner leaves isOwned() false while the entry lingers (the REPAIR
    // path), and gating here let a foreign ledger that raced into that window be silently adopted.
    if (opts.autoAdoptLedger && existsSync(opts.autoAdoptLedger))
      throw new Error('commit: a project memory file appeared here that Helix did not create — adopt it explicitly (helix_memory_adopt) or remove it');
    // Reused-path safety (F6, revised; C1.4-③ closes the conferral half). Earlier this REFUSED when
    // the current .owner did not match the entry — but that bricked a legitimate lost-.owner repair
    // with no recovery ceremony. Deletion safety lives at the compaction chokepoint (a wrong/foreign
    // key deletes no genuine verify) and the read-path clamp (foreign records stay Fresh). Preserving
    // the nonce on a mismatch is safe for DELETION, but it is NOT trust-neutral on its own — an old
    // Verified row copied back into a reused path would re-elevate under the preserved nonce (measured
    // reused-path trust-laundering). That CONFERRAL is what the ambiguity gate below closes: a
    // mismatched re-adoption enters `trust-pending`, so the scope's grades clamp to Fresh until a
    // human resolves it (repair restores the nonce; fresh rotates it). The earlier "launders nothing"
    // claim here was inaccurate and is retracted.
    // Idempotent re-adoption (PR-1): a still-registered project PRESERVES its stamp and macNonce. Minting
    // a fresh macNonce would silently invalidate — and, on the next compaction, DELETE +
    // false-integrity-mark — every verify signed under the old subkey. A first adoption (no prior
    // entry) mints fresh.
    // C1.4-③ ambiguity gate. An existing registry entry whose current `.owner` no longer matches
    // (lost or overwritten) is an AMBIGUOUS re-adoption — a lost-`.owner` repair and a path reused
    // for new content are indistinguishable here. Enter `trust-pending`: preserve the nonce (repair
    // must stay possible), but the read path will clamp this scope's elevated grades to Fresh so old
    // Verified rows cannot launder into reused-path content until a human resolves it. Read the
    // CURRENT `.owner` BEFORE atomicWriteOwner below overwrites it. A first adoption (no entry) and
    // an idempotent re-adoption whose `.owner` still matches stay active.
    const priorOwner = readOwner(projectRoot);
    const ambiguousReadopt = existing !== undefined && priorOwner !== existing.stamp;
    const trustState: TrustState = ambiguousReadopt ? 'pending' : (existing?.trustState ?? 'active');
    const stamp = existing?.stamp ?? gen();
    // Second draw: a home-only per-project salt for the ledger MAC subkey. Bound to the
    // resolved project path in the home registry, NEVER written to the repo .owner file, so a
    // record signed for one project cannot be transplanted into another (HKDF salt differs).
    const macNonce = existing?.macNonce ?? gen();
    const adoptedAt = existing?.adoptedAt ?? (opts.now ?? (() => new Date().toISOString()))();
    const helixDir = join(projectRoot, '.helix');
    assertNotSymlink(helixDir, '.helix directory'); // a symlinked .helix parent would redirect the .owner (and ledger) write out of the repo
    mkdirSync(helixDir, { recursive: true });
    // ORDER IS LOAD-BEARING (2026-09-20). The registry lands FIRST, because `.owner` is the evidence
    // of an ambiguous re-adoption: writing it first overwrites the mismatch with the registry's own
    // stamp, so a failure between the two writes leaves `pending` unrecorded AND the evidence gone,
    // and the retry sees a matching stamp and reads `active` forever — the reused-path laundering
    // C1.4-③ exists to stop. With the registry first, a failure leaves `.owner` still disagreeing,
    // so the retry classifies the scope ambiguous and clamps it to `pending` for a human to resolve.
    // Cost, accepted: an interrupted FIRST adoption also lands pending rather than unowned.
    reg[key] = { stamp, adoptedAt, macNonce, trustState };
    atomicWriteRegistry(home, reg);
    atomicWriteOwner(projectRoot, stamp); // rename-based: never follows a symlinked .owner
  });
}

/** C1.4-③ human resolution of a `trust-pending` scope. This is the DESTRUCTIVE-capable ceremony,
 *  so it belongs behind a TTY confirmation (see scripts/trust-resolve-cli.ts), NEVER on the
 *  agent-callable MCP surface — an agent must not be able to choose conferral vs destruction.
 *  - 'repair': the same project; the `.owner` was just lost. Return to `active` with the nonce and
 *    stamp UNCHANGED, so the read path re-derives the subkey and the prior verifies re-elevate. Fully
 *    reversible — nothing was deleted while pending.
 *  - 'fresh': the path was reused for new content. Return to `active` but ROTATE the macNonce, so the
 *    old verifies fail under the new subkey and stay Fresh (measured non-destructive on read AND at
 *    compaction: planCompaction's keyProven gate cannot prove the old lineage under the new key, so
 *    nothing is deleted and no integrity marker is minted). A fresh stamp is minted too.
 *  Refuses a scope that is not pending — there is nothing to resolve, and silently rotating an active
 *  scope's nonce would be a destructive no-op-that-wasn't. */
export function resolveTrust(
  projectRoot: string,
  home: string,
  resolution: 'repair' | 'fresh',
  opts: { genStamp?: () => string } = {},
): void {
  const gen = opts.genStamp ?? (() => randomBytes(16).toString('hex'));
  const key = canonicalRoot(projectRoot);
  ensureHelixDir(home);
  withFileLock(registryPath(home), () => {
    const loaded = loadRegistry(home);
    if (loaded.kind === 'corrupt')
      throw new Error(`resolveTrust: registry at ${registryPath(home)} is present but unparseable — restore it before resolving`);
    const reg = loaded.kind === 'ok' ? loaded.reg : {};
    const existing = reg[key];
    if (!existing || (existing.trustState ?? 'active') !== 'pending')
      throw new Error(`resolveTrust: ${key} is not trust-pending — nothing to resolve`);
    if (resolution === 'repair') {
      reg[key] = { ...existing, trustState: 'active' };
    } else {
      // fresh: rotate the nonce (retire the old lineage) and re-stamp, then go active.
      const stamp = gen();
      reg[key] = { stamp, adoptedAt: existing.adoptedAt, macNonce: gen(), trustState: 'active' };
      const helixDir = join(projectRoot, '.helix');
      assertNotSymlink(helixDir, '.helix directory');
      mkdirSync(helixDir, { recursive: true });
      atomicWriteOwner(projectRoot, stamp);
    }
    atomicWriteRegistry(home, reg);
  });
}

/** C1.4-③: a scope's trust disposition, read from the home registry. `active` (the default) for an
 *  unregistered project and for any entry without the field — so nothing pre-existing is treated as
 *  pending. `pending` only for an entry an ambiguous re-adoption marked so. Corrupt/absent registry
 *  reads active: this predicate never confers trust on its own (the read-path clamp does), it only
 *  reports whether a resolution is owed, and treating an unreadable registry as pending would strand
 *  every scope behind a ceremony over a transient read fault. */
export function trustStateOf(projectRoot: string, home: string): TrustState {
  const entry = readRegistry(home)[canonicalRoot(projectRoot)];
  return entry?.trustState ?? 'active';
}

/** The project's home-only MAC nonce (project-binding salt for the ledger HMAC subkey).
 *  Returns null for an unowned project. Lives only in the home registry, never in the repo. */
export function scopeNonce(projectRoot: string, home: string): string | null {
  const entry = readRegistry(home)[canonicalRoot(projectRoot)];
  return entry?.macNonce ?? null;
}

/** A stable, home-stored MAC nonce for the global ledger, kept under a reserved registry key.
 *  Minted on first read so the global ledger gets the same project-binding treatment. Returns null
 *  (fail-closed => key-absent => clamp to Fresh) when the registry is present but unparseable: minting
 *  there would OVERWRITE an existing-but-unreadable nonce and, via a wrong subkey, drive compaction to
 *  delete every genuine global verify. Only a genuinely absent registry mints a first nonce. */
export function globalScopeNonce(home: string): string | null {
  const r = loadRegistry(home);
  if (r.kind === 'corrupt') return null; // never overwrite a present-but-unreadable registry
  const fast = r.kind === 'ok' ? (r.reg[GLOBAL_KEY] as { macNonce?: string } | undefined)?.macNonce : undefined;
  if (fast) return fast; // common case: already minted — lock-free read, no contention
  // Mint under the registry lock with a re-check (double-checked): another session may have minted
  // between our read and the lock, and the write must be serialized + atomic like every other. A
  // lock that cannot be taken fails closed (null => key-absent => clamp to Fresh), never a blind mint.
  ensureHelixDir(home); // the lock file needs `home` to exist first
  try {
    return withFileLock(registryPath(home), () => {
      const r2 = loadRegistry(home);
      if (r2.kind === 'corrupt') return null;
      const reg = r2.kind === 'ok' ? r2.reg : {};
      const existing = (reg[GLOBAL_KEY] as { macNonce?: string } | undefined)?.macNonce;
      if (existing) return existing;
      const macNonce = randomBytes(16).toString('hex');
      reg[GLOBAL_KEY] = { stamp: '', adoptedAt: new Date().toISOString(), macNonce };
      atomicWriteRegistry(home, reg);
      return macNonce;
    });
  } catch {
    // D-55 exception, deliberate: also absorbs the directory-fsync errno atomicWriteFile now propagates,
    // so a genuine failure surfaces as null (clamps @global to Fresh) instead of throwing, since a recall
    // must not break on it — the already-landed rename lets the fast path above return the nonce next time.
    return null; // lock unavailable/stuck -> fail closed rather than break a recall with a blind mint
  }
}
