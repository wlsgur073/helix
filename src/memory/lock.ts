import { mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

// Cross-process advisory lock around the JSONL ledger. The plugin ships no per-session
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
 *  live contention. Releases ONLY the lock it still owns (verified by a per-call token), so a
 *  holder whose lock was stolen — because its critical section outran staleMs or the process was
 *  suspended — cannot delete the lock a different process has since acquired. Always attempts a
 *  release (even if `fn` throws). */
export function withFileLock<T>(target: string, fn: () => T, opts: LockOptions = {}): T {
  const lockDir = target + '.lock';
  const ownerFile = join(lockDir, 'owner');
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`; // unique per acquisition
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  let waited = 0;

  for (;;) {
    let acquired = false;
    try {
      mkdirSync(lockDir);    // atomic acquire (EEXIST if held)
      acquired = true;
      writeFileSync(ownerFile, token); // stamp ownership so release can prove the lock is still ours
      break;
    } catch (e) {
      if (!acquired) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; // real error (perms/disk) — bubble up untouched
        let ageMs = 0;
        try { ageMs = Date.now() - statSync(lockDir).mtimeMs; } catch { ageMs = 0; /* vanished -> retry */ }
        if (ageMs > staleMs) {
          try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* lost the steal race */ }
          continue; // retry acquire immediately
        }
        if (waited >= maxWaitMs) throw new Error(`withFileLock: timed out acquiring ${lockDir} after ${maxWaitMs}ms`);
        sleepSync(RETRY_MS);
        waited += RETRY_MS;
        continue;
      }
      // We created the dir but stamping ownership failed: undo our own acquire (so we don't leak a
      // lock we cannot prove we own), then surface the error.
      try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* nothing to undo */ }
      throw e;
    }
  }

  try {
    return fn();
  } finally {
    // Release ONLY if we still own the lock. A mismatched/absent token means another holder stole
    // and re-acquired it while we ran (long critical section or OS suspend) — deleting it then would
    // free a lock that process is actively holding. Leave it; stale-steal will reclaim if orphaned.
    try {
      if (readFileSync(ownerFile, 'utf8') === token) rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* owner file unreadable/gone -> cannot prove ownership -> do not delete */
    }
  }
}
