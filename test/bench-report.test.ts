import { describe, expect, it } from 'vitest';
import { summarizeMetrics } from '../scripts/bench-replay.js';

const NOW = Date.parse('2026-07-05T12:00:00.000Z');
const IN = '2026-07-05T11:00:00.000Z';   // inside the window
const OUT = '2026-06-01T00:00:00.000Z';  // outside the window
const op = (tool: string, ms: number, ts = IN, ok = true): string =>
  JSON.stringify({ v: 1, kind: 'op', ts, op_id: 'o_x', 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': tool, duration_ms: ms, ok, 'error.type': ok ? null : 'Error' });
const replay = (ms: number, rows: number, ts = IN): string =>
  JSON.stringify({ v: 1, kind: 'replay', ts, op_id: null, scope: 'global', rows, live_rows: rows, bytes: rows * 100, parse_ms: ms, project_ms: 0, key_available: true, caller: 'store' });

describe('summarizeMetrics (spec §8 --report)', () => {
  it('skips malformed and newer-schema rows, counting them (spec §9.7, §9.11)', () => {
    const s = summarizeMetrics([
      op('helix_memory_recall', 10),
      '{torn line',
      JSON.stringify({ v: 2, kind: 'op', ts: IN }),                 // newer schema
      JSON.stringify({ v: 1, kind: 'mystery', ts: IN }),            // unknown kind
      JSON.stringify({ v: 1, kind: 'op', ts: IN }),                 // missing required fields
    ], { sinceMs: 14 * 86_400_000, nowMs: NOW });
    expect(s.ops.get('helix_memory_recall')!.n).toBe(1);
    expect(s.skipped.newerSchema).toBe(1);
    expect(s.skipped.malformed).toBe(3); // torn + unknown kind + missing fields
  });

  it('verdict uses only the recency window and the latest replay for current size (C2-4)', () => {
    const lines = [
      op('helix_memory_recall', 500, OUT),           // old — excluded from the verdict
      ...Array.from({ length: 21 }, () => op('helix_memory_recall', 10)),
      replay(3, 800, OUT),
      replay(5, 1200),                               // latest replay -> current size
    ];
    const s = summarizeMetrics(lines, { sinceMs: 14 * 86_400_000, nowMs: NOW });
    expect(s.verdict.recallOkN).toBe(21);
    expect(s.verdict.recallFailN).toBe(0);
    expect(s.verdict.recallP95).toBe(10);            // the old 500ms sample is outside the window
    expect(s.verdict.latestRows).toBe(1200);
    expect(s.verdict.state).toBe('below');
  });

  it('flags the trigger when windowed recall p95 exceeds 150ms', () => {
    const lines = Array.from({ length: 25 }, () => op('helix_memory_recall', 200));
    const s = summarizeMetrics(lines, { sinceMs: 14 * 86_400_000, nowMs: NOW });
    expect(s.verdict.recallP95).toBe(200);
    expect(s.verdict.state).toBe('exceeded');
  });
});

describe('E2: the verdict is tri-state and counts successful recalls only', () => {
  const op = (tool: string, ms: number, ok = true): string =>
    JSON.stringify({ v: 1, kind: 'op', ts: '2026-07-11T00:00:00.000Z', 'gen_ai.tool.name': tool, duration_ms: ms, ok });
  const opts = { sinceMs: 14 * 86_400_000, nowMs: Date.parse('2026-07-11T12:00:00.000Z') };

  it('20 FAILED recalls => insufficient, not below', () => {
    const lines = Array.from({ length: 20 }, () => op('helix_memory_recall', 2, false));
    const v = summarizeMetrics(lines, opts).verdict;
    expect(v.state).toBe('insufficient');
    expect(v.recallOkN).toBe(0);
    expect(v.recallFailN).toBe(20);
  });

  it('zero recalls at all => insufficient', () => {
    expect(summarizeMetrics([], opts).verdict.state).toBe('insufficient');
  });

  it('25 successful FAST recalls => below', () => {
    const lines = Array.from({ length: 25 }, () => op('helix_memory_recall', 5));
    expect(summarizeMetrics(lines, opts).verdict.state).toBe('below');
  });

  it('25 successful SLOW recalls => exceeded', () => {
    const lines = Array.from({ length: 25 }, () => op('helix_memory_recall', 999));
    expect(summarizeMetrics(lines, opts).verdict.state).toBe('exceeded');
  });

  it('a compaction row is NOT counted as malformed, and its forged-drop count surfaces', () => {
    const lines = [
      JSON.stringify({ v: 1, kind: 'compaction', ts: '2026-07-11T00:00:00.000Z', scope: 'global', duration_ms: 3, dropped_rows: 2, reclaimed_bytes: 100, dropped_forged_verifies: 2, ok: true }),
      op('helix_memory_recall', 5),
    ];
    const s = summarizeMetrics(lines, opts);
    expect(s.skipped.malformed).toBe(0);
    expect(s.verdict.forgedDrops).toBe(2);
  });
});
