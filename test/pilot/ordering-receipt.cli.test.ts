import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { bundleCli } from '../helpers/bundle-cli.js';
import { RULE } from '../../scripts/pilot/gate-set.js';

/** The append/verify CLI for evidence-chain element 4.
 *
 *  Exercised as a real process, because the properties under test are process properties: an
 *  argument error must exit 2, an integrity failure must exit 1, and `append` must extend the file
 *  on disk rather than rewrite it. */

let cli: string;
beforeAll(async () => { cli = await bundleCli('scripts/pilot/ordering-receipt.ts'); }, 30_000);

const PREP = 'a'.repeat(64);
const RUN = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);

const run = (args: string[]) =>
  execFileSync(process.execPath, [cli, ...args], { cwd: process.cwd(), stdio: 'pipe' }).toString();
const status = (args: string[]): number => {
  try { execFileSync(process.execPath, [cli, ...args], { cwd: process.cwd(), stdio: 'pipe' }); return 0; }
  catch (e) { return (e as { status?: number }).status ?? -1; }
};

const withLog = (body: (log: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'ordrcpt-'));
  try { body(join(dir, 'ordering.jsonl')); } finally { rmSync(dir, { recursive: true, force: true }); }
};

const append = (log: string, event: string, sha: string, runId?: string) =>
  run(['--mode', 'append', '--log', log, '--event', event, '--payload-sha', sha,
    ...(runId === undefined ? [] : ['--run-id', runId])]);

const healthy = (log: string) => {
  append(log, 'prepare-finished', PREP);
  append(log, 'runner-started', PREP, 'r1');
  append(log, 'runner-finished', RUN, 'r1');
};

describe('append', () => {
  it('creates the log and extends it without rewriting what is already there', () => {
    withLog((log) => {
      append(log, 'prepare-finished', PREP);
      const first = readFileSync(log, 'utf8');
      append(log, 'runner-started', PREP, 'r1');
      const second = readFileSync(log, 'utf8');
      // Byte-prefix, not line count: this is what distinguishes an append from a rewrite that
      // happens to reproduce the earlier lines.
      expect(second.startsWith(first)).toBe(true);
      expect(second.trimEnd().split('\n')).toHaveLength(2);
      expect(status(['--mode', 'verify', '--log', log])).toBe(0);
    });
  });

  it('writes lines that identify themselves and attest their own clock', () => {
    // Finding 4, at the surface that matters: the file. §10 requires an artifact to name its own
    // `rule` and `artifact` without reference to a filename, and the verdict on stdout is not
    // retained — a `.jsonl` copied out of its directory has to still say what it is.
    withLog((log) => {
      healthy(log);
      for (const l of readFileSync(log, 'utf8').trimEnd().split('\n')) {
        const o = JSON.parse(l) as Record<string, unknown>;
        expect(o.artifact).toBe('ordering-receipt-entry');
        expect(o.rule).toBe(RULE);
        expect(o.attestation).toMatch(/self-reported/i);
      }
    });
  });

  it('REFUSES a run id on prepare-finished and a runner event without one', () => {
    withLog((log) => {
      expect(status(['--mode', 'append', '--log', log, '--event', 'prepare-finished',
        '--payload-sha', PREP, '--run-id', 'r1'])).toBe(2);
      expect(status(['--mode', 'append', '--log', log, '--event', 'runner-started',
        '--payload-sha', PREP])).toBe(2);
      expect(status(['--mode', 'append', '--log', log, '--event', 'runner-finished',
        '--payload-sha', RUN])).toBe(2);
    });
  });

  it('REFUSES an unrecognised event name', () => {
    withLog((log) => {
      expect(status(['--mode', 'append', '--log', log, '--event', 'runner-resumed',
        '--payload-sha', PREP, '--run-id', 'r1'])).toBe(2);
    });
  });

  it('REFUSES a payload hash that is not 64 lowercase hex', () => {
    withLog((log) => {
      expect(status(['--mode', 'append', '--log', log, '--event', 'prepare-finished',
        '--payload-sha', PREP.toUpperCase()])).toBe(2);
      expect(status(['--mode', 'append', '--log', log, '--event', 'prepare-finished',
        '--payload-sha', 'deadbeef'])).toBe(2);
    });
  });

  it('REFUSES to append onto an already-corrupted log, exiting 1', () => {
    withLog((log) => {
      healthy(log);
      const lines = readFileSync(log, 'utf8').trimEnd().split('\n');
      const edited = JSON.parse(lines[0]!) as { payloadSha256: string };
      edited.payloadSha256 = OTHER;
      lines[0] = JSON.stringify(edited);
      writeFileSync(log, lines.join('\n') + '\n');
      expect(status(['--mode', 'append', '--log', log, '--event', 'runner-started',
        '--payload-sha', PREP, '--run-id', 'r2'])).toBe(1);
      expect(() => append(log, 'runner-started', PREP, 'r2')).toThrow(/chain-broken/);
    });
  });
});

