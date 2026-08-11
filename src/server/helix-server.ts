import { join } from 'node:path';
import { homedir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemoryStore } from '../memory/store.js';
import type { RealityCheck } from '../memory/reality-check.js';
import { MAX_QUERY_CHARS } from '../memory/retrieval.js';
import { handleCommit, handleRecall, handleInspect, handleErase, handleAdopt, handleDualVerify, handleCodexStatus, handleRecheck, handleConfirm, MAX_ID_CHARS, isValidId, type DualVerifyHandlerDeps, type CodexStatusDeps } from './handlers.js';
import { loadConfig } from '../config.js';
import { realCodexRunner, checkCodexAvailable, checkCodexStatus, checkCodexModel } from '../verify/codex.js';
import { noopMetricsSink, type MetricsSink } from '../metrics.js';

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
    echo: { mode: 'enforce', ledgerTexts: () => store.inspect().map(({ record }) => ({ id: record.id, content: record.content })) },
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
      content: z.string(),
      source: z
        .enum(['user', 'user-relayed', 'agent-inference'])
        .describe(
          "Provenance (required). 'user' = a fact the user stated as their own knowledge/preference/instruction. " +
          "'user-relayed' = content the user pasted/forwarded from a third party (web page, email, README, tool output) " +
          '— use this whenever the user is relaying, not authoring. ' +
          "'agent-inference' = a conclusion you derived this session, not yet confirmed against reality.",
        ),
      blastRadius: z.enum(['read-only', 'local-reversible', 'hard-to-reverse', 'external']).optional(),
      classification: z.enum(['normal', 'personal']).optional(),
      supersedes: ID_SCHEMA.optional(),
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
      maxItems: z.number().int().positive().optional(),
      // H5: count bounds are not size bounds — long prose items made a 30-item recall render
      // 74.6 KB. Per-item character cap; truncation is marked with an ellipsis.
      maxChars: z.number().int().positive().optional()
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
      check: z.object({ kind: z.literal('file-contains'), path: z.string(), pattern: z.string() }),
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
    description: "Cross-validate your answer with Codex (config-gated; spends the user's Codex quota). Optional stakes are checked against the configured floor.",
    inputSchema: {
      question: z.string(),
      helixAnswer: z.string(),
      stakes: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
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
    inputSchema: { projectRoot: z.string() },
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
