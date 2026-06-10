import { join } from 'node:path';
import { homedir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemoryStore } from '../memory/store.js';
import { handleCommit, handleRecall, handleInspect, handleErase, handleDualVerify, type DualVerifyHandlerDeps } from './handlers.js';
import { loadConfig } from '../config.js';
import { realCodexRunner, checkCodexAvailable } from '../verify/codex.js';

/** Build a Helix MCP server with the memory tools registered against `store`. */
export function buildServer(store: MemoryStore, dualDeps?: DualVerifyHandlerDeps): McpServer {
  const server = new McpServer({ name: 'helix', version: '0.1.0' });
  const dv: DualVerifyHandlerDeps = dualDeps ?? {
    config: loadConfig(),
    runner: realCodexRunner,
    checkAvailable: checkCodexAvailable,
    auditPath: join(homedir(), '.helix', 'audit.jsonl'),
  };

  server.registerTool('helix_memory_commit', {
    title: 'Commit memory',
    description: 'Store a fact in Helix memory (secret-scanned; provenance recorded).',
    inputSchema: {
      content: z.string(),
      source: z.enum(['user', 'reality-check', 'codex-agree']).optional(),
      blastRadius: z.enum(['read-only', 'local-reversible', 'hard-to-reverse', 'external']).optional(),
      classification: z.enum(['normal', 'personal']).optional(),
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
    description: 'Physically erase a memory item by id (compaction; satisfies right-to-erasure).',
    inputSchema: { id: z.string() },
  }, async (args) => handleErase(store, args));

  server.registerTool('helix_dual_verify', {
    title: 'Dual-verify with Codex',
    description: "Cross-validate your answer with Codex (config-gated; spends the user's Codex quota). Optional stakes are checked against the configured floor.",
    inputSchema: {
      question: z.string(),
      helixAnswer: z.string(),
      stakes: z.enum(['low', 'medium', 'high']).optional(),
    },
  }, async (args) => handleDualVerify(args, dv));

  return server;
}
