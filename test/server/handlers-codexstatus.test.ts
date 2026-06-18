import { describe, it, expect } from 'vitest';
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
    config: structuredClone(DEFAULT_CONFIG),
    codexLogPath: join(mkdtempSync(join(tmpdir(), 'helix-cstat-')), 'codex-log.jsonl'),
    ...over,
  };
}
const enabledCfg = (): HelixConfig => ({
  dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'high', model: null, effort: null, timeoutMs: 120_000, memoryEgress: 'block', logContent: false },
});

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
    const onCfg: HelixConfig = { dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'high', model: null, effort: null, timeoutMs: 120_000, memoryEgress: 'block', logContent: true } };
    const res = await handleCodexStatus(deps({ cliFound: true, version: '0.139.0', available: true, authMode: 'chatgpt' }, { config: onCfg, codexLogPath: logPath }));
    expect(text(res)).toMatch(/content log:\s*ON/i);
    expect(text(res)).toContain('2 entries');
  });

  it('content log ON with a missing file reports 0 entries (never throws)', async () => {
    const onCfg: HelixConfig = { dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'high', model: null, effort: null, timeoutMs: 120_000, memoryEgress: 'block', logContent: true } };
    const res = await handleCodexStatus(deps({ cliFound: true, version: '0.139.0', available: true, authMode: 'chatgpt' }, { config: onCfg }));
    expect(text(res)).toMatch(/content log:\s*ON/i);
    expect(text(res)).toContain('0 entries');
  });
});
