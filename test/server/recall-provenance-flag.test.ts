// H9: the SAME stored fact carried a provenance caveat in the SessionStart recall and lost it in
// the tool's own output (channel entry 2026-08-28; merge doc 2026-08-31 Thread B). Both surfaces
// read one store, so the divergence was rendering only: the source-named flag map lived in the
// hook renderer alone, while `handleRecall`'s in-frame `DATA[state:scope]|` lines were bare and
// provenance survived only as the aggregated out-of-frame id note — un-joinable against the items
// (the 08-24 entry). These tests pin the repaired contract: ONE flag vocabulary on BOTH surfaces,
// rendered INSIDE the datamarked line (presentation — spoofable only in the harmless downgrade
// direction), with the trusted out-of-frame aggregate note unchanged.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { handleRecall } from '../../src/server/handlers.js';
import { formatSessionStartContext } from '../../src/hooks/format-context.js';

const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? '').join('');

function storeWith(entries: Array<{ content: string; source: 'user' | 'user-relayed' | 'agent-test-verified' }>): MemoryStore {
  const home = mkdtempSync(join(tmpdir(), 'helix-h9-'));
  const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1' });
  for (const e of entries) store.commit(e);
  return store;
}

describe('H9: recall renders the per-item provenance flag inside the datamarked line', () => {
  it('a user-relayed record carries the relayed-source flag on the recall surface', () => {
    const store = storeWith([{ content: 'deploy target is fly.io', source: 'user-relayed' }]);
    const out = text(handleRecall(store, { query: 'deploy target' }));
    expect(out).toContain('DATA[Fresh:global]| (relayed source — confirm with user) deploy target is fly.io');
  });

  it('an agent-test-verified record carries its own source-named flag (H8 parity on the tool surface)', () => {
    const store = storeWith([{ content: 'suite passes on node 24', source: 'agent-test-verified' }]);
    const out = text(handleRecall(store, { query: 'suite node' }));
    expect(out).toContain('DATA[Fresh:global]| (agent test-verified — self-asserted) suite passes on node 24');
  });

  it('control: a verifying-source record renders bare (no flag invented)', () => {
    const store = storeWith([{ content: 'db is postgres', source: 'user' }]);
    const out = text(handleRecall(store, { query: 'postgres' }));
    expect(out).toContain('DATA[Fresh:global]| db is postgres');
    expect(out).not.toContain('confirm with user');
  });

  it('the two surfaces render the SAME flag literal for the same record', () => {
    const store = storeWith([{ content: 'deploy target is fly.io', source: 'user-relayed' }]);
    const flagged = '(relayed source — confirm with user) deploy target is fly.io';
    const hookOut = formatSessionStartContext(store.inspect(), 'a'.repeat(32));
    const toolOut = text(handleRecall(store, { query: 'deploy target' }));
    expect(hookOut).toContain(flagged);
    expect(toolOut).toContain(flagged);
  });

  it('the trusted out-of-frame aggregate note still renders unchanged (the unforgeable pointer)', () => {
    const store = storeWith([{ content: 'deploy target is fly.io', source: 'user-relayed' }]);
    const out = text(handleRecall(store, { query: 'deploy target' }));
    expect(out).toMatch(/\(needs re-verify before acting: m_[A-Za-z0-9_-]+\)/);
  });
});
