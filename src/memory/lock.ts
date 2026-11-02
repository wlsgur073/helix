import { writeFileSync, unlinkSync, linkSync, lstatSync, rmSync, readdirSync, openSync, closeSync, readSync, fstatSync, existsSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { dirname, basename, join } from 'node:path';
import { classifyHolder, selfIdentity, tryParsePayload, realProbe, type HolderClass, type LivenessProbe, type LockPayload } from './lock-liveness.js';
import { resolvedPathOrThrow } from './path-identity.js';

// Cross-process advisory lock around the JSONL ledger. Concurrent helix-mcp processes (one per
// agent session, same host, same user, ONE kernel/boot domain — declared precondition) write the
// same ledger. A shared Linux time namespace is NOT a precondition: /proc/uptime and a process's
// start ticks are both read through the READING process's time namespace, so two processes in
// namespaces with different boottime offsets read different values for the same fact — the
// situation a containerised deployment sharing this lock across that boundary produces. Rather
// than assume the boundary away, classifyHolder (lock-liveness.ts) records each side's time
// namespace identity and refuses both time-derived proofs where the identities differ or either
// side has none to compare (D-28, 2026-09-20); that uncertainty resolves to alive-unknown, never
// to evidence. The ONE residual is the malformed-payload litter check (`mtimeMs <
// probe.bootInstantMs()`), present at one site below, readLockHolder, which the acquirer, the reader
// wait and the reaper's re-verification share: an unparseable payload carries no recorded identity
// to compare a namespace against, and no namespace-independent boot instant exists, so that site
// still reads the file's mtime against THIS process's own boot instant.
// During a mixed-build rollout (the launch barrier means a running process keeps its old bytes
// until restarted), an old-build holder's payload carries no timeNs — absent, normalizes to null
// — so it never matches a new-build waiter's real value and the recycled-pid proof cannot fire
// against it; rule 2 (bootId, not namespaced) and rule 4 (kill0 reporting the pid gone) still
// prove death on their own, and bootId already subsumes rule 2b's cross-boot case on Linux, so
// the degradation is bounded to same-boot pid-recycle detection and resolves to waiting, never
// to a false dead — the safe direction by design. The lock is a regular FILE published
// atomically WITH its owner payload via linkSync(sourceTmp, lockPath): the first instant the name
// exists its payload is complete, so a LIVE creator can never present a malformed lock (write
// completes and closes BEFORE link — the completeness invariant). Waiters classify the recorded
// holder with the liveness matrix (lock-liveness.ts): only a provably-DEAD holder is ever
// reclaimed (Task 4's reaper gate); age plays no role anywhere — age cannot distinguish suspension
// from death, and that misclassification was exactly the erased-plaintext-resurrection defect
// (D3). Uncertainty always waits, with one exception (D8): an object Helix never publishes at a
// lock path (a link, a FIFO, a socket, a device) is refused at once.
// This lock defends against ACCIDENTAL concurrency + OS scheduling + crashes, not an adversary.

const RETRY_MS = 25;
const DEFAULT_MAX_WAIT_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface LockContext { stillOwned(): boolean; readonly path: string; }
export interface LockOptions { maxWaitMs?: number; probe?: LivenessProbe; }

/** The lock path of a target: the path resolver's answer (path-identity.ts resolvePath) plus `.lock`, so the lock
 *  guards the file the kernel reaches through every spelling, a dangling link included (it locks beside the link's
 *  TARGET: M67). An unresolvable path throws UnresolvablePathError, one that cannot be inspected throws its own fs
 *  error, a missing folder throws the kernel's ENOENT: nothing is ever published into a folder that is not there.
 *  Registry and witness scope KEYS do not use this: path-identity.ts canonicalRoot keeps Node's JS realpath. */
export function lockPathOf(target: string): string { return resolvedPathOrThrow(target) + '.lock'; }

/** Test-only helper: publish an arbitrary lock payload the same atomic way production does. */
export function writeLockFileForTest(lockPath: string, payload: object): void {
  const src = `${lockPath}.lk-${randomBytes(16).toString('hex')}.tmp`;
  writeFileSync(src, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });   // match production exactly
  try { linkSync(src, lockPath); } finally { unlinkSync(src); }
}

