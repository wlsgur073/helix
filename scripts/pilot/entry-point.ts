import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when the calling module is the process entry point (`node <thisFile> …`), false when it is
 *  merely imported — the guard that lets one file be both a CLI and a typechecked, unit-testable
 *  module.
 *
 *  Both sides are REALPATH'd, deliberately. `process.argv[1]` is whatever spelling the launcher
 *  used (possibly relative, possibly through a symlink), while Node resolves the main module to its
 *  realpath — so a textual comparison disagrees whenever a symlink is anywhere on the path and the
 *  CLI silently does nothing, exiting 0.
 *
 *  It also replaces a second, subtler coupling: these scripts used to ask
 *  `process.argv[1].endsWith('<name>.ts')`, which tied "am I the entry point?" to a FILE EXTENSION.
 *  That made the CLI unbundlable — compiling it to `.mjs` so tests can run it under plain `node`
 *  (instead of fetching an unpinned `tsx` off the registry on every `npm test`) turned `main()`
 *  into a no-op with a successful exit code. Identity, not spelling, is the question being asked.
 */
export function isEntryPoint(importMetaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl)); }
  catch { return false; }   // a vanished/unresolvable path is not proof of entry — stay a library
}
