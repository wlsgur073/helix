import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCodexLog, MAX_ENTRIES, type CodexLogEntry } from '../src/codex-log.js';

function tmpLog(): string {
  return join(mkdtempSync(join(tmpdir(), 'helix-clog-')), 'codex-log.jsonl');
}
const sent: CodexLogEntry = {
  ts: '2026-06-14T00:00:00.000Z', kind: 'compare', outcome: 'sent',
  model: 'gpt-5.5', effort: 'high', prompt: 'which db?', response: 'use postgres',
};
const refused: CodexLogEntry = {
  ts: '2026-06-14T00:00:00.000Z', kind: 'compare', outcome: 'refused',
  reason: 'refused: payload contains a secret (not sent to external Codex)',
};

describe('appendCodexLog', () => {
  it('a sent entry persists prompt + response', () => {
    const p = tmpLog();
    appendCodexLog(p, sent);
    const line = JSON.parse(readFileSync(p, 'utf8').trim());
    expect(line.outcome).toBe('sent');
    expect(line.prompt).toBe('which db?');
    expect(line.response).toBe('use postgres');
  });

  // A prior version of this case asserted "no prompt/response" on a `refused` fixture that was
  // never GIVEN a prompt/response — that only proves appendCodexLog didn't invent fields, since it
  // serializes whatever it is handed and strips nothing. The invariant that a refused run's actual
  // prompt/response never reach disk is enforced one layer up, at the handlers.ts call site that
  // decides which fields to pass in (`...(sent ? { prompt, response } : { reason })`) — see
  // test/server/handlers-dualverify.test.ts, describe('codex content log: a refused run persists
  // no payload'), which exercises handleDualVerify end-to-end and reads the written file back.
  // What stays here is only what IS about appendCodexLog itself: it writes exactly the fields it
  // is given, verbatim.
  it('writes exactly the fields it is given (metadata-only fixture in, metadata-only line out)', () => {
    const p = tmpLog();
    appendCodexLog(p, refused);
    const line = JSON.parse(readFileSync(p, 'utf8').trim());
    expect(line.outcome).toBe('refused');
    expect(line.reason).toMatch(/secret/i);
    expect('prompt' in line).toBe(false);
    expect('response' in line).toBe(false);
  });

  it('appends one JSON line per call', () => {
    const p = tmpLog();
    appendCodexLog(p, sent);
    appendCodexLog(p, refused);
    expect(readFileSync(p, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it.runIf(process.platform !== 'win32')('creates the file with mode 0o600 (POSIX)', () => {
    const p = tmpLog();
    appendCodexLog(p, sent);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('MAX_ENTRIES retention cap keeps only the last MAX_ENTRIES lines (oldest trimmed)', () => {
    const p = tmpLog();
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      appendCodexLog(p, { ...sent, prompt: `q${i}`, response: `a${i}` });
    }
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(MAX_ENTRIES);
    // first 5 (q0..q4) trimmed; the oldest surviving is q5, newest is q(MAX_ENTRIES+4)
    expect(JSON.parse(lines[0]!).prompt).toBe('q5');
    expect(JSON.parse(lines[lines.length - 1]!).prompt).toBe(`q${MAX_ENTRIES + 4}`);
  });

  it('a write to an unwritable path is swallowed (best-effort; never throws)', () => {
    // a path whose parent is a file, not a directory -> mkdir/append fails; must not throw
    const f = tmpLog();
    appendCodexLog(f, sent);                       // f is now a file
    const bad = join(f, 'nested', 'codex-log.jsonl');
    expect(() => appendCodexLog(bad, sent)).not.toThrow();
  });
});
