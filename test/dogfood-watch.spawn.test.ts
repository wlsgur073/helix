// scripts/dogfood-watch.sh is the terminal-riding watchdog; until move 2 it had no test at all. These
// cases copy the REAL script into a temp tree (never a rewritten copy), point every env seam the
// script exposes into that tree, and put a STUB `systemctl` first on PATH so no case depends on the
// host's user bus or installed units — the certification run sheet forbids silent, environment-
// dependent skips. Assertions are on the Trigger-1 fired line only where the script's other banners
// (timer state, completion gap, missing sink) may legitimately print too.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { EvaluationRecord } from '../scripts/trigger-measure.js';
import type { AcknowledgementRecord } from '../scripts/trigger-measure.js';
import type { Leg } from '../scripts/trigger-eval.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const WATCH = join(repoRoot, 'scripts', 'dogfood-watch.sh');
const POSTRUN = join(repoRoot, 'scripts', 'dogfood-postrun.sh');

/** Same construction as test/dogfood-postrun.spawn.test.ts's evalLine: the REAL EvaluationRecord type
 *  through JSON.stringify, so the fixture has the sink's exact byte shape (no spaces after colons). */
function evalLine(ts: string, overall: EvaluationRecord['overall'], run: string, legs?: EvaluationRecord['legs']): string {
  const leg: Leg = { min: null, max: null, threshold: 0, status: 'unavailable' };
  const record: EvaluationRecord = {
    v: 1, policy: 'T1-2026-07-11', kind: 'evaluation',
    ts, run,
    service_result: null, exit_code: null, exit_status: null,
    legs: legs ?? { rows: leg, bytes: leg, latency: leg },
    latencyN: null, overall,
    project: 'owned', metricsState: 'present', unknownLines: 0, unknownMaxOps: 0,
  };
  return JSON.stringify(record);
}

const FIRED_HISTORY = [
  evalLine('2026-08-26T13:18:49.278Z', 'fired', 'r1'),
  evalLine('2026-08-27T09:00:00.000Z', 'fired', 'r2'),
  evalLine('2026-09-05T09:00:00.000Z', 'not-fired', 'r3'),   // LAST evaluation is not-fired
].join('\n') + '\n';
const FIRED_LINE = '[dogfood-watch] Trigger-1 has fired since 2026-08-26T13:18:49.278Z; 2 of the last 3 evaluations fired.';

interface Tree { script: string; bin: string; home: string; sink: string; stamp: string; triggerStamp: string }

/** Fresh temp tree: the real watch script, a stub `systemctl` (prints $STUB_SYSTEMCTL_STATE, default
 *  `enabled`, exit 0), and a home for the stamps. */
function buildTree(): Tree {
  const tmp = mkdtempSync(join(tmpdir(), 'helix-watch-'));
  mkdirSync(join(tmp, 'bin'));
  mkdirSync(join(tmp, 'home'));
  const script = join(tmp, 'dogfood-watch.sh');
  copyFileSync(WATCH, script);
  chmodSync(script, 0o755);
  const stub = join(tmp, 'bin', 'systemctl');
  writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' "${STUB_SYSTEMCTL_STATE:-enabled}"\nexit 0\n');
  chmodSync(stub, 0o755);
  return {
    script, bin: join(tmp, 'bin'), home: join(tmp, 'home'),
    sink: join(tmp, 'home', 'trigger.jsonl'),
    stamp: join(tmp, 'home', 'watch.stamp'),
    triggerStamp: join(tmp, 'home', 'trigger.stamp'),
  };
}