/** Why the acquire loop gave up, which decides the sentence after the timeout message's head. */
type TimeoutCause =
  | { kind: 'payload'; holder: LockPayload }   // a holder that parsed: its pid, its start time and how to identify it
  | { kind: 'unparseable' }                    // a regular file whose content is not a lock payload, or is over the read cap
  | { kind: 'unreadable' }                     // the file exists but its holder could not be read or identified
  | { kind: 'no-directory' }                   // the publish step answered ENOENT at the budget end and the lock's folder is not there
  | { kind: 'legacy-dir' }                     // locks-R5: a legacy lock directory that did not classify dead
  | { kind: 'vanished' };                      // locks-R5: the budget ran out with the lock free (read absent, or cleared by this call) and its one more publication spent

/** The only thing an operator sees when acquisition fails, so it must not recommend an inference this
 *  file refuses to make for itself. It used to say "Verify liveness with: kill -0 <pid>", which is the
 *  one check that cannot decide the case: kill -0 answers that SOME process holds the pid, never that
 *  it is the process that took the lock. On a platform that records no start time — the situation
 *  that produces this timeout — a reused pid answers alive, so the advice handed the operator exactly
 *  the misclassification that age-based stealing was rejected for, and then told them to delete the
 *  lock on the strength of it. */
function timeoutMessage(lockPath: string, cause: TimeoutCause, waitedMs: number): string {
  const head = `withFileLock: timed out after ${waitedMs}ms acquiring ${lockPath}`;
  switch (cause.kind) {
    case 'unparseable':
      return `${head} — the lock file does not parse as a lock this version writes (it is empty, holds other content, ` +
        `or is larger than a lock payload), so its holder cannot be identified and it is not reclaimed in the boot it ` +
        `was written in. Inspect ${lockPath} by hand.`;
    case 'unreadable':
      return `${head} — the lock file exists but its holder could not be read or identified (a permission or I/O error, ` +
        `or a failed liveness check), so it is never auto-reclaimed. Inspect ${lockPath} by hand.`;
    case 'no-directory':
      return `${head} — the lock could not be published because its directory does not exist (it was removed, or a path ` +
        `component is missing). Nothing holds this lock; check the folder of ${lockPath}.`;
    case 'legacy-dir':
      return `${head} — a lock directory written by an older version stands there and its owner could not be shown dead, ` +
        `so it is never auto-reclaimed. Inspect ${lockPath} by hand.`;
    case 'vanished':
      return `${head} — the lock was free at the last look, but another process held it on every earlier attempt inside ` +
        `the budget (contention, not a stuck holder). Try again.`;
    case 'payload': {
      const holder = cause.holder;
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
  }
}

export const LOCK_FOREIGN_OBJECT_REFUSAL =
  'withFileLock: the lock file for this path is not a lock Helix wrote (a link, a FIFO, a socket or a device ' +
  'stands at its name) — refusing to read it or wait on it. Ask the user to look at that object and remove it; do ' +
  'not remove it for them.';
export class LockForeignObjectError extends Error {
  readonly lockForeignObject = true;   // the marker isLockForeignObjectError reads
  constructor() { super(LOCK_FOREIGN_OBJECT_REFUSAL); this.name = 'LockForeignObjectError'; }
}
export const isLockForeignObjectError = (e: unknown): boolean =>
  e instanceof Error && (e as { lockForeignObject?: unknown }).lockForeignObject === true;

/** The lock could not be PUBLISHED because its directory refuses the write (EACCES) or stands on a read-only file
 *  system (EROFS). The fs error keeps its class, code and message; the mark only says at which step it was raised, so
 *  the project-scope write can answer with its fixed text (design 4.3 step 2, 13.3 decision 5) and never mistake an
 *  EACCES raised inside the critical section (the registry's or the key's lock, a home that cannot be written) for it. */
export const isLockPublishRefusedError = (e: unknown): boolean =>
  e instanceof Error && (e as { lockPublishRefused?: unknown }).lockPublishRefused === true;

function markPublishRefused(e: unknown): unknown {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if ((code === 'EACCES' || code === 'EROFS') && e instanceof Error) {
    try { Object.assign(e, { lockPublishRefused: true }); } catch { /* a frozen error keeps its own text */ }
  }
  return e;
}

/** The wait for the lock ran out of its budget (any cause sentence of `timeoutMessage`). The mark says that and the cause
 *  kind (`lockTimeoutCauseOf`); the text keeps its lock path. The store answers the adopt operation with a fixed text chosen
 *  by the cause (14 decision 8, t-07; 14 item 19). */
export const isLockTimeoutError = (e: unknown): boolean =>
  e instanceof Error && (e as { lockTimedOut?: unknown }).lockTimedOut === true;

/** The kinds of cause a lock wait that ran out of its budget can carry (the `kind` of `TimeoutCause`). */
export type LockTimeoutCause = TimeoutCause['kind'];

/** The cause kind of a lock wait that ran out of its budget, or null when the error carries no such mark. The store answers
 *  the adopt operation by it (14 item 19): another writer ('payload', 'vanished'), a folder that went away ('no-directory'),
 *  or a lock Helix cannot identify ('unreadable', 'unparseable', 'legacy-dir'). */
export function lockTimeoutCauseOf(e: unknown): LockTimeoutCause | null {
  if (!isLockTimeoutError(e)) return null;
  const kind = (e as { lockTimeoutCause?: unknown }).lockTimeoutCause;
  return typeof kind === 'string' ? kind as LockTimeoutCause : null;
}

function markTimedOut(e: Error, kind: LockTimeoutCause): Error { return Object.assign(e, { lockTimedOut: true, lockTimeoutCause: kind }); }

interface AcquiredLock { ctx: LockContext; release: () => void }

/** Locks THIS thread published and could not take down when it released them (finding v-firstwrite-05 of the
 *  B1 prototype; spec 4.5 does not speak about the release). A lock is released by its path, after the token
 *  at that path was read back. When the path leads somewhere else at that moment (the folder the lock stands
 *  in was replaced while the lock was held), or the file cannot be read, the release proves nothing and
 *  leaves everything in place: the lock file stays where it was published, recording a holder that is alive.
 *  Every other process then waits its budget on it, and this thread's own next acquisition classified it
 *  'reentrant-self' and threw until the process ended.
 *
 *  So the release keeps the pair (lock path, token), in memory only, and the acquirer takes such a lock down
 *  as soon as its own token stands at the path again: before the loop, and in it when it meets its own token
 *  as the holder. The proof is the release's own, the random token this thread minted for an acquisition
 *  whose critical section has ended; nothing is removed on the strength of a pid. Bounded at ORPHAN_MAX pairs
 *  (ruling t-04): a pair whose path never leads back is dropped, oldest first, and its lock stays where it
 *  stands. Insertion order is age. */
const ORPHAN_MAX = 64;
const orphanedOwnLocks = new Map<string, string>();   // token -> the lock path it was published at

function rememberOrphan(lockPath: string, token: string): void {
  orphanedOwnLocks.set(token, lockPath);
  while (orphanedOwnLocks.size > ORPHAN_MAX) {
    const oldest = orphanedOwnLocks.keys().next();
    if (oldest.done === true) break;
    orphanedOwnLocks.delete(oldest.value);
  }
}

/** Take down every remembered lock whose token stands at its path again; answers whether the lock at `at`
 *  was one of them. A pair whose path holds something else stays remembered (another object, another holder,
 *  or still unreachable), and so does one whose read or unlink threw. No cost while nothing is remembered,
 *  which is every process whose releases all proved ownership. */
function reclaimOrphanedOwnLocks(at?: string): boolean {
  if (orphanedOwnLocks.size === 0) return false;
  let freedAt = false;
  for (const [token, lockPath] of [...orphanedOwnLocks]) {
    try {
      if (lockTokenAt(lockPath) !== token) continue;
      unlinkSync(lockPath);
      orphanedOwnLocks.delete(token);
      if (lockPath === at) freedAt = true;
    } catch { /* not removable now: stays remembered */ }
  }
  return freedAt;
}

/** Test and probe seam: how many of its own locks this thread remembers as not released. */
export function orphanedOwnLockCount(): number { return orphanedOwnLocks.size; }

/** Shared acquire path for withFileLock/withFileLockAsync (extracted; zero behavior change for
 *  existing synchronous callers — same publish/contend/classify/reclaim loop, same error
 *  messages). Returns the acquired LockContext plus a release() thunk; deciding how the held
 *  section runs (sync return vs awaited) is the caller's job. */
function acquireFileLock(target: string, opts: LockOptions = {}): AcquiredLock {
  const probe = opts.probe ?? realProbe;
  const canon = resolvedPathOrThrow(target);
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
  let publishedOnceMore = false;                            // per acquisition: the extra publication of the absent row (locks-R3) and of a steal at the budget end
  // An orphan of ANY path is taken down here (see orphanedOwnLocks), so other processes wait on it only until
  // this thread's next acquisition of any lock.
  reclaimOrphanedOwnLocks();

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
        // a vanished dir throws ENOENT every pass; a bare non-yielding `continue` would spin at 100% CPU forever (the stealUnderGate fall-through class), so route it through the normal cadence
        if (elapsedMs() < maxWaitMs) { sleepWithinBudget(); continue; }
        // Budget over, and the two causes differ. No folder: no-directory. A folder that stands: a sweep took srcTmp, a
        // holder may well hold the lock, so the reading below picks the cause, as it does after an EEXIST.
        if (!existsSync(dirname(lockPath))) throw markTimedOut(new Error(timeoutMessage(lockPath, { kind: 'no-directory' }, elapsedMs())), 'no-directory');
      } else if (code !== 'EEXIST') throw markPublishRefused(e);   // real error (perms/disk) — bubble up untouched
    }

    // Held. Classify the recorded holder: a legacy dir by its owner pid (pid-gated reclaim), an
    // unparseable payload as dead litter only when its creator predates this boot, a payload by the
    // liveness matrix. readLockHolder is the ONE classification; awaitLiveHolder (the IT-M6 reader
    // wait) applies it too, so a waiter and an acquirer can never disagree about a holder.
    const reading = readLockHolder(lockPath, self, probe);
    if (reading.kind === 'foreign') throw new LockForeignObjectError();      // D8: not opened, no budget spent
    if (reading.kind === 'absent') {
      if (elapsedMs() >= maxWaitMs) {
        if (publishedOnceMore) throw markTimedOut(new Error(timeoutMessage(lockPath, { kind: 'vanished' }, elapsedMs())), 'vanished');
        publishedOnceMore = true;                                            // decision 8 (locks-R3): publish once more, then refuse
        continue;
      }
      sleepWithinBudget();
      continue;
    }
    if (reading.kind === 'unreadable') {                                      // may be a live holder's lock: wait the budget, then refuse
      if (elapsedMs() >= maxWaitMs) throw markTimedOut(new Error(timeoutMessage(lockPath, { kind: 'unreadable' }, elapsedMs())), 'unreadable');
      sleepWithinBudget();
      continue;
    }
    const holder = reading.holder;

    // This thread's own token as the holder: a real re-entrant call, or an orphan whose folder came back after the
    // look in front of the loop. An orphan is taken down and the publish retried at once, with no budget check and no
    // sleep: this thread has just freed the lock itself. That cannot spin: a reclaim forgets the pair, so this runs at
    // most once per remembered pair, and a lock that is not remembered reaches the throw.
    if (holder === 'reentrant-self' && reclaimOrphanedOwnLocks(lockPath)) continue;
    if (holder === 'reentrant-self')
      throw new Error(`withFileLock: re-entrant acquisition of ${lockPath} from the same thread (pid ${process.pid}) — withFileLock is not re-entrant`);
    // A provably-dead holder gets ONE gated reclaim attempt, then we fall through to the normal
    // retry cadence (budget check + sleep) rather than continue-ing: a contended/stuck gate makes
    // stealUnderGate a no-op, and an unconditional continue there would spin without ever advancing
    // `waited` — a non-yielding infinite loop. Falling through means a stuck gate simply times out
    // (automatic reclaim disabled until repair, the documented fail-closed residue). The steal
    // grants nothing: the loop still re-publishes from scratch on the next pass. A steal that cleared
    // the lock at the budget end leaves `reading` describing a lock that is gone, so that pass answers
    // as the absent row does and `reading` is never printed.
    const cleared = holder === 'dead' && stealUnderGate(lockPath, probe);
    if (elapsedMs() >= maxWaitMs) {
      if (cleared) {
        if (publishedOnceMore) throw markTimedOut(new Error(timeoutMessage(lockPath, { kind: 'vanished' }, elapsedMs())), 'vanished');
        publishedOnceMore = true;
        continue;
      }
      const cause: TimeoutCause = reading.payload !== null ? { kind: 'payload', holder: reading.payload }
        : reading.shape === 'legacy-dir' ? { kind: 'legacy-dir' } : { kind: 'unparseable' };
      throw markTimedOut(new Error(timeoutMessage(lockPath, cause, elapsedMs())), cause.kind);
    }
    sleepWithinBudget();
  }

  const ctx: LockContext = {
    path: canon,
    stillOwned() { return lockTokenAt(lockPath) === token; },
  };
  const release = (): void => {
    // Release ONLY a lock we can prove is ours. Anything else (foreign payload, legacy dir, a link,
    // unreadable) is left in place — deleting it would free a lock someone else may hold. What cannot
    // be proven now is remembered (see orphanedOwnLocks): the path may lead back to it later.
    try { if (lockTokenAt(lockPath) === token) { unlinkSync(lockPath); return; } } catch { /* cannot prove ownership, or the unlink failed */ }
    rememberOrphan(lockPath, token);
  };
  return { ctx, release };
}

