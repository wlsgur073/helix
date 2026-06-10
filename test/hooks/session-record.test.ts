import { describe, it, expect } from 'vitest';
import { buildSessionEndRecord } from '../../src/hooks/session-record.js';

const NOW = () => '2026-06-10T12:00:00.000Z';

describe('buildSessionEndRecord', () => {
  it('builds a record from the documented hook input shape', () => {
    expect(buildSessionEndRecord('{"session_id":"abc","reason":"clear"}', NOW)).toEqual({
      kind: 'session-end', sessionId: 'abc', reason: 'clear', ts: NOW(),
    });
  });

  it('accepts the observed end_reason field as a fallback', () => {
    expect(buildSessionEndRecord('{"session_id":"abc","end_reason":"logout"}', NOW)?.reason).toBe('logout');
  });

  it('defaults missing fields instead of failing', () => {
    expect(buildSessionEndRecord('{}', NOW)).toEqual({
      kind: 'session-end', sessionId: 'unknown', reason: 'unknown', ts: NOW(),
    });
  });

  it('returns null on garbage stdin (hook then records nothing, exits 0)', () => {
    expect(buildSessionEndRecord('not json at all', NOW)).toBeNull();
    expect(buildSessionEndRecord('', NOW)).toBeNull();
  });
});
