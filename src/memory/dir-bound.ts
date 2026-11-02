/** The judged directory, held by a descriptor (third fix batch B1, design 4.1 item 3, decision 2). A file opened by
 *  its path goes wherever the path led at that moment, and the check after the open sees only what the path leads to
 *  afterwards: a directory component replaced before the sample, or replaced and put back around the open, still
 *  moves a file or a row into another directory. A descriptor held on the judged directory does not move. Node's fs
 *  API has no `*at` calls, so the file is reached through `/proc/self/fd/<fd>/<name>`, which the kernel resolves from
 *  the descriptor's directory.
 *
 *  The descriptor is bound to the judgement twice. Its device and inode must be the judged directory's, and
 *  `readlink(/proc/self/fd/<fd>)` must be the judged path: the identity alone passes a directory reached by another
 *  spelling (a link above it), and only the kernel's own name for the descriptor tells them apart. Without `/proc`
 *  (not mounted, not Linux) the answer is an unbound handle: the path-based names, with the check after the open
 *  alone. `/proc` lost after it was seen is a refusal of its own, because the fallback would be a silent loss of the
 *  guarantee every earlier append had.
 *
 *  This module must not import `./ledger.js`, which imports it. */
import { lstatSync, constants } from 'node:fs';
import { join } from 'node:path';
import { realProcFdSyscalls, type DurableFsOps, type ProcFdSyscalls } from './fs-ops.js';
import { hasComparableInode, sameFile, type FileIdentity } from './path-identity.js';

export const PROC_SELF_FD = '/proc/self/fd';

/** `fd` is the held directory descriptor, `null` for the path-based fallback. */
export interface HeldDir { readonly dir: string; readonly fd: number | null }

export type JudgedDirOutcome =
  | { kind: 'bound'; dir: HeldDir }
  | { kind: 'unbound'; dir: HeldDir }
  | { kind: 'changed' }
  | { kind: 'proc-lost' };

/** What a bind learnt of one `procFd` object: 'present' once `/proc/self/fd/<fd>` was verified against a descriptor,
 *  'absent' when the first verification failed. Keyed by the object, so a fresh stub has a fresh memory. */
const memory = new WeakMap<ProcFdSyscalls, 'present' | 'absent'>();

const DIR_OPEN = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** What the directory open answers when what stands at the judged path is no longer a plain directory. Linux answers
 *  ENOTDIR for O_DIRECTORY | O_NOFOLLOW on a link and ELOOP without O_DIRECTORY: both are listed, so this code never
 *  depends on which. */
const DIR_CHANGED_OPEN_ERRORS = new Set(['ELOOP', 'ENOTDIR', 'ENOENT']);

export function procFdAvailable(fsOps: DurableFsOps): boolean {
  return process.platform === 'linux' && memory.get(fsOps.procFd ?? realProcFdSyscalls) !== 'absent';
}

/** The judgement's sample of a directory: only a directory answers; a link, a file and a missing name answer null,
 *  any other error is thrown, as `fileIdentityAt` does. */