/** What awaitLiveHolder found. 'none': nothing to wait for (no lock file, a foreign or unreadable
 *  object, a holder that classifies dead or reentrant-self, at entry or during the wait, or a target
 *  whose lock path does not resolve). 'released': the holder seen at entry gave the lock up within the
 *  budget (the file is gone, it now records a different acquisition, or another object replaced it).
 *  'timeout': that holder still had it when the budget ran out. */
export type HolderWaitOutcome = 'none' | 'released' | 'timeout';

export interface HolderWaitOptions {
  maxWaitMs: number;
  pollMs?: number;
  probe?: LivenessProbe;
  /** Test seam for the pause between polls; production uses the lock's own synchronous sleep. */
  sleep?: (ms: number) => void;
}

/** Upper bound on what is read from a lock path. A payload this version publishes is about 220 bytes. */
const LOCK_READ_MAX_BYTES = 64 * 1024;

/** What stands at a lock path, or at a legacy lock directory's `owner` entry (spec 4.5).
 *  - payload:    a regular file and the bytes read from it, at most LOCK_READ_MAX_BYTES. `oversized`
 *                says the file holds more than that; the caller then treats it like a payload that
 *                does not parse, whatever its first bytes are.
 *  - legacy-dir: a directory (the pre-redesign lock form).
 *  - foreign:    a symlink, a FIFO, a socket, a device: never opened.
 *  - unreadable: a regular file that could not be opened or read, or a name that could not be examined.
 *  - absent:     nothing at the name (at the look, or at the open that followed it). */
