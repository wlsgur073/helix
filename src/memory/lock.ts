import { mkdirSync, rmSync, statSync } from 'node:fs';

// Cross-process advisory lock around the JSONL ledger. The .mcp.json ships no per-session
// isolation, so concurrent Claude Code sessions each run a helix-mcp process against the same
// ~/.helix/memory.jsonl. Without serialization a compaction (read -> rewrite -> rename) can
// drop a commit appended by another process, or a pre-erase snapshot can rewrite erased
// plaintext back in — violating the right-to-erasure guarantee. mkdir is atomic on every
// platform, so an empty lock directory is the mutex.

const DEFAULT_STALE_MS = 10_000; // a holder older than this is assumed crashed -> steal
const DEFAULT_MAX_WAIT_MS = 5_000;
const RETRY_MS = 25;

/** Block the current thread briefly without a busy CPU spin (sync, cross-platform). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface LockOptions {
  staleMs?: number;   // steal a lock whose dir mtime is older than this
  maxWaitMs?: number; // give up (throw) after waiting this long for a live lock
}

/** Run `fn` while holding an exclusive lock on `target`. Steals stale locks; times out on
 *  live contention. Always releases (even if `fn` throws). */
export function withFileLock<T>(target: string, fn: () => T, opts: LockOptions = {}): T {
  const lockDir = target + '.lock';
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  let waited = 0;

  for (;;) {
    try {
      mkdirSync(lockDir); // atomic acquire (EEXIST if held)
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let ageMs = 0;
      try { ageMs = Date.now() - statSync(lockDir).mtimeMs; } catch { ageMs = 0; /* vanished -> retry */ }
      if (ageMs > staleMs) {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* lost the steal race */ }
        continue; // retry acquire immediately
      }
      if (waited >= maxWaitMs) throw new Error(`withFileLock: timed out acquiring ${lockDir} after ${maxWaitMs}ms`);
      sleepSync(RETRY_MS);
      waited += RETRY_MS;
    }
  }

  try {
    return fn();
  } finally {
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* already released */ }
  }
}
