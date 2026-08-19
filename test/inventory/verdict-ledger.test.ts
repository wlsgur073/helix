import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  // 원장은 손으로 채우는 JSON이므로 자리표시자 빈 문자열은 현실적인 입력이다. `=== null`만
  // 보는 검사는 그것을 증거로 받아들인다. 아래 두 사례는 그 규칙 하나만 발동시킨다.
  it('rejects a MET row whose evidence is an empty string', () => {
    expect(validateLedger([row({ evidence: '' })])).toEqual(['r1: MET requires evidence']);
  });

  it('rejects a MET row whose candidate binding is whitespace only', () => {
    expect(validateLedger([row({ candidate: '   ' })])).toEqual(['r1: MET requires a candidate binding']);
  });

  // 설계 문서 4는 서로 다른 번들에서 나온 행이 한 판정표에 섞이는 상황을 배제하고, 7-1은
  // 이월을 금지한다. 행마다 `candidate !== null`만 보면 그 원장이 통과한다.
  it('rejects a ledger whose rows are bound to two different candidates', () => {
    const mixed = [row(), row({ rowId: 'r2', candidate: 'cafebabe' })];
    expect(validateLedger(mixed))
      .toEqual(['ledger: rows are bound to more than one candidate (cafebabe, deadbeef)']);
  });

  it('accepts two rows bound to the same candidate', () => {
    expect(validateLedger([row(), row({ rowId: 'r2' })])).toEqual([]);
  });
});

// 게이트를 커밋된 테스트로 구동한다. 손으로 붙여 넣는 일회성 명령은 실행 여부 자체가 판단에
// 맡겨지며, 그러면 원장이 손상되어도 스위트는 초록색이다.
describe('the committed verdict ledger', () => {
  const VERDICTS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'inventory', 'verdicts.json');

  it('parses as an array of rows that raise no schema problem', () => {
    const rows = JSON.parse(readFileSync(VERDICTS_PATH, 'utf8')) as VerdictRow[];
    expect(Array.isArray(rows), 'data/inventory/verdicts.json is not a JSON array').toBe(true);
    expect(validateLedger(rows), 'the committed ledger carries a schema problem').toEqual([]);
    // 빈 원장에서는 `gatePasses`가 `false`이므로 통과 단언은 아직 걸 수 없다.
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

  // 두 행 모두 `MET`이므로 `.every(r => r.verdict === 'MET')`만 보는 구현에서는 통과한다.
  // 후보 혼합을 막는 것은 `validateLedger` 연동 분기뿐이다.
  it('blocks a ledger whose MET rows are bound to different candidates', () => {
    expect(gatePasses([row(), row({ rowId: 'r2', candidate: 'cafebabe' })])).toBe(false);
  });
});
