// Whole-history credential scan using Helix's own detector (no external dep).
// Walks every unique blob across all refs and runs findSecrets over it, reporting
// NAMED (high-confidence) hits by kind + blob + path — never the secret value.
// Usage: npx tsx scripts/scan-history-secrets.ts
// Note: Helix's pattern set (~12 providers + generic assignment) is narrower than a
// purpose-built secret scanner; treat a broader-ruleset scanner as a CI fast-follow.
import { execFileSync } from 'node:child_process';
import { findSecrets } from '../src/memory/secret-scan.js';

// Known-safe values that are intentionally present (GitHub-allowlisted example key).
const KNOWN_SAFE = /AKIAIOSFODNN7EXAMPLE/;

// Paths whose "hits" are by-design, never real credentials:
//  - test/**            : the detector's own test fixtures (example secret shapes)
//  - the detector source: its pattern/keyword string literals self-match
//  - bin/**             : built bundles, derived from the (scanned) src/ tree
//  - smoke-secret-probe : a diagnostic that hardcodes a prose "pass:" string to
//                         demonstrate the secret-assignment false positive
// Limitation: a real secret hard-coded directly into a detector source file, a test
// fixture, or the smoke probe would be allowlisted — the WHOLE matching blob is skipped
// (before scanning), not just the benign span. Those files are reviewed by hand; a
// purpose-built secret scanner with a broader ruleset is recommended as a CI fast-follow.
const ALLOWLIST_PATHS: RegExp[] = [
  /^test\//,
  /^src\/memory\/secret-scan\.ts$/,
  /^src\/risk\/trifecta\.ts$/,
  /^bin\//,
  /^scripts\/smoke-secret-probe\.ts$/,
];

function listObjects(): Map<string, string> {
  const out = execFileSync('git', ['rev-list', '--all', '--objects'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  const blobs = new Map<string, string>(); // sha -> first path seen
  for (const line of out.split('\n')) {
    if (!line) continue;
    const i = line.indexOf(' ');
    if (i > 0) {
      const sha = line.slice(0, i);
      const path = line.slice(i + 1);
      if (!blobs.has(sha)) blobs.set(sha, path);
    }
  }
  return blobs;
}

const blobs = listObjects();
let scanned = 0;
const hits: string[] = [];
for (const [sha, path] of blobs) {
  if (ALLOWLIST_PATHS.some((re) => re.test(path))) continue;
  let content: string;
  try {
    content = execFileSync('git', ['cat-file', '-p', sha], { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch {
    continue; // non-blob (tree/commit) or unreadable
  }
  scanned++;
  for (const s of findSecrets(content).filter((sp) => sp.tier === 'named')) {
    if (KNOWN_SAFE.test(content.slice(s.start, s.end))) continue;
    hits.push(`HIT ${s.kind} | blob ${sha.slice(0, 10)} | ${path}`);
  }
}

for (const h of hits) console.log(h);
console.log(`\nscanned ${scanned} unique blobs across all refs; ${hits.length} named hit(s) after allowlist`);
process.exit(hits.length === 0 ? 0 : 1);
