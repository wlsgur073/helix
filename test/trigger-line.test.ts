// Tests for the T1 trigger measurement CLI (Phase 2 Track 2a, Task A2 — see
// docs/superpowers/plans/2026-07-17-phase2-trigger-governance-and-disclosure.md). Exercises BOTH the
// thin CLI entry (main, from trigger-cli.ts) and the measurement module (trigger-measure.ts) it
// delegates to, per the task's tsconfig note: scripts/ is only typechecked transitively via test
// imports, so both modules must be imported here for `npm run typecheck` to see them at all.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/trigger-cli.js';
import {
  measureAndRecord,
  appendToSink,
  validateRecordLine,
  parseMetricsBuffer,
  resolveHome,
  resolveGlobalLedger,
  resolveProjectDisposition,
} from '../scripts/trigger-measure.js';
import { realFsOps, type DurableFsOps } from '../src/memory/fs-ops.js';
import { stampOwnership, projectLedgerPath } from '../src/memory/ownership.js';

const tmpHome = (): string => mkdtempSync(join(tmpdir(), 'helix-trigger-home-'));
const tmpProj = (): string => mkdtempSync(join(tmpdir(), 'helix-trigger-proj-'));

/** Spy on process.stdout.write for the duration of `run`, always restoring it (even on throw). */
function captureStdout(run: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

/** Same for stderr — main()'s usage/error messages land here, never on stdout (the record line owns
 *  stdout exclusively). */
function captureStderr(run: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}

// -------------------------------------------------------------------------------------------------
// resolveHome / resolveGlobalLedger — the pure env-resolution formula (mirrors src/server/index.ts:19-20)
// -------------------------------------------------------------------------------------------------
describe('resolveHome / resolveGlobalLedger (pure formula)', () => {
  it('HELIX_HOME set -> used verbatim; HELIX_LEDGER unset -> defaults to <home>/memory.jsonl', () => {
    expect(resolveHome({ HELIX_HOME: '/x/home' })).toBe('/x/home');
    expect(resolveGlobalLedger({}, '/x/home')).toBe(join('/x/home', 'memory.jsonl'));
  });
  it('HELIX_LEDGER set -> overrides the default', () => {
    expect(resolveGlobalLedger({ HELIX_LEDGER: '/custom/ledger.jsonl' }, '/x/home')).toBe('/custom/ledger.jsonl');
  });
  it('HELIX_HOME unset -> defaults to homedir()/.helix', () => {
    expect(resolveHome({})).toBe(join(homedir(), '.helix'));
  });
});

// -------------------------------------------------------------------------------------------------
// resolveProjectDisposition — owned / unowned / absent, incl. the cwd==~ collision guard
// -------------------------------------------------------------------------------------------------
describe('resolveProjectDisposition (pure-ish; real fs for existence/ownership)', () => {
  it('absent: no .helix dir at all', () => {
    const home = tmpHome();
    const root = tmpProj();
    expect(resolveProjectDisposition(root, home, join(home, 'memory.jsonl'))).toBe('absent');
  });
  it('unowned: .helix exists but is not stamped', () => {
    const home = tmpHome();
    const root = tmpProj();
    mkdirSync(join(root, '.helix'));
    expect(resolveProjectDisposition(root, home, join(home, 'memory.jsonl'))).toBe('unowned');
  });
  it('owned: stamped AND distinct from the global ledger path', () => {
    const home = tmpHome();
    const root = tmpProj();
    stampOwnership(root, home, { genStamp: () => 'stamp' });
    expect(resolveProjectDisposition(root, home, join(home, 'memory.jsonl'))).toBe('owned');
  });
  it('cwd==~ collision guard: stamped-owned but the project ledger resolves to the SAME path as the global ledger -> unowned', () => {
    const home = tmpHome();
    const root = tmpProj();
    stampOwnership(root, home, { genStamp: () => 'stamp' });
    expect(resolveProjectDisposition(root, home, projectLedgerPath(root))).toBe('unowned');
  });
});

// -------------------------------------------------------------------------------------------------
// parseMetricsBuffer — the bench-replay.ts:246-254 shape check, reimplemented over raw bytes
// -------------------------------------------------------------------------------------------------
describe('parseMetricsBuffer (pure)', () => {
  it('skips empty lines, marks malformed/wrong-shape lines unknown, keeps ok:false recalls (failed-but-completed)', () => {
    const lines = [
      JSON.stringify({ kind: 'op', 'gen_ai.tool.name': 'helix_memory_recall', duration_ms: 42 }),
      '',
      'not json at all',
      JSON.stringify({ kind: 'op', 'gen_ai.tool.name': 'helix_memory_recall', duration_ms: 7, ok: false }),
    ];
    const buf = Buffer.from(lines.join('\n') + '\n', 'utf8');
    expect(parseMetricsBuffer(buf)).toEqual([
      { kind: 'recall', ms: 42 },
      { kind: 'unknown', maxOps: 1 },
      { kind: 'recall', ms: 7 },
    ]);
  });
  it('a trailing line with NO newline is still parsed (not silently dropped)', () => {
    const buf = Buffer.from(JSON.stringify({ kind: 'op', 'gen_ai.tool.name': 'helix_memory_recall', duration_ms: 1 }), 'utf8');
    expect(parseMetricsBuffer(buf)).toEqual([{ kind: 'recall', ms: 1 }]);
  });
  // A well-formed non-recall op row is RECOGNIZED, not unknown: it is understood and known not to be
  // a recall, so it must not inflate the uncertain bucket. (Superseded 2026-07-17: this test used to
  // assert 'unknown' here -- a real ~70KB metrics file is MOSTLY non-recall rows, so classifying them
  // as pseudo-unknowns flooded the evaluator's trailing-200 window and degraded the latency leg toward
  // permanently 'unavailable' under completely normal traffic.)
  it('a well-formed OTHER-TOOL op row is EXCLUDED entirely -- not a recall, not an unknown', () => {
    const buf = Buffer.from(JSON.stringify({ kind: 'op', 'gen_ai.tool.name': 'helix_memory_commit', duration_ms: 1 }) + '\n', 'utf8');
    expect(parseMetricsBuffer(buf)).toEqual([]);
  });
  it('a kind:"replay" row is EXCLUDED entirely', () => {
    const buf = Buffer.from(JSON.stringify({ v: 1, kind: 'replay', ts: '2026-07-17T00:00:00.000Z', scope: 'global', rows: 10, bytes: 100, parse_ms: 1, project_ms: 1 }) + '\n', 'utf8');
    expect(parseMetricsBuffer(buf)).toEqual([]);
  });
  it('a kind:"compaction" row is EXCLUDED entirely', () => {
    const buf = Buffer.from(JSON.stringify({ v: 1, kind: 'compaction', ts: '2026-07-17T00:00:00.000Z', scope: 'global', duration_ms: 3, dropped_rows: 1, reclaimed_bytes: 10, ok: true }) + '\n', 'utf8');
    expect(parseMetricsBuffer(buf)).toEqual([]);
  });
  it('a newer-schema row (v>1) is unknown -- it could hide an unreadable recall, even if it otherwise looks like one', () => {
    const line = JSON.stringify({ v: 2, kind: 'op', 'gen_ai.tool.name': 'helix_memory_recall', duration_ms: 1 });
    const buf = Buffer.from(line + '\n', 'utf8');
    expect(parseMetricsBuffer(buf)).toEqual([{ kind: 'unknown', maxOps: Math.max(1, Math.floor(Buffer.byteLength(line, 'utf8') / 64)) }]);
  });
  it('an op row with a MISSING duration_ms is unknown -- could be an unreadable recall', () => {
    const buf = Buffer.from(JSON.stringify({ kind: 'op', 'gen_ai.tool.name': 'helix_memory_recall' }) + '\n', 'utf8');
    expect(parseMetricsBuffer(buf)).toEqual([{ kind: 'unknown', maxOps: 1 }]);
  });
  it('a recall-tool op row with a NON-NUMERIC duration_ms is unknown, not a recall', () => {
    const buf = Buffer.from(JSON.stringify({ kind: 'op', 'gen_ai.tool.name': 'helix_memory_recall', duration_ms: '42' }) + '\n', 'utf8');
    expect(parseMetricsBuffer(buf)).toEqual([{ kind: 'unknown', maxOps: 1 }]);
  });
  it('maxOps scales with BYTE length (>64 bytes -> maxOps > 1), not string char length', () => {
    const longUnknown = 'x'.repeat(200); // not valid JSON -> unknown
    const buf = Buffer.from(longUnknown, 'utf8');
    expect(parseMetricsBuffer(buf)).toEqual([{ kind: 'unknown', maxOps: Math.floor(200 / 64) }]);
  });
});

// -------------------------------------------------------------------------------------------------
// validateRecordLine — self-validation (re-parse + shape check) BEFORE any write
// -------------------------------------------------------------------------------------------------
describe('validateRecordLine (pure self-validation)', () => {
  const good = (): Record<string, unknown> => ({
    // FIXED timestamp, not new Date().toISOString(): two separate good() calls (one to build the
    // input line, one to build the expected object) must never straddle a millisecond tick.
    v: 1, policy: 'T1-2026-07-11', kind: 'evaluation', ts: '2026-07-17T00:00:00.000Z', run: 'r',
    service_result: null, exit_code: null, exit_status: null,
    legs: {
      rows: { min: 0, max: 0, threshold: 2500, status: 'false' },
      bytes: { min: 0, max: 0, threshold: 4194304, status: 'false' },
      latency: { min: null, max: null, threshold: 3, status: 'unavailable' },
    },
    latencyN: null, overall: 'indeterminate', project: 'absent', metricsState: 'absent',
    unknownLines: 0, unknownMaxOps: 0,
  });

  it('accepts a well-formed record and returns the parsed object', () => {
    expect(validateRecordLine(JSON.stringify(good()))).toEqual(good());
  });

  it('rejects a non-ASCII byte anywhere in the line (JSON.stringify does not escape it)', () => {
    const withHangul = JSON.stringify({ ...good(), run: '한글' });
    expect(withHangul).toContain('한글'); // premise: JSON.stringify really did pass it through literally
    expect(() => validateRecordLine(withHangul)).toThrow();
  });

  it.each([
    ['v', { ...good(), v: 2 }],
    ['policy', { ...good(), policy: 'wrong' }],
    ['kind', { ...good(), kind: 'other' }],
    ['ts', { ...good(), ts: 'not-a-date' }],
    ['run (empty string)', { ...good(), run: '' }],
    ['overall', { ...good(), overall: 'maybe' }],
    ['project', { ...good(), project: 'foreign' }],
    ['metricsState', { ...good(), metricsState: 'unknown' }],
    ['unknownLines (negative)', { ...good(), unknownLines: -1 }],
    ['legs.rows (missing status)', { ...good(), legs: { ...good().legs as object, rows: { min: 0, max: 0, threshold: 2500 } } }],
  ])('rejects a corrupted %s field', (_name, bad) => {
    expect(() => validateRecordLine(JSON.stringify(bad))).toThrow();
  });
});

// -------------------------------------------------------------------------------------------------
// appendToSink — durable append seam (open -> write -> fsync(fd) -> close -> fsyncDir ONLY on create)
// -------------------------------------------------------------------------------------------------
describe('appendToSink (sink durability seam)', () => {
  it('issues open -> write -> fsync(fd) -> close -> fsyncDir(parent) on CREATE; NOT fsyncDir on a later append', () => {
    const home = tmpHome();
    const ops: string[] = [];
    const wrapped: DurableFsOps = {
      ...realFsOps,
      openSync: (p, fl, m) => { ops.push('open'); return realFsOps.openSync(p, fl, m); },
      writeSync: (fd, b, o, l) => { ops.push('write'); return realFsOps.writeSync(fd, b, o, l); },
      fsyncSync: (fd) => { ops.push('fsync'); realFsOps.fsyncSync(fd); },
      closeSync: (fd) => { ops.push('close'); realFsOps.closeSync(fd); },
      fsyncDir: (d) => { ops.push('fsyncDir'); realFsOps.fsyncDir(d); },
    };
    appendToSink(home, JSON.stringify({ a: 1 }), wrapped);
    const i = (name: string): number => ops.indexOf(name);
    expect(i('open')).toBe(0);
    expect(i('write')).toBeGreaterThan(i('open'));
    expect(i('fsync')).toBeGreaterThan(i('write'));
    expect(i('close')).toBeGreaterThan(i('fsync'));
    expect(i('fsyncDir')).toBeGreaterThan(i('close'));
    expect(ops.filter((o) => o === 'fsyncDir')).toHaveLength(1);

    ops.length = 0;
    appendToSink(home, JSON.stringify({ a: 2 }), wrapped);
    expect(ops).toContain('open');
    expect(ops).toContain('write');
    expect(ops).not.toContain('fsyncDir'); // the sink already existed -- no directory fsync needed

    expect(readFileSync(join(home, 'trigger.jsonl'), 'utf8')).toBe('{"a":1}\n{"a":2}\n');
  });

  it('creates the sink file with mode 0600', () => {
    const home = tmpHome();
    appendToSink(home, JSON.stringify({ a: 1 }));
    const mode = statSync(join(home, 'trigger.jsonl')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// -------------------------------------------------------------------------------------------------
// measureAndRecord — end-to-end measurement + record composition
// -------------------------------------------------------------------------------------------------
describe('measureAndRecord (end-to-end)', () => {
  it('a totally fresh home (no ledger, no config, no metrics file) is a clean zero -- indeterminate, NOT not-fired', () => {
    const home = tmpHome();
    const root = tmpProj(); // no .helix
    const line = captureStdout(() =>
      measureAndRecord({ root, run: 'r', serviceResult: null, exitCode: null, exitStatus: null }, { env: { HELIX_HOME: home } }),
    );
    const record = JSON.parse(line);
    expect(record.project).toBe('absent');
    expect(record.metricsState).toBe('absent');
    expect(record.legs.rows).toEqual({ min: 0, max: 0, threshold: 2500, status: 'false' });
    expect(record.legs.bytes).toEqual({ min: 0, max: 0, threshold: 4194304, status: 'false' });
    expect(record.legs.latency).toEqual({ min: null, max: null, threshold: 3, status: 'unavailable' });
    expect(record.overall).toBe('indeterminate'); // latency coverage unproven -- not all three legs are 'false'
    expect(record.latencyN).toBeNull();
    expect(record.unknownLines).toBe(0);
    expect(record.unknownMaxOps).toBe(0);
    expect(record.v).toBe(1);
    expect(record.policy).toBe('T1-2026-07-11');
    expect(record.kind).toBe('evaluation');
  });

  it('an unowned project ledger is excluded even when it physically has content', () => {
    const home = tmpHome();
    const root = tmpProj();
    mkdirSync(join(root, '.helix'), { recursive: true });
    writeFileSync(join(root, '.helix', 'memory.jsonl'), 'x\n'.repeat(50)); // 50 rows, but UNSTAMPED
    writeFileSync(join(home, 'memory.jsonl'), 'g\n'); // 1 row, global
    const line = captureStdout(() =>
      measureAndRecord({ root, run: 'r', serviceResult: null, exitCode: null, exitStatus: null }, { env: { HELIX_HOME: home } }),
    );
    const record = JSON.parse(line);
    expect(record.project).toBe('unowned');
    expect(record.legs.rows.min).toBe(1); // only the global 1 row; the 50-row unowned file never contributes
  });

  it('an owned project sums rows/bytes across BOTH participants', () => {
    const home = tmpHome();
    const root = tmpProj();
    stampOwnership(root, home, { genStamp: () => 'stamp-happy' });
    writeFileSync(join(home, 'memory.jsonl'), 'g1\ng2\n'); // 2 rows
    writeFileSync(projectLedgerPath(root), 'p1\n'); // 1 row
    const line = captureStdout(() =>
      measureAndRecord({ root, run: 'r', serviceResult: 'success', exitCode: '0', exitStatus: '0/SUCCESS' }, { env: { HELIX_HOME: home } }),
    );
    const record = JSON.parse(line);
    expect(record.project).toBe('owned');
    expect(record.legs.rows.min).toBe(3); // 2 + 1
    expect(record.service_result).toBe('success');
    expect(record.exit_code).toBe('0');
    expect(record.exit_status).toBe('0/SUCCESS');
    expect(record.run).toBe('r');
  });

  it('a read-error participant (directory in place of the global ledger) leaves rows/bytes UNAVAILABLE while an independent latency crossing still fires overall', () => {
    const home = tmpHome();
    const root = tmpProj(); // absent project -- keeps this focused on the global read-error + latency leg
    mkdirSync(join(home, 'memory.jsonl')); // a DIRECTORY where the ledger file should be -> EISDIR -> read-error
    const slowRecall = JSON.stringify({ v: 1, kind: 'op', ts: '2026-07-17T00:00:00.000Z', 'gen_ai.tool.name': 'helix_memory_recall', duration_ms: 999, ok: true });
    writeFileSync(join(home, 'metrics.jsonl'), Array.from({ length: 3 }, () => slowRecall).join('\n') + '\n');
    const line = captureStdout(() =>
      measureAndRecord({ root, run: 'r', serviceResult: null, exitCode: null, exitStatus: null }, { env: { HELIX_HOME: home } }),
    );
    const record = JSON.parse(line);
    expect(record.legs.rows.status).toBe('unavailable');
    expect(record.legs.bytes.status).toBe('unavailable');
    expect(record.legs.latency.status).toBe('true');
    expect(record.overall).toBe('fired');
    expect(record.metricsState).toBe('present');
  });

  it('a read-error on the metrics file (directory) -> metricsState read-error, latency unavailable, record still validates+appends', () => {
    const home = tmpHome();
    const root = tmpProj();
    mkdirSync(join(home, 'metrics.jsonl')); // a DIRECTORY where the metrics file should be
    const line = captureStdout(() =>
      measureAndRecord({ root, run: 'r', serviceResult: null, exitCode: null, exitStatus: null }, { env: { HELIX_HOME: home } }),
    );
    const record = JSON.parse(line);
    expect(record.metricsState).toBe('read-error');
    expect(record.legs.latency).toEqual({ min: null, max: null, threshold: 3, status: 'unavailable' });
    expect(existsSync(join(home, 'trigger.jsonl'))).toBe(true); // read-error is a valid recorded STATE, not a crash
  });

  it('participants are two INDEPENDENT single-file snapshots, not one atomic cross-file snapshot (seam-injected mutation between reads)', () => {
    const home = tmpHome();
    const root = tmpProj();
    stampOwnership(root, home, { genStamp: () => 'stamp1' });
    const globalLedger = join(home, 'memory.jsonl');
    const projLedger = projectLedgerPath(root);

    let projectContent = 'p1\n'; // 1 row -- what a hypothetical atomic snapshot taken BEFORE any read would see
    const readFile = (path: string): Buffer => {
      if (path === globalLedger) {
        projectContent = 'p1\np2\np3\n'; // mutate the SECOND file as a side effect of reading the FIRST
        return Buffer.from('g1\n'); // 1 row
      }
      if (path === projLedger) return Buffer.from(projectContent);
      const err = new Error('ENOENT (test fixture)') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err; // any other path (e.g. metrics.jsonl) -> expected-absent, not a crash
    };
    const line = captureStdout(() =>
      measureAndRecord({ root, run: 'r', serviceResult: null, exitCode: null, exitStatus: null }, { env: { HELIX_HOME: home }, readFile }),
    );
    const record = JSON.parse(line);
    // project reflects the POST-mutation value (3 rows): its read happened AFTER, and independently
    // of, the global read -- proving the union is a sum of two independent snapshots, not one atomic
    // cross-file snapshot (which would have seen the PRE-mutation 1 row).
    expect(record.legs.rows.min).toBe(1 + 3);
  });

  it('cwd-independence: config loads from the explicit --root path, not process.cwd() (the loader pin)', () => {
    const home = tmpHome();
    const root = tmpProj();
    stampOwnership(root, home, { genStamp: () => 'stamp-cwd' });
    mkdirSync(join(root, '.helix'), { recursive: true });
    writeFileSync(join(root, '.helix', 'config.json'), JSON.stringify({ metrics: { enabled: false } }));
    const elsewhere = mkdtempSync(join(tmpdir(), 'helix-trigger-elsewhere-'));
    const prevCwd = process.cwd();
    process.chdir(elsewhere);
    try {
      const line = captureStdout(() =>
        measureAndRecord({ root, run: 'r', serviceResult: null, exitCode: null, exitStatus: null }, { env: { HELIX_HOME: home } }),
      );
      const record = JSON.parse(line);
      expect(record.metricsState).toBe('disabled');
    } finally {
      process.chdir(prevCwd);
    }
  });

  it('ledger row counting is newline-count based -- a torn/unterminated final line is NOT counted as a row (documented T1 semantics)', () => {
    const home = tmpHome();
    const root = tmpProj();
    const content = 'row1\nrow2\npartial-no-newline';
    writeFileSync(join(home, 'memory.jsonl'), content);
    const line = captureStdout(() =>
      measureAndRecord({ root, run: 'r', serviceResult: null, exitCode: null, exitStatus: null }, { env: { HELIX_HOME: home } }),
    );
    const record = JSON.parse(line);
    expect(record.legs.rows.min).toBe(2); // the torn tail contributes 0 rows
    expect(record.legs.bytes.min).toBe(Buffer.byteLength(content, 'utf8')); // but its bytes still count
  });

  it('unknown-line accounting end-to-end: recognized non-recall rows are EXCLUDED (not unknown); malformed rows are unknown; empty lines skipped; ok:false recalls counted', () => {
    const home = tmpHome();
    const root = tmpProj();
    const ts = '2026-07-17T00:00:00.000Z';
    const malformed = '{not json';
    const otherToolOp = JSON.stringify({ v: 1, kind: 'op', ts, 'gen_ai.tool.name': 'helix_memory_commit', duration_ms: 5, ok: true });
    const replayRow = JSON.stringify({ v: 1, kind: 'replay', ts, scope: 'global', rows: 10, bytes: 100, parse_ms: 1, project_ms: 1 });
    const compactionRow = JSON.stringify({ v: 1, kind: 'compaction', ts, scope: 'global', duration_ms: 3, dropped_rows: 1, reclaimed_bytes: 10, ok: true });
    const lines = [
      JSON.stringify({ v: 1, kind: 'op', ts, 'gen_ai.tool.name': 'helix_memory_recall', duration_ms: 200, ok: true }), // slow recall
      '', // empty -> skipped, not unknown
      malformed, // -> unknown
      otherToolOp, // -> EXCLUDED (recognized non-recall op)
      replayRow, // -> EXCLUDED (recognized replay row)
      compactionRow, // -> EXCLUDED (recognized compaction row)
      JSON.stringify({ v: 1, kind: 'op', ts, 'gen_ai.tool.name': 'helix_memory_recall', duration_ms: 50, ok: false }), // fast, FAILED but completed -> still a recall
    ];
    writeFileSync(join(home, 'metrics.jsonl'), lines.join('\n') + '\n');
    const line = captureStdout(() =>
      measureAndRecord({ root, run: 'r', serviceResult: null, exitCode: null, exitStatus: null }, { env: { HELIX_HOME: home } }),
    );
    const record = JSON.parse(line);
    const expectedUnknownMaxOps = Math.max(1, Math.floor(Buffer.byteLength(malformed, 'utf8') / 64));
    expect(record.metricsState).toBe('present');
    expect(record.unknownLines).toBe(1); // only the malformed line -- the 3 recognized rows are excluded, not unknown
    expect(record.unknownMaxOps).toBe(expectedUnknownMaxOps);
    expect(record.latencyN).toBe(2); // exactly 2 kind:'recall' entries (ok:false still counts; excluded rows aren't in the event list)
    expect(record.legs.latency.min).toBe(1); // only the 200ms one is genuinely slow
    expect(record.legs.latency.max).toBe(1 + expectedUnknownMaxOps); // + the one real unknown assumed slow
  });

  // Regression lock for the reviewed defect: a real metrics file is MOSTLY non-recall rows. Before the
  // fix, each was misclassified 'unknown' and flooded the evaluator's trailing-200 window, so 3
  // genuinely slow recalls sitting further back in the file could be pushed entirely out of the
  // window (their replacement pseudo-unknowns would then split the bound across the threshold,
  // degrading the leg to 'unavailable' instead of 'true'). With the fix, none of the 250 recognized
  // rows below occupy a window slot at all.
  it('a realistic-traffic metrics file (mostly replay/other-tool rows) still fires the latency leg -- the exact bug this fix closes', () => {
    const home = tmpHome();
    const root = tmpProj();
    const ts = '2026-07-17T00:00:00.000Z';
    const slowRecall = JSON.stringify({ v: 1, kind: 'op', ts, 'gen_ai.tool.name': 'helix_memory_recall', duration_ms: 999, ok: true });
    const otherToolOp = JSON.stringify({ v: 1, kind: 'op', ts, 'gen_ai.tool.name': 'helix_memory_commit', duration_ms: 5, ok: true });
    const replayRow = JSON.stringify({ v: 1, kind: 'replay', ts, scope: 'global', rows: 10, bytes: 100, parse_ms: 1, project_ms: 1 });
    // 3 slow recalls FIRST (oldest), then 250 recognized non-recall rows AFTER them (newest) -- under
    // the old buggy classification those 250 rows alone would exceed the 200-wide window, pushing
    // these 3 recalls out of it entirely.
    const lines = [slowRecall, slowRecall, slowRecall, ...Array.from({ length: 250 }, (_, i) => (i % 2 === 0 ? otherToolOp : replayRow))];
    writeFileSync(join(home, 'metrics.jsonl'), lines.join('\n') + '\n');
    const line = captureStdout(() =>
      measureAndRecord({ root, run: 'r', serviceResult: null, exitCode: null, exitStatus: null }, { env: { HELIX_HOME: home } }),
    );
    const record = JSON.parse(line);
    expect(record.unknownLines).toBe(0); // every non-recall row was RECOGNIZED, not unknown
    expect(record.legs.latency).toEqual({ min: 3, max: 3, threshold: 3, status: 'true' });
    expect(record.overall).toBe('fired');
  });

  it('the record never contains the --root or HELIX_HOME filesystem paths (content-free discipline)', () => {
    const home = tmpHome();
    const root = tmpProj();
    const line = captureStdout(() =>
      measureAndRecord({ root, run: 'r', serviceResult: null, exitCode: null, exitStatus: null }, { env: { HELIX_HOME: home } }),
    );
    expect(line).not.toContain(root);
    expect(line).not.toContain(home);
  });

  it('the printed stdout line is byte-identical to the appended sink line', () => {
    const home = tmpHome();
    const root = tmpProj();
    const printed = captureStdout(() => {
      measureAndRecord({ root, run: 'r', serviceResult: null, exitCode: null, exitStatus: null }, { env: { HELIX_HOME: home } });
    });
    const appended = readFileSync(join(home, 'trigger.jsonl'), 'utf8');
    expect(printed).toBe(appended);
  });

  it('deps.env and deps.readFile both default to the real process.env / fs when omitted', () => {
    const home = tmpHome();
    const root = tmpProj();
    const prevHome = process.env.HELIX_HOME;
    const prevLedger = process.env.HELIX_LEDGER;
    process.env.HELIX_HOME = home;
    delete process.env.HELIX_LEDGER;
    try {
      const line = captureStdout(() => measureAndRecord({ root, run: 'r', serviceResult: null, exitCode: null, exitStatus: null })); // NO deps at all
      const record = JSON.parse(line);
      expect(record.project).toBe('absent');
      expect(existsSync(join(home, 'trigger.jsonl'))).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HELIX_HOME; else process.env.HELIX_HOME = prevHome;
      if (prevLedger === undefined) delete process.env.HELIX_LEDGER; else process.env.HELIX_LEDGER = prevLedger;
    }
  });
});

// -------------------------------------------------------------------------------------------------
// main — CLI entry: argv parsing, exit-code contract, deps wiring
// -------------------------------------------------------------------------------------------------
describe('main (CLI entry)', () => {
  it('missing --root -> usage to stderr, exit 2, no measurement attempted', () => {
    const exits: number[] = [];
    let result = -1;
    const stderrText = captureStderr(() => {
      result = main(['--run', 'r1'], { exit: (c) => exits.push(c) });
    });
    expect(result).toBe(2);
    expect(exits).toEqual([2]);
    expect(stderrText).toMatch(/usage/i);
  });

  it('missing --run -> usage to stderr, exit 2', () => {
    const exits: number[] = [];
    let result = -1;
    const stderrText = captureStderr(() => {
      result = main(['--root', '/tmp/whatever'], { exit: (c) => exits.push(c) });
    });
    expect(result).toBe(2);
    expect(exits).toEqual([2]);
    expect(stderrText).toMatch(/usage/i);
  });

  it('empty-string --root counts as missing (not just entirely absent)', () => {
    const exits: number[] = [];
    captureStderr(() => {
      const result = main(['--root', '', '--run', 'r1'], { exit: (c) => exits.push(c) });
      expect(result).toBe(2);
    });
    expect(exits).toEqual([2]);
  });

  it('optional flags: entirely absent AND present-but-empty both collapse to null; a real value passes through verbatim', () => {
    const home = tmpHome();
    const root = tmpProj();

    let line = captureStdout(() => {
      const code = main(['--root', root, '--run', 'run-a'], { exit: () => {}, env: { HELIX_HOME: home } });
      expect(code).toBe(0);
    });
    let record = JSON.parse(line);
    expect(record.service_result).toBeNull();
    expect(record.exit_code).toBeNull();
    expect(record.exit_status).toBeNull();
    expect(record.run).toBe('run-a');

    line = captureStdout(() => {
      const code = main(
        ['--root', root, '--run', 'run-b', '--service-result', '', '--exit-code', '', '--exit-status', ''],
        { exit: () => {}, env: { HELIX_HOME: home } },
      );
      expect(code).toBe(0);
    });
    record = JSON.parse(line);
    expect(record.service_result).toBeNull();
    expect(record.exit_code).toBeNull();
    expect(record.exit_status).toBeNull();

    line = captureStdout(() => {
      const code = main(
        ['--root', root, '--run', 'run-c', '--service-result', 'success', '--exit-code', '0', '--exit-status', '0/SUCCESS'],
        { exit: () => {}, env: { HELIX_HOME: home } },
      );
      expect(code).toBe(0);
    });
    record = JSON.parse(line);
    expect(record.service_result).toBe('success');
    expect(record.exit_code).toBe('0');
    expect(record.exit_status).toBe('0/SUCCESS');
  });

  it('a self-validation failure (forced via a broken now() seam) returns exit 1 and appends NOTHING', () => {
    const home = tmpHome();
    const root = tmpProj();
    const exits: number[] = [];
    let result = -1;
    const stderrText = captureStderr(() => {
      result = main(['--root', root, '--run', 'r1'], { env: { HELIX_HOME: home }, now: () => '', exit: (c) => exits.push(c) });
    });
    expect(result).toBe(1);
    expect(exits).toEqual([1]);
    expect(stderrText.length).toBeGreaterThan(0);
    expect(existsSync(join(home, 'trigger.jsonl'))).toBe(false);
  });

  it('a non-ASCII --run value fails self-validation (ASCII-only output is enforced, not incidental) -> exit 1, no append', () => {
    const home = tmpHome();
    const root = tmpProj();
    const exits: number[] = [];
    let result = -1;
    const stderrText = captureStderr(() => {
      result = main(['--root', root, '--run', '한글'], { env: { HELIX_HOME: home }, exit: (c) => exits.push(c) });
    });
    expect(result).toBe(1);
    expect(exits).toEqual([1]);
    expect(stderrText.length).toBeGreaterThan(0);
    expect(existsSync(join(home, 'trigger.jsonl'))).toBe(false);
  });

  it('append succeeds but the stdout print throws -> still exit 1; the append is NOT rolled back', () => {
    const home = tmpHome();
    const root = tmpProj();
    const exits: number[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => { throw new Error('EPIPE fake'); }) as typeof process.stdout.write;
    let result = -1;
    let stderrText = '';
    try {
      stderrText = captureStderr(() => {
        result = main(['--root', root, '--run', 'r1'], { env: { HELIX_HOME: home }, exit: (c) => exits.push(c) });
      });
    } finally {
      process.stdout.write = original;
    }
    expect(result).toBe(1);
    expect(exits).toEqual([1]);
    expect(stderrText.length).toBeGreaterThan(0);
    expect(existsSync(join(home, 'trigger.jsonl'))).toBe(true);
    expect(readFileSync(join(home, 'trigger.jsonl'), 'utf8')).toContain('"kind":"evaluation"');
  });
});
