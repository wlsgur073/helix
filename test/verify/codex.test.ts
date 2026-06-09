import { describe, it, expect } from 'vitest';
import { buildCodexExecArgs, interpretPreflight } from '../../src/verify/codex.js';

describe('buildCodexExecArgs', () => {
  it('builds the read-only, ephemeral, output-to-file exec command (verified vs codex-cli 0.138)', () => {
    expect(buildCodexExecArgs('what is 2+2?', '/tmp/out.txt')).toEqual([
      'exec', '--skip-git-repo-check', '-s', 'read-only', '--ephemeral', '-o', '/tmp/out.txt', 'what is 2+2?',
    ]);
  });
  it('passes the question verbatim as the final positional arg', () => {
    const args = buildCodexExecArgs('use --flags; and "quotes"', '/tmp/o');
    expect(args[args.length - 1]).toBe('use --flags; and "quotes"');
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