type LockObject =
  | { kind: 'payload'; ino: number; mtimeMs: number; raw: string; oversized: boolean }
  | { kind: 'legacy-dir'; ino: number }
  | { kind: 'foreign' }
  | { kind: 'unreadable' }
  | { kind: 'absent' };

/** THE one read of a lock path (spec 4.5). Every site that used readFileSync on a lock path goes
 *  through it: the acquirer's classification, the reader wait, stillOwned, release, the orphan reclaim,
 *  the reaper's re-verification, the reaper gate, and the `owner` entry of a legacy lock directory. readFileSync
 *  followed links and blocked on a FIFO with no writer, which stopped the server's one thread.
 *  The name is examined without following a link (lstat); only a regular file is opened, with
 *  O_NONBLOCK (a FIFO that took the name after the look opens instead of blocking) and O_NOFOLLOW (a
 *  link that took the name fails ELOOP); the DESCRIPTOR is then asked what was opened; at most
 *  LOCK_READ_MAX_BYTES + 1 bytes are read. Never throws. By result: lstat ENOENT or open ENOENT is
 *  `absent`; a non-regular non-directory at the look, open ELOOP, or a descriptor that is not a
 *  regular file is `foreign`; every other failure is `unreadable`. */
function readLockObject(path: string): LockObject {
  try {
    const st = lstatSync(path);
    if (st.isDirectory()) return { kind: 'legacy-dir', ino: st.ino };
    if (!st.isFile()) return { kind: 'foreign' };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' };
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };       // released between the look and the open
    if (code === 'ELOOP') return { kind: 'foreign' };       // a link took the name between the look and the open
    return { kind: 'unreadable' };
  }
  try {
    const st = fstatSync(fd);
    if (st.isDirectory()) return { kind: 'legacy-dir', ino: st.ino };
    if (!st.isFile()) return { kind: 'foreign' };
    const buf = Buffer.allocUnsafe(LOCK_READ_MAX_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    return { kind: 'payload', ino: st.ino, mtimeMs: st.mtimeMs, raw: buf.toString('utf8', 0, Math.min(n, LOCK_READ_MAX_BYTES)), oversized: n > LOCK_READ_MAX_BYTES };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    try { closeSync(fd); } catch { /* a failed close of a read-only descriptor changes nothing */ }
  }
}

