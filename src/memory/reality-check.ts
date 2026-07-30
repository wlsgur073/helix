import { existsSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import type { VerifyOutcome } from './firewall.js';

export type RealityCheck =
  | { kind: 'file-exists'; path: string }
  | { kind: 'file-contains'; path: string; pattern: string };

const INDETERMINATE: VerifyOutcome = { ran: false, indeterminate: true, passed: false };

/** file-contains read bound: an oversized file is indeterminate (never read whole into memory). */
const MAX_FILE_BYTES = 5_000_000;

/** Does `path` contain `pattern`? Opens the file itself and answers from the DESCRIPTOR.
 *
 *  The previous version asked `statSync(path).size > MAX_FILE_BYTES` and then read the whole file.
 *  Size is the wrong question: a FIFO, a character device and most of /proc all report size 0, so
 *  the guard waved them through into a synchronous whole-file read on the single-threaded MCP
 *  server's thread — a FIFO with no writer blocks open(2) forever and /dev/zero reads until the
 *  process dies. Neither is an I/O *error*, so the caller's try/catch never sees them; the server
 *  simply stops answering. This is reachable from the agent tool surface, because checkBinding only
 *  requires the path and pattern to be raw substrings of the item's own content.
 *
 *  Three things make it safe, and all three are needed:
 *   - O_NONBLOCK on the open, so opening a writer-less FIFO returns instead of blocking;
 *   - fstat on the DESCRIPTOR rather than stat on the path, which both asks about the object we
 *     actually opened (no TOCTOU) and lets us reject anything that is not a regular file;
 *   - a bounded read loop, because a regular file may still grow after its fstat.
 */
function containsBounded(path: string, pattern: string): VerifyOutcome {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return INDETERMINATE;                  // not a regular file -> cannot verify safely
    if (st.size > MAX_FILE_BYTES) return INDETERMINATE;      // oversized -> never read whole into memory
    // One byte of headroom: filling the buffer means the file outgrew what fstat promised, which is
    // a file we can no longer bound — fail closed rather than answer from a partial read.
    const cap = Math.min(st.size, MAX_FILE_BYTES) + 1;
    const buf = Buffer.alloc(cap);
    let len = 0;
    for (;;) {
      const n = readSync(fd, buf, len, cap - len, null);
      if (n === 0) break;
      len += n;
      if (len === cap) return INDETERMINATE;
    }
    return { ran: true, indeterminate: false, passed: buf.subarray(0, len).toString('utf8').includes(pattern) };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* closing a doomed fd changes nothing */ } }
  }
}

/**
 * Run a mechanical reality-check. Fail-closed: anything unrecognized, malformed, or
 * errored is indeterminate (never `passed`). A determinate negative (file absent /
 * pattern missing) is `{ ran: true, indeterminate: false, passed: false }`.
 */
export function runRealityCheck(check: RealityCheck): VerifyOutcome {
  try {
    switch (check.kind) {
      case 'file-exists': {
        if (typeof check.path !== 'string') return INDETERMINATE;
        return { ran: true, indeterminate: false, passed: existsSync(check.path) };
      }
      case 'file-contains': {
        if (typeof check.path !== 'string' || typeof check.pattern !== 'string') return INDETERMINATE;
        if (!existsSync(check.path)) return INDETERMINATE; // missing -> can't check (denies delete->demote)
        return containsBounded(check.path, check.pattern);
      }
      default:
        return INDETERMINATE; // unknown kind -> fail closed
    }
  } catch {
    return INDETERMINATE; // any I/O error -> fail closed
  }
}

const MIN_PATTERN_CHARS = 3;
/**
 * Does this check actually exercise what the item claims? (spec §4) Promotion requires BOTH the
 * `path` AND the `pattern` to be RAW substrings of the item content (byte-for-byte, matching
 * runRealityCheck's raw includes), and a non-trivial pattern. Only `file-contains` may promote.
 */
export function checkBinding(content: string, check: RealityCheck): { bound: boolean; reason?: string } {
  if (check.kind !== 'file-contains') return { bound: false, reason: 'only file-contains may promote (file-exists is non-promoting)' };
  if (check.pattern.replace(/\s/g, '').length < MIN_PATTERN_CHARS) return { bound: false, reason: 'pattern too trivial (need >=3 non-whitespace chars)' };
  if (!content.includes(check.path)) return { bound: false, reason: 'check.path is not present in the item content' };
  if (!content.includes(check.pattern)) return { bound: false, reason: 'check.pattern is not present in the item content' };
  return { bound: true };
}
