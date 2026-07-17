// Tests for the pure T1 trigger evaluator (Phase 2 Track 2a, Task A1 — see
// docs/superpowers/plans/2026-07-17-phase2-trigger-governance-and-disclosure.md).
import { describe, expect, it } from 'vitest';
import {
  evaluateTrigger,
  type LegStatus,
  type MetricsEvent,
  type MetricsState,
  type ParticipantSize,
  type TriggerVerdict,
} from '../scripts/trigger-eval.js';

const ROWS_THRESHOLD = 2500;
const BYTES_THRESHOLD = 4_194_304;
const SLOW_COUNT_THRESHOLD = 3;

const fast = (ms = 50): MetricsEvent => ({ kind: 'recall', ms });
const slow = (ms = 999): MetricsEvent => ({ kind: 'recall', ms });
const unknownLine = (maxOps = 1): MetricsEvent => ({ kind: 'unknown', maxOps });

// ---------------------------------------------------------------------------------------------
// Full three-valued truth table over leg-status combinations (overall derivation)
// ---------------------------------------------------------------------------------------------
describe('overall derivation — three-valued truth table', () => {
  const STATUSES: LegStatus[] = ['true', 'false', 'unavailable'];

  const expectedOverall = (rows: LegStatus, bytes: LegStatus, latency: LegStatus): TriggerVerdict['overall'] => {
    if (rows === 'true' || bytes === 'true' || latency === 'true') return 'fired';
    if (rows === 'false' && bytes === 'false' && latency === 'false') return 'not-fired';
    return 'indeterminate';
  };

  /**
   * Builds participants realizing the given (rows,bytes) status pair, or null if that pair is
   * structurally unreachable. Read-error-ness is ONE per-participant flag shared by both size legs
   * (there is a single `state`, not one per leg): a read-error participant nulls BOTH legs' upper
   * bound simultaneously. 'false' requires a defined, sub-threshold upper bound; 'unavailable'
   * requires an undefined one. So a {false, unavailable} split across (rows, bytes) is impossible —
   * it would require a read-error to be simultaneously present (for the 'unavailable' leg) and
   * absent (for the 'false' leg). This excludes 6 of the 27 ordered (rows,bytes,latency) triples
   * (the 2 unordered {false,unavailable} pairings × 3 latency statuses each), independent of latency.
   */
  function buildParticipants(rowsStatus: LegStatus, bytesStatus: LegStatus): ParticipantSize[] | null {
    const needsReadError = rowsStatus === 'unavailable' || bytesStatus === 'unavailable';
    const needsNoReadError = rowsStatus === 'false' || bytesStatus === 'false';
    if (needsReadError && needsNoReadError) return null;
    const below = (status: LegStatus, threshold: number): number => (status === 'true' ? threshold : threshold - 1);
    const global: ParticipantSize = {
      id: 'global',
      state: 'read',
      rows: below(rowsStatus, ROWS_THRESHOLD),
      bytes: below(bytesStatus, BYTES_THRESHOLD),
    };
    const project: ParticipantSize = needsReadError
      ? { id: 'project', state: 'read-error' }
      : { id: 'project', state: 'expected-absent' };
    return [global, project];
  }

  function buildLatency(status: LegStatus): { metricsState: MetricsState; events: MetricsEvent[] | null } {
    if (status === 'unavailable') return { metricsState: 'disabled', events: null };
    const n = status === 'true' ? SLOW_COUNT_THRESHOLD : SLOW_COUNT_THRESHOLD - 1;
    const events: MetricsEvent[] = Array.from({ length: n }, () => slow());
    return { metricsState: 'present', events };
  }

  it('covers every achievable ordered (rows,bytes,latency) status triple — 21 of 27; the other 6 are excluded by construction (see buildParticipants)', () => {
    let checked = 0;
    for (const rowsStatus of STATUSES) {
      for (const bytesStatus of STATUSES) {
        const participants = buildParticipants(rowsStatus, bytesStatus);
        if (participants === null) continue;
        for (const latencyStatus of STATUSES) {
          const { metricsState, events } = buildLatency(latencyStatus);
          const result = evaluateTrigger({ participants, metricsState, events });
          const label = `rows=${rowsStatus} bytes=${bytesStatus} latency=${latencyStatus}`;
          expect(result.legs.rows.status, label).toBe(rowsStatus);
          expect(result.legs.bytes.status, label).toBe(bytesStatus);
          expect(result.legs.latency.status, label).toBe(latencyStatus);
          expect(result.overall, label).toBe(expectedOverall(rowsStatus, bytesStatus, latencyStatus));
          checked++;
        }
      }
    }
    expect(checked).toBe(21);
  });
});

