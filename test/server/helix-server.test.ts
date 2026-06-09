import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { buildServer } from '../../src/server/helix-server.js';

describe('buildServer', () => {
  it('constructs an McpServer with the helix tools registered (no throw)', () => {
    const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), 'helix-srv-')), 'm.jsonl'), { sessionId: 's1' });
    const server = buildServer(store);
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
  });
});
