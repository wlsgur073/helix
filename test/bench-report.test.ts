import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeMetrics, runReport, SAMPLE_FLOOR } from '../scripts/bench-replay.js';

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

  // F6: forgedDrops must honor the recency window like every other windowed verdict field. The
  // ONLY compaction row above is inside the window, so that assertion alone has no witness that the
  // `ts >= cutoff` guard is even wired up -- an out-of-window row makes the guard observable.
  it('forgedDrops counts only compaction rows inside the recency window', () => {
    const lines = [
      JSON.stringify({ v: 1, kind: 'compaction', ts: OUT, scope: 'global', duration_ms: 3, dropped_rows: 9, reclaimed_bytes: 900, dropped_forged_verifies: 7, ok: true }),
      JSON.stringify({ v: 1, kind: 'compaction', ts: IN, scope: 'global', duration_ms: 3, dropped_rows: 2, reclaimed_bytes: 100, dropped_forged_verifies: 2, ok: true }),
      op('helix_memory_recall', 5),
    ];
    const s = summarizeMetrics(lines, opts);
    expect(s.verdict.forgedDrops).toBe(2);   // NOT 9 (out-of-window) and NOT 9+2
  });
});

describe('F4: insufficient requires SAMPLE_FLOOR (20) successful recalls, not just n > 0', () => {
  const op = (tool: string, ms: number, ok = true): string =>
    JSON.stringify({ v: 1, kind: 'op', ts: '2026-07-11T00:00:00.000Z', 'gen_ai.tool.name': tool, duration_ms: ms, ok });
  const opts = { sinceMs: 14 * 86_400_000, nowMs: Date.parse('2026-07-11T12:00:00.000Z') };

  it('1 successful recall => insufficient, and the provisional p95-vs-trigger comparison still has a value', () => {
    const v = summarizeMetrics([op('helix_memory_recall', 2)], opts).verdict;
    expect(v.state).toBe('insufficient');
    expect(v.recallOkN).toBe(1);
    expect(v.reason).toBe(`n < ${SAMPLE_FLOOR}`);
    expect(v.recallP95).toBe(2);   // provisional value computed, not suppressed just because n < floor
  });

  it('19 successful recalls => insufficient', () => {
    const lines = Array.from({ length: 19 }, () => op('helix_memory_recall', 5));
    const v = summarizeMetrics(lines, opts).verdict;
    expect(v.state).toBe('insufficient');
    expect(v.recallOkN).toBe(19);
    expect(v.reason).toBe(`n < ${SAMPLE_FLOOR}`);
  });

  it('20 FAST successful recalls => below (the floor, not one short)', () => {
    const lines = Array.from({ length: 20 }, () => op('helix_memory_recall', 5));
    const v = summarizeMetrics(lines, opts).verdict;
    expect(v.state).toBe('below');
    expect(v.reason).toBeNull();
  });

  it('20 SLOW successful recalls => exceeded', () => {
    const lines = Array.from({ length: 20 }, () => op('helix_memory_recall', 999));
    const v = summarizeMetrics(lines, opts).verdict;
    expect(v.state).toBe('exceeded');
    expect(v.reason).toBeNull();
  });

  it('0 recalls => insufficient with NO provisional value', () => {
    const v = summarizeMetrics([], opts).verdict;
    expect(v.state).toBe('insufficient');
    expect(v.reason).toBe('no successful samples');
    expect(v.recallP95).toBeNull();
  });
});

describe('I1: runReport renders the operator-facing report end-to-end (F4 unlocked)', () => {
  // runReport is imported by NOTHING else in the suite (that was the I1 finding): a mutation that
  // redacts the provisional render under `insufficient` left all other tests green. These drive the
  // real CLI entry point end-to-end (temp metrics file -> captured stdout), not just summarizeMetrics.
  const opRow = (ms: number, ts: string): string =>
    JSON.stringify({ v: 1, kind: 'op', ts, op_id: 'o_x', 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': 'helix_memory_recall', duration_ms: ms, ok: true, 'error.type': null });

  function writeMetrics(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'helix-bench-report-'));
    const file = join(dir, 'metrics.jsonl');
    writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '');
    return file;
  }

  /** Spy/replace process.stdout.write for the duration of `run`, always restoring it — even if `run`
   *  throws — so a failing assertion never leaves stdout silently swallowed for later tests. */
  async function captureStdout(run: () => Promise<void>): Promise<string> {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await run();
    } finally {
      process.stdout.write = original;
    }
    return chunks.join('');
  }

  it('15 SLOW successful recalls: the insufficient state AND the provisional p95-vs-trigger comparison both render — the operator is not blinded', async () => {
    const ts = new Date().toISOString();   // inside runReport's default recency window
    const file = writeMetrics(Array.from({ length: 15 }, () => opRow(300, ts)));
    const out = await captureStdout(() => runReport({ file, sinceDays: 14 }));
    expect(out).toContain(`insufficient evidence (n < ${SAMPLE_FLOOR}) -- no judgment`);
    // The provisional comparison must carry the REAL computed p95 (300.0ms, nearest-rank over 15
    // samples all at 300ms) and the real trigger (150ms) -- not a redacted/constant placeholder.
    expect(out).toContain(`300.0ms (n=15, provisional -- below the ${SAMPLE_FLOOR}-sample floor) vs trigger 150ms`);
  });

  it('0 successful samples: NO provisional value is rendered', async () => {
    const file = writeMetrics([]);
    const out = await captureStdout(() => runReport({ file, sinceDays: 14 }));
    expect(out).toContain('insufficient evidence (no successful samples) -- no judgment');
    expect(out).toContain('recall op p95: (no successful samples)');
    expect(out).not.toMatch(/provisional/);
  });

  // Relabel (2026-07-17): this report is a DIAGNOSTIC, never the authoritative trigger -- that
  // authority moved to the helix-trigger daily snapshot (Phase 2 Track 2a). Neither prior test above
  // ever reached the 'exceeded' state, so the old "TRIGGER EXCEEDED" wording had NO test pinning its
  // actual rendered stdout (only summarizeMetrics().verdict.state was checked elsewhere in this file).
  it('25 SLOW successful recalls (exceeded state): no "TRIGGER EXCEEDED" wording anywhere; the non-authoritative diagnostic wording renders instead', async () => {
    const ts = new Date().toISOString();
    const file = writeMetrics(Array.from({ length: 25 }, () => opRow(999, ts)));
    const out = await captureStdout(() => runReport({ file, sinceDays: 14 }));
    expect(out).not.toContain('TRIGGER EXCEEDED');
    expect(out).toContain('windowed p95 diagnostic (non-authoritative)');
    expect(out).toContain('p95 over 150ms -- non-authoritative diagnostic; the authoritative trigger is the helix-trigger snapshot');
  });

  it('25 FAST successful recalls (below state): the retitled block header still renders (the title change applies to every state, not just exceeded)', async () => {
    const ts = new Date().toISOString();
    const file = writeMetrics(Array.from({ length: 25 }, () => opRow(5, ts)));
    const out = await captureStdout(() => runReport({ file, sinceDays: 14 }));
    expect(out).not.toContain('TRIGGER EXCEEDED');
    expect(out).toContain('windowed p95 diagnostic (non-authoritative)');
    expect(out).toContain('below trigger -- no action');
  });
});
