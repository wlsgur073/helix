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
import { defaultExpansion } from '../../src/memory/expansion.js';
import { probeUniverse, corpusPrecondition, assertScopeParticipated } from './candidate-universe.js';

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
  // The universe artifact is written to a sibling path derived from <out>. If <out> itself ended in
  // .universe.json, a later run could derive that same name and silently overwrite THIS run's
  // verdicts — the artifact rule §6 hashes before scoring. Reserve the suffix instead.
  if (outPath.endsWith('.universe.json')) { throw new Error(`reserved-output-suffix: <out> must not end in .universe.json (${outPath}); that name is derived for the candidate-universe artifact`); }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { k: number; probes: ProbeInput[] };
  const home = join(snapshotDir, 'home');
  const projectRoot = join(snapshotDir, 'proj');
  const store = new MemoryStore(join(home, 'memory.jsonl'), {
    home, sessionId: 'classify-o67', now: () => '2026-01-01T00:00:00.000Z',
    project: { ledger: projectLedgerPath(projectRoot), root: projectRoot, home },
  });
  // Snapshot preconditions, once, before any probe: identity uniqueness is a corpus property (a
  // per-probe check sits behind recall's relevance filter and would miss it), an unreadable ledger
  // must not be counted as zero rows, and an empty corpus is not a corpus. Rule §4 makes any
  // snapshot error a gate failure, so these refuse the run rather than classify a degraded one.
  const { bound: maxItems, rowsByScope } = corpusPrecondition([
    { scope: 'global', path: join(home, 'memory.jsonl') },
    { scope: 'project', path: projectLedgerPath(projectRoot) },
  ]);
  const universe: { id: string; candidates: string[] }[] = [];
  let disclosure: { projectDisposition: string; integrityAvailable: boolean; witnessNotes: string[] } | undefined;
  const verdicts = manifest.probes.map((p) => {
    // Candidate pool: identities the production recall would serve for this query (order discarded).
    const res = store.recall(p.query, { maxItems });
    // Recall discloses whether a whole scope was excluded by ownership/witness enforcement. Rule §3
    // defines candidates as what production SERVES with that enforcement included, so the artifact
    // records it — otherwise a degraded run and a small corpus hash to indistinguishable files.
    disclosure ??= { projectDisposition: res.projectDisposition, integrityAvailable: res.integrityAvailable, witnessNotes: res.witnessNotes };
    // The hashed universe and the verdicts come from the SAME in-run recall, so a verdict can never
    // name an identity that is absent from the universe it is supposed to have competed in.
    universe.push({ id: p.id, candidates: probeUniverse(res.items.map((it) => ({ id: it.record.id, scope: it.scope }))) });
    const pool: CandidateDoc[] = res.items.map((it) => ({ id: it.record.id, content: it.record.content }));
    return classifyProbe(p, pool);
  });
  // The larger loss channel, and it hides on the path rule §6 prescribes: a snapshot copied for
  // window close is un-adopted by canonical-path ownership, so its project rows count toward the
  // bound while serving nothing.
  assertScopeParticipated(rowsByScope, disclosure?.projectDisposition ?? 'inactive');
  universe.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  verdicts.sort((a, b) => a.id.localeCompare(b.id));
  const summary = {
    census: verdicts.filter((v) => v.status !== 'out-of-domain').length,
    inClass: verdicts.filter((v) => v.status === 'in-class').map((v) => v.id),
    targetZeroEvidence: verdicts.filter((v) => v.status === 'target-zero-evidence').map((v) => v.id),
    unscorable: verdicts.filter((v) => v.status === 'unscorable').map((v) => v.id),
    outOfDomain: verdicts.filter((v) => v.status === 'out-of-domain').map((v) => v.id),
  };
  writeFileSync(outPath, JSON.stringify({ rule: 'o67-class-rule-2026-07', manifest: manifestPath.split('/').pop(), summary, probes: verdicts }, null, 1) + '\n');
  // SEPARATE artifact by design: the verdict file's bytes stay reproducible (the C1.3 retrodiction
  // anchor is pinned against them), while rule §6's window-close procedure gets the universe it
  // requires to be hashed BEFORE scoring.
  writeFileSync(outPath.replace(/\.json$/, '') + '.universe.json', JSON.stringify({
    rule: 'o67-class-rule-2026-07',
    artifact: 'candidate-universe',
    manifest: manifestPath.split('/').pop(),
    identity: '<scope>:<record-id> — split at the FIRST colon; scope is global|project',
    order: 'sorted by identity; recall order is discarded and never recorded (rule §3)',
    recallBound: maxItems,
    // expansion.ts resolves data/semantic-neighbors.json module-relative and falls back to
    // undefined on ANY read/parse failure, silently. Semantically-rescued records carry zero
    // lexical evidence, so they can never be witnesses or equal-coverage competitors: they change
    // the UNIVERSE without changing a single verdict. The pinned verdict hashes therefore cannot
    // detect the asset's absence — this field is the only signal.
    disclosure: { rowsByScope, ...disclosure, expansionAvailable: defaultExpansion() !== undefined },
    probes: universe,
  }, null, 1) + '\n');
};
if (process.argv[1] && process.argv[1].endsWith('classify-o67.ts')) main();
