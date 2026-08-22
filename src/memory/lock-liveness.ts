import { readFileSync, readlinkSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { uptime as osUptime } from 'node:os';

/** Identity a lock holder records at acquisition, and everything a later waiter needs to decide
 *  dead / alive / cannot-know. startTicks is a DECIMAL STRING (proc stat field 22): exact, and a
 *  string dodges any numeric-precision debate. All-null identity fields = non-Linux platform. */
export interface LockPayload { v: 1; token: string; pid: number; startTicks: string | null; bootId: string | null; pidNs: string | null; threadId: number; platform: string; uptimeSec: number | null; }

export type HolderClass = 'dead' | 'alive' | 'alive-unknown' | 'reentrant-self';

export interface LivenessProbe {
  kill0(pid: number): 'alive' | 'dead' | 'eperm' | 'unknown';
  startTicksOf(pid: number): string | null;
  stateOf(pid: number): string | null;
  bootId(): string | null;
  pidNs(): string | null;
  uptimeSec(): number | null;
  bootInstantMs(): number | null;
}

/** proc stat's comm field may contain spaces and parens; everything after the LAST ') ' is the
 *  fixed field list, so state = fields[0] and startTicks = fields[19] (field 22 overall). */
export function parseAfterLastParen(stat: string): string[] | null {
  const i = stat.lastIndexOf(')');
  if (i < 0) return null;
  return stat.slice(i + 2).split(' ');
}

/** Platforms whose os.uptime() backend is a proven monotonic within-boot counter: Linux reads
 *  /proc/uptime falling back to CLOCK_BOOTTIME, Windows reads GetTickCount64(). Darwin is EXCLUDED:
 *  libuv reads kern.boottime and then calls time(NULL) SEPARATELY, so a backward clock step landing
 *  between the two reads yields an arbitrarily low uptime, and no finite tolerance covers that.
 *  Anything unlisted is refused by default — an unproven backend is not a witness. */
export const UPTIME_WITNESS_PLATFORMS: ReadonlySet<string> = new Set(['linux', 'win32']);

/** The ONE place the operating system is asked. Shared implementation, never a shared sample:
 *  every caller gets a fresh reading, because a cached one is exactly the staleness §3.4 forbids. */
const rawUptimeSec = (): number | null => {
  try { const u = osUptime(); return Number.isFinite(u) ? u : null; } catch { return null; }
};

/** The ONE platform policy. Exported because process.platform cannot be varied in-process, so this
 *  is the only way to test the gate directly rather than by inference from the host it runs on. */
export const gateUptime = (platform: string, raw: number | null): number | null =>
  raw !== null && UPTIME_WITNESS_PLATFORMS.has(platform) ? raw : null;

const gatedUptimeSec = (): number | null => gateUptime(process.platform, rawUptimeSec());

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
  uptimeSec() { return gatedUptimeSec(); },
  bootInstantMs() {
    // Reads the GATED value, not the raw one. Both consumers of this number turn it into a `dead`
    // verdict (lock.ts:137 classifies, lock.ts:251 unlinks), and the subtraction below reads the
    // wall clock and the uptime non-atomically — wall clock first — so on a platform where the
    // clock can step between the two reads the result can be erroneously HIGH, under which a LIVE
    // lock's mtime looks pre-boot and gets stolen. PRECONDITION, stated rather than assumed, in the
    // same voice as the same-host/same-user/one-boot-domain precondition at lock.ts:7-8: this
    // inference holds only where the wall clock does not step backward between two adjacent reads.
    // Excluded platforms return null and fall through to alive-unknown, exactly as they do today.
    const u = gatedUptimeSec();
    return u === null ? null : Date.now() - u * 1000;
  },
};

export function selfIdentity(token: string, probe: LivenessProbe = realProbe): LockPayload {
  return { v: 1, token, pid: process.pid, startTicks: probe.startTicksOf(process.pid), bootId: probe.bootId(), pidNs: probe.pidNs(), threadId, platform: process.platform, uptimeSec: probe.uptimeSec() };
}

/** A LockPayload identity field that must be `string | null`. A well-formed-JSON payload carrying a
 *  NUMERIC startTicks/bootId/pidNs (e.g. 42) would otherwise pass and later make `cur !== recorded.
 *  startTicks` compare a /proc string against a number — always true — mis-classifying a LIVE holder
 *  'dead' and letting the gate steal it. Every other malformed cell already fails CLOSED (waits);
 *  this was the lone fail-OPEN one. Reject => alive-unknown (never stolen). */
const isStringOrNull = (x: unknown): boolean => x === null || typeof x === 'string';

