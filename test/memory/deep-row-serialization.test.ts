import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';

describe('D6: a deeply-nested parsed row cannot brick recall via auto-compaction', () => {
  it('recall survives a row whose field JSON.stringify would overflow', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-d6-'));
    const ledger = join(home, 'memory.jsonl');
    // NOTE: the depth cap (Task 1) already drops this at parse; this test proves the eligibility
    // serializer is ALSO wrapped, so even a row that slips a future guard change cannot brick recall.
    const store = new MemoryStore(ledger, { sessionId: 's', home, compaction: { auto: true, minRows: 1, minReclaimBytes: 0, minReclaimRatio: 0, graceMs: 0 } as any });
    for (let i = 0; i < 5; i++) store.commit({ content: `fact ${i}`, source: 'user' });
    // A structurally-valid but pathologically deep line appended raw (bypasses commit's shallow record).
    const deep = '['.repeat(9000) + ']'.repeat(9000);
    appendFileSync(ledger, `{"id":"deep","content":"c","tx":"2026-01-01T00:00:00.000Z","provenance":{},"x":${deep}}\n`);
    expect(() => store.recall('fact')).not.toThrow();
  });
});
