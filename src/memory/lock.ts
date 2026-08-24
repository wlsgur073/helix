import { readFileSync, writeFileSync, unlinkSync, linkSync, lstatSync, realpathSync, rmSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { dirname, basename, join } from 'node:path';
import { classifyHolder, selfIdentity, tryParsePayload, realProbe, type HolderClass, type LivenessProbe, type LockPayload } from './lock-liveness.js';

// Cross-process advisory lock around the JSONL ledger. Concurrent helix-mcp processes (one per
// agent session, same host, same user, ONE kernel/boot domain, and ONE Linux time namespace —
// declared precondition) write the same ledger. The time namespace is named rather than left to
// "one boot" because it virtualizes /proc/uptime and CLOCK_BOOTTIME alike: two processes inside a
// single boot then read different uptimes, which would let the cross-boot witness call a LIVE
// holder dead, and a containerised deployment sharing this lock across that boundary reads as
// satisfying the sentence while violating the witness. The lock is a regular FILE published
// atomically WITH its owner payload via linkSync(sourceTmp, lockPath): the first instant the name
// exists its payload is complete, so a LIVE creator can never present a malformed lock (write
// completes and closes BEFORE link — the completeness invariant). Waiters classify the recorded
// holder with the liveness matrix (lock-liveness.ts): only a provably-DEAD holder is ever
// reclaimed (Task 4's reaper gate); age plays no role anywhere — age cannot distinguish suspension
// from death, and that misclassification was exactly the erased-plaintext-resurrection defect
// (D3). Uncertainty always waits.
// This lock defends against ACCIDENTAL concurrency + OS scheduling + crashes, not an adversary.

const RETRY_MS = 25;
const DEFAULT_MAX_WAIT_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface LockContext { stillOwned(): boolean; }
export interface LockOptions { maxWaitMs?: number; probe?: LivenessProbe; }

/** THE shared path-identity rule for BOTH the lock layer AND the ledger write layer (append +
 *  compaction) — export it so ledger.ts resolves the SAME identity the lock does. Every spelling of
 *  one ledger (a symlinked cwd, or a symlink standing in for the ledger FILE itself) must map to one
 *  path, or the lock would guard a different inode than the writes touch: a compaction renaming over
 *  a symlink alias turns the alias into a regular file while appends follow the link to the real
 *  inode, and the pre-compaction plaintext (incl. permanently-erased content) survives on that inode
 *  — the erase claim broken. realpath resolves symlinks, not hard links — hard-link aliases are
 *  refused at the write layer (nlink guard), not here. The parent dir must exist (callers mkdir it
 *  first). */
export function canonical(target: string): string {
  try { return realpathSync(target); }
  catch { return join(realpathSync(dirname(target)), basename(target)); }
}

export function lockPathOf(target: string): string { return canonical(target) + '.lock'; }

/** Test-only helper: publish an arbitrary lock payload the same atomic way production does. */
export function writeLockFileForTest(lockPath: string, payload: object): void {
  const src = `${lockPath}.lk-${randomBytes(16).toString('hex')}.tmp`;
  writeFileSync(src, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });   // match production exactly
  try { linkSync(src, lockPath); } finally { unlinkSync(src); }
}

/** The only thing an operator sees when acquisition fails, so it must not recommend an inference this
 *  file refuses to make for itself. It used to say "Verify liveness with: kill -0 <pid>", which is the
 *  one check that cannot decide the case: kill -0 answers that SOME process holds the pid, never that
 *  it is the process that took the lock. On a platform that records no start time — the situation
 *  that produces this timeout — a reused pid answers alive, so the advice handed the operator exactly
 *  the misclassification that age-based stealing was rejected for, and then told them to delete the
 *  lock on the strength of it. */
