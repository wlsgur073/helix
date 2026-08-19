// 도구 표면의 이중 회수. 사용자가 실행하는 번들과 소스 등록부를 각각 프로토콜로 읽고
// 일치를 요구한다. 정규식이나 개수 세기를 쓰지 않는다.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../../src/memory/store.js';
import { buildServer } from '../../src/server/helix-server.js';

export interface ToolFacet {
  name: string;
  description: string;
  inputSchema: unknown;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(ROOT, 'bin', 'helix-mcp.mjs');

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_')),
  ) as Record<string, string>;
}

const facet = (t: { name: string; description?: string; inputSchema: unknown }): ToolFacet =>
  ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema });

// 코드포인트 비교. `localeCompare`는 `--without-intl`/small-icu Node에서 코드포인트 유사
// 비교로 퇴화하며 `HELIX_HOME` 대 `HELIXA` 같은 쌍에서 순서가 갈린다. 이 스냅샷의 존재
// 이유가 다른 기계에서의 대조이므로 ICU 빌드에 좌우되는 축을 남기지 않는다.
const byName = (a: ToolFacet, b: ToolFacet): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * 사용자가 실제로 실행하는 바이트에서 회수한다.
 *
 * `bundle`은 기본값이 배포되는 번들이며, 인자로 주는 것은 테스트가 합성 변이를 주입하는
 * 통로이다 — 번들의 임시 사본을 변형하여 넘기면, 이 함수가 상수를 반환하는 것이 아니라
 * 넘겨받은 바이트를 실제로 읽는다는 것이 확인된다. `bin/`은 변형하지 않는다.
 */
export async function fromBundle(bundle: string = BUNDLE): Promise<ToolFacet[]> {
  const home = mkdtempSync(join(tmpdir(), 'helix-inv-bundle-'));
  const client = new Client({ name: 'helix-inventory', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    cwd: home,
    env: { ...cleanEnv(), HELIX_HOME: home },
  }));
  try {
    const { tools } = await client.listTools();
    return tools.map(facet).sort(byName);
  } finally {
    await client.close();
    // 디렉터리를 만든 함수가 수명을 소유한다. vitest 안에서는 global-setup의 실행별 루트가
    // 함께 지우지만, `npm run inventory`는 vitest 밖이라 여기서 지우지 않으면 누적된다.
    try { rmSync(home, { recursive: true, force: true }); } catch { /* 최선 노력 */ }
  }
}

/**
 * `process.env.HELIX_HOME`을 임시로 바꾸어 `fn`을 실행하고 이전 값으로 복원한다.
 * `process.env.X = undefined`는 문자열 `"undefined"`를 저장하므로, 이전 값이 없었으면
 * 대입이 아니라 삭제로 되돌린다. `test/global-setup.ts`의 `restoreEnv`와 같은 규율이다.
 */
function withHelixHome<T>(home: string, fn: () => T): T {
  const prior = process.env.HELIX_HOME;
  process.env.HELIX_HOME = home;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.HELIX_HOME;
    else process.env.HELIX_HOME = prior;
  }
}

/** 소스 등록부에서 독립적으로 회수한다. */
export async function fromSource(): Promise<ToolFacet[]> {
  const home = mkdtempSync(join(tmpdir(), 'helix-inv-src-'));
  const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 'inventory' });
  // `buildServer`는 `dualDeps` 없이 호출되면 `process.env.HELIX_HOME ?? homedir()/.helix`를
  // 스스로 해소하고 그 경로에 `loadConfig`를 즉시 실행한다. 임시 디렉터리를
  // `MemoryStore`에만 넘기면 이 팔만 운영자의 실제 전역 설정을 읽어, 이중 회수의 두 팔이
  // 서로 다른 설정 아래에서 구동된다. 범위는 `buildServer` 호출 한 번으로 좁힌다 —
  // 도구 등록은 그 시점에 끝나고, `listTools`는 핸들러를 구동하지 않는다.
  const server = withHelixHome(home, () => buildServer(store));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'helix-inventory-src', version: '0.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const { tools } = await client.listTools();
    return tools.map(facet).sort(byName);
  } finally {
    await client.close();
    // 디렉터리를 만든 함수가 수명을 소유한다. vitest 안에서는 global-setup의 실행별 루트가
    // 함께 지우지만, `npm run inventory`는 vitest 밖이라 여기서 지우지 않으면 누적된다.
    try { rmSync(home, { recursive: true, force: true }); } catch { /* 최선 노력 */ }
  }
}

/** 불일치는 실패이며 인벤토리를 만들지 않는다. */
export function compareSurfaces(bundle: ToolFacet[], source: ToolFacet[]): void {
  const b = JSON.stringify(bundle);
  const s = JSON.stringify(source);
  if (b === s) return;
  throw new Error(
    'tool-surface-disagreement: the shipped bundle and the source registry differ. ' +
    `bundle=[${bundle.map((t) => t.name).join(',')}] source=[${source.map((t) => t.name).join(',')}]`,
  );
}

export async function extractTools(): Promise<ToolFacet[]> {
  const [bundle, source] = await Promise.all([fromBundle(), fromSource()]);
  compareSurfaces(bundle, source);
  return bundle;
}
