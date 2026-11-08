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
