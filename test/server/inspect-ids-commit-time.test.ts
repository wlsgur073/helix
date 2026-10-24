// Issue #9, its 2026-10-12 comment: a record named in a recency note could only be dated by rendering the
// whole history, since `history` excludes `ids`. helix_memory_inspect with `ids` now marks each record with
// the time it carries, in the interval form history uses (`<state>:<scope>:<tx>..`), on its DATA and PROOF
// lines alike. The unfiltered live listing keeps its two-part mark.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStore } from '../../src/memory/store.js';
import { handleInspect, type ToolResult } from '../../src/server/handlers.js';
import { buildServer } from '../../src/server/helix-server.js';

function store(): { store: MemoryStore; path: string } {
  const home = mkdtempSync(join(tmpdir(), 'helix-i9-ids-'));
  const path = join(home, 'm.jsonl');
  return { store: new MemoryStore(path, { home, sessionId: 's1', now: () => '2026-10-08T05:42:04.416Z' }), path };
}
const text = (r: ToolResult): string => r.content.map((c) => c.text).join('');

describe('helix_memory_inspect ids shows the time each record carries (issue #9)', () => {
  it('ids marks the record and its PROOF line with the record\'s time, as history does', () => {
    const { store: s } = store();
    const rec = s.commit({ content: 'db is postgres', source: 'user' });
    const out = text(handleInspect(s, { ids: [rec.id] }));
    expect(out).toContain('DATA[Fresh:global:2026-10-08T05:42:04.416Z..]| db is postgres');
    expect(out).toMatch(new RegExp(`^PROOF\\[Fresh:global:2026-10-08T05:42:04\\.416Z\\.\\.\\]\\| ${rec.id} contentDigest: [0-9a-f]{64}$`, 'm'));
  });

  it('the unfiltered live listing keeps the two-part mark', () => {
    const { store: s } = store();
    const rec = s.commit({ content: 'db is postgres', source: 'user' });
    const out = text(handleInspect(s, {}));
    expect(out).toContain('DATA[Fresh:global]| db is postgres');
    expect(out).toMatch(new RegExp(`^PROOF\\[Fresh:global\\]\\| ${rec.id} contentDigest: [0-9a-f]{64}$`, 'm'));
  });

  it('a record whose tx is not a canonical instant shows ?? in its mark', () => {
    const { store: s, path } = store();
    s.commit({ content: 'db is postgres', source: 'user' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    appendFileSync(path, JSON.stringify({ ...JSON.parse(lines[lines.length - 1]!), id: 'm_badtx', content: 'kettle note', tx: '2026-10-08 05:42' }) + '\n');
    const out = text(handleInspect(s, { ids: ['m_badtx'] }));
    expect(out).toContain('DATA[Fresh:global:??..]| kettle note');
    expect(out).toMatch(/^PROOF\[Fresh:global:\?\?\.\.\]\| m_badtx contentDigest: [0-9a-f]{64}$/m);
  });

  it('the tool description says that ids shows the record\'s time', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'i9-ids', version: '0' });
    await Promise.all([client.connect(ct), buildServer(store().store).connect(st)]);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'helix_memory_inspect')?.description)
      .toMatch(/With ids, each record's mark also shows the time the record carries, in the interval form history uses/);
  });
});
