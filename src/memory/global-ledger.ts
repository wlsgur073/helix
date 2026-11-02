/** The global ledger's own rules (third fix batch B1, design 4.7; D3; 13.3 decision 12; 14 decision 8 G-R1..G-R9).
 *
 *  The global ledger has no exclusion rule of its own: it is read whatever its path, and only its WRITES depend on the
 *  state of that path. The resolver (path-identity.ts resolvePath) answers resolved, unresolvable or uninspectable:
 *  - resolved (a plain path, a link to another place, HELIX_LEDGER): the store locks and opens the resolved destination;
 *    a plain path whose folder is missing has the folder created, as before.
 *  - unresolvable (D3): global memory is READ-ONLY: every write is refused with one fixed text before a lock is tried and
 *    before the store writes anything to the home; a read opens the path as given and adds a fixed note.
 *  - cannot be inspected: the write and the read fail with that fs error, as before.
 *  One shape that RESOLVES is read-only too (FN-25, the third row): the path reaches a folder through a link and that
 *  folder does not exist. Helix never creates a link's target folder (4.2), so a write could only fail; it is refused
 *  the same way and a read answers an empty result with the same note. Since G-R1 the link may be the final name or any
 *  folder link above the file.
 *
 *  Builtins and path-identity.ts only, so the store, the SessionStart hook, the server's start and the re-baseline CLI
 *  ask the one question the same way. */
import { lstatSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolvePath } from './path-identity.js';

export type GlobalReadOnlyCause = 'unresolvable' | 'target-directory-missing';

export type GlobalLedgerWriteState =
  | { kind: 'writable' }
  | { kind: 'read-only'; cause: GlobalReadOnlyCause };

const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** Is there, above the file, a folder that stands as a link leading nowhere? Walks up from the file's folder. A folder
 *  that does not exist yet is passed (the plain missing-folder case keeps creating it), a link whose target exists is
 *  passed, an error that is not ENOENT decides nothing. The walk is over the path AS GIVEN, each prefix read by the kernel:
 *  `path.resolve` would fold `<dir link>/..` as text and look at another folder than the kernel reaches (the ALIAS-DOTDOT
 *  class). A relative path stops at its first component; the folders above the working directory exist, so no link there
 *  leads nowhere. */
function danglingFolderLinkAbove(path: string): boolean {
  for (let dir = dirname(path); dirname(dir) !== dir; dir = dirname(dir)) {
    let link: boolean;
    try { link = lstatSync(dir).isSymbolicLink(); } catch { continue; }
    if (!link) continue;
    try { statSync(dir); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT'; }
  }
  return false;
}

/** The state of the global ledger's path for a WRITE (design 4.7, the first table). Lock-free and side-effect free: it
 *  creates nothing, opens nothing and never throws for a string argument. "Cannot be inspected" answers `writable`: the
 *  write then fails at the lock with that fs error, as before. */
export function globalLedgerWriteState(path: string): GlobalLedgerWriteState {
  const r = resolvePath(path);
  if (r.kind === 'unresolvable') return { kind: 'read-only', cause: 'unresolvable' };
  if (r.kind === 'resolved' && r.dirMissing && (isLink(path) || danglingFolderLinkAbove(path))) {
    return { kind: 'read-only', cause: 'target-directory-missing' };
  }
  return { kind: 'writable' };
}

export const isGlobalLedgerReadOnly = (path: string): boolean => globalLedgerWriteState(path).kind === 'read-only';

/** The operations that write the global ledger, by the name their refusal starts with. */
export type GlobalWriteOp = 'commit' | 'erase' | 'confirm' | 'recheck' | 'compaction';

const CAUSE =
  "the global memory file's path cannot be resolved (a name that is not valid UTF-8, a path past the system limit, too many links, or a link into a directory that does not exist)";
const TAIL = 'Tell the user that the global memory path needs repair; do not repair it for them.';
const refusal = (op: GlobalWriteOp): string => `${op}: ${CAUSE} — nothing was written. ${TAIL}`;

/** The refusal of a write to a read-only global ledger: the 4.9 row "전역 ledger 쓰기" with `<op>` filled from a fixed
 *  list, plus one sentence that keeps an agent from repairing the path itself (the sentence is this plan's, MINE). No
 *  path, no interpolation. */
export const GLOBAL_WRITE_REFUSAL: Record<GlobalWriteOp, string> = {
  commit: refusal('commit'), erase: refusal('erase'), confirm: refusal('confirm'), recheck: refusal('recheck'), compaction: refusal('compaction'),
};

/** The typed pre-refusal of a write to a read-only global ledger (design 4.7, the audit row; decision 12). Raised before
 *  any lock, any home write and any append, so nothing was stored: the erase handler records it in the existing
 *  pre-write class 'rejected'. Read by property, never by class. */
export class GlobalLedgerReadOnlyError extends Error {
  readonly globalLedgerReadOnly = true as const;
  constructor(readonly op: GlobalWriteOp, readonly readOnlyCause: GlobalReadOnlyCause) {
    super(GLOBAL_WRITE_REFUSAL[op]);
    this.name = 'GlobalLedgerReadOnlyError';
  }
}

export const isGlobalLedgerReadOnlyError = (e: unknown): boolean =>
  e instanceof Error && (e as { globalLedgerReadOnly?: unknown }).globalLedgerReadOnly === true;

/** The server's one stderr line at its start (design 4.7: "서버는 시작할 때 stderr에 한 줄을 출력한다"). ASCII only,
 *  constant, no path. */
export const GLOBAL_READ_ONLY_STARTUP_LINE =
  "helix: NOTE - the global memory file's path cannot be used for writing (it cannot be resolved, or it is a link into a " +
  'directory that does not exist), so global memory is read-only: nothing can be stored, erased or re-graded there until ' +
  'the path is repaired';

/** The changed-destination refusal of a global write (4.1 item 3, the check after the open; FW-R7, v-firstwrite-12: the
 *  append raised the project commit's text in the global scope). "In progress", not "waited for its lock": the file can
 *  also be replaced while the lock is held (v-global-08). */
export const GLOBAL_DESTINATION_CHANGED: Record<GlobalWriteOp, string> = {
  commit: 'commit: the global memory file changed while the write was in progress — nothing was written. Try the commit again; if it happens again, tell the user.',
  erase: 'erase: the global memory file changed while the erase was in progress — nothing was erased. Try the erase again; if it happens again, tell the user.',
  confirm: 'confirm: the global memory file changed while the confirmation was in progress — the grade was not changed. Try the confirmation again; if it happens again, tell the user.',
  recheck: 'recheck: the global memory file changed while the recheck was in progress — the grade was not changed. Try the recheck again; if it happens again, tell the user.',
  compaction: 'compaction: the global memory file changed while the rewrite was in progress — nothing was rewritten.',
};