describe('a pre-existing ZERO-LENGTH --log', () => {
  /** Round-3 finding, reproduced live: every zero-length file passes `parseLog` (the empty string
   *  is its one legitimate unterminated input) and is then EXTENDED — 553 bytes appended onto a
   *  pinned EMPTY project ledger at exit 0, corpus dead. A zero-length file is never this tool's
   *  log: its own appends always leave at least one terminated line. Only ENOENT means "no log
   *  yet"; an existing empty file is some other artifact standing where a log was named. */
  const appendArgs = (log: string) =>
    ['--mode', 'append', '--log', log, '--event', 'prepare-finished', '--payload-sha', PREP];

  it('append REFUSES it as an invocation error, leaving it at zero bytes', () => {
    withLog((log) => {
      writeFileSync(log, '');
      expect(status(appendArgs(log))).toBe(2);
      expect(readFileSync(log, 'utf8')).toBe('');
      expect(() => run(appendArgs(log))).toThrow(/log-preexisting-empty/);
    });
  });

  it('refuses with an input-safe message: point --log elsewhere, never touch the file', () => {
    // The refusal cannot know what the empty file is — a pinned empty ledger is a NORMAL snapshot
    // state — so the one remedy it may hand out is a different --log. Telling the operator to
    // delete or move the file would be the destructive repair this refusal exists to prevent.
    withLog((log) => {
      writeFileSync(log, '');
      let stderr = '';
      try { execFileSync(process.execPath, [cli, ...appendArgs(log)], { cwd: process.cwd(), stdio: 'pipe' }); }
      catch (e) { stderr = String((e as { stderr?: Buffer }).stderr ?? ''); }
      expect(stderr).toMatch(/log-preexisting-empty/);
      expect(stderr).toMatch(/pipeline artifact/);
      expect(stderr).toMatch(/--log/);
      expect(stderr).not.toMatch(/delete|remove|move it aside/i);
    });
  });

  it('still creates a log that does not exist at all', () => {
    // The boundary the slug draws: ENOENT is the legal first-append state; zero bytes is not.
    withLog((log) => {
      expect(status(appendArgs(log))).toBe(0);
      expect(readFileSync(log, 'utf8').endsWith('\n')).toBe(true);
    });
  });
});

