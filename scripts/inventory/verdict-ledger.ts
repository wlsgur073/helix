// The verdict ledger's schema and its gate, fixed in code rather than left to a document.
export type Verdict = 'MET' | 'FAILED' | 'UNEVIDENCED' | 'UNFALSIFIABLE' | 'UNDOCUMENTED';
export type RepairTarget = 'documentation' | 'code' | 'both';

export interface VerdictRow {
  rowId: string;
  surfaceItem: string;
  claimId: string | null;
  verdict: Verdict;
  repairTarget: RepairTarget | null;
  /** Where the evidence is: a test path and line for an automated pin, a receipt path for manual evidence. */
  evidence: string | null;
  /** The release candidate this observation is bound to. If the candidate moves, the row is STALE. */
  candidate: string | null;
  securityBoundary: boolean;
}

/**
 * Blank. The ledger is JSON filled in by hand, so a placeholder empty string and a whitespace-only
 * string are as realistic as `null`, and all three mean the same thing: no evidence. A bare
 * `=== null` check lets a row with `evidence: ""` through the gate. This repository has already
 * corrected one of these — `join(ROOT, '')` normalises to `ROOT`, so an empty hook bundle path
 * passed an existence check.
 */
const blank = (v: string | null): boolean => v === null || v.trim().length === 0;

export function validateLedger(rows: VerdictRow[]): string[] {
  const problems: string[] = [];
  for (const r of rows) {
    if (r.verdict === 'MET' && blank(r.evidence)) problems.push(`${r.rowId}: MET requires evidence`);
    if (r.verdict === 'MET' && blank(r.candidate)) problems.push(`${r.rowId}: MET requires a candidate binding`);
    if (r.verdict === 'FAILED' && r.repairTarget === null) problems.push(`${r.rowId}: FAILED requires a repairTarget`);
    if (r.verdict === 'UNDOCUMENTED' && r.claimId !== null) problems.push(`${r.rowId}: UNDOCUMENTED must not name a claim`);
  }
  // A property of the whole ledger, so it sits outside the row loop. Rows from two different
  // bundles must never share one verdict table, and no observation may carry across changed bundle
  // bytes. A per-row `candidate !== null` check would pass a ledger holding rows from one candidate
  // beside rows from its successor, deferring that judgement to release day.
  // Only rows that carry an observation are compared. `candidate` means "the candidate this
  // OBSERVATION is bound to", so the `null` on an `UNEVIDENCED` row is the absence of an
  // observation, not a second candidate. Counting null as a candidate would make every honest
  // ledger report a false problem before certification finishes, since such a ledger always holds
  // unevidenced rows. A row that has an observation but no candidate is already caught by the
  // per-row MET check above.
  const candidates = [...new Set(rows.map((r) => r.candidate).filter((c): c is string => c !== null))];
  if (candidates.length > 1) {
    problems.push(`ledger: rows are bound to more than one candidate (${[...candidates].sort().join(', ')})`);
  }
  return problems;
}

/**
 * Row ids whose `claimId` names no live document block.
 *
 * A block id is content-addressed, so any edit to the document rotates it and strands every verdict
 * bound to the old value — silently, because a `claimId` is only a string and nothing dereferences
 * it. `classify-docs` guards the opposite direction, refusing a block that no classification covers;
 * this guards the one it does not. A `claimId` of `null` is the absence of a claim, which
 * `validateLedger` already rules on, and not a reference that failed to resolve.
 */
export function danglingClaims(rows: VerdictRow[], live: ReadonlySet<string>): string[] {
  return rows
    .filter((r) => r.claimId !== null && !live.has(r.claimId))
    .map((r) => `${r.rowId}: claimId ${r.claimId ?? ''} resolves to no live block`);
}

/**
 * What an observation was made against: the IMMUTABLE candidate receipt, and the artifact digests it
 * recorded at the cut, beside the same paths hashed now.
 *
 * The comparison target is the receipt, never the branch head. HEAD advances for certification-only
 * commits that leave the shipped bundle untouched, and invalidating every row on that would make an
 * honest ledger unmaintainable; what invalidates an observation is the artifact it was made against
 * changing underneath it.
 */
export interface ReleaseBinding {
  /** `payload.candidateCommit` from the candidate receipt. */
  receiptCandidate: string;
  /** Artifact path -> sha256, as the receipt recorded it at the cut. */
  receiptArtifacts: Readonly<Record<string, string>>;
  /** The same paths hashed as they stand now. A path absent here was never measured. */
  liveArtifacts: Readonly<Record<string, string | undefined>>;
}

/**
 * Rows whose observation no longer describes the release, and artifacts that have moved under it.
 *
 * The third unguarded direction. `danglingClaims` above guards `claimId` -> live block because a
 * `claimId` "is only a string and nothing dereferences it"; a row's `candidate` is the same shape and
 * was dereferenced by nobody. Measured 2026-09-02: the committed ledger's every row named a candidate
 * 111 commits behind HEAD whose shipped bundle differed from the one on disk, and nothing anywhere
 * reported it.
 *
 * A `null` candidate is the ABSENCE of an observation, which `validateLedger` already rules on, so it
 * is passed over here rather than reported twice. A receipt-pinned artifact that was not hashed is
 * reported: treating an unmeasured path as matching is the silent skip the run-sheet forbids.
 *
 * Matching artifacts never excuse a mismatched candidate. The rule is exact candidate binding, and
 * artifact equality is an additional requirement rather than a substitute for it.
 */
export function staleBinding(rows: VerdictRow[], binding: ReleaseBinding): string[] {
  const problems: string[] = [];
  for (const r of rows) {
    if (r.candidate === null) continue;
    if (r.candidate !== binding.receiptCandidate) {
      problems.push(`${r.rowId}: observation is bound to ${r.candidate}, but the receipt names ${binding.receiptCandidate}`);
    }
  }
  for (const [path, recorded] of Object.entries(binding.receiptArtifacts)) {
    const live = binding.liveArtifacts[path];
    if (live === undefined) {
      problems.push(`artifact ${path}: pinned by the receipt but never measured`);
    } else if (live !== recorded) {
      problems.push(`artifact ${path}: the receipt recorded ${recorded}, the tree now holds ${live}`);
    }
  }
  return problems;
}

/**
 * Expected rows the ledger no longer holds.
 *
 * `gatePasses` asks only that the table be non-empty and every row MET, so it opens by DELETION:
 * measured 2026-09-02, dropping the three unevidenced rows from the committed ledger flipped it from
 * false to true over the 71 that remained. An expected-case inventory has to come from somewhere the
 * ledger does not control, which is why it is a parameter here rather than derived from `rows`.
 *
 * An EMPTY inventory is reported rather than passed. Silence would read as "no row is missing", when
 * what is true is that no row could have been found missing.
 */
export function missingRows(rows: VerdictRow[], expected: readonly string[]): string[] {
  if (expected.length === 0) {
    return ['ledger: no expected row inventory is pinned, so a deleted row cannot be detected'];
  }
  const present = new Set(rows.map((r) => r.rowId));
  return expected.filter((id) => !present.has(id)).map((id) => `ledger: expected row ${id} is not in the ledger`);
}

/**
 * The gate. A row's risk class does not change whether it passes — only what kind of evidence it
 * takes to get there. An empty ledger does not pass: no rows means the inventory is unfinished.
 */
export function gatePasses(rows: VerdictRow[]): boolean {
  if (rows.length === 0) return false;
  if (validateLedger(rows).length > 0) return false;
  return rows.every((r) => r.verdict === 'MET');
}
