import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock } from '../../src/memory/lock.js';

const target = (): string => join(mkdtempSync(join(tmpdir(), 'helix-lock-')), 'ledger.jsonl');

describe('withFileLock', () => {
  it('runs fn under the lock and removes the lock dir afterward', () => {
    const t = target();
    const r = withFileLock(t, () => 42);
    expect(r).toBe(42);
    expect(existsSync(t + '.lock')).toBe(false);
  });

  it('releases the lock even if fn throws', () => {
    const t = target();
    expect(() => withFileLock(t, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(t + '.lock')).toBe(false);
  });

  it('times out if the lock is held (fresh) past maxWaitMs', () => {
    const t = target();
    mkdirSync(t + '.lock'); // a live holder
    expect(() => withFileLock(t, () => 1, { maxWaitMs: 80 })).toThrow(/timed out/i);
  });

  it('steals a STALE lock (crashed holder) and proceeds', () => {
    const t = target();
    mkdirSync(t + '.lock');
    const old = new Date(Date.now() - 60_000);
    utimesSync(t + '.lock', old, old);
    let ran = false;
    withFileLock(t, () => { ran = true; }, { staleMs: 10_000, maxWaitMs: 200 });
    expect(ran).toBe(true);
    expect(existsSync(t + '.lock')).toBe(false);
  });
});