/** The token recorded at a lock path, or null: read through readLockObject, so a link, a FIFO, a
 *  directory, an oversized or an unreadable file answers null and is never followed. stillOwned,
 *  release, the orphan reclaim and the reaper gate use it to recognise their OWN lock and leave
 *  everything else in place. */
function lockTokenAt(path: string): string | null {
  const o = readLockObject(path);
  return o.kind === 'payload' && !o.oversized ? tryParsePayload(o.raw)?.token ?? null : null;
}

/** The `owner` entry of a legacy lock DIRECTORY, read through readLockObject (spec 4.5, locks-R4):
 *  its text when it is a regular file inside the cap, else null. null covers an ownerless directory
 *  and an owner entry that is a link, a FIFO, a socket, a device, a directory, unreadable or over the
 *  cap: the directory then classifies alive-unknown, as an ownerless one does. */
function legacyOwner(lockPath: string): string | null {
  const o = readLockObject(join(lockPath, 'owner'));
  return o.kind === 'payload' && !o.oversized ? o.raw : null;
}

/** One reading of a lock path. `holder` is a regular file or a legacy directory, with the holder's
 *  class, the payload when it parses (null for a legacy directory or a payload that does not parse)
 *  and a snapshot that names this acquisition: the inode plus the bytes read (a legacy directory: its
 *  inode plus its owner text, '' when it has none). Every acquisition publishes a fresh random token,
 *  so a released-and-retaken lock never repeats a snapshot even when the filesystem reuses the inode
 *  number. The other three kinds are the rows of spec 4.5. */
