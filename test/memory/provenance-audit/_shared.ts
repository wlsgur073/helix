import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../../src/memory/store.js';

const CLK = '2026-07-01T00:00:00.000Z';

/** Owned project store over synthetic temp ledgers (mirrors test/memory/erase-routing.test.ts). */
export function projectStore() {
  const home = mkdtempSync(join(tmpdir(), 'helix-pa-'));
  const root = mkdtempSync(join(tmpdir(), 'helix-pa-proj-'));
  const global = join(home, 'memory.jsonl');
  const projLedger = join(root, '.helix', 'memory.jsonl');
  let n = 0;
  const store = new MemoryStore(global, {
    sessionId: 's', home, now: () => CLK, genId: () => `m_${++n}`,
    project: { ledger: projLedger, root, home },
  });
  store.adopt();
  return { store, global, projLedger, home, root };
}

/** Global-only store (no project scope). */
export function globalStore() {
  const home = mkdtempSync(join(tmpdir(), 'helix-pa-'));
  const global = join(home, 'memory.jsonl');
  let n = 0;
  const store = new MemoryStore(global, { sessionId: 's', home, now: () => CLK, genId: () => `m_${++n}` });
  return { store, global, home };
}
