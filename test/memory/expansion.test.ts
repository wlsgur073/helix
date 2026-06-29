import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadExpansion, defaultExpansion } from '../../src/memory/expansion.js';

const ASSET = fileURLToPath(new URL('../../data/semantic-neighbors.json', import.meta.url));

describe('semantic-neighbors asset', () => {
  it('exists and has the expected envelope', () => {
    expect(existsSync(ASSET)).toBe(true);
    const j = JSON.parse(readFileSync(ASSET, 'utf8'));
    expect(j.version).toBe(1);
    expect(j.source).toBe('potion-base-8M');
    expect(typeof j.floor).toBe('number');
    expect(typeof j.neighbors).toBe('object');
  });

  it('encodes the known general-English synonym bridges (scope = §2)', () => {
    const j = JSON.parse(readFileSync(ASSET, 'utf8'));
    const neigh = (w: string): Record<string, number> =>
      Object.fromEntries((j.neighbors[w] ?? []).map((e: [string, number]) => [e[0], e[1]]));
    expect(neigh('remove').delete).toBeGreaterThan(450); // probe measured ~657
    expect(neigh('failure').error).toBeGreaterThan(450); // probe measured ~525
    // domain bridge is OUT of scope and must NOT be forced in:
    expect(neigh('persistence').storage ?? 0).toBeLessThan(450);
  });

  it('is reasonably sized (sub-~1.5MB) and integer-weighted', () => {
    const raw = readFileSync(ASSET, 'utf8');
    expect(raw.length).toBeLessThan(1_500_000);
    const j = JSON.parse(raw);
    for (const arr of Object.values<[string, number][]>(j.neighbors)) {
      for (const [, wm] of arr) expect(Number.isInteger(wm)).toBe(true);
    }
  });
});

describe('loadExpansion', () => {
  const blob = JSON.stringify({ version: 1, source: 'potion-base-8M', floor: 0.45, k: 8,
    neighbors: { remove: [['delete', 657], ['erase', 540], ['weak', 300]] } });
  it('parses, divides weightMilli by 1000, filters by theta, caps k', () => {
    const exp = loadExpansion(blob, 0.55, 1); // theta=0.55 drops erase(.54)+weak(.30); k=1
    expect([...exp.get('remove')!]).toEqual([{ token: 'delete', w: 0.657 }]);
  });
  it('theta below an entry keeps it', () => {
    const exp = loadExpansion(blob, 0.50, 8);
    expect(exp.get('remove')!.map((e) => e.token)).toEqual(['delete', 'erase']);
  });
});

describe('defaultExpansion', () => {
  it('resolves + loads the committed data/ asset', () => {
    const exp = defaultExpansion();
    expect(exp).toBeDefined();
    expect(exp!.get('remove')?.some((e) => e.token === 'delete')).toBe(true);
  });
});
