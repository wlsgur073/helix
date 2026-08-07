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
import { strayTrustFiles, assessGradeLoss } from '../memory/trust-store-layout.js';
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

// REFUSE to start on a split trust store — but ONLY when starting would actually LOSE a trust grade.
// Before the store's `home` was pinned, it was derived from the LEDGER's directory, so anyone using
// HELIX_LEDGER had their signing key, registry and witness created out there.
//
// Two proxies were tried here before this one and both broke: key PRESENCE ("does HOME have a key")
// missed that the harm is re-grading under the wrong key, not minting; key IDENTITY
// (`compareStrayMasterKey` — kept, still sound, just no longer the decider here) fixed that but was
// itself too conservative, refusing whenever there was no stray key to compare against — which
// re-opened this exact denial of service: on a HEALTHY install (HOME already has its own key), an
// adversary who can write beside the ledger plants ONE shape-valid stray file (say, a bare
// `witness.json`) and every session dies at exit 78, even though nothing is at risk.
//
// So the gate now measures the loss directly (`assessGradeLoss`; see its doc for the two paths a
// grade actually disappears by). A ledger with nothing elevated in play — empty, fresh, or every
// record still Fresh — can never fail this check, key or witness state notwithstanding: that is what
// keeps a bare stray file from ever blocking startup (docs/issues/repros/f1-detector-startup-dos.ts),
// while a ledger that genuinely stands to lose a grade still refuses (docs/issues/repros/
// f1-helix-ledger-trust-store.ts's sibling scenario: normal use established HOME's own trust state,
// then a pre-pin version built a second one beside a relocated ledger).
// This check must precede store construction: the read path mints a scope nonce as soon as a master
// exists, so anything that touches the ledger first has already changed the state we are judging.
const stray = strayTrustFiles(home, globalLedger);
if (stray.length > 0) {
  const ledgerDir = dirname(globalLedger);
  const loss = assessGradeLoss(home, globalLedger);
  if (!loss.loses) {
    process.stderr.write(                                                             // ASCII only
      `helix: NOTE - trust-store-shaped files were found next to the ledger, but starting will NOT\n` +
      `  lose any trust grade this ledger currently carries (measured, not inferred from key or file\n` +
      `  presence alone).\n` +
      `  found next to the ledger: ${stray.join(', ')}\n` +
      `  ledger directory        : ${ledgerDir}\n` +
      `  HELIX_HOME              : ${home}\n` +
      `They are most likely an inert leftover, from before the trust store's location was pinned to\n` +
      `HELIX_HOME or from a repo-writing adversary. If they still hold state you need, move\n` +
      `${stray.join(', ')} into HELIX_HOME by hand; otherwise it is safe to delete them from the\n` +
      `ledger directory - this note will keep appearing until they are gone.\n`,
    );
  } else {
    const causes: string[] = [];
    if (loss.undecidable !== null) {
      causes.push(
        `  - HELIX_HOME's own trust state could not be read (${loss.undecidable}), so whether starting\n` +
        `    is lossless could not be established at all. Starting anyway would mint a replacement key\n` +
        `    and re-grade this ledger under it - the exact silent trust reset this check prevents.\n`,
      );
    }
    if (loss.unverifiableRecordIds.length > 0) {
      causes.push(
        `  - ${loss.unverifiableRecordIds.length} record(s) (${loss.unverifiableRecordIds.join(', ')}) do not verify\n` +
        `    under HELIX_HOME's own signing key: their elevated grade would never be recognized again.\n`,
      );
    }
    if (loss.clampedRecordIds.length > 0) {
      causes.push(
        `  - HELIX_HOME's rollback witness for this ledger does not match its current content, which\n` +
        `    would clamp ${loss.clampedRecordIds.length} already-elevated record(s) (${loss.clampedRecordIds.join(', ')})\n` +
        `    to Fresh (store.ts's mismatch guard).\n`,
      );
    }
    process.stderr.write(                                                             // ASCII only
      `helix: REFUSING TO START - trust-store files were found next to the ledger instead of under HELIX_HOME,\n` +
      (loss.undecidable !== null
        ? `and whether starting would lose a trust grade this ledger carries could not be determined:\n`
        : `and starting would lose a trust grade this ledger currently carries:\n`) +
      `  found next to the ledger: ${stray.join(', ')}\n` +
      `  ledger directory        : ${ledgerDir}\n` +
      `  HELIX_HOME              : ${home}\n` +
      `${causes.join('')}` +
      `Two ways out, both deliberate:\n` +
      `  1. Move ${stray.join(', ')} from the ledger directory into HELIX_HOME, keeping the ledger where it\n` +
      `     is - the only remedy proven lossless (docs/issues/repros/f1-manual-remedy.ts).\n` +
      `  2. Discard the old trust state (delete those files) and accept the loss deliberately with the\n` +
      `     re-baseline ceremony: node bin/helix-rebaseline.mjs --scope global\n`,
    );
    process.exit(78); // EX_CONFIG
  }
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
