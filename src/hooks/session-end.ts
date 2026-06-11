// SessionEnd hook entry: append one session record to ~/.helix/sessions.jsonl.
// Session metadata is NOT a memory assertion, so it goes to its own ledger — committing
// auto-generated summaries to memory would bypass the provenance firewall.
// A hook must never block shutdown: any error -> record nothing, exit 0.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSessionEndRecord } from './session-record.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const record = buildSessionEndRecord(await readStdin());
  if (record) {
    const home = process.env.HELIX_HOME ?? join(homedir(), '.helix');
    const path = process.env.HELIX_SESSIONS ?? join(home, 'sessions.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + '\n');
  }
} catch {
  // never block session end
}
// No explicit exit(0): stdin is fully consumed above, so natural exit yields code 0 and
// flushes any pending writes (process.exit can truncate them).
