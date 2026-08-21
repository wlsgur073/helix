import { MAX_SESSION_ID_CHARS, MAX_SESSION_REASON_CHARS } from '../limits.js';

export interface SessionEndRecord {
  kind: 'session-end';
  sessionId: string;
  reason: string;
  ts: string;
}

/**
 * H3: the ONE shared stdin reader both session-start.ts and session-end.ts import — a private
 * per-hook `readStdin` would let the two drift, and the hook process is the only reader standing
 * between an untrusted stdin and memory (there is no schema layer here, unlike the MCP tools).
 *
 * A BYTE cap, not a char cap: bounds the raw read before any JSON parse or UTF-8 decode. Accumulates
 * chunks to EOF and returns the decoded text, UNLESS the running total crosses `maxBytes` first — at
 * that point it returns `null` immediately and stops accumulating (it does not keep draining to EOF
 * first; a `for await` loop left early destroys/releases the underlying stream). Fail-closed by
 * construction: callers treat `null` as "no input", never as a truncated prefix of the real payload —
 * a silently truncated JSON payload can parse to something the sender never sent.
 */
export async function readStdinCapped(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parse a SessionEnd hook's stdin JSON into a session record. The documented field is
 * `reason`; `end_reason` was observed in the wild on this platform — accept both.
 * Garbage input -> null (the hook records nothing and still exits 0).
 *
 * H3: `sessionId`/`reason` are TRUNCATED (not rejected) to their caps — the record stays useful for
 * whoever reads sessions.jsonl even when the hook's caller sent an oversized value.
 */
export function buildSessionEndRecord(
  stdinText: string,
  now: () => string = () => new Date().toISOString(),
): SessionEndRecord | null {
  try {
    const j = JSON.parse(stdinText) as Record<string, unknown>;
    if (j === null || typeof j !== 'object') return null;
    const sessionId = typeof j.session_id === 'string' && j.session_id !== '' ? j.session_id : 'unknown';
    const reasonRaw = j.reason ?? j.end_reason;
    const reason = typeof reasonRaw === 'string' && reasonRaw !== '' ? reasonRaw : 'unknown';
    return {
      kind: 'session-end',
      sessionId: sessionId.slice(0, MAX_SESSION_ID_CHARS),
      reason: reason.slice(0, MAX_SESSION_REASON_CHARS),
      ts: now(),
    };
  } catch {
    return null;
  }
}
