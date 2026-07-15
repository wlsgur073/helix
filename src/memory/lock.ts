import { readFileSync, writeFileSync, unlinkSync, linkSync, lstatSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, basename, join } from 'node:path';
import { classifyHolder, selfIdentity, tryParsePayload, realProbe, type HolderClass, type LivenessProbe, type LockPayload } from './lock-liveness.js';

// Cross-process advisory lock around the JSONL ledger. Concurrent helix-mcp processes (one per
// agent session, same host, same user, ONE kernel/boot domain — declared precondition) write the
// same ledger. The lock is a regular FILE published atomically WITH its owner payload via
// linkSync(sourceTmp, lockPath): the first instant the name exists its payload is complete, so a
// LIVE creator can never present a malformed lock (write completes and closes BEFORE link — the
// completeness invariant). Waiters classify the recorded holder with the liveness matrix
// (lock-liveness.ts): only a provably-DEAD holder is ever reclaimed (Task 4's reaper gate); age
// plays no role anywhere — age cannot distinguish suspension from death, and that misclassification
// was exactly the erased-plaintext-resurrection defect (D3). Uncertainty always waits.
// This lock defends against ACCIDENTAL concurrency + OS scheduling + crashes, not an adversary.

const RETRY_MS = 25;
const DEFAULT_MAX_WAIT_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface LockContext { stillOwned(): boolean; }
export interface LockOptions { maxWaitMs?: number; probe?: LivenessProbe; }

/** Canonicalize the TARGET so every spelling of the same ledger (symlinked cwd, etc.) maps to one
 *  lock path. realpath resolves symlinks, not hard links — hard-link aliases are refused at the
 *  write layer (nlink guard), not here. The parent dir must exist (callers mkdir it first). */
function canonical(target: string): string {
  try { return realpathSync(target); }
  catch { return join(realpathSync(dirname(target)), basename(target)); }
}

export function lockPathOf(target: string): string { return canonical(target) + '.lock'; }

/** Test-only helper: publish an arbitrary lock payload the same atomic way production does. */
export function writeLockFileForTest(lockPath: string, payload: object): void {
  const src = `${lockPath}.lk-${randomBytes(16).toString('hex')}.tmp`;
  writeFileSync(src, JSON.stringify(payload), { flag: 'wx' });
  try { linkSync(src, lockPath); } finally { unlinkSync(src); }
}

function timeoutMessage(lockPath: string, holder: LockPayload | null, waitedMs: number): string {
  const who = holder ? `held by pid ${holder.pid} (started ticks ${holder.startTicks ?? 'unknown'})` : 'holder unreadable (never auto-reclaimed)';
  return `withFileLock: timed out after ${waitedMs}ms acquiring ${lockPath} — ${who}. ` +
    `Verify liveness with: kill -0 <pid>. If (and only if) the holder is truly gone, remove the lock file manually.`;
}

export function withFileLock<T>(target: string, fn: (ctx: LockContext) => T, opts: LockOptions = {}): T {
  const probe = opts.probe ?? realProbe;
  const canon = canonical(target);
  const lockPath = canon + '.lock';
  const token = randomBytes(16).toString('hex');
  const self = selfIdentity(token, probe);
  const payloadText = JSON.stringify(self);
  if (tryParsePayload(payloadText) === null) throw new Error('withFileLock: internal — payload failed its own well-formedness check'); // completeness invariant, testable
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  let waited = 0;
  let lastHolder: LockPayload | null = null;

  for (;;) {
    const srcTmp = `${canon}.lk-${randomBytes(16).toString('hex')}.tmp`;
    try {
      writeFileSync(srcTmp, payloadText, { flag: 'wx' });   // full write returns before...
      try { linkSync(srcTmp, lockPath); break; }            // ...the name is published (atomic, with content)
      finally { try { unlinkSync(srcTmp); } catch { /* swept by a holder mid-flight — harmless */ } }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EOPNOTSUPP' || code === 'ENOTSUP')
        throw new Error(`withFileLock: filesystem refuses hard links for ${lockPath}; ledger locking is unsupported on this filesystem`);
      if (code === 'ENOENT') continue;                      // our source tmp was swept — retry
      if (code !== 'EEXIST') throw e;                       // real error (perms/disk) — bubble up untouched
    }

    // Held. Classify the recorded holder.
    let holder: HolderClass;
    lastHolder = null;
    try {
      const st = lstatSync(lockPath);
      if (st.isDirectory()) {
        holder = 'alive-unknown';                           // legacy dir: Task 4 adds pid-gated reclaim
      } else {
        const raw = readFileSync(lockPath, 'utf8');
        const parsed = tryParsePayload(raw);
        if (parsed === null) {
          const boot = probe.bootInstantMs();
          holder = boot !== null && st.mtimeMs < boot ? 'dead' : 'alive-unknown'; // dead litter: creator predates this boot
        } else {
          lastHolder = parsed;
          holder = classifyHolder(parsed, self, probe);
        }
      }
    } catch { continue; }                                   // vanished between attempts — retry immediately

    if (holder === 'reentrant-self')
      throw new Error(`withFileLock: re-entrant acquisition of ${lockPath} from the same thread (pid ${process.pid}) — withFileLock is not re-entrant`);
    // Task 4 replaces this: if (holder === 'dead') { stealUnderGate(...); continue; }
    if (waited >= maxWaitMs) throw new Error(timeoutMessage(lockPath, lastHolder, waited));
    sleepSync(RETRY_MS);
    waited += RETRY_MS;
  }

  const ctx: LockContext = {
    stillOwned() {
      try { return tryParsePayload(readFileSync(lockPath, 'utf8'))?.token === token; } catch { return false; }
    },
  };
  try {
    return fn(ctx);
  } finally {
    // Release ONLY a lock we can prove is ours. Anything else (foreign payload, legacy dir,
    // unreadable) is left in place — deleting it would free a lock someone else may hold.
    try {
      if (!lstatSync(lockPath).isDirectory() && tryParsePayload(readFileSync(lockPath, 'utf8'))?.token === token) unlinkSync(lockPath);
    } catch { /* gone/unreadable — cannot prove ownership — leave it */ }
  }
}
