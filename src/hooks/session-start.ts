// SessionStart hook entry: print the current-truth memory block to stdout (Claude Code
// injects a SessionStart hook's stdout into the session context). A hook must never
// break session start: on ANY error it injects nothing and still exits 0.
//
// SECURITY: this auto-load path reads BOTH ledgers through the VERIFYING projection (verifiedLive),
// NOT a bare buildProjection. A forged or hand-edited ledger record — including one appended to an
// already-OWNED project's .helix/memory.jsonl — replays as Fresh here, exactly as recall/inspect
// clamp it. The hook runs locally and can read ~/.helix, so it derives the same subkeys and shows
// the SAME verified grades the tools show. Key-absent => everything clamps to Fresh (fail-closed).
import { writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSessionStartContext } from './format-context.js';
import { newNonce } from '../memory/content-frame.js';
import { isOwned, projectLedgerPath } from '../memory/ownership.js';
import { verifiedLive } from '../memory/verified-read.js';
import type { ScopedRecord } from '../types.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export interface GatherInput {
  home: string;
  globalLedger: string;
  cwd?: string;
}

/**
 * Pure, testable: gather the VERIFIED live records from the global ledger + (the in-repo project
 * ledger iff owned), each scope-tagged. Routes every read through verifiedLive so a forged/edited
 * record clamps to Fresh — the same trust grades recall/inspect show. No stdin, no process state,
 * no I/O beyond reading the ledger/registry/master under `home`.
 */
export function gatherScopedRecords({ home, globalLedger, cwd }: GatherInput): ScopedRecord[] {
  const scoped: ScopedRecord[] = [];
  for (const r of verifiedLive(globalLedger, home).live.values()) scoped.push({ record: r, scope: 'global' });

  // Project root comes ONLY from the hook's stdin cwd (canonical). No process.cwd() fallback —
  // a hook's own cwd is unreliable. No cwd -> global only.
  if (cwd) {
    try {
      if (isOwned(cwd, home)) {
        const projLedger = projectLedgerPath(cwd);
        // guard: never read the global ledger as a "project" layer (cwd == ~ collision)
        if (resolve(projLedger) !== resolve(globalLedger)) {
          for (const r of verifiedLive(projLedger, home, cwd).live.values()) scoped.push({ record: r, scope: 'project' });
        }
      }
    } catch { /* unreadable/foreign project ledger → global only */ }
  }
  return scoped;
}

async function main(): Promise<void> {
  try {
    const home = process.env.HELIX_HOME ?? join(homedir(), '.helix');
    const globalLedger = process.env.HELIX_LEDGER ?? join(home, 'memory.jsonl');

    let cwd: string | undefined;
    try {
      const j = JSON.parse(await readStdin()) as { cwd?: unknown };
      if (typeof j.cwd === 'string') cwd = j.cwd;
    } catch { /* no/garbage stdin -> global only */ }

    const scoped = gatherScopedRecords({ home, globalLedger, cwd });
    const text = formatSessionStartContext(scoped, newNonce());
    // Synchronous write to fd 1: process exit must not drop a buffered async pipe write on
    // Windows (which would inject an unterminated DATA block). No explicit exit() needed —
    // natural exit yields code 0 and there are no open handles to keep the loop alive.
    if (text !== '') writeSync(1, text + '\n');
  } catch {
    // fail-closed for injection: no memory block rather than a broken session
  }
}

// Run only when invoked as the hook entry point (node <bundle>). Importing this module — e.g. a unit
// test exercising gatherScopedRecords — must NOT consume stdin or block. resolve() normalises both
// sides so a relative argv[1] still matches the bundle's own path.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) void main();
