#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MemoryStore } from '../memory/store.js';
import { buildServer } from './helix-server.js';
import { loadConfig } from '../config.js';
import { realCodexRunner, checkCodexAvailable } from '../verify/codex.js';

// HELIX_HOME relocates ALL user-level state (ledger, global config, audit) in one knob —
// the acceptance suite uses it for hermetic isolation. Project config stays cwd-relative.
const home = process.env.HELIX_HOME ?? join(homedir(), '.helix');
const ledger = process.env.HELIX_LEDGER ?? join(home, 'memory.jsonl');

const store = new MemoryStore(ledger, { sessionId: process.env.HELIX_SESSION ?? 'cli' });
const server = buildServer(store, {
  config: loadConfig({ globalPath: join(home, 'config.json') }),
  runner: realCodexRunner,
  checkAvailable: checkCodexAvailable,
  echo: { mode: 'enforce', ledgerTexts: () => store.inspect().map(({ record }) => ({ id: record.id, content: record.content })) },
  auditPath: join(home, 'audit.jsonl'),
  codexLogPath: join(home, 'codex-log.jsonl'),
});
const transport = new StdioServerTransport();
await server.connect(transport);
