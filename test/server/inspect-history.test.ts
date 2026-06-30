import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { handleInspect } from '../../src/server/handlers.js';

function tmpStore() {
  const home = mkdtempSync(join(tmpdir(), 'helix-ih-'));
  let n = 0, t = 0;
  return new MemoryStore(join(home, 'memory.jsonl'), {
    sessionId: 's', home,
    now: () => `2026-06-09T00:00:00.${String(++t).padStart(3, '0')}Z`,
    genId: () => `m_${++n}`,
  });
}

describe('handleInspect history mode', () => {
  it('default (no history) is unchanged: a CURRENT MEMORY frame, no interval in the mark', () => {
    const store = tmpStore();
    store.commit({ content: 'hello', source: 'user' });
    const text = handleInspect(store, {}).content[0]!.text;
    expect(text).toContain('CURRENT MEMORY');
    expect(text).not.toContain('..');               // no [tx..txTo] interval in default mode
  });

  it('history=true lists a closed row with its interval and closedBy verb', () => {
    const store = tmpStore();
    const a = store.commit({ content: 'old', source: 'user' });
    store.commit({ content: 'new', source: 'user', supersedes: a.id });
    const text = handleInspect(store, { history: true }).content[0]!.text;
    expect(text).toContain('MEMORY HISTORY');
    expect(text).toContain('supersede:global');     // closed-row mark uses the closer verb + scope
    expect(text).toMatch(/2026-06-09T00:00:00\.\d{3}Z\.\.2026-06-09T00:00:00\.\d{3}Z/); // [tx..txTo]
  });

  it('empty memory in history mode returns the empty marker', () => {
    expect(handleInspect(tmpStore(), { history: true }).content[0]!.text).toBe('(memory is empty)');
  });
});
