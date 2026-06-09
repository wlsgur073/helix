#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MemoryStore } from '../memory/store.js';
import { buildServer } from './helix-server.js';

const ledger = process.env.HELIX_LEDGER ?? join(homedir(), '.helix', 'memory.jsonl');
const store = new MemoryStore(ledger, { sessionId: process.env.HELIX_SESSION ?? 'cli' });
const server = buildServer(store);
const transport = new StdioServerTransport();
await server.connect(transport);
