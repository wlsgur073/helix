// SessionStart hook entry: print the current-truth memory block to stdout (Claude Code
// injects a SessionStart hook's stdout into the session context). A hook must never
// break session start: on ANY error it injects nothing and still exits 0.
import { writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseLedger } from '../memory/ledger.js';
import { buildProjection } from '../memory/projection.js';
import { formatSessionStartContext } from './format-context.js';

try {
  const home = process.env.HELIX_HOME ?? join(homedir(), '.helix');
  const ledger = process.env.HELIX_LEDGER ?? join(home, 'memory.jsonl');
  const text = formatSessionStartContext([...buildProjection(parseLedger(ledger)).values()]);
  // Synchronous write to fd 1: process exit must not drop a buffered async pipe write on
  // Windows (which would inject an unterminated DATA block). No explicit exit() needed —
  // natural exit yields code 0 and there are no open handles to keep the loop alive.
  if (text !== '') writeSync(1, text + '\n');
} catch {
  // fail-closed for injection: no memory block rather than a broken session
}
