import { existsSync, readFileSync, statSync } from 'node:fs';
import type { VerifyOutcome } from './firewall.js';

export type RealityCheck =
  | { kind: 'file-exists'; path: string }
  | { kind: 'file-contains'; path: string; pattern: string };

const INDETERMINATE: VerifyOutcome = { ran: false, indeterminate: true, passed: false };

/** file-contains read bound: an oversized file is indeterminate (never read whole into memory). */
const MAX_FILE_BYTES = 5_000_000;

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
        if (!existsSync(check.path)) return { ran: true, indeterminate: false, passed: false };
        if (statSync(check.path).size > MAX_FILE_BYTES) return INDETERMINATE; // oversized -> can't verify safely
        const text = readFileSync(check.path, 'utf8');
        return { ran: true, indeterminate: false, passed: text.includes(check.pattern) };
      }
      default:
        return INDETERMINATE; // unknown kind -> fail closed
    }
  } catch {
    return INDETERMINATE; // any I/O error -> fail closed
  }
}
