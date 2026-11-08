// Measurement module for the T1 trigger daily snapshot. Resolves the same PARTICIPANTS the
// production server resolves (src/server/index.ts), and reads its one configuration switch —
// whether the metrics leg is enabled — from the GLOBAL config, exactly as the server and the
// SessionStart hook do. The measured repository is a subject, never a configuration source: it
// names the project ledger to size, and nothing else.
// Feeds the result to the pure evaluator (trigger-eval.ts), composes ONE self-validated JSON record, and
// owns the fsynced append to the trigger sink. scripts/trigger-cli.ts is the thin argv-parsing entry;
// this module holds every measurement/compose/validate/append step behind an injectable reader seam
// (deps.readFile) and an injectable env seam (deps.env) so tests run fully hermetically — no real
// ~/.helix is ever touched by a test that supplies deps.
import { constants, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { realFsOps, writeAll, type DurableFsOps } from '../src/memory/fs-ops.js';
import { judgeProjectLayer, projectLedgerPath } from '../src/memory/ownership.js';
import { hasOwnHelixEntry } from '../src/memory/project-root.js';
import { metricsEnabledFromGlobalConfig } from '../src/config.js';
import { resolveHelixPaths } from '../src/memory/home-env.js';
import { ensureHelixDir } from '../src/memory/home-permissions.js';
import { NotRegularHomeFileError } from '../src/memory/home-files.js';
import { readLedgerFileBytes } from '../src/memory/ledger.js';
import { evaluateTrigger, type Leg, type MetricsEvent, type MetricsState, type ParticipantSize } from './trigger-eval.js';

const POLICY = 'T1-2026-07-11';
const SINK_FILE = 'trigger.jsonl';
const METRICS_FILE = 'metrics.jsonl';

/** The default whole-file reader of both entry points: readLedgerFileBytes, which opens O_NONBLOCK, asks the descriptor what it is
 *  and refuses anything but a regular file (LedgerNotRegularError, no errno code), while ENOENT keeps its code. */
const defaultReadFile = (p: string): Buffer => readLedgerFileBytes(p);

/** The sink is appended to through a descriptor that is read-write (the tail byte is looked at), append-only, never follows a link at
 *  the name and never blocks in the open: a FIFO opens under O_RDWR and is refused by the descriptor's type, a link ends in ELOOP, a
 *  directory in EISDIR, a socket or driverless device in ENXIO. Where the platform lacks O_NOFOLLOW the OR drops it (as in ledger.ts). */
const SINK_OPEN = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const SINK_NOT_REGULAR_OPEN_ERRORS: ReadonlySet<string> = new Set(['ENXIO', 'ELOOP', 'EISDIR']);

/** Injectable seams. Production defaults are the real filesystem/env; tests override these to run
 *  hermetically and to pin the non-atomic per-participant read semantics (see readTwoParticipants). */
export interface MeasureDeps {
  /** Whole-file read, one call per participant/metrics file. Default: readLedgerFileBytes
   *  (src/memory/ledger.ts), which refuses what is not a regular file and keeps ENOENT's code. Returns a
   *  Buffer (never a decoded string) because both `bytes` and the unknown-line maxOps estimate are
   *  defined in terms of raw byte length. */
  readFile?: (path: string) => Buffer;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  /** Sink open/write/fsync/close/fsyncDir seam — reuses the repo's shared durable-write contract
   *  (src/memory/fs-ops.ts) so tests can observe the exact syscall order, the same way
   *  test/memory/append-durability.test.ts pins the ledger's append order. */
  fs?: DurableFsOps;
}

export interface EvaluationRecord {
  v: 1;
  policy: typeof POLICY;
  kind: 'evaluation';
  ts: string;
  run: string;
  service_result: string | null;
  exit_code: string | null;
  exit_status: string | null;
  legs: { rows: Leg; bytes: Leg; latency: Leg };
  latencyN: number | null;
  overall: 'fired' | 'not-fired' | 'indeterminate';
  project: 'owned' | 'unowned' | 'absent';
  metricsState: MetricsState;
  unknownLines: number;
  unknownMaxOps: number;
}

export interface MeasureInput {
  root: string;
  run: string;
  serviceResult: string | null;
  exitCode: string | null;
  exitStatus: string | null;
}

type ReadOutcome = { state: 'read'; rows: number; bytes: number } | { state: 'expected-absent' } | { state: 'read-error' };

/** ONE whole-file read through the seam. ENOENT -> expected-absent (a clean read of "nothing there
 *  yet"); any other error (a directory, FIFO or device swapped in for the ledger is a
 *  LedgerNotRegularError, which carries no code) -> read-error.
 *  rows = physical newline count — a torn, unterminated final line contributes 0 rows though its
 *  bytes still count (documented T1 semantics: T1 counts physical rows, not parsed records). */
function readWholeFile(path: string, readFile: (p: string) => Buffer): ReadOutcome {
  let buf: Buffer;
  try {
    buf = readFile(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return { state: code === 'ENOENT' ? 'expected-absent' : 'read-error' };
  }
  let rows = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) rows++;
  return { state: 'read', rows, bytes: buf.length };
}

function toParticipant(id: 'global' | 'project', outcome: ReadOutcome): ParticipantSize {
  return outcome.state === 'read' ? { id, state: 'read', rows: outcome.rows, bytes: outcome.bytes } : { id, state: outcome.state };
}

/** 'owned' iff a project layer exists and the one judgement (ownership.ts judgeProjectLayer) reads it
 *  'owned'; its row 7 is the cwd==~ collision guard. 'unowned' whenever a project layer exists but that
 *  fails, and the sink keeps these three values: an 'aliased' or 'unusable' layer is recorded as 'unowned'
 *  (design 4.2). 'absent' when there is no project layer at all. Only 'owned' ever contributes bytes/rows
 *  — see readTwoParticipants. */
export function resolveProjectDisposition(root: string, home: string, globalLedger: string): 'owned' | 'unowned' | 'absent' {
  if (!hasOwnHelixEntry(root)) return 'absent';
  return judgeProjectLayer({ root, ledger: projectLedgerPath(root), home, globalLedger }).state === 'owned' ? 'owned' : 'unowned';
}

/** Reads BOTH participants, global THEN project, as two INDEPENDENT single-file snapshots — not one
 *  atomic cross-file snapshot ("the union is DEFINED as the sum of per-participant single-read
 *  snapshots"). The order (global first) is a real contract, not an implementation detail: a
 *  seam-injected mutation timed off the global call is how the module test pins the semantics. An
 *  'unowned'/'absent' project is never read at all — its bytes/rows never contribute, even if the
 *  file physically exists ("Only an 'owned' project ledger is a participant"). */
function readTwoParticipants(
  globalLedger: string,
  root: string,
  home: string,
  disposition: 'owned' | 'unowned' | 'absent',
  readFile: (path: string) => Buffer,
): ParticipantSize[] {
  const global = toParticipant('global', readWholeFile(globalLedger, readFile));
  const project: ParticipantSize =
    disposition === 'owned' ? toParticipant('project', readWholeFile(projectLedgerPath(root), readFile)) : { id: 'project', state: 'expected-absent' };
  return [global, project];
}

/** Classifies one physical metrics line, mirroring bench-replay.ts's acceptance taxonomy
 *  (bench-replay.ts:246-269) at the CATEGORY level — 'op'/'replay'/'compaction' are the three
 *  recognized row kinds — without needing bench-replay's own per-field strictness for replay/
 *  compaction (that strictness exists there because it aggregates those rows' numeric fields for
 *  percentile stats; this module only asks "is this line a recall, a recognized non-recall we can
 *  safely ignore, or genuinely unreadable").
 *
 *  Returns:
 *   - {kind:'recall', ms}   — a helix_memory_recall op with a numeric duration_ms (ok:false included,
 *                             `ok` is never checked).
 *   - null                  — a RECOGNIZED non-recall row: excluded from the event list entirely, so
 *                             it contributes NOTHING to events, unknownLines, or unknownMaxOps. This
 *                             is any other-tool 'op' row with a valid (string tool name, numeric
 *                             duration_ms) shape, any 'replay' row, or any 'compaction' row. A real
 *                             metrics file is MOSTLY these rows; treating them as 'unknown' would
 *                             flood the evaluator's trailing-200 window with maxOps-expanded
 *                             pseudo-unknowns and degrade the latency leg toward permanently
 *                             'unavailable' under completely normal traffic.
 *   - {kind:'unknown', ...} — genuinely unreadable: JSON.parse failure; a NEWER schema (v present and
 *                             > 1 — could hide a recall this reader cannot interpret, mirroring
 *                             bench-replay's own newer-schema skip, checked before kind dispatch); an
 *                             'op' row with a missing/non-numeric duration_ms or a non-string tool
 *                             name (could be a recall with unreadable fields); or any unrecognized
 *                             kind. Carries a byte-bounded maxOps estimate the evaluator uses to bound
 *                             how many ops a torn-then-repaired physical line could be hiding. */
function parseMetricsLine(lineBuf: Buffer): MetricsEvent | null {
  const maxOps = Math.max(1, Math.floor(lineBuf.length / 64));
  const unknown = (): MetricsEvent => ({ kind: 'unknown', maxOps });
  let row: unknown;
  try {
    row = JSON.parse(lineBuf.toString('utf8'));
  } catch {
    return unknown();
  }
  if (row === null || typeof row !== 'object') return unknown();
  const r = row as Record<string, unknown>;
  if (typeof r.v === 'number' && r.v > 1) return unknown(); // newer schema — could hide an unreadable recall
  if (r.kind === 'op' && typeof r['gen_ai.tool.name'] === 'string' && typeof r.duration_ms === 'number') {
    return r['gen_ai.tool.name'] === 'helix_memory_recall' ? { kind: 'recall', ms: r.duration_ms } : null;
  }
  if (r.kind === 'replay' || r.kind === 'compaction') return null;
  return unknown();
}

/** Splits on physical newlines at the BYTE level (maxOps needs byte length, not decoded char length,
 *  so this slices the Buffer directly, never a decoded string). Empty lines (consecutive/trailing
 *  newlines) are skipped entirely — never counted as unknown. A trailing line with no terminating
 *  newline is still attempted (mirrors readline's behavior, which is what bench-replay.ts's own
 *  --report reader uses). File order is preserved, oldest-first. A recognized non-recall line
 *  (parseMetricsLine returning null) is dropped here, not pushed as any kind of event. */
export function parseMetricsBuffer(buf: Buffer): MetricsEvent[] {
  const events: MetricsEvent[] = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      if (i > start) {
        const event = parseMetricsLine(buf.subarray(start, i));
        if (event !== null) events.push(event);
      }
      start = i + 1;
    }
  }
  return events;
}

