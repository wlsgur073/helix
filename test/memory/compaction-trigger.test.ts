import { describe, it, expect } from 'vitest';
import { cheapGate, dirtyGate } from '../../src/memory/compaction-trigger.js';
import type { CompactionConfig } from '../../src/config.js';

const cfg: CompactionConfig = { auto: true, dirtyRatio: 0.5, minRows: 200, minDirtyBytes: 1_048_576, graceMs: 86_400_000, maxBytes: 52_428_800 };
const now = 1_000_000_000_000; // fixed nowMs

describe('cheapGate', () => {
  it('blocks when auto is off', () => {
    expect(cheapGate({ rows: 1000, totalBytes: 1000, mtimeMs: 0, nowMs: now, cfg: { ...cfg, auto: false } })).toEqual({ proceed: false, reason: 'notAuto' });
  });
  it('blocks a trivially small ledger', () => {
    expect(cheapGate({ rows: 199, totalBytes: 1000, mtimeMs: 0, nowMs: now, cfg })).toEqual({ proceed: false, reason: 'tooSmall' });
  });
  it('blocks a ledger above maxBytes', () => {
    expect(cheapGate({ rows: 1000, totalBytes: cfg.maxBytes + 1, mtimeMs: 0, nowMs: now, cfg })).toEqual({ proceed: false, reason: 'tooBig' });
  });
  it('blocks a ledger written within the grace window (not quiescent)', () => {
    const mtime = now - (cfg.graceMs - 1); // 1ms short of grace
    expect(cheapGate({ rows: 1000, totalBytes: 1000, mtimeMs: mtime, nowMs: now, cfg })).toEqual({ proceed: false, reason: 'notQuiescent' });
  });
  it('proceeds when all cheap gates pass (quiescent, right-sized, opted in)', () => {
    const mtime = now - cfg.graceMs; // exactly at grace boundary => quiescent
    expect(cheapGate({ rows: 1000, totalBytes: 1000, mtimeMs: mtime, nowMs: now, cfg })).toEqual({ proceed: true });
  });

  // Boundary locks: minRows/maxBytes are INCLUSIVE bounds. Without these, `<`->`<=` and `>`->`>=`
  // regressions survive (the block/proceed cases above sit far from the boundary).
  it('proceeds at exactly minRows (the bound is inclusive)', () => {
    const mtime = now - cfg.graceMs;
    expect(cheapGate({ rows: cfg.minRows, totalBytes: 1000, mtimeMs: mtime, nowMs: now, cfg })).toEqual({ proceed: true });
  });
  it('proceeds at exactly maxBytes (the bound is inclusive)', () => {
    const mtime = now - cfg.graceMs;
    expect(cheapGate({ rows: 1000, totalBytes: cfg.maxBytes, mtimeMs: mtime, nowMs: now, cfg })).toEqual({ proceed: true });
  });

  // Reason PRECEDENCE locks. `proceed` is an order-invariant conjunction, but `reason` is a shipped
  // observable (it labels the compaction metric), so the guard order is contract. Each case below
  // triggers MULTIPLE reasons at once; only the dominant one may be reported. Together they pin a
  // total order: notAuto < tooSmall < tooBig < notQuiescent.
  it('reports notAuto even when every other reason also triggers (disabled dominates)', () => {
    expect(cheapGate({ rows: 1, totalBytes: cfg.maxBytes + 1, mtimeMs: now, nowMs: now, cfg: { ...cfg, auto: false } }))
      .toEqual({ proceed: false, reason: 'notAuto' });
  });
  it('reports tooSmall over tooBig (minRows precedes maxBytes)', () => {
    expect(cheapGate({ rows: 1, totalBytes: cfg.maxBytes + 1, mtimeMs: 0, nowMs: now, cfg }))
      .toEqual({ proceed: false, reason: 'tooSmall' });
  });
  it('reports tooBig over notQuiescent (maxBytes precedes quiescence)', () => {
    expect(cheapGate({ rows: 1000, totalBytes: cfg.maxBytes + 1, mtimeMs: now, nowMs: now, cfg }))
      .toEqual({ proceed: false, reason: 'tooBig' });
  });
});

describe('dirtyGate', () => {
  it('fires on the ratio branch (>= dirtyRatio)', () => {
    expect(dirtyGate({ rows: 1000, reclaimable: 500, reclaimableBytes: 0, cfg })).toBe(true);
  });
  it('fires on the absolute byte branch even at low ratio', () => {
    // 45% ratio (below 0.5) but large reclaimable bytes -> byte branch fires
    expect(dirtyGate({ rows: 1000, reclaimable: 450, reclaimableBytes: cfg.minDirtyBytes, cfg })).toBe(true);
  });
  it('does NOT fire on a huge low-ratio ledger with tiny reclaim', () => {
    expect(dirtyGate({ rows: 10_000_000, reclaimable: 500, reclaimableBytes: 500, cfg })).toBe(false);
  });
  // Empty-ledger guard. An all-zero row is NOT enough to lock it: 0/0 is NaN and `NaN >= x` is
  // already false, so the guard is invisible there. Only degenerate counts expose it — a nonzero
  // reclaimable divides to Infinity (fires the ratio branch), and nonzero bytes fire the absolute
  // branch. Neither may compact a ledger that has no rows.
  it('never fires on an empty ledger, even with degenerate counts', () => {
    expect(dirtyGate({ rows: 0, reclaimable: 0, reclaimableBytes: 0, cfg })).toBe(false);
    expect(dirtyGate({ rows: 0, reclaimable: 1, reclaimableBytes: 0, cfg })).toBe(false); // 1/0 = Infinity
    expect(dirtyGate({ rows: 0, reclaimable: 0, reclaimableBytes: cfg.minDirtyBytes, cfg })).toBe(false);
  });
});
