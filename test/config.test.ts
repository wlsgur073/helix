import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.js';

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

  it('defaults memoryEgress to block (fail-closed)', () => {
    const cfg = loadConfig({ projectPath: join(tmpDir(), 'n.json'), globalPath: join(tmpDir(), 'n.json') });
    expect(cfg.dualVerify.memoryEgress).toBe('block');
    expect(DEFAULT_CONFIG.dualVerify.memoryEgress).toBe('block');
  });

  it('reads a valid memoryEgress override (allow)', () => {
    const dir = tmpDir();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { memoryEgress: 'allow' } }));
    expect(loadConfig({ projectPath: p, globalPath: join(dir, 'g.json') }).dualVerify.memoryEgress).toBe('allow');
  });

  it('falls back to block on an unrecognized memoryEgress value (invalid config fails closed)', () => {
    const dir = tmpDir();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { memoryEgress: 'yes-please' } }));
    expect(loadConfig({ projectPath: p, globalPath: join(dir, 'g.json') }).dualVerify.memoryEgress).toBe('block');
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
