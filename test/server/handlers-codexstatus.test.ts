import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCodexStatus, type CodexStatusDeps } from '../../src/server/handlers.js';
import type { CodexStatus } from '../../src/verify/codex.js';
import { DEFAULT_CONFIG, type HelixConfig } from '../../src/config.js';

const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? '').join('');

function deps(status: CodexStatus, over: Partial<CodexStatusDeps> = {}): CodexStatusDeps {
  return {
    inspect: async () => status,
    resolveModel: async () => null,   // default: unresolved; individual tests override
    config: structuredClone(DEFAULT_CONFIG),
    codexLogPath: join(mkdtempSync(join(tmpdir(), 'helix-cstat-')), 'codex-log.jsonl'),
    ...over,
  };
}
const enabledCfg = (): HelixConfig => ({
  dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'high', model: null, effort: null, timeoutMs: 120_000, egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block' }, logContent: false },
  metrics: { enabled: true },
});
const cfg = (over: Partial<HelixConfig['dualVerify']> = {}): HelixConfig => {
  const base = enabledCfg();
  return { ...base, dualVerify: { ...base.dualVerify, ...over } };
};
const LIVE: CodexStatus = { cliFound: true, version: '0.144.1', available: true, authMode: 'chatgpt' };

describe('handleCodexStatus', () => {
  it('found + logged-in ChatGPT subscription renders version, connection, inferred auth mode', async () => {
    const res = await handleCodexStatus(deps({ cliFound: true, version: '0.139.0', available: true, authMode: 'chatgpt' }));
    expect(text(res)).toContain('Helix');
    expect(text(res)).toContain('codex-cli 0.139.0');
    expect(text(res)).toMatch(/logged in/i);
    expect(text(res)).toMatch(/ChatGPT subscription \(inferred\)/i);
  });

  it('not found renders NOT FOUND, not logged in, no version', async () => {
    const res = await handleCodexStatus(deps({ cliFound: false, available: false, authMode: 'none', reason: 'codex CLI not found' }));
    expect(text(res)).toMatch(/NOT FOUND/i);
    expect(text(res)).toMatch(/not logged in/i);
  });

  it('api-key auth mode is shown', async () => {
    const res = await handleCodexStatus(deps({ cliFound: true, version: '0.139.0', available: true, authMode: 'api-key' }));
    expect(text(res)).toMatch(/API key/i);
  });

  it('unknown auth mode degrades gracefully (shown as unknown)', async () => {
    const res = await handleCodexStatus(deps({ cliFound: true, version: '0.139.0', available: true, authMode: 'unknown' }));
    expect(text(res)).toMatch(/unknown/i);
  });

  it('dual-verify disabled (DEFAULT_CONFIG) is reported', async () => {
    const res = await handleCodexStatus(deps({ cliFound: true, version: '0.139.0', available: true, authMode: 'chatgpt' }));
    expect(text(res)).toMatch(/dual-verify:\s*disabled/i);
  });

  it('dual-verify enabled shows the mode', async () => {
    const res = await handleCodexStatus(deps({ cliFound: true, version: '0.139.0', available: true, authMode: 'chatgpt' }, { config: enabledCfg() }));
    expect(text(res)).toMatch(/dual-verify:\s*enabled, mode=compare/i);
  });

  it('content log OFF (default) reports OFF and points at the opt-in key', async () => {
    const res = await handleCodexStatus(deps({ cliFound: true, version: '0.139.0', available: true, authMode: 'chatgpt' }));
    expect(text(res)).toMatch(/content log:\s*OFF/i);
    expect(text(res)).toMatch(/logContent/);
  });

  it('content log ON reports ON + path + entry count (counts existing lines, missing -> 0)', async () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'helix-cstaton-')), 'codex-log.jsonl');
    writeFileSync(logPath, '{"ts":"t","kind":"compare","outcome":"sent"}\n{"ts":"t","kind":"compare","outcome":"skipped"}\n');
    const onCfg: HelixConfig = { dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'high', model: null, effort: null, timeoutMs: 120_000, egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block' }, logContent: true }, metrics: { enabled: true } };
    const res = await handleCodexStatus(deps({ cliFound: true, version: '0.139.0', available: true, authMode: 'chatgpt' }, { config: onCfg, codexLogPath: logPath }));
    expect(text(res)).toMatch(/content log:\s*ON/i);
    expect(text(res)).toContain('2 entries');
  });

  it('content log ON with a missing file reports 0 entries (never throws)', async () => {
    const onCfg: HelixConfig = { dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'high', model: null, effort: null, timeoutMs: 120_000, egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block' }, logContent: true }, metrics: { enabled: true } };
    const res = await handleCodexStatus(deps({ cliFound: true, version: '0.139.0', available: true, authMode: 'chatgpt' }, { config: onCfg }));
    expect(text(res)).toMatch(/content log:\s*ON/i);
    expect(text(res)).toContain('0 entries');
  });
});

