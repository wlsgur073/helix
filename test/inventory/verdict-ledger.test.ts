import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLedger, gatePasses, danglingClaims, type VerdictRow } from '../../scripts/inventory/verdict-ledger.js';
import { parseBlocks, DOC_CORPUS } from '../../scripts/inventory/classify-docs.js';

const row = (over: Partial<VerdictRow> = {}): VerdictRow => ({
  rowId: 'r1', surfaceItem: 'tool:helix_memory_commit', claimId: 'README.md#abc123def456',
  verdict: 'MET', repairTarget: null, evidence: 'test/acceptance/bundle.e2e.test.ts:61',
  candidate: 'deadbeef', securityBoundary: false, ...over,
});

describe('verdict ledger validation', () => {
  it('accepts a complete MET row', () => {
    expect(validateLedger([row()])).toEqual([]);
  });

  it('rejects a MET row with no evidence', () => {
    expect(validateLedger([row({ evidence: null })])).toContain('r1: MET requires evidence');
  });

  it('rejects a MET row not bound to a candidate', () => {
    expect(validateLedger([row({ candidate: null })])).toContain('r1: MET requires a candidate binding');
  });

  it('rejects a FAILED row with no repair target', () => {
    expect(validateLedger([row({ verdict: 'FAILED', repairTarget: null })]))
      .toContain('r1: FAILED requires a repairTarget');
  });

  // The mixed-candidate check must compare only rows that carry an observation. `candidate` means
  // "the candidate this OBSERVATION is bound to", so the `null` on an `UNEVIDENCED` row is the
  // absence of an observation, not a second candidate. An honest ledger always holds such rows
  // until certification finishes, so counting null as a candidate reports a false problem every
  // time.
  it('does not read an absent observation as a second candidate', () => {
    expect(validateLedger([
      row(),
      row({ rowId: 'r2', verdict: 'UNEVIDENCED', evidence: null, candidate: null }),
    ])).toEqual([]);
  });

  it('still rejects rows bound to two different candidates', () => {
    expect(validateLedger([row(), row({ rowId: 'r2', candidate: 'cafebabe' })]))
      .toContain('ledger: rows are bound to more than one candidate (cafebabe, deadbeef)');
  });

  it('rejects an UNDOCUMENTED row that names a claim', () => {
    expect(validateLedger([row({ verdict: 'UNDOCUMENTED' })]))
      .toContain('r1: UNDOCUMENTED must not name a claim');
  });

  // The ledger is JSON filled in by hand, so a placeholder empty string is a realistic input, and a
  // check that only tests `=== null` accepts it as evidence. The two cases below trip that one rule
  // and nothing else.
  it('rejects a MET row whose evidence is an empty string', () => {
    expect(validateLedger([row({ evidence: '' })])).toEqual(['r1: MET requires evidence']);
  });

  it('rejects a MET row whose candidate binding is whitespace only', () => {
    expect(validateLedger([row({ candidate: '   ' })])).toEqual(['r1: MET requires a candidate binding']);
  });

  // Rows from two different bundles must never share one verdict table, and no observation may
  // carry across changed bundle bytes. A per-row `candidate !== null` check would let such a ledger
  // through.
  it('rejects a ledger whose rows are bound to two different candidates', () => {
    const mixed = [row(), row({ rowId: 'r2', candidate: 'cafebabe' })];
    expect(validateLedger(mixed))
      .toEqual(['ledger: rows are bound to more than one candidate (cafebabe, deadbeef)']);
  });

  it('accepts two rows bound to the same candidate', () => {
    expect(validateLedger([row(), row({ rowId: 'r2' })])).toEqual([]);
  });
});

