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
          bundle: m ? m[1] : '',
        });
      }
    }
  }
  return out.sort((a, b) => a.event.localeCompare(b.event));
}

/** hook 번들이 아닌 최상위 `bin/*.mjs` 중 MCP 서버를 제외한 것이 운영자 CLI이다. */
function cliBundles(): string[] {
  return readdirSync(BIN)
    .filter((e) => e.endsWith('.mjs') && e !== 'helix-mcp.mjs')
    .map((e) => join(BIN, e))
    .filter((p) => statSync(p).isFile())
    .sort();
}

export function extractClis(): CliFacet[] {
  return cliBundles().map((bundle) => {
    const r = spawnSync(process.execPath, [bundle], {
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_')),
      ) as Record<string, string>,
    });
    return {
      bundle: relative(ROOT, bundle),
      usage: `${r.stdout}${r.stderr}`.trim(),
      noArgsExitCode: r.status ?? -1,
    };
  });
}