/** disabled (config) wins first, even over an absent file; then ENOENT -> absent; any other read
 *  failure -> read-error; else present (and the file's events are parsed).
 *
 *  The switch is read GLOBAL-only, matching the server and the SessionStart hook. It has to be: the
 *  file being measured is `<home>/metrics.jsonl`, so whether that measurement is enabled is a
 *  property of the home, not of whichever repository is being measured — and taking it from the
 *  measured repo let a checkout suppress the evidence behind the storage-migration decision. */
function resolveMetrics(home: string, readFile: (path: string) => Buffer): { state: MetricsState; events: MetricsEvent[] | null } {
  if (!metricsEnabledFromGlobalConfig(home)) return { state: 'disabled', events: null };
  let buf: Buffer;
  try {
    buf = readFile(join(home, METRICS_FILE));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return { state: code === 'ENOENT' ? 'absent' : 'read-error', events: null };
  }
  return { state: 'present', events: parseMetricsBuffer(buf) };
}

/** Whole-file totals (not windowed — the evaluator owns its own trailing-window rule internally for
 *  the latency leg; these two record fields describe overall parse quality of the metrics file). */
function summarizeUnknowns(events: MetricsEvent[]): { unknownLines: number; unknownMaxOps: number } {
  let unknownLines = 0;
  let unknownMaxOps = 0;
  for (const e of events) {
    if (e.kind === 'unknown') {
      unknownLines++;
      unknownMaxOps += e.maxOps;
    }
  }
  return { unknownLines, unknownMaxOps };
}

