// Producer AND verifier for docs/release/v0.1-candidate-receipt.json.
//
// Until 2026-09-02 that file was written by hand, re-written by hand at each cut, and checked by
// nothing. The run-sheet's whole instruction for a moved candidate is "rewrite … against the new
// candidate", and the receipt names the bundles, the manifest and the claim set that every
// certification observation is bound to. A sealed artifact with no producer drifts, and a seal with
// no verifier is decoration.
//
// THE SEALING CONVENTION IS NOT THE FREEZE RECEIPT'S, and the difference is the trap this module
// exists to remove. docs/release/v2-freeze-receipt-2026-08.json seals with
// `sha256(JSON.stringify(payload))` — insertion order — and scripts/freeze-guard.ts verifies exactly
// that. The v0.1 candidate receipt seals CANONICALLY: the same hash over a key-sorted payload.
// Measured against the committed file, only the canonical form reproduces its recorded
// `payloadSha256`. Reach for the other formula and a sound receipt reads as tampered.
//
// Object keys are sorted; ARRAYS ARE NOT. A reordered `rowIds` is a different inventory, and
// canonicalising it away would let a reordered ledger seal as unchanged.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface CandidatePayload {
  artifactKind: 'v0.1-release-candidate';
  candidateCommit: string;
  treeShaAtCut: string;
  cutAt: string;
  /** Shipped bundle path -> sha256. Enumerated from bin/, never hand-listed: a new CLI that nobody
   *  added to a literal list would otherwise ship unpinned. */
  bundles: Record<string, string>;
  manifest: Record<string, string>;
  claimSet: Record<string, string>;
  /** The row ids this candidate is certified over. The release preflight compares the ledger against
   *  it, because `gatePasses` opens by DELETION without an inventory it does not control. */
  rowIds: string[];
  gateAtCut: Record<string, unknown>;
}

export interface CandidateReceipt {
  payload: CandidatePayload;
  payloadSha256: string;
}

/** Deep key sort; array order is content and is preserved. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort()
      .map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export function canonicalPayloadSha256(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(payload)), 'utf8').digest('hex');
}

export function composeCandidateReceipt(payload: CandidatePayload): CandidateReceipt {
  return { payload, payloadSha256: canonicalPayloadSha256(payload) };
}

/** Everything a reader can check without leaving the file, plus the two structural requirements the
 *  release preflight depends on. Returns problems, empty when sound. */
export function verifyCandidateReceipt(doc: unknown): string[] {
  const problems: string[] = [];
  const d = doc as Partial<CandidateReceipt>;
  if (!d || typeof d !== 'object' || !d.payload || typeof d.payloadSha256 !== 'string') {
    return ['shape: expected an object carrying `payload` and a string `payloadSha256`'];
  }
  const p = d.payload;
  if (canonicalPayloadSha256(p) !== d.payloadSha256) {
    problems.push('payload-sha256: payload does not hash to its own payloadSha256 under the canonical (key-sorted) convention');
  }
  if (p.artifactKind !== 'v0.1-release-candidate') {
    problems.push(`artifactKind: expected 'v0.1-release-candidate', found ${JSON.stringify(p.artifactKind)}`);
  }
  if (!Array.isArray(p.rowIds) || p.rowIds.length === 0) {
    problems.push('rowIds: the receipt carries no row inventory, so a deleted verdict row would be undetectable');
  }
  for (const k of ['bundles', 'manifest', 'claimSet'] as const) {
    if (!p[k] || Object.keys(p[k]).length === 0) problems.push(`${k}: no artifact is pinned`);
  }
  return problems;
}

const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

/** Every `.mjs` under bin/, relative and posix-separated, sorted. */
function shippedBundles(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.mjs')) out.push(posix.join(...relative(repoRoot, f).split(/[\\/]/)));
    }
  };
  walk(join(repoRoot, 'bin'));
  return out.sort();
}

const MANIFEST_PATHS = ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'hooks/hooks.json'];
const CLAIMSET_PATHS = ['data/inventory/surface.json', 'data/inventory/claims.json'];

const hashAll = (repoRoot: string, paths: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const p of paths) {
    const f = join(repoRoot, p);
    if (!existsSync(f)) throw new Error(`cut-candidate: pinned path is missing: ${p}`);
    out[p] = sha256File(f);
  }
  return out;
};

const git = (repoRoot: string, args: string[]): string =>
  execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();

export function buildCandidatePayload(repoRoot: string, cutAt: string, gateAtCut: Record<string, unknown>): CandidatePayload {
  const rows = JSON.parse(readFileSync(join(repoRoot, 'data/inventory/verdicts.json'), 'utf8')) as Array<{ rowId: string }>;
  return {
    artifactKind: 'v0.1-release-candidate',
    candidateCommit: git(repoRoot, ['rev-parse', 'HEAD']),
    treeShaAtCut: git(repoRoot, ['rev-parse', 'HEAD^{tree}']).slice(0, 12),
    cutAt,
    bundles: hashAll(repoRoot, shippedBundles(repoRoot)),
    manifest: hashAll(repoRoot, MANIFEST_PATHS),
    claimSet: hashAll(repoRoot, CLAIMSET_PATHS),
    rowIds: rows.map((r) => r.rowId),
    gateAtCut,
  };
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  const root = process.cwd();
  const dirty = git(root, ['status', '--porcelain']);
  if (dirty.length > 0 && !process.argv.includes('--allow-dirty')) {
    console.error('FAIL cut-candidate: the working tree is not clean. A candidate cut from a dirty tree pins bytes no commit carries.');
    console.error(dirty);
    process.exit(1);
  }
  const payload = buildCandidatePayload(root, new Date().toISOString(), {
    typecheck: 'run npm run typecheck and record its exit',
    suite: 'run npm test and record its summary line',
    note: 'gateAtCut is filled by the operator from the run that accompanied this cut',
  });
  const receipt = composeCandidateReceipt(payload);
  const problems = verifyCandidateReceipt(receipt);
  for (const p of problems) console.error(`FAIL ${p}`);
  if (problems.length > 0) process.exit(1);
  const out = join(root, 'docs/release/v0.1-candidate-receipt.json');
  writeFileSync(out, `${JSON.stringify(receipt, null, 1)}\n`);
  console.log(`cut-candidate: wrote ${out}`);
  console.log(`  candidate ${payload.candidateCommit}`);
  console.log(`  ${Object.keys(payload.bundles).length} bundles, ${Object.keys(payload.manifest).length} manifest, ${Object.keys(payload.claimSet).length} claim-set, ${payload.rowIds.length} rows`);
  console.log('  gateAtCut is a PLACEHOLDER — fill it from the run that accompanied this cut, then re-seal.');
}