function runWatch(t: Tree, extra: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    PATH: `${t.bin}:${process.env.PATH ?? ''}`,      // the stub systemctl shadows any host one
    HOME: t.home,
    TRIGGER_FILE: t.sink, STAMP_FILE: t.stamp, TRIGGER_STAMP_FILE: t.triggerStamp,
    TIMER_UNIT: 'helix-dogfood.timer',
    ...extra,
  };
  const res = spawnSync('bash', [t.script], { env, encoding: 'utf8', timeout: 10_000, cwd: t.home });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('scripts/dogfood-watch.sh (spawn tests, hermetic systemctl)', () => {
  it('a sink whose LAST evaluation is not-fired but has earlier fired rows -> the fired line prints once, exit 0', () => {
    const t = buildTree();
    writeFileSync(t.sink, FIRED_HISTORY);
    const { status, stdout } = runWatch(t);
    expect(status).toBe(0);
    expect(stdout).toContain(FIRED_LINE);
  });

  it('a second run the same day with the same trigger stamp -> the fired line is absent, exit 0', () => {
    const t = buildTree();
    writeFileSync(t.sink, FIRED_HISTORY);
    expect(runWatch(t).stdout).toContain(FIRED_LINE);
    const second = runWatch(t);
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain('Trigger-1 has fired');
  });

  it('sink absent -> the fired line is absent (the script may print its own missing-sink banner), exit 0', () => {
    const t = buildTree();                                   // no sink written
    const { status, stdout, stderr } = runWatch(t);
    expect(status).toBe(0);
    expect(stdout + stderr).not.toContain('Trigger-1 has fired');
  });

  it('timer not found AND fired history, fresh stamps -> BOTH banners print in one run (independent throttles)', () => {
    const t = buildTree();
    writeFileSync(t.sink, FIRED_HISTORY);
    const { status, stdout } = runWatch(t, { STUB_SYSTEMCTL_STATE: 'not-found' });
    expect(status).toBe(0);
    expect(stdout).toContain(FIRED_LINE);
    expect(stdout).toMatch(/\[dogfood-watch\] helix-dogfood\.timer not found/);
  });
});

describe('the two copies of trigger_fired_summary are byte-identical', () => {
  /** The function body from its opening line to its closing brace line, inclusive. */
  function reporterBody(script: string): string {
    const text = readFileSync(script, 'utf8');
    const start = text.indexOf('trigger_fired_summary() {');
    expect(start, `${script} defines trigger_fired_summary`).toBeGreaterThanOrEqual(0);
    const end = text.indexOf('\n}\n', start);
    return text.slice(start, end + 3);
  }
  it('dogfood-watch.sh and dogfood-postrun.sh carry the same function text', () => {
    expect(reporterBody(WATCH)).toBe(reporterBody(POSTRUN));
  });
});

const legsWith = (latencyMin: number | null, rows: Leg['status'] = 'false', latStatus?: Leg['status']): EvaluationRecord['legs'] => ({
  rows: { min: 78, max: 78, threshold: 2500, status: rows },
  bytes: { min: 1, max: 1, threshold: 4194304, status: 'false' },
  latency: { min: latencyMin, max: latencyMin, threshold: 3, status: latStatus ?? (latencyMin !== null && latencyMin >= 3 ? 'true' : 'false') },
});
function ackLine(ts: string, evaluationTs: string, legs: EvaluationRecord['legs']): string {
  const r: AcknowledgementRecord = { v: 1, policy: 'T1-2026-07-11', kind: 'acknowledgement', ts, evaluationTs, legs };
  return JSON.stringify(r);
}

