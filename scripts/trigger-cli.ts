// Thin CLI entry for the T1 trigger daily snapshot (Phase 2 Track 2a, Task A2). Parses argv, then
// delegates every measurement/compose/validate/append/print step to trigger-measure.ts. Nothing in
// this repo imports this module except tests (which call `main` directly with injected deps); the
// compiled artifact (bin/helix-trigger.mjs, Task A3) is invoked directly by systemd ExecStopPost,
// never imported.
//
// No invocation guard is needed: the bottom-line `void main(process.argv.slice(2))` runs once per
// module load, using real argv/env/fs by default — when a TEST imports `main`, that one stray call
// runs too (against vitest's own argv, which never carries --root), taking the usage/exit-2 branch
// and marking the exit code via the same default `exit` seam a real crash would use. It never calls
// the hard process.exit(), so it cannot abort module evaluation, and (verified empirically before
// relying on this) a stray process.exitCode mutation from that call does not leak into `npm test`'s
// own reported exit code.
import { measureAndRecord, type MeasureDeps } from './trigger-measure.js';

export interface CliDeps extends MeasureDeps {
  exit?: (code: number) => void;
}

interface ParsedArgs {
  root?: string;
  run?: string;
  serviceResult?: string;
  exitCode?: string;
  exitStatus?: string;
}

const USAGE = 'usage: trigger-cli --root <path> --run <id> [--service-result <s>] [--exit-code <s>] [--exit-status <s>]\n';

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--root') out.root = argv[++i] ?? '';
    else if (flag === '--run') out.run = argv[++i] ?? '';
    else if (flag === '--service-result') out.serviceResult = argv[++i] ?? '';
    else if (flag === '--exit-code') out.exitCode = argv[++i] ?? '';
    else if (flag === '--exit-status') out.exitStatus = argv[++i] ?? '';
  }
  return out;
}

/** '' and undefined both mean "not supplied" for the optional lifecycle fields -> null in the record
 *  (missing OR empty-string collapse to the same null; systemd's `${SERVICE_RESULT:-}` expansion
 *  yields an empty string, not an unset flag, when the variable is unset). */
const toNullable = (s: string | undefined): string | null => (s === undefined || s === '' ? null : s);

/** Never throws: every failure path (usage, or any exception from measureAndRecord) is caught here,
 *  reported to stderr, and turned into a numeric exit code — both returned AND applied via deps.exit
 *  (default: process.exitCode, never the hard process.exit(), matching this repo's natural-exit
 *  convention — see src/hooks/session-start.ts). Exit 2 = usage error (no record attempted); exit 1 =
 *  a reporter crash somewhere in validate/append/print; exit 0 = a validated record was appended AND
 *  printed, including the all-legs-unavailable case (a valid record). */
export function main(argv: string[], deps: CliDeps = {}): number {
  const exit = deps.exit ?? ((code: number): void => { process.exitCode = code; });
  const parsed = parseArgs(argv);
  if (!parsed.root || !parsed.run) {
    process.stderr.write(USAGE);
    exit(2);
    return 2;
  }
  try {
    measureAndRecord(
      {
        root: parsed.root,
        run: parsed.run,
        serviceResult: toNullable(parsed.serviceResult),
        exitCode: toNullable(parsed.exitCode),
        exitStatus: toNullable(parsed.exitStatus),
      },
      deps,
    );
    exit(0);
    return 0;
  } catch (e) {
    process.stderr.write(`trigger-cli: ${e instanceof Error ? e.message : String(e)}\n`);
    exit(1);
    return 1;
  }
}

void main(process.argv.slice(2));
