// SessionEnd hook entry: append one session record to ~/.helix/sessions.jsonl.
// Session metadata is NOT a memory assertion, so it goes to its own ledger — committing
// auto-generated summaries to memory would bypass the provenance firewall.
// A hook must never block shutdown: any error -> record nothing, exit 0.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSessionEndRecord, readStdinCapped } from './session-record.js';
import { ensureHelixDir } from '../memory/home-permissions.js';
import { HOOK_STDIN_MAX_BYTES } from '../limits.js';

try {
  // H3: fail-closed on an over-cap stdin -- `stdinText === null` short-circuits straight past
  // buildSessionEndRecord, so an oversized payload writes NOTHING to sessions.jsonl (same as
  // garbage/empty stdin below), never a record built from a truncated prefix.
  const stdinText = await readStdinCapped(process.stdin, HOOK_STDIN_MAX_BYTES);
  const record = stdinText === null ? null : buildSessionEndRecord(stdinText);
  if (record) {
    const home = process.env.HELIX_HOME ?? join(homedir(), '.helix');
    const path = process.env.HELIX_SESSIONS ?? join(home, 'sessions.jsonl');
    ensureHelixDir(dirname(path));
    appendFileSync(path, JSON.stringify(record) + '\n', { mode: 0o600 });   // owner-only ON CREATE
  }
} catch {
  // never block session end
}
// No explicit exit(0): stdin is fully consumed above, so natural exit yields code 0 and
// flushes any pending writes (process.exit can truncate them).
