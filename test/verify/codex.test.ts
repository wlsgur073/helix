import { describe, it, expect } from 'vitest';
import { buildCodexExecArgs, interpretPreflight, interpretWhereOutput } from '../../src/verify/codex.js';

describe('buildCodexExecArgs (prompt-via-stdin contract)', () => {
  it('builds the read-only, ephemeral, output-to-file command ending with "-" (verified vs codex-cli 0.138)', () => {
    expect(buildCodexExecArgs('/tmp/out.txt')).toEqual([
      'exec', '--skip-git-repo-check', '-s', 'read-only', '--ephemeral', '-o', '/tmp/out.txt', '-',
    ]);
  });

  it('never carries free text in argv — every element is a literal, the outFile, or a validated token', () => {
    expect(buildCodexExecArgs('/tmp/o', { model: 'gpt-5.5', effort: 'xhigh' })).toEqual([
      'exec', '--skip-git-repo-check', '-s', 'read-only', '--ephemeral', '-o', '/tmp/o',
      '-m', 'gpt-5.5', '-c', 'model_reasoning_effort=xhigh', '-',
    ]);
  });

  it('omits -m and -c when model/effort are null (inherit ~/.codex/config.toml)', () => {
    expect(buildCodexExecArgs('/tmp/o', { model: null, effort: null })).toEqual([
      'exec', '--skip-git-repo-check', '-s', 'read-only', '--ephemeral', '-o', '/tmp/o', '-',
    ]);
  });

  it('rejects a malformed model or effort (argv safety)', () => {
    expect(() => buildCodexExecArgs('/tmp/o', { model: 'bad; rm -rf' })).toThrow(/invalid codex model/i);
    expect(() => buildCodexExecArgs('/tmp/o', { effort: 'x high' })).toThrow(/invalid codex effort/i);
  });
});

describe('interpretWhereOutput (Windows-safe launcher resolution)', () => {
  const js = (dir: string) => `${dir}\\node_modules\\@openai\\codex\\bin\\codex.js`;

  it('POSIX: codex is directly spawnable, no resolution needed', () => {
    expect(interpretWhereOutput('linux', '', () => false)).toEqual({ file: 'codex', argsPrefix: [] });
  });

  it('win32: an npm .cmd shim resolves to its underlying codex.js, run by our own node', () => {
    const dir = 'C:\\nodejs';
    // `where codex` lists the extension-less POSIX-sh shim first, then the .cmd
    const out = `${dir}\\codex\r\n${dir}\\codex.cmd\r\n`;
    expect(interpretWhereOutput('win32', out, (p) => p === js(dir))).toEqual({
      file: process.execPath,
      argsPrefix: [js(dir)],
    });
  });

  it('win32: takes the first usable entry in PATH order (a native .exe is spawned directly)', () => {
    const out = 'C:\\tools\\codex.exe\r\nC:\\nodejs\\codex.cmd\r\n';
    expect(interpretWhereOutput('win32', out, () => true)).toEqual({ file: 'C:\\tools\\codex.exe', argsPrefix: [] });
  });

  it('win32: a .cmd whose codex.js cannot be found -> null (fail-closed; never shell:true)', () => {
    expect(interpretWhereOutput('win32', 'C:\\nodejs\\codex.cmd\r\n', () => false)).toBeNull();
  });

  it('win32: extension-less sh shims are skipped (CreateProcess cannot exec them)', () => {
    expect(interpretWhereOutput('win32', 'C:\\nodejs\\codex\r\n', () => true)).toBeNull();
  });

  it('win32: empty where output -> null', () => {
    expect(interpretWhereOutput('win32', '', () => false)).toBeNull();
  });
});

describe('interpretPreflight', () => {
  it('available when version matches and logged in', () => {
    expect(interpretPreflight('codex-cli 0.138.0', 'Logged in using ChatGPT')).toEqual({ available: true });
  });
  it('unavailable when the version string is absent (CLI not found)', () => {
    expect(interpretPreflight('command not found', 'Logged in using ChatGPT').available).toBe(false);
  });
  it('unavailable when not logged in', () => {
    const r = interpretPreflight('codex-cli 0.138.0', 'Not logged in');
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/login/i);
  });
});