describe('T1-STICKY: an acknowledged fire stays quiet until new evidence (item 7)', () => {
  const E = (ts: string, lat: number | null, rows: Leg['status'] = 'false'): string =>
    evalLine(ts, (lat !== null && lat >= 3) || rows === 'true' ? 'fired' : 'not-fired', 'r', legsWith(lat, rows));
  const ACK_TS = '2026-09-23T12:00:00.000Z';
  const history = (...later: string[]): string => [
    E('2026-09-20T09:00:00.000Z', 5),
    E('2026-09-23T08:30:18.147Z', 5),
    ackLine(ACK_TS, '2026-09-23T08:30:18.147Z', legsWith(5)),
    ...later,
  ].join('\n') + '\n';
  const quiet = (sink: string): void => {
    const t = buildTree();
    writeFileSync(t.sink, sink);
    const r = runWatch(t);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('Trigger-1 has fired');
  };
  const rearmed = (sink: string): void => {
    const t = buildTree();
    writeFileSync(t.sink, sink);
    const r = runWatch(t);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Re-armed after the acknowledgement of ${ACK_TS}`);
  };

  it('acknowledged, no later evaluation -> quiet', () => quiet(history()));
  it('acknowledged at 5, later 5 then 4 (an old slow recall left) -> quiet', () =>
    quiet(history(E('2026-09-24T09:00:00.000Z', 5), E('2026-09-25T09:00:00.000Z', 4))));
  it('acknowledged at 5, later 4 then 5 (a rise from 4 is a new slow recall) -> re-armed', () =>
    rearmed(history(E('2026-09-24T09:00:00.000Z', 4), E('2026-09-25T09:00:00.000Z', 5))));
  it('acknowledged at 5, later 6 -> re-armed', () => rearmed(history(E('2026-09-24T09:00:00.000Z', 6))));
  it('acknowledged at 5, later null then 5 -> quiet (null neither re-arms nor resets)', () =>
    quiet(history(E('2026-09-24T09:00:00.000Z', null), E('2026-09-25T09:00:00.000Z', 5))));
  it('acknowledged with rows false, later rows true -> re-armed', () =>
    rearmed(history(E('2026-09-24T09:00:00.000Z', 5, 'true'))));
  it('acknowledged at 5, later 6 then 2 (probe c10), then a SECOND acknowledgement of the 2 reading -> quiet (R23)', () =>
    quiet(history(
      E('2026-09-24T09:00:00.000Z', 6),
      E('2026-09-25T09:00:00.000Z', 2),
      ackLine('2026-09-25T12:00:00.000Z', '2026-09-25T09:00:00.000Z', legsWith(2)),
    )));
  it('acknowledged with rows true and latency min null (unavailable), later latency min 50 (status true), rows unchanged -> re-armed (R19: a leg not true at ack, true after, re-arms even from a null baseline)', () =>
    rearmed([
      E('2026-09-20T09:00:00.000Z', 5),
      E('2026-09-23T08:30:18.147Z', 5),
      ackLine(ACK_TS, '2026-09-23T08:30:18.147Z', legsWith(null, 'true', 'unavailable')),
      E('2026-09-24T09:00:00.000Z', 50, 'true'),
    ].join('\n') + '\n'));
});

// Signal 2 (J7): the gap is dated from the newest evaluation or reporter-failure `ts`, never from the sink's mtime, and an
// acknowledgement row (which moves the mtime without a run completing) is never read. The script reads `date`, so fixtures are
// built relative to the real clock: a gap of whole days shifts the KST calendar day by exactly that many days at any time of
// day, so the expected `last:` day is fixed by the fixture and only the day count could differ across a KST midnight.
const DAY_MS = 86_400_000;
const isoAgo = (days: number, extraMs = 0): string => new Date(Date.now() - days * DAY_MS - extraMs).toISOString();
const kstDay = (iso: string): string => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);
const GAP_PREFIX = '[dogfood-watch] no dogfood run completion for';
const gapBanner = (lastIso: string): RegExp =>
  new RegExp(`\\[dogfood-watch\\] no dogfood run completion for \\d+ days \\(last: ${kstDay(lastIso)}\\)`);
const lines = (...rows: string[]): string => rows.join('\n') + '\n';

/** The reporter-failure line with the byte shape scripts/dogfood-postrun.sh composes (field order, no spaces). */
function reporterFailureLine(ts: string): string {
  return JSON.stringify({
    v: 1, policy: 'T1-2026-07-11', kind: 'reporter-failure', ts, run: 'r-rf',
    service_result: 'timeout', exit_code: null, exit_status: null, reason: 'timeout',
  });
}

/** Writes `text` as the sink, then sets its mtime, so a case fixes the mtime independently of the rows. */
function writeSink(t: Tree, text: string, mtimeIso: string): void {
  writeFileSync(t.sink, text);
  const m = new Date(mtimeIso);
  utimesSync(t.sink, m, m);
}

describe('Signal 2: the gap is dated from the newest completion row, not from the sink mtime (J7)', () => {
  const noGapBanner = (r: { status: number | null; stdout: string }): void => {
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(GAP_PREFIX);
    expect(r.stdout).not.toContain('cannot assess');
  };
  const sameDay = (s: string): string => s.replace(/for \d+ days/, 'for N days');

  it('an acknowledgement after the last evaluation does not move the gap: same banner and same last day as the sink without it', () => {
    const lastEval = isoAgo(3);
    const control = buildTree();                      // mtime = the evaluation's instant, what a sink without an ack looks like
    writeSink(control, lines(evalLine(lastEval, 'not-fired', 'r1')), lastEval);
    const acked = buildTree();                        // the acknowledgement is appended now: ts now, mtime now
    writeSink(acked, lines(evalLine(lastEval, 'not-fired', 'r1'), ackLine(isoAgo(0), lastEval, legsWith(5))), isoAgo(0));
    const c = runWatch(control);
    expect(c.status).toBe(0);
    expect(c.stdout).toMatch(gapBanner(lastEval));
    const a = runWatch(acked);
    expect(a.status).toBe(0);
    expect(sameDay(a.stdout)).toBe(sameDay(c.stdout));
  });

  it('a reporter-failure row is a completion, and the row ts rules over an older mtime -> no gap banner', () => {
    const t = buildTree();                            // evaluation 3 days ago, a timeout/crash row a minute ago; mtime deliberately old
    writeSink(t, lines(evalLine(isoAgo(3), 'not-fired', 'r1'), reporterFailureLine(isoAgo(0, 60_000))), isoAgo(3));
    noGapBanner(runWatch(t));
  });

  it('the newest ts wins, not the last row: a later row carrying an earlier ts (clock step) -> no gap banner', () => {
    const t = buildTree();
    writeSink(t, lines(evalLine(isoAgo(0, 60_000), 'not-fired', 'r1'), evalLine(isoAgo(3), 'not-fired', 'r2')), isoAgo(3));
    noGapBanner(runWatch(t));
  });

  it('the newer of the two kinds dates the gap: evaluation 5 days ago, reporter-failure 3 days ago -> last is the failure day, whatever the mtime', () => {
    const lastFailure = isoAgo(3);
    const t = buildTree();
    writeSink(t, lines(evalLine(isoAgo(5), 'not-fired', 'r1'), reporterFailureLine(lastFailure)), isoAgo(0));
    const r = runWatch(t);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(gapBanner(lastFailure));
  });

  it.each([
    ['a single row torn inside its ts', '{"v":1,"policy":"T1-2026-07-11","kind":"evaluation","ts":"2026-11-0'],
    ['a reporter-failure row whose ts is not a calendar instant', reporterFailureLine('2026-13-45T25:61:61.000Z') + '\n'],
  ])('no row yields a usable ts (%s) -> the mtime dates the gap, as before', (_name, text) => {
    const mtime = isoAgo(3);
    const t = buildTree();
    writeSink(t, text, mtime);
    const r = runWatch(t);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(gapBanner(mtime));
  });

  // A newer row whose ts has the ISO shape but is not a calendar instant sorts above the older valid row; it must not hide that
  // row and send the script to the mtime (which is now here, so the fallback would print no banner at all).
  it.each([
    ['month 13, on a reporter-failure row', (older: string) => reporterFailureLine(`${older.slice(0, 5)}13${older.slice(7)}`)],
    ['hour 24, on an evaluation row', (older: string) => evalLine(`${older.slice(0, 11)}24${older.slice(13)}`, 'not-fired', 'r2')],
  ])('a newer row with an impossible ts (%s) does not hide an older valid row -> the older row dates the gap, not the mtime', (_name, newer) => {
    const older = isoAgo(3);
    const t = buildTree();
    writeSink(t, lines(evalLine(older, 'not-fired', 'r1'), newer(older)), isoAgo(0));
    const r = runWatch(t);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(gapBanner(older));
  });
});
