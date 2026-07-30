/** The reported bound of the v2 gate (§3d) — a pure library, no CLI, nothing to guard.
 *
 *  Every Hit@1 verdict is reported together with the nominal one-sided 95 percent exact-binomial
 *  (Clopper-Pearson) lower bound, under a common independent-success model. The model
 *  qualification travels with the number: it is a bound on Hit@1 over the eligible rows, not on
 *  the gate as a whole, and it describes sampling error rather than how hard the test was.
 *
 *      L(x, n) = 0                                if x = 0
 *      L(x, n) = BetaInverse(alpha; x, n-x+1)     if x > 0
 *      L(0, 0)   undefined — report N/A
 *
 *  `alpha^(1/n)` is the all-success special case ONLY; §3d is explicit that using it for a failed
 *  result is wrong. It is not used here even for that case — it is used in the tests, as an
 *  independent reference the general routine has to reproduce without being told.
 *
 *  There is no external dependency for this. The inverse is found by bisection on the regularized
 *  incomplete beta, which is monotone in p, so the bracket is exact and convergence needs no
 *  starting guess: 200 halvings take the interval below any representable double's resolution. */

export const ALPHA = 0.05;

/** log Γ(z) — Lanczos approximation, g = 7, n = 9. Accurate to ~15 significant digits for z > 0,
 *  which is the only domain reached here (a and b are counts plus one). */
const logGamma = (z: number): number => {
  const C = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  const x = z - 1;
  let series = C[0]!;
  for (let i = 1; i < 9; i++) series += C[i]! / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(series);
};

/** Continued fraction for the incomplete beta, by the modified Lentz method. Converges rapidly for
 *  `x < (a+1)/(a+b+2)`; the caller uses the symmetry `I_x(a,b) = 1 - I_{1-x}(b,a)` outside that. */
const betaContinuedFraction = (a: number, b: number, x: number): number => {
  const TINY = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return h;
};

/** `I_x(a, b)` — the regularized incomplete beta, i.e. the Beta(a, b) CDF at x. Exported because
 *  it is what makes the bound checkable without a reference table: whatever `lowerBound` returns,
 *  putting it back through here must give alpha. */
export const regularizedIncompleteBeta = (a: number, b: number, x: number): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
};

/** The one-sided lower bound for `x` successes in `n` trials. `null` means N/A, not zero: with no
 *  trials there is nothing to bound, and reporting 0 would present an absent measurement as a
 *  measured floor. */
export const lowerBound = (x: number, n: number, alpha: number = ALPHA): number | null => {
  if (!Number.isInteger(x) || !Number.isInteger(n) || x < 0 || n < 0 || x > n) {
    throw new Error(`invalid-counts: ${x} of ${n} is not a whole number of successes out of trials`);
  }
  if (n === 0) return null;
  if (x === 0) return 0;
  // I_p(x, n-x+1) rises monotonically from 0 to 1 in p, so [0, 1] is an exact bracket and
  // bisection cannot miss the root. 200 halvings shrink it below double precision.
  const a = x, b = n - x + 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (regularizedIncompleteBeta(a, b, mid) < alpha) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
};
