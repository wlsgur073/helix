import { join } from 'node:path';
import { homedir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemoryStore } from '../memory/store.js';
import { digestContent } from '../memory/ledger-mac.js';
import type { RealityCheck } from '../memory/reality-check.js';
import { MAX_QUERY_CHARS } from '../memory/retrieval.js';
import {
  MAX_COMMIT_CONTENT_CHARS, MAX_DV_QUESTION_CHARS, MAX_DV_ANSWER_CHARS, MAX_DV_QUOTED_ITEMS,
  MAX_RECHECK_PATH_CHARS, MAX_RECHECK_PATTERN_CHARS, RECALL_MAX_ITEMS_CAP, RECALL_MAX_CHARS_CAP,
} from '../limits.js';
import { handleCommit, handleRecall, handleInspect, handleErase, handleAdopt, handleDualVerify, handleCodexStatus, handleRecheck, handleConfirm, MAX_ID_CHARS, isValidId, type DualVerifyHandlerDeps, type CodexStatusDeps } from './handlers.js';
import { loadConfig } from '../config.js';
import { realCodexRunner, checkCodexAvailable, checkCodexStatus, checkCodexModel } from '../verify/codex.js';
import { noopMetricsSink, type MetricsSink } from '../metrics.js';
import { isReviewableRoot } from '../memory/ownership.js';

// LEAD-AUDIT-ID-UNCONSTRAINED: mirrors handlers.ts's assertValidId at the MCP tool boundary itself.
// `.refine(isValidId)` (not a parallel `.min().max().regex()` chain) so the schema and the
// authoritative handlers.ts check share the SAME predicate, not just its constants (fix round 1
// Minor: a duplicated `.min(1).max().regex()` chain here could drift from handlers.ts's rule without
// either side noticing). A malformed id is rejected by the SDK's own schema validation before the
// handler (and its appendAudit call) ever runs, exactly like MAX_QUERY_CHARS below. Applied to every
// id-shaped argument (family-unit fix): erase/recheck/confirm's `id`, AND commit's `supersedes`
// (also an id-lookup value, just never audited). Exported (fix round 1 Minor) per the brief.
export const ID_SCHEMA = z.string().refine(isValidId, {
  message: `id must be 1-${MAX_ID_CHARS} printable, non-control characters`,
});

/** adopt's `projectRoot`, mirroring the ID_SCHEMA split above: the SAME predicate the store enforces
 *  (isReviewableRoot from ownership.ts), so the client-facing rejection and the authoritative one
 *  cannot drift. A relative or empty root resolves against the server's cwd — which IS the active
 *  project root — so it would clear the store's equality check while leaving the approval prompt with
 *  nothing to render. See isReviewableRoot's docstring for why absoluteness is the whole rule. */
export const PROJECT_ROOT_SCHEMA = z.string().refine(isReviewableRoot, {
  message: 'projectRoot must be an absolute path, so the approval prompt can show which ledger is being trusted',
});

/** Build a Helix MCP server with the memory tools registered against `store`. The returned object
 *  IS the McpServer (every existing caller keeps working unchanged) plus `drainInFlight`, so
 *  lifecycle.ts can wait out an in-flight helix_dual_verify handler before force-exiting. */
