// User-only TTY re-baseline ceremony CLI (spec 2026-07-17-high-water-counter-decision §6, D2). The
// ONLY sanctioned path that lowers/re-blesses a scope's rollback witness: gated behind an
// interactive confirmation, NEVER registered as an MCP tool (grep src/server — it isn't wired
// there), so a shell-capable agent gets no more authority over the witness than any other write.
//
// Flow (exact, spec §6/§7): display the current byte hash + verdict + the epoch this would bump
// to, ask for a literal "bless", re-verify the ledger is UNCHANGED since the display, then commit
// a fresh epoch fence — all inside ONE held ledger lock (see withFileLockAsync, lock.ts, for why
// the confirmation prompt cannot be expressed as a plain `withFileLock(ledger, async fn)`: that
// silently releases the lock the instant the callback hits its first `await`).
//
// Follows scripts/trigger-cli.ts's conventions: `main(argv, deps): Promise<number>` (async here —
// the first CLI in this repo that reads stdin), `deps.exit ?? (code => { process.exitCode = code
// })`, a module-level `void main(process.argv.slice(2))` guard that is vitest-import-safe (it
// never calls the hard process.exit(), so a stray invocation during a test import cannot abort
// module evaluation or leak into the test runner's own exit code — see trigger-cli.ts's own
// comment for the empirically-verified rationale, which applies identically here).
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { isAbsolute, dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { MemoryRecord } from '../src/types.js';
import { withFileLockAsync } from '../src/memory/lock.js';
import { readLedgerBytes, appendRecordUnlocked, witnessFenceRecord } from '../src/memory/ledger.js';
import {
  scopeKeyOf, readScopeWitness, classifyState, planTransition, openTransition, completeTransition,
} from '../src/memory/witness-store.js';
import { sha256Hex } from '../src/memory/witness-core.js';
import { projectLedgerPath } from '../src/memory/ownership.js';

export interface RebaselineDeps {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  promptLine?: (q: string) => Promise<string>;
  now?: () => string;
  exit?: (code: number) => void;
}

const USAGE = 'usage: helix-rebaseline --scope global | --scope <absoluteProjectRoot>\n';
const CONFIRM_PROMPT = 'Type "bless" to re-baseline: ';
const GLOBAL_LEDGER_FILE = 'memory.jsonl';

/** `--scope global` or `--scope <absoluteProjectRoot>`, and nothing else — no `--scope=value`
 *  form (mirrors trigger-cli.ts's parseArgs: space-separated flag/value pairs only). Returns null
 *  for anything else (missing flag, missing/relative value, extra args, `--help`, ...) so the
 *  caller can route every malformed invocation through ONE usage/exit-2 branch. */
function parseScope(argv: string[]): string | null {
  if (argv.length !== 2 || argv[0] !== '--scope') return null;
  const scope = argv[1];
  if (!scope) return null;
  if (scope !== 'global' && !isAbsolute(scope)) return null;
  return scope;
}

/** home = HELIX_HOME ?? ~/.helix (trigger-measure.ts:65-67 pattern). */
function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.HELIX_HOME ?? join(homedir(), '.helix');
}
/** global ledger = HELIX_LEDGER ?? <home>/memory.jsonl (trigger-measure.ts:70-72 pattern). */
function resolveGlobalLedger(env: NodeJS.ProcessEnv, home: string): string {
  return env.HELIX_LEDGER ?? join(home, GLOBAL_LEDGER_FILE);
}

