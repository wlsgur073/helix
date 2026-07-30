#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MemoryStore } from '../memory/store.js';
import { parseLedger } from '../memory/ledger.js';
import { scanLegacyElevated } from '../memory/legacy-scan.js';
import { subkeyForScope } from '../memory/verified-read.js';
import { canonicalRoot } from '../memory/ownership.js';
import { strayTrustFiles } from '../memory/trust-store-layout.js';
import { verifyVerify } from '../memory/ledger-mac.js';
import { buildServer } from './helix-server.js';
import { installSelfTermination } from './lifecycle.js';
import { loadConfig, compactionConfigFromGlobal } from '../config.js';
import { createMetricsSink } from '../metrics.js';
import { realCodexRunner, checkCodexAvailable } from '../verify/codex.js';

// HELIX_HOME is where ALL user-level state lives: the ledger by default, the global config, the
// audit log, and — always, regardless of HELIX_LEDGER — the trust store (signing key, ownership
// registry, rollback witness). The acceptance suite uses it for hermetic isolation.
const home = process.env.HELIX_HOME ?? join(homedir(), '.helix');
const globalLedger = process.env.HELIX_LEDGER ?? join(home, 'memory.jsonl');
const projectRoot = process.cwd();
const projectLedger = join(projectRoot, '.helix', 'memory.jsonl');
// The project layer is active only when <cwd>/.helix/ exists (mirrors config's existence-gated
// project layer) — so Helix never litters a non-Helix dir and a bare cwd stays global-only.
// The cwd == ~ collision (project ledger == global ledger) also disables it.
const projectActive = existsSync(join(projectRoot, '.helix'))
  // realpath, not textual resolve: a symlinked .helix that points the project ledger AT the global
  // ledger is ONE physical file — treat it as a collision and stay global-only.
  && canonicalRoot(projectLedger) !== canonicalRoot(globalLedger);
const project = projectActive ? { ledger: projectLedger, root: projectRoot, home } : undefined;

// One config load drives both the store's metrics sink and the server deps. The real sink writes
// content-free records to ~/.helix/metrics.jsonl, gated by config.metrics.enabled (noop when off).
const config = loadConfig({ globalPath: join(home, 'config.json') });
const metrics = createMetricsSink(join(home, 'metrics.jsonl'), config.metrics.enabled);

// REFUSE to start on a split trust store. Before the store's `home` was pinned, it was derived from
// the LEDGER's directory, so anyone using HELIX_LEDGER had their signing key, registry and witness
// created out there. Starting anyway would mint a fresh key beside the pinned home — silently
// revoking every grade the old key conferred and orphaning a witness that still attests to this
// scope, so a rollback against the old state would no longer be detectable. That is a trust reset
// performed on the user's behalf without telling them. This check must precede BOTH the store
// construction and the integrity scan below: the read path mints a scope nonce as soon as a master
// exists, so anything that touches the ledger first has already changed the state we are judging.
const stray = strayTrustFiles(home, globalLedger);
if (stray.length > 0) {
  process.stderr.write(                                                             // ASCII only
    `helix: REFUSING TO START - trust-store files were found next to the ledger instead of under HELIX_HOME.\n` +
    `  found next to the ledger: ${stray.join(', ')}\n` +
    `  ledger directory        : ${dirname(globalLedger)}\n` +
    `  HELIX_HOME              : ${home}\n` +
    `These were created by an older version, which derived the trust store's location from HELIX_LEDGER.\n` +
    `The signing key now always lives under HELIX_HOME, so starting would mint a NEW key and silently\n` +
    `drop every trust grade the old one conferred. Two ways out, both deliberate:\n` +
    `  1. Move ${stray.join(', ')} from the ledger directory into HELIX_HOME, keeping the ledger where it is.\n` +
    `  2. Discard the old trust state (delete those files) and re-establish it with the re-baseline\n` +
    `     ceremony: node bin/helix-rebaseline.mjs --scope global\n`,
  );
  process.exit(78); // EX_CONFIG
}

// Auto-compaction is read GLOBAL-only (never via loadConfig's project layer): it is destructive — it
// can close the soft-erase undo window — so a foreign checkout's `.helix/config.json` must never be
// able to enable or tune it. Default OFF; the store's own gates decide whether it ever fires.
const store = new MemoryStore(globalLedger, { home, sessionId: process.env.HELIX_SESSION ?? 'cli', project, metricsSink: metrics, compaction: compactionConfigFromGlobal(home) });

// WRITE-side witness startup heal (spec §4.9): complete any rewrite that crashed after its bytes
// landed but before the journal cleared (crash window B), for global + an owned project. Best-effort,
// runs once here — NEVER from a hook (a read-only surface must not advance the witness).
store.healWitness();

// Verifying integrity scan (spec §7): surface only records the verifying replay would NOT honour —
// a `verify` whose MAC fails under the scope subkey (forged/legacy-unsigned) or a baked non-Fresh
// assert/supersede (R1 clamps it to Fresh). A genuine SIGNED verify (which confirm/recheck now mint
// routinely) is NOT flagged, so the §7 warning stays a forged-elevation detector instead of firing on
// every legitimately-elevated ledger. Subkey resolution mirrors the store/hook (subkeyForScope) so
// the scan asks the exact same validity question the live projection does. ADVISORY only — wrapped so
// a malformed/unreadable ledger (parseLedger rethrows non-ENOENT I/O errors) degrades to no-warning,
// never blocks startup. Output stays content-free (a count only).
const scanScopes: Array<{ ledger: string; root?: string }> = [
  { ledger: globalLedger },
  ...(project ? [{ ledger: project.ledger, root: project.root }] : []),
];
for (const { ledger, root } of scanScopes) {
  try {
    const subkey = subkeyForScope(home, root);
    const scan = scanLegacyElevated(parseLedger(ledger), (r) => (subkey ? verifyVerify(r, subkey) : false));
    if (!scan.ok) process.stderr.write(`helix: WARNING - ${scan.offenders.length} forged/legacy elevated record(s) in ${ledger}; trust states there are not tool-minted\n`); // ASCII only
  } catch { /* advisory: never block startup */ }
}

const server = buildServer(store, {
  config,
  runner: realCodexRunner,
  checkAvailable: checkCodexAvailable,
  echo: { mode: 'enforce', ledgerTexts: () => store.inspect().map(({ record }) => ({ id: record.id, content: record.content })) },
  auditPath: join(home, 'audit.jsonl'),
  codexLogPath: join(home, 'codex-log.jsonl'),
}, metrics);
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
