/** Pilot runner (protocol §execution). Reads manifest + snapshot (snapshot/home/memory.jsonl as the
 *  GLOBAL ledger, snapshot/proj/.helix/memory.jsonl as the PROJECT ledger under project root
 *  snapshot/proj), probes MemoryStore.recall at the manifest K, writes deterministic JSON (no
 *  timestamps in content — stability runs must be byte-identical).
 *
 *  Adapted to the real MemoryStore.recall return shape (checked against src/memory/store.ts): recall()
 *  returns `RecallResult { items: RecalledItem[]; ... }` where each `RecalledItem` is
 *  `{ record: MemoryRecord; scope; needsReverify; integrity }` — the item id lives at `.record.id`,
 *  NOT `.id` directly. All `.id` accesses below go through `.record.id` accordingly.
 *
 *  Production-faithful dual-scope construction (task-2 review fix): mirrors src/server/index.ts's own
 *  store wiring exactly — globalLedger = <home>/memory.jsonl; project = { ledger:
 *  <projectRoot>/.helix/memory.jsonl, root: projectRoot, home }. Ranks are measured against the SAME
 *  candidate set production recall serves (global + an OWNED project, merged), not the project ledger
 *  alone. The project scope only participates when `isOwned(projectRoot, home)` is true
 *  (src/memory/ownership.ts) — an un-adopted ledger file reads as 'unadopted-present' and is excluded
 *  from recall entirely — so the real snapshot (next task) must copy ~/.helix/projects.json alongside
 *  the master key, or every project-scope probe silently degrades to a global-only recall.
 *
 *  `compaction` is deliberately left unset (disabled): compactLedger preserves the live projection by
 *  construction so it can never change a rank, but it WOULD rewrite the snapshot's ledger bytes on
 *  disk — and a frozen snapshot must stay byte-identical across stability re-runs. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { projectLedgerPath } from '../../src/memory/ownership.js';

const [manifestPath, snapshotDir, outPath] = process.argv.slice(2);
if (!manifestPath || !snapshotDir || !outPath) { console.error('usage: run-pilot <manifest> <snapshotDir> <out>'); process.exit(2); }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as
  { k: number; probes: { id: string; query: string; relevant: string[]; unambiguous: boolean }[] };
const home = join(snapshotDir, 'home');
const globalLedger = join(home, 'memory.jsonl');
const projectRoot = join(snapshotDir, 'proj');
const projectLedger = projectLedgerPath(projectRoot);
const store = new MemoryStore(globalLedger, {
  home, sessionId: 'pilot', now: () => '2026-01-01T00:00:00.000Z',
  project: { ledger: projectLedger, root: projectRoot, home },
});
const results = manifest.probes.map((p) => {
  const items = store.recall(p.query, { maxItems: manifest.k }).items;
  const ranks = p.relevant.map((rid) => items.findIndex((it) => it.record.id === rid) + 1).filter((r) => r > 0);
  const bestRank = ranks.length ? Math.min(...ranks) : null;
  return { id: p.id, query: p.query, unambiguous: p.unambiguous, bestRank,
    hitAtK: bestRank !== null && bestRank <= manifest.k, hitAt1: bestRank === 1,
    returned: items.map((it) => it.record.id) };
});
writeFileSync(outPath, JSON.stringify({ k: manifest.k, results }, null, 1) + '\n');
