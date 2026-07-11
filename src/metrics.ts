// Content-free latency/size metrics (spec: docs/superpowers/specs/2026-07-05-replay-metrics-sensor-design.md).
// DELIBERATE POLICY SPLIT vs audit.ts: appendAudit is LOUD on failure (a security record must not
// silently fail); every method here SWALLOWS all errors (metrics are best-effort and must never
// take a tool call or session start down with them).
//
// HARD RULE (spec §3): records are metadata-only — no memory content, no query text, no paths, no
// error messages. `error.type` is the exception class name, or the constant 'NonError' for a
// non-Error throw (NEVER a stringified thrown value — a thrown string would leak verbatim).
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** One per-scope verifying read, camelCase in code — the sink writes snake_case wire names. */
export interface ReplayInput {
  scope: 'global' | 'project';
  caller: 'store' | 'hook';
  rows: number;
  liveRows: number;
  bytes: number;
  parseMs: number;
  projectMs: number;
  keyAvailable: boolean;
}

/** One auto-compaction attempt. Metadata-only (no content, no paths). */
export interface CompactionInput {
  scope: 'global' | 'project';
  durationMs: number;
  droppedRows: number;
  reclaimedBytes: number;
  /** Content-free count of forged verify rows dropped, measured under compactLedger's lock (0 on a
   *  failed/no-op compaction or when no HMAC subkey was available). */
  droppedForgedVerifies: number;
  ok: boolean;
}

export interface MetricsSink {
  /** Emit one replay record. Buffered while an op is active (flushed after duration capture). */
  emitReplay(r: ReplayInput): void;
  /** Emit one compaction record (best-effort, never throws). */
  emitCompaction(c: CompactionInput): void;
  /** Time a tool handler to settlement (sync or promise), emit one op record, and bracket a
   *  current-op id so replays emitted synchronously inside self-stamp it. Save/restore, not
   *  null-clear, so a nested runOp cannot orphan the outer op's later replays. */
  runOp<T>(tool: string, fn: () => T | Promise<T>): Promise<T>;
}

export interface MetricsSinkDeps {
  append?: (path: string, line: string) => void; // injectable for tests
  now?: () => string;
  genId?: () => string;
}

/** Shared no-op sink: methods do nothing; runOp still runs the handler. */
export const noopMetricsSink: MetricsSink = {
  emitReplay: () => {},
  emitCompaction: () => {},
  runOp: async (_tool, fn) => await fn(),
};

export function createMetricsSink(path: string, enabled: boolean, deps: MetricsSinkDeps = {}): MetricsSink {
  if (!enabled) return noopMetricsSink;
  const append = deps.append ?? ((p: string, line: string): void => {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, line, { mode: 0o600 }); // owner-only on create; O_APPEND, one line per record
  });
  const now = deps.now ?? ((): string => new Date().toISOString());
  const genId = deps.genId ?? ((): string => `o_${randomUUID()}`);

  let currentOpId: string | null = null;
  let buffer: string[] | null = null; // non-null while an op is active (signal purity, spec §5)

  const safeAppend = (line: string): void => { try { append(path, line); } catch { /* best-effort */ } };

  return {
    emitReplay(r: ReplayInput): void {
      try {
        const line = JSON.stringify({
          v: 1, kind: 'replay', ts: now(), op_id: currentOpId, scope: r.scope,
          rows: r.rows, live_rows: r.liveRows, bytes: r.bytes,
          parse_ms: r.parseMs, project_ms: r.projectMs,
          key_available: r.keyAvailable, caller: r.caller,
        }) + '\n';
        if (buffer) buffer.push(line); else safeAppend(line);
      } catch { /* never throw into a read path */ }
    },

    emitCompaction(c: CompactionInput): void {
      try {
        const line = JSON.stringify({
          v: 1, kind: 'compaction', ts: now(), op_id: currentOpId, scope: c.scope,
          duration_ms: c.durationMs, dropped_rows: c.droppedRows, reclaimed_bytes: c.reclaimedBytes,
          dropped_forged_verifies: c.droppedForgedVerifies, ok: c.ok,
        }) + '\n';
        if (buffer) buffer.push(line); else safeAppend(line);
      } catch { /* never throw into a compaction path */ }
    },

    async runOp<T>(tool: string, fn: () => T | Promise<T>): Promise<T> {
      const prevOp = currentOpId;
      const prevBuf = buffer;
      const opId = genId();
      const myBuf: string[] = [];
      currentOpId = opId;
      buffer = myBuf;
      const started = performance.now();
      let ok = true;
      let errorType: string | null = null;
      try {
        return await fn();
      } catch (e) {
        ok = false;
        errorType = e instanceof Error ? e.name : 'NonError';
        throw e;
      } finally {
        const durationMs = performance.now() - started; // capture BEFORE any metrics I/O
        currentOpId = prevOp;                            // stack-style restore
        buffer = prevBuf;
        try {
          safeAppend(JSON.stringify({
            v: 1, kind: 'op', ts: now(), op_id: opId,
            'mcp.method.name': 'tools/call', 'gen_ai.tool.name': tool,
            duration_ms: durationMs, ok, 'error.type': errorType,
          }) + '\n');
          for (const line of myBuf) safeAppend(line); // flush AFTER capture
        } catch { /* never throw */ }
      }
    },
  };
}
