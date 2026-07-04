import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { handleInspect } from '../../src/server/handlers.js';

const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

describe('handleInspect asOf (spec C §6)', () => {
  const mk = () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-ia-'));
    const store = new MemoryStore(join(home, 'memory.jsonl'), { sessionId: 's', home });
    const a = store.commit({ content: 'fact', source: 'user' });
    store.confirm(a.id);
    return { store, id: a.id };
  };

  it('renders a snapshot with a fact line and a WINNER evidence sub-line', () => {
    const { store, id } = mk();
    const out = text(handleInspect(store, { asOf: new Date().toISOString() }));
    expect(out).toContain('MEMORY AS OF');
    expect(out).toContain(id);
    expect(out).toContain('Verified');
    expect(out).toContain('WINNER');
    expect(out).toContain('membership and timing are declared'); // honest note
  });

  it('rejects a malformed as-of cursor with an error, no frame', () => {
    const { store } = mk();
    const out = text(handleInspect(store, { asOf: 'yesterday' }));
    expect(out).toContain('canonical ISO-8601 instant');
    expect(out).not.toContain('MEMORY AS OF');
  });

  it('history and asOf together is an error', () => {
    const { store } = mk();
    const out = text(handleInspect(store, { history: true, asOf: new Date().toISOString() }));
    expect(out).toContain('mutually exclusive');
  });
});
