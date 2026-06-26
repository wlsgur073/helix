#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MemoryStore } from '../memory/store.js';
import { parseLedger } from '../memory/ledger.js';
import { scanLegacyElevated } from '../memory/legacy-scan.js';
import { buildServer } from './helix-server.js';
import { installSelfTermination } from './lifecycle.js';
import { loadConfig } from '../config.js';
import { realCodexRunner, checkCodexAvailable } from '../verify/codex.js';

// HELIX_HOME relocates ALL user-level state (ledger, global config, audit) in one knob —
// the acceptance suite uses it for hermetic isolation. Project config stays cwd-relative.
const home = process.env.HELIX_HOME ?? join(homedir(), '.helix');
const globalLedger = process.env.HELIX_LEDGER ?? join(home, 'memory.jsonl');
const projectRoot = process.cwd();
const projectLedger = join(projectRoot, '.helix', 'memory.jsonl');
// The project layer is active only when <cwd>/.helix/ exists (mirrors config's existence-gated
// project layer) — so Helix never litters a non-Helix dir and a bare cwd stays global-only.
// The cwd == ~ collision (project ledger == global ledger) also disables it.
const projectActive = existsSync(join(projectRoot, '.helix'))
  && resolve(projectLedger) !== resolve(globalLedger);
const project = projectActive ? { ledger: projectLedger, root: projectRoot, home } : undefined;

const store = new MemoryStore(globalLedger, { sessionId: process.env.HELIX_SESSION ?? 'cli', project });

// One-time integrity scan (spec §7): a record above Fresh or any `verify` event predates this
// feature (store.verify was unwired), so it is a legacy/forged elevation pure replay would surface
// as legitimately-Verified. Warn the operator. ADVISORY only — wrapped so a malformed/unreadable
// ledger (parseLedger rethrows non-ENOENT I/O errors) degrades to no-warning, never blocks startup.
for (const ledger of [globalLedger, ...(project ? [project.ledger] : [])]) {
  try {
    const scan = scanLegacyElevated(parseLedger(ledger));
    if (!scan.ok) process.stderr.write(`helix: WARNING - ${scan.offenders.length} pre-existing elevated/verify record(s) in ${ledger}; trust states there are not tool-minted\n`); // ASCII only
  } catch { /* advisory: never block startup */ }
}

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
installSelfTermination({
  stdin: process.stdin,
  stdout: process.stdout,
  transport,
  closeServer: () => server.close(),
  onSignal: (sig, handler) => { process.on(sig, handler); },
  exit: (code) => process.exit(code),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  log: (msg) => { process.stderr.write(msg + '\n'); }, // ASCII only
});
