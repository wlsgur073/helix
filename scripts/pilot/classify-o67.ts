/** Offline O_67-class (superset-competition) classifier — readiness C1.3.
 *  Rule: docs/release/o67-class-rule-2026-07.md. OUTCOME-BLIND by construction: reads the
 *  manifest + snapshot only; never reads run-pilot output. A probe with exactly one target T is
 *  in-class iff M(T) is non-empty and some servable non-target candidate C has M(T) ⊊ M(C),
 *  where M(r) = lexicalEvidence(Q, tokenize(r.content)).matched and
 *  Q = unique(meaningfulTokens(tokenize(query))) — the scorer's own query tokenization.
 *  Candidate pool = the record set MemoryStore.recall would serve (identities only; order
 *  discarded and never recorded). Deterministic: fixed clock, sorted arrays, no randomness.
 *  Usage: npx tsx scripts/pilot/classify-o67.ts <manifest> <snapshotDir> <out> */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { projectLedgerPath } from '../../src/memory/ownership.js';
import { lexicalEvidence, meaningfulTokens, tokenize } from '../../src/memory/retrieval.js';

export interface ProbeInput { id: string; query: string; relevant: string[]; unambiguous: boolean }
export interface CandidateDoc { id: string; content: string }
export interface ProbeVerdict {
  id: string;
  status: 'in-class' | 'not-in-class' | 'target-zero-evidence' | 'out-of-domain' | 'unscorable';
  reason?: string;                      // for out-of-domain / unscorable
  targetId?: string;
  qTerms?: string[];                    // sorted
  targetDirect?: string[];              // sorted
  targetRescued?: string[];             // sorted
  targetMatched?: string[];             // sorted
  witnesses?: { id: string; extraTerms: string[] }[]; // sorted by id; extraTerms sorted
  equalCoverage?: string[];             // ids of equal-set competitors (informational), sorted
  baseHit1Eligible: boolean;            // the manifest's unambiguous flag, echoed as data
  finalHit1Eligible: boolean;           // base && !in-class (recommended-gate field; C5.1 confirms)
}

export const strictSuperset = (a: Set<string>, b: Set<string>): boolean =>
  a.size > b.size && [...b].every((x) => a.has(x));

/** Pure per-probe classification over an explicit candidate pool (unit-testable core). */
export function classifyProbe(p: ProbeInput, pool: CandidateDoc[]): ProbeVerdict {
  const base = p.unambiguous === true;
  if (p.relevant.length !== 1) {
    return { id: p.id, status: 'out-of-domain', reason: p.relevant.length === 0 ? 'no-target' : 'multi-target', baseHit1Eligible: base, finalHit1Eligible: base };
  }
  const targetId = p.relevant[0]!;
  const qTerms = [...new Set(meaningfulTokens(tokenize(p.query)))].sort();
  if (qTerms.length === 0) {
    return { id: p.id, status: 'unscorable', reason: 'empty-query', targetId, baseHit1Eligible: base, finalHit1Eligible: false };
  }
  const byId = new Map<string, CandidateDoc[]>();
  for (const c of pool) { const arr = byId.get(c.id) ?? []; arr.push(c); byId.set(c.id, arr); }
  const targetDocs = byId.get(targetId) ?? [];
  if (targetDocs.length === 0) {
    return { id: p.id, status: 'unscorable', reason: 'target-not-servable', targetId, baseHit1Eligible: base, finalHit1Eligible: false };
  }
  if (targetDocs.length > 1) {
    return { id: p.id, status: 'unscorable', reason: 'duplicate-target-identity', targetId, baseHit1Eligible: base, finalHit1Eligible: false };
  }
  const evOf = (c: CandidateDoc) => lexicalEvidence(qTerms, tokenize(c.content));
  const t = evOf(targetDocs[0]!);
  const common = { targetId, qTerms, targetDirect: [...t.direct].sort(), targetRescued: [...t.rescued].sort(), targetMatched: [...t.matched].sort(), baseHit1Eligible: base };
  if (t.matched.size === 0) {
    return { id: p.id, status: 'target-zero-evidence', ...common, finalHit1Eligible: base };
  }
  const witnesses: { id: string; extraTerms: string[] }[] = [];
  const equalCoverage: string[] = [];
  for (const c of pool) {
    if (c.id === targetId) continue;
    const m = evOf(c).matched;
    if (strictSuperset(m, t.matched)) witnesses.push({ id: c.id, extraTerms: [...m].filter((x) => !t.matched.has(x)).sort() });
    else if (m.size === t.matched.size && [...t.matched].every((x) => m.has(x))) equalCoverage.push(c.id);
  }
  witnesses.sort((a, b) => a.id.localeCompare(b.id));
  equalCoverage.sort();
  const inClass = witnesses.length > 0;
  return {
    id: p.id, status: inClass ? 'in-class' : 'not-in-class', ...common,
    ...(witnesses.length ? { witnesses } : {}), ...(equalCoverage.length ? { equalCoverage } : {}),
    finalHit1Eligible: base && !inClass,
  };
}

const main = (): void => {
  const [manifestPath, snapshotDir, outPath] = process.argv.slice(2);
  if (!manifestPath || !snapshotDir || !outPath) { console.error('usage: classify-o67 <manifest> <snapshotDir> <out>'); process.exit(2); }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { k: number; probes: ProbeInput[] };
  const home = join(snapshotDir, 'home');
  const projectRoot = join(snapshotDir, 'proj');
  const store = new MemoryStore(join(home, 'memory.jsonl'), {
    home, sessionId: 'classify-o67', now: () => '2026-01-01T00:00:00.000Z',
    project: { ledger: projectLedgerPath(projectRoot), root: projectRoot, home },
  });
  // Upper bound on servable records: total physical rows across both ledgers.
  const rowsOf = (p: string): number => { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  const maxItems = Math.max(1, rowsOf(join(home, 'memory.jsonl')) + rowsOf(projectLedgerPath(projectRoot)));
  const verdicts = manifest.probes.map((p) => {
    // Candidate pool: identities the production recall would serve for this query (order discarded).
    const pool: CandidateDoc[] = store.recall(p.query, { maxItems }).items.map((it) => ({ id: it.record.id, content: it.record.content }));
    return classifyProbe(p, pool);
  });
  verdicts.sort((a, b) => a.id.localeCompare(b.id));
  const summary = {
    census: verdicts.filter((v) => v.status !== 'out-of-domain').length,
    inClass: verdicts.filter((v) => v.status === 'in-class').map((v) => v.id),
    targetZeroEvidence: verdicts.filter((v) => v.status === 'target-zero-evidence').map((v) => v.id),
    unscorable: verdicts.filter((v) => v.status === 'unscorable').map((v) => v.id),
    outOfDomain: verdicts.filter((v) => v.status === 'out-of-domain').map((v) => v.id),
  };
  writeFileSync(outPath, JSON.stringify({ rule: 'o67-class-rule-2026-07', manifest: manifestPath.split('/').pop(), summary, probes: verdicts }, null, 1) + '\n');
};
if (process.argv[1] && process.argv[1].endsWith('classify-o67.ts')) main();