// The gate is driven by a committed test. A one-off command pasted in by hand leaves whether it ran
// at all to someone's judgement, and then the suite stays green over a damaged ledger.
describe('the committed verdict ledger', () => {
  const VERDICTS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'inventory', 'verdicts.json');

  it('parses as an array of rows that raise no schema problem', () => {
    const rows = JSON.parse(readFileSync(VERDICTS_PATH, 'utf8')) as VerdictRow[];
    expect(Array.isArray(rows), 'data/inventory/verdicts.json is not a JSON array').toBe(true);
    expect(validateLedger(rows), 'the committed ledger carries a schema problem').toEqual([]);
    // `gatePasses` is `false` on an empty ledger, so no passing assertion can be made yet.
  });

  // The block id is content-addressed, so editing the document a claim lives in rotates the id and
  // strands every verdict bound to the old one — with no error anywhere, because a verdict row is
  // just a string. The opposite direction is already guarded: `classify-docs.test.ts` refuses a
  // block that no classification covers. This is the direction that was not, and it had already
  // gone wrong twice over on one block before the check existed.
  it('names no claim that has stopped resolving to a live block', () => {
    const rows = JSON.parse(readFileSync(VERDICTS_PATH, 'utf8')) as VerdictRow[];
    const live = new Set(DOC_CORPUS.flatMap((f) => parseBlocks(f).map((b) => b.id)));
    expect(danglingClaims(rows, live), 'a verdict is bound to a block that no longer exists').toEqual([]);
  });
});

describe('claim binding', () => {
  it('reports a row whose claim resolves to no live block', () => {
    const rows = [row({ rowId: 'r9', claimId: 'README.md#000000000000' })];
    expect(danglingClaims(rows, new Set(['README.md#abc123def456'])))
      .toEqual(['r9: claimId README.md#000000000000 resolves to no live block']);
  });

  // Negative control: without it the check above stays green even if the function always returns [].
  it('reports nothing when every claim resolves', () => {
    expect(danglingClaims([row()], new Set(['README.md#abc123def456']))).toEqual([]);
  });

  // An UNDOCUMENTED row carries `claimId: null` by rule, and absence of a claim is not a broken
  // reference. Reading null as an unresolvable id would make every honest UNDOCUMENTED row a defect.
  it('does not read an absent claim as a broken reference', () => {
    expect(danglingClaims([row({ verdict: 'UNDOCUMENTED', claimId: null })], new Set())).toEqual([]);
  });
});

describe('release gate', () => {
  it('passes only when every row is MET', () => {
    expect(gatePasses([row(), row({ rowId: 'r2' })])).toBe(true);
  });

  it('blocks on a convenience FAILED exactly as on a security FAILED', () => {
    const conv = [row({ verdict: 'FAILED', repairTarget: 'code', securityBoundary: false })];
    const sec = [row({ verdict: 'FAILED', repairTarget: 'code', securityBoundary: true })];
    expect(gatePasses(conv)).toBe(false);
    expect(gatePasses(sec)).toBe(false);
  });

  it('blocks on UNEVIDENCED, UNFALSIFIABLE and UNDOCUMENTED alike', () => {
    for (const v of ['UNEVIDENCED', 'UNFALSIFIABLE', 'UNDOCUMENTED'] as const) {
      const r = v === 'UNDOCUMENTED' ? row({ verdict: v, claimId: null }) : row({ verdict: v });
      expect(gatePasses([r]), `${v} did not block the gate`).toBe(false);
    }
  });

  it('an empty ledger does not pass the gate', () => {
    // If a ledger with no rows passed, an unfinished inventory would count as a pass.
    expect(gatePasses([])).toBe(false);
  });

  // The only case that isolates the branch where `gatePasses` consults `validateLedger`. This row's
  // verdict is `MET`, so an implementation that only checks `.every(r => r.verdict === 'MET')` lets
  // it pass. Without this case the whole branch could be deleted and every other test would stay
  // green.
  it('blocks a row whose verdict is MET but whose schema is incomplete', () => {
    expect(gatePasses([row({ evidence: null })])).toBe(false);
  });

  // Both rows are `MET`, so an implementation checking only `.every(r => r.verdict === 'MET')` lets
  // them pass. The `validateLedger` branch is the only thing that refuses the mixed candidates.
  it('blocks a ledger whose MET rows are bound to different candidates', () => {
    expect(gatePasses([row(), row({ rowId: 'r2', candidate: 'cafebabe' })])).toBe(false);
  });
});
