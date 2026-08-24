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
 * The gate. A row's risk class does not change whether it passes — only what kind of evidence it
 * takes to get there. An empty ledger does not pass: no rows means the inventory is unfinished.
 */
export function gatePasses(rows: VerdictRow[]): boolean {
  if (rows.length === 0) return false;
  if (validateLedger(rows).length > 0) return false;
  return rows.every((r) => r.verdict === 'MET');
}