export function buildServer(store: MemoryStore, dualDeps?: DualVerifyHandlerDeps, metrics?: MetricsSink): McpServer & { drainInFlight: (budgetMs: number) => Promise<void> } {
  // Single dispatch seam: every tool handler runs inside m.runOp so store.emitReplay calls made
  // synchronously inside self-stamp the current op id (spec §5). Default noop = zero behavior change.
  const m = metrics ?? noopMetricsSink;
  const server = new McpServer({ name: 'helix', version: '0.1.0' });
  // The no-deps fallback must honor HELIX_HOME too, or it would silently read the real
  // ~/.helix/config.json and write the real audit log under test isolation (the index.ts
  // entry always passes explicit deps; this keeps a future caller from breaking isolation).
  const home = process.env.HELIX_HOME ?? join(homedir(), '.helix');
  const dv: DualVerifyHandlerDeps = dualDeps ?? {
    config: loadConfig({ globalPath: join(home, 'config.json') }),
    runner: realCodexRunner,
    checkAvailable: checkCodexAvailable,
    // inspect()'s own projection sets contentDigest unconditionally (store.ts:767), but the field is
    // optional on ScopedRecord for pairings built outside that projection. The fallback computes the
    // same pure function `inspect()` already applies rather than fabricating a value, so a record that
    // ever arrives without one is still matchable instead of silently unquotable.
    echo: { mode: 'enforce', ledgerTexts: () => store.inspect().map(({ record, contentDigest }) => ({ id: record.id, content: record.content, contentDigest: contentDigest ?? digestContent(record.content) })) },
    auditPath: join(home, 'audit.jsonl'),
    codexLogPath: join(home, 'codex-log.jsonl'),
  };

  const codexStatusDeps: CodexStatusDeps = {
    inspect: () => checkCodexStatus(),
    resolveModel: () => checkCodexModel(),
    config: dv.config,
    codexLogPath: dv.codexLogPath,
  };

  server.registerTool('helix_memory_commit', {
    title: 'Commit memory',
    description: 'Store a fact in Helix memory (secret-scanned; provenance recorded). Pass supersedes=<id> to update (replace) an existing item instead of adding a duplicate.',
    inputSchema: {
      // H3: the character bound is declared here as well as enforced in the store, so an oversized
      // commit is refused by schema validation before the handler (and its secret scan) ever runs —
      // the same bounded-input discipline MAX_QUERY_CHARS gets on recall above. The store keeps the
      // authoritative check for callers that do not come through MCP (hooks, CLI, tests).
      content: z
        .string()
        .max(MAX_COMMIT_CONTENT_CHARS)
        .describe(`The fact to store (max ${MAX_COMMIT_CONTENT_CHARS} characters; split the fact or store a pointer if it is longer).`),
      source: z
        .enum(['user', 'user-relayed', 'agent-inference', 'agent-test-verified'])
        .describe(
          "Provenance (required). 'user' = a fact the user stated as their own knowledge/preference/instruction. " +
          "'user-relayed' = content the user pasted/forwarded from a third party (web page, email, README, tool output) " +
          '— use this whenever the user is relaying, not authoring. ' +
          "'agent-inference' = a conclusion you derived this session, not yet confirmed against reality. " +
          "'agent-test-verified' = a conclusion you derived AND mechanically verified this session (e.g. by running tests); " +
          'still non-authoritative — it does not elevate trust.',
        ),
      blastRadius: z.enum(['read-only', 'local-reversible', 'hard-to-reverse', 'external']).optional(),
      classification: z.enum(['normal', 'personal']).optional(),
      supersedes: ID_SCHEMA.optional(),
      supersedesDigest: z
        .string()
        .regex(/^[0-9a-f]{64}$/, 'supersedesDigest must be a 64-character lowercase hex digest')
        .optional()
        .describe(
          'Required only when superseding a VERIFIED fact: the `supersedesDigest=` value shown for ' +
          'that row by helix_memory_inspect. Echoing it proves you retrieved the record you are ' +
          'replacing; a supersede issued without having read the target is refused.',
        ),
      scope: z.enum(['project', 'global']).optional(),
    },
  }, async (args) => m.runOp('helix_memory_commit', () => handleCommit(store, args)));

  server.registerTool('helix_memory_recall', {
    title: 'Recall memory',
    description: 'Recall relevant memory as a DATA-only block; flags items needing re-verification.',
    // The character bound is declared here as well as enforced in the store, so an oversized query
    // is refused by schema validation before it reaches a handler at all — the same bounded-input
    // discipline `maxItems` and `asOf` already get. The store keeps the authoritative check (it also
    // bounds distinct TERMS, which needs the tokenizer) for callers that do not come through MCP.
    inputSchema: {
      query: z.string().max(MAX_QUERY_CHARS),
      // M1 (2026-08-18 review): maxItems/maxChars accepted ANY positive integer — a caller could ask
      // for far more items, or a far larger per-item cap, than the response will ever actually
      // deliver (the handler's own RESPONSE_MAX_CHARS total bound drops the excess anyway). Capping
      // the inputs here too is a client-facing rejection instead of a silently-shrunk result.
      maxItems: z.number().int().positive().max(RECALL_MAX_ITEMS_CAP).optional(),
      // H5: count bounds are not size bounds — long prose items made a 30-item recall render
      // 74.6 KB. Per-item character cap; truncation is marked with an ellipsis.
      maxChars: z.number().int().positive().max(RECALL_MAX_CHARS_CAP).optional()
        .describe('Per-item character cap for rendered content (truncated with …). Use when the caller can only read a bounded result.'),
    },
  }, async (args) => m.runOp('helix_memory_recall', () => handleRecall(store, args)));

  server.registerTool('helix_memory_inspect', {
    title: 'Inspect memory',
    description: 'List current memory items (id, trust state, content). Pass history=true to also list closed items with their [tx, txTo) declared interval, OR asOf=<ISO instant> to reconstruct the point-in-time snapshot at that system-time (which facts were live, their grade, and the verify evidence). history and asOf are mutually exclusive.',
    inputSchema: { history: z.boolean().optional(), asOf: z.string().optional() },
  }, async (args) => m.runOp('helix_memory_inspect', () => handleInspect(store, args)));

  server.registerTool('helix_memory_erase', {
    title: 'Erase memory',
    description: 'Erase a memory item by id. Soft: the item is removed from the live view (recall/inspect) and the erase is recorded in the audit log, so an erroneous or poisoned erase can be detected and undone. This tool itself never physically destroys content. By default (compaction off) the erased content stays recoverable on disk indefinitely; but if the user has enabled compaction.auto, that recoverability is time-bounded — an ordinary helix_memory_recall can then compact the ledger and physically destroy it once the grace window (graceMs) has passed.',
    inputSchema: { id: ID_SCHEMA },
  }, async (args) => m.runOp('helix_memory_erase', () => handleErase(store, args, { auditPath: dv.auditPath, now: dv.now })));

  server.registerTool('helix_memory_recheck', {
    title: 'Recheck memory against reality',
    description:
      'Run a content-bound mechanical reality-check on a memory item. A pass yields the Corroborated ' +
      'trust state (machine-checked, NOT human-verified — it can NEVER reach Verified). The check is ' +
      'file-contains and BOTH path and pattern MUST appear in the item content, or the call is rejected ' +
      '(prevents laundering an unrelated passing check into trust). Use for objective, checkable facts.',
    inputSchema: {
      id: ID_SCHEMA,
      // H3: same bounded-input discipline as commit's content above -- an oversized path/pattern is
      // refused by schema validation before the handler (and its file read / checkBinding scan) runs.
      check: z.object({
        kind: z.literal('file-contains'),
        path: z.string().max(MAX_RECHECK_PATH_CHARS).describe(`File path to check (max ${MAX_RECHECK_PATH_CHARS} characters).`),
        pattern: z.string().max(MAX_RECHECK_PATTERN_CHARS).describe(`Substring the file must contain (max ${MAX_RECHECK_PATTERN_CHARS} characters).`),
      }),
    },
  }, async (args) => m.runOp('helix_memory_recheck', () => handleRecheck(store, args as { id: string; check: RealityCheck }, { auditPath: dv.auditPath, now: dv.now })));

  server.registerTool('helix_memory_confirm', {
    title: 'Confirm memory (user-vouched)',
    description:
      'Promote a memory item to the Verified state because THE USER explicitly vouched for it this turn. ' +
      'Requires explicit user approval; never self-confirm — call ONLY when the user directly confirmed the ' +
      'fact, never to confirm your own inference or a relayed claim. Only items committed with source=user ' +
      'are eligible (re-commit a relayed/inferred fact as source=user first). The user, not Helix, is the ' +
      'authority — do not allow-list this tool.',
    inputSchema: { id: ID_SCHEMA },
  }, async (args) => m.runOp('helix_memory_confirm', () => handleConfirm(store, args, { auditPath: dv.auditPath, now: dv.now })));

  // The ONLY tool that spawns a metered child, so it is the only one that gains the `extra`
  // parameter: the SDK's per-request AbortSignal (extra.signal), fired on both an explicit client
  // cancel and a transport close (protocol.js's _onclose aborts every pending request). Forwarded to
  // handleDualVerify so a cancel reaches codex.ts's kill wiring instead of being dropped on the floor.
  // The call is also tracked in `dualVerifyInFlight` so drainInFlight (below) can wait for its
  // completion audit row before lifecycle.ts force-exits.
  const dualVerifyInFlight = new Set<Promise<unknown>>();
  server.registerTool('helix_dual_verify', {
    title: 'Dual-verify with Codex',
    description: "Cross-validate your answer with Codex (config-gated; spends the user's Codex quota). Optional stakes are checked against the configured floor; an omitted stakes counts as 'low' — omission is not an exemption. quotedMemory declares memories this call deliberately quotes, each {id, contentDigest} pair a proof of read; resolved pairs are exempt from the memory-echo guard, unresolvable pairs are discarded.",
    inputSchema: {
      // H3: same bounded-input discipline as commit's content above -- an oversized question/answer
      // is refused by schema validation before the handler (and the JSON-parse allocation it would
      // otherwise pay for) runs. classifyEgress's downstream 200,000-char joint scan limit (see
      // limits.ts) is a separate, later gate; these caps exist to reject early, not to duplicate it.
      question: z.string().max(MAX_DV_QUESTION_CHARS).describe(`The question being verified (max ${MAX_DV_QUESTION_CHARS} characters).`),
      helixAnswer: z.string().max(MAX_DV_ANSWER_CHARS).describe(`Your answer to cross-validate (max ${MAX_DV_ANSWER_CHARS} characters).`),
      stakes: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
      // H6: proof-of-read declarations. SIZE-bounded only (array length + per-string chars): the
      // guard DISCARDS a pair that does not resolve against the ledger, so validity refinements
      // here would turn the designed discard-semantics into a whole-call refusal (a stale digest
      // is indistinguishable from a wrong one — dual-verify.ts / trifecta.ts carry the argument).
      quotedMemory: z.array(z.object({
        id: z.string().max(MAX_ID_CHARS).describe('Ledger id of the record being quoted.'),
        contentDigest: z.string().max(64).describe("The record's contentDigest (sha-256 hex) as proof of read."),
      })).max(MAX_DV_QUOTED_ITEMS).optional()
        .describe(`Memories this call deliberately quotes; resolved pairs are exempted from the memory-echo guard (max ${MAX_DV_QUOTED_ITEMS} pairs).`),
    },
  }, async (args, extra) => {
    const call = m.runOp('helix_dual_verify', () => handleDualVerify(args, dv, extra?.signal));
    dualVerifyInFlight.add(call);
    try {
      return await call;
    } finally {
      dualVerifyInFlight.delete(call);
    }
  });

  server.registerTool('helix_codex_status', {
    title: 'Codex status',
    description: 'Show whether Helix is connected to Codex (CLI/version, login, auth mode), the dual-verify config, and the content-log state. Free — no metered Codex call.',
    inputSchema: {},
  }, async () => m.runOp('helix_codex_status', () => handleCodexStatus(codexStatusDeps)));

  server.registerTool('helix_memory_adopt', {
    title: 'Adopt project memory',
    description:
      "Trust the current project's pre-existing memory file (only for a ledger you recognize, e.g. a " +
      'team-shared one). Default-deny: an unrecognized project ledger is ignored until adopted. Pass ' +
      'the project root you mean; a root that is not the active scope is refused and adopts nothing. ' +
      'This moves a trust boundary — everything in that ledger becomes recallable — so the user, not ' +
      'Helix, is the authority: call only on explicit user instruction, and do not allow-list this tool.',
    inputSchema: { projectRoot: PROJECT_ROOT_SCHEMA },
  }, async (args) => m.runOp('helix_memory_adopt', () => handleAdopt(store, args, { auditPath: dv.auditPath, now: dv.now })));

  return Object.assign(server, {
    // Bounded by construction: resolves once every tracked call has settled OR budgetMs elapses,
    // whichever comes first -- never waits indefinitely, so a hung handler cannot turn a shutdown
    // into a hang (that would just trade one defect for a worse one).
    async drainInFlight(budgetMs: number): Promise<void> {
      if (dualVerifyInFlight.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); });
      try {
        await Promise.race([Promise.allSettled([...dualVerifyInFlight]), timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