function timeoutMessage(lockPath: string, holder: LockPayload | null, waitedMs: number): string {
  const head = `withFileLock: timed out after ${waitedMs}ms acquiring ${lockPath}`;
  if (holder === null) {
    return `${head} — holder unreadable, so it is never auto-reclaimed. Inspect ${lockPath} by hand; ` +
      `a lock file that does not parse was not written by this version.`;
  }
  const who = `held by pid ${holder.pid} (recorded start ${holder.startTicks ?? 'NONE — this platform does not expose one'})`;
  const identify = holder.startTicks === null
    ? `Because no start time was recorded, a waiter cannot tell the original holder from an unrelated ` +
      `process that later reused pid ${holder.pid}; kill -0 cannot separate them either. Identify it: ` +
      `ps -p ${holder.pid} -o pid,lstart,command — and confirm it is a Helix run before acting.`
    : `The holder classified live on every attempt. Confirm it is the run that took the lock by ` +
      `comparing its start time against the value above (ps -p ${holder.pid} -o pid,lstart,command).`;
  return `${head} — ${who}. ${identify} ` +
    `Removing the lock while its holder is merely SUSPENDED reintroduces the concurrency this lock prevents.`;
}

interface AcquiredLock { ctx: LockContext; release: () => void }

/** Shared acquire path for withFileLock/withFileLockAsync (extracted; zero behavior change for
 *  existing synchronous callers — same publish/contend/classify/reclaim loop, same error
 *  messages). Returns the acquired LockContext plus a release() thunk; deciding how the held
 *  section runs (sync return vs awaited) is the caller's job. */
