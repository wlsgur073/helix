// SessionEnd hook entry: append one session record to ~/.helix/sessions.jsonl.
// Session metadata is NOT a memory assertion, so it goes to its own ledger — committing
// auto-generated summaries to memory would bypass the provenance firewall.
// A hook must never block shutdown: any error -> record nothing, say so on stderr in one constant line, exit 0.
import { closeSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { buildSessionEndRecord, readStdinCapped, HOME_REFUSED_END_NOTE, SESSION_RECORD_DROPPED_NOTE } from './session-record.js';
import { assertSessionsDestination } from './sessions-destination.js';
import { ensureHelixDir } from '../memory/home-permissions.js';
import { HOOK_STDIN_MAX_BYTES } from '../limits.js';
import { resolveHelixPaths, isHomeRefusalError, type HelixPaths } from '../memory/home-env.js';
import { openHomeFileForAppend } from '../memory/home-files.js';

/** Design 4.1: HELIX_HOME, HELIX_LEDGER and HELIX_SESSIONS resolved once (HELIX_LEDGER because ruling N1 compares the sessions
 *  destination with the global ledger, task B2). A refused value prints the one constant note and no record is written; only
 *  the resolver's own refusal speaks here, so a refusal raised later (ensureHelixDir, the append) keeps its own path. */
function resolvedPathsOrNote(): HelixPaths | null {
  try {
    // Decision S1: literal process.env reads (the inventory extractor sees only this form), never the bare process.env.
    return resolveHelixPaths({
      HELIX_HOME: process.env.HELIX_HOME, HELIX_LEDGER: process.env.HELIX_LEDGER, HELIX_SESSIONS: process.env.HELIX_SESSIONS,
    }, homedir());
  } catch (e) {
    if (isHomeRefusalError(e)) writeSync(2, `${HOME_REFUSED_END_NOTE}\n`); // ASCII only
    return null;
  }
}

try {
  // H3: fail-closed on an over-cap stdin -- `stdinText === null` short-circuits straight past
  // buildSessionEndRecord, so an oversized payload writes NOTHING to sessions.jsonl (same as
  // garbage/empty stdin below), never a record built from a truncated prefix.
  const stdinText = await readStdinCapped(process.stdin, HOOK_STDIN_MAX_BYTES);
  const record = stdinText === null ? null : buildSessionEndRecord(stdinText);
  if (record) {
    const paths = resolvedPathsOrNote();
    if (paths !== null) {
      try {
        assertSessionsDestination(paths);                              // ruling N1: not a control file of the home, not a ledger
        ensureHelixDir(dirname(paths.sessionsFile));
        const fd = openHomeFileForAppend(paths.sessionsFile, 0o600);   // owner-only ON CREATE; a FIFO or other non-regular file is refused, not waited on
        try { writeFileSync(fd, JSON.stringify(record) + '\n'); } finally { closeSync(fd); }
      } catch {
        writeSync(2, `${SESSION_RECORD_DROPPED_NOTE}\n`);              // ASCII; if this write fails too, the outer catch ends the hook silently
      }
    }
  }
} catch {
  // never block session end
}
// No explicit exit(0): stdin is fully consumed above, so natural exit yields code 0 and
// flushes any pending writes (process.exit can truncate them).
