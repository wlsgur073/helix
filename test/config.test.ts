import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULT_CONFIG, metricsEnabledFromGlobalConfig } from '../src/config.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'helix-cfg-')); }

describe('loadConfig', () => {
  it('returns defaults (dualVerify disabled) when no config files exist', () => {
    const cfg = loadConfig({ projectPath: join(tmpDir(), 'nope.json'), globalPath: join(tmpDir(), 'nope.json') });
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg.dualVerify.enabled).toBe(false);
  });

  it('project config overrides defaults', () => {
    const dir = tmpDir();
    const p = join(dir, 'config.json');
    writeFileSync(p, JSON.stringify({ dualVerify: { enabled: true, mode: 'critique' } }));
    const cfg = loadConfig({ projectPath: p, globalPath: join(dir, 'global.json') });
    expect(cfg.dualVerify.enabled).toBe(true);
    expect(cfg.dualVerify.mode).toBe('critique');
    expect(cfg.dualVerify.stakesFloor).toBe('high');
  });

  it('accepts xhigh as a stakesFloor (4th tier, strictest)', () => {
    const dir = tmpDir();
    const p = join(dir, 'config.json');
    writeFileSync(p, JSON.stringify({ dualVerify: { stakesFloor: 'xhigh' } }));
    const cfg = loadConfig({ projectPath: p, globalPath: join(dir, 'global.json') });
    expect(cfg.dualVerify.stakesFloor).toBe('xhigh');
  });

  it('project config overrides global config', () => {
    const dir = tmpDir();
    const g = join(dir, 'g.json'); writeFileSync(g, JSON.stringify({ dualVerify: { enabled: false } }));
    const p = join(dir, 'p.json'); writeFileSync(p, JSON.stringify({ dualVerify: { enabled: true } }));
    expect(loadConfig({ projectPath: p, globalPath: g }).dualVerify.enabled).toBe(true);
  });

  it('tolerates malformed JSON by falling back to defaults', () => {
    const dir = tmpDir();
    const p = join(dir, 'bad.json'); writeFileSync(p, '{ not json');
    expect(loadConfig({ projectPath: p, globalPath: join(dir, 'x.json') }).dualVerify.enabled).toBe(false);
  });

  it('defaults model and effort to null (inherit codex ~/.codex/config.toml)', () => {
    const cfg = loadConfig({ projectPath: join(tmpDir(), 'n.json'), globalPath: join(tmpDir(), 'n.json') });
    expect(cfg.dualVerify.model).toBeNull();
    expect(cfg.dualVerify.effort).toBeNull();
  });

  it('reads valid model + effort overrides (incl. xhigh)', () => {
    const dir = tmpDir();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { model: 'gpt-5.5', effort: 'xhigh' } }));
    const cfg = loadConfig({ projectPath: p, globalPath: join(dir, 'g.json') });
    expect(cfg.dualVerify.model).toBe('gpt-5.5');
    expect(cfg.dualVerify.effort).toBe('xhigh');
  });

  it('rejects a malformed model and an unknown effort, keeping defaults', () => {
    const dir = tmpDir();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { model: 'bad; rm -rf', effort: 'ultra' } }));
    const cfg = loadConfig({ projectPath: p, globalPath: join(dir, 'g.json') });
    expect(cfg.dualVerify.model).toBeNull();   // default kept (malformed rejected)
    expect(cfg.dualVerify.effort).toBeNull();  // default kept (unknown rejected)
  });

  it('allows model:null to inherit codex default', () => {
    const dir = tmpDir();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { model: null } }));
    expect(loadConfig({ projectPath: p, globalPath: join(dir, 'g.json') }).dualVerify.model).toBeNull();
  });

  it('defaults every egressPolicy leg to block (fail-closed)', () => {
    const cfg = loadConfig({ projectPath: join(tmpDir(), 'n.json'), globalPath: join(tmpDir(), 'n.json') });
    expect(cfg.dualVerify.egressPolicy).toEqual({ memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block' });
    expect(DEFAULT_CONFIG.dualVerify.egressPolicy.secretHeuristic).toBe('block');
  });

  it('reads a valid per-leg override (secretHeuristic: allow); other legs stay block', () => {
    const dir = tmpDir();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { egressPolicy: { secretHeuristic: 'allow' } } }));
    const ep = loadConfig({ projectPath: p, globalPath: join(dir, 'g.json') }).dualVerify.egressPolicy;
    expect(ep.secretHeuristic).toBe('allow'); expect(ep.piiHigh).toBe('block');
  });

  it('an invalid leg value falls back to block (fail-closed) and warns', () => {
    const dir = tmpDir(); const warn = vi.fn();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { egressPolicy: { piiHigh: 'maybe' } } }));
    expect(loadConfig({ projectPath: p, globalPath: join(dir, 'g.json'), warn }).dualVerify.egressPolicy.piiHigh).toBe('block');
    expect(warn).toHaveBeenCalled();
  });

  it('warns on an unknown egressPolicy key (a typo is not silently applied)', () => {
    const dir = tmpDir(); const warn = vi.fn();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { egressPolicy: { secretHuristic: 'allow' } } }));
    loadConfig({ projectPath: p, globalPath: join(dir, 'g.json'), warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('secretHuristic'));
  });

  it('warns that the removed memoryEgress key is ignored', () => {
    const dir = tmpDir(); const warn = vi.fn();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { memoryEgress: 'allow' } }));
    loadConfig({ projectPath: p, globalPath: join(dir, 'g.json'), warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('memoryEgress'));
  });
});

