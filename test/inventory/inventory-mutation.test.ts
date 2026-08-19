// 변이 검증 (설계 문서 5.3): 추출기가 주입된 변이를 실제로 회수하는지.
//
// 커밋된 스냅샷의 지역 사본을 변형하고 `not.toEqual`을 단언하는 형태로는 이것을 확인할 수
// 없다. 그 형태가 확인하는 것은 vitest의 `toEqual`이며, `buildSurface()`가 빈 배열만
// 반환하도록 망가져도 통과한다. 그래서 아래 첫 두 사례는 추출기를 **직접 호출하고**, 변이를
// 그 입력(번들의 임시 사본, fixture 디렉터리)에 주입하여 출력이 실제로 달라지는지 본다.
// 변이는 저장소 밖 임시 경로에만 존재하며 `bin/`과 생산 코드는 변형하지 않는다.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SURFACE_PATH, type Surface } from '../../scripts/inventory/build-inventory.js';
import { fromBundle, compareSurfaces } from '../../scripts/inventory/extract-tools.js';
import { extractEnvVars } from '../../scripts/inventory/extract-config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the extractors recover an injected mutation', () => {
  // 도구 표면. 배포 번들의 임시 사본에서 등록 이름 하나를 바꾸고, 추출기가 그 사본을 읽어
  // 바뀐 이름을 보고하는지 본다. 추출기가 상수를 반환한다면 이 사례는 실패한다.
  it('reports the planted tool name when the bundle it reads carries one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-mut-bundle-'));
    try {
      const mutated = join(dir, 'helix-mcp.mjs');
      const original = readFileSync(join(ROOT, 'bin', 'helix-mcp.mjs'), 'utf8');
      writeFileSync(mutated, original.replaceAll('helix_memory_commit', 'helix_memory_planted'));

      const shipped = await fromBundle();
      const planted = await fromBundle(mutated);

      // 음성 대조: 변이가 없는 쪽은 원래 이름을 보고하고, 자기 자신과는 어긋나지 않는다.
      expect(shipped.map((t) => t.name)).toContain('helix_memory_commit');
      expect(() => compareSurfaces(shipped, structuredClone(shipped))).not.toThrow();

      // 변이가 주입되면 추출기의 출력이 바뀌고, 비교기가 그것을 거부한다.
      expect(planted.map((t) => t.name)).toContain('helix_memory_planted');
      expect(planted.map((t) => t.name)).not.toContain('helix_memory_commit');
      expect(() => compareSurfaces(shipped, planted)).toThrow(/tool-surface-disagreement/);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 최선 노력 */ }
    }
  }, 90_000);

  // 환경변수. fixture 디렉터리에 심은 읽기를 추출기가 회수하는지 본다. 대조군은 같은
  // 디렉터리에 변이가 없는 파일만 둔 경우이다.
  it('recovers an environment-variable read planted in a fixture bundle', () => {
    const clean = mkdtempSync(join(tmpdir(), 'helix-mut-env-clean-'));
    const mutant = mkdtempSync(join(tmpdir(), 'helix-mut-env-plant-'));
    try {
      writeFileSync(join(clean, 'a.mjs'), 'const h = process.env.HELIX_HOME;\nexport default h;\n');
      writeFileSync(join(mutant, 'a.mjs'), 'const h = process.env.HELIX_HOME;\nexport default h;\n');
      writeFileSync(join(mutant, 'b.mjs'), 'export const p = process.env.HELIX_PLANTED_BY_MUTATION;\n');

      expect(extractEnvVars(clean).map((e) => e.name)).toEqual(['HELIX_HOME']);
      expect(extractEnvVars(mutant).map((e) => e.name)).toEqual(['HELIX_HOME', 'HELIX_PLANTED_BY_MUTATION']);
    } finally {
      for (const d of [clean, mutant]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* 최선 노력 */ }
      }
    }
  });

  // 인식 불가 형태. 정규식이 원리적으로 보지 못하는 접근이 들어오면 회수가 조용히 누락되므로
  // 추출 자체가 실패해야 한다. 표류 테스트는 이 부류를 검출하지 못한다 — 실시간 회수도 같이
  // 놓치므로 스냅샷과 어긋나지 않는다.
  it('fails instead of silently omitting a bracket-form environment read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-mut-env-bracket-'));
    try {
      writeFileSync(join(dir, 'a.mjs'), "export const p = process.env['HELIX_HIDDEN'];\n");
      expect(() => extractEnvVars(dir)).toThrow(/env-read-form-unrecognized/);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 최선 노력 */ }
    }
  });
});

// `keyof Surface`로 좁힌다: `Record<string, unknown[]>`는 문자열 인덱스 시그니처로 취급되어
// `noUncheckedIndexedAccess` 아래에서 `live.tools` 등 모든 프로퍼티 접근이 `unknown[] | undefined`가
// 된다. 다섯 필드로 한정하면 각 배열 원소는 여전히 `unknown`(변이 주입을 허용)이면서 배열
// 자체는 항상 존재가 보장된다.
const committed = (): Record<keyof Surface, unknown[]> => JSON.parse(readFileSync(SURFACE_PATH, 'utf8'));

// 이 절이 확인하는 것은 스냅샷 대조가 **필드 수준**이라는 것뿐이며, 추출기의 완전성이 아니다
// (그것은 위 절이 담당한다). 원소를 더하기만 하는 사례는 배열이 비어 있어도 통과하는
// 항진명제이므로 두지 않는다.
describe('the snapshot comparison is field-level, not merely length-level', () => {
  it('a removed config leaf makes the two objects differ', () => {
    const live = committed();
    live.configLeaves = live.configLeaves.slice(1);
    expect(live).not.toEqual(committed());
  });

  it('a changed hook timeout makes the two objects differ', () => {
    const live = committed();
    live.hooks = live.hooks.map((h, i) => (i === 0 ? { ...(h as object), timeout: 999 } : h));
    expect(live).not.toEqual(committed());
  });

  it('a changed CLI usage line makes the two objects differ', () => {
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
