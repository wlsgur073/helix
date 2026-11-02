import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, lstatSync, fstatSync, openSync, writeSync, fsyncSync, closeSync, constants } from 'node:fs';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import { withFileLock } from './lock.js';
import { ensureHelixDir } from './home-permissions.js';
import { fsyncDir } from './fs-ops.js';
import { canonicalRoot, resolvePath, fileIdentityAt, sameFile, type FileIdentity } from './path-identity.js';
import { ledgerContentKindOfFd, type LedgerContentKind } from './ledger.js';
import { sampleDirIdentity } from './dir-bound.js';

// Moved to path-identity.ts (design section 7); exported again from here so no caller moves.
export { canonicalRoot };

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

/** A project layer's state, the answer of judgeProjectLayer (design 4.2):
 *
 *  - 'owned' (row 11): adopted, and its memory path passed rows 3 to 10. The only state that participates; an owned
 *    project with no ledger file yet participates too.
 *  - 'aliased' (rows 4, 6, 7, 8): the memory file cannot be resolved, resolves outside the project, leads to another Helix
 *    memory file, or has a second hard link. Adopted or not.
 *  - 'unusable' (rows 3, 5, 9, 9a, 10): the memory file cannot be used as it is. Adopted or not.
 *  - 'ancestor-unadopted' (row 2): a project found in a parent directory that nobody adopted; its files are not inspected.
 *  - 'unadopted-present' (row 12): a working-directory project nobody adopted, with a file at the memory path.
 *  - 'inactive' (rows 1, 13): no project layer, or one nobody adopted with nothing at the memory path.
 *
 *  'aliased', 'unusable', 'ancestor-unadopted' and 'unadopted-present' are disclosure states, each excluded from every read
 *  with its own constant note. An in-memory union that nothing in src/ stores: the trigger sink records 'aliased' and
 *  'unusable' as `unowned` (scripts/trigger-measure.ts). */
export type ProjectDisposition = 'inactive' | 'owned' | 'unadopted-present' | 'aliased' | 'unusable' | 'ancestor-unadopted';

/** The row of design 4.2's table that answered. */
export type JudgementRow = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '9a' | '10' | '11' | '12' | '13';

/** Why a layer is 'aliased' or 'unusable'. */
export type JudgementCause = 'helix-not-directory' | 'unresolvable' | 'uninspectable' | 'outside-root' | 'global-ledger' | 'other-project' | 'home-directory' | 'unjudgeable-target' | 'hard-link' | 'not-regular' | 'unreadable' | 'not-ledger-content' | 'target-directory-missing';

/** One answer of the table. `cause` is set for 'aliased' and 'unusable' only. `destination` is the resolved path of the
 *  memory path, set from row 6 on. `identity` and `dirIdentity` are set on rows 11 to 13 only: the device and inode of
 *  the destination and of the directory that holds it at judgement time, `null` when nothing stands there. */
export interface LayerJudgement { state: ProjectDisposition; row: JudgementRow; cause?: JudgementCause; destination?: string; identity?: FileIdentity | null; dirIdentity?: FileIdentity | null }

/** A project layer as the judgement reads it: the layer, its home, and the global ledger it is compared with. */
export interface JudgedLayer { root: string; ledger: string; home: string; globalLedger: string; origin?: ProjectOrigin }

const under = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`);
/** `path` is `dir` itself or lies below it, compared by path component (row 6). */
function withinDir(dir: string, path: string): boolean { return path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`); }

/** What stands at a RESOLVED destination: its identity (A5's FileIdentity) and what rows 8 and 9 read. */
interface Standing extends FileIdentity { readonly regular: boolean; readonly nlink: bigint }
/** What stands at a RESOLVED path (its last component is not a link): null when nothing does, 'error' otherwise. */
function standingAt(path: string): Standing | null | 'error' {
  try { const st = lstatSync(path, { bigint: true }); return { dev: st.dev, ino: st.ino, regular: st.isFile(), nlink: st.nlink }; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'error'; }
}

