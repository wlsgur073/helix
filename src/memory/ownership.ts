import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, lstatSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { withFileLock, canonical } from './lock.js';

/** Canonical (symlink-resolved) project key so two path spellings of ONE physical project — a symlink,
 *  a case alias — map to a SINGLE registry entry and nonce, matching the realpath-based ledger lock.
 *  Falls back to textual resolve only when neither the root nor its parent exists (never throws, so
 *  the disposition snapshot stays pure). On a normal (unsymlinked) path realpath === resolve, so
 *  existing resolve-keyed entries keep their key — no migration. */
export function canonicalRoot(projectRoot: string): string {
  try { return canonical(projectRoot); } catch { return resolve(projectRoot); }
}

/** The in-repo project ledger path for a project root. */
export function projectLedgerPath(projectRoot: string): string {
  return join(projectRoot, '.helix', 'memory.jsonl');
}

interface RegistryEntry { stamp: string; adoptedAt: string; macNonce: string }
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

/** Atomic, crash-durable, symlink-safe write: create a fresh tmp with owner-only mode (never briefly
 *  world-readable), fsync it, rename over the destination — which REPLACES a symlink at the name
 *  rather than following it, so a hostile `.owner -> arbitrary-file` symlink cannot redirect a write —
 *  then fsync the directory so the rename survives power loss. Lock-free readers therefore see EITHER
 *  the old file OR the new one, never a torn write. */
function atomicWriteFile(path: string, data: string, mode: number): void {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', mode);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, path); }
  catch (e) { try { unlinkSync(tmp); } catch { /* orphan tmp — harmless */ } throw e; }
  let dfd: number | undefined;
  try { dfd = openSync(dirname(path), 'r'); fsyncSync(dfd); }
  catch { /* directory fsync is best-effort (not all platforms permit it) */ }
  finally { if (dfd !== undefined) { try { closeSync(dfd); } catch { /* ignore */ } } }
}

function atomicWriteRegistry(home: string, reg: Registry): void {
  const path = registryPath(home);
  assertNotSymlink(path, 'registry'); // a symlinked registry would split the file lock across processes
  atomicWriteFile(path, JSON.stringify(reg, null, 2), 0o600);
}

function atomicWriteOwner(projectRoot: string, stamp: string): void {
  atomicWriteFile(ownerFile(projectRoot), stamp, 0o600);
}

function readOwner(projectRoot: string): string | null {
  try { return readFileSync(ownerFile(projectRoot), 'utf8').trim(); }
  catch { return null; }
}

/** Owned iff the home registry has an entry for this absolute path whose stamp equals the
 *  repo-side .owner file. The registry lives in the user's home, so a cloned repo cannot forge it. */
export function isOwned(projectRoot: string, home: string): boolean {
  const entry = readRegistry(home)[canonicalRoot(projectRoot)];
  if (!entry) return false;
  const stamp = readOwner(projectRoot);
  return stamp !== null && stamp === entry.stamp;
}

/** A project layer's read-side participation state (B1/B2). 'unadopted-present' is the disclosure
 *  trigger: a foreign, un-owned ledger file sits where Helix would read one, and is excluded from
 *  every read surface. */
export type ProjectDisposition = 'inactive' | 'owned' | 'unadopted-present';

/** Shared, side-effect-free tri-state snapshot of a project layer's disposition — the SAME predicate
 *  MemoryStore (read paths) and the SessionStart hook (which does not go through MemoryStore) both
 *  route through, so the two surfaces can never disagree about what 'unadopted-present' means. Pure:
 *  two file reads (isOwned's registry+.owner, then existsSync), no writes, never throws (isOwned
 *  already swallows its own read errors; existsSync never throws).
 *
 *  - 'owned': isOwned(project.root, project.home) — true regardless of whether the ledger FILE exists
 *    yet (an owned project with no ledger file still participates).
 *  - 'unadopted-present': a descriptor is given, NOT owned, and a ledger file exists at project.ledger
 *    — the exact condition MemoryStore's targetLedger() throws the adopt-hint error on for commit.
 *  - 'inactive': no descriptor (no project layer configured), OR configured but neither owned nor a
 *    ledger file present — nothing to read, nothing to disclose.
 *
 *  A SNAPSHOT, not a lock: call fresh each time — see MemoryStore.projectDisposition's doc-comment for
 *  the full per-call self-consistency rationale (B1). */
export function projectDispositionOf(
  project: { root: string; home: string; ledger: string } | undefined,
): ProjectDisposition {
  if (!project) return 'inactive';
  if (isOwned(project.root, project.home)) return 'owned';
  return existsSync(project.ledger) ? 'unadopted-present' : 'inactive';
}

/** Stamp a project as owned: write the repo-side .owner and the home-side registry entry. */
export function stampOwnership(
  projectRoot: string,
  home: string,
  opts: { now?: () => string; genStamp?: () => string; autoAdoptLedger?: string } = {},
): void {
  const gen = opts.genStamp ?? (() => randomBytes(16).toString('hex'));
  const key = canonicalRoot(projectRoot);
  mkdirSync(home, { recursive: true }); // the registry lock file needs `home` to exist first
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
    if (opts.autoAdoptLedger && !existing && existsSync(opts.autoAdoptLedger))
      throw new Error('commit: a project memory file appeared here that Helix did not create — adopt it explicitly (helix_memory_adopt) or remove it');
    // Anti-laundering on a REUSED path (F6): only preserve when the repo's current .owner still
    // matches the registry entry — i.e. it is genuinely the same, still-owned project. If an entry
    // exists but .owner is absent/mismatched, the state is ambiguous (a lost/tampered owner to REPAIR
    // vs a FOREIGN repo now at this path); auto-restoring the old stamp+nonce would let a foreign
    // repo's copied records validate under the preserved subkey, or silently resurrect a stale
    // project. Refuse and make the user resolve it explicitly.
    if (existing && readOwner(projectRoot) !== existing.stamp)
      throw new Error(`stampOwnership: ${key} has a registry entry but its .owner does not match — resolve the ambiguity (a foreign repo at a reused path vs a lost owner) before adopting`);
    // Idempotent re-adoption (PR-1): a still-owned project PRESERVES its stamp and macNonce. Minting
    // a fresh macNonce would silently invalidate — and, on the next compaction, DELETE +
    // false-integrity-mark — every verify signed under the old subkey. A first adoption (no prior
    // entry) mints fresh.
    const stamp = existing?.stamp ?? gen();
    // Second draw: a home-only per-project salt for the ledger MAC subkey. Bound to the
    // resolved project path in the home registry, NEVER written to the repo .owner file, so a
    // record signed for one project cannot be transplanted into another (HKDF salt differs).
    const macNonce = existing?.macNonce ?? gen();
    const adoptedAt = existing?.adoptedAt ?? (opts.now ?? (() => new Date().toISOString()))();
    mkdirSync(join(projectRoot, '.helix'), { recursive: true });
    atomicWriteOwner(projectRoot, stamp); // rename-based: never follows a symlinked .owner
    reg[key] = { stamp, adoptedAt, macNonce };
    atomicWriteRegistry(home, reg);
  });
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
  mkdirSync(home, { recursive: true }); // the lock file needs `home` to exist first
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
    return null; // lock unavailable/stuck -> fail closed rather than break a recall with a blind mint
  }
}
