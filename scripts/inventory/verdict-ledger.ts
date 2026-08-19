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

/**
 * 비어 있는 값. 원장은 손으로 채우는 JSON이므로 `null`뿐 아니라 자리표시자 빈 문자열과
 * 공백만 있는 문자열도 현실적인 입력이며, 셋 다 증거가 없다는 뜻이다. `=== null`만 보면
 * `evidence: ""`인 행이 게이트를 통과한다. 이 저장소는 같은 부류를 이미 한 번 교정하였다
 * (`join(ROOT, '')`가 `ROOT`로 정규화되어 빈 hook 번들 경로가 존재 검사를 통과한 건).
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
  // 원장 전체의 성질이므로 행 순회 밖에 둔다. 설계 문서 4는 서로 다른 번들에서 나온 행이 한
  // 판정표에 섞이는 상황을 원천적으로 배제한다고 적고, 7-1은 바뀐 번들 바이트를 가로지르는
  // 이월을 금지한다. 행마다 `candidate !== null`만 보면 Rₙ의 행과 Rₙ₊₁의 행이 섞인 원장이
  // 게이트를 통과하며, 그 판별이 릴리스 당일의 추가 판단으로 미뤄진다.
  const candidates = [...new Set(rows.map((r) => r.candidate))];
  if (candidates.length > 1) {
    const named = candidates.map((c) => c ?? 'null').sort();
    problems.push(`ledger: rows are bound to more than one candidate (${named.join(', ')})`);
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
