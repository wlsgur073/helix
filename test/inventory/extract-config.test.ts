import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { extractConfigLeaves, extractEnvVars } from '../../scripts/inventory/extract-config.js';

/**
 * 객체의 leaf 경로를 회수한다. 추출기의 `walk`를 재사용하지 않는다 — 같은 코드로 두 집합을
 * 만들면 정의상 같아져 아래 단언이 아무것도 확인하지 못한다.
 */
function leafPaths(node: unknown, prefix: string[] = [], out: string[] = []): string[] {
  if (typeof node === 'object' && node !== null && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) leafPaths(v, [...prefix, k], out);
  } else if (prefix.length > 0) {
    out.push(prefix.join('.'));
  }
  return out;
}

describe('config leaf extraction', () => {
  it('reaches the compaction keys, which DEFAULT_CONFIG does not carry', () => {
    const paths = extractConfigLeaves().map((l) => l.path);
    // DEFAULT_CONFIG만 훑으면 이 여섯 개가 통째로 누락된다.
    expect(paths).toContain('compaction.auto');
    expect(paths).toContain('compaction.dirtyRatio');
    expect(paths).toContain('compaction.minRows');
    expect(paths).toContain('compaction.minDirtyBytes');
    expect(paths).toContain('compaction.graceMs');
    expect(paths).toContain('compaction.maxBytes');
  });

  it('treats every egress leg as its own leaf', () => {
    const paths = extractConfigLeaves().map((l) => l.path);
    for (const leg of ['memoryEcho', 'piiHigh', 'piiBulk', 'secretHeuristic', 'secretEntropy', 'secretEntropyExempt']) {
      expect(paths, `egress leg ${leg} is not an inventoried leaf`).toContain(`dualVerify.egressPolicy.${leg}`);
    }
  });

  it('treats a null default as a leaf rather than recursing into it', () => {
    const leaves = extractConfigLeaves();
    const model = leaves.find((l) => l.path === 'dualVerify.model');
    expect(model, 'dualVerify.model vanished — null was treated as a branch').toBeDefined();
    expect(model!.defaultValue).toBeNull();
  });

  /**
   * 설정 회수가 AST 추출이 아니라 기본값 walk이므로, 기본값 없이 수용되는 키가 생기면
   * 인벤토리에서 조용히 누락된다. 그 부류를 검출하는 단언이다: `loadConfig`가 실제로
   * 수용하여 반환한 leaf 경로가 전부 인벤토리의 leaf 집합에 들어 있어야 한다.
   */
  it('accepts no configuration key that the inventory does not carry as a leaf', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-cfgaccept-'));
    try {
      // 문서화된 키 전부를 기본값이 **아닌** 유효한 값으로 채운다. 기본값과 같은 값을 쓰면
      // 대입이 일어나지 않아도 단언이 통과하므로, 수용 경로를 실제로 지나게 한다.
      writeFileSync(join(home, 'config.json'), JSON.stringify({
        dualVerify: {
          enabled: true, mode: 'critique', stakesFloor: 'low', model: 'gpt-5.6', effort: 'high',
          timeoutMs: 60_000,
          egressPolicy: {
            memoryEcho: 'allow', piiHigh: 'allow', piiBulk: 'allow',
            secretHeuristic: 'allow', secretEntropy: 'allow', secretEntropyExempt: 'block',
          },
          logContent: true,
        },
        metrics: { enabled: false },
      }));
      const accepted = leafPaths(loadConfig({ globalPath: join(home, 'config.json') })).sort();
      const inventoried = new Set(extractConfigLeaves().map((l) => l.path));
      expect(accepted.length, 'the probe config set nothing at all').toBeGreaterThan(10);
      expect(
        accepted.filter((p) => !inventoried.has(p)),
        'loadConfig accepts a key with no inventoried leaf — the inventory omits it silently',
      ).toEqual([]);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* 최선 노력 */ }
    }
  });

  it('carries the default value, not just the path', () => {
    const leaves = extractConfigLeaves();
    expect(leaves.find((l) => l.path === 'metrics.enabled')!.defaultValue).toBe(true);
    expect(leaves.find((l) => l.path === 'dualVerify.enabled')!.defaultValue).toBe(false);
    expect(leaves.find((l) => l.path === 'compaction.minRows')!.defaultValue).toBe(200);
  });
});

describe('environment variable extraction', () => {
  it('recovers every HELIX_ variable the shipped bundles read, documented or not', () => {
    const names = extractEnvVars().map((e) => e.name);
    expect(names).toContain('HELIX_HOME');
    expect(names).toContain('HELIX_LEDGER');
    // 배포 번들이 읽지만 배포 문서에 없는 변수. 인벤토리에서 사라지면 안 된다.
    expect(names).toContain('HELIX_SESSIONS');
  });

  it('records which shipped file reads each variable', () => {
    const sessions = extractEnvVars().find((e) => e.name === 'HELIX_SESSIONS');
    expect(sessions!.readIn.some((f) => f.includes('session-end'))).toBe(true);
  });
});
