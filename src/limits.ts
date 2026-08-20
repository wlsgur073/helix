// H3/M1 (2026-08-18 review): authoritative input/response caps. Schema and core BOTH read these —
// a cap enforced in only one place is a cap an alternate entry path does not have.
//
// Measured cause: a 1 MiB `helix_memory_commit` became a ~1.049 MB persistent ledger record AND a
// ~1.049 MB tool response, because projection, retrieval and inspect each re-read and re-tokenize
// the same stored content — one oversized commit pays its cost on every later read, not once at
// write time. dual-verify's own downstream egress cap (classifyEgress) is 200,000 chars, but that
// check runs AFTER the MCP JSON parse and the initial string allocation for `question`/
// `helixAnswer` have already happened; the schema caps below exist to reject an oversized field
// BEFORE that allocation, not to duplicate the egress check, which is why they sit under 200,000
// rather than at it. HOOK_STDIN_MAX_BYTES bounds the accumulate-to-EOF stdin reads in
// `src/hooks/session-start.ts` and `src/hooks/session-end.ts`, which have no schema layer at all —
// the hook process itself is the only reader standing between an untrusted stdin and memory.

/** `helix_memory_commit`'s `content` field. */
export const MAX_COMMIT_CONTENT_CHARS = 16_384;

/** `helix_dual_verify`'s `question` field. Sits under dual-verify's 200,000-char egress cap (see
 *  header) — a per-field cap, not summed with MAX_DV_ANSWER_CHARS. */
export const MAX_DV_QUESTION_CHARS = 65_536;

/** `helix_dual_verify`'s `helixAnswer` field. Same reasoning as MAX_DV_QUESTION_CHARS. */
export const MAX_DV_ANSWER_CHARS = 65_536;

/** `helix_memory_recheck`'s `check.path` field. */
export const MAX_RECHECK_PATH_CHARS = 4_096;

/** `helix_memory_recheck`'s `check.pattern` field. */
export const MAX_RECHECK_PATTERN_CHARS = 2_048;

/** Accumulate-to-EOF stdin reads in `src/hooks/session-start.ts` and `src/hooks/session-end.ts`
 *  (each named `readStdin`). A BYTE cap, not a char cap: it bounds the raw read before any JSON
 *  parse or text decoding happens. */
export const HOOK_STDIN_MAX_BYTES = 1_048_576;

/** SessionEnd hook record's `sessionId` field (`src/hooks/session-record.ts`). */
export const MAX_SESSION_ID_CHARS = 128;

/** SessionEnd hook record's `reason` field (`src/hooks/session-record.ts`). */
export const MAX_SESSION_REASON_CHARS = 256;

/** Ceiling on `helix_memory_recall`'s optional `maxItems` argument. */
export const RECALL_MAX_ITEMS_CAP = 200;

/** Ceiling on `helix_memory_recall`'s optional `maxChars` argument (per-item render cap). */
export const RECALL_MAX_CHARS_CAP = 10_000;

/** Ceiling on any single MCP tool response's rendered character length. */
export const RESPONSE_MAX_CHARS = 262_144;
