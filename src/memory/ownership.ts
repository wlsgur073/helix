import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { withFileLock } from './lock.js';

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
function loadRegistry(home: string): RegistryRead {
  let text: string;
  try { text = readFileSync(registryPath(home), 'utf8'); }
  catch { return { kind: 'absent' }; } // ENOENT / unreadable -> treat as first use
  try { return { kind: 'ok', reg: JSON.parse(text) as Registry }; }
  catch { return { kind: 'corrupt' }; } // present but malformed -> caller decides (never clobber)
}

function readRegistry(home: string): Registry {
  const r = loadRegistry(home);
  return r.kind === 'ok' ? r.reg : {}; // read-only callers fail-closed to empty (not owned / null nonce)
}

/** Atomic registry publish (tmp + rename on the same filesystem). Lock-free readers (isOwned,
 *  scopeNonce) therefore see EITHER the old registry OR the new one, never a torn in-place write —
 *  which, unhandled, would corrupt-read and (via globalScopeNonce's mint) overwrite live nonces. */
function atomicWriteRegistry(home: string, reg: Registry): void {
  const path = registryPath(home);
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  try { renameSync(tmp, path); }
  catch (e) { try { unlinkSync(tmp); } catch { /* orphan tmp — harmless */ } throw e; }
}

function readOwner(projectRoot: string): string | null {
  try { return readFileSync(ownerFile(projectRoot), 'utf8').trim(); }
  catch { return null; }
}

/** Owned iff the home registry has an entry for this absolute path whose stamp equals the
 *  repo-side .owner file. The registry lives in the user's home, so a cloned repo cannot forge it. */
export function isOwned(projectRoot: string, home: string): boolean {
  const entry = readRegistry(home)[resolve(projectRoot)];
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
  opts: { now?: () => string; genStamp?: () => string } = {},
): void {
  const gen = opts.genStamp ?? (() => randomBytes(16).toString('hex'));
  const key = resolve(projectRoot);
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
    // Idempotent re-adoption (PR-1): if THIS home already registered this project, PRESERVE its
    // stamp and macNonce. Minting a fresh macNonce here would silently invalidate — and, on the
    // next compaction, DELETE + false-integrity-mark — every verify signed under the old subkey.
    // A first adoption (no prior entry, incl. a FOREIGN ledger) still mints fresh, so pre-existing
    // foreign records never launder into Verified.
    const stamp = existing?.stamp ?? gen();
    // Second draw: a home-only per-project salt for the ledger MAC subkey. Bound to the
    // resolved project path in the home registry, NEVER written to the repo .owner file, so a
    // record signed for one project cannot be transplanted into another (HKDF salt differs).
    const macNonce = existing?.macNonce ?? gen();
    const adoptedAt = existing?.adoptedAt ?? (opts.now ?? (() => new Date().toISOString()))();
    mkdirSync(join(projectRoot, '.helix'), { recursive: true });
    writeFileSync(ownerFile(projectRoot), stamp);
    reg[key] = { stamp, adoptedAt, macNonce };
    atomicWriteRegistry(home, reg);
  });
}

/** The project's home-only MAC nonce (project-binding salt for the ledger HMAC subkey).
 *  Returns null for an unowned project. Lives only in the home registry, never in the repo. */
export function scopeNonce(projectRoot: string, home: string): string | null {
  const entry = readRegistry(home)[resolve(projectRoot)];
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