describe('verify', () => {
  it('exits 0 on a healthy log and prints the limits with the pass', () => {
    withLog((log) => {
      healthy(log);
      const out = run(['--mode', 'verify', '--log', log]);
      expect(out).toMatch(/VERIFIED/);
      expect(out).toMatch(/r1/);
      // Non-negotiable: the summary a report would paste must carry what it does not establish.
      expect(out).toMatch(/DOES NOT ESTABLISH/);
      expect(out).toMatch(/self-reported/i);
      expect(out).toMatch(/unrecorded exploratory run/);
    });
  });

  it('exits 1 when a runner-started precedes every prepare-finished', () => {
    withLog((log) => {
      append(log, 'runner-started', PREP, 'r1');
      append(log, 'prepare-finished', PREP);
      expect(status(['--mode', 'verify', '--log', log])).toBe(1);
      expect(() => run(['--mode', 'verify', '--log', log])).toThrow(/run-before-any-prepare/);
    });
  });

  it('honours --expect-prepare in both directions', () => {
    withLog((log) => {
      healthy(log);
      expect(status(['--mode', 'verify', '--log', log, '--expect-prepare', PREP])).toBe(0);
      expect(status(['--mode', 'verify', '--log', log, '--expect-prepare', OTHER])).toBe(1);
    });
  });

  it('honours --expect-head, which is what makes truncation visible', () => {
    withLog((log) => {
      healthy(log);
      const head = /head: ([0-9a-f]{64})/.exec(run(['--mode', 'verify', '--log', log]))![1]!;
      expect(status(['--mode', 'verify', '--log', log, '--expect-head', head])).toBe(0);
      // Drop the last line. Every remaining hash is still correct, so without the anchor this is
      // indistinguishable from a log that simply ended earlier.
      const lines = readFileSync(log, 'utf8').trimEnd().split('\n');
      writeFileSync(log, lines.slice(0, -1).join('\n') + '\n');
      expect(status(['--mode', 'verify', '--log', log])).toBe(0);
      expect(status(['--mode', 'verify', '--log', log, '--expect-head', head])).toBe(1);
      expect(() => run(['--mode', 'verify', '--log', log, '--expect-head', head])).toThrow(/head-mismatch/);
    });
  });

  it('exits 1 rather than 2 for a missing log, and refuses an empty one', () => {
    withLog((log) => {
      expect(status(['--mode', 'verify', '--log', log])).toBe(1);
      writeFileSync(log, '');
      expect(status(['--mode', 'verify', '--log', log])).toBe(1);
    });
  });

  it('exits 1 on a log that records prepares and no run at all', () => {
    // Finding 2, reproduced against the real CLI: this printed
    // "ordering receipt VERIFIED — 1 entries, 1 prepare-finished, 0 run(s) bound" and exited 0.
    // Element 4's whole subject is the runner-started, and there is none.
    withLog((log) => {
      append(log, 'prepare-finished', PREP);
      expect(status(['--mode', 'verify', '--log', log])).toBe(1);
      expect(() => run(['--mode', 'verify', '--log', log])).toThrow(/log-records-no-run/);
    });
  });

  it('prints which optional checks ran, and stops advising an anchor once anchored', () => {
    // Finding 1, reproduced against the real CLI: a bare verify and a fully anchored one produced
    // byte-identical output, and the anchored one still told the reader to pass --expect-head.
    withLog((log) => {
      healthy(log);
      const bare = run(['--mode', 'verify', '--log', log]);
      const head = /head: ([0-9a-f]{64})/.exec(bare)![1]!;
      const anchored = run(['--mode', 'verify', '--log', log, '--expect-prepare', PREP,
        '--expect-head', head]);
      expect(bare).not.toEqual(anchored);
      expect(bare).toMatch(/--expect-head: NOT SUPPLIED/);
      expect(bare).toMatch(/--expect-prepare: NOT SUPPLIED/);
      expect(bare).toMatch(/Pass --expect-head/);
      expect(anchored).toContain(`--expect-head: ${head}`);
      expect(anchored).toContain(`--expect-prepare: ${PREP}`);
      expect(anchored).not.toMatch(/Pass --expect-head/);
    });
  });
});

describe('a log whose last line lost its newline', () => {
  /** Finding 3, reproduced against the real CLI: verify exited 0, then append reported
   *  "appended seq 2" while `wc -l` counted 2 lines for three events — the new entry was fused onto
   *  the previous one, and every later verify failed. A success message, a chain value that will
   *  never verify, and a valid receipt destroyed. */
  it('is refused by verify instead of being read as sound', () => {
    withLog((log) => {
      healthy(log);
      writeFileSync(log, readFileSync(log, 'utf8').trimEnd());
      expect(status(['--mode', 'verify', '--log', log])).toBe(1);
      expect(() => run(['--mode', 'verify', '--log', log])).toThrow(/log-not-newline-terminated/);
    });
  });

  it('is refused by append, leaving the bytes exactly as they were', () => {
    withLog((log) => {
      healthy(log);
      const truncated = readFileSync(log, 'utf8').trimEnd();
      writeFileSync(log, truncated);
      expect(status(['--mode', 'append', '--log', log, '--event', 'runner-finished',
        '--payload-sha', RUN, '--run-id', 'r1'])).toBe(1);
      expect(readFileSync(log, 'utf8')).toBe(truncated);
      expect(truncated.split('\n')).toHaveLength(3);   // three events, three lines, none fused
    });
  });
});

