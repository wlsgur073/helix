import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acknowledgeLatest, validateAcknowledgementLine, type EvaluationRecord } from '../scripts/trigger-measure.js';
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

  it.each([
    ['no sink at all', null],
    ['no evaluation', ['{"v":1,"policy":"T1-2026-07-11","kind":"reporter-failure","ts":"2026-09-23T00:00:00.000Z"}']],
    ['the latest evaluation is not-fired', [evalLine('2026-09-22T00:00:00.000Z', 'fired'), evalLine('2026-09-23T00:00:00.000Z', 'not-fired', 1)]],
    ['the latest evaluation is indeterminate', [evalLine('2026-09-23T00:00:00.000Z', 'indeterminate', null)]],
  ])('refuses and appends nothing when there is %s', (_label, lines) => {
    const h = homeWith(lines as string[] | null);
    const before = existsSync(join(h, 'trigger.jsonl')) ? readFileSync(join(h, 'trigger.jsonl'), 'utf8') : null;
    const r = acknowledgeLatest(deps(h));
    expect(r.ok).toBe(false);
    const after = existsSync(join(h, 'trigger.jsonl')) ? readFileSync(join(h, 'trigger.jsonl'), 'utf8') : null;
    expect(after).toBe(before);
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
});
