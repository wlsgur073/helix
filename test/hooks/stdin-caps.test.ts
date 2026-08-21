// H3 (2026-08-18 review): bounds the two hooks' accumulate-to-EOF stdin reads. readStdinCapped is
// the ONE shared implementation both session-start.ts and session-end.ts import (session-record.ts
// is the neutral, unit-testable home) -- a private per-hook readStdin would let the two drift.
//
// (c) wiring coverage: session-start.ts's isEntryPoint guard keeps its main() from running on
// import, so its fail-closed path (proceed as {}, one stderr note) is read, not exercised, below.
// session-end.ts has NO such guard -- its top-level body runs on import -- so it is exercised only
// through the frozen bin/ bundle in test/acceptance/hooks.e2e.test.ts (unaffected by this change,
// since bin/ is not rebuilt this task); importing the .ts source here would spawn nothing but WOULD
// consume this test process's real stdin, which is not deterministic in a test runner. Both hooks'
// fail-closed BEHAVIOR is proven directly through readStdinCapped + buildSessionEndRecord instead:
// session-start's contract is "null -> proceed as {}" (proven by readStdinCapped returning null, and
// separately by gatherScopedRecords's existing no-cwd behavior in session-start.test.ts); session-
// end's contract is "null -> write nothing" (proven by buildSessionEndRecord never being called on a
// null read, which is a one-line `stdinText === null ? null : buildSessionEndRecord(stdinText)` in
// session-end.ts, read at review time rather than executed here).
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { readStdinCapped, buildSessionEndRecord } from '../../src/hooks/session-record.js';
import { HOOK_STDIN_MAX_BYTES, MAX_SESSION_ID_CHARS, MAX_SESSION_REASON_CHARS } from '../../src/limits.js';

/** A Readable that yields `bytes` as one or more Buffer chunks -- no spawning, no real stdin. */
function readableOf(bytes: Buffer, chunkSize = 64 * 1024): Readable {
  const chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.subarray(i, i + chunkSize));
  return Readable.from(chunks);
}

describe('readStdinCapped', () => {
  it('returns the accumulated text when the stream ends AT the cap', async () => {
    const payload = 'a'.repeat(HOOK_STDIN_MAX_BYTES);
    const out = await readStdinCapped(readableOf(Buffer.from(payload, 'utf8')), HOOK_STDIN_MAX_BYTES);
    expect(out).toBe(payload);
  });

  it('returns the accumulated text when well under the cap', async () => {
    const out = await readStdinCapped(readableOf(Buffer.from('{"cwd":"/tmp"}', 'utf8')), HOOK_STDIN_MAX_BYTES);
    expect(out).toBe('{"cwd":"/tmp"}');
  });

  it('returns null once the stream crosses the cap (fail-closed), not a truncated prefix', async () => {
    const payload = Buffer.alloc(HOOK_STDIN_MAX_BYTES + 1, 'b');
    const out = await readStdinCapped(readableOf(payload), HOOK_STDIN_MAX_BYTES);
    expect(out).toBeNull();
  });

  it('returns null on a payload one byte over the cap even when it arrives in a single chunk', async () => {
    const payload = Buffer.alloc(HOOK_STDIN_MAX_BYTES + 1, 'c');
    const out = await readStdinCapped(Readable.from([payload]), HOOK_STDIN_MAX_BYTES);
    expect(out).toBeNull();
  });
});

describe('buildSessionEndRecord — sessionId/reason truncation', () => {
  it('truncates an over-cap session_id to MAX_SESSION_ID_CHARS', () => {
    const overCap = 's'.repeat(MAX_SESSION_ID_CHARS + 1);
    const rec = buildSessionEndRecord(JSON.stringify({ session_id: overCap, reason: 'clear' }));
    expect(rec).not.toBeNull();
    expect(rec!.sessionId.length).toBe(MAX_SESSION_ID_CHARS);
    expect(rec!.sessionId).toBe(overCap.slice(0, MAX_SESSION_ID_CHARS));
  });

  it('truncates an over-cap reason to MAX_SESSION_REASON_CHARS', () => {
    const overCap = 'r'.repeat(MAX_SESSION_REASON_CHARS + 1);
    const rec = buildSessionEndRecord(JSON.stringify({ session_id: 's-1', reason: overCap }));
    expect(rec).not.toBeNull();
    expect(rec!.reason.length).toBe(MAX_SESSION_REASON_CHARS);
    expect(rec!.reason).toBe(overCap.slice(0, MAX_SESSION_REASON_CHARS));
  });

  it('leaves an at-cap session_id and reason intact (not off-by-one truncated)', () => {
    const idAtCap = 'i'.repeat(MAX_SESSION_ID_CHARS);
    const reasonAtCap = 'j'.repeat(MAX_SESSION_REASON_CHARS);
    const rec = buildSessionEndRecord(JSON.stringify({ session_id: idAtCap, reason: reasonAtCap }));
    expect(rec).toEqual({ kind: 'session-end', sessionId: idAtCap, reason: reasonAtCap, ts: rec!.ts });
  });

  it('leaves ordinary short session_id/reason values untouched', () => {
    const rec = buildSessionEndRecord(JSON.stringify({ session_id: 's-9', reason: 'logout' }));
    expect(rec?.sessionId).toBe('s-9');
    expect(rec?.reason).toBe('logout');
  });
});
