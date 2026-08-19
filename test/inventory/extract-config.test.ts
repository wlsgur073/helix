import { describe, it, expect } from 'vitest';
import { extractConfigLeaves, extractEnvVars } from '../../scripts/inventory/extract-config.js';

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