function isLegShape(v: unknown): v is Leg {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    (o.min === null || typeof o.min === 'number') &&
    (o.max === null || typeof o.max === 'number') &&
    typeof o.threshold === 'number' &&
    (o.status === 'true' || o.status === 'false' || o.status === 'unavailable')
  );
}

/** Re-parses the EXACT serialized bytes and shape-checks every required field/enum before anything is
 *  written anywhere ("the artifact re-parses and shape-checks the EXACT serialized bytes immediately
 *  before write/print"). Throws with a descriptive message on any mismatch. This is a
 *  belt-and-suspenders internal-bug detector (the record is built entirely from typed data flowing
 *  through the evaluator and the resolvers above), not a defense against untrusted input.
 *
 *  Includes the ASCII-only check: JSON.stringify does NOT escape non-ASCII characters (a Hangul or
 *  emoji byte in `run`/`service_result`/`exit_code`/`exit_status` — the only free-form fields, all
 *  CLI-argv-supplied — would pass through into the output literally), so without an explicit check
 *  here "ASCII-only output" would hold only by the happenstance of what the caller passed, not by
 *  enforcement. */
export function validateRecordLine(line: string): EvaluationRecord {
  const fail = (field: string): never => { throw new Error(`trigger record self-validation failed: ${field}`); };
  // eslint-disable-next-line no-control-regex -- deliberately matching the full ASCII byte range
  if (!/^[\x00-\x7F]*$/.test(line)) fail('non-ASCII byte in output');
  const parsed = JSON.parse(line) as Record<string, unknown>;
  if (parsed.v !== 1) fail('v');
  if (parsed.policy !== POLICY) fail('policy');
  if (parsed.kind !== 'evaluation') fail('kind');
  if (typeof parsed.ts !== 'string' || Number.isNaN(Date.parse(parsed.ts))) fail('ts');
  if (typeof parsed.run !== 'string' || parsed.run === '') fail('run');
  for (const field of ['service_result', 'exit_code', 'exit_status']) {
    const v = parsed[field];
    if (v !== null && typeof v !== 'string') fail(field);
  }
  const legs = parsed.legs as Record<string, unknown> | undefined;
  if (!legs || !isLegShape(legs.rows) || !isLegShape(legs.bytes) || !isLegShape(legs.latency)) fail('legs');
  if (parsed.latencyN !== null && typeof parsed.latencyN !== 'number') fail('latencyN');
  if (parsed.overall !== 'fired' && parsed.overall !== 'not-fired' && parsed.overall !== 'indeterminate') fail('overall');
  if (parsed.project !== 'owned' && parsed.project !== 'unowned' && parsed.project !== 'absent') fail('project');
  if (parsed.metricsState !== 'present' && parsed.metricsState !== 'absent' && parsed.metricsState !== 'disabled' && parsed.metricsState !== 'read-error') {
    fail('metricsState');
  }
  if (typeof parsed.unknownLines !== 'number' || parsed.unknownLines < 0) fail('unknownLines');
  if (typeof parsed.unknownMaxOps !== 'number' || parsed.unknownMaxOps < 0) fail('unknownMaxOps');
  return parsed as unknown as EvaluationRecord;
}

