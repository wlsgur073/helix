import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acknowledgeLatest, validateAcknowledgementLine, type AcknowledgementRecord, type EvaluationRecord } from '../scripts/trigger-measure.js';
import { main } from '../scripts/trigger-cli.js';
import type { Leg } from '../scripts/trigger-eval.js';

function evalLine(ts: string, overall: EvaluationRecord['overall'], latencyMin: number | null = 5): string {
  const off: Leg = { min: 78, max: 78, threshold: 2500, status: 'false' };
  const lat: Leg = { min: latencyMin, max: latencyMin, threshold: 3, status: latencyMin !== null && latencyMin >= 3 ? 'true' : 'false' };
  const r: EvaluationRecord = {
    v: 1, policy: 'T1-2026-07-11', kind: 'evaluation', ts, run: 'r',
    service_result: null, exit_code: null, exit_status: null,
    legs: { rows: off, bytes: { ...off, threshold: 4194304 }, latency: lat },
    latencyN: 83, overall, project: 'owned', metricsState: 'present', unknownLines: 0, unknownMaxOps: 0,
  };
  return JSON.stringify(r);
}
/** An acknowledgement line as the CLI writes it: the acknowledged evaluation's legs, at `latencyMin`. */
function ackLine(ts: string, evaluationTs: string, latencyMin: number | null = 5): string {
  const legs = (JSON.parse(evalLine(evaluationTs, 'fired', latencyMin)) as EvaluationRecord).legs;
  const r: AcknowledgementRecord = { v: 1, policy: 'T1-2026-07-11', kind: 'acknowledgement', ts, evaluationTs, legs };
  return JSON.stringify(r);
}
const sinkOf = (h: string): string | null => (existsSync(join(h, 'trigger.jsonl')) ? readFileSync(join(h, 'trigger.jsonl'), 'utf8') : null);
const homeWith = (lines: string[] | null): string => {
  const h = mkdtempSync(join(tmpdir(), 'helix-ack-'));
  if (lines) writeFileSync(join(h, 'trigger.jsonl'), lines.join('\n') + '\n');
  return h;
};
const deps = (h: string) => ({ env: { HELIX_HOME: h }, now: () => '2026-09-24T01:00:00.000Z' });

