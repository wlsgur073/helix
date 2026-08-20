import { describe, it, expect } from 'vitest';
import {
  MAX_COMMIT_CONTENT_CHARS, MAX_DV_QUESTION_CHARS, MAX_DV_ANSWER_CHARS,
  MAX_RECHECK_PATH_CHARS, MAX_RECHECK_PATTERN_CHARS, HOOK_STDIN_MAX_BYTES,
  MAX_SESSION_ID_CHARS, MAX_SESSION_REASON_CHARS, RECALL_MAX_ITEMS_CAP,
  RECALL_MAX_CHARS_CAP, RESPONSE_MAX_CHARS,
} from '../src/limits.js';

// H3/M1 (2026-08-18 review): src/limits.ts is the single table every later task's schema AND core
// enforcement reads from (Tasks 3-5). These tests pin the table itself -- its exports, shape and
// values -- not any enforcement site.
describe('limits', () => {
  // Named individually rather than gathered with a wildcard import, so a renamed or dropped export
  // fails this file at IMPORT time, before a single assertion runs -- the RED signal Step 3 depends
  // on (module missing -> the import itself throws).
  const ALL: Record<string, number> = {
    MAX_COMMIT_CONTENT_CHARS, MAX_DV_QUESTION_CHARS, MAX_DV_ANSWER_CHARS,
    MAX_RECHECK_PATH_CHARS, MAX_RECHECK_PATTERN_CHARS, HOOK_STDIN_MAX_BYTES,
    MAX_SESSION_ID_CHARS, MAX_SESSION_REASON_CHARS, RECALL_MAX_ITEMS_CAP,
    RECALL_MAX_CHARS_CAP, RESPONSE_MAX_CHARS,
  };

  it('exports exactly the eleven H3/M1 constants, each a positive integer', () => {
    expect(Object.keys(ALL)).toHaveLength(11);
    for (const [name, value] of Object.entries(ALL)) {
      expect(typeof value, name).toBe('number');
      expect(Number.isInteger(value), name).toBe(true);
      expect(value, name).toBeGreaterThan(0);
    }
  });

  // Per-field caps, NOT a sum bound. `helix_dual_verify` takes `question` and `helixAnswer` as two
  // independent string fields that are never concatenated before dual-verify's downstream egress
  // cap (200,000 chars -- classifyEgress) runs. `MAX_DV_QUESTION_CHARS + MAX_DV_ANSWER_CHARS <
  // 200_000` would reject a table where both fields are individually safe but happen to sum past
  // 200,000, and would pass a table where a single field alone already exceeds what egress lets
  // through -- neither matches how the two fields are actually read, so each is asserted on its
  // own against the egress cap.
  it('MAX_DV_QUESTION_CHARS and MAX_DV_ANSWER_CHARS each sit under the 200,000-char egress cap', () => {
    expect(MAX_DV_QUESTION_CHARS).toBeLessThan(200_000);
    expect(MAX_DV_ANSWER_CHARS).toBeLessThan(200_000);
  });
});