/** Row 7's "the same" (decision 15): equal resolved strings, or both exist with one device and inode (A5's sameFile, so an
 *  inode of 0 is never "the same": only the string comparison is left then, decision 9). `named` is false when the resolver
 *  cannot name the target's destination (unresolvable or uninspectable): decision 6 then applies. For such a target the identity half still works through a stat of the path as
 *  given when the kernel can do it. */
function compareWith(dest: { path: string; id: Standing | null }, targetPath: string): { same: boolean; named: boolean } {
  const t = resolvePath(targetPath);
  const named = t.kind === 'resolved';
  if (t.kind === 'resolved' && t.path === dest.path) return { same: true, named };
  if (dest.id === null) return { same: false, named };
  try { return { same: sameFile(dest.id, fileIdentityAt(t.kind === 'resolved' ? t.path : targetPath, { follow: t.kind !== 'resolved' })), named }; }
  catch { return { same: false, named }; }
}

/** Row 9a's answer for one file, remembered per process while the file does not change. The judgement runs on every recall,
 *  commit, inspect and erase; a link target that holds no record line within the bound would otherwise be read each time.
 *  The key is the open file's device and inode; an entry answers only while size, mtime and ctime (nanoseconds, bigint) are what
 *  they were when the content was read. Every write moves ctime, and nothing but the system clock sets it back. Never remembered:
 *  a file with an inode of 0 (no identity to key on, decision 9); a file whose size or times moved while it was read; a file changed within the last two seconds (a later write inside one
 *  timestamp tick would leave size and times as they are, the rule git applies to its index); a time in the future. Residual,
 *  for SECURITY.md (B11): a change made through a shared writable mapping reaches the content before it reaches the times. At
 *  most 64 files are remembered; the map is emptied when it is full. The SessionStart hook and the two CLIs are fresh processes
 *  and never have a remembered answer. */
const CONTENT_KIND_CACHE_MAX = 64;
const CONTENT_KIND_SETTLED_NS = 2_000_000_000n;
const contentKindCache = new Map<string, { size: bigint; mtimeNs: bigint; ctimeNs: bigint; kind: LedgerContentKind }>();

function contentKindOfOpenFile(fd: number, fresh: boolean): LedgerContentKind {
  // A WRITE reads the content and never consults the memory (design 4.2 row 9a: "the write confirms again with the content
  // under the lock"; finding v2-judgement-03: a write that answered from memory appended a row to a file that no longer held
  // ledger rows). Nothing is remembered from such a read either.
  if (fresh) return ledgerContentKindOfFd(fd);
  const before = fstatSync(fd, { bigint: true });
  if (before.ino === 0n) return ledgerContentKindOfFd(fd);
  const key = `${before.dev}:${before.ino}`;
  const hit = contentKindCache.get(key);
  if (hit !== undefined && hit.size === before.size && hit.mtimeNs === before.mtimeNs && hit.ctimeNs === before.ctimeNs) return hit.kind;
  contentKindCache.delete(key);
  const kind = ledgerContentKindOfFd(fd);
  const after = fstatSync(fd, { bigint: true });
  const newest = after.mtimeNs > after.ctimeNs ? after.mtimeNs : after.ctimeNs;
  const unchanged = after.size === before.size && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs;
  if (unchanged && BigInt(Date.now()) * 1_000_000n - newest > CONTENT_KIND_SETTLED_NS) {
    if (contentKindCache.size >= CONTENT_KIND_CACHE_MAX) contentKindCache.clear();
    contentKindCache.set(key, { size: after.size, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs, kind });
  }
  return kind;
}

function openedVerdict(path: string, readContent: boolean, fresh: boolean): 'ok' | 'not-regular' | 'unreadable' | 'not-ledger-content' {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return 'unreadable'; }
  try {
    if (!fstatSync(fd).isFile()) return 'not-regular';          // replaced between the lstat and the open
    if (!readContent) return 'ok';
    try { return contentKindOfOpenFile(fd, fresh) === 'other' ? 'not-ledger-content' : 'ok'; } catch { return 'unreadable'; }
  } finally { closeSync(fd); }
}

