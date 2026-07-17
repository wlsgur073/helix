// Shared grammar for BOTH T1 trigger sink record kinds (Phase 2 Track 2a -- see
// docs/superpowers/plans/2026-07-17-phase2-trigger-governance-and-disclosure.md). The sink
// (<home>/trigger.jsonl) has exactly two writers, single-writer-per-kind: the measurement CLI
// (scripts/trigger-measure.ts / scripts/trigger-cli.ts, Task A2, compiled to bin/helix-trigger.mjs in
// Task A3) appends `kind:"evaluation"` records; the systemd ExecStopPost adapter
// (scripts/dogfood-postrun.sh, Task A4) appends `kind:"reporter-failure"` records whenever the
// artifact does not exit 0. ONE parser locks BOTH shapes so the two record kinds can never silently
// drift apart -- imported by both test/trigger-line.test.ts (evaluation records) and
// test/dogfood-postrun.spawn.test.ts (reporter-failure records).
import { validateRecordLine, type EvaluationRecord } from '../../scripts/trigger-measure.js';

const POLICY = 'T1-2026-07-11';
const REASONS = ['timeout', 'crash', 'launch-failure'] as const;
export type ReporterFailureReason = (typeof REASONS)[number];

export interface ReporterFailureRecord {
  v: 1;
  policy: typeof POLICY;
  kind: 'reporter-failure';
  ts: string;
  run: string;
  service_result: string | null;
  exit_code: string | null;
  exit_status: string | null;
  reason: ReporterFailureReason;
}

export type TriggerRecord = EvaluationRecord | ReporterFailureRecord;

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

/** Strict shape check for a `kind:"reporter-failure"` line -- exactly the fields the adapter's FIXED
 *  template composes (see scripts/dogfood-postrun.sh), no more and no less. Mirrors
 *  validateRecordLine's fail()-throws-descriptive-message convention, but is a SEPARATE definition
 *  (not a delegation) because the adapter is bash, not TypeScript -- it has no importable validator of
 *  its own to share. */
function validateReporterFailureLine(line: string): ReporterFailureRecord {
  const fail = (field: string): never => { throw new Error(`reporter-failure record validation failed: ${field}`); };
  // eslint-disable-next-line no-control-regex -- deliberately matching the full ASCII byte range
  if (!/^[\x00-\x7F]*$/.test(line)) fail('non-ASCII byte in output');
  const parsed = JSON.parse(line) as Record<string, unknown>;
  if (parsed.v !== 1) fail('v');
  if (parsed.policy !== POLICY) fail('policy');
  if (parsed.kind !== 'reporter-failure') fail('kind');
  if (typeof parsed.ts !== 'string' || Number.isNaN(Date.parse(parsed.ts))) fail('ts');
  if (typeof parsed.run !== 'string' || parsed.run === '') fail('run');
  for (const field of ['service_result', 'exit_code', 'exit_status']) {
    if (!isNullableString(parsed[field])) fail(field);
  }
  if (typeof parsed.reason !== 'string' || !(REASONS as readonly string[]).includes(parsed.reason)) fail('reason');
  const allowedKeys = new Set(['v', 'policy', 'kind', 'ts', 'run', 'service_result', 'exit_code', 'exit_status', 'reason']);
  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) fail(`unexpected field ${key}`);
  }
  return parsed as unknown as ReporterFailureRecord;
}

/** Parses ONE sink line under whichever grammar its `kind` selects. `kind:"evaluation"` delegates to
 *  the artifact's own self-validation (validateRecordLine, scripts/trigger-measure.ts) so there is
 *  never a second, drifting definition of that shape; `kind:"reporter-failure"` is validated locally.
 *  Throws on anything that is not valid JSON, has an unrecognized/missing `kind`, or fails its kind's
 *  shape check -- callers that expect success should let this throw surface as a test failure, not
 *  swallow it. */
export function parseTriggerRecord(line: string): TriggerRecord {
  let kind: unknown;
  try {
    kind = (JSON.parse(line) as Record<string, unknown>).kind;
  } catch {
    throw new Error('trigger record grammar: line is not valid JSON');
  }
  if (kind === 'evaluation') return validateRecordLine(line);
  if (kind === 'reporter-failure') return validateReporterFailureLine(line);
  throw new Error(`trigger record grammar: unrecognized kind ${JSON.stringify(kind)}`);
}
