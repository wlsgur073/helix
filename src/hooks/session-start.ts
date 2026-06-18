// SessionStart hook entry: print the current-truth memory block to stdout (Claude Code
// injects a SessionStart hook's stdout into the session context). A hook must never
// break session start: on ANY error it injects nothing and still exits 0.
import { writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseLedger } from '../memory/ledger.js';
import { buildProjection } from '../memory/projection.js';
import { formatSessionStartContext } from './format-context.js';
import { newNonce } from '../memory/content-frame.js';
import { isOwned, projectLedgerPath } from '../memory/ownership.js';
import type { ScopedRecord } from '../types.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const home = process.env.HELIX_HOME ?? join(homedir(), '.helix');
  const globalLedger = process.env.HELIX_LEDGER ?? join(home, 'memory.jsonl');

  const scoped: ScopedRecord[] = [];
  for (const r of buildProjection(parseLedger(globalLedger)).values()) scoped.push({ record: r, scope: 'global' });

  // Project root comes ONLY from the hook's stdin cwd (canonical). No process.cwd() fallback —
  // a hook's own cwd is unreliable. No cwd -> global only.
  let cwd: string | undefined;
  try {
    const j = JSON.parse(await readStdin()) as { cwd?: unknown };
    if (typeof j.cwd === 'string') cwd = j.cwd;
  } catch { /* no/garbage stdin -> global only */ }

  if (cwd && isOwned(cwd, home)) {
    const projLedger = projectLedgerPath(cwd);
    // guard: never read the global ledger as a "project" layer (cwd == ~ collision)
    if (projLedger !== globalLedger) {
      for (const r of buildProjection(parseLedger(projLedger)).values()) scoped.push({ record: r, scope: 'project' });
    }
  }

  const text = formatSessionStartContext(scoped, newNonce());
  // Synchronous write to fd 1: process exit must not drop a buffered async pipe write on
  // Windows (which would inject an unterminated DATA block). No explicit exit() needed —
  // natural exit yields code 0 and there are no open handles to keep the loop alive.
  if (text !== '') writeSync(1, text + '\n');
} catch {
  // fail-closed for injection: no memory block rather than a broken session
}
