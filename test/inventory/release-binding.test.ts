// `verdict-ledger.ts` guards two reference directions and, until this file existed, not the third.
// `validateLedger` refuses a ledger holding rows from two candidates, and `danglingClaims` refuses a
// row whose `claimId` names no live document block — its own comment says why: a `claimId` "is only a
// string and nothing dereferences it".
//
// A row's `candidate` is likewise only a string, and nothing dereferenced it either. Measured
// 2026-09-02: every row in the committed ledger was bound to a candidate 111 commits behind HEAD
// whose shipped bundle differs from the one on disk, and no check anywhere emitted a signal. The
// run-sheet's rule is written about BYTES — "There is no sound bookkeeping technique for carrying a
// row across changed bundle bytes" — so the comparison target is the immutable candidate receipt and
// the artifact digests it recorded, never the moving branch head.
//
// Second hole, also measured that day: deleting the three unevidenced rows flipped `gatePasses` from
// false to TRUE. The gate pins no expected row set, so it opens by deletion — "a case that should
// have run but did not, counted toward the pass total, leaves its absence invisible in the verdict
// table" is exactly what the run-sheet forbids.
//
// These cases are synthetic on purpose. They pin the FUNCTIONS, and they stay green while the real
// ledger is stale; reporting the real ledger's state is the release preflight's job, not the unit
// suite's.
import { describe, it, expect } from 'vitest';
import {
  staleBinding, missingRows, type VerdictRow, type ReleaseBinding,
} from '../../scripts/inventory/verdict-ledger.js';

const CAND = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function row(over: Partial<VerdictRow> = {}): VerdictRow {
  return {
    rowId: 'r1', surfaceItem: 'tool:x', claimId: 'README.md#0123456789ab', verdict: 'MET',
    repairTarget: null, evidence: 'A1 suite', candidate: CAND, securityBoundary: false, ...over,
  };
}

function binding(over: Partial<ReleaseBinding> = {}): ReleaseBinding {
  return {
    receiptCandidate: CAND,
    receiptArtifacts: { 'bin/helix-mcp.mjs': 'dead'.repeat(16) },
    liveArtifacts: { 'bin/helix-mcp.mjs': 'dead'.repeat(16) },
    ...over,
  };
}

describe('staleBinding', () => {
  it('is silent when every row names the receipt candidate and every artifact still matches', () => {
    expect(staleBinding([row(), row({ rowId: 'r2' })], binding())).toEqual([]);
  });

  it('reports a row bound to a candidate the receipt does not name', () => {
    const problems = staleBinding([row(), row({ rowId: 'r2', candidate: OTHER })], binding());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('r2');
    expect(problems[0]).toContain(OTHER);
  });

  // The absence of an observation, not a second candidate: `validateLedger` already rules that a MET
  // row must carry one, and an honest in-progress ledger always holds rows that carry none.
  it('passes over a row that carries no observation', () => {
    expect(staleBinding([row({ rowId: 'r2', verdict: 'UNEVIDENCED', evidence: null, candidate: null })], binding()))
      .toEqual([]);
  });

  // The load-bearing half. Certification-only commits move HEAD without moving the receipt, so HEAD is
  // not the comparison target; what invalidates an observation is the artifact it was made against
  // changing underneath it.
  it('reports an artifact whose bytes no longer match what the receipt recorded', () => {
    const problems = staleBinding([row()], binding({
      liveArtifacts: { 'bin/helix-mcp.mjs': 'beef'.repeat(16) },
    }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('bin/helix-mcp.mjs');
  });

  // A path the receipt pins but nobody hashed is an unmeasured artifact, and counting it as matching
  // is the silent skip the run-sheet names.
  it('reports an artifact the receipt names that was never measured', () => {
    const problems = staleBinding([row()], binding({ liveArtifacts: {} }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('bin/helix-mcp.mjs');
  });

  // Bundle equality must not excuse a different candidate: the rule requires exact candidate binding,
  // and a matching artifact is an additional requirement rather than a substitute for it.
  it('still reports a mismatched candidate when every artifact matches', () => {
    expect(staleBinding([row({ candidate: OTHER })], binding())).not.toEqual([]);
  });
});

describe('missingRows', () => {
  it('is silent when the ledger holds every expected row', () => {
    expect(missingRows([row(), row({ rowId: 'r2' })], ['r1', 'r2'])).toEqual([]);
  });

  // The measured hole: dropping an unrun row leaves `rows.every(MET)` true over a smaller table.
  it('reports an expected row that has been dropped from the ledger', () => {
    const problems = missingRows([row()], ['r1', 'r2']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('r2');
  });

  // Nothing to compare against is itself a finding: silence would read as "no row is missing".
  it('reports that a deleted row cannot be detected when no inventory is pinned', () => {
    const problems = missingRows([row()], []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no expected row inventory/i);
  });
});
