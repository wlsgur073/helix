// The release preflight. `gatePasses` had ZERO production callers — measured 2026-09-02 — so the
// certification gate ran only when a person remembered to reason about it, and the ledger drifted 111
// commits without a signal.
//
// This suite pins the preflight's LOGIC on fixtures and stays green. It deliberately does NOT assert
// that the committed ledger is stale today: an assertion that encodes a temporary invalid state as
// success has to be inverted by hand later, and passes for the wrong reason until someone remembers.
// Reporting the real state is what running the preflight does, and it is meant to fail while the
// release is uncertified — a blocked release is not the same thing as a broken development suite.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runCertifyGate } from '../../scripts/inventory/certify-gate.js';

const CAND = 'a'.repeat(40);

/** A repo root holding a receipt, a ledger and the artifacts the receipt pins. */
function fixture(opts: {
  bundleBytes: string;
  recordedSha?: string;
  rows?: unknown[];
  rowIds?: string[];
}): string {
  const root = mkdtempSync(join(tmpdir(), 'helix-certify-'));
  const artifact = 'bin/helix-mcp.mjs';
  const file = join(root, artifact);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, opts.bundleBytes);

  // sha256 of the bytes just written, unless the caller wants the receipt to disagree.
  const sha = opts.recordedSha ?? createHash('sha256').update(opts.bundleBytes).digest('hex');

  mkdirSync(join(root, 'docs/release'), { recursive: true });
  writeFileSync(join(root, 'docs/release/receipt.json'), JSON.stringify({
    payload: {
      candidateCommit: CAND,
      bundles: { [artifact]: sha },
      ...(opts.rowIds ? { rowIds: opts.rowIds } : {}),
    },
  }));

  mkdirSync(join(root, 'data/inventory'), { recursive: true });
  writeFileSync(join(root, 'data/inventory/verdicts.json'), JSON.stringify(opts.rows ?? [{
    rowId: 'r1', surfaceItem: 'tool:x', claimId: null, verdict: 'MET',
    repairTarget: null, evidence: 'A1 suite', candidate: CAND, securityBoundary: false,
  }]));
  return root;
}

function run(root: string): ReturnType<typeof runCertifyGate> {
  return runCertifyGate(join(root, 'docs/release/receipt.json'), join(root, 'data/inventory/verdicts.json'), root);
}

describe('runCertifyGate', () => {
  it('passes when every row names the receipt candidate, the artifact matches, and the inventory is complete', () => {
    const r = run(fixture({ bundleBytes: 'shipped bytes', rowIds: ['r1'] }));
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('fails when the artifact on disk is not the one the receipt recorded', () => {
    // The receipt pins the digest of different bytes than the ones written.
    const r = run(fixture({ bundleBytes: 'rebuilt bytes', recordedSha: 'f'.repeat(64), rowIds: ['r1'] }));
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toContain('bin/helix-mcp.mjs');
  });

  it('fails when a row is bound to a candidate the receipt does not name', () => {
    const r = run(fixture({
      bundleBytes: 'shipped bytes', rowIds: ['r1'],
      rows: [{
        rowId: 'r1', surfaceItem: 'tool:x', claimId: null, verdict: 'MET',
        repairTarget: null, evidence: 'A1 suite', candidate: 'c'.repeat(40), securityBoundary: false,
      }],
    }));
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toContain('r1');
  });

  // The hole Codex surfaced and measurement confirmed: `gatePasses` opens by DELETION, because it
  // only asks that the table be non-empty and every row MET.
  it('fails when an expected row has been deleted, even though every surviving row is MET', () => {
    const r = run(fixture({ bundleBytes: 'shipped bytes', rowIds: ['r1', 'r2'] }));
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toContain('r2');
  });

  // A receipt that pins no row inventory cannot detect a deletion, and saying nothing would read as
  // "no row is missing".
  it('fails when the receipt pins no expected row inventory at all', () => {
    const r = run(fixture({ bundleBytes: 'shipped bytes' }));
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toMatch(/no expected row inventory/i);
  });

  it('fails on a ledger that is unevidenced, even when everything else lines up', () => {
    const r = run(fixture({
      bundleBytes: 'shipped bytes', rowIds: ['r1'],
      rows: [{
        rowId: 'r1', surfaceItem: 'tool:x', claimId: null, verdict: 'UNEVIDENCED',
        repairTarget: null, evidence: null, candidate: null, securityBoundary: false,
      }],
    }));
    expect(r.ok).toBe(false);
  });
});
