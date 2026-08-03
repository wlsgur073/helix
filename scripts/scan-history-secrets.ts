// Whole-history credential scan using Helix's own detector (no external dep).
// Walks every unique blob across all refs — enumerated by walking every unique commit
// tree, so a blob is matched against every path it ever lived at, not just one arbitrary
// path — and runs findSecrets over it, reporting NAMED (high-confidence) hits by kind +
// blob + path — never the secret value.
// Usage: npx tsx scripts/scan-history-secrets.ts
// Note: Helix's pattern set (~12 providers + generic assignment) is narrower than a
// purpose-built secret scanner; treat a broader-ruleset scanner as a CI fast-follow.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { findSecrets } from '../src/memory/secret-scan.js';

// Known-safe values that are intentionally present (GitHub-allowlisted example key).
const KNOWN_SAFE = /AKIAIOSFODNN7EXAMPLE/;

// Paths whose "hits" are by-design, never real credentials:
//  - test/**            : the detector's own test fixtures (example secret shapes)
//  - the detector source: its pattern/keyword string literals self-match
//  - bin/**             : built bundles, derived from the (scanned) src/ tree
//  - smoke-secret-probe : a diagnostic that hardcodes a prose "pass:" string to
//                         demonstrate the secret-assignment false positive
// Fixed: a blob that lived at BOTH an allowlisted path and a real path used to be
// silently skipped whole, because the old enumeration (`git rev-list --all --objects`)
// records only ONE arbitrary path per blob. `enumerateBlobPaths` now walks every unique
// commit tree and keeps every path a blob was ever found at, so the blob is scanned (and
// reported under its non-allowlisted path) as long as any one of its paths isn't
// allowlisted.
// Residual limitation: a blob is still skipped whole — not just the benign span — when
// EVERY path it ever lived at is allowlisted (e.g. a real secret hard-coded directly into
// a test fixture, the detector source, or the smoke probe). Those files are reviewed by
// hand; a purpose-built secret scanner with a broader ruleset is recommended as a CI
// fast-follow.
const ALLOWLIST_PATHS: RegExp[] = [
  /^test\//,
  /^src\/memory\/secret-scan\.ts$/,
  /^src\/risk\/trifecta\.ts$/,
  /^bin\//,
  /^scripts\/smoke-secret-probe\.ts$/,
  // docs/release/audit-2026-07.md quotes the detector's own PEM pattern in prose while
  // DOCUMENTING it; exact path only — a future real secret under docs/ must stay red.
  /^docs\/release\/audit-2026-07\.md$/,
];

export interface SecretHitRecord {
  kind: string;
  sha: string;
  path: string;
}

// blob sha -> every path it was ever recorded under, across every unique tree reachable
// from any ref. Walks each unique ROOT tree (one per distinct commit tree, deduped) with
// `git ls-tree -r`, so a blob that ever lived at two different paths — one allowlisted,
// one real — is recorded under BOTH, unlike `git rev-list --all --objects`, which dedups
// by blob sha and keeps only the first path its traversal happens to visit.
export function enumerateBlobPaths(repoRoot: string): Map<string, string[]> {
  const raw = execFileSync('git', ['-C', repoRoot, 'log', '--all', '--format=%T'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  const map = new Map<string, string[]>();
  for (const tree of new Set(raw.split('\n').filter(Boolean))) {
    // unique ROOT trees only
    const out = execFileSync('git', ['-C', repoRoot, 'ls-tree', '-r', '-z', tree], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
    for (const rec of out.split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      const parts = rec.slice(0, tab).split(/\s+/);
      const type = parts[1];
      const sha = parts[2];
      if (type !== 'blob' || !sha) continue;
      const path = rec.slice(tab + 1);
      const arr = map.get(sha);
      if (arr) {
        if (!arr.includes(path)) arr.push(path);
      } else {
        map.set(sha, [path]);
      }
    }
  }
  return map;
}

function runScan(repoRoot: string): { hits: SecretHitRecord[]; scanned: number; blobCount: number } {
  const blobs = enumerateBlobPaths(repoRoot);
  let scanned = 0;
  const hits: SecretHitRecord[] = [];
  for (const [sha, paths] of blobs) {
    if (paths.every((p) => ALLOWLIST_PATHS.some((re) => re.test(p)))) continue;
    const path = paths.find((p) => !ALLOWLIST_PATHS.some((re) => re.test(p)))!;
    let content: string;
    try {
      content = execFileSync('git', ['-C', repoRoot, 'cat-file', '-p', sha], {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      });
    } catch {
      continue; // defensive: object vanished/corrupted between enumeration and read
    }
    scanned++;
    for (const s of findSecrets(content).filter((sp) => sp.tier === 'named')) {
      if (KNOWN_SAFE.test(content.slice(s.start, s.end))) continue;
      hits.push({ kind: s.kind, sha, path });
    }
  }
  return { hits, scanned, blobCount: blobs.size };
}

export function scanRepo(repoRoot: string): SecretHitRecord[] {
  return runScan(repoRoot).hits;
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  const { hits, scanned, blobCount } = runScan(process.cwd());
  if (blobCount === 0) {
    // A vacuous scan (no blob enumerated across any ref) must not read as a clean scan —
    // it means the enumeration itself is broken (wrong cwd, no refs, a swallowed git
    // failure), and "0 hits" would otherwise look identical to a real, clean sweep.
    console.error('FAIL: enumeration found 0 blobs across all refs — refusing to report a clean scan for a scan that never ran.');
    process.exit(1);
  }
  for (const h of hits) console.log(`HIT ${h.kind} | blob ${h.sha.slice(0, 10)} | ${h.path}`);
  console.log(`\nscanned ${scanned} unique blobs across all refs; ${hits.length} named hit(s) after allowlist`);
  process.exit(hits.length === 0 ? 0 : 1);
}
