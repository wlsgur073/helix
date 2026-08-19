// 변이 검증: 검출 함수가 실제로 변이를 거부하는지. 변이를 거부하지 못하는 추출기는
// 인벤토리가 완전하다는 근거가 되지 못한다 (설계 문서 5.3).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SURFACE_PATH, type Surface } from '../../scripts/inventory/build-inventory.js';

// `keyof Surface`로 좁힌다: `Record<string, unknown[]>`는 문자열 인덱스 시그니처로 취급되어
// `noUncheckedIndexedAccess` 아래에서 `live.tools` 등 모든 프로퍼티 접근이 `unknown[] | undefined`가
// 된다. 다섯 필드로 한정하면 각 배열 원소는 여전히 `unknown`(변이 주입을 허용)이면서 배열
// 자체는 항상 존재가 보장된다.
const committed = (): Record<keyof Surface, unknown[]> => JSON.parse(readFileSync(SURFACE_PATH, 'utf8'));

describe('snapshot comparison rejects each mutation class', () => {
  it('detects a tenth tool', () => {
    const live = committed();
    live.tools = [...live.tools, { name: 'helix_memory_zzz', description: 'planted', inputSchema: {} }];
    expect(live).not.toEqual(committed());
  });

  it('detects a removed config leaf', () => {
    const live = committed();
    live.configLeaves = live.configLeaves.slice(1);
    expect(live).not.toEqual(committed());
  });

  it('detects an added environment variable', () => {
    const live = committed();
    live.envVars = [...live.envVars, { name: 'HELIX_PLANTED', readIn: ['bin/helix-mcp.mjs'] }];
    expect(live).not.toEqual(committed());
  });

  it('detects a changed hook timeout', () => {
    const live = committed();
    live.hooks = live.hooks.map((h, i) => (i === 0 ? { ...(h as object), timeout: 999 } : h));
    expect(live).not.toEqual(committed());
  });

  it('detects a changed CLI usage line', () => {
    const live = committed();
    live.clis = live.clis.map((c, i) => (i === 0 ? { ...(c as object), usage: 'planted' } : c));
    expect(live).not.toEqual(committed());
  });

  // 이 계획이 겨냥한 구체적 함정: DEFAULT_CONFIG만 훑으면 compaction 여섯 개가 누락된다.
  it('the committed snapshot actually carries the compaction leaves', () => {
    const paths = (committed().configLeaves as Array<{ path: string }>).map((l) => l.path);
    expect(paths.filter((p) => p.startsWith('compaction.')).length).toBe(6);
  });
});
