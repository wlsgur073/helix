import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { globalStore } from './_shared.js';

describe('probe (g): malformed ledger rows are skipped, never crash recall/inspect', () => {
  const bad = ['null', '"a string"', '123', '{}', '{"id":null}', '{ not json'];
  for (const line of bad) {
    it(`recall + inspect survive a ledger line: ${line}`, () => {
      const { store, global } = globalStore();
      store.commit({ content: 'a good fact about deployment', source: 'user' });
      writeFileSync(global, line + '\n' + '{"broken":', { flag: 'a' });
      expect(() => store.recall('deployment')).not.toThrow();
      expect(() => store.inspect()).not.toThrow();
    });
  }
});
