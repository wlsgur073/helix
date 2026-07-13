import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { parseLedgerText } from '../../src/memory/ledger.js';

// D6: a pathologically deep field would throw `RangeError: Maximum call stack size exceeded` inside
// JSON.stringify (used by the auto-compaction eligibility serializer and the compaction writer). The
// LOAD-BEARING protection is the parse-boundary DEPTH CAP (isWellFormedRecord's withinDepth): a row
// nested past MAX_PARSE_DEPTH is DROPPED at parse, so it never reaches any serializer on the recall or
// compaction path. These tests pin the cap, not a downstream wrap — removing the cap turns them RED.
describe('D6: the parse depth cap keeps a deep row off the recall / auto-compaction path', () => {
  const DEEP = '['.repeat(9000) + ']'.repeat(9000); // ~depth 9000, far past the cap and past stringify's limit

  it('parseLedgerText drops a deep row (so no serializer ever receives it)', () => {
    const line = `{"id":"deep","content":"c","tx":"2026-01-01T00:00:00.000Z","provenance":{},"x":${DEEP}}`;
    // Sanity: JSON.stringify of the parsed value genuinely overflows — proving the cap is what saves us.
    expect(() => JSON.stringify(JSON.parse(line))).toThrow(); // RangeError: Maximum call stack size exceeded
    expect(parseLedgerText(line)).toHaveLength(0);            // dropped at the boundary → red if the cap is removed
  });

  it('recall survives + returns real facts when a deep row is present, with auto-compaction eligible', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-d6-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home, compaction: { auto: true, minRows: 1, minReclaimBytes: 0, minReclaimRatio: 0, graceMs: 0 } as any });
    for (let i = 0; i < 5; i++) store.commit({ content: `fact ${i}`, source: 'user' });
    appendFileSync(ledger, `{"id":"deep","content":"c","tx":"2026-01-01T00:00:00.000Z","provenance":{},"x":${DEEP}}\n`);
    expect(() => store.recall('fact')).not.toThrow();                 // deep row dropped at parse → no serializer overflow
    expect(store.recall('fact').items.some((i) => i.record.id === 'deep')).toBe(false); // and it is not surfaced
  });
});
