import { describe, expect, it } from 'vitest';
import { lowerBound, regularizedIncompleteBeta, ALPHA } from '../../scripts/pilot/binomial.js';

/** The reported bound of §3d: the nominal one-sided 95% exact-binomial (Clopper-Pearson) lower
 *  bound for Hit@1 under a common independent-success model.
 *
 *  Three independent kinds of oracle are used, because a numerical routine that is merely
 *  self-consistent can be self-consistently wrong:
 *
 *   1. the four values the design worked by hand;
 *   2. the CLOSED FORM `alpha^(1/n)`, which is exact when every trial succeeds — 40 exact values
 *      the general implementation must reproduce without knowing it is in that case;
 *   3. a round trip through the incomplete beta itself: whatever `L` comes back, `I_L(x, n-x+1)`
 *      must equal alpha. That one needs no reference value at all. */

describe('exact-binomial lower bound', () => {
  it('reproduces the four values the design worked by hand', () => {
    expect(lowerBound(2, 2)).toBeCloseTo(0.2236, 4);
    expect(lowerBound(1, 2)).toBeCloseTo(0.0253, 4);
    expect(lowerBound(0, 2)).toBe(0);
    expect(lowerBound(28, 28)).toBeCloseTo(0.8985, 4);
  });

  it('matches the all-success closed form exactly, for every n it could plausibly meet', () => {
    // `0.05^(1/n)` is the all-success SPECIAL CASE, and §3d warns against using it for a failed
    // result. Here it is the reference, not the method: the general routine is asked for L(n, n)
    // with no knowledge that it is in that case.
    for (let n = 1; n <= 40; n++) {
      expect(lowerBound(n, n)!).toBeCloseTo(Math.pow(ALPHA, 1 / n), 12);
    }
  });

  it('round-trips: the bound is exactly the point where the beta CDF equals alpha', () => {
    for (const [x, n] of [[1, 2], [1, 5], [3, 7], [9, 10], [17, 22], [21, 28]] as const) {
      const p = lowerBound(x, n);
      expect(regularizedIncompleteBeta(x, n - x + 1, p!)).toBeCloseTo(ALPHA, 10);
    }
  });

  it('is 0 at zero successes and undefined at zero trials', () => {
    // §3d: L(0, 0) is undefined and must be reported as N/A rather than as a number. A zero-trial
    // window is the starved case the Hit@1 minimum exists to block, so this value is reachable.
    expect(lowerBound(0, 5)).toBe(0);
    expect(lowerBound(0, 0)).toBeNull();
  });

  it('rises with successes and falls with failures', () => {
    for (let x = 1; x < 10; x++) expect(lowerBound(x + 1, 10)).toBeGreaterThan(lowerBound(x, 10)!);
    expect(lowerBound(5, 10)!).toBeGreaterThan(lowerBound(5, 20)!);
  });

  it('is never above the point estimate, and never below zero', () => {
    // A lower confidence bound that exceeded x/n would be reporting more than was observed.
    for (const [x, n] of [[1, 2], [2, 2], [5, 9], [27, 28], [28, 28]] as const) {
      const p = lowerBound(x, n)!;
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(x / n);
    }
  });

  it('refuses counts that are not a whole number of successes out of trials', () => {
    expect(() => lowerBound(3, 2)).toThrow(/invalid-counts/);
    expect(() => lowerBound(-1, 2)).toThrow(/invalid-counts/);
    expect(() => lowerBound(1.5, 2)).toThrow(/invalid-counts/);
    expect(() => lowerBound(1, 2.5)).toThrow(/invalid-counts/);
  });
});
