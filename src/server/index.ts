#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MemoryStore } from '../memory/store.js';
import { parseLedger } from '../memory/ledger.js';
import { scanLegacyElevated } from '../memory/legacy-scan.js';
import { hardenHomePermissions } from '../memory/home-permissions.js';
import { subkeyForScope } from '../memory/verified-read.js';
import { aliasesGlobalLedger } from '../memory/scope-target.js';
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
// The project LEDGER layer is active only when <cwd>/.helix/ exists — so Helix never litters a
// non-Helix dir and a bare cwd stays global-only. The cwd == ~ collision (project ledger == global
// ledger) also disables it. Note this gate is about the ledger alone: config no longer has a
// cwd-discovered project layer to mirror, since a repo must not configure the process reading it.
const projectActive = existsSync(join(projectRoot, '.helix'))
  // One physical file is never two scopes — see aliasesGlobalLedger for why this is canonical and
  // not textual, and for the census of the call sites that share this rule.
  && !aliasesGlobalLedger(projectLedger, globalLedger);
const project = projectActive ? { ledger: projectLedger, root: projectRoot } : undefined;

// One config load drives both the store's metrics sink and the server deps. The real sink writes
// content-free records to ~/.helix/metrics.jsonl, gated by config.metrics.enabled (noop when off).
// GLOBAL-ONLY, and deliberately so: `projectPath` is omitted, which now means there is no project
// layer at all. A checkout's own config.json is not a configuration source for the process that
// opened it — see loadConfig's note for why ownership and tighten-only were rejected as gates.
// Repair an over-broad HELIX_HOME before anything reads or writes inside it. Creation-time modes
// only cover files this version creates; every file a shipped version already wrote keeps the mode
// it was born with. Runs before loadConfig deliberately: config.json is authority-bearing, so it
// should be owner-only BEFORE its contents are trusted. Warn-and-fix and never throws — see
// hardenHomePermissions for why an over-broad mode is not treated as evidence of tampering.
hardenHomePermissions(home, { warn: (m) => process.stderr.write(`${m}\n`) });
const config = loadConfig({ globalPath: join(home, 'config.json') });
// Say so when such a file exists. Silence here would be a regression in operator feedback, since a
// project config with an INVALID value still warned when the layer was read — a user following older
// guidance would otherwise get no signal at all that their settings stopped applying.
if (existsSync(join(projectRoot, '.helix', 'config.json'))) {
  process.stderr.write(`helix: NOTE - ${join(projectRoot, '.helix', 'config.json')} is not read; dual-verify, egress and logging settings come only from ${join(home, 'config.json')}\n`); // ASCII only
}
const metrics = createMetricsSink(join(home, 'metrics.jsonl'), config.metrics.enabled);

// REFUSE to start on a split trust store — but ONLY when there is a genuine migration left to
// protect. Before the store's `home` was pinned, it was derived from the LEDGER's directory, so
// anyone using HELIX_LEDGER had their signing key, registry and witness created out there. Starting
// anyway, on a HOME THAT HAS NO KEY OF ITS OWN YET, would mint a fresh one beside the stray files —
// silently revoking every grade the old key conferred and orphaning a witness that still attests to
// this scope, so a rollback against the old state would no longer be detectable. That is a trust
// reset performed on the user's behalf without telling them, and it is the only scenario this must
// block: once HELIX_HOME already has its own master key, starting does NOT mint a new one — that key
// was already established (by an earlier migration, or the re-baseline ceremony), so files still
// sitting beside the ledger are orphaned leftovers, not a migration in progress. Blocking startup
// forever over inert leftovers is itself the denial of service this gate must not become (see
// docs/issues/repros/f1-detector-startup-dos.ts), so that case is downgraded to a warning.
// This check must precede BOTH the store construction and the integrity scan below: the read path
// mints a scope nonce as soon as a master exists, so anything that touches the ledger first has
// already changed the state we are judging.
const stray = strayTrustFiles(home, globalLedger);
const homeHasOwnMasterKey = existsSync(join(home, 'ledger-mac-master.key'));
if (stray.length > 0 && !homeHasOwnMasterKey) {
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
} else if (stray.length > 0) {
  process.stderr.write(                                                             // ASCII only
    `helix: NOTE - trust-store-shaped files were found next to the ledger, but HELIX_HOME already has\n` +
    `  its own signing key, so starting will NOT touch them and will NOT mint a new key over them.\n` +
    `  found next to the ledger: ${stray.join(', ')}\n` +
    `  ledger directory        : ${dirname(globalLedger)}\n` +
    `  HELIX_HOME              : ${home}\n` +
    `These are most likely left over from before HELIX_HOME had a key of its own. If they still hold\n` +
    `state you need, move ${stray.join(', ')} into HELIX_HOME by hand; otherwise it is safe to\n` +
    `delete them from the ledger directory — this note will keep appearing until they are gone.\n`,
  );
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
  drainInFlight: (budgetMs) => server.drainInFlight(budgetMs),
  onSignal: (sig, handler) => { process.on(sig, handler); },
  exit: (code) => process.exit(code),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  log: (msg) => { process.stderr.write(msg + '\n'); }, // ASCII only
});
