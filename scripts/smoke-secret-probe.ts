// Offline diagnostic: run the real secret detector over a text file (and a root-cause snippet)
// to find what the egress secret leg (classifyEgress -> findSecrets) flags. No quota, no egress.
// Usage: npx tsx scripts/smoke-secret-probe.ts [path-to-text-file]
import { readFileSync } from 'node:fs';
import { findSecrets } from '../src/memory/secret-scan.js';

function report(label: string, text: string): void {
  const spans = findSecrets(text);
  const named = spans.filter((s) => s.tier === 'named');
  console.log(`\n=== ${label} === spans=${spans.length} named=${named.length}`);
  for (const s of spans) {
    const ctx = text.slice(Math.max(0, s.start - 25), s.end + 25).replace(/\s+/g, ' ');
    console.log(`  [${s.tier}] ${s.kind} "${text.slice(s.start, s.end)}" | ctx: …${ctx}…`);
  }
  console.log(named.length ? '  -> WOULD BLOCK (egress secret leg, override-proof)' : '  -> clean (passes secret leg)');
}

// Root-cause demo: the English word "pass" + a colon matches secret-assignment,
// because pass(word)? makes the "word" suffix optional.
report('snippet: prose "pass:"', 'R5 README first-impression pass: install steps (requires Node>=20)');

const path = process.argv[2];
if (path) report(`payload file: ${path}`, readFileSync(path, 'utf8'));