/** ABSENT is legal — a payload written by an older build has no uptimeSec, and §3.6 requires it to
 *  keep parsing rather than fall to the litter path's wall-clock mtime inference. PRESENT but not a
 *  finite number is REJECTED, never coerced: same fail-OPEN shape as isStringOrNull above. Note
 *  non-finite IS reachable here even though JSON cannot spell Infinity — the literal 1e309 parses
 *  to it. Absent is normalised to null below, so no reader has to handle undefined. */
const isFiniteNumberOrAbsent = (x: unknown): boolean =>
  x === undefined || x === null || (typeof x === 'number' && Number.isFinite(x));

export function tryParsePayload(raw: string): LockPayload | null {
  try {
    const p = JSON.parse(raw) as LockPayload;
    if (p === null || typeof p !== 'object' || p.v !== 1) return null;
    if (typeof p.token !== 'string' || typeof p.pid !== 'number' || typeof p.threadId !== 'number' || typeof p.platform !== 'string') return null;
    if (!isStringOrNull(p.startTicks) || !isStringOrNull(p.bootId) || !isStringOrNull(p.pidNs)) return null;
    if (!isFiniteNumberOrAbsent(p.uptimeSec)) return null;
    return { ...p, uptimeSec: p.uptimeSec ?? null };
  } catch { return null; }
}

/** Whether the RECORDED payload carries a witness this host may reason about. Deliberately ignores
 *  the freshly sampled value — the call site validates that one, so a null or non-finite sample
 *  means the witness is unavailable (alive-unknown), never dead. Re-asserts the platform match that
 *  rule 1 already enforces, so the rule's placement is not its only guard.
 *
 *  The pidNs conjunct: rule 2b, below, inherits rule 2's POSITION ahead of rule 3 (the pid-namespace
 *  check) but not rule 2's REASONING for standing there. boot_id is not namespaced, so a sibling
 *  container reads the host's own value and a mismatch there really does prove a different boot —
 *  but /proc/uptime IS virtualized under lxcfs, so a container waiter can sample a LOWER uptime than
 *  a live HOST holder recorded, with matching bootId and a finite recorded value, and without this
 *  conjunct that pair would wrongly prove death. Costs nothing real: where pidNs differs, rule 3
 *  already answers alive-unknown, so this conjunct only moves WHERE that answer comes from, never
 *  widens who receives a 'dead' verdict — do not delete it as redundant with rule 3, which runs
 *  AFTER rule 2b and cannot retroactively undo a 'dead' this predicate already returned. */
const usableUptimeWitness = (recorded: LockPayload, self: LockPayload): boolean =>
  recorded.platform === self.platform
  && UPTIME_WITNESS_PLATFORMS.has(recorded.platform)
  && typeof recorded.uptimeSec === 'number' && Number.isFinite(recorded.uptimeSec)
  && recorded.pidNs === self.pidNs;

/** Spec Layer 2, precedence-fixed. EVERY uncertainty resolves to alive-unknown (never stolen);
 *  only positively-established death (or cross-boot impossibility) resolves to dead. */
export function classifyHolder(recorded: LockPayload, self: LockPayload, probe: LivenessProbe): HolderClass {
  if (recorded.platform !== self.platform) return 'alive-unknown';                        // rule 1
  if (recorded.bootId !== null && self.bootId !== null && recorded.bootId !== self.bootId) return 'dead'; // rule 2
  // Rule 2b — rule 2's reasoning for platforms that have no boot id. Uptime rises monotonically
  // within a boot, so a current reading BELOW the recorded one proves the two readings came from
  // different boots, and a process cannot survive a reboot. Like rule 2 this deliberately precedes
  // the pidNs and pid-validity checks: a cross-boot proof does not depend on the recorded pid still
  // meaning anything. STRICTLY less-than — uptime is coarse and equality is not evidence. Sampled
  // HERE, at classification time, NEVER from `self`, which lock.ts builds once before its loop.
  if (usableUptimeWitness(recorded, self)) {
    const now = probe.uptimeSec();
    // `now >= 0` is practically unreachable — Linux reads /proc/uptime or CLOCK_BOOTTIME, Windows
    // reads GetTickCount64(), and none of those can go negative. It stays because a negative FRESH
    // sample against a positive recorded value would otherwise satisfy `now < recorded` and answer
    // dead — a stolen live lock. (A negative RECORDED value is harmless on its own: it only makes
    // `now < recorded` harder to satisfy.) A nonsense reading is uncertainty, and this module's
    // standard resolves uncertainty to alive-unknown, never to evidence — do not delete this guard
    // as dead code.
    if (now !== null && Number.isFinite(now) && now >= 0 && now < recorded.uptimeSec!) return 'dead';
  }
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
  return recorded.startTicks === null ? 'alive-unknown' : 'alive';   // no recorded start-time (non-Linux): kill0 alone cannot separate the original holder from a recycled pid
}
