// 도구 표면 추출기의 계약. 개수를 하드코딩하지 않는다 — 하드코딩된 목록이 배포 트리의
// "Seven MCP tools" 오류를 만든 방식이며, 개수 고정은 Task 4의 스냅샷이 담당한다.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    // 이 파일만의 사설 임시 루트에서 돌린다. `helix-inv-*`를 공유 임시 디렉터리에서 계수하면
    // 같은 실행의 다른 테스트 파일이 동시에 만들고 지우는 디렉터리가 계수에 섞여, 추출기와
    // 무관한 이유로 통과와 실패가 갈린다(실측: before=1, after=0으로 실패). 사설 루트에서는
    // 남은 것이 곧 추출기가 남긴 것이므로, 불변이 아니라 공집합을 요구할 수 있다.
    const priv = mkdtempSync(join(tmpdir(), 'helix-tmproot-'));
    const prior = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    try {
      process.env.TMPDIR = priv;
      process.env.TMP = priv;
      process.env.TEMP = priv;
      await extractTools();
      expect(readdirSync(priv), 'extractTools left its temporary HELIX_HOME behind').toEqual([]);
    } finally {
      // `process.env.X = undefined`는 문자열 "undefined"를 저장하므로 삭제로 복원한다.
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try { rmSync(priv, { recursive: true, force: true }); } catch { /* 최선 노력 */ }
    }
  }, 60_000);

  // `fromSource`는 `buildServer`가 스스로 해소하는 home을 임시 디렉터리로 돌리기 위해
  // `process.env.HELIX_HOME`을 일시적으로 바꾼다. 그 값이 프로세스에 남으면 같은 프로세스의
  // 다른 회수가 이미 지워진 임시 디렉터리를 실제 home으로 읽는다. 부재였던 변수에 문자열
  // "undefined"가 남는 것도 같은 부류의 오염이므로, 삭제로 복원되는지까지 확인한다.
  it('leaves process.env.HELIX_HOME exactly as it found it', async () => {
    const prior = process.env.HELIX_HOME;
    try {
      delete process.env.HELIX_HOME;
      await fromSource();
      expect('HELIX_HOME' in process.env, 'fromSource left HELIX_HOME defined').toBe(false);

      process.env.HELIX_HOME = '/nonexistent/helix-prior-marker';
      await fromSource();
      expect(process.env.HELIX_HOME, 'fromSource did not restore the prior value').toBe('/nonexistent/helix-prior-marker');
    } finally {
      if (prior === undefined) delete process.env.HELIX_HOME;
      else process.env.HELIX_HOME = prior;
    }
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
