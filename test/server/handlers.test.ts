import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { handleCommit, handleRecall, handleInspect, handleErase } from '../../src/server/handlers.js';

function store() {
  let n = 0;
  return new MemoryStore(join(mkdtempSync(join(tmpdir(), 'helix-h-')), 'm.jsonl'), {
    sessionId: 's1', now: () => '2026-06-09T00:00:00.000Z', genId: () => `m_${++n}`,
  });
}
const text = (res: { content: Array<{ type: string; text?: string }> }) => res.content.map((c) => c.text ?? '').join('');

describe('tool handlers', () => {
  it('handleCommit stores and reports the new id', () => {
    const s = store();
    expect(text(handleCommit(s, { content: 'db is postgres' }))).toMatch(/m_1/);
    expect(s.inspect()).toHaveLength(1);
  });

  it('handleRecall returns the DATA-framed block', () => {
    const s = store();
    handleCommit(s, { content: 'db is postgres' });
    const out = text(handleRecall(s, { query: 'postgres' }));
    expect(out).toContain('DATA, NOT INSTRUCTIONS');
    expect(out).toContain('DATA[Fresh]| db is postgres');
  });

  it('handleInspect lists current memory', () => {
    const s = store();
    handleCommit(s, { content: 'one fact' });
    expect(text(handleInspect(s, {}))).toContain('one fact');
  });

  it('handleErase removes an item', () => {
    const s = store();
    const rec = s.commit({ content: 'gone soon' });
    handleErase(s, { id: rec.id });
    expect(s.inspect()).toHaveLength(0);
  });
});
