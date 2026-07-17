// Pure T1 trigger evaluator (Phase 2 Track 2a, Task A1 — see
// docs/superpowers/plans/2026-07-17-phase2-trigger-governance-and-disclosure.md).
// No I/O: turns a participant-size snapshot plus a metrics event list into a three-valued verdict
// per leg. The measurement CLI (Task A2, not built here) owns reading the ledgers and the metrics
// sink; this module only judges what it is handed.
//
// ONE modal rule for every leg (see deriveLegStatus): 'true' iff the leg's lower bound reaches its
// threshold; 'false' iff its upper bound cannot reach it; else 'unavailable'. Rows/bytes bounds come
// from participant readability; the latency bound comes from expanding unknown (unparseable) metrics
// lines to their maximum possible op count, uniformly in the direction that is worst-case for the
// bound currently being computed.

export type LegStatus = 'true' | 'false' | 'unavailable';
export type MetricsState = 'present' | 'absent' | 'disabled' | 'read-error';

export interface ParticipantSize {
  id: 'global' | 'project';
  state: 'read' | 'expected-absent' | 'read-error';
  rows?: number;
  bytes?: number;
}

/** One physical metrics-file entry: a successfully parsed recall latency, or an unparseable
 *  ('unknown') line. `maxOps` is the caller's byte-bounded upper estimate of how many op records a
 *  torn-then-successful-append could have concatenated onto that one physical line
 *  (`max(1, floor(lineBytes / 64))`); this module trusts it as given. */
export type MetricsEvent = { kind: 'recall'; ms: number } | { kind: 'unknown'; maxOps: number };

export interface Leg {
  min: number | null;
  max: number | null;
  threshold: number;
  status: LegStatus;
}

export interface TriggerVerdict {
  schema: 1;
  legs: { rows: Leg; bytes: Leg; latency: Leg };
  /** Recorded (kind:'recall') events inside the evaluated trailing window — population size, not a
   *  bound; null whenever the latency leg has no data to evaluate. */
  latencyN: number | null;
  overall: 'fired' | 'not-fired' | 'indeterminate';
}

const ROWS_THRESHOLD = 2500;
const BYTES_THRESHOLD = 4_194_304; // 4 MiB
const SLOW_COUNT_THRESHOLD = 3;
const SLOW_MS_THRESHOLD = 150; // strictly greater than this counts as slow
const WINDOW_SIZE = 200; // trailing recall window; the evaluator owns this rule (callers may pre-trim to a superset)

/** The one modal rule, shared by every leg. `min`/`max` bracket the true (unknown) value; the rule
 *  never needs a tie-break because min<=max always holds by construction in every leg below. */
function deriveLegStatus(min: number | null, max: number | null, threshold: number): LegStatus {
  if (min !== null && min >= threshold) return 'true';
  if (max !== null && max < threshold) return 'false';
  return 'unavailable';
}

/** rows/bytes leg: lower = upper = sum over 'read' participants (an 'expected-absent' participant
 *  contributes 0 as a clean read). The upper bound — and therefore 'false' — is defined only when no
 *  participant is 'read-error'; a single readable participant can still fire 'true' on its own. */
function computeSizeLeg(participants: ParticipantSize[], field: 'rows' | 'bytes', threshold: number): Leg {
  let min = 0;
  let hasReadError = false;
  for (const participant of participants) {
    if (participant.state === 'read') {
      min += participant[field] ?? 0;
    } else if (participant.state === 'read-error') {
      hasReadError = true;
    }
    // 'expected-absent' contributes 0 — no action needed.
  }
  const max = hasReadError ? null : min;
  return { min, max, threshold, status: deriveLegStatus(min, max, threshold) };
}

/** Trailing-window tail, kept to at most WINDOW_SIZE elements. Applied independently to two
 *  different sequences below: the literal (unexpanded) events for latencyN, and the maxOps-expanded
 *  atomic units for the latency bounds. Same rule, different population — see the two call sites. */
function windowTail<T>(items: T[]): T[] {
  return items.slice(Math.max(0, items.length - WINDOW_SIZE));
}

