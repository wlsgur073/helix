import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRealityCheck } from '../../src/memory/reality-check.js';

function tmpFile(content: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'helix-rc-')), 'f.txt');
  writeFileSync(p, content);
  return p;
}

describe('runRealityCheck', () => {
  it('file-exists passes when the file exists, fails (determinate) when not', () => {
    const p = tmpFile('hello');
    expect(runRealityCheck({ kind: 'file-exists', path: p })).toEqual({ ran: true, indeterminate: false, passed: true });
    expect(runRealityCheck({ kind: 'file-exists', path: p + '.nope' })).toEqual({ ran: true, indeterminate: false, passed: false });
  });

  it('file-contains passes when the pattern is present', () => {
    const p = tmpFile('the db is postgres');
    expect(runRealityCheck({ kind: 'file-contains', path: p, pattern: 'postgres' }).passed).toBe(true);
    expect(runRealityCheck({ kind: 'file-contains', path: p, pattern: 'mysql' }).passed).toBe(false);
  });

  it('file-contains on an oversized file is indeterminate (read DoS guard, fail-closed)', () => {
    const p = tmpFile('x'.repeat(5_000_001)); // > MAX_FILE_BYTES (5_000_000)
    expect(runRealityCheck({ kind: 'file-contains', path: p, pattern: 'x' }))
      .toEqual({ ran: false, indeterminate: true, passed: false });
  });

  it('fail-closed: unknown kind is indeterminate, never passed', () => {
    const r = runRealityCheck({ kind: 'telepathy' } as never);
    expect(r.indeterminate).toBe(true);
    expect(r.passed).toBe(false);
  });

  it('fail-closed: a malformed trigger is indeterminate, never passed', () => {
    const bad = runRealityCheck({ kind: 'file-exists' } as never);
    expect(bad).toEqual({ ran: false, indeterminate: true, passed: false });
  });
});
