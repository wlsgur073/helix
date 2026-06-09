import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemoryStore } from '../memory/store.js';
import { handleCommit, handleRecall, handleInspect, handleErase, handleDualVerify } from './handlers.js';

/** Build a Helix MCP server with the memory tools registered against `store`. */
export function buildServer(store: MemoryStore): McpServer {
  const server = new McpServer({ name: 'helix', version: '0.1.0' });

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
    title: 'Dual-verify (Phase 3 stub)',
    description: 'Cross-validate an answer with Codex. Not available until Phase 3.',
    inputSchema: { question: z.string() },
  }, async (args) => handleDualVerify(store, args));

  return server;
}