/** Append the validated line + fsync, then fsync the directory ONLY when this call CREATED the file — an append to an already-existing
 *  sink does not need a directory fsync (the directory entry did not change), unlike the ledger's unconditional fsyncDir on every
 *  append (src/memory/ledger.ts appendRecordUnlocked). Existence is checked BEFORE opening, by lstat, so a dangling link counts as
 *  present and the open refuses it; a mid-call race with a concurrent creator is an accepted, documented risk (single writer per
 *  record kind, by design — the CLI is the only writer of 'evaluation' and 'acknowledgement' rows).
 *
 *  The sink follows the home rule (B2a ruling F): the home goes through ensureHelixDir, so a symlinked home, a home that is not a
 *  directory, another user's directory and a missing parent are HomeRefusalError and nothing is written, a missing home whose parent
 *  exists is created 0700 and an existing home's mode is left alone. The sink itself must be a regular file, found out on the
 *  descriptor (SINK_OPEN): anything else is NotRegularHomeFileError. When the file does not end in a newline (a write cut short by a
 *  kill or a full disk) the record starts on a line of its own, the separator sharing the record's single write and fsync, as in the
 *  ledger's append (IT-LOW 11); the fragment stays where it is, one malformed line the readers already skip. */
export function appendToSink(home: string, line: string, fs: DurableFsOps = realFsOps): void {
  const path = join(home, SINK_FILE);
  ensureHelixDir(home);
  const existedBefore = sinkPresent(path);
  let fd: number;
  try {
    fd = fs.openSync(path, SINK_OPEN, 0o600);   // owner-only ON CREATE; the umask can only clear bits
  } catch (e) {
    if (SINK_NOT_REGULAR_OPEN_ERRORS.has((e as NodeJS.ErrnoException).code ?? '')) throw new NotRegularHomeFileError();
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    if ((st.mode & constants.S_IFMT) !== constants.S_IFREG) throw new NotRegularHomeFileError();
    let data = line + '\n';
    if (st.size > 0) {
      const tail = Buffer.alloc(1);
      fs.readSync(fd, tail, 0, 1, st.size - 1);
      if (tail[0] !== 0x0a) data = '\n' + data;   // tail repair: separator + record share one write and one fsync
    }
    writeAll(fs, fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!existedBefore) fs.fsyncDir(dirname(path));
}

/** lstat, not existsSync: a dangling link at the name is present, and the open then refuses it. */
function sinkPresent(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** T1-STICKY (item 7): a record that a fire was HANDLED. Written only by `helix-trigger --acknowledge`
 *  (single writer per record kind), content-free, and it changes nothing about how an evaluation is
 *  computed — policy, thresholds and the evaluation record are untouched. The fired-history readers
 *  (both copies of trigger_fired_summary) go quiet after it until a later evaluation shows NEW
 *  evidence. `evaluationTs` and `legs` copy the LATEST evaluation when the acknowledgement is taken,
 *  whatever that evaluation reads (acknowledgeLatest says why): the baseline a re-arm compares against. */
export interface AcknowledgementRecord {
  v: 1;
  policy: typeof POLICY;
  kind: 'acknowledgement';
  ts: string;
  evaluationTs: string;
  legs: { rows: Leg; bytes: Leg; latency: Leg };
}

export function validateAcknowledgementLine(line: string): AcknowledgementRecord {
  const fail = (field: string): never => { throw new Error(`trigger acknowledgement self-validation failed: ${field}`); };
  // eslint-disable-next-line no-control-regex -- deliberately matching the full ASCII byte range
  if (!/^[\x00-\x7F]*$/.test(line)) fail('non-ASCII byte in output');
  const parsed = JSON.parse(line) as Record<string, unknown>;
  if (parsed.v !== 1) fail('v');
  if (parsed.policy !== POLICY) fail('policy');
  if (parsed.kind !== 'acknowledgement') fail('kind');
  if (typeof parsed.ts !== 'string' || Number.isNaN(Date.parse(parsed.ts))) fail('ts');
  if (typeof parsed.evaluationTs !== 'string' || Number.isNaN(Date.parse(parsed.evaluationTs))) fail('evaluationTs');
  const legs = parsed.legs as Record<string, unknown> | undefined;
  if (!legs || !isLegShape(legs.rows) || !isLegShape(legs.bytes) || !isLegShape(legs.latency)) fail('legs');
  return parsed as unknown as AcknowledgementRecord;
}

/** The first `"ts":"..."` value on a sink line, '' when there is none — the extraction both shell
 *  readers make (`grep -o '"ts":"[^"]*"' | head -n 1 | cut -d'"' -f4`). `ts` is serialized before any
 *  free-form field of either record kind, and an acknowledgement's `"evaluationTs":"` cannot match
 *  (the needle is a quote followed by a lowercase `ts`). */
function tsOf(line: string): string {
  return /"ts":"([^"]*)"/.exec(line)?.[1] ?? '';
}

