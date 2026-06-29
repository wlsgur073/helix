// EH-3 calibration: sweep theta/gate/discount over a fixture; print per-case diagnostics + the
// recall/precision frontier. Dev tool only. Run: npx tsx scripts/calibrate-semantic.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rankRecords, semanticCoverage, tokenize, meaningfulTokens } from '../src/memory/retrieval.js';
import { loadExpansion } from '../src/memory/expansion.js';

const ASSET = fileURLToPath(new URL('../data/semantic-neighbors.json', import.meta.url));
const BLOB = readFileSync(ASSET, 'utf8');
const rec = (id, content) => ({ id, tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z',
  validTo: null, type: 'assert', state: 'Fresh', content, provenance: { source: 'user', sessionId: 'cli' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' });

const CORPUS = [
  rec('rm', 'rm <id> command hard-deletes a task'),
  rec('exit', 'Exit code 2 on usage error'),
  rec('iso', 'Timestamps are ISO 8601'),
  rec('verb', 'CLI commands are verb-first (add, list)'),
];
const POS = [['remove a job', 'rm'], ['unsuccessful run', 'exit'], ['program failure', 'exit']];
const NEG = [['naming convention', 'iso'], ['remove a job', 'iso']];

// --- diagnostics: why does each POS target score what it does (at a low theta to see all neighbors)?
const expLow = loadExpansion(BLOB, 0.50, 8);
console.log('=== POS target semanticCoverage (theta=0.50, discount=1) ===');
for (const [q, id] of POS) {
  const target = CORPUS.find((r) => r.id === id);
  const qTerms = [...new Set(meaningfulTokens(tokenize(q)))];
  const cov = semanticCoverage(qTerms, tokenize(target.content), expLow, 1);
  const bridges = qTerms.map((t) => `${t}->[${(expLow.get(t) ?? []).map((e) => e.token + ':' + e.w.toFixed(2)).join(',')}]`);
  console.log(`  "${q}" -> ${id}: lex=${cov.lexicalMatched} sem=${cov.semanticWeight.toFixed(3)} | ${bridges.join('  ')}`);
}

// --- sweep ---
const THETAS = [0.50, 0.52, 0.55, 0.58, 0.60];
const GATES = [0.25, 0.30, 0.35, 0.40, 0.45];
const DISCS = [1.0, 0.9, 0.8];
console.log('\n=== frontier (combos with 0 NEG violations, sorted by POS recovered) ===');
const rows = [];
for (const theta of THETAS) for (const gate of GATES) for (const disc of DISCS) {
  const exp = loadExpansion(BLOB, theta, 8);
  const opts = { expansion: exp, semDiscount: disc, semGate: gate };
  const posOk = POS.filter(([q, id]) => rankRecords(CORPUS, q, opts).map((r) => r.id).includes(id)).length;
  const negBad = NEG.filter(([q, id]) => rankRecords(CORPUS, q, opts).map((r) => r.id).includes(id)).length;
  rows.push({ theta, gate, disc, posOk, negBad });
}
rows.filter((r) => r.negBad === 0).sort((a, b) => b.posOk - a.posOk || b.gate - a.gate || b.theta - a.theta)
  .slice(0, 12).forEach((r) => console.log(`  theta=${r.theta} gate=${r.gate} disc=${r.disc} -> POS ${r.posOk}/${POS.length} NEG ${r.negBad}`));
