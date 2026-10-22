// The server-instructions facet of the inventory (issue #4): recovered from the bundle the user runs,
// once with no config and once with the switch on. inventory-mutation.test.ts shows the extractor reads
// the bundle it is given; this file shows what the shipped one answers.
import { describe, it, expect } from 'vitest';
import { instructionsFromBundle } from '../../scripts/inventory/extract-instructions.js';

describe('server instructions facet', () => {
  it('recovers absence by default and the text with the switch on, from the shipped bundle', async () => {
    const r = await instructionsFromBundle();
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ configJson: null, instructions: null });
    expect(r[1]?.configJson).toBe('{"serverInstructions":true}');
    expect(r[1]?.instructions).toHaveLength(606);
    expect(r[1]?.instructions?.startsWith('Helix provides optional persistent memory')).toBe(true);
  }, 90_000);
});
