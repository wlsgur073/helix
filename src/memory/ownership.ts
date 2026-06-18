import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The in-repo project ledger path for a project root. */
export function projectLedgerPath(projectRoot: string): string {
  return join(projectRoot, '.helix', 'memory.jsonl');
}

interface RegistryEntry { stamp: string; adoptedAt: string }
type Registry = Record<string, RegistryEntry>;

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
  const stamp = (opts.genStamp ?? (() => randomBytes(16).toString('hex')))();
  const adoptedAt = (opts.now ?? (() => new Date().toISOString()))();
  mkdirSync(join(projectRoot, '.helix'), { recursive: true });
  writeFileSync(ownerFile(projectRoot), stamp);
  const reg = readRegistry(home);
  reg[resolve(projectRoot)] = { stamp, adoptedAt };
  mkdirSync(home, { recursive: true });
  writeFileSync(registryPath(home), JSON.stringify(reg, null, 2));
}
