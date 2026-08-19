// 도구 표면 추출기의 계약. 개수를 하드코딩하지 않는다 — 하드코딩된 목록이 배포 트리의
// "Seven MCP tools" 오류를 만든 방식이며, 개수 고정은 Task 4의 스냅샷이 담당한다.
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fromBundle, fromSource, compareSurfaces, extractTools } from '../../scripts/inventory/extract-tools.js';

describe('tool surface extraction', () => {
  it('recovers the same tool set from the shipped bundle and from the source registry', async () => {
    const [bundle, source] = await Promise.all([fromBundle(), fromSource()]);
    expect(bundle.map((t) => t.name)).toEqual(source.map((t) => t.name));
    expect(bundle.length).toBeGreaterThan(1);
  }, 60_000);

  it('carries description and input schema, not just names', async () => {
    const tools = await extractTools();
    const commit = tools.find((t) => t.name === 'helix_memory_commit');
    expect(commit, 'helix_memory_commit is no longer registered').toBeDefined();
    expect(commit!.description.length).toBeGreaterThan(0);
    expect(commit!.inputSchema).toBeDefined();
  }, 60_000);

  it('removes the temporary home it created, so a run outside vitest does not accumulate them', async () => {
    const before = readdirSync(tmpdir()).filter((e) => e.startsWith('helix-inv-')).length;
    await extractTools();
    const after = readdirSync(tmpdir()).filter((e) => e.startsWith('helix-inv-')).length;
    expect(after, 'extractTools left its temporary HELIX_HOME behind').toBe(before);
  }, 60_000);

  // 음성 대조: 비교기가 실제로 불일치를 거부하는지. 이것이 없으면 위 두 사례는
  // 비교기가 항상 통과하는 경우에도 초록색이다.
  it('rejects a surface that differs by one name', () => {
    const a = [{ name: 'helix_memory_commit', description: 'd', inputSchema: {} }];
    const b = [{ name: 'helix_memory_commmit', description: 'd', inputSchema: {} }];
    expect(() => compareSurfaces(a, b)).toThrow(/tool-surface-disagreement/);
  });

  it('rejects a surface that differs only by input schema', () => {
    const a = [{ name: 'x', description: 'd', inputSchema: { a: 1 } }];
    const b = [{ name: 'x', description: 'd', inputSchema: { a: 2 } }];
    expect(() => compareSurfaces(a, b)).toThrow(/tool-surface-disagreement/);
  });

  it('accepts two identical surfaces', () => {
    const a = [{ name: 'x', description: 'd', inputSchema: { a: 1 } }];
    expect(() => compareSurfaces(a, structuredClone(a))).not.toThrow();
  });
});