describe('loadConfig: dualVerify.timeoutMs (configurable Codex runner cap)', () => {
  it('defaults timeoutMs to a positive number', () => {
    const cfg = loadConfig({ projectPath: join(tmpDir(), 'n.json'), globalPath: join(tmpDir(), 'n.json') });
    expect(typeof cfg.dualVerify.timeoutMs).toBe('number');
    expect(cfg.dualVerify.timeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.dualVerify.timeoutMs).toBe(cfg.dualVerify.timeoutMs);
  });
  it('reads a valid timeoutMs override', () => {
    const dir = tmpDir();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { timeoutMs: 240000 } }));
    expect(loadConfig({ projectPath: p, globalPath: join(dir, 'g.json') }).dualVerify.timeoutMs).toBe(240000);
  });
  it('rejects out-of-band / non-integer timeoutMs, keeping the default (fail-safe)', () => {
    const dir = tmpDir();
    const def = DEFAULT_CONFIG.dualVerify.timeoutMs;
    // 0/-5/'soon' (non-positive / non-number), NaN/±Infinity (non-finite), 0.5 (fractional),
    // 999 (< 1s floor). All must fall back to the default. (Values > 1h are CLAMPED, not rejected —
    // see the clamp test below.)
    for (const bad of [0, -5, 'soon', NaN, Infinity, -Infinity, 0.5, 999] as unknown[]) {
      const p = join(dir, `t${String(bad)}.json`); writeFileSync(p, JSON.stringify({ dualVerify: { timeoutMs: bad } }));
      expect(loadConfig({ projectPath: p, globalPath: join(dir, 'g.json') }).dualVerify.timeoutMs).toBe(def);
    }
  });
  it('clamps an over-cap timeoutMs (> 1h) down to the 1h maximum', () => {
    const dir = tmpDir();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { timeoutMs: 7_200_000 } })); // 2h
    expect(loadConfig({ projectPath: p, globalPath: join(dir, 'g.json') }).dualVerify.timeoutMs).toBe(3_600_000);
  });
});

describe('loadConfig: dualVerify.logContent (opt-in content log gate)', () => {
  it('defaults logContent to false (content logging OFF by default)', () => {
    const cfg = loadConfig({ projectPath: join(tmpDir(), 'n.json'), globalPath: join(tmpDir(), 'n.json') });
    expect(cfg.dualVerify.logContent).toBe(false);
  });

  it('reads logContent:true when explicitly set', () => {
    const dir = tmpDir();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { logContent: true } }));
    expect(loadConfig({ projectPath: p, globalPath: join(dir, 'g.json') }).dualVerify.logContent).toBe(true);
  });

  it('rejects a non-boolean logContent, fail-closed to false (OFF)', () => {
    const dir = tmpDir();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { logContent: 'yes' } }));
    expect(loadConfig({ projectPath: p, globalPath: join(dir, 'g.json') }).dualVerify.logContent).toBe(false);
  });
});

describe('metrics config (spec §6)', () => {
  it('defaults to enabled', () => {
    expect(DEFAULT_CONFIG.metrics.enabled).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'helix-cfg-'));
    const cfg = loadConfig({ globalPath: join(dir, 'none.json'), projectPath: join(dir, 'none2.json') });
    expect(cfg.metrics.enabled).toBe(true);
  });

  it('project layer can disable; invalid values keep the default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-cfg-'));
    const g = join(dir, 'g.json'); const p = join(dir, 'p.json');
    writeFileSync(g, JSON.stringify({ metrics: { enabled: 'yes' } }));   // invalid -> default
    writeFileSync(p, JSON.stringify({ metrics: { enabled: false } }));  // project wins
    const cfg = loadConfig({ globalPath: g, projectPath: p });
    expect(cfg.metrics.enabled).toBe(false);
  });

  it('metricsEnabledFromGlobalConfig: global-only, never throws, defaults true', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-cfg-'));
    expect(metricsEnabledFromGlobalConfig(home)).toBe(true);              // missing file
    writeFileSync(join(home, 'config.json'), '{not json');
    expect(metricsEnabledFromGlobalConfig(home)).toBe(true);              // malformed -> default
    writeFileSync(join(home, 'config.json'), JSON.stringify({ metrics: { enabled: false } }));
    expect(metricsEnabledFromGlobalConfig(home)).toBe(false);
  });
});
