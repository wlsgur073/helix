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

  // `classifyEgress` (src/risk/trifecta.ts) joins `question` and `helixAnswer` with a newline and
  // compares the JOINED length against its 200,000-char scan limit -- dual-verify.ts passes both
  // into classifyEgress's `texts` array on every call, so the pair is bounded JOINTLY, not just per
  // field. A per-field-only check would let a future edit raise either cap while each stays under
  // 200,000 individually, yet still push every dual-verify call over the real joint limit and into a
  // permanent scan_limit refusal -- so the sum is asserted too, alongside the per-field checks, not
  // instead of them.
  it('MAX_DV_QUESTION_CHARS and MAX_DV_ANSWER_CHARS each sit under the 200,000-char egress cap, and so does their sum', () => {
    expect(MAX_DV_QUESTION_CHARS).toBeLessThan(200_000);
    expect(MAX_DV_ANSWER_CHARS).toBeLessThan(200_000);
    // Strict `<` (not `<=`) is deliberate, not just consistency with the two checks above: the real
    // joined string is `question + '\n' + answer`, one char longer than the bare sum, so a sum that
    // is merely `<= 200_000` could still push the actual joined length past classifyEgress's limit.
    // `< 200_000` (i.e. sum <= 199_999) leaves that one char of room, matching the true check.
    expect(MAX_DV_QUESTION_CHARS + MAX_DV_ANSWER_CHARS).toBeLessThan(200_000);
  });
});
