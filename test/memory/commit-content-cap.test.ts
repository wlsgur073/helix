import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { MAX_COMMIT_CONTENT_CHARS } from '../../src/limits.js';

describe('commit content cap (H3)', () => {
  const mk = (home: string) => new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's', now: () => '2026-06-09T00:00:00.000Z', genId: () => 'm_1' });
  it('rejects content past the cap BEFORE scanning or appending', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-h3-'));
    try {
      const store = mk(home);
      expect(() => store.commit({ content: 'x'.repeat(MAX_COMMIT_CONTENT_CHARS + 1), source: 'user' }))
        .toThrow(/content exceeds/i);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('accepts content AT the cap', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-h3b-'));
    try {
      expect(mk(home).commit({ content: 'x'.repeat(MAX_COMMIT_CONTENT_CHARS), source: 'user' }).id).toBeTruthy();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
