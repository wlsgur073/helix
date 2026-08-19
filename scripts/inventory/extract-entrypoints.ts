// hook은 등록에서, CLI 계약은 실행에서 회수한다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HookFacet { event: string; command: string; timeout: number | null; bundle: string }
export interface CliFacet { bundle: string; usage: string; noArgsExitCode: number }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(ROOT, 'bin');

interface HooksJson {
  hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>;
}

export function extractHooks(): HookFacet[] {
  const raw = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8')) as HooksJson;
  const out: HookFacet[] = [];
  for (const [event, groups] of Object.entries(raw.hooks)) {
    for (const group of groups) {
      for (const entry of group.hooks) {
        // `node "${CLAUDE_PLUGIN_ROOT}/bin/hooks/x.mjs"` → 저장소 루트 기준 경로로 해소한다.
        const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"']+)/.exec(entry.command);
        out.push({
          event,
          command: entry.command,
          timeout: entry.timeout ?? null,
          // 저장소 기준 상대 경로. 스냅샷이 기계 의존적이 되지 않도록 절대 경로를 쓰지 않는다.
          // `m?.[1] ?? ''`인 이유는 `noUncheckedIndexedAccess`가 캡처 그룹을
          // `string | undefined`로 만들기 때문이다. `m ? m[1] : ''`는 그 좁히기를 하지 못한다.
          bundle: m?.[1] ?? '',
        });
      }
    }
  }
  // 코드포인트 비교. `localeCompare`는 `--without-intl`/small-icu Node에서 퇴화하여 순서가
  // 갈리며, 이 스냅샷은 다른 기계에서 대조되는 것이 존재 이유이다.
  return out.sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
}

/** hook 번들이 아닌 최상위 `bin/*.mjs` 중 MCP 서버를 제외한 것이 운영자 CLI이다. */
function cliBundles(): string[] {
  return readdirSync(BIN)
    .filter((e) => e.endsWith('.mjs') && e !== 'helix-mcp.mjs')
    .map((e) => join(BIN, e))
    .filter((p) => statSync(p).isFile())
    .sort();
}

/**
 * 자식에게 주는 최소 환경. `HELIX_*`는 운영자의 설정이 계약에 섞이는 것을 막기 위해
 * 제거하고, `NODE_OPTIONS`와 `NODE_DEBUG`는 Node 자신이 stderr에 진단을 출력하게 만들기
 * 때문에 제거한다. 두 CLI 모두 usage를 stderr에만 내므로(실측: stdout은 빈 문자열)
 * `usage`를 stdout에서만 도출하면 계약이 통째로 비게 된다. 따라서 필드를 분리하는 대신
 * 오염원을 제거한다. 그 진단 문자열은 PID를 포함하여 같은 기계에서도 재현되지 않으므로,
 * 재생성 한 번으로 오염된 값이 CLI 계약으로 커밋될 수 있었다.
 */
function childEnv(): NodeJS.ProcessEnv {
  const drop = (k: string): boolean => k.startsWith('HELIX_') || k === 'NODE_OPTIONS' || k === 'NODE_DEBUG';
  return Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && !drop(k)),
  );
}

export function extractClis(): CliFacet[] {
  return cliBundles().map((bundle) => {
    const r = spawnSync(process.execPath, [bundle], {
      encoding: 'utf8',
      env: childEnv(),
      // 인자 검증에서 즉시 반환하는 호출이다. 상한이 없으면 회귀 한 번이 인벤토리 생성을
      // 무기한 정지시킨다.
      timeout: 10_000,
    });
    return {
      bundle: relative(ROOT, bundle),
      usage: `${r.stdout}${r.stderr}`.trim(),
      noArgsExitCode: r.status ?? -1,
    };
  });
}