type LockHolderReading =
  | { kind: 'holder'; holder: HolderClass; payload: LockPayload | null; snapshot: string; shape: 'payload' | 'unparseable' | 'legacy-dir' }
  | { kind: 'foreign' }
  | { kind: 'unreadable' }
  | { kind: 'absent' };

/** THE classification of what stands at a lock path, the one site of the litter rule, shared by
 *  acquireFileLock's contention branch, awaitLiveHolder (L1) and the reaper's re-verification under
 *  its gate: a legacy DIRECTORY lock -> its owner pid (classifyLegacyOwner); a payload that does not
 *  parse, or a regular file over the read cap -> 'dead' only when the file predates this boot
 *  (litter), else 'alive-unknown'; a payload -> classifyHolder against `self`. For a regular file the
 *  snapshot records the very bytes classified, so a poll compares against exactly that acquisition.
 *  `foreign`, `unreadable` and `absent` are passed on from readLockObject; a probe that throws while
 *  classifying reads as `unreadable` (the holder could not be identified). Never publishes, reclaims
 *  or unlinks anything. */
function readLockHolder(lockPath: string, self: LockPayload, probe: LivenessProbe): LockHolderReading {
  const o = readLockObject(lockPath);
  if (o.kind === 'foreign' || o.kind === 'unreadable' || o.kind === 'absent') return { kind: o.kind };
  try {
    if (o.kind === 'legacy-dir') {
      const owner = legacyOwner(lockPath);
      return { kind: 'holder', holder: classifyLegacyOwner(owner, probe), payload: null, snapshot: `d:${o.ino}:${owner ?? ''}`, shape: 'legacy-dir' };
    }
    const snapshot = `f:${o.ino}:${o.raw}`;
    const parsed = o.oversized ? null : tryParsePayload(o.raw);
    if (parsed === null) {
      const boot = probe.bootInstantMs();
      return { kind: 'holder', holder: boot !== null && o.mtimeMs < boot ? 'dead' : 'alive-unknown', payload: null, snapshot, shape: 'unparseable' };
    }
    return { kind: 'holder', holder: classifyHolder(parsed, self, probe), payload: parsed, snapshot, shape: 'payload' };
  } catch { return { kind: 'unreadable' }; }
}

