// Fails when the committed snapshot and a live recovery disagree. A tenth tool, a new config leaf,
// a new environment variable, a new hook or a new CLI flag is reported here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSurface, SURFACE_PATH } from '../../scripts/inventory/build-inventory.js';

describe('surface snapshot', () => {
  it('matches the committed snapshot exactly', async () => {
    const live = await buildSurface();
    const committed = JSON.parse(readFileSync(SURFACE_PATH, 'utf8'));
    expect(live, 'the shipped surface drifted from data/inventory/surface.json — run `npm run inventory`').toEqual(committed);
  }, 90_000);

  it('the snapshot is non-trivial in every class', () => {
    const s = JSON.parse(readFileSync(SURFACE_PATH, 'utf8'));
    expect(s.tools.length).toBeGreaterThan(1);
    expect(s.configLeaves.length).toBeGreaterThan(1);
    expect(s.envVars.length).toBeGreaterThan(1);
    expect(s.hooks.length).toBe(2);
    expect(s.clis.length).toBe(3); // helix-trigger, helix-rebaseline, helix-trust-resolve (C1.4-③)
  });
});
