/** Which directory's `.helix/` a session's project layer lives in: the working directory's own, or —
 *  for a session started below a project — the nearest parent's (GitHub issue #1). One rule, shared by
 *  the MCP server (src/server/index.ts) and the SessionStart hook (src/hooks/session-start.ts), so the
 *  two can never disagree about which project a session is in.
 *
 *  The walk only DISCOVERS a parent project. Whether its ledger is read or written is still the
 *  ownership gate's decision (projectDispositionOf, MemoryStore.targetLedger), and a parent directory's
 *  folder is never claimed automatically: a walk that auto-adopted would hand the memory of every
 *  session started below a shared directory (`/tmp`, a Windows drive root) to whoever created a
 *  `.helix/` there — the class of bug git fixed as CVE-2022-24765.
 *
 *  A layer is dropped only for the global ledger's own directory entry (isGlobalLedgerEntry, design 4.2):
 *  every other memory path keeps its layer, and the judgement in ownership.ts decides what it is. */
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { canonicalRoot, isGlobalLedgerEntry, projectLedgerPath, type ProjectOrigin } from './ownership.js';

export type { ProjectOrigin } from './ownership.js';

export interface ProjectLayer { root: string; ledger: string; origin: ProjectOrigin }

/** The same directory, compared the way the platform compares paths (case-insensitively on Windows). */
function samePath(a: string, b: string): boolean {
  return relative(a, b) === '';
}

/** `child` is `parent` itself or lies below it. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** D6: a parent's `.helix` counts only when it is a directory that is empty (a fresh `mkdir .helix`
 *  opt-in) or already holds Helix's own files. A folder of the same name that another tool keeps — the
 *  Helix editor stores `languages.toml` and `config.toml` in `.helix/` — is passed over, and the walk
 *  goes on above it. The working directory's own folder is not held to this: its rule predates the
 *  walk and is unchanged. */
function holdsHelixMemory(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    const names = readdirSync(dir);
    return names.length === 0 || names.includes('memory.jsonl') || names.includes('.owner');
  } catch { return false; }
}

/** Does `dir` hold an entry named `.helix`? By lstat, so a dangling link counts, and a regular file, a
 *  FIFO and a directory count alike: row 3 of the judgement (design 4.2) decides what such an entry is.
 *  Never throws: an lstat error reads as "no entry", which is also how a folder above that cannot be
 *  traversed ends in no layer (decision 8, R15). */
export function hasOwnHelixEntry(dir: string): boolean {
  try { lstatSync(join(dir, '.helix')); return true; } catch { return false; }
}

/** Never throws and never writes: an fs error reads as "no folder here". `userHome` is the operating
 *  system's home directory (os.homedir()), NOT HELIX_HOME — it bounds the walk: a working directory
 *  inside it never looks at the home directory or above, one outside it looks up to the filesystem
 *  root. */
export function resolveProjectLayer(opts: { cwd: string; userHome: string; globalLedger: string }): ProjectLayer | undefined {
  const { cwd, userHome, globalLedger } = opts;
  // The working directory's own folder. No layer only when the memory path is the global ledger's own
  // directory entry (design 4.2): the home spelled through a symlink, `.helix` as a directory link to the
  // home. A memory path that is a LINK to the global ledger keeps its layer, and the judgement excludes it
  // as aliased (D5).
  if (hasOwnHelixEntry(cwd)) {
    const ledger = projectLedgerPath(cwd);
    return isGlobalLedgerEntry(ledger, globalLedger) ? undefined : { root: cwd, ledger, origin: 'cwd' };
  }
  // An empty or relative home (an empty or relative HOME) gives no boundary to trust: resolved against
  // each process's own cwd, it would let the server and the hook walk to different places. No walk.
  if (!isAbsolute(userHome)) return undefined;
  // Physical parents: resolve symlinks first, then climb with dirname, so a `..` after a symlinked
  // directory is never folded as text (the ALIAS-DOTDOT lesson).
  const home = canonicalRoot(userHome);
  let dir = canonicalRoot(cwd);
  const insideHome = within(home, dir);
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return undefined; // past the filesystem root
    if (insideHome && (samePath(home, parent) || !within(home, parent))) return undefined; // never home, never above it
    dir = parent;
    if (holdsHelixMemory(join(dir, '.helix'))) {
      const ledger = projectLedgerPath(dir);
      return isGlobalLedgerEntry(ledger, globalLedger) ? undefined : { root: dir, ledger, origin: 'ancestor' };
    }
  }
}