// ---------------------------------------------------------------------------------------------
// Threshold triads (N-1, N, N+1)
// ---------------------------------------------------------------------------------------------
describe('rows leg threshold triad (threshold 2500)', () => {
  it('N-1 = 2499 (single readable participant) -> false', () => {
    const participants: ParticipantSize[] = [
      { id: 'global', state: 'read', rows: 2499 },
      { id: 'project', state: 'expected-absent' },
    ];
    const result = evaluateTrigger({ participants, metricsState: 'disabled', events: null });
    expect(result.legs.rows).toEqual({ min: 2499, max: 2499, threshold: 2500, status: 'false' });
  });

  it('N = 2500, summed across both read participants -> true', () => {
    const participants: ParticipantSize[] = [
      { id: 'global', state: 'read', rows: 1300 },
      { id: 'project', state: 'read', rows: 1200 },
    ];
    const result = evaluateTrigger({ participants, metricsState: 'disabled', events: null });
    expect(result.legs.rows).toEqual({ min: 2500, max: 2500, threshold: 2500, status: 'true' });
  });

  it('N+1 = 2501 -> true', () => {
    const participants: ParticipantSize[] = [
      { id: 'global', state: 'read', rows: 2501 },
      { id: 'project', state: 'expected-absent' },
    ];
    const result = evaluateTrigger({ participants, metricsState: 'disabled', events: null });
    expect(result.legs.rows).toEqual({ min: 2501, max: 2501, threshold: 2500, status: 'true' });
  });
});

describe('bytes leg threshold triad (threshold 4194304)', () => {
  it('N-1 = 4194303 -> false', () => {
    const participants: ParticipantSize[] = [
      { id: 'global', state: 'read', bytes: 4_194_303 },
      { id: 'project', state: 'expected-absent' },
    ];
    const result = evaluateTrigger({ participants, metricsState: 'disabled', events: null });
    expect(result.legs.bytes).toEqual({ min: 4_194_303, max: 4_194_303, threshold: 4_194_304, status: 'false' });
  });

  it('N = 4194304, summed across both read participants -> true', () => {
    const participants: ParticipantSize[] = [
      { id: 'global', state: 'read', bytes: 2_194_304 },
      { id: 'project', state: 'read', bytes: 2_000_000 },
    ];
    const result = evaluateTrigger({ participants, metricsState: 'disabled', events: null });
    expect(result.legs.bytes).toEqual({ min: 4_194_304, max: 4_194_304, threshold: 4_194_304, status: 'true' });
  });

  it('N+1 = 4194305 -> true', () => {
    const participants: ParticipantSize[] = [
      { id: 'global', state: 'read', bytes: 4_194_305 },
      { id: 'project', state: 'expected-absent' },
    ];
    const result = evaluateTrigger({ participants, metricsState: 'disabled', events: null });
    expect(result.legs.bytes).toEqual({ min: 4_194_305, max: 4_194_305, threshold: 4_194_304, status: 'true' });
  });
});

