// The release preflight — the unavoidable path that runs the certification gate.
//
// `gatePasses` existed for weeks with ZERO production callers: only its own definition and one test
// mentioned it, and that test says in terms that no passing assertion can be made yet. A gate nothing
// calls runs only when a person remembers to reason about it, and on 2026-09-02 the measurement was
// that nobody had: every row of the committed ledger was bound to a candidate 111 commits behind
// HEAD, whose shipped bundle differs from the one on disk, with no signal anywhere.
//
// This is deliberately NOT a vitest case. The run-sheet requires the RELEASE to stay blocked while it
// is uncertified; it does not require the development suite to be red. Those are different failures
// with different audiences, and merging them trains readers to ignore the one that matters. The unit
// suite pins this file's logic on fixtures and stays green; running the preflight reports the real
// state, and today it correctly reports the release as uncertified.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validateLedger, gatePasses, staleBinding, missingRows,
  type VerdictRow, type ReleaseBinding,
} from './verdict-ledger.js';

export interface CertifyResult {
  ok: boolean;
  failures: string[];
  notes: string[];
}

interface ReceiptPayload {
  candidateCommit: string;
  bundles?: Record<string, string>;
  manifest?: Record<string, string>;
  claimSet?: Record<string, string>;
  /**
   * The row ids this candidate is certified over. Absent from receipts cut before 2026-09-02, and
   * `missingRows` reports that absence rather than passing over it: without an inventory the ledger
   * does not control, deleting an unrun row leaves `every(MET)` true over a smaller table.
   */
  rowIds?: string[];
}

const sha256File = (p: string): string | undefined =>
  existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : undefined;

export function runCertifyGate(receiptPath: string, verdictsPath: string, repoRoot: string): CertifyResult {
  const failures: string[] = [];
  const notes: string[] = [];

  const payload = (JSON.parse(readFileSync(receiptPath, 'utf8')) as { payload: ReceiptPayload }).payload;
  const rows = JSON.parse(readFileSync(verdictsPath, 'utf8')) as VerdictRow[];

  // Every artifact map the receipt carries, in one set. A receipt that pins a path it never hashes is
  // a receipt problem, and `staleBinding` reports the unmeasured path rather than passing over it.
  const receiptArtifacts: Record<string, string> = {
    ...(payload.bundles ?? {}), ...(payload.manifest ?? {}), ...(payload.claimSet ?? {}),
  };
  const liveArtifacts: Record<string, string | undefined> = {};
  for (const path of Object.keys(receiptArtifacts)) liveArtifacts[path] = sha256File(join(repoRoot, path));

  const binding: ReleaseBinding = { receiptCandidate: payload.candidateCommit, receiptArtifacts, liveArtifacts };

  failures.push(...validateLedger(rows));
  failures.push(...staleBinding(rows, binding));
  failures.push(...missingRows(rows, payload.rowIds ?? []));

  // Reported last so a reader sees WHY before the verdict. It is not itself a failure line when the
  // lines above already say what is wrong; a bare "the gate is closed" explains nothing.
  if (!gatePasses(rows)) {
    const nonMet = rows.filter((r) => r.verdict !== 'MET');
    failures.push(nonMet.length > 0
      ? `gate: ${nonMet.length} of ${rows.length} rows are not MET (${nonMet.map((r) => `${r.rowId}=${r.verdict}`).join(', ')})`
      : `gate: closed over ${rows.length} rows`);
  }

  notes.push(`receipt candidate ${payload.candidateCommit}; ${Object.keys(receiptArtifacts).length} artifacts pinned; ${rows.length} ledger rows`);
  notes.push('out of scope (deploy-machine state): installed plugin identity — the deploy runbook load-path check is its counterparty');

  return { ok: failures.length === 0, failures, notes };
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  const root = process.cwd();
  const r = runCertifyGate(
    join(root, 'docs/release/v0.1-candidate-receipt.json'),
    join(root, 'data/inventory/verdicts.json'),
    root,
  );
  for (const n of r.notes) console.log(`note: ${n}`);
  for (const f of r.failures) console.error(`FAIL ${f}`);
  console.log(r.ok ? 'certify-gate: the release is certified against its receipt' : 'certify-gate: THE RELEASE IS NOT CERTIFIED');
  process.exit(r.ok ? 0 : 1);
}
