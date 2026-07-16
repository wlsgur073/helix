import { readFileSync, writeFileSync, unlinkSync, linkSync, lstatSync, realpathSync, rmSync, readdirSync } from 'node:fs';
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
      if (code === 'ENOENT') {                              // srcTmp swept mid-flight, OR the ledger's dir vanished mid-acquire — retry ON THE BUDGET
        if (waited >= maxWaitMs) throw new Error(timeoutMessage(lockPath, null, waited)); // a vanished dir throws ENOENT every pass; a bare non-yielding `continue` would spin at 100% CPU forever (the stealUnderGate fall-through class), so route it through the normal cadence
        sleepSync(RETRY_MS);
        waited += RETRY_MS;
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
    writeFileSync(gateSrc, JSON.stringify(selfIdentity(gateToken, probe)), { flag: 'wx' });
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