export function sampleDirIdentity(dir: string): FileIdentity | null {
  try {
    const st = lstatSync(dir, { bigint: true });
    return st.isDirectory() ? { dev: st.dev, ino: st.ino } : null;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}

/** `seen`, through `/proc/self/fd/<fd>`, is the object the descriptor holds: the same device, and the same inode unless
 *  either side has none. An inode of 0 says nothing about whose `/proc` this is, so it never fails by itself (design 14,
 *  decision 9). */
function sameHeldObject(seen: FileIdentity, held: FileIdentity): boolean {
  if (seen.dev !== held.dev) return false;
  return !hasComparableInode(seen) || !hasComparableInode(held) || seen.ino === held.ino;
}

/** Open and bind the judged directory, or say why not. `judged === null` is a judgement that found no directory: a
 *  refusal in both modes, before anything is opened. An errno other than the listed three propagates raw, EACCES
 *  included (a folder that refuses this open fails the append's sweep the same way, so none ever took an append). */
export function openJudgedDir(dir: string, judged: FileIdentity | null, fsOps: DurableFsOps): JudgedDirOutcome {
  if (judged === null) return { kind: 'changed' };
  if (!procFdAvailable(fsOps)) return { kind: 'unbound', dir: { dir, fd: null } };
  let fd: number;
  try {
    fd = fsOps.openSync(dir, DIR_OPEN);
  } catch (e) {
    if (DIR_CHANGED_OPEN_ERRORS.has((e as NodeJS.ErrnoException).code ?? '')) return { kind: 'changed' };
    throw e;
  }
  let bound = false;
  try {
    const st = fsOps.fstatSync(fd);
    const held: FileIdentity = { dev: st.dev, ino: st.ino };
    if (hasComparableInode(judged) && hasComparableInode(held) && !sameFile(held, judged)) return { kind: 'changed' };

    const sys = fsOps.procFd ?? realProcFdSyscalls;
    const magic = `${PROC_SELF_FD}/${fd}`;
    let ours: boolean;
    try { ours = sameHeldObject(sys.statSync(magic), held); } catch { ours = false; }
    if (!ours) {   // not this process's /proc/self/fd (another pid namespace), or no /proc at all
      if (memory.get(sys) === 'present') return { kind: 'proc-lost' };
      memory.set(sys, 'absent');
      return { kind: 'unbound', dir: { dir, fd: null } };
    }
    memory.set(sys, 'present');

    let named: string;
    try { named = sys.readlinkSync(magic); } catch { return { kind: 'proc-lost' }; }
    if (named !== dir) return { kind: 'changed' };   // this binding, not the identity, is what closes a link above the directory
    bound = true;
    return { kind: 'bound', dir: { dir, fd } };
  } finally {
    if (!bound) fsOps.closeSync(fd);
  }
}

/** The name of `name` inside the held directory: through the descriptor when it is bound, by the path otherwise. */
export function boundPath(held: HeldDir, name: string): string {
  return held.fd === null ? join(held.dir, name) : `${PROC_SELF_FD}/${held.fd}/${name}`;
}

/** Fsync the held directory. Opening `/proc/self/fd/<fd>` opens the directory the descriptor holds, wherever its path
 *  has moved, so this keeps the seam and its errno classification. */
export function fsyncDir(held: HeldDir, fsOps: DurableFsOps): void {
  fsOps.fsyncDir(held.fd === null ? held.dir : `${PROC_SELF_FD}/${held.fd}`);
}

/** An error raised through a held directory names the directory's judged path, not the descriptor path it was reached by
 *  (design 14 item 21): a refused open of a read-only memory file said `open '/proc/self/fd/21/memory.jsonl'`, so the user
 *  could not tell which file it was, and the text depended on a descriptor number. Each `/proc/self/fd/<fd>` of this
 *  handle in the error's `message`, `path` and `dest` becomes `held.dir`, only where `/`, a quote or the end follows (a
 *  folder held on descriptor 2 never rewrites `/proc/self/fd/21/...`). The error is changed in place and returned, so its
 *  code, its markers and the stored mark survive; it is read by its properties, never by class. A handle without a
 *  descriptor, a value that is not an object and a property that resists the change are left as they are. */
export function unbindError(e: unknown, held: HeldDir): unknown {
  if (held.fd === null || e === null || typeof e !== 'object') return e;
  const prefix = new RegExp(`${PROC_SELF_FD}/${held.fd}(?=[/']|$)`, 'g');
  const fields = e as Record<string, unknown>;
  for (const key of ['message', 'path', 'dest']) {
    const was = fields[key];
    if (typeof was !== 'string') continue;
    const now = was.replace(prefix, () => held.dir);
    if (now !== was) { try { fields[key] = now; } catch { /* frozen or read-only: the error stays as it was raised */ } }
  }
  return e;
}

export function closeHeldDir(held: HeldDir, fsOps: DurableFsOps): void {
  if (held.fd !== null) fsOps.closeSync(held.fd);
}
