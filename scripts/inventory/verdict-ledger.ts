// 판정 원장의 스키마와 게이트. 설계 문서 3.4와 6을 코드로 고정한다.
export type Verdict = 'MET' | 'FAILED' | 'UNEVIDENCED' | 'UNFALSIFIABLE' | 'UNDOCUMENTED';
export type RepairTarget = 'documentation' | 'code' | 'both';

export interface VerdictRow {
  rowId: string;
  surfaceItem: string;
  claimId: string | null;
  verdict: Verdict;
  repairTarget: RepairTarget | null;
  /** 증거의 위치. 자동 핀이면 테스트 경로와 행, 수기 증거면 영수증 경로. */
  evidence: string | null;
  /** 이 관측이 결속된 릴리스 후보의 식별자. 후보가 이동하면 행은 STALE이다. */
  candidate: string | null;
  securityBoundary: boolean;
}

export function validateLedger(rows: VerdictRow[]): string[] {
  const problems: string[] = [];
  for (const r of rows) {
    if (r.verdict === 'MET' && r.evidence === null) problems.push(`${r.rowId}: MET requires evidence`);
    if (r.verdict === 'MET' && r.candidate === null) problems.push(`${r.rowId}: MET requires a candidate binding`);
    if (r.verdict === 'FAILED' && r.repairTarget === null) problems.push(`${r.rowId}: FAILED requires a repairTarget`);
    if (r.verdict === 'UNDOCUMENTED' && r.claimId !== null) problems.push(`${r.rowId}: UNDOCUMENTED must not name a claim`);
  }
  return problems;
}

/**
 * 게이트. 위험 등급은 통과 여부를 바꾸지 않는다 — 요구되는 증거의 종류를 바꿀 뿐이다.
 * 빈 원장은 통과하지 않는다: 행이 없다는 것은 인벤토리가 완성되지 않았다는 뜻이다.
 */
export function gatePasses(rows: VerdictRow[]): boolean {
  if (rows.length === 0) return false;
  if (validateLedger(rows).length > 0) return false;
  return rows.every((r) => r.verdict === 'MET');
}