/** node:readline/promises over real stdin/stdout — the first CLI in this repo reading stdin. */
async function defaultPromptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Mirrors appendRecordUnlocked's EXACT write-path bytes (ledger.ts:77-97) without decoding: the
 *  bytes that land on disk after a real append are (existing bytes) ++ (a '\n' tail-repair
 *  separator IFF the existing bytes are non-empty and do not already end in 0x0a) ++
 *  (JSON.stringify(record) + '\n'). Deliberately Buffer-concatenation, never
 *  `existing.toString('utf8')` + string concat + re-encode: a decode/re-encode round-trip is only
 *  byte-preserving for VALID UTF-8, and `existing` is arbitrary pre-existing on-disk content that
 *  must stay byte-EXACT (the serialization-consistency guard — same bug class as Task 6's
 *  compactLedger integration; completeTransition's exact-bytes assert is the detector if this
 *  ever drifts from appendRecordUnlocked's real behavior). `Buffer.byteLength`/`sha256Hex` both
 *  accept a Buffer directly, so the caller needs no separate string-vs-Buffer branch. */
function computeAppendedBytes(existing: Buffer, record: MemoryRecord): Buffer {
  const line = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
  const needsSeparator = existing.length > 0 && existing[existing.length - 1] !== 0x0a;
  return needsSeparator ? Buffer.concat([existing, Buffer.from('\n'), line]) : Buffer.concat([existing, line]);
}

/** Never throws: every failure path (usage, TTY refusal, or any exception from the locked
 *  ceremony) is caught and turned into a numeric exit code — both returned AND applied via
 *  deps.exit (default: process.exitCode, never the hard process.exit(), matching this repo's
 *  natural-exit convention). Exit 2 = usage/TTY refusal (nothing attempted); exit 1 = confirmation
 *  declined OR an unexpected failure (nothing written in either case); exit 3 = the ledger changed
 *  during the confirmation pause (nothing written); exit 0 = a fresh epoch fence was committed. */
export async function main(argv: string[], deps: RebaselineDeps = {}): Promise<number> {
  const exit = deps.exit ?? ((code: number): void => { process.exitCode = code; });

  const scope = parseScope(argv);
  if (scope === null) {
    process.stderr.write(USAGE);
    exit(2);
    return 2;
  }

  const isTTY = deps.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!isTTY) {
    process.stderr.write('rebaseline requires an interactive terminal\n');
    exit(2);
    return 2;
  }

  try {
    const env = deps.env ?? process.env;
    const now = deps.now ?? ((): string => new Date().toISOString());
    const promptLine = deps.promptLine ?? defaultPromptLine;

    const home = resolveHome(env);
    const ledger = scope === 'global' ? resolveGlobalLedger(env, home) : projectLedgerPath(scope);
    const scopeKey = scope === 'global' ? scopeKeyOf(home) : scopeKeyOf(home, scope);
    mkdirSync(dirname(ledger), { recursive: true }); // the lock file lives next to the ledger; must exist before withFileLockAsync

    // The ENTIRE ceremony — display, confirmation, re-verify, commit — runs inside ONE held ledger
    // lock (spec §6/§7 design invariant: never released and re-acquired). withFileLockAsync (not
    // withFileLock) is what makes that true across the `await promptLine(...)` below — see its
    // doc-comment in lock.ts for why the plain synchronous helper cannot do this.
    const code = await withFileLockAsync(ledger, async () => {
      const displayedBytes = readLedgerBytes(ledger);
      const displayedHash = sha256Hex(displayedBytes);
      const state = readScopeWitness(home, scopeKey);
      const verdict = classifyState(state, displayedBytes);
      const currentEntry = state.macInvalid ? null : state.entry;
      const currentEpoch = currentEntry?.epoch ?? 0;
      const displayPlan = planTransition(home, scopeKey, 'rebaseline'); // pure read, no write — see witness-store.ts

      process.stdout.write(`scope: ${scope}\n`);
      process.stdout.write(`bytes: ${displayedBytes.length}\n`);
      process.stdout.write(`sha256: ${displayedHash}\n`);
      process.stdout.write(`epoch: ${currentEpoch} -> ${displayPlan.epoch}\n`);
      process.stdout.write(`verdict: ${verdict.kind}\n`);

      const answer = await promptLine(CONFIRM_PROMPT);
      if (answer.trim() !== 'bless') {
        process.stderr.write('confirmation not given -- nothing written\n');
        exit(1);
        return 1;
      }

      // Still under the SAME lock: re-verify the ledger has not moved since it was displayed.
      const currentBytes = readLedgerBytes(ledger);
      if (sha256Hex(currentBytes) !== displayedHash) {
        process.stderr.write('ledger changed during confirmation\n');
        exit(3);
        return 3;
      }

      // Fresh plan (re-derived, not reused from the display-time call above — planTransition is a
      // pure read and "only ADVISORY"; openTransition re-asserts consistency under the witness
      // lock regardless, but re-deriving right before commit is the defensive, spec-literal order).
      const plan = planTransition(home, scopeKey, 'rebaseline');
      const fence = witnessFenceRecord(plan.epoch, plan.nonce, now());
      const finalBytes = computeAppendedBytes(currentBytes, fence);
      const expected = { byteLength: finalBytes.length, prefixHash: sha256Hex(finalBytes) };

      openTransition(home, scopeKey, {
        kind: 'rebaseline', epoch: plan.epoch, nonce: plan.nonce,
        predecessor: plan.predecessor, supersedes: plan.supersedes,
        expected, tx: fence.tx,
      });

      appendRecordUnlocked(ledger, fence); // we hold the ledger lock — the unlocked inner append is correct here
      const landedBytes = readLedgerBytes(ledger);
      // completeTransition's exact-bytes assert is the serialization-consistency guard: if
      // computeAppendedBytes ever diverges from appendRecordUnlocked's real write path, this throws
      // instead of silently completing against the wrong expected digest.
      completeTransition(home, scopeKey, landedBytes, fence.tx);

      process.stdout.write(`re-baselined ${scope} at epoch ${plan.epoch}\n`);
      exit(0);
      return 0;
    });
    return code;
  } catch (e) {
    process.stderr.write(`helix-rebaseline: ${e instanceof Error ? e.message : String(e)}\n`);
    exit(1);
    return 1;
  }
}

void main(process.argv.slice(2));
