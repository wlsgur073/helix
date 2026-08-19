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

const byName = (a: ToolFacet, b: ToolFacet): number => a.name.localeCompare(b.name);

/** 사용자가 실제로 실행하는 바이트에서 회수한다. */
export async function fromBundle(): Promise<ToolFacet[]> {
  const home = mkdtempSync(join(tmpdir(), 'helix-inv-bundle-'));
  const client = new Client({ name: 'helix-inventory', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
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

/** 소스 등록부에서 독립적으로 회수한다. */
export async function fromSource(): Promise<ToolFacet[]> {
  const home = mkdtempSync(join(tmpdir(), 'helix-inv-src-'));
  const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 'inventory' });
  const server = buildServer(store);
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