/** Acknowledge a Trigger-1 fire (ruling R23). Lines are selected exactly as the fired-history readers
 *  (both copies of trigger_fired_summary) select them, by fixed strings over JSON.stringify output
 *  (no spaces after colons, every '"' inside a string escaped, so each needle can occur only as its
 *  field): an evaluation contains `"kind":"evaluation"`, a fire is an evaluation containing
 *  `"overall":"fired"`, the latest acknowledgement is the LAST line containing
 *  `"kind":"acknowledgement"`, and "later" is the readers' strict `>` on fixed-width ISO `ts` strings.
 *
 *  Refuses — returns a reason and appends nothing — when the sink is absent, holds no evaluation, holds
 *  no evaluation that ever read fired (nothing to acknowledge), or holds an acknowledgement with no
 *  evaluation later than it (nothing new since). Otherwise appends one record copying the LATEST
 *  evaluation's `ts` and legs, whatever it reads. The readers compare every later evaluation with the
 *  acknowledged reading, so the baseline must be the current state: with the latest FIRED reading as
 *  the baseline (latency min 6, say), a new slow recall lifting the current min from 2 to 3 would be
 *  missed, and a re-arm caused by a rise below the threshold could never be acknowledged at all. The
 *  earlier rule — the latest evaluation itself must read fired — was a dead end: once a leg fell back
 *  under threshold, the summary kept alarming on the fire in its history while this refused (final
 *  review I-2, probe c10). A malformed latest evaluation throws (validateRecordLine), which the CLI
 *  turns into exit 1. A refused environment throws the resolver's HomeRefusalError (it is not an
 *  `{ ok: false }` reason); trigger-cli.ts turns it into exit 3. */
