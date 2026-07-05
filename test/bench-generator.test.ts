import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateLedger, computeStats, percentileNearestRank } from '../scripts/bench-replay.js';
import { verifiedLiveStats } from '../src/memory/verified-read.js';

describe('bench generator (spec §8)', () => {
  it('generates a signed fixture the real verifier accepts (self-check, spec §9 + C2-7)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-bench-'));
    const ledger = join(home, 'memory.jsonl');
    const out = generateLedger(home, ledger, { rows: 200, seed: 7 });
    expect(out.rows).toBe(200);
    expect(out.verifies).toBeGreaterThan(0);
    const { projection, stats } = verifiedLiveStats(ledger, home);
    expect(stats.rows).toBe(200);
    expect(stats.keyAvailable).toBe(true);
    const elevated = [...projection.live.values()].filter((r) => r.state !== 'Fresh');
    expect(elevated.length).toBeGreaterThan(0); // signed verifies actually took effect
  });

  it('is deterministic under a seed', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-bench-'));
    const a = generateLedger(home, join(home, 'a.jsonl'), { rows: 100, seed: 42 });
    const b = generateLedger(home, join(home, 'b.jsonl'), { rows: 100, seed: 42 });
    expect(a).toEqual(b);
  });

  it('computeStats + nearest-rank percentile are exact on a known array', () => {
    const s = computeStats([5, 1, 3, 2, 4]);
    expect(s).toMatchObject({ n: 5, median: 3, min: 1, max: 5, mean: 3 });
    expect(percentileNearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentileNearestRank(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
  });
});
