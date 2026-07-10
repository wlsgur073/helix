import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULT_CONFIG, metricsEnabledFromGlobalConfig, compactionConfigFromGlobal } from '../src/config.js';

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
    const dir = tmpDir(); const warn = vi.fn();
    // 'ultra' used to sit here as the "unknown effort" example; Codex 5.6 made it valid.
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { model: 'bad; rm -rf', effort: 'insane' } }));
    const cfg = loadConfig({ projectPath: p, globalPath: join(dir, 'g.json'), warn });
    expect(cfg.dualVerify.model).toBeNull();   // default kept (malformed rejected)
    expect(cfg.dualVerify.effort).toBeNull();  // default kept (unknown rejected)
    expect(warn).toHaveBeenCalledTimes(2);     // neither is dropped silently any more
  });

  it('allows model:null to inherit codex default', () => {
    const dir = tmpDir();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { model: null } }));
    expect(loadConfig({ projectPath: p, globalPath: join(dir, 'g.json') }).dualVerify.model).toBeNull();
  });

  it('accepts the Codex 5.6 efforts max and ultra', () => {
    const dir = tmpDir();
    for (const effort of ['max', 'ultra'] as const) {
      const p = join(dir, `e-${effort}.json`); writeFileSync(p, JSON.stringify({ dualVerify: { effort } }));
      expect(loadConfig({ projectPath: p, globalPath: join(dir, 'g.json') }).dualVerify.effort).toBe(effort);
    }
  });

  it('rejects minimal (retired: no codex model advertises it) and warns', () => {
    const dir = tmpDir(); const warn = vi.fn();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { effort: 'minimal' } }));
    expect(loadConfig({ projectPath: p, globalPath: join(dir, 'g.json'), warn }).dualVerify.effort).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('minimal'));
  });

  it('an invalid project effort does not clobber a valid global effort (-> ignored, not -> inherit)', () => {
    const dir = tmpDir(); const warn = vi.fn();
    const g = join(dir, 'g.json'); writeFileSync(g, JSON.stringify({ dualVerify: { effort: 'max' } }));
    const p = join(dir, 'p.json'); writeFileSync(p, JSON.stringify({ dualVerify: { effort: 'nope' } }));
    expect(loadConfig({ projectPath: p, globalPath: g, warn }).dualVerify.effort).toBe('max');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nope'));
    // The wording is load-bearing (design §3.2): the survivor here is the GLOBAL Helix value, not
    // Codex's, so the message must say "-> ignored", never "-> inheriting codex config".
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('-> ignored'));
  });

  it('an ABSENT key never warns (a valid two-file setup must stay silent)', () => {
    const dir = tmpDir(); const warn = vi.fn();
    const g = join(dir, 'g.json'); writeFileSync(g, JSON.stringify({ dualVerify: { effort: 'high' } }));
    const p = join(dir, 'p.json'); writeFileSync(p, JSON.stringify({ dualVerify: { enabled: true } }));
    const cfg = loadConfig({ projectPath: p, globalPath: g, warn });
    expect(cfg.dualVerify.effort).toBe('high');
    expect(cfg.dualVerify.enabled).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns on an invalid mode and an invalid stakesFloor, keeping the previous value', () => {
    const dir = tmpDir(); const warn = vi.fn();
    const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify({ dualVerify: { mode: 'debate', stakesFloor: 'urgent' } }));
    const cfg = loadConfig({ projectPath: p, globalPath: join(dir, 'g.json'), warn });
    expect(cfg.dualVerify.mode).toBe('compare');       // DEFAULT_CONFIG value kept
    expect(cfg.dualVerify.stakesFloor).toBe('high');   // DEFAULT_CONFIG value kept
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('debate'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('urgent'));
    // Pin each call individually (not "some call contains -> ignored"): a regression on either the
    // mode or the stakesFloor message alone must still fail this test.
    expect(warn.mock.calls[0]![0]).toEqual(expect.stringContaining('-> ignored'));
    expect(warn.mock.calls[1]![0]).toEqual(expect.stringContaining('-> ignored'));
  });

  it('mode:null and stakesFloor:null warn (they have no inherit semantics); model/effort null do not', () => {
    const dir = tmpDir();
    const nullish = vi.fn();
    const p1 = join(dir, 'a.json'); writeFileSync(p1, JSON.stringify({ dualVerify: { mode: null, stakesFloor: null } }));
    loadConfig({ projectPath: p1, globalPath: join(dir, 'g.json'), warn: nullish });
    expect(nullish).toHaveBeenCalledTimes(2);

    const quiet = vi.fn();
    const p2 = join(dir, 'b.json'); writeFileSync(p2, JSON.stringify({ dualVerify: { model: null, effort: null } }));
    loadConfig({ projectPath: p2, globalPath: join(dir, 'g.json'), warn: quiet });
    expect(quiet).not.toHaveBeenCalled();
  });

  it('rejects a model longer than 64 chars (the display-safety bound) and warns', () => {
    const dir = tmpDir(); const warn = vi.fn();
    const ok64 = 'g'.repeat(64);
    const long65 = 'g'.repeat(65);
    const a = join(dir, 'ok.json'); writeFileSync(a, JSON.stringify({ dualVerify: { model: ok64 } }));
    expect(loadConfig({ projectPath: a, globalPath: join(dir, 'g.json') }).dualVerify.model).toBe(ok64);
    const b = join(dir, 'long.json'); writeFileSync(b, JSON.stringify({ dualVerify: { model: long65 } }));
    expect(loadConfig({ projectPath: b, globalPath: join(dir, 'g.json'), warn }).dualVerify.model).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('-> ignored'));
  });

  it('a warned value is rendered on one bounded line for every q()-guarded key (no raw newline reaches stderr)', () => {
    const dir = tmpDir();
    const evil = 'x\ny'.repeat(80);
    // mode/stakesFloor/model/effort all route their warn through q(); a future edit that interpolates
    // any one of them raw (e.g. `${dv.effort}`) must fail this loop, not just the model case.
    for (const key of ['mode', 'stakesFloor', 'model', 'effort'] as const) {
      const warn = vi.fn();
      const dv: Record<string, unknown> = { [key]: evil };
      const p = join(dir, `${key}.json`); writeFileSync(p, JSON.stringify({ dualVerify: dv }));
      loadConfig({ projectPath: p, globalPath: join(dir, 'g.json'), warn });
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls[0]![0] as string;
      expect(msg.split('\n')).toHaveLength(1);   // the real invariant: no raw newline forges a log line
      expect(msg.length).toBeLessThan(200);      // bounded: a 10MB value cannot flood stderr
    }
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

  it('an egressPolicy value containing a raw newline cannot forge a second stderr line', () => {
    const dir = tmpDir(); const warn = vi.fn();
    // A hostile checkout's project config tries to smuggle a fake log line via the invalid value.
    const p = join(dir, 'c.json');
    writeFileSync(p, JSON.stringify({ dualVerify: { egressPolicy: { piiHigh: 'block\nhelix: FORGED LINE' } } }));
    loadConfig({ projectPath: p, globalPath: join(dir, 'g.json'), warn });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg.split('\n')).toHaveLength(1);   // no raw newline reaches stderr -> no forged second line
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

describe('compactionConfigFromGlobal', () => {
  it('defaults to disabled with safe thresholds when no global config exists', () => {
    expect(compactionConfigFromGlobal(tmpDir())).toEqual({
      auto: false, dirtyRatio: 0.5, minRows: 200, minDirtyBytes: 1048576, graceMs: 86400000, maxBytes: 52428800,
    });
  });

  it('reads the GLOBAL config and validates bounds (bad values keep defaults)', () => {
    const home = tmpDir();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ compaction: { auto: true, dirtyRatio: 0, graceMs: -5, minRows: 10, maxBytes: 0, minDirtyBytes: -1 } }));
    const c = compactionConfigFromGlobal(home);
    expect(c.auto).toBe(true);              // valid boolean accepted
    expect(c.dirtyRatio).toBe(0.5);          // 0 out of (0,1] -> default
    expect(c.graceMs).toBe(86400000);        // negative -> default
    expect(c.minRows).toBe(10);              // valid integer >= 0 accepted
    expect(c.maxBytes).toBe(52428800);       // 0 fails strict >0 -> default
    expect(c.minDirtyBytes).toBe(1048576);   // negative fails >=1 -> default
  });

  it('rejects minDirtyBytes: 0 (it would make the byte branch always fire) and accepts 1', () => {
    const zero = tmpDir();
    writeFileSync(join(zero, 'config.json'), JSON.stringify({ compaction: { minDirtyBytes: 0 } }));
    expect(compactionConfigFromGlobal(zero).minDirtyBytes).toBe(1048576); // 0 out of [1,inf) -> default
    const one = tmpDir();
    writeFileSync(join(one, 'config.json'), JSON.stringify({ compaction: { minDirtyBytes: 1 } }));
    expect(compactionConfigFromGlobal(one).minDirtyBytes).toBe(1);        // inclusive lower bound accepted
  });
});