describe('latency leg threshold triad (slow-count threshold 3)', () => {
  it('N-1 = 2 slow recalls -> false', () => {
    const events: MetricsEvent[] = [slow(), slow()];
    const result = evaluateTrigger({ participants: [], metricsState: 'present', events });
    expect(result.legs.latency).toEqual({ min: 2, max: 2, threshold: 3, status: 'false' });
    expect(result.latencyN).toBe(2);
  });

  it('N = 3 slow recalls -> true', () => {
    const events: MetricsEvent[] = [slow(), slow(), slow()];
    const result = evaluateTrigger({ participants: [], metricsState: 'present', events });
    expect(result.legs.latency).toEqual({ min: 3, max: 3, threshold: 3, status: 'true' });
    expect(result.latencyN).toBe(3);
  });

  it('N+1 = 4 slow recalls -> true', () => {
    const events: MetricsEvent[] = [slow(), slow(), slow(), slow()];
    const result = evaluateTrigger({ participants: [], metricsState: 'present', events });
    expect(result.legs.latency).toEqual({ min: 4, max: 4, threshold: 3, status: 'true' });
    expect(result.latencyN).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------
// Strict-greater boundary
// ---------------------------------------------------------------------------------------------
describe('strict-greater boundary (slow means ms > 150, not >=)', () => {
  it('[150,150,150] -> 0 slow (exactly-150 counts as fast)', () => {
    const events: MetricsEvent[] = [fast(150), fast(150), fast(150)];
    const result = evaluateTrigger({ participants: [], metricsState: 'present', events });
    expect(result.legs.latency).toEqual({ min: 0, max: 0, threshold: 3, status: 'false' });
    expect(result.latencyN).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// Metrics state matrix
// ---------------------------------------------------------------------------------------------
describe('metrics state matrix', () => {
  it('present + 0 events -> upper 0 -> latency false (full verdict shape, incl. schema)', () => {
    const result = evaluateTrigger({ participants: [], metricsState: 'present', events: [] });
    expect(result).toEqual({
      schema: 1,
      legs: {
        rows: { min: 0, max: 0, threshold: 2500, status: 'false' },
        bytes: { min: 0, max: 0, threshold: 4_194_304, status: 'false' },
        latency: { min: 0, max: 0, threshold: 3, status: 'false' },
      },
      latencyN: 0,
      overall: 'not-fired',
    });
  });

  it('absent -> latency unavailable, latencyN null', () => {
    const result = evaluateTrigger({ participants: [], metricsState: 'absent', events: null });
    expect(result.legs.latency).toEqual({ min: null, max: null, threshold: 3, status: 'unavailable' });
    expect(result.latencyN).toBeNull();
  });

  it('disabled -> latency unavailable, latencyN null', () => {
    const result = evaluateTrigger({ participants: [], metricsState: 'disabled', events: null });
    expect(result.legs.latency).toEqual({ min: null, max: null, threshold: 3, status: 'unavailable' });
    expect(result.latencyN).toBeNull();
  });

  it('read-error -> latency unavailable, latencyN null', () => {
    const result = evaluateTrigger({ participants: [], metricsState: 'read-error', events: null });
    expect(result.legs.latency).toEqual({ min: null, max: null, threshold: 3, status: 'unavailable' });
    expect(result.latencyN).toBeNull();
  });

  it('events is meaningful only when metricsState is present — a non-null array does not leak through otherwise', () => {
    const events: MetricsEvent[] = [slow(), slow(), slow(), slow()]; // would be 'true' if honored
    const result = evaluateTrigger({ participants: [], metricsState: 'disabled', events });
    expect(result.legs.latency).toEqual({ min: null, max: null, threshold: 3, status: 'unavailable' });
    expect(result.latencyN).toBeNull();
  });

  it('present + null events -> unavailable (no data despite the sensor being present)', () => {
    const result = evaluateTrigger({ participants: [], metricsState: 'present', events: null });
    expect(result.legs.latency).toEqual({ min: null, max: null, threshold: 3, status: 'unavailable' });
    expect(result.latencyN).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Position-sensitive unknowns
// ---------------------------------------------------------------------------------------------
describe('position-sensitive unknowns', () => {
  it('round-3 example: 1 fast, 3 unknowns(maxOps=1), then 199 fast -> upper bound 1 -> false', () => {
    const events: MetricsEvent[] = [
      fast(),
      unknownLine(1),
      unknownLine(1),
      unknownLine(1),
      ...Array.from({ length: 199 }, () => fast()),
    ];
    const result = evaluateTrigger({ participants: [], metricsState: 'present', events });
    // 203 literal events. The trailing-200 window (over the maxOps-expanded 203 atomic units, all
    // width 1 here since every maxOps=1) drops the oldest 3 units: the fast recall and the first two
    // unknowns. The third unknown survives inside the window; worst case (upper bound) it is slow ->
    // max=1. Best case (lower bound) it is fast like everything else in the window -> min=0.
    expect(result.legs.latency).toEqual({ min: 0, max: 1, threshold: 3, status: 'false' });
    // latencyN uses the SAME trailing-200 rule but applied to the literal (unexpanded) event list, and
    // counts only kind:'recall' entries within it — the surviving unknown at that boundary does not
    // count as a recorded recall. Window = events[3..202] = 1 unknown + 199 recalls -> latencyN = 199.
    expect(result.latencyN).toBe(199);
  });

  it('saturated-window displacement: 50 oldest slow recalls fall outside the trailing-200 window', () => {
    const events: MetricsEvent[] = [...Array.from({ length: 50 }, () => slow()), ...Array.from({ length: 200 }, () => fast())];
    const result = evaluateTrigger({ participants: [], metricsState: 'present', events });
    expect(result.legs.latency).toEqual({ min: 0, max: 0, threshold: 3, status: 'false' });
    expect(result.latencyN).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Concatenated-line multiplicity (also serves as the directed maxOps=2 case with hand-computed bounds)
// ---------------------------------------------------------------------------------------------
describe('concatenated-line multiplicity', () => {
  it('one unknown with maxOps=2 counts twice in the upper bound (hand-computed: min=0, max=2)', () => {
    const events: MetricsEvent[] = [unknownLine(2)];
    const result = evaluateTrigger({ participants: [], metricsState: 'present', events });
    expect(result.legs.latency).toEqual({ min: 0, max: 2, threshold: 3, status: 'false' });
    expect(result.latencyN).toBe(0); // the single line is 'unknown', never a RECORDED recall
  });
});

// ---------------------------------------------------------------------------------------------
// Brute-force multiplicity property test (deterministic, no randomness)
// ---------------------------------------------------------------------------------------------
// Exchange argument (recorded here per the brief): for a fixed trailing-200 window, replacing a
// 'not-a-recall' resolution of an unknown unit with an actual recall (fast or slow) can only move the
// windowed slow-count in the direction favorable to the extremal bound being computed. An added recall
// either (a) lands outside the newest-200 window, changing nothing, or (b) enters the window and
// displaces exactly the oldest member that was in it. So "expand every unknown to its full maxOps, all
// slow" is never less than the true slow-count (a valid, and — because it is realized by an actual
// resolution — TIGHT upper bound), and "...all fast" is never more than the true slow-count (a valid,
// tight lower bound). No resolution, including a mixed one that treats some unknown units as
// not-a-recall at all, can ever fall outside [analytic lower, analytic upper].
//
// This is checked below by exhaustive enumeration rather than taken on faith: every unknown (maxOps=1,
// so exactly one hidden unit each) is independently resolved to one of {not-a-recall, fast, slow}, the
// TRUE windowed slow-count is computed directly from each resolved sequence (an oracle independent of
// evaluateTrigger's own expansion logic), and compared against evaluateTrigger's bounds for the
// (unresolved) scenario — both for containment and for tightness (both bounds must actually be
// achieved by some resolution, not just never-exceeded).
describe('brute-force multiplicity property test (<=8 events, window fixed at 200 so it never saturates — saturation is covered separately above)', () => {
  const FAST_MS = 50;
  const SLOW_MS = 500;
  type Resolution = 'not-a-recall' | 'fast' | 'slow';
  const RESOLUTIONS: Resolution[] = ['not-a-recall', 'fast', 'slow'];

  function allAssignments(numUnknowns: number): Resolution[][] {
    if (numUnknowns === 0) return [[]];
    const rest = allAssignments(numUnknowns - 1);
    return RESOLUTIONS.flatMap((head) => rest.map((tail) => [head, ...tail]));
  }

  function oracleSlowCount(events: MetricsEvent[], assignment: Resolution[]): number {
    let u = 0;
    const resolved: number[] = [];
    for (const event of events) {
      if (event.kind === 'recall') {
        resolved.push(event.ms);
        continue;
      }
      const resolution = assignment[u++];
      if (resolution === 'fast') resolved.push(FAST_MS);
      else if (resolution === 'slow') resolved.push(SLOW_MS);
      // 'not-a-recall' contributes nothing: dropped from the resolved recall sequence entirely.
    }
    const windowed = resolved.slice(Math.max(0, resolved.length - 200));
    return windowed.filter((ms) => ms > 150).length;
  }

  const SCENARIOS: MetricsEvent[][] = [
    [],
    [unknownLine(1)],
    [fast(FAST_MS), unknownLine(1)],
    [unknownLine(1), slow(SLOW_MS)],
    [fast(FAST_MS), unknownLine(1), slow(SLOW_MS), unknownLine(1)],
    [unknownLine(1), unknownLine(1), unknownLine(1)],
    [fast(FAST_MS), fast(FAST_MS), unknownLine(1), slow(SLOW_MS), unknownLine(1), fast(FAST_MS), slow(SLOW_MS), unknownLine(1)],
    [unknownLine(1), unknownLine(1), fast(FAST_MS), fast(FAST_MS), fast(FAST_MS), fast(FAST_MS), fast(FAST_MS), fast(FAST_MS)],
  ];

  it('every enumerated true slow-count falls within [analytic lower, analytic upper], and both bounds are achieved (tightness)', () => {
    for (const events of SCENARIOS) {
      const numUnknowns = events.filter((event) => event.kind === 'unknown').length;
      const result = evaluateTrigger({ participants: [], metricsState: 'present', events });
      const { min: lower, max: upper } = result.legs.latency;
      if (lower === null || upper === null) throw new Error('latency bounds unexpectedly null under metricsState=present');

      const observed = new Set<number>();
      for (const assignment of allAssignments(numUnknowns)) {
        const trueCount = oracleSlowCount(events, assignment);
        observed.add(trueCount);
        const label = `events=${JSON.stringify(events)} assignment=${JSON.stringify(assignment)}`;
        expect(trueCount, label).toBeGreaterThanOrEqual(lower);
        expect(trueCount, label).toBeLessThanOrEqual(upper);
      }
      const scenarioLabel = JSON.stringify(events);
      expect(Math.min(...observed), `tight lower for ${scenarioLabel}`).toBe(lower);
      expect(Math.max(...observed), `tight upper for ${scenarioLabel}`).toBe(upper);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Spec callouts
// ---------------------------------------------------------------------------------------------
describe('spec callouts', () => {
  it('a readable participant alone can fire a leg while the other participant is read-error', () => {
    const participants: ParticipantSize[] = [
      { id: 'global', state: 'read', rows: 5000, bytes: 5_000_000 },
      { id: 'project', state: 'read-error' },
    ];
    const result = evaluateTrigger({ participants, metricsState: 'disabled', events: null });
    expect(result.legs.rows.status).toBe('true');
    expect(result.legs.bytes.status).toBe('true');
    expect(result.legs.rows.max).toBeNull();
    expect(result.legs.bytes.max).toBeNull();
    expect(result.overall).toBe('fired');
  });

  it('expected-absent contributes 0 as a clean read (max stays defined, not null)', () => {
    const participants: ParticipantSize[] = [
      { id: 'global', state: 'read', rows: 2500, bytes: 4_194_304 },
      { id: 'project', state: 'expected-absent' },
    ];
    const result = evaluateTrigger({ participants, metricsState: 'disabled', events: null });
    expect(result.legs.rows).toEqual({ min: 2500, max: 2500, threshold: 2500, status: 'true' });
    expect(result.legs.bytes).toEqual({ min: 4_194_304, max: 4_194_304, threshold: 4_194_304, status: 'true' });
  });
});
