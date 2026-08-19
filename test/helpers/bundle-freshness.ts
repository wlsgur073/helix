import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `build.mjs`가 산출하는 다섯 번들. 이 목록이 곧 배포되는 실행 가능 표면이다. */
const BUNDLES: readonly string[] = [
  'helix-mcp.mjs',
  'helix-trigger.mjs',
  'helix-rebaseline.mjs',
  'hooks/session-start.mjs',
  'hooks/session-end.mjs',
];

/**
 * `src/`를 임시 디렉터리로 재빌드하여 커밋된 `bin/`과 바이트 비교하고, 어긋난 번들의 상대 경로를
 * 반환한다. 빈 배열이면 `bin/`이 `src/`의 재빌드와 동일하다.
 *
 * 이 함수가 헬퍼로 분리된 이유는 두 곳이 같은 사실을 필요로 하기 때문이다.
 * `test/plugin/packaging.test.ts`는 `bin/`이 낡았는지를 묻고, `test/docs/shipped-claims.doc.test.ts`는
 * 자신이 `src/`를 실행해 얻은 값이 배포 번들에 대한 증거가 될 수 있는지를 묻는다. 후자의 근거가
 * 바로 전자의 사실이므로, 두 파일이 각자 재빌드 논리를 복사해 두면 한쪽이 조용히 표류할 수 있다.
 *
 * esbuild는 같은 버전과 같은 입력에 대해 같은 바이트를 낸다. 따라서 차이가 나면 `src/`와 `bin/`이
 * 어긋난 것이며, `npm run build` 후 `bin/`을 커밋해야 한다.
 */
export function staleBundles(): string[] {
  const out = mkdtempSync(join(tmpdir(), 'helix-freshbuild-'));
  execFileSync(process.execPath, [join(ROOT, 'build.mjs')], {
    cwd: ROOT,
    env: { ...process.env, HELIX_BUILD_OUT: out },
    stdio: 'ignore',
  });
  return BUNDLES.filter(
    (rel) => !readFileSync(join(out, rel)).equals(readFileSync(join(ROOT, 'bin', rel))),
  );
}
