import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

function readRegistry(home: string): Registry {
  try { return JSON.parse(readFileSync(registryPath(home), 'utf8')) as Registry; }
  catch { return {}; } // missing or malformed -> empty
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

/** Stamp a project as owned: write the repo-side .owner and the home-side registry entry. */
export function stampOwnership(
  projectRoot: string,
  home: string,
  opts: { now?: () => string; genStamp?: () => string } = {},
): void {
  const gen = opts.genStamp ?? (() => randomBytes(16).toString('hex'));
  const stamp = gen();
  // Second draw: a home-only per-project salt for the ledger MAC subkey. Bound to the
  // resolved project path in the home registry, NEVER written to the repo .owner file, so a
  // record signed for one project cannot be transplanted into another (HKDF salt differs).
  const macNonce = gen();
  const adoptedAt = (opts.now ?? (() => new Date().toISOString()))();
  mkdirSync(join(projectRoot, '.helix'), { recursive: true });
  writeFileSync(ownerFile(projectRoot), stamp);
  const reg = readRegistry(home);
  reg[resolve(projectRoot)] = { stamp, adoptedAt, macNonce };
  mkdirSync(home, { recursive: true });
  writeFileSync(registryPath(home), JSON.stringify(reg, null, 2));
}

/** The project's home-only MAC nonce (project-binding salt for the ledger HMAC subkey).
 *  Returns null for an unowned project. Lives only in the home registry, never in the repo. */
export function scopeNonce(projectRoot: string, home: string): string | null {
  const entry = readRegistry(home)[resolve(projectRoot)];
  return entry?.macNonce ?? null;
}

/** A stable, home-stored MAC nonce for the global ledger, kept under a reserved registry key.
 *  Minted on first read so the global ledger gets the same project-binding treatment. */
export function globalScopeNonce(home: string): string {
  const reg = readRegistry(home);
  const existing = (reg[GLOBAL_KEY] as { macNonce?: string } | undefined)?.macNonce;
  if (existing) return existing;
  const macNonce = randomBytes(16).toString('hex');
  reg[GLOBAL_KEY] = { stamp: '', adoptedAt: new Date().toISOString(), macNonce };
  mkdirSync(home, { recursive: true });
  writeFileSync(registryPath(home), JSON.stringify(reg, null, 2));
  return macNonce;
}
