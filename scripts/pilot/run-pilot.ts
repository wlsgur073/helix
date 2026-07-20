/** Pilot runner (protocol §execution). Reads manifest + snapshot (snapshot/<home>, snapshot/<proj>/.helix),
 *  probes MemoryStore.recall at the manifest K against the PROJECT ledger copy, writes deterministic JSON
 *  (no timestamps in content — stability runs must be byte-identical).
 *
 *  Adapted to the real MemoryStore.recall return shape (checked against src/memory/store.ts): recall()
 *  returns `RecallResult { items: RecalledItem[]; ... }` where each `RecalledItem` is
 *  `{ record: MemoryRecord; scope; needsReverify; integrity }` — the item id lives at `.record.id`,
 *  NOT `.id` directly. All `.id` accesses below go through `.record.id` accordingly. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';

const [manifestPath, snapshotDir, outPath] = process.argv.slice(2);
if (!manifestPath || !snapshotDir || !outPath) { console.error('usage: run-pilot <manifest> <snapshotDir> <out>'); process.exit(2); }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as
  { k: number; probes: { id: string; query: string; relevant: string[]; unambiguous: boolean }[] };
const home = join(snapshotDir, 'home');
const ledger = join(snapshotDir, 'proj', '.helix', 'memory.jsonl');
const store = new MemoryStore(ledger, { home, sessionId: 'pilot', now: () => '2026-01-01T00:00:00.000Z' });
const results = manifest.probes.map((p) => {
  const items = store.recall(p.query, { maxItems: manifest.k }).items;
  const ranks = p.relevant.map((rid) => items.findIndex((it) => it.record.id === rid) + 1).filter((r) => r > 0);
  const bestRank = ranks.length ? Math.min(...ranks) : null;
  return { id: p.id, query: p.query, unambiguous: p.unambiguous, bestRank,
    hitAtK: bestRank !== null && bestRank <= manifest.k, hitAt1: bestRank === 1,
    returned: items.map((it) => it.record.id) };
});
writeFileSync(outPath, JSON.stringify({ k: manifest.k, results }, null, 1) + '\n');
