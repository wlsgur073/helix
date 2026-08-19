// 설정 leaf는 파서가 실제로 쓰는 권위에서 회수한다. compaction 기본값은 export되지 않으므로
// 빈 HELIX_HOME에 대해 접근자를 실행하여 회수한다 — 읽기가 아니라 실행이다.
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, compactionConfigFromGlobal } from '../../src/config.js';

export interface ConfigLeaf { path: string; defaultValue: unknown }
export interface EnvVar { name: string; readIn: string[] }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(ROOT, 'bin');

const isBranch = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function walk(node: Record<string, unknown>, prefix: string[], out: ConfigLeaf[]): void {
  for (const [key, value] of Object.entries(node)) {
    // `unreadable`은 출력 상태이지 지원 설정이 아니다 (설계 문서 5.1).
    if (prefix.length === 0 && key === 'unreadable') continue;
    const path = [...prefix, key];
    if (isBranch(value)) walk(value, path, out);
    else out.push({ path: path.join('.'), defaultValue: value });
  }
}

export function extractConfigLeaves(): ConfigLeaf[] {
  const home = mkdtempSync(join(tmpdir(), 'helix-inv-cfg-'));
  try {
    const out: ConfigLeaf[] = [];
    walk(DEFAULT_CONFIG as unknown as Record<string, unknown>, [], out);
    walk({ compaction: compactionConfigFromGlobal(home) as unknown as Record<string, unknown> }, [], out);
    // 코드포인트 비교. `localeCompare`는 `--without-intl`/small-icu Node에서 퇴화하여 순서가
    // 갈리며, 이 스냅샷은 다른 기계에서 대조되는 것이 존재 이유이다.
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  } finally {
    // 디렉터리를 만든 함수가 수명을 소유한다. vitest 안에서는 global-setup의 실행별 루트가
    // 함께 지우지만, `npm run inventory`는 vitest 밖이라 여기서 지우지 않으면 누적된다.
    try { rmSync(home, { recursive: true, force: true }); } catch { /* 최선 노력 */ }
  }
}

function shippedFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) shippedFiles(full, acc);
    else if (full.endsWith('.mjs')) acc.push(full);
  }
  return acc;
}

/** 회수하는 형태: `process.env.IDENT`. esbuild 출력에서 구문적으로 모호하지 않다. */
const ENV_READ = /process\.env\.([A-Z][A-Z0-9_]*)/g;
/** 회수하지 못하는 형태까지 포함하여 세는 탐지기. bracket 접근과 소문자 이름을 함께 센다. */
const ENV_ANY = /process\.env\s*(?:\.|\[)/g;

/**
 * 배포 번들에서 환경변수 읽기를 회수한다. 프로토콜로 물어볼 수 있는 표면이 아니므로
 * 패턴 대조를 쓴다.
 *
 * 표류 테스트는 이 한계를 보완하지 못한다. 표류 테스트가 검출하는 것은 정규식이 **볼 수
 * 있는** 변화뿐이며, `process.env['X']`나 `const { X } = process.env`처럼 원리적으로 보지
 * 못하는 형태가 도입되면 실시간 회수도 그것을 놓치므로 스냅샷은 그대로이고 표류 테스트는
 * 통과한다. 그래서 대신 넓은 탐지 정규식과 매치 수를 대조하여, 회수하지 못하는 형태가
 * 하나라도 들어오면 인벤토리 생성 자체를 실패시킨다 — 설계 문서 8.2가 v0.1의 채택 범위에
 * 넣은 "인식 불가 형태에서의 실패"이다. destructuring 형태는 이 대조로도 보이지 않는다.
 *
 * `dir`은 기본값이 배포 번들 디렉터리이며, 인자로 주는 것은 테스트가 합성 변이를 주입하는
 * 통로이다 — 변이를 생산 코드에 심지 않고 회수 여부를 확인하기 위한 것이다.
 */
export function extractEnvVars(dir: string = BIN): EnvVar[] {
  const found = new Map<string, Set<string>>();
  for (const file of shippedFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    const recovered = [...text.matchAll(ENV_READ)];
    const detected = [...text.matchAll(ENV_ANY)].length;
    if (detected > recovered.length) {
      throw new Error(
        `env-read-form-unrecognized: ${rel} carries ${detected} process.env accesses but only ` +
        `${recovered.length} are in the recoverable \`process.env.IDENT\` form. The inventory would ` +
        'silently omit the rest, so it is not built. Extend the extractor to the new form.',
      );
    }
    for (const m of recovered) {
      // `noUncheckedIndexedAccess`가 켜져 있어 캡처 그룹은 `string | undefined`이다.
      // 이 정규식에서 그룹 1은 매치 시 항상 참여하지만, 타입이 그것을 알지 못한다.
      const name = m[1];
      if (name === undefined) continue;
      if (!found.has(name)) found.set(name, new Set());
      found.get(name)!.add(rel);
    }
  }
  return [...found.entries()]
    .map(([name, files]) => ({ name, readIn: [...files].sort() }))
    // 코드포인트 비교: 위 `path` 정렬과 같은 이유이며, 실측된 퇴화 사례가 바로
    // `HELIX_HOME` 대 `HELIXA` 쌍이므로 이 정렬이 그 축에 가장 가깝다.
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