function acquireFileLock(target: string, opts: LockOptions = {}): AcquiredLock {
  const probe = opts.probe ?? realProbe;
  const canon = canonical(target);
  const lockPath = canon + '.lock';
  const token = randomBytes(16).toString('hex');
  const self = selfIdentity(token, probe);
  // `self` is the STABLE identity and is built once on purpose: pid, start ticks, boot id and pid
  // namespace are what other processes match this holder against, and re-deriving them per attempt
  // would put avoidable variation into the one artifact they depend on. `self` is also what every
  // loop iteration classifies incumbents against — do NOT let the refresh below touch it.
  // The WITNESS is different: it is a measurement of when this attempt happened, so it is resampled
  // for each creation attempt below (contract 9). `self.uptimeSec`, sampled once here by
  // selfIdentity, is NOT that witness — it is always superseded by the per-attempt sample in the
  // published payload below, and must never be read as one.
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  // MEASURED elapsed, not a retry tally. This used to be `waited += RETRY_MS` per pass, i.e. a count
  // of retries reported in milliseconds — so under scheduling pressure a `maxWaitMs: 500` call could
  // block for SECONDS and then report "timed out after 500ms". Two defects in one: a budget that did
  // not bind, and a false number in the one message that tells an operator to go check a pid.
  // performance.now() is monotonic — unlike Date.now() it cannot step backward and silently stretch
  // (or collapse) the budget, which matters on this project's primary platform.
  // NOTE this is a real deadline now: under heavy contention acquisition gives up sooner than the
  // old tally did. That is the intended meaning of the parameter, and it stays fail-safe — a waiter
  // that gives up never steals a live holder's lock.
  const startedAt = performance.now();
  const elapsedMs = (): number => Math.round(performance.now() - startedAt);
  // Sleep the retry cadence, but never past the deadline: the next pass should throw rather than
  // overshoot the caller's budget by up to one RETRY_MS. Floor of 1ms so a nearly-exhausted budget
  // still yields the CPU instead of spinning.
  const sleepWithinBudget = (): void => sleepSync(Math.max(1, Math.min(RETRY_MS, maxWaitMs - elapsedMs())));
  let lastHolder: LockPayload | null = null;

  for (;;) {
    const srcTmp = `${canon}.lk-${randomBytes(16).toString('hex')}.tmp`;
    // Serialise THIS attempt's payload, with a witness sampled for THIS attempt, and validate the
    // exact bytes about to be published. The completeness invariant is about the bytes that reach
    // the name, not about a representative built once: a check that passes on a payload which is
    // then discarded has validated something that is not the artifact — the same defect class as
    // reasoning about a stale sample on the read side. Cost is one field assignment, one
    // JSON.stringify and one parse of a nine-field flat object per pass: microseconds against a
    // 25 ms cadence that already performs a write, a link, an unlink and an lstat.
    const payloadText = JSON.stringify({ ...self, uptimeSec: probe.uptimeSec() });
    // A failure here is an INTERNAL defect, not contention, so it aborts rather than retrying.
    if (tryParsePayload(payloadText) === null) throw new Error('withFileLock: internal — payload failed its own well-formedness check');
    try {
      writeFileSync(srcTmp, payloadText, { flag: 'wx', mode: 0o600 });   // full write returns before...
      try { linkSync(srcTmp, lockPath); break; }            // ...the name is published (atomic, with content)
      finally { try { unlinkSync(srcTmp); } catch { /* swept by a holder mid-flight — harmless */ } }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EOPNOTSUPP' || code === 'ENOTSUP')
        throw new Error(`withFileLock: filesystem refuses hard links for ${lockPath}; ledger locking is unsupported on this filesystem`);
      if (code === 'ENOENT') {                              // srcTmp swept mid-flight, OR the ledger's dir vanished mid-acquire — retry ON THE BUDGET
        if (elapsedMs() >= maxWaitMs) throw new Error(timeoutMessage(lockPath, null, elapsedMs())); // a vanished dir throws ENOENT every pass; a bare non-yielding `continue` would spin at 100% CPU forever (the stealUnderGate fall-through class), so route it through the normal cadence
        sleepWithinBudget();
        continue;
      }
      if (code !== 'EEXIST') throw e;                       // real error (perms/disk) — bubble up untouched
    }

    // Held. Classify the recorded holder.
    let holder: HolderClass;
    lastHolder = null;
    try {
      const st = lstatSync(lockPath);
      if (st.isDirectory()) {
        holder = classifyLegacyDir(lockPath, probe);         // legacy dir: pid-gated reclaim (owner file)
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
    // A provably-dead holder gets ONE gated reclaim attempt, then we fall through to the normal
    // retry cadence (budget check + sleep) rather than continue-ing: a contended/stuck gate makes
    // stealUnderGate a no-op, and an unconditional continue there would spin without ever advancing
    // `waited` — a non-yielding infinite loop. Falling through means a stuck gate simply times out
    // (automatic reclaim disabled until repair, the documented fail-closed residue). The steal
    // grants nothing: the loop still re-publishes from scratch on the next pass.
    if (holder === 'dead') stealUnderGate(lockPath, probe);
    if (elapsedMs() >= maxWaitMs) throw new Error(timeoutMessage(lockPath, lastHolder, elapsedMs()));
    sleepWithinBudget();
  }

  const ctx: LockContext = {
    stillOwned() {
      try { return tryParsePayload(readFileSync(lockPath, 'utf8'))?.token === token; } catch { return false; }
    },
  };
  const release = (): void => {
    // Release ONLY a lock we can prove is ours. Anything else (foreign payload, legacy dir,
    // unreadable) is left in place — deleting it would free a lock someone else may hold.
    try {
      if (!lstatSync(lockPath).isDirectory() && tryParsePayload(readFileSync(lockPath, 'utf8'))?.token === token) unlinkSync(lockPath);
    } catch { /* gone/unreadable — cannot prove ownership — leave it */ }
  };
  return { ctx, release };
}

export function withFileLock<T>(target: string, fn: (ctx: LockContext) => T, opts: LockOptions = {}): T {
  const { ctx, release } = acquireFileLock(target, opts);
  try {
    return fn(ctx);
  } finally {
    release();
  }
}

/** Async-aware sibling of withFileLock, for a critical section that must `await` something WHILE
 *  still holding the lock (e.g. an interactive confirmation — scripts/rebaseline-cli.ts, spec §6,
 *  is the first caller). This CANNOT be expressed as `withFileLock(target, async (ctx) => {...})`:
 *  withFileLock's body is `try { return fn(ctx); } finally { release(); }`. When `fn` is an async
 *  function, `fn(ctx)` runs synchronously only up to its first `await`, then synchronously returns
 *  a PENDING promise — `return fn(ctx)` hands that pending promise straight to `finally`, which
 *  runs IMMEDIATELY (a `finally` after a bare `return <promise>` does not wait for the promise to
 *  settle). The lock would be released the instant `fn` hit its first `await`, not once `fn`
 *  logically finished — silently defeating "held across the await" (verified empirically: a
 *  probe script confirmed the release log line fires before the awaited callback resumes).
 *  This sibling instead `await`s `fn(ctx)` INSIDE the try, so `finally`/`release()` only runs
 *  once the async work has actually settled. Acquisition reuses the IDENTICAL synchronous loop
 *  (acquireFileLock) — only the held-scope call and release are sequenced differently. */
export async function withFileLockAsync<T>(target: string, fn: (ctx: LockContext) => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const { ctx, release } = acquireFileLock(target, opts);
  try {
    return await fn(ctx);
  } finally {
    release();
  }
}

/** Legacy (pre-redesign) lock DIRECTORY: owner file carries `pid-hex`. kill0-only classification —
 *  no ticks/boot/ns were recorded. An OWNERLESS dir is permanently alive-unknown: the old holder
 *  may sit suspended between its mkdir and its owner stamp, and no evidence can distinguish that
 *  from a crash — manual removal only (the timeout error names the path). */
function classifyLegacyDir(lockPath: string, probe: LivenessProbe): HolderClass {
  let raw: string;
  try { raw = readFileSync(join(lockPath, 'owner'), 'utf8'); } catch { return 'alive-unknown'; }
  const pid = Number(raw.split('-')[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'alive-unknown';
  const k = probe.kill0(pid);
  if (k === 'dead') return 'dead';
  if (k === 'unknown') return 'alive-unknown';
  const st = probe.stateOf(pid);
  return st === 'Z' || st === 'X' ? 'dead' : 'alive';
}

/** Serialize EVERY reclaim through a per-boot gate so two reapers can never both act on the same
 *  victim: the second reaper's delayed unlink removing the first one's FRESH lock was the last
 *  double-hold execution left (Codex round 2). The gate is never auto-stolen within its own boot —
 *  a reaper crash inside this tiny section disables automatic reclaim until reboot or manual
 *  repair (documented fail-closed residue). Gates from other boots are inert litter: removable. */
function stealUnderGate(lockPath: string, probe: LivenessProbe): void {
  const bootId = probe.bootId() ?? 'noboot';
  const gatePath = `${lockPath}.reap.${bootId}`;
  const dir = dirname(lockPath);
  const prefix = `${basename(lockPath)}.reap.`;
  for (const name of readdirSyncSafe(dir)) {                       // other-boot gate litter
    if (name.startsWith(prefix) && name !== basename(gatePath)) { try { unlinkSync(join(dir, name)); } catch { /* raced */ } }
  }
  const gateToken = randomBytes(16).toString('hex');
  const gateSrc = `${gatePath}.src-${gateToken}.tmp`;
  try {
    writeFileSync(gateSrc, JSON.stringify(selfIdentity(gateToken, probe)), { flag: 'wx', mode: 0o600 });
    try { linkSync(gateSrc, gatePath); } finally { try { unlinkSync(gateSrc); } catch { /* raced */ } }
  } catch { return; }                                              // gate busy (same boot) — no steal this round
  try {
    const st = lstatSync(lockPath);
    if (st.isDirectory()) {
      if (classifyLegacyDir(lockPath, probe) !== 'dead') return;   // re-verify under the gate
      rmSync(lockPath, { recursive: true, force: true });
    } else {
      const raw = readFileSync(lockPath, 'utf8');
      const parsed = tryParsePayload(raw);
      if (parsed !== null) {
        if (classifyHolder(parsed, selfIdentity(gateToken, probe), probe) !== 'dead') return; // changed/alive — abandon
      } else {
        const boot = probe.bootInstantMs();
        if (boot === null || st.mtimeMs >= boot) return;           // malformed but same-boot — abandon
      }
      unlinkSync(lockPath);
    }
  } catch { /* victim vanished or fs error — abandon; outer loop re-evaluates */ }
  finally {
    try { if (tryParsePayload(readFileSync(gatePath, 'utf8'))?.token === gateToken) unlinkSync(gatePath); } catch { /* leave */ }
  }
}

function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
