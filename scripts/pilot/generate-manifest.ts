/** Manifest generator (protocol §enumeration). Ledger-side probes are fully mechanical; oracle-side
 *  probes take a MANUAL entry→record mapping supplied as a JSON file (adjudicated once, frozen with
 *  the manifest). Usage: npx tsx scripts/pilot/generate-manifest.ts <snapshotDir> <oracleMd> <mappingJson> <out> */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { topicTerms, deriveQuery } from './derive.js';
import { segmentOracle } from './segment-oracle.js';

const [snapshotDir, oraclePath, mappingPath, outPath] = process.argv.slice(2);
if (!snapshotDir || !oraclePath || !mappingPath || !outPath) { console.error('usage: generate-manifest <snapshotDir> <oracleMd> <mappingJson> <out>'); process.exit(2); }
const rows = readFileSync(join(snapshotDir, 'proj', '.helix', 'memory.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; type: string; content: string; supersedes: string | null });
const superseded = new Set(rows.filter((r) => r.type === 'supersede' || r.type === 'erase').map((r) => r.supersedes).filter(Boolean) as string[]);
const live = rows.filter((r) => (r.type === 'assert' || r.type === 'supersede') && !superseded.has(r.id));
const termsOf = new Map(live.map((r) => [r.id, new Set(topicTerms(r.content))]));
const unambiguous = (relevant: string[], q: string[]): boolean => {
  if (relevant.length !== 1) return false;
  const overlapping = live.filter((r) => r.id !== relevant[0] && q.filter((t) => termsOf.get(r.id)!.has(t)).length >= 3);
  return overlapping.length === 0;
};
const probes: { id: string; query: string; relevant: string[]; unambiguous: boolean; side: string }[] = [];
for (const r of live) {
  const q = topicTerms(r.content);
  probes.push({ id: `L_${r.id}`, query: q.join(' '), relevant: [r.id], unambiguous: unambiguous([r.id], q), side: 'ledger' });
}
const mapping = JSON.parse(readFileSync(mappingPath, 'utf8')) as Record<string, string[]>; // entryIndex -> record ids
const { entries } = segmentOracle(readFileSync(oraclePath, 'utf8'));
entries.forEach((e, i) => {
  if (e.excluded) return;
  const relevant = mapping[String(i)] ?? [];
  const q = topicTerms(e.text);
  probes.push({ id: `O_${i}`, query: q.join(' '), relevant, unambiguous: unambiguous(relevant, q), side: 'oracle' });
});
writeFileSync(outPath, JSON.stringify({ k: 20, probes }, null, 1) + '\n');
console.log(`probes: ${probes.length} (ledger ${live.length}, oracle ${probes.length - live.length}); unambiguous: ${probes.filter((p) => p.unambiguous).length}`);
