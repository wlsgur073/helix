import { readFileSync, readlinkSync } from 'node:fs';
import { threadId } from 'node:worker_threads';

/** Identity a lock holder records at acquisition, and everything a later waiter needs to decide
 *  dead / alive / cannot-know. startTicks is a DECIMAL STRING (proc stat field 22): exact, and a
 *  string dodges any numeric-precision debate. All-null identity fields = non-Linux platform. */
export interface LockPayload { v: 1; token: string; pid: number; startTicks: string | null; bootId: string | null; pidNs: string | null; threadId: number; platform: string; }

export type HolderClass = 'dead' | 'alive' | 'alive-unknown' | 'reentrant-self';

export interface LivenessProbe {
  kill0(pid: number): 'alive' | 'dead' | 'eperm' | 'unknown';
  startTicksOf(pid: number): string | null;
  stateOf(pid: number): string | null;
  bootId(): string | null;
  pidNs(): string | null;
  bootInstantMs(): number | null;
}

/** proc stat's comm field may contain spaces and parens; everything after the LAST ') ' is the
 *  fixed field list, so state = fields[0] and startTicks = fields[19] (field 22 overall). */
export function parseAfterLastParen(stat: string): string[] | null {
  const i = stat.lastIndexOf(')');
  if (i < 0) return null;
  return stat.slice(i + 2).split(' ');
}

export const realProbe: LivenessProbe = {
  kill0(pid) {
    try { process.kill(pid, 0); return 'alive'; }
    catch (e) {
      const c = (e as NodeJS.ErrnoException).code;
      return c === 'ESRCH' ? 'dead' : c === 'EPERM' ? 'eperm' : 'unknown';
    }
  },
  startTicksOf(pid) {
    try { return parseAfterLastParen(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.[19] ?? null; } catch { return null; }
  },
  stateOf(pid) {
    try { return parseAfterLastParen(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.[0] ?? null; } catch { return null; }
  },
  bootId() { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } },
  pidNs() { try { return readlinkSync('/proc/self/ns/pid'); } catch { return null; } },
  bootInstantMs() {
    try { return Date.now() - Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000; } catch { return null; }
  },
};

export function selfIdentity(token: string, probe: LivenessProbe = realProbe): LockPayload {
  return { v: 1, token, pid: process.pid, startTicks: probe.startTicksOf(process.pid), bootId: probe.bootId(), pidNs: probe.pidNs(), threadId, platform: process.platform };
}

/** A LockPayload identity field that must be `string | null`. A well-formed-JSON payload carrying a
 *  NUMERIC startTicks/bootId/pidNs (e.g. 42) would otherwise pass and later make `cur !== recorded.
 *  startTicks` compare a /proc string against a number — always true — mis-classifying a LIVE holder
 *  'dead' and letting the gate steal it. Every other malformed cell already fails CLOSED (waits);
 *  this was the lone fail-OPEN one. Reject => alive-unknown (never stolen). */
const isStringOrNull = (x: unknown): boolean => x === null || typeof x === 'string';

export function tryParsePayload(raw: string): LockPayload | null {
  try {
    const p = JSON.parse(raw) as LockPayload;
    if (p === null || typeof p !== 'object' || p.v !== 1) return null;
    if (typeof p.token !== 'string' || typeof p.pid !== 'number' || typeof p.threadId !== 'number' || typeof p.platform !== 'string') return null;
    if (!isStringOrNull(p.startTicks) || !isStringOrNull(p.bootId) || !isStringOrNull(p.pidNs)) return null;
    return p;
  } catch { return null; }
}

/** Spec Layer 2, precedence-fixed. EVERY uncertainty resolves to alive-unknown (never stolen);
 *  only positively-established death (or cross-boot impossibility) resolves to dead. */
export function classifyHolder(recorded: LockPayload, self: LockPayload, probe: LivenessProbe): HolderClass {
  if (recorded.platform !== self.platform) return 'alive-unknown';                        // rule 1
  if (recorded.bootId !== null && self.bootId !== null && recorded.bootId !== self.bootId) return 'dead'; // rule 2
  if ((recorded.bootId === null) !== (self.bootId === null)) return 'alive-unknown';
  if (recorded.pidNs !== self.pidNs) return 'alive-unknown';                              // rule 3 (null === null ok)
  if (!Number.isSafeInteger(recorded.pid) || recorded.pid <= 0) return 'alive-unknown';
  if (recorded.pid === self.pid && recorded.startTicks === self.startTicks) {             // rule 7
    return recorded.threadId === self.threadId ? 'reentrant-self' : 'alive';
  }
  const k = probe.kill0(recorded.pid);                                                    // rule 4
  if (k === 'dead') return 'dead';
  if (k === 'unknown') return 'alive-unknown';
  if (recorded.startTicks !== null) {
    const cur = probe.startTicksOf(recorded.pid);
    if (cur !== null && cur !== recorded.startTicks) return 'dead';                       // recycled pid
    if (cur === null && k === 'alive') return 'alive-unknown';                            // cannot verify identity
  }
  const st = probe.stateOf(recorded.pid);
  if (st === 'Z' || st === 'X') return 'dead';                                            // a zombie never resumes
  return 'alive';
}
