// The opens of the files Helix keeps under HELIX_HOME (B2a ruling J2, plan decision P3).
//
// A plain open(2) asks nothing about WHAT the path is: a FIFO with no peer blocks it for good, and no catch ever sees
// that, because nothing is thrown. Reads therefore open O_NONBLOCK and fstat the DESCRIPTOR (the object actually
// opened, not the name), and appends open O_NONBLOCK too, so a FIFO with no reader fails with ENXIO at once. Only a
// regular file is handed back. The ledger reads (src/memory/ledger.ts) and config.json (src/config.ts) have their own
// versions of the same defence; this module is the one for everything else Helix opens in its home.
//
// Links at the last component ARE followed: the key read through a link and an append through a linked HELIX_SESSIONS
// are behaviours this module must not change. The decision about WHICH file a destination may be is not made here.
import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { basename, dirname, join, win32 } from 'node:path';
import { fileIdentityAt, hasComparableInode, resolvePath, sameFile, type FileIdentity } from './path-identity.js';

/** A file Helix keeps (a key, a registry, a log, the sessions file) is a FIFO, a directory, a device, a socket or
 *  anything else that is not a regular file. Fixed at the text review: constant, no path. */
const NOT_REGULAR_HOME_FILE_TEXT = 'A Helix data file is not a regular file.';

export class NotRegularHomeFileError extends Error {
  /** The marker isNotRegularHomeFileError reads (a property, never class identity: a module loaded twice mints two classes). */
  readonly notRegularHomeFile = true;
  constructor() {
    super(NOT_REGULAR_HOME_FILE_TEXT);
    this.name = 'NotRegularHomeFileError';
  }
}

export const isNotRegularHomeFileError = (e: unknown): boolean =>
  e instanceof Error && (e as { notRegularHomeFile?: unknown }).notRegularHomeFile === true;

const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK;

/** ENXIO: a FIFO with no reader opened for writing, and a UNIX socket or a driverless device node opened at all. */
const isEnxio = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENXIO';

/** Closes `fd` and refuses unless it is a regular file. An fstat that throws closes it too. */
function refuseUnlessRegular(fd: number): void {
  let regular = false;
  try { regular = fstatSync(fd).isFile(); }
  finally { if (!regular) { try { closeSync(fd); } catch { /* closing a finished descriptor changes nothing */ } } }
  if (!regular) throw new NotRegularHomeFileError();
}

/** Opens `path` for reading without blocking and returns the descriptor of a REGULAR file; the caller reads it and
 *  closes it. ENOENT and every other errno propagate unchanged. Anything that is not a regular file throws
 *  NotRegularHomeFileError. */
export function openHomeFileForRead(path: string): number {
  let fd: number;
  try { fd = openSync(path, READ_FLAGS); }
  catch (e) { if (isEnxio(e)) throw new NotRegularHomeFileError(); throw e; }
  refuseUnlessRegular(fd);
  return fd;
}

/** Opens `path` for appending without blocking, creating it with `mode` (the umask can only clear bits), and returns the
 *  descriptor of a REGULAR file; the caller writes it and closes it. `open` replaces the raw open for a caller whose
 *  open goes through an injectable seam (witness-store's DurableFsOps). EISDIR, EACCES and the other errnos propagate
 *  unchanged; a FIFO (with or without a reader), a socket or a device throws NotRegularHomeFileError. */
export function openHomeFileForAppend(
  path: string,
  mode: number,
  open: (path: string, flags: number, mode: number) => number = (p, f, m) => openSync(p, f, m),
): number {
  let fd: number;
  try { fd = open(path, APPEND_FLAGS, mode); }
  catch (e) { if (isEnxio(e)) throw new NotRegularHomeFileError(); throw e; }
  refuseUnlessRegular(fd);
  return fd;
}

/** The ten files under HELIX_HOME that Helix keeps for itself and that no ledger may be: OWNED_FILES (home-permissions.ts)
 *  without `memory.jsonl`, the owner's ledger (B2a ruling E, design 4.3). Spelled out here because this module imports builtins
 *  and path-identity.ts only; test/memory/home-files.test.ts compares the list with OWNED_FILES. */
const CONTROL_FILES = [
  'audit.jsonl', 'sessions.jsonl', 'metrics.jsonl', 'trigger.jsonl', 'codex-log.jsonl',
  'witness.json', 'witness-log.jsonl', 'projects.json', 'ledger-mac-master.key', 'config.json',
] as const;

/** The control files, then their lock names and the lock name of `memory.jsonl` (the lock a ledger or a key takes is
 *  `<resolved path>.lock`, lock.ts lockPathOf). `memory.jsonl` itself is not here: it is the normal global path. */