describe('unchained bytes in the retained file', () => {
  /** Post-repair reproduction, against the real process: two entries appended, a line of spaces
   *  spliced between them, and verify exited 0 — bytes sat in the retained receipt covered by no
   *  chain value, because `parseLog` filtered blank-looking lines before walking. The file is
   *  entry lines each terminated by exactly one newline; anything blank-looking other than the
   *  zero-length remainder after the final terminator is refused. */
  it('verify REFUSES a spliced line of spaces instead of filtering it out', () => {
    withLog((log) => {
      append(log, 'prepare-finished', PREP);
      append(log, 'runner-started', PREP, 'r1');
      const lines = readFileSync(log, 'utf8').trimEnd().split('\n');
      writeFileSync(log, [lines[0], '    ', lines[1]].join('\n') + '\n');
      expect(status(['--mode', 'verify', '--log', log])).toBe(1);
      expect(() => run(['--mode', 'verify', '--log', log])).toThrow(/log-unchained-bytes/);
    });
  });

  it('verify REFUSES a whitespace-only line at the tail', () => {
    withLog((log) => {
      healthy(log);
      writeFileSync(log, readFileSync(log, 'utf8') + ' \t \n');
      expect(status(['--mode', 'verify', '--log', log])).toBe(1);
      expect(() => run(['--mode', 'verify', '--log', log])).toThrow(/log-unchained-bytes/);
    });
  });

  it('append REFUSES to extend such a log, leaving the bytes exactly as they were', () => {
    withLog((log) => {
      append(log, 'prepare-finished', PREP);
      append(log, 'runner-started', PREP, 'r1');
      const lines = readFileSync(log, 'utf8').trimEnd().split('\n');
      const tampered = [lines[0], '  ', lines[1]].join('\n') + '\n';
      writeFileSync(log, tampered);
      expect(status(['--mode', 'append', '--log', log, '--event', 'runner-finished',
        '--payload-sha', RUN, '--run-id', 'r1'])).toBe(1);
      expect(readFileSync(log, 'utf8')).toBe(tampered);
    });
  });
});

describe('the argument contract', () => {
  it('REFUSES a missing or unrecognised mode', () => {
    withLog((log) => {
      expect(status(['--log', log])).toBe(2);
      expect(status(['--mode', 'inspect', '--log', log])).toBe(2);
    });
  });

  it('REFUSES an unknown flag instead of ignoring it', () => {
    withLog((log) => {
      healthy(log);
      expect(status(['--mode', 'verify', '--log', log, '--force', 'yes'])).toBe(2);
    });
  });

  it('REFUSES a flag belonging to the other mode', () => {
    // `--event` is meaningless to verify and `--expect-prepare` to append. Ignoring either would
    // leave an operator believing an argument was honoured when nothing read it.
    withLog((log) => {
      healthy(log);
      expect(status(['--mode', 'verify', '--log', log, '--event', 'prepare-finished'])).toBe(2);
      expect(status(['--mode', 'append', '--log', log, '--event', 'prepare-finished',
        '--payload-sha', PREP, '--expect-prepare', PREP])).toBe(2);
      expect(status(['--mode', 'append', '--log', log, '--event', 'prepare-finished',
        '--payload-sha', PREP, '--expect-head', PREP])).toBe(2);
      expect(status(['--mode', 'verify', '--log', log, '--run-id', 'r1'])).toBe(2);
    });
  });

  it('REFUSES an --expect-head that is not 64 lowercase hex', () => {
    withLog((log) => {
      healthy(log);
      expect(status(['--mode', 'verify', '--log', log, '--expect-head', 'deadbeef'])).toBe(2);
    });
  });

  it('REFUSES a repeated flag, a positional, and a flag with no value', () => {
    withLog((log) => {
      healthy(log);
      expect(status(['--mode', 'verify', '--log', log, '--log', log])).toBe(2);
      expect(status(['verify', '--log', log])).toBe(2);
      expect(status(['--mode', 'verify', '--log'])).toBe(2);
    });
  });

  it('REFUSES a missing required flag', () => {
    withLog((log) => {
      expect(status(['--mode', 'verify'])).toBe(2);
      expect(status(['--mode', 'append', '--log', log, '--event', 'prepare-finished'])).toBe(2);
    });
  });
});
