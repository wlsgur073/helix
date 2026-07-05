import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { createMetricsSink, noopMetricsSink, type ReplayInput } from '../src/metrics.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'helix-metrics-'));
const replay = (over: Partial<ReplayInput> = {}): ReplayInput => ({
  scope: 'global', caller: 'store', rows: 3, liveRows: 2, bytes: 120,
  parseMs: 1.5, projectMs: 0.5, keyAvailable: true, ...over,
});
const lines = (path: string): Record<string, unknown>[] =>
  readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

describe('createMetricsSink', () => {
  it('writes a v1 replay line with wire field names and null op_id outside an op', () => {
    const path = join(tmp(), 'metrics.jsonl');
    const sink = createMetricsSink(path, true, { now: () => '2026-07-05T00:00:00.000Z' });
    sink.emitReplay(replay());
    const [row] = lines(path);
    expect(row).toMatchObject({
      v: 1, kind: 'replay', ts: '2026-07-05T00:00:00.000Z', op_id: null, scope: 'global',
      rows: 3, live_rows: 2, bytes: 120, parse_ms: 1.5, project_ms: 0.5,
      key_available: true, caller: 'store',
    });
  });

  it('runOp emits an op record and stamps its op_id into replays emitted inside', async () => {
    const path = join(tmp(), 'metrics.jsonl');
    const sink = createMetricsSink(path, true, { genId: () => 'o_test' });
    const out = await sink.runOp('helix_memory_recall', () => { sink.emitReplay(replay()); return 42; });
    expect(out).toBe(42);
    const rows = lines(path);
    const op = rows.find((r) => r.kind === 'op')!;
    const rp = rows.find((r) => r.kind === 'replay')!;
    expect(op).toMatchObject({
      v: 1, op_id: 'o_test', 'mcp.method.name': 'tools/call',
      'gen_ai.tool.name': 'helix_memory_recall', ok: true, 'error.type': null,
    });
    expect(typeof op.duration_ms).toBe('number');
    expect(rp.op_id).toBe('o_test');
  });

  it('records the exception class name, rethrows, and leaks no message', async () => {
    const path = join(tmp(), 'metrics.jsonl');
    const sink = createMetricsSink(path, true);
    await expect(sink.runOp('helix_memory_recall', () => { throw new TypeError('SECRET-MSG'); }))
      .rejects.toThrow(TypeError);
    const op = lines(path).find((r) => r.kind === 'op')!;
    expect(op.ok).toBe(false);
    expect(op['error.type']).toBe('TypeError');
    expect(readFileSync(path, 'utf8')).not.toContain('SECRET-MSG');
  });

  it("records 'NonError' for a thrown string and never stringifies the value", async () => {
    const path = join(tmp(), 'metrics.jsonl');
    const sink = createMetricsSink(path, true);
    await expect(sink.runOp('helix_memory_erase', () => { throw 'LEAKY-VALUE'; })).rejects.toBe('LEAKY-VALUE');
    const op = lines(path).find((r) => r.kind === 'op')!;
    expect(op['error.type']).toBe('NonError');
    expect(readFileSync(path, 'utf8')).not.toContain('LEAKY-VALUE');
  });

  it('never throws on an unwritable path and still returns the handler result', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'blocker'), ''); // a FILE where a dir is needed -> ENOTDIR on append
    const path = join(dir, 'blocker', 'metrics.jsonl');
    const sink = createMetricsSink(path, true);
    expect(() => sink.emitReplay(replay())).not.toThrow();
    await expect(sink.runOp('helix_memory_recall', () => 7)).resolves.toBe(7);
  });

  it('disabled sink and noopMetricsSink write nothing and still run the handler', async () => {
    const path = join(tmp(), 'metrics.jsonl');
    const sink = createMetricsSink(path, false);
    sink.emitReplay(replay());
    await expect(sink.runOp('helix_memory_recall', () => 1)).resolves.toBe(1);
    await expect(noopMetricsSink.runOp('helix_memory_recall', () => 2)).resolves.toBe(2);
    expect(() => statSync(path)).toThrow(); // file never created
  });

  it('signal purity: append latency does not inflate duration_ms (spec §9.13)', async () => {
    const path = join(tmp(), 'metrics.jsonl');
    const captured: string[] = [];
    const slowAppend = (_p: string, line: string): void => {
      const until = performance.now() + 25; // 25ms busy-wait per append
      while (performance.now() < until) { /* spin */ }
      captured.push(line);
    };
    const sink = createMetricsSink(path, true, { append: slowAppend });
    await sink.runOp('helix_memory_recall', () => { sink.emitReplay(replay()); sink.emitReplay(replay()); });
    const op = captured.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.kind === 'op')!;
    // 3 appends x 25ms happen AFTER capture; the handler itself is sub-ms.
    expect(op.duration_ms as number).toBeLessThan(20);
    expect(captured).toHaveLength(3);
  });

  it('restores the previous op bracket stack-style (nested runOp)', async () => {
    const path = join(tmp(), 'metrics.jsonl');
    const captured: string[] = [];
    const sink = createMetricsSink(path, true, { append: (_p, l) => captured.push(l), genId: (() => { let n = 0; return () => `o_${++n}`; })() });
    await sink.runOp('helix_memory_recall', async () => {
      await sink.runOp('helix_memory_inspect', () => { sink.emitReplay(replay()); });
      sink.emitReplay(replay()); // must stamp o_1 (outer), not null and not o_2
    });
    const rows = captured.map((l) => JSON.parse(l) as Record<string, unknown>);
    const replays = rows.filter((r) => r.kind === 'replay');
    expect(replays.map((r) => r.op_id).sort()).toEqual(['o_1', 'o_2']);
  });

  it('creates the file owner-only on POSIX (spec §9.14)', () => {
    if (platform() === 'win32') return; // mode bits not enforced on Windows
    const path = join(tmp(), 'metrics.jsonl');
    createMetricsSink(path, true).emitReplay(replay());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