export const HOME_CONTROL_NAMES: readonly string[] = [
  ...CONTROL_FILES,
  ...['memory.jsonl', ...CONTROL_FILES].map((name) => `${name}.lock`),
];

const HEX32 = '[0-9a-f]{32}';
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The temporary files Helix mints beside an owned file, by the writers' own shapes: `<f>.c-<hex32>.tmp` (compaction,
 *  ledger.ts), `<f>.lk-<hex32>.tmp` (lock, lock.ts), `<f>.k-<hex32>.tmp` (key, ledger-mac.ts), `<f>.w-<hex32>.tmp` (witness,
 *  witness-store.ts), `<f>.<hex16>.tmp` (registry, ownership.ts) and the legacy `<f>.<digits>.tmp` (ledger-sweep.ts). No
 *  temporary file has a fixed name, so "the named temp files" of the outline are these shapes; a lock-reaping gate is
 *  `<f>.lock.reap.<boot id>` (lock.ts), matched by its prefix. Stems: the control files and `memory.jsonl`. */
const TEMP_FAMILIES: ReadonlyArray<readonly [stem: string, pattern: RegExp, gatePrefix: string]> =
  ['memory.jsonl', ...CONTROL_FILES].map((stem) => [stem, new RegExp(`^${escapeRe(stem)}\\.(?:(?:c|lk|k|w)-${HEX32}|[0-9a-f]{16}|\\d+)\\.tmp$`), `${stem}.lock.reap.`] as const);

const identityOrNull = (path: string, follow: boolean): FileIdentity | null => {
  try { return fileIdentityAt(path, { follow }); } catch { return null; }   // an error decides nothing: "not the same file"
};

/** Is the resolved destination `resolved` (the resolver's physical answer, `resolvePath(x).path`) one of the home's control
 *  files? Returns that control name, or null. Two conditions, either is enough (design 4.3):
 *  1. PATH: the destination's directory is the home's physical directory (the home's own final link followed) and its name is in
 *     HOME_CONTROL_NAMES or is a temporary file of an owned file. This is the only condition that can see a file that does not
 *     exist yet, and the only one on a file system that gives no inode.
 *  2. IDENTITY: the destination exists, has a comparable inode (not 0, B1 decision 9) and is the same device and inode as one
 *     of the ten control files as the home reaches it (a link followed), which sees a hard link or a second name.
 *  `allow` skips ONE control file for both conditions (the SessionEnd hook passes `sessions.jsonl`); its lock and temporary
 *  files stay control files. `platform` (default process.platform; a test passes 'win32' on any host, as codex.ts's
 *  interpretWhereOutput does) selects the win32 branch: the home is kept as given, not resolved the kernel's way (resolvePath
 *  splits on `/`; A2's win32 branch does the same), and both sides are compared after path.win32.resolve, which folds the
 *  separators, a trailing separator, `.` and `..` (resolvePath joins with `/` there, so `C:\h/x` reaches this function). The
 *  identity condition is the same on both branches; on a file system without inodes hasComparableInode refuses it.
 *  Side-effect free; never throws. The cost is one resolution of the home and at most eleven stats. */
export function homeControlFileOf(home: string, resolved: string, opts: { allow?: string; platform?: NodeJS.Platform } = {}): string | null {
  const allow = opts.allow;
  const onWin32 = (opts.platform ?? process.platform) === 'win32';
  let homeDir: string;
  let dest: string;
  if (onWin32) {
    homeDir = win32.resolve(home);
    dest = win32.resolve(resolved);
  } else {
    const h = resolvePath(home);
    homeDir = h.kind === 'resolved' ? h.path : home;
    dest = resolved;
  }
  const ops = onWin32 ? win32 : { dirname, basename, join };
  if (ops.dirname(dest) === homeDir) {
    const name = ops.basename(dest);
    // Design 4.3: the home's own memory.jsonl is the normal path, so neither condition claims it, also when a control file
    // is a link or a second name to it (that file's own defect is judged where it is read, e.g. the witness file's D9 refusal).
    if (name === 'memory.jsonl') return null;
    if (name !== allow && HOME_CONTROL_NAMES.includes(name)) return name;
    for (const [stem, pattern, gatePrefix] of TEMP_FAMILIES) {
      if (pattern.test(name) || name.startsWith(gatePrefix)) return stem;
    }
  }
  const id = identityOrNull(dest, false);
  if (!hasComparableInode(id)) return null;
  for (const name of CONTROL_FILES) {
    if (name === allow) continue;
    if (sameFile(id, identityOrNull(ops.join(homeDir, name), true))) return name;
  }
  return null;
}
