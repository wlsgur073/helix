import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { extractConfigLeaves, extractEnvVars } from '../../scripts/inventory/extract-config.js';

/**
 * Recovers an object's leaf paths. The extractor's own `walk` is deliberately not reused: building
 * both sets with the same code makes them equal by definition, and the assertion below would
 * establish nothing.
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
    // Walking DEFAULT_CONFIG alone drops all six of these.
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
   * Config recovery is a walk over the defaults rather than an AST extraction, so a key that is
   * accepted without having a default drops silently out of the inventory. This assertion detects
   * that class: every leaf path `loadConfig` actually accepted and returned must appear in the
   * inventory's leaf set.
   */
  it('accepts no configuration key that the inventory does not carry as a leaf', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-cfgaccept-'));
    try {
      // Every documented key is filled with a valid value that is NOT its default. Using the
      // default would let the assertion pass even if no assignment happened, so this drives the
      // acceptance path for real.
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
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
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
    // A variable the shipped bundles read but the shipped docs do not name. It must not vanish from the inventory.
    expect(names).toContain('HELIX_SESSIONS');
  });

  it('records which shipped file reads each variable', () => {
    const sessions = extractEnvVars().find((e) => e.name === 'HELIX_SESSIONS');
    expect(sessions!.readIn.some((f) => f.includes('session-end'))).toBe(true);
  });
});
