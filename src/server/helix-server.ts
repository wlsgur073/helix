import { join } from 'node:path';
import { homedir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemoryStore } from '../memory/store.js';
import { handleCommit, handleRecall, handleInspect, handleErase, handleAdopt, handleDualVerify, handleCodexStatus, type DualVerifyHandlerDeps, type CodexStatusDeps } from './handlers.js';
import { loadConfig } from '../config.js';
import { realCodexRunner, checkCodexAvailable, checkCodexStatus } from '../verify/codex.js';

/** Build a Helix MCP server with the memory tools registered against `store`. */
export function buildServer(store: MemoryStore, dualDeps?: DualVerifyHandlerDeps): McpServer {
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
      supersedes: z.string().optional(),
      scope: z.enum(['project', 'global']).optional(),
    },
  }, async (args) => handleCommit(store, args));

  server.registerTool('helix_memory_recall', {
    title: 'Recall memory',
    description: 'Recall relevant memory as a DATA-only block; flags items needing re-verification.',
    inputSchema: { query: z.string(), maxItems: z.number().int().positive().optional() },
  }, async (args) => handleRecall(store, args));

  server.registerTool('helix_memory_inspect', {
    title: 'Inspect memory',
    description: 'List current memory items (id, trust state, content).',
    inputSchema: {},
  }, async () => handleInspect(store, {}));

  server.registerTool('helix_memory_erase', {
    title: 'Erase memory',
    description: 'Erase a memory item by id. Soft-only: the item is removed from the live view (recall/inspect) but remains recoverable on disk (no compaction) and the erase is recorded in the audit log, so an erroneous or poisoned erase can be detected and undone. This tool cannot physically destroy content — genuine right-to-erasure (compaction) is handled outside the agent tool surface.',
    inputSchema: { id: z.string() },
  }, async (args) => handleErase(store, args, { auditPath: dv.auditPath, now: dv.now }));

  server.registerTool('helix_dual_verify', {
    title: 'Dual-verify with Codex',
    description: "Cross-validate your answer with Codex (config-gated; spends the user's Codex quota). Optional stakes are checked against the configured floor.",
    inputSchema: {
      question: z.string(),
      helixAnswer: z.string(),
      stakes: z.enum(['low', 'medium', 'high']).optional(),
    },
  }, async (args) => handleDualVerify(args, dv));

  server.registerTool('helix_codex_status', {
    title: 'Codex status',
    description: 'Show whether Helix is connected to Codex (CLI/version, login, auth mode), the dual-verify config, and the content-log state. Free — no metered Codex call.',
    inputSchema: {},
  }, async () => handleCodexStatus(codexStatusDeps));

  server.registerTool('helix_memory_adopt', {
    title: 'Adopt project memory',
    description: "Trust the current project's pre-existing memory file (only for a ledger you recognize, e.g. a team-shared one). Default-deny: an unrecognized project ledger is ignored until adopted.",
    inputSchema: {},
  }, async () => handleAdopt(store, {}));

  return server;
}
