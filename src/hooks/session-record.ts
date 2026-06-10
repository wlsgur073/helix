export interface SessionEndRecord {
  kind: 'session-end';
  sessionId: string;
  reason: string;
  ts: string;
}

/**
 * Parse a SessionEnd hook's stdin JSON into a session record. The documented field is
 * `reason`; `end_reason` was observed in the wild on this platform — accept both.
 * Garbage input -> null (the hook records nothing and still exits 0).
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
    return { kind: 'session-end', sessionId, reason, ts: now() };
  } catch {
    return null;
  }
}
