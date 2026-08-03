// Freeze-window guard for the v2 pilot (spec: the Phase-WS design, local operating doc).
//
// HARD (exit 1):
//   1. receipt payload integrity — sha256Hex(JSON.stringify(payload)) === payloadSha256,
//      byte-for-byte the issuer's own computation (freeze-receipt.ts), so a mismatch is
//      tampering, never a serializer disagreement;
//   2. the candidate commit exists in this repository;
//   3. ANCHOR equality — every payload.tools path re-hashed from the CANDIDATE COMMIT's
//      blob (git ls-tree), every payload.methodDocs path re-hashed from the candidate
//      commit's content bytes (git show | sha256). History rewrite or receipt edit → red.
// WARN-ONLY (exit 0): before payload.txClose, working-tree divergence from the pins is
//   listed as ::warning:: lines. Undeployed repo work during the window is legitimate;
//   the close chain runs from the candidate commit, not from this tree.
// OUT OF SCOPE (declared, not silent): payload.config / payload.runtime — deploy-machine
//   state, not derivable from the repository.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Bytes, sha256Hex, gitHashObject } from './pilot/pin-hashes.js';

export interface GuardReport { ok: boolean; failures: string[]; warnings: string[]; notes: string[] }

const git = (root: string, args: string[]): Buffer =>
  execFileSync('git', ['-C', root, ...args], { maxBuffer: 1 << 26 });

const lsTreeBlobSha = (root: string, commit: string, path: string): string | null => {
  const out = git(root, ['ls-tree', commit, '--', path]).toString('utf8').trim();
  if (!out) return null;
  const m = /^\d{6} blob ([0-9a-f]{40,64})\t/.exec(out);
  return m && m[1] ? m[1] : null;
};

export function runFreezeGuard(receiptPath: string, repoRoot: string, nowIso?: string): GuardReport {
  const failures: string[] = []; const warnings: string[] = []; const notes: string[] = [];
  const doc = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
    payloadSha256: string;
    payload: {
      candidateCommit: string; txClose: string;
      tools: Record<string, string>; methodDocs: Record<string, string>;
      config: unknown; runtime: unknown;
    };
  };
  const p = doc.payload;

  if (sha256Hex(JSON.stringify(p)) !== doc.payloadSha256) {
    failures.push('payload-sha256: receipt payload does not hash to its own payloadSha256');
  }
  try {
    git(repoRoot, ['cat-file', '-e', `${p.candidateCommit}^{commit}`]);
  } catch {
    failures.push(`candidate-commit: ${p.candidateCommit} is not a commit in this repository`);
  }

  if (failures.length === 0) {
    for (const [path, want] of Object.entries(p.tools)) {
      const got = lsTreeBlobSha(repoRoot, p.candidateCommit, path);
      if (got !== want) failures.push(`anchor: ${path} — candidate blob ${got ?? 'absent'} != receipt ${want}`);
    }
    for (const [path, want] of Object.entries(p.methodDocs)) {
      let got: string | null = null;
      try { got = sha256Bytes(git(repoRoot, ['show', `${p.candidateCommit}:${path}`])); } catch { /* absent */ }
      if (got !== want) failures.push(`anchor: ${path} — candidate sha256 ${got ?? 'absent'} != receipt ${want}`);
    }
  }

  const now = nowIso ?? new Date().toISOString();
  if (now <= p.txClose) {
    for (const [path, want] of Object.entries(p.tools)) {
      const f = join(repoRoot, path);
      const got = existsSync(f) ? gitHashObject(readFileSync(f)) : null;
      if (got !== want) warnings.push(`worktree diverges from pin (pre-close, informational): ${path}`);
    }
    for (const [path, want] of Object.entries(p.methodDocs)) {
      const f = join(repoRoot, path);
      const got = existsSync(f) ? sha256Bytes(readFileSync(f)) : null;
      if (got !== want) warnings.push(`worktree diverges from pin (pre-close, informational): ${path}`);
    }
  }

  notes.push('out of scope (deploy-machine state): payload.config sha256, payload.runtime identity');
  return { ok: failures.length === 0, failures, warnings, notes };
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  const root = process.cwd();
  const r = runFreezeGuard(join(root, 'docs/release/v2-freeze-receipt-2026-08.json'), root);
  for (const w of r.warnings) console.log(`::warning::${w}`);
  for (const n of r.notes) console.log(`note: ${n}`);
  for (const f of r.failures) console.error(`FAIL ${f}`);
  console.log(r.ok ? 'freeze-guard: anchors verified' : 'freeze-guard: ANCHOR FAILURE');
  process.exit(r.ok ? 0 : 1);
}