/** Expands each event into one boolean per atomic recall unit (true = slow, i.e. ms > 150). A
 *  'recall' event is always exactly one unit with a known outcome. An 'unknown' event — an
 *  unparseable line that may itself concatenate multiple torn-then-successful op records — expands
 *  to its full `maxOps`, uniformly assumed fast or slow depending on which bound is being computed.
 *
 *  Per the brief's exchange argument (re-verified by exhaustive enumeration in the test file):
 *  expanding to the FULL maxOps in one uniform direction is extremal for that direction's bound. A
 *  recall entering the trailing window either has no effect (the window is not yet full) or displaces
 *  exactly the oldest member that was in it — so adding more same-direction recalls never makes that
 *  bound less extreme. Both the fast-only and slow-only expansions are therefore not just valid but
 *  TIGHT (achieved by an actual resolution, not merely a safe over/under-approximation). */
function expandToUnits(events: MetricsEvent[], unknownIsSlow: boolean): boolean[] {
  const units: boolean[] = [];
  for (const event of events) {
    if (event.kind === 'recall') {
      units.push(event.ms > SLOW_MS_THRESHOLD);
    } else {
      for (let i = 0; i < event.maxOps; i++) units.push(unknownIsSlow);
    }
  }
  return units;
}

function computeLatencyBound(events: MetricsEvent[], unknownIsSlow: boolean): number {
  return windowTail(expandToUnits(events, unknownIsSlow)).filter(Boolean).length;
}

/** Population size for latencyN: RECORDED (kind:'recall') events within the trailing window,
 *  computed over the LITERAL event list — no maxOps displacement ("the no-displacement window").
 *  windowTail(events) has at most WINDOW_SIZE elements, so this is already <= WINDOW_SIZE. Distinct
 *  from (and never larger than) the window used for the bounds above, which is computed over the
 *  maxOps-expanded sequence and may therefore start at a different literal-line boundary. */
function latencyPopulation(events: MetricsEvent[]): number {
  return windowTail(events).filter((event) => event.kind === 'recall').length;
}

/** latency leg: 'unavailable' whenever the sensor is off or produced no data (present but null) —
 *  "sensor off => latency legs blind". Otherwise the lower bound expands every unknown to maxOps FAST
 *  recalls (maximal displacement of genuinely slow members out of the window) and the upper bound
 *  expands every unknown to maxOps SLOW recalls (maximal admission of assumed-slow members). */
function computeLatencyLeg(metricsState: MetricsState, events: MetricsEvent[] | null, threshold: number): Leg {
  if (metricsState !== 'present' || events === null) {
    return { min: null, max: null, threshold, status: 'unavailable' };
  }
  const min = computeLatencyBound(events, false);
  const max = computeLatencyBound(events, true);
  return { min, max, threshold, status: deriveLegStatus(min, max, threshold) };
}

function deriveOverall(legs: { rows: Leg; bytes: Leg; latency: Leg }): TriggerVerdict['overall'] {
  const statuses = [legs.rows.status, legs.bytes.status, legs.latency.status];
  if (statuses.includes('true')) return 'fired';
  if (statuses.every((status) => status === 'false')) return 'not-fired';
  return 'indeterminate';
}

export function evaluateTrigger(input: {
  participants: ParticipantSize[];
  metricsState: MetricsState;
  events: MetricsEvent[] | null; // oldest-first FILE order; meaningful only when metricsState === 'present'
}): TriggerVerdict {
  const rows = computeSizeLeg(input.participants, 'rows', ROWS_THRESHOLD);
  const bytes = computeSizeLeg(input.participants, 'bytes', BYTES_THRESHOLD);
  const latency = computeLatencyLeg(input.metricsState, input.events, SLOW_COUNT_THRESHOLD);
  const legs = { rows, bytes, latency };
  const latencyN =
    input.metricsState === 'present' && input.events !== null ? latencyPopulation(input.events) : null;
  return { schema: 1, legs, latencyN, overall: deriveOverall(legs) };
}
