// SessionStart hook entry: print the current-truth memory block to stdout (Claude Code
// injects a SessionStart hook's stdout into the session context). A hook must never
// break session start: on ANY error it injects nothing and still exits 0.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseLedger } from '../memory/ledger.js';
import { buildProjection } from '../memory/projection.js';
import { formatSessionStartContext } from './format-context.js';

try {
  const home = process.env.HELIX_HOME ?? join(homedir(), '.helix');
  const ledger = process.env.HELIX_LEDGER ?? join(home, 'memory.jsonl');
  const text = formatSessionStartContext([...buildProjection(parseLedger(ledger)).values()]);
  if (text !== '') process.stdout.write(text + '\n');
} catch {
  // fail-closed for injection: no memory block rather than a broken session
}
process.exit(0);