describe('acknowledgeLatest', () => {
  it('appends one validated record copying the latest fired evaluation', () => {
    const h = homeWith([evalLine('2026-09-23T08:30:18.147Z', 'fired')]);
    const r = acknowledgeLatest(deps(h));
    expect(r.ok).toBe(true);
    const last = readFileSync(join(h, 'trigger.jsonl'), 'utf8').trim().split('\n').at(-1)!;
    const rec = validateAcknowledgementLine(last);
    expect(rec.kind).toBe('acknowledgement');
    expect(rec.ts).toBe('2026-09-24T01:00:00.000Z');
    expect(rec.evaluationTs).toBe('2026-09-23T08:30:18.147Z');
    expect(rec.legs.latency.min).toBe(5);
    expect(Object.keys(rec)).toEqual(['v', 'policy', 'kind', 'ts', 'evaluationTs', 'legs']);
  });

  // R23: refused only with no sink, no evaluation, no evaluation that ever read fired, or nothing
  // newer than the latest acknowledgement. The row "the latest evaluation is not-fired" left this
  // table (FLIPPED, see the test below); the lone indeterminate row stays: nothing ever fired.
  it.each([
    ['no sink at all', null],
    ['no evaluation', ['{"v":1,"policy":"T1-2026-07-11","kind":"reporter-failure","ts":"2026-09-23T00:00:00.000Z"}']],
    ['the latest evaluation is indeterminate', [evalLine('2026-09-23T00:00:00.000Z', 'indeterminate', null)]],
    ['an acknowledgement newer than every evaluation', [evalLine('2026-09-23T08:30:18.147Z', 'fired'), ackLine('2026-09-23T12:00:00.000Z', '2026-09-23T08:30:18.147Z')]],
  ])('refuses and appends nothing when there is %s', (_label, lines) => {
    const h = homeWith(lines as string[] | null);
    const before = sinkOf(h);
    const r = acknowledgeLatest(deps(h));
    expect(r.ok).toBe(false);
    expect(sinkOf(h)).toBe(before);
  });

  it('a fire on record whose latest evaluation reads not-fired is acknowledged against that latest reading', () => {
    // FLIPPED 2026-09-24 (item 7, R23): was "refuses and appends nothing when there is the latest
    // evaluation is not-fired" (the it.each row above). A leg back under threshold after a fire left
    // the fired-history summary alarming while this refused — a banner nothing could quiet.
    const h = homeWith([evalLine('2026-09-22T00:00:00.000Z', 'fired'), evalLine('2026-09-23T00:00:00.000Z', 'not-fired', 1)]);
    const r = acknowledgeLatest(deps(h));
    expect(r.ok).toBe(true);
    const rec = validateAcknowledgementLine(sinkOf(h)!.trim().split('\n').at(-1)!);
    expect(rec.evaluationTs).toBe('2026-09-23T00:00:00.000Z');
    expect(rec.legs.latency.min).toBe(1);
  });

  it('a re-armed alarm whose leg fell back under threshold (probe c10) is acknowledged, copying the latest evaluation', () => {
    // Fired at 5, acknowledged, fired at 6 (a rise: re-armed), then not-fired at 2.
    const h = homeWith([
      evalLine('2026-09-23T08:30:18.147Z', 'fired', 5),
      ackLine('2026-09-23T12:00:00.000Z', '2026-09-23T08:30:18.147Z', 5),
      evalLine('2026-09-24T09:00:00.000Z', 'fired', 6),
      evalLine('2026-09-25T09:00:00.000Z', 'not-fired', 2),
    ]);
    const lines = sinkOf(h)!.trim().split('\n').length;
    const r = acknowledgeLatest(deps(h));
    expect(r.ok).toBe(true);
    const after = sinkOf(h)!.trim().split('\n');
    expect(after).toHaveLength(lines + 1);
    const rec = validateAcknowledgementLine(after.at(-1)!);
    expect(rec.evaluationTs).toBe('2026-09-25T09:00:00.000Z');
    expect(rec.legs.latency.min).toBe(2);
  });
});

describe('validateAcknowledgementLine', () => {
  it('rejects the wrong kind and a non-ASCII byte', () => {
    const ok = JSON.stringify({ v: 1, policy: 'T1-2026-07-11', kind: 'acknowledgement', ts: '2026-09-24T01:00:00.000Z', evaluationTs: '2026-09-23T08:30:18.147Z', legs: JSON.parse(evalLine('2026-09-23T08:30:18.147Z', 'fired')).legs });
    expect(() => validateAcknowledgementLine(ok)).not.toThrow();
    expect(() => validateAcknowledgementLine(ok.replace('"acknowledgement"', '"evaluation"'))).toThrow(/kind/);
    expect(() => validateAcknowledgementLine(ok.replace('2026-09-24', '2026–09-24'))).toThrow(/non-ASCII/);
  });
});

describe('trigger-cli --acknowledge', () => {
  it('exits 0 after appending, 2 on a refusal', () => {
    const fired = homeWith([evalLine('2026-09-23T08:30:18.147Z', 'fired')]);
    expect(main(['--acknowledge'], { ...deps(fired), exit: () => {} })).toBe(0);
    const quiet = homeWith([evalLine('2026-09-23T08:30:18.147Z', 'not-fired', 1)]);
    expect(main(['--acknowledge'], { ...deps(quiet), exit: () => {} })).toBe(2);
  });

  it('exits 1 and appends nothing when the latest evaluation line is malformed (probe c11)', () => {
    const h = homeWith([
      evalLine('2026-09-23T08:30:18.147Z', 'fired'),
      '{"v":1,"policy":"T1-2026-07-11","kind":"evaluation","ts":"2026-09-24T09:00:00.000Z"',
    ]);
    const before = sinkOf(h);
    expect(main(['--acknowledge'], { ...deps(h), exit: () => {} })).toBe(1);
    expect(sinkOf(h)).toBe(before);
  });
});
