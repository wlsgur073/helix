import { describe, it, expect } from 'vitest';
import { buildCodexExecArgs, interpretPreflight } from '../../src/verify/codex.js';

describe('buildCodexExecArgs', () => {
  it('builds the read-only, ephemeral, output-to-file exec command (verified vs codex-cli 0.138)', () => {
    expect(buildCodexExecArgs('what is 2+2?', '/tmp/out.txt')).toEqual([
      'exec', '--skip-git-repo-check', '-s', 'read-only', '--ephemeral', '-o', '/tmp/out.txt', 'what is 2+2?',
    ]);
  });
  it('passes the question verbatim as the final positional arg (mid-string flags are inert)', () => {
    const args = buildCodexExecArgs('use --flags; and "quotes"', '/tmp/o');
    expect(args[args.length - 1]).toBe('use --flags; and "quotes"');
  });

  it('refuses a leading-dash question (argv flag-smuggling guard)', () => {
    expect(() => buildCodexExecArgs('--dangerously-bypass-approvals-and-sandbox', '/tmp/o')).toThrow(/flag-smuggling|start with/i);
    expect(() => buildCodexExecArgs('  -s danger-full-access', '/tmp/o')).toThrow();
  });

  it('adds -m model and -c model_reasoning_effort when opts given', () => {
    expect(buildCodexExecArgs('q', '/tmp/o', { model: 'gpt-5.5', effort: 'xhigh' })).toEqual([
      'exec', '--skip-git-repo-check', '-s', 'read-only', '--ephemeral', '-o', '/tmp/o',
      '-m', 'gpt-5.5', '-c', 'model_reasoning_effort=xhigh', 'q',
    ]);
  });

  it('omits -m when model is null (inherit codex default), still sets effort', () => {
    const args = buildCodexExecArgs('q', '/tmp/o', { model: null, effort: 'high' });
    expect(args).not.toContain('-m');
    expect(args).toContain('model_reasoning_effort=high');
  });

  it('rejects a malformed model (argv safety)', () => {
    expect(() => buildCodexExecArgs('q', '/tmp/o', { model: 'bad; rm -rf' })).toThrow(/invalid codex model/i);
  });

  it('omits both -m and -c when model and effort are null (full inherit from codex config)', () => {
    expect(buildCodexExecArgs('q', '/tmp/o', { model: null, effort: null })).toEqual([
      'exec', '--skip-git-repo-check', '-s', 'read-only', '--ephemeral', '-o', '/tmp/o', 'q',
    ]);
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