/** READ-ONLY wait for a live holder of `target`'s lock (IT-M6: a witnessed reader that still sees a
 *  rewrite's journal over the old bytes waits for the rewriter instead of withholding the scope).
 *  Never publishes, reclaims, steals or unlinks anything: it reads the lock file and, through
 *  `probe`, /proc and kill(pid, 0). A holder that classifies alive or alive-unknown is waited for,
 *  polling every `pollMs` and classifying it again at each poll, until anything else stands at the
 *  lock path ('released'), that acquisition classifies dead or reentrant-self ('none'), or `maxWaitMs`
 *  passes. No lock, a foreign or unreadable object (neither is confirmed as a rewrite's holder), a
 *  dead holder (its rewrite can no longer land) and this thread's own lock (nothing can land while we
 *  wait on ourselves) return 'none' at once. */
export function awaitLiveHolder(target: string, opts: HolderWaitOptions): HolderWaitOutcome {
  const probe = opts.probe ?? realProbe;
  let lockPath: string;
  try { lockPath = lockPathOf(target); } catch { return 'none'; }   // e.g. the ledger's directory does not exist
  const self = selfIdentity('holder-wait', probe);
  const current = readLockHolder(lockPath, self, probe);
  if (current.kind !== 'holder' || current.holder === 'dead' || current.holder === 'reentrant-self') return 'none';
  const seen = current.snapshot;
  const look = (): HolderWaitOutcome | null => {
    const now = readLockHolder(lockPath, self, probe);
    if (now.kind !== 'holder' || now.snapshot !== seen) return 'released';
    return now.holder === 'dead' || now.holder === 'reentrant-self' ? 'none' : null;
  };
  const sleep = opts.sleep ?? sleepSync;
  const pollMs = opts.pollMs ?? RETRY_MS;
  const startedAt = performance.now();
  for (;;) {
    const left = opts.maxWaitMs - (performance.now() - startedAt);
    if (left <= 0) return look() ?? 'timeout';
    sleep(Math.max(1, Math.min(pollMs, left)));
    const outcome = look();
    if (outcome !== null) return outcome;
  }
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
 *  no ticks/boot/ns were recorded. An OWNERLESS dir (`raw` null, see legacyOwner) is permanently
 *  alive-unknown: the old holder may sit suspended between its mkdir and its owner stamp, and no
 *  evidence can distinguish that from a crash — manual removal only (the timeout error names the path). */
function classifyLegacyOwner(raw: string | null, probe: LivenessProbe): HolderClass {
  if (raw === null) return 'alive-unknown';
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
 *  repair (documented fail-closed residue). Gates from other boots are inert litter: removable.
 *  Answers whether THIS call removed the lock: false for a busy gate and for a victim left alone. */
function stealUnderGate(lockPath: string, probe: LivenessProbe): boolean {
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
  } catch { return false; }                                        // gate busy (same boot) — no steal this round
  try {
    // Re-verify under the gate with THE classification (readLockHolder). Anything that is not provably
    // dead now (changed, alive, same-boot junk, foreign, unreadable, gone) is left alone.
    const victim = readLockHolder(lockPath, selfIdentity(gateToken, probe), probe);
    if (victim.kind !== 'holder' || victim.holder !== 'dead') return false;
    if (victim.shape === 'legacy-dir') rmSync(lockPath, { recursive: true, force: true });
    else unlinkSync(lockPath);
    return true;
  } catch { return false; }                                        // victim vanished or fs error — abandon; outer loop re-evaluates
  finally {
    try { if (lockTokenAt(gatePath) === gateToken) unlinkSync(gatePath); } catch { /* leave */ }
  }
}

function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
