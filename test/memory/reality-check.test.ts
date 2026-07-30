import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRealityCheck, checkBinding } from '../../src/memory/reality-check.js';

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

describe('checkBinding (content-bound promotion gate)', () => {
  const content = 'the api base path is /v2/users in config app.json';
  it('binds when BOTH path and pattern appear in the item content', () => {
    expect(checkBinding(content, { kind: 'file-contains', path: 'app.json', pattern: '/v2/users' }).bound).toBe(true);
  });
  it('rejects when the path is not in the item content (launders an unrelated file)', () => {
    expect(checkBinding(content, { kind: 'file-contains', path: '/etc/hosts', pattern: '/v2/users' }).bound).toBe(false);
  });
  it('rejects when the pattern is not in the item content', () => {
    expect(checkBinding(content, { kind: 'file-contains', path: 'app.json', pattern: 'SECRET' }).bound).toBe(false);
  });
  it('rejects a trivial (<3 non-ws char) pattern', () => {
    expect(checkBinding('x y', { kind: 'file-contains', path: 'y', pattern: 'x' }).bound).toBe(false);
  });
  it('rejects a non-file-contains check (file-exists is non-promoting)', () => {
    expect(checkBinding(content, { kind: 'file-exists', path: 'app.json' }).bound).toBe(false);
  });
});

describe('runRealityCheck FAIL narrowing', () => {
  it('a MISSING file is indeterminate (not a determinate FAIL) — denies delete->demote', () => {
    const r = runRealityCheck({ kind: 'file-contains', path: '/no/such/file/here.xyz', pattern: 'anything' });
    expect(r).toEqual({ ran: false, indeterminate: true, passed: false });
  });
});

// N-RECHECK: the file-contains guard used to check `statSync(path).size` only — reported SIZE, never
// TYPE. A FIFO, a character device and most of /proc all report size 0, so the guard passed them
// straight into a synchronous readFileSync on the single-threaded MCP server's thread: a FIFO with
// no writer blocks open(2) FOREVER, and /dev/zero reads until the process dies. Neither is an I/O
// *error*, so runRealityCheck's catch never sees them. Reachable because checkBinding only requires
// the path and pattern to be raw substrings of the item's own content, and an agent can commit that
// content first.
const posixOnly = describe.skipIf(process.platform === 'win32');
posixOnly('file-contains refuses non-regular files', () => {
  it('returns INDETERMINATE for a FIFO with no writer instead of blocking forever', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-fifo-'));
    const fifo = join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    // The load-bearing assertion is that this CALL RETURNS AT ALL. Before the fix it never did, and
    // the failure surfaced as the whole test file timing out rather than as a wrong value.
    expect(runRealityCheck({ kind: 'file-contains', path: fifo, pattern: 'needle' }))
      .toEqual({ ran: false, indeterminate: true, passed: false });
  }, 10_000);

  it('returns INDETERMINATE for a character device instead of reading it unboundedly', () => {
    expect(runRealityCheck({ kind: 'file-contains', path: '/dev/zero', pattern: 'needle' }))
      .toEqual({ ran: false, indeterminate: true, passed: false });
  }, 10_000);

  it('still reads an ordinary regular file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-regular-'));
    const f = join(dir, 'notes.txt');
    writeFileSync(f, 'the needle is in here\n');
    expect(runRealityCheck({ kind: 'file-contains', path: f, pattern: 'needle' }))
      .toEqual({ ran: true, indeterminate: false, passed: true });
    expect(runRealityCheck({ kind: 'file-contains', path: f, pattern: 'haystack' }))
      .toEqual({ ran: true, indeterminate: false, passed: false });
  });
});
