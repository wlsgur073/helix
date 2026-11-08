/** Ruling N1 (third fix batch B2a, design 4.7): the SessionEnd hook writes its record only where Helix may. The destination
 *  is resolved the kernel's way (path-identity.ts resolvePath: a link chain followed, a folder reached through a link
 *  resolved before a `..`) and refused when it is a control file of the home other than sessions.jsonl itself
 *  (home-files.ts homeControlFileOf), the resolved global ledger, or the home's own memory.jsonl whatever HELIX_LEDGER says
 *  (sameDestination for both), or a project's ledger (plan review of 2026-11-08: a resolved destination or a path as given
 *  named memory.jsonl directly inside a folder named .helix, the shape of ownership.ts projectLedgerPath). This function
 *  creates and opens nothing; a missing folder is not an error here (ensureHelixDir makes the last one).
 *
 *  Builtins and the memory modules only, so the hook, which runs its body on import and exports nothing, can ask the question
 *  and a test can ask it too. */
import { basename, dirname, join } from 'node:path';
import { HomeRefusalError, type HelixPaths } from '../memory/home-env.js';
import { homeControlFileOf, sameDestination } from '../memory/home-files.js';
import { resolvePath, UnresolvablePathError, type IdentityProbe } from '../memory/path-identity.js';

/** The message of the typed refusal. Constant: no path, no interpolation (the hook swallows it and prints its own note). */
export const SESSIONS_DESTINATION_REFUSAL_TEXT = 'the sessions file is a file that Helix keeps for another purpose';

/** A project's ledger is `<root>/.helix/memory.jsonl`. The hook has no project scope and reads no registry, so it knows one
 *  by the two last names of a path alone (no file system call). It is asked of the resolved destination (a link elsewhere
 *  that leads to a ledger) and of the path as given (a ledger that is itself a link to a file of another name). */
function isProjectLedgerName(path: string): boolean {
  return basename(path) === 'memory.jsonl' && basename(dirname(path)) === '.helix';
}

export function assertSessionsDestination(paths: HelixPaths, probe?: IdentityProbe): void {
  const dest = resolvePath(paths.sessionsFile);
  if (dest.kind === 'unresolvable') throw new UnresolvablePathError(dest.cause);
  if (dest.kind === 'uninspectable') throw dest.error;
  // `resolved`: with dirMissing the path is where the file would be, which is enough for every comparison below.
  if (homeControlFileOf(paths.home, dest.path, { allow: 'sessions.jsonl' }) !== null) {
    throw new HomeRefusalError('home-control-file', SESSIONS_DESTINATION_REFUSAL_TEXT);
  }
  // A project's ledger (plan review of 2026-11-08, rule M): never a sessions file, adopted or not, whether the resolved
  // destination or the path as given has its two last names.
  if (isProjectLedgerName(dest.path) || isProjectLedgerName(paths.sessionsFile)) {
    throw new HomeRefusalError('home-control-file', SESSIONS_DESTINATION_REFUSAL_TEXT);
  }
  // The global ledger as configured, and <home>/memory.jsonl whatever HELIX_LEDGER says: with a relocated ledger that file is
  // still the owner's ledger of every configuration that does not relocate it, so it is never a sessions file. An unresolvable
  // or uninspectable ledger path names no file the record could land in (and the ledger's own writes are refused).
  for (const ledgerPath of [paths.globalLedger, join(paths.home, 'memory.jsonl')]) {
    const ledger = resolvePath(ledgerPath);
    if (ledger.kind === 'resolved' && sameDestination(dest.path, ledger.path, probe)) {
      throw new HomeRefusalError('home-control-file', SESSIONS_DESTINATION_REFUSAL_TEXT);
    }
  }
}
