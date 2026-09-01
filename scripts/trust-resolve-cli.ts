// C1.4-③ user-only TTY ceremony that resolves a `trust-pending` scope (an ambiguous re-adoption:
// a registered path whose `.owner` stamp was lost or overwritten). The ONLY sanctioned path that
// makes the destructive-capable trust decision, gated behind an interactive confirmation and NEVER
// registered as an MCP tool (grep src/server — it isn't wired there), so a shell-capable agent gets
// no authority to confer or destroy trust that any other write would not.
//
//   --scope <absoluteProjectRoot> --repair   -> same project; keep the nonce, re-elevate old verifies.
//   --scope <absoluteProjectRoot> --fresh     -> path reused for new content; rotate the nonce so the
//                                                old verifies stay Fresh (measured non-destructive on
//                                                read and at compaction — see ownership.resolveTrust).
//
// Follows rebaseline-cli.ts's conventions: `main(argv, deps): Promise<number>`, `deps.exit ??
// (code => { process.exitCode = code })`, a vitest-import-safe module-level guard that never calls
// the hard process.exit(). Exit 2 = nothing attempted (bad usage / no TTY / scope not pending);
// exit 1 = confirmation declined or an unexpected failure (nothing written); exit 0 = resolved.
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { MemoryStore } from '../src/memory/store.js';
import { trustStateOf, resolveTrust, projectLedgerPath } from '../src/memory/ownership.js';

export interface TrustResolveDeps {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  promptLine?: (q: string) => Promise<string>;
  exit?: (code: number) => void;
}

const USAGE = 'usage: helix-trust-resolve --scope <absoluteProjectRoot> --repair | --fresh\n';

/** `--scope <absoluteRoot>` plus exactly one of `--repair` / `--fresh`, in either order, nothing
 *  else. Returns null for any malformed invocation so one usage/exit-2 branch handles them all. */
function parseArgs(argv: string[]): { scope: string; resolution: 'repair' | 'fresh' } | null {
  if (argv.length !== 3) return null;
  const scopeIdx = argv.indexOf('--scope');
  if (scopeIdx < 0) return null;
  const scope = argv[scopeIdx + 1];
  if (!scope || !isAbsolute(scope)) return null;
  const flags = argv.filter((_, i) => i !== scopeIdx && i !== scopeIdx + 1);
  if (flags.length !== 1) return null;
  if (flags[0] === '--repair') return { scope, resolution: 'repair' };
  if (flags[0] === '--fresh') return { scope, resolution: 'fresh' };
  return null;
}

function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.HELIX_HOME ?? join(homedir(), '.helix');
}

async function defaultPromptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } finally { rl.close(); }
}

/** The number of live PROJECT rows in this scope — the "rows affected" figure the disclosure shows.
 *  A conservative upper bound on how many grades a `fresh` rotation would demote: the live read
 *  already clamps a pending scope to Fresh, so the per-row stored grade is not separately available
 *  here without re-deriving the active subkey, and the row count is the honest thing to report. */
function affectedRowCount(home: string, root: string): number {
  const store = new MemoryStore(join(home, 'memory.jsonl'), {
    home, sessionId: 'trust-resolve', project: { root, ledger: projectLedgerPath(root) },
  });
  return store.inspect().filter((s) => s.scope === 'project').length;
}

export async function main(argv: string[], deps: TrustResolveDeps = {}): Promise<number> {
  const exit = deps.exit ?? ((code: number): void => { process.exitCode = code; });

  const parsed = parseArgs(argv);
  if (parsed === null) { process.stderr.write(USAGE); exit(2); return 2; }

  const isTTY = deps.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!isTTY) { process.stderr.write('trust-resolve requires an interactive terminal\n'); exit(2); return 2; }

  try {
    const env = deps.env ?? process.env;
    const home = resolveHome(env);
    const { scope, resolution } = parsed;

    if (trustStateOf(scope, home) !== 'pending') {
      process.stderr.write(`helix-trust-resolve: ${scope} is not trust-pending — nothing to resolve.\n`);
      exit(2);
      return 2;
    }

    const affected = affectedRowCount(home, scope);
    const banner = resolution === 'repair'
      ? `REPAIR ${scope}: keep the existing trust nonce; ${affected} project row(s) return to their stored grades.\n`
      : `FRESH ${scope}: ROTATE the trust nonce; the ${affected} project row(s) signed under the old nonce stay Fresh (not deleted).\n`;
    process.stdout.write(banner);

    const word = resolution === 'repair' ? 'repair' : 'fresh';
    const promptLine = deps.promptLine ?? defaultPromptLine;
    const answer = (await promptLine(`Type "${word}" to confirm: `)).trim();
    if (answer !== word) {
      process.stderr.write('confirmation declined — nothing changed.\n');
      exit(1);
      return 1;
    }

    resolveTrust(scope, home, resolution);
    process.stdout.write(`resolved: ${scope} is now active (${resolution}).\n`);
    exit(0);
    return 0;
  } catch (e) {
    process.stderr.write(`helix-trust-resolve: ${e instanceof Error ? e.message : String(e)}\n`);
    exit(1);
    return 1;
  }
}

// vitest-import-safe: `main` only ever sets process.exitCode (never the hard process.exit()), so a
// stray invocation during a test import cannot abort module evaluation or leak into the runner's
// exit code — the same unconditional-call convention rebaseline-cli.ts uses (its comment carries the
// empirically-verified rationale). It must run under the BUNDLE name too (bin/*.mjs), so it is not
// gated on the source filename.
void main(process.argv.slice(2));