/** The "same directory entry" of design 4.2's paragraph on resolveProjectLayer: one last name, directories that are one
 *  directory the kernel's way, and a memory path whose last component is not a link. Both sides stay as given, because
 *  `resolve` folds `dl/..` as text while an append reads it the kernel's way (the ALIAS-DOTDOT class). */
export function isGlobalLedgerEntry(projectLedger: string, globalLedger: string): boolean {
  if (basename(projectLedger) !== basename(globalLedger)) return false;
  if (projectLedger !== globalLedger) {
    const da = resolvePath(dirname(projectLedger)), db = resolvePath(dirname(globalLedger));
    if (da.kind !== 'resolved' || db.kind !== 'resolved' || da.path !== db.path) return false;
  }
  try { return !lstatSync(projectLedger).isSymbolicLink(); }
  catch { return true; }   // nothing there yet, or it cannot be looked at: one entry all the same, and no link is known
}

export function judgeProjectLayer(project: JudgedLayer | undefined, opts: { forAdopt?: boolean; freshContent?: boolean } = {}): LayerJudgement {
  try { return judge(project, opts.forAdopt === true, opts.freshContent === true); }
  catch { return { state: 'unusable', row: '5', cause: 'uninspectable' }; }
}

function judge(project: JudgedLayer | undefined, forAdopt: boolean, freshContent: boolean): LayerJudgement {
  if (!project) return { state: 'inactive', row: '1' };                                             // row 1
  const owned = isOwned(project.root, project.home);
  if (project.origin === 'ancestor' && !owned && !forAdopt) return { state: 'ancestor-unadopted', row: '2' };   // row 2: its files are not inspected
  let helix: ReturnType<typeof lstatSync> | null = null;                                            // row 3: lstat, a dangling link is there
  try { helix = lstatSync(join(project.root, '.helix')); } catch { /* absent or not inspectable: rows 4 and 5 answer */ }
  if (helix !== null && !helix.isDirectory()) return { state: 'unusable', row: '3', cause: 'helix-not-directory' };
  const dest = resolvePath(project.ledger);                                                         // rows 4, 5: the memory path and the root
  const root = resolvePath(resolve(project.root));                                                  // (the root normalised as text, then resolved the kernel's way)
  if (dest.kind === 'unresolvable' || root.kind === 'unresolvable') return { state: 'aliased', row: '4', cause: 'unresolvable' };
  if (dest.kind === 'uninspectable' || root.kind === 'uninspectable') return { state: 'unusable', row: '5', cause: 'uninspectable' };
  const destination = dest.path;
  if (!withinDir(root.path, destination)) return { state: 'aliased', row: '6', cause: 'outside-root', destination };   // row 6 (D1), by path component
  const id = standingAt(destination);
  if (id === 'error') return { state: 'unusable', row: '9', cause: 'unreadable', destination };
  let memoryPathIsLink = false;
  try { memoryPathIsLink = lstatSync(project.ledger).isSymbolicLink(); } catch { /* nothing at the memory path */ }
  const isOwnPath = destination === under(root.path, '.helix/memory.jsonl');
  // Row 7, first comparison: the global ledger. No exception.
  const g = compareWith({ path: destination, id }, project.globalLedger);
  if (g.same) return { state: 'aliased', row: '7', cause: 'global-ledger', destination };
  // The project's own .helix/memory.jsonl is exempt from the three rules below (decision 9) and from the second comparison
  // (T7-1): without that a project inside HELIX_HOME could not write its own file.
  if (!isOwnPath) {
    // Decision 6, second rule: while the global ledger cannot be named, a memory path that is a link cannot be told from it.
    if (!g.named && memoryPathIsLink) return { state: 'aliased', row: '7', cause: 'unjudgeable-target', destination };
    // Decision 7: a destination inside the HELIX_HOME directory. A home that cannot be named has nothing to compare.
    const home = resolvePath(project.home);
    if (home.kind === 'resolved' && withinDir(home.path, destination)) return { state: 'aliased', row: '7', cause: 'home-directory', destination };
    // Second comparison: another registered project's ledger.
    const ownKey = canonicalRoot(project.root);
    for (const key of Object.keys(readRegistry(project.home))) {
      if (key === GLOBAL_KEY || key === ownKey) continue;
      const ledgerOfKey = projectLedgerPath(key);
      const c = compareWith({ path: destination, id }, ledgerOfKey);
      if (c.same) return { state: 'aliased', row: '7', cause: 'other-project', destination };
      if (!c.named) {   // decision 6, first rule: a registered project whose ledger cannot be named answers for everything inside its root
        const r = resolvePath(key);
        if (withinDir(r.kind === 'resolved' ? r.path : key, destination)) return { state: 'aliased', row: '7', cause: 'unjudgeable-target', destination };
      }
    }
  }
  if (id !== null) {
    if (id.regular && id.nlink !== 1n) return { state: 'aliased', row: '8', cause: 'hard-link', destination };   // row 8 (D6), regular files only
    if (!id.regular) return { state: 'unusable', row: '9', cause: 'not-regular', destination };                 // row 9: never opened
    const opened = openedVerdict(destination, memoryPathIsLink, freshContent);                                   // row 9, row 9a (a link only)
    if (opened === 'not-ledger-content') return { state: 'unusable', row: '9a', cause: opened, destination };
    if (opened !== 'ok') return { state: 'unusable', row: '9', cause: opened, destination };
  } else if (memoryPathIsLink && dest.dirMissing) {
    return { state: 'unusable', row: '10', cause: 'target-directory-missing', destination };                     // row 10
  }
  const identity = id === null ? null : { dev: id.dev, ino: id.ino };                                           // rows 11 to 13
  const dirIdentity = sampleDirIdentity(dirname(destination));   // A6's sample; an error other than ENOENT or ENOTDIR reaches the outer catch (row 5)
  if (owned) return { state: 'owned', row: '11', destination, identity, dirIdentity };
  if (id !== null) return { state: 'unadopted-present', row: '12', destination, identity, dirIdentity };
  return { state: 'inactive', row: '13', destination, identity, dirIdentity };
}

