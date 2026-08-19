import { describe, it, expect } from 'vitest';
import { validateLedger, gatePasses, type VerdictRow } from '../../scripts/inventory/verdict-ledger.js';

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

  it('rejects an UNDOCUMENTED row that names a claim', () => {
    expect(validateLedger([row({ verdict: 'UNDOCUMENTED' })]))
      .toContain('r1: UNDOCUMENTED must not name a claim');
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
    // 행이 없는 원장이 통과하면 인벤토리 미완성이 통과로 집계된다.
    expect(gatePasses([])).toBe(false);
  });

  // `gatePasses`의 `validateLedger` 연동 분기를 고립시키는 유일한 사례이다. 이 행은
  // verdict가 `MET`이므로 `.every(r => r.verdict === 'MET')`만 보는 구현에서는 통과한다.
  // 이 사례가 없으면 그 분기를 통째로 삭제해도 나머지 테스트가 전부 초록색으로 남는다.
  it('blocks a row whose verdict is MET but whose schema is incomplete', () => {
    expect(gatePasses([row({ evidence: null })])).toBe(false);
  });
});
