// `docs/release/v0.1-candidate-receipt.json` is a sha256-sealed artifact that, until this file
// existed, NOTHING produced and NOTHING verified. It was written by hand and re-written by hand at
// each cut, and the run-sheet's instruction for a moved candidate is the single word "rewrite".
//
// That left a trap, measured 2026-09-02. The v2 freeze receipt in the same directory seals with
// `sha256(JSON.stringify(payload))` — insertion order — and `scripts/freeze-guard.ts` verifies
// exactly that. The v0.1 candidate receipt seals with a CANONICAL serialization instead: the same
// hash over a key-sorted payload. Both files carry a field called `payloadSha256`, both hold a
// `payload`, and the two conventions disagree. Anyone reaching for the implemented, tested formula
// to check the v0.1 receipt gets a mismatch and concludes the seal is broken.
//
// So the convention is pinned here against the committed artifact, and a verifier ships beside the
// producer. A seal nobody can check is not a seal.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalPayloadSha256, composeCandidateReceipt, verifyCandidateReceipt,
  type CandidatePayload,
} from '../../scripts/inventory/cut-candidate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function payload(over: Partial<CandidatePayload> = {}): CandidatePayload {
  return {
    artifactKind: 'v0.1-release-candidate',
    candidateCommit: 'a'.repeat(40),
    treeShaAtCut: 'b'.repeat(12),
    cutAt: '2026-09-02T00:00:00.000Z',
    bundles: { 'bin/helix-mcp.mjs': 'c'.repeat(64) },
    manifest: { 'hooks/hooks.json': 'd'.repeat(64) },
    claimSet: { 'data/inventory/claims.json': 'e'.repeat(64) },
    rowIds: ['r001', 'r002'],
    gateAtCut: { typecheck: 'exit 0', suite: '2551 passed' },
    ...over,
  };
}

describe('canonicalPayloadSha256', () => {
  // The whole point of canonicalising: two payloads that differ only in key ORDER are the same
  // document, and must seal identically. A plain JSON.stringify does not have this property, which
  // is why the two receipts in docs/release disagree.
  it('is unchanged when the same fields are inserted in a different order', () => {
    const a = { artifactKind: 'x', candidateCommit: 'y', bundles: { p: '1', q: '2' } };
    const b = { bundles: { q: '2', p: '1' }, candidateCommit: 'y', artifactKind: 'x' };
    expect(canonicalPayloadSha256(a)).toBe(canonicalPayloadSha256(b));
  });

  it('changes when any value changes', () => {
    expect(canonicalPayloadSha256(payload())).not.toBe(canonicalPayloadSha256(payload({ cutAt: '2026-09-03T00:00:00.000Z' })));
  });

  // Array order IS content — a rowIds list in a different order is a different inventory, and
  // sorting it away would let a reordered ledger seal as unchanged.
  it('changes when an array is reordered', () => {
    expect(canonicalPayloadSha256(payload({ rowIds: ['r001', 'r002'] })))
      .not.toBe(canonicalPayloadSha256(payload({ rowIds: ['r002', 'r001'] })));
  });
});

describe('composeCandidateReceipt / verifyCandidateReceipt', () => {
  it('seals a payload so its own verifier accepts it', () => {
    expect(verifyCandidateReceipt(composeCandidateReceipt(payload()))).toEqual([]);
  });

  it('reports a payload edited after sealing', () => {
    const doc = composeCandidateReceipt(payload());
    (doc.payload as CandidatePayload).candidateCommit = 'f'.repeat(40);
    expect(verifyCandidateReceipt(doc).join(' ')).toContain('payload-sha256');
  });

  // The gap this whole file closes: the receipt must carry the row inventory the release preflight
  // compares the ledger against, because without it a deleted row is undetectable.
  it('refuses a receipt that carries no row inventory', () => {
    const doc = composeCandidateReceipt(payload({ rowIds: [] }));
    expect(verifyCandidateReceipt(doc).join(' ')).toMatch(/rowIds/i);
  });

  it('refuses a receipt whose artifactKind is not the v0.1 candidate kind', () => {
    const doc = composeCandidateReceipt(payload({ artifactKind: 'something-else' as CandidatePayload['artifactKind'] }));
    expect(verifyCandidateReceipt(doc).join(' ')).toMatch(/artifactKind/i);
  });
});

describe('the committed candidate receipt', () => {
  // Pins the convention against the real artifact. Written to FAIL if anyone re-seals that file with
  // the v2 freeze receipt's insertion-order formula, which is the mistake the two conventions invite.
  it('verifies under the canonical convention this module implements', () => {
    const doc = JSON.parse(readFileSync(join(ROOT, 'docs/release/v0.1-candidate-receipt.json'), 'utf8')) as
      { payload: Record<string, unknown>; payloadSha256: string };
    expect(canonicalPayloadSha256(doc.payload), 'the committed receipt no longer matches its own seal')
      .toBe(doc.payloadSha256);
  });
});