/** A project layer's state (ProjectDisposition), the judgement's answer alone: the SAME function MemoryStore's read paths
 *  and the SessionStart hook (which does not go through MemoryStore) ask, so the two surfaces can never disagree. The global
 *  ledger is a required input, because row 7 compares the destination with it. Pure reads, no writes, never throws.
 *
 *  A SNAPSHOT, not a lock: call fresh each time. See MemoryStore.projectDisposition's doc comment for the per-call
 *  self-consistency rationale (B1). */
export function projectDispositionOf(project: JudgedLayer | undefined): ProjectDisposition { return judgeProjectLayer(project).state; }

/** Does the server's startup integrity scan (src/server/index.ts) read this project layer's ledger, and is the file it skipped
 *  not a regular file? The scan reads the file under this project's subkey, so it may read only what is this project's own.
 *
 *  M41 (design 4.2): the scan reads a file only after rows 4 to 10 passed, which leaves 'owned', 'unadopted-present' and
 *  'inactive': an unadopted working-directory project's own file is still scanned. 'aliased', 'unusable' and
 *  'ancestor-unadopted' are never read, adopted or not, exactly as every read path leaves them out. `notRegular` keeps the one
 *  IT-H4 line that src/server/index.ts printed for a FIFO, device or directory, because the scan no longer opens such a file.
 *
 *  A missing `origin` reads as 'cwd', as everywhere else. Pure reads, never throws. */
export function startupScanDecision(project: { root: string; ledger: string; origin?: ProjectOrigin }, home: string, globalLedger: string): { read: boolean; notRegular: boolean } {
  const j = judgeProjectLayer({ root: project.root, ledger: project.ledger, home, globalLedger, origin: project.origin });
  return {
    read: j.state === 'owned' || j.state === 'unadopted-present' || j.state === 'inactive',
    notRegular: j.state === 'unusable' && j.cause === 'not-regular',
  };
}

/** Whether the startup scan reads this layer: startupScanDecision's `read`. */
export function startupScanReadsProject(project: { root: string; ledger: string; origin?: ProjectOrigin }, home: string, globalLedger: string): boolean {
  return startupScanDecision(project, home, globalLedger).read;
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
