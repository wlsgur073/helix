// Third fix batch B1, task A15 (design 4.8 item 1, section 14 item 16): the look at witness.json holds at every moment a link
// can arrive. A link takes the name right after each lstat of that name in one advanceWitness, one k per run. Verdicts are
// computed from consequences: the bytes at the link's destination, and what stands there at all.
import { describe, it, expect, vi } from 'vitest';
const race = vi.hoisted(() => ({ name: null as string | null, k: 0, seen: 0, plant: null as (() => void) | null }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    lstatSync: (p: unknown, ...rest: unknown[]) => {
      try { return (real.lstatSync as (...a: unknown[]) => unknown)(p, ...rest); }
      finally {
        if (race.plant !== null && p === race.name && ++race.seen === race.k) { const plant = race.plant; race.plant = null; plant(); }
      }
    },
  };
});
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, unlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceWitness, witnessPath, isWitnessUnusableError, type WitnessUnusableError } from '../../src/memory/witness-store.js';

const A = Buffer.from('row-a\n');
const VICTIM = JSON.stringify({ v: 1, scopes: { other: { entry: null, journal: null } } });   // witness-shaped: the read accepts it
const thrown = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return undefined; };

interface Firing { k: number; h: string; e: unknown }
/** One run per lstat of witness.json in one advanceWitness; `check` sees each run whose k was reached. Answers how many fired. */
function atEveryLstat(opts: { store?: boolean; dest: (h: string) => string; check: (f: Firing) => void }): number {
  let fired = 0;
  for (let k = 1; ; k++) {
    const h = realpathSync(mkdtempSync(join(tmpdir(), 'wr-')));
    try {
      advanceWitness(h, '@global', A, 'tx-a');
      const w = witnessPath(h);
      if (opts.store === false) unlinkSync(w);
      const dest = opts.dest(h);
      Object.assign(race, { name: w, k, seen: 0, plant: () => { try { unlinkSync(w); } catch { /* no file yet */ } symlinkSync(dest, w); } });
      const e = thrown(() => advanceWitness(h, '@global', A, 'tx-b'));
      const reached = race.plant === null;
      race.plant = null;
      if (!reached) return fired;
      fired++;
      opts.check({ k, h, e });
    } finally { race.plant = null; rmSync(h, { recursive: true, force: true }); }
  }
}
const refusedAsLink = (e: unknown): boolean => isWitnessUnusableError(e) && (e as WitnessUnusableError).reason === 'link';

describe('a link that takes witness.json at any lstat of that name never has its destination written', () => {
  const witnessShaped = (store: boolean): void => {
    const moved: number[] = []; const other: Array<[number, string]> = []; let refused = 0;
    const fired = atEveryLstat({
      store,
      dest: (h) => { const v = join(h, 'elsewhere.json'); writeFileSync(v, VICTIM); return v; },
      check: ({ k, h, e }) => {
        if (readFileSync(join(h, 'elsewhere.json'), 'utf8') !== VICTIM) moved.push(k);
        if (refusedAsLink(e)) refused++; else if (e !== undefined) other.push([k, String(e)]);
      },
    });
    expect(fired).toBeGreaterThan(0);        // a loop in which no k fired proved nothing
    expect(refused).toBeGreaterThan(0);
    expect(moved).toEqual([]);
    expect(other).toEqual([]);
  };
  it('a witness-shaped destination stays byte for byte, for every k', () => witnessShaped(true));
  it('the same when no witness.json existed yet', () => witnessShaped(false));

  it('a dangling link: nothing appears at its destination, for every k', () => {
    const landed: Array<[number, string[]]> = [];
    const fired = atEveryLstat({
      dest: (h) => { mkdirSync(join(h, 'sub')); return join(h, 'sub', 'w.json'); },
      check: ({ k, h }) => { const names = readdirSync(join(h, 'sub')); if (names.length > 0) landed.push([k, names]); },
    });
    expect(fired).toBeGreaterThan(0);
    expect(landed).toEqual([]);
  });
});