describe('handleCodexStatus: effective model / effort / timeout disclosure', () => {
  it('an explicit model is labelled an override and SKIPS the probe entirely', async () => {
    const resolveModel = vi.fn(async () => 'gpt-5.6-terra');
    const res = await handleCodexStatus(deps(LIVE, { config: cfg({ model: 'gpt-5.6-sol' }), resolveModel }));
    expect(text(res)).toMatch(/model:\s+gpt-5\.6-sol \(helix override\)/);
    expect(resolveModel).not.toHaveBeenCalled();   // codex's default cannot affect a run that passes -m
    expect(text(res)).not.toContain('gpt-5.6-terra');
  });

  it('an inherited model is resolved from codex and labelled inherited', async () => {
    const res = await handleCodexStatus(deps(LIVE, { config: cfg({ model: null }), resolveModel: async () => 'gpt-5.6-sol' }));
    expect(text(res)).toMatch(/model:\s+gpt-5\.6-sol \(inherited from codex config\)/);
  });

  it('a failed probe says unresolved and never invents a name', async () => {
    const res = await handleCodexStatus(deps(LIVE, { config: cfg({ model: null }), resolveModel: async () => null }));
    expect(text(res)).toMatch(/model:\s+inherited from codex config \(unresolved\)/);
    expect(text(res)).not.toMatch(/gpt-/);
  });

  it('a missing or logged-out CLI is not probed (nothing to answer with)', async () => {
    const spy = vi.fn(async () => 'gpt-5.6-sol');
    const absent = await handleCodexStatus(deps({ cliFound: false, available: false, authMode: 'none' }, { config: cfg({ model: null }), resolveModel: spy }));
    expect(spy).not.toHaveBeenCalled();
    expect(text(absent)).toMatch(/model:\s+inherited from codex config \(unresolved\)/);

    const out = vi.fn(async () => 'gpt-5.6-sol');
    await handleCodexStatus(deps({ cliFound: true, version: '0.144.1', available: false, authMode: 'none' }, { config: cfg({ model: null }), resolveModel: out }));
    expect(out).not.toHaveBeenCalled();
  });

  it('the probe is NOT gated on dualVerify.enabled (status answers "what if I turn this on")', async () => {
    const spy = vi.fn(async () => 'gpt-5.6-sol');
    const disabled = structuredClone(DEFAULT_CONFIG); // enabled: false, model: null
    const res = await handleCodexStatus(deps(LIVE, { config: disabled, resolveModel: spy }));
    expect(spy).toHaveBeenCalledOnce();
    expect(text(res)).toMatch(/dual-verify:\s+disabled/);
    expect(text(res)).toMatch(/model:\s+gpt-5\.6-sol \(inherited from codex config\)/);
  });

  it('effort is labelled override or inherited, and the timeout is always shown', async () => {
    const over = await handleCodexStatus(deps(LIVE, { config: cfg({ effort: 'xhigh', timeoutMs: 120_000 }) }));
    expect(text(over)).toMatch(/effort:\s+xhigh \(helix override\)/);
    expect(text(over)).toMatch(/timeout:\s+120000 ms/);

    const inherited = await handleCodexStatus(deps(LIVE, { config: cfg({ effort: null }) }));
    expect(text(inherited)).toMatch(/effort:\s+inherited from codex config/);
  });

  it('the timeout line carries no provenance label (helix does not track whether it was set)', async () => {
    const res = await handleCodexStatus(deps(LIVE, { config: cfg({ timeoutMs: 300_000 }) }));
    expect(text(res)).toMatch(/timeout:\s+300000 ms$/m);
    expect(text(res)).not.toMatch(/\(default\)/);
  });

  it('max and ultra at or below the hint ceiling emit the quota-loss note', async () => {
    for (const effort of ['max', 'ultra'] as const) {
      const res = await handleCodexStatus(deps(LIVE, { config: cfg({ effort, timeoutMs: 300_000 }) }));
      expect(text(res)).toContain('note:');
      expect(text(res)).toMatch(/quota is spent/);
      expect(text(res)).toContain('dualVerify.timeoutMs');
    }
  });

  it('the note is gated on RISK, not provenance: an explicit 300000 warns, 300001 does not', async () => {
    const at = await handleCodexStatus(deps(LIVE, { config: cfg({ effort: 'max', timeoutMs: 300_000 }) }));
    expect(text(at)).toContain('note:');
    const above = await handleCodexStatus(deps(LIVE, { config: cfg({ effort: 'max', timeoutMs: 300_001 }) }));
    expect(text(above)).not.toContain('note:');
  });

  it('no note for a fast effort, and none when effort is inherited (helix cannot know codex\'s)', async () => {
    const fast = await handleCodexStatus(deps(LIVE, { config: cfg({ effort: 'high', timeoutMs: 120_000 }) }));
    expect(text(fast)).not.toContain('note:');
    const unknown = await handleCodexStatus(deps(LIVE, { config: cfg({ effort: null, timeoutMs: 120_000 }) }));
    expect(text(unknown)).not.toContain('note:');
  });
});
