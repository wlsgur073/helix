// H3/M1 (2026-08-18 review; header corrected I2, 2026-08-20 review): every resource/response cap
// Helix enforces is declared here ONCE. The RULE each constant is meant to serve is dual
// enforcement — schema AND core, because a cap enforced in only one place is a cap an alternate
// entry path does not have — but that rule is met by different mechanisms per constant, not by one
// uniform pair of checks everywhere below.
//
// MAX_COMMIT_CONTENT_CHARS is the one constant enforced literally both ways: the MCP schema
// (`helix-server.ts:75-78`) rejects an oversized `content` before the handler runs, and the store
// (`store.ts:218-225`, `MemoryStore.commit`) rejects it again, so a caller into `store.commit` that
// does not come through the MCP schema (hooks, CLI, tests) still cannot persist an oversized fact.
//
// MAX_DV_QUESTION_CHARS/MAX_DV_ANSWER_CHARS and MAX_RECHECK_PATH_CHARS/MAX_RECHECK_PATTERN_CHARS are
// schema-only — no core code reads these four constants — but each pair still has a core-side bound,
// through a DIFFERENT, pre-existing mechanism at a DIFFERENT value, not a second read of the
// constant. Dual-verify's `question` and `helixAnswer` are jointly bounded by `classifyEgress`
// (`src/risk/trifecta.ts:243,247`), which joins the two with a newline and compares that length
// against its own 200,000-char scan limit, chosen independently of this table (see "Measured cause"
// below for why the schema caps sit under 200,000 rather than at it — they pre-empt the allocation,
// they do not duplicate the scan). Recheck's `path`/`pattern` are bounded TRANSITIVELY: `store.
// recheck` (`store.ts:708-711`) runs `checkBinding(target.content, check)` before any file read, and
// `checkBinding` (`src/memory/reality-check.ts:84-89`) refuses unless both strings are raw
// substrings of the item's own `content` — so path and pattern can never exceed the 16,384-char
// commit cap that already bounds `content`, even though nothing checks them against
// MAX_RECHECK_PATH_CHARS/MAX_RECHECK_PATTERN_CHARS outside the schema.
//
// RECALL_MAX_ITEMS_CAP/RECALL_MAX_CHARS_CAP are schema-only, with no separate core mechanism (the
// response they shape is already bounded by RESPONSE_MAX_CHARS below). HOOK_STDIN_MAX_BYTES,
// MAX_SESSION_ID_CHARS, MAX_SESSION_REASON_CHARS and RESPONSE_MAX_CHARS are core-only — none has an
// MCP schema, either because the input never crosses the MCP schema boundary (hook stdin, session
// fields) or because the constant bounds an output rather than an input (the response cap).
// HOOK_STDIN_MAX_BYTES bounds the accumulate-to-EOF stdin reads in `src/hooks/session-start.ts` and
// `src/hooks/session-end.ts`, which have no schema layer at all — the hook process itself is the
// only reader standing between an untrusted stdin and memory.
//
// Measured cause (why MAX_COMMIT_CONTENT_CHARS is 16,384): a 1 MiB `helix_memory_commit` became a
// ~1.049 MB persistent ledger record AND a ~1.049 MB tool response, because projection, retrieval
// and inspect each re-read and re-tokenize the same stored content — one oversized commit pays its
// cost on every later read, not once at write time.

/** `helix_memory_commit`'s `content` field. */
export const MAX_COMMIT_CONTENT_CHARS = 16_384;

/** `helix_dual_verify`'s `question` field. `classifyEgress` (src/risk/trifecta.ts) joins `question`
 *  and `helixAnswer` with a newline into one string and compares THAT joined length against its
 *  200,000-char scan limit — so the pair is bounded JOINTLY, not just per field. This cap and
 *  MAX_DV_ANSWER_CHARS are chosen so both the individual field and their sum stay under 200,000
 *  (test/limits.test.ts asserts both). Raising either cap without re-checking the sum can turn every
 *  dual-verify call into a scan-limit refusal. */
export const MAX_DV_QUESTION_CHARS = 65_536;

/** `helix_dual_verify`'s `helixAnswer` field. Same reasoning as MAX_DV_QUESTION_CHARS — see there. */
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
