import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseLedger, parseLedgerText } from '../src/memory/ledger.js';

describe('parseLedgerText', () => {
  it('parses the same records as parseLedger over the same bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-parsetext-'));
    try {
      const path = join(dir, 'm.jsonl');
      const lines = [
        JSON.stringify({ id: 'a', type: 'assert', content: 'one', state: 'Fresh', provenance: { source: 'user', sessionId: 's' } }),
        '   ',                                   // blank -> skipped
        '{not json',                             // torn -> tolerated/skipped
        JSON.stringify({ id: 'b', type: 'assert', content: 'two', state: 'Fresh', provenance: { source: 'user', sessionId: 's' } }),
      ].join('\n') + '\n';
      writeFileSync(path, lines);
      expect(parseLedgerText(readFileSync(path, 'utf8'))).toEqual(parseLedger(path));
      expect(parseLedgerText(lines).map((r) => (r as { id: string }).id)).toEqual(['a', 'b']);
      expect(parseLedgerText('')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
