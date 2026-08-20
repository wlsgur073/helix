// F10.c — the MCP erase is documented as SOFT-only (handlers.ts's own docstring: "NEVER physically
// destroys content"). Nothing at source read the raw ledger to check, so flipping the call-site
// default to { permanent: true } survived the whole suite. This file measures the guarantee at the
// only place it exists: the bytes of the ledger file after the tool ran.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { handleErase } from '../../src/server/handlers.js';

describe('handleErase against the raw ledger (F10.c)', () => {
  it('the tool erase is soft: the content line physically survives and a tombstone is appended', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-f10c-'));
    const ledger = join(home, 'm.jsonl');
    let n = 0;
    const store = new MemoryStore(ledger, {
      home, sessionId: 's1', now: () => '2026-06-09T00:00:00.000Z', genId: () => `m_${++n}`,
    });
    try {
      const marker = 'raw-ledger-soft-erase-probe-content';
      const rec = store.commit({ content: marker, source: 'user' });
      const before = readFileSync(ledger, 'utf8');
      expect(before, 'fixture sanity: the commit landed in the file').toContain(marker);

      const res = handleErase(store, { id: rec.id }, { auditPath: join(home, 'audit.jsonl'), now: () => '2026-06-09T00:00:01.000Z' });
      expect(res.content.map((c) => ('text' in c ? c.text : '')).join('')).toContain('erased');

      const after = readFileSync(ledger, 'utf8');
      expect(after, 'SOFT means the plaintext is still on disk, recoverable until a compaction').toContain(marker);
      expect(after.split('\n').length, 'a tombstone row was APPENDED, not a rewrite').toBeGreaterThan(before.split('\n').length);
      expect(store.recall(marker).items.find((i) => i.record.id === rec.id), 'and the live view no longer serves it').toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