export function acknowledgeLatest(deps: MeasureDeps = {}): { ok: true; line: string } | { ok: false; reason: string } {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? defaultReadFile;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const { home } = resolveHelixPaths({ HELIX_HOME: env.HELIX_HOME, HELIX_LEDGER: env.HELIX_LEDGER }, homedir());
  let text: string;
  try { text = readFile(join(home, SINK_FILE)).toString('utf8'); }
  catch { return { ok: false, reason: 'no trigger sink to acknowledge' }; }
  const lines = text.split('\n');
  const evaluations = lines.filter((l) => l.includes('"kind":"evaluation"'));
  const last = evaluations.at(-1);
  if (last === undefined) return { ok: false, reason: 'no evaluation to acknowledge' };
  if (!evaluations.some((l) => l.includes('"overall":"fired"'))) {
    return { ok: false, reason: 'no evaluation has ever fired -- nothing to acknowledge' };
  }
  const latestAck = lines.filter((l) => l.includes('"kind":"acknowledgement"')).at(-1);
  if (latestAck !== undefined) {
    const ackTs = tsOf(latestAck);
    if (!evaluations.some((l) => tsOf(l) > ackTs)) {
      return { ok: false, reason: 'no evaluation since the latest acknowledgement -- nothing new to acknowledge' };
    }
  }
  const evaluation = validateRecordLine(last);
  const record: AcknowledgementRecord = {
    v: 1, policy: POLICY, kind: 'acknowledgement', ts: now(), evaluationTs: evaluation.ts, legs: evaluation.legs,
  };
  const line = JSON.stringify(record);
  validateAcknowledgementLine(line);
  appendToSink(home, line, deps.fs ?? realFsOps);
  return { ok: true, line };
}

/** End-to-end: resolve env -> read participants -> resolve metrics -> evaluate -> compose -> validate
 *  -> append+fsync -> print. Returns the exact line that was appended and printed. A refused
 *  environment throws the resolver's HomeRefusalError (it is not an `{ ok: false }` reason);
 *  trigger-cli.ts turns it into exit 3. Throws on ANY
 *  failure in that chain (self-validation, append, or print) — the CLI entry (trigger-cli.ts) is the
 *  ONE place that catches this and turns it into an exit code. A record that fails validation is never
 *  written (validation happens before the single write), and a printed record was appended first (the
 *  write happens before the print). A write cut short by a kill, a full disk or a power loss can still
 *  leave a torn last line; the next append starts its record on a line of its own (appendToSink). */
export function measureAndRecord(input: MeasureInput, deps: MeasureDeps = {}): string {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? defaultReadFile;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const fsOps = deps.fs ?? realFsOps;

  const { home, globalLedger } = resolveHelixPaths({ HELIX_HOME: env.HELIX_HOME, HELIX_LEDGER: env.HELIX_LEDGER }, homedir());
  const disposition = resolveProjectDisposition(input.root, home, globalLedger);
  const participants = readTwoParticipants(globalLedger, input.root, home, disposition, readFile);

  const { state: metricsState, events } = resolveMetrics(home, readFile);
  const { unknownLines, unknownMaxOps } = summarizeUnknowns(events ?? []);

  const verdict = evaluateTrigger({ participants, metricsState, events });

  const record: EvaluationRecord = {
    v: 1, policy: POLICY, kind: 'evaluation',
    ts: now(), run: input.run,
    service_result: input.serviceResult, exit_code: input.exitCode, exit_status: input.exitStatus,
    legs: verdict.legs, latencyN: verdict.latencyN, overall: verdict.overall,
    project: disposition, metricsState, unknownLines, unknownMaxOps,
  };
  const line = JSON.stringify(record);
  validateRecordLine(line); // throws on failure — BEFORE the write, so an invalid record is never written

  appendToSink(home, line, fsOps);
  process.stdout.write(line + '\n'); // SAME line, printed after the append (journald echo)
  return line;
}
