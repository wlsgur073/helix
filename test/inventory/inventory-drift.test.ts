// 커밋된 스냅샷과 실시간 회수가 어긋나면 실패한다. 열 번째 도구, 새 설정 leaf, 새 환경변수,
// 새 hook, 새 CLI 플래그가 추가되면 이 테스트가 그것을 알린다.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSurface, SURFACE_PATH } from '../../scripts/inventory/build-inventory.js';

describe('surface snapshot', () => {
  it('matches the committed snapshot exactly', async () => {
    const live = await buildSurface();
    const committed = JSON.parse(readFileSync(SURFACE_PATH, 'utf8'));
    expect(live, 'the shipped surface drifted from data/inventory/surface.json — run `npm run inventory`').toEqual(committed);
  }, 90_000);

  it('the snapshot is non-trivial in every class', () => {
    const s = JSON.parse(readFileSync(SURFACE_PATH, 'utf8'));
    expect(s.tools.length).toBeGreaterThan(1);
    expect(s.configLeaves.length).toBeGreaterThan(1);
    expect(s.envVars.length).toBeGreaterThan(1);
    expect(s.hooks.length).toBe(2);
    expect(s.clis.length).toBe(2);
  });
});
