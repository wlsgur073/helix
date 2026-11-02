// scripts/rebaseline-cli.ts
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { isAbsolute as isAbsolute3, dirname as dirname10, join as join9 } from "node:path";
import { mkdirSync as mkdirSync5 } from "node:fs";

// src/memory/lock.ts
import { writeFileSync, unlinkSync, linkSync, lstatSync as lstatSync2, rmSync, readdirSync, openSync, closeSync, readSync, fstatSync, existsSync, constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { dirname as dirname2, basename as basename2, join as join2 } from "node:path";

// src/memory/lock-liveness.ts
import { readFileSync, readlinkSync } from "node:fs";
import { threadId } from "node:worker_threads";
import { uptime as osUptime } from "node:os";
function parseAfterLastParen(stat) {
  const i = stat.lastIndexOf(")");
  if (i < 0) return null;
  return stat.slice(i + 2).split(" ");
}
var UPTIME_WITNESS_PLATFORMS = /* @__PURE__ */ new Set(["linux", "win32"]);
var rawUptimeSec = () => {
  try {
    const u = osUptime();
    return Number.isFinite(u) ? u : null;
  } catch {
    return null;
  }
};
var gateUptime = (platform, raw) => raw !== null && UPTIME_WITNESS_PLATFORMS.has(platform) ? raw : null;
var gatedUptimeSec = () => gateUptime(process.platform, rawUptimeSec());
var realProbe = {
  kill0(pid) {
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (e) {
      const c = e.code;
      return c === "ESRCH" ? "dead" : c === "EPERM" ? "eperm" : "unknown";
    }
  },
  startTicksOf(pid) {
    try {
      return parseAfterLastParen(readFileSync(`/proc/${pid}/stat`, "utf8"))?.[19] ?? null;
    } catch {
      return null;
    }
  },
  stateOf(pid) {
    try {
      return parseAfterLastParen(readFileSync(`/proc/${pid}/stat`, "utf8"))?.[0] ?? null;
    } catch {
      return null;
    }
  },
  bootId() {
    try {
      return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      return null;
    }
  },
  pidNs() {
    try {
      return readlinkSync("/proc/self/ns/pid");
    } catch {
      return null;
    }
  },
  timeNs() {
    try {
      return readlinkSync("/proc/self/ns/time");
    } catch {
      return null;
    }
  },
  uptimeSec() {
    return gatedUptimeSec();
  },
  bootInstantMs() {
    const u = gatedUptimeSec();
    return u === null ? null : Date.now() - u * 1e3;
  }
};
function selfIdentity(token, probe = realProbe) {
  return { v: 1, token, pid: process.pid, startTicks: probe.startTicksOf(process.pid), bootId: probe.bootId(), pidNs: probe.pidNs(), timeNs: probe.timeNs(), threadId, platform: process.platform, uptimeSec: probe.uptimeSec() };
}
var isStringOrNull = (x) => x === null || typeof x === "string";
var isFiniteNumberOrAbsent = (x) => x === void 0 || x === null || typeof x === "number" && Number.isFinite(x);
function tryParsePayload(raw) {
  try {
    const p = JSON.parse(raw);
    if (p === null || typeof p !== "object" || p.v !== 1) return null;
    if (typeof p.token !== "string" || typeof p.pid !== "number" || typeof p.threadId !== "number" || typeof p.platform !== "string") return null;
    if (!isStringOrNull(p.startTicks) || !isStringOrNull(p.bootId) || !isStringOrNull(p.pidNs)) return null;
    if (!isFiniteNumberOrAbsent(p.uptimeSec)) return null;
    if (p.timeNs !== void 0 && !isStringOrNull(p.timeNs)) return null;
    return { ...p, uptimeSec: p.uptimeSec ?? null, timeNs: p.timeNs ?? null };
  } catch {
    return null;
  }
}
var usableUptimeWitness = (recorded, self) => recorded.platform === self.platform && UPTIME_WITNESS_PLATFORMS.has(recorded.platform) && typeof recorded.uptimeSec === "number" && Number.isFinite(recorded.uptimeSec) && recorded.pidNs === self.pidNs && sameTimeNamespace(recorded, self);
var sameTimeNamespace = (recorded, self) => (recorded.timeNs ?? null) === (self.timeNs ?? null);
function classifyHolder(recorded, self, probe) {
  if (recorded.platform !== self.platform) return "alive-unknown";
  if (recorded.bootId !== null && self.bootId !== null && recorded.bootId !== self.bootId) return "dead";
  if (usableUptimeWitness(recorded, self)) {
    const now = probe.uptimeSec();
    if (now !== null && Number.isFinite(now) && now >= 0 && now < recorded.uptimeSec) return "dead";
  }
  if (recorded.bootId === null !== (self.bootId === null)) return "alive-unknown";
  if (recorded.pidNs !== self.pidNs) return "alive-unknown";
  if (!Number.isSafeInteger(recorded.pid) || recorded.pid <= 0) return "alive-unknown";
  if (recorded.pid === self.pid && recorded.startTicks === self.startTicks) {
    return recorded.threadId === self.threadId ? "reentrant-self" : "alive";
  }
  const k = probe.kill0(recorded.pid);
  if (k === "dead") return "dead";
  if (k === "unknown") return "alive-unknown";
  if (recorded.startTicks !== null && sameTimeNamespace(recorded, self)) {
    const cur = probe.startTicksOf(recorded.pid);
    if (cur !== null && cur !== recorded.startTicks) return "dead";
    if (cur === null && k === "alive") return "alive-unknown";
  }
  const st = probe.stateOf(recorded.pid);
  if (st === "Z" || st === "X") return "dead";
  return recorded.startTicks === null ? "alive-unknown" : "alive";
}

// src/memory/path-identity.ts
import { lstatSync, readlinkSync as readlinkSync2, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
function canonicalRoot(projectRoot) {
  try {
    return registryKeyPath(projectRoot);
  } catch {
    return resolve(projectRoot);
  }
}
function registryKeyPath(target) {
  try {
    return realpathSync(target);
  } catch {
    return join(realpathSync(dirname(target)), basename(target));
  }
}
var MAX_SYMLINK_HOPS = 40;
function utf8OrNull(b) {
  const s = b.toString("utf8");
  return Buffer.from(s, "utf8").equals(b) ? s : null;
}
var codeOf = (e) => e?.code;
function failureOf(e) {
  const code = codeOf(e);
  if (code === "ENAMETOOLONG") return { kind: "unresolvable", cause: "path-too-long" };
  if (code === "ELOOP") return { kind: "unresolvable", cause: "too-many-links" };
  return { kind: "uninspectable", error: e };
}
function namesDirectory(p) {
  const last = p.slice(p.lastIndexOf("/") + 1);
  return last === "" || last === "." || last === "..";
}
var under = (dir, name) => dir === "/" ? `/${name}` : `${dir}/${name}`;
function physicalDir(dir) {
  let real;
  try {
    real = realpathSync.native(dir, { encoding: "buffer" });
  } catch (e) {
    return codeOf(e) === "ENOENT" ? missingDir(dir, e) : failureOf(e);
  }
  const text = utf8OrNull(real);
  return text === null ? { kind: "unresolvable", cause: "non-utf8-name" } : { kind: "dir", path: text, missing: null };
}
function missingDir(dir, error) {
  const parts = dir.split("/");
  for (let keep = parts.length - 1; keep >= 0; keep--) {
    const head = parts.slice(0, keep).join("/");
    const prefix = head !== "" ? head : isAbsolute(dir) ? "/" : ".";
    let real;
    try {
      real = realpathSync.native(prefix, { encoding: "buffer" });
    } catch (e) {
      if (codeOf(e) === "ENOENT") continue;
      return failureOf(e);
    }
    const text = utf8OrNull(real);
    if (text === null) return { kind: "unresolvable", cause: "non-utf8-name" };
    const rest = parts.slice(keep).filter((c) => c !== "" && c !== ".");
    if (rest.includes("..")) return { kind: "uninspectable", error };
    return { kind: "dir", path: rest.length === 0 ? text : under(text, rest.join("/")), missing: rest.length === 0 ? null : error };
  }
  return { kind: "uninspectable", error };
}
function directoryAnswer(p) {
  try {
    statSync(p);
  } catch (e) {
    return failureOf(e);
  }
  return existingAnswer(p);
}
function existingAnswer(p) {
  let real;
  try {
    real = realpathSync.native(p, { encoding: "buffer" });
  } catch (e) {
    return failureOf(e);
  }
  const text = utf8OrNull(real);
  return text === null ? { kind: "unresolvable", cause: "non-utf8-name" } : { kind: "resolved", path: text, dirMissing: false };
}
function creationAnswer(p) {
  const d = physicalDir(dirname(p));
  if (d.kind !== "dir") return d;
  const path = under(d.path, basename(p));
  return d.missing === null ? { kind: "resolved", path, dirMissing: false } : { kind: "resolved", path, dirMissing: true, dirError: d.missing };
}
function resolvePath(input) {
  const given = input === "" ? "." : input;
  if (namesDirectory(given)) return directoryAnswer(given);
  let p = given;
  for (let hops = 0; ; hops++) {
    let isLink2;
    try {
      isLink2 = lstatSync(p).isSymbolicLink();
    } catch (e) {
      return codeOf(e) === "ENOENT" ? creationAnswer(p) : failureOf(e);
    }
    if (!isLink2) return existingAnswer(p);
    if (hops === 0) {
      try {
        statSync(p);
      } catch (e) {
        if (codeOf(e) !== "ENOENT") return failureOf(e);
      }
    }
    if (hops === MAX_SYMLINK_HOPS) return { kind: "unresolvable", cause: "too-many-links" };
    let body;
    try {
      body = utf8OrNull(readlinkSync2(p, { encoding: "buffer" }));
    } catch (e) {
      return failureOf(e);
    }
    if (body === null) return { kind: "unresolvable", cause: "non-utf8-name" };
    let q;
    if (isAbsolute(body)) q = body;
    else {
      const from = physicalDir(dirname(p));
      if (from.kind !== "dir") return from;
      q = `${from.path}/${body}`;
    }
    if (namesDirectory(q)) return directoryAnswer(q);
    const dir = physicalDir(dirname(q));
    if (dir.kind !== "dir") return dir;
    const next = under(dir.path, basename(q));
    if (dir.missing !== null) return { kind: "resolved", path: next, dirMissing: true, dirError: dir.missing };
    p = next;
  }
}
var UNRESOLVABLE_PATH_MESSAGE = "the path cannot be resolved (a name that is not valid UTF-8, a path past the system limit, or too many links)";
var UnresolvablePathError = class extends Error {
  constructor(reason) {
    super(UNRESOLVABLE_PATH_MESSAGE);
    this.reason = reason;
    this.name = "UnresolvablePathError";
  }
  reason;
  /** The marker isUnresolvablePathError reads (a property, never class identity). */
  unresolvablePath = true;
};
function resolvedPathOrThrow(path) {
  const r = resolvePath(path);
  if (r.kind === "unresolvable") throw new UnresolvablePathError(r.cause);
  if (r.kind === "uninspectable") throw r.error;
  if (r.dirMissing) throw r.dirError ?? Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  return r.path;
}
var realIdentityProbe = (path, follow) => {
  try {
    const st = follow ? statSync(path, { bigint: true }) : lstatSync(path, { bigint: true });
    return { dev: st.dev, ino: st.ino };
  } catch (e) {
    if (codeOf(e) === "ENOENT") return null;
    throw e;
  }
};
function fileIdentityAt(path, opts = {}) {
  return (opts.probe ?? realIdentityProbe)(path, opts.follow === true);
}
function hasComparableInode(id) {
  return id !== null && id.ino !== 0n;
}
function sameFile(a, b) {
  return hasComparableInode(a) && hasComparableInode(b) && a.dev === b.dev && a.ino === b.ino;
}

// src/memory/lock.ts
var RETRY_MS = 25;
var DEFAULT_MAX_WAIT_MS = 5e3;
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function timeoutMessage(lockPath, cause, waitedMs) {
  const head = `withFileLock: timed out after ${waitedMs}ms acquiring ${lockPath}`;
  switch (cause.kind) {
    case "unparseable":
      return `${head} \u2014 the lock file does not parse as a lock this version writes (it is empty, holds other content, or is larger than a lock payload), so its holder cannot be identified. Such a file is cleared only if it predates the last boot, where the platform reports one, and not while another process holds the clearing step. Inspect ${lockPath} by hand.`;
    case "unreadable":
      return `${head} \u2014 the lock file exists but its holder could not be read or identified (a permission or I/O error, or a failed liveness check), so it is never auto-reclaimed. Inspect ${lockPath} by hand.`;
    case "no-directory":
      return `${head} \u2014 the lock could not be published because its directory does not exist (it was removed, or a path component is missing). Nothing holds this lock; check the folder of ${lockPath}.`;
    case "legacy-dir":
      return `${head} \u2014 a lock directory written by an older version stands there. It is cleared only when its owner is shown dead, and not while another process holds the clearing step. Inspect ${lockPath} by hand.`;
    case "vanished":
      return `${head} \u2014 the lock was free at the last look, but it could not be taken inside the budget (contention, not a stuck holder). Try again.`;
    case "payload": {
      const holder = cause.holder;
      const who = `held by pid ${holder.pid} (recorded start ${holder.startTicks ?? "NONE \u2014 this platform does not expose one"})`;
      const identify = holder.startTicks === null ? `Because no start time was recorded, a waiter cannot tell the original holder from an unrelated process that later reused pid ${holder.pid}; kill -0 cannot separate them either. Identify it: ps -p ${holder.pid} -o pid,lstart,command \u2014 and confirm it is a Helix run before acting.` : `This lock is cleared only when its holder is shown dead, and not while another process holds the clearing step. Confirm it is the run that took the lock by comparing its start time against the value above (ps -p ${holder.pid} -o pid,lstart,command).`;
      return `${head} \u2014 ${who}. ${identify} Removing the lock while its holder is merely SUSPENDED reintroduces the concurrency this lock prevents.`;
    }
  }
}
var LOCK_FOREIGN_OBJECT_REFUSAL = "withFileLock: the lock file for this path is not a lock Helix wrote (a link, a FIFO, a socket or a device stands at its name) \u2014 refusing to read it or wait on it. Ask the user to look at that object and remove it; do not remove it for them.";
var LockForeignObjectError = class extends Error {
  lockForeignObject = true;
  // the marker isLockForeignObjectError reads
  constructor() {
    super(LOCK_FOREIGN_OBJECT_REFUSAL);
    this.name = "LockForeignObjectError";
  }
};
function markPublishRefused(e) {
  const code = e?.code;
  if ((code === "EACCES" || code === "EROFS") && e instanceof Error) {
    try {
      Object.assign(e, { lockPublishRefused: true });
    } catch {
    }
  }
  return e;
}
function markTimedOut(e, kind) {
  return Object.assign(e, { lockTimedOut: true, lockTimeoutCause: kind });
}
var ORPHAN_MAX = 64;
var orphanedOwnLocks = /* @__PURE__ */ new Map();
function rememberOrphan(lockPath, token) {
  orphanedOwnLocks.set(token, lockPath);
  while (orphanedOwnLocks.size > ORPHAN_MAX) {
    const oldest = orphanedOwnLocks.keys().next();
    if (oldest.done === true) break;
    orphanedOwnLocks.delete(oldest.value);
  }
}
function reclaimOrphanedOwnLocks(at) {
  if (orphanedOwnLocks.size === 0) return false;
  let freedAt = false;
  for (const [token, lockPath] of [...orphanedOwnLocks]) {
    try {
      if (lockTokenAt(lockPath) !== token) continue;
      unlinkSync(lockPath);
      orphanedOwnLocks.delete(token);
      if (lockPath === at) freedAt = true;
    } catch {
    }
  }
  return freedAt;
}
function acquireFileLock(target, opts = {}) {
  const probe = opts.probe ?? realProbe;
  const canon = resolvedPathOrThrow(target);
  const lockPath = canon + ".lock";
  const token = randomBytes(16).toString("hex");
  const self = selfIdentity(token, probe);
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const startedAt = performance.now();
  const elapsedMs = () => Math.round(performance.now() - startedAt);
  const sleepWithinBudget = () => sleepSync(Math.max(1, Math.min(RETRY_MS, maxWaitMs - elapsedMs())));
  let publishedOnceMore = false;
  reclaimOrphanedOwnLocks();
  for (; ; ) {
    const srcTmp = `${canon}.lk-${randomBytes(16).toString("hex")}.tmp`;
    const payloadText = JSON.stringify({ ...self, uptimeSec: probe.uptimeSec() });
    if (tryParsePayload(payloadText) === null) throw new Error("withFileLock: internal \u2014 payload failed its own well-formedness check");
    try {
      writeFileSync(srcTmp, payloadText, { flag: "wx", mode: 384 });
      try {
        linkSync(srcTmp, lockPath);
        break;
      } finally {
        try {
          unlinkSync(srcTmp);
        } catch {
        }
      }
    } catch (e) {
      const code = e.code;
      if (code === "EPERM" || code === "EOPNOTSUPP" || code === "ENOTSUP")
        throw new Error(`withFileLock: filesystem refuses hard links for ${lockPath}; ledger locking is unsupported on this filesystem`);
      if (code === "ENOENT") {
        if (elapsedMs() < maxWaitMs) {
          sleepWithinBudget();
          continue;
        }
        if (!existsSync(dirname2(lockPath))) throw markTimedOut(new Error(timeoutMessage(lockPath, { kind: "no-directory" }, elapsedMs())), "no-directory");
      } else if (code !== "EEXIST") throw markPublishRefused(e);
    }
    const reading = readLockHolder(lockPath, self, probe);
    if (reading.kind === "foreign") throw new LockForeignObjectError();
    if (reading.kind === "absent") {
      if (elapsedMs() >= maxWaitMs) {
        if (publishedOnceMore) throw markTimedOut(new Error(timeoutMessage(lockPath, { kind: "vanished" }, elapsedMs())), "vanished");
        publishedOnceMore = true;
        continue;
      }
      sleepWithinBudget();
      continue;
    }
    if (reading.kind === "unreadable") {
      if (elapsedMs() >= maxWaitMs) throw markTimedOut(new Error(timeoutMessage(lockPath, { kind: "unreadable" }, elapsedMs())), "unreadable");
      sleepWithinBudget();
      continue;
    }
    const holder = reading.holder;
    if (holder === "reentrant-self" && reclaimOrphanedOwnLocks(lockPath)) continue;
    if (holder === "reentrant-self")
      throw new Error(`withFileLock: re-entrant acquisition of ${lockPath} from the same thread (pid ${process.pid}) \u2014 withFileLock is not re-entrant`);
    const cleared = holder === "dead" && stealUnderGate(lockPath, probe);
    if (elapsedMs() >= maxWaitMs) {
      if (cleared) {
        if (publishedOnceMore) throw markTimedOut(new Error(timeoutMessage(lockPath, { kind: "vanished" }, elapsedMs())), "vanished");
        publishedOnceMore = true;
        continue;
      }
      const cause = reading.payload !== null ? { kind: "payload", holder: reading.payload } : reading.shape === "legacy-dir" ? { kind: "legacy-dir" } : { kind: "unparseable" };
      throw markTimedOut(new Error(timeoutMessage(lockPath, cause, elapsedMs())), cause.kind);
    }
    sleepWithinBudget();
  }
  const ctx = {
    path: canon,
    stillOwned() {
      return lockTokenAt(lockPath) === token;
    }
  };
  const release = () => {
    try {
      if (lockTokenAt(lockPath) === token) {
        unlinkSync(lockPath);
        return;
      }
    } catch {
    }
    rememberOrphan(lockPath, token);
  };
  return { ctx, release };
}
var LOCK_READ_MAX_BYTES = 64 * 1024;
function readLockObject(path) {
  try {
    const st = lstatSync2(path);
    if (st.isDirectory()) return { kind: "legacy-dir", ino: st.ino };
    if (!st.isFile()) return { kind: "foreign" };
  } catch (e) {
    return e.code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
  }
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT") return { kind: "absent" };
    if (code === "ELOOP") return { kind: "foreign" };
    return { kind: "unreadable" };
  }
  try {
    const st = fstatSync(fd);
    if (st.isDirectory()) return { kind: "legacy-dir", ino: st.ino };
    if (!st.isFile()) return { kind: "foreign" };
    const buf = Buffer.allocUnsafe(LOCK_READ_MAX_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    return { kind: "payload", ino: st.ino, mtimeMs: st.mtimeMs, raw: buf.toString("utf8", 0, Math.min(n, LOCK_READ_MAX_BYTES)), oversized: n > LOCK_READ_MAX_BYTES };
  } catch {
    return { kind: "unreadable" };
  } finally {
    try {
      closeSync(fd);
    } catch {
    }
  }
}
function lockTokenAt(path) {
  const o = readLockObject(path);
  return o.kind === "payload" && !o.oversized ? tryParsePayload(o.raw)?.token ?? null : null;
}
function legacyOwner(lockPath) {
  const o = readLockObject(join2(lockPath, "owner"));
  return o.kind === "payload" && !o.oversized ? o.raw : null;
}
function readLockHolder(lockPath, self, probe) {
  const o = readLockObject(lockPath);
  if (o.kind === "foreign" || o.kind === "unreadable" || o.kind === "absent") return { kind: o.kind };
  try {
    if (o.kind === "legacy-dir") {
      const owner = legacyOwner(lockPath);
      return { kind: "holder", holder: classifyLegacyOwner(owner, probe), payload: null, snapshot: `d:${o.ino}:${owner ?? ""}`, shape: "legacy-dir" };
    }
    const snapshot = `f:${o.ino}:${o.raw}`;
    const parsed = o.oversized ? null : tryParsePayload(o.raw);
    if (parsed === null) {
      const boot = probe.bootInstantMs();
      return { kind: "holder", holder: boot !== null && o.mtimeMs < boot ? "dead" : "alive-unknown", payload: null, snapshot, shape: "unparseable" };
    }
    return { kind: "holder", holder: classifyHolder(parsed, self, probe), payload: parsed, snapshot, shape: "payload" };
  } catch {
    return { kind: "unreadable" };
  }
}
function withFileLock(target, fn, opts = {}) {
  const { ctx, release } = acquireFileLock(target, opts);
  try {
    return fn(ctx);
  } finally {
    release();
  }
}
async function withFileLockAsync(target, fn, opts = {}) {
  const { ctx, release } = acquireFileLock(target, opts);
  try {
    return await fn(ctx);
  } finally {
    release();
  }
}
function classifyLegacyOwner(raw, probe) {
  if (raw === null) return "alive-unknown";
  const pid = Number(raw.split("-")[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return "alive-unknown";
  const k = probe.kill0(pid);
  if (k === "dead") return "dead";
  if (k === "unknown") return "alive-unknown";
  const st = probe.stateOf(pid);
  return st === "Z" || st === "X" ? "dead" : "alive";
}
function stealUnderGate(lockPath, probe) {
  const bootId = probe.bootId() ?? "noboot";
  const gatePath = `${lockPath}.reap.${bootId}`;
  const dir = dirname2(lockPath);
  const prefix = `${basename2(lockPath)}.reap.`;
  for (const name of readdirSyncSafe(dir)) {
    if (name.startsWith(prefix) && name !== basename2(gatePath)) {
      try {
        unlinkSync(join2(dir, name));
      } catch {
      }
    }
  }
  const gateToken = randomBytes(16).toString("hex");
  const gateSrc = `${gatePath}.src-${gateToken}.tmp`;
  try {
    writeFileSync(gateSrc, JSON.stringify(selfIdentity(gateToken, probe)), { flag: "wx", mode: 384 });
    try {
      linkSync(gateSrc, gatePath);
    } finally {
      try {
        unlinkSync(gateSrc);
      } catch {
      }
    }
  } catch {
    return false;
  }
  try {
    const victim = readLockHolder(lockPath, selfIdentity(gateToken, probe), probe);
    if (victim.kind !== "holder" || victim.holder !== "dead") return false;
    if (victim.shape === "legacy-dir") rmSync(lockPath, { recursive: true, force: true });
    else unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (lockTokenAt(gatePath) === gateToken) unlinkSync(gatePath);
    } catch {
    }
  }
}
function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// src/memory/ledger.ts
import { mkdirSync as mkdirSync3, statSync as statSync4, openSync as openSync5, fstatSync as fstatSync4, readSync as readSync3, closeSync as closeSync5, constants as constants4 } from "node:fs";
import { basename as basename4, dirname as dirname7 } from "node:path";
import { StringDecoder } from "node:string_decoder";

// src/memory/ledger-mac.ts
import { createHash, createHmac, hkdfSync, randomBytes as randomBytes2, timingSafeEqual } from "node:crypto";
import { openSync as openSync3, fsyncSync as fsyncSync2, closeSync as closeSync3, readFileSync as readFileSync2, linkSync as linkSync3, unlinkSync as unlinkSync3, statSync as statSync3, chmodSync as chmodSync2 } from "node:fs";
import { dirname as dirname5, join as join5 } from "node:path";

// src/memory/fs-ops.ts
import { openSync as openSync2, readSync as readSync2, writeSync, fsyncSync, closeSync as closeSync2, fstatSync as fstatSync2, statSync as statSync2, readlinkSync as readlinkSync3, renameSync, unlinkSync as unlinkSync2, linkSync as linkSync2, fchmodSync, readdirSync as readdirSync2 } from "node:fs";
var realDirFsyncSyscalls = { openSync: openSync2, fsyncSync, closeSync: closeSync2 };
var DIR_FSYNC_UNSUPPORTED = /* @__PURE__ */ new Set(["EINVAL", "EISDIR", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EACCES"]);
var isUnsupported = (e) => DIR_FSYNC_UNSUPPORTED.has(e?.code ?? "");
function fsyncDir(dir, sys = realDirFsyncSyscalls, platform = process.platform) {
  let dfd;
  try {
    dfd = sys.openSync(dir, "r");
  } catch (e) {
    if (platform === "win32" || isUnsupported(e)) return;
    throw e;
  }
  try {
    sys.fsyncSync(dfd);
  } catch (e) {
    if (!(platform === "win32" || isUnsupported(e))) throw e;
  } finally {
    sys.closeSync(dfd);
  }
}
var realProcFdSyscalls = {
  statSync: (path) => {
    const st = statSync2(path, { bigint: true });
    return { dev: st.dev, ino: st.ino };
  },
  readlinkSync: (path) => readlinkSync3(path)
};
var realFsOps = {
  openSync: openSync2,
  readSync: readSync2,
  writeSync,
  fsyncSync,
  closeSync: closeSync2,
  fstatSync: (fd) => {
    const s = fstatSync2(fd, { bigint: true });
    return { size: Number(s.size), nlink: Number(s.nlink), mode: Number(s.mode), dev: s.dev, ino: s.ino };
  },
  renameSync,
  unlinkSync: unlinkSync2,
  linkSync: linkSync2,
  fchmodSync,
  readdirSync: (d) => readdirSync2(d),
  fsyncDir
};
function writeAll(fs, fd, data) {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw new Error(`writeAll: zero-progress write (${n} of ${buf.length - off} remaining bytes)`);
    off += n;
  }
}

// src/memory/ledger-sweep.ts
import { dirname as dirname3, basename as basename3, join as join3 } from "node:path";
var HEX32 = "[0-9a-f]{32}";
function orphanTmpPattern(base) {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc}\\.(c-${HEX32}|lk-${HEX32}|k-${HEX32}|w-${HEX32}|\\d+)\\.tmp$`);
}
function sweepOrphanTmps(artifactPath, opts = {}) {
  const fs = opts.fsOps ?? realFsOps;
  const dir = dirname3(artifactPath);
  const pat = orphanTmpPattern(basename3(artifactPath));
  const keepName = opts.keep ? basename3(opts.keep) : null;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!pat.test(name) || name === keepName) continue;
    try {
      fs.unlinkSync(join3(dir, name));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      continue;
    }
    removed++;
  }
  if (removed > 0) fs.fsyncDir(dir);
  return removed;
}

// src/memory/home-permissions.ts
import { lstatSync as lstatSync3, chmodSync, readdirSync as readdirSync3, mkdirSync, existsSync as existsSync2 } from "node:fs";
import { join as join4, dirname as dirname4, sep } from "node:path";
function finalName(dir) {
  let n = dir;
  for (; ; ) {
    if (n.length > 1 && (n.endsWith("/") || n.endsWith(sep))) {
      n = n.slice(0, -1);
      continue;
    }
    if (n.length > 2 && (n.endsWith("/.") || n.endsWith(`${sep}.`))) {
      n = n.slice(0, -2);
      continue;
    }
    return n;
  }
}
function ensureHelixDir(dir) {
  if (process.platform === "win32") {
    mkdirSync(dir, { recursive: true });
    return;
  }
  const name = finalName(dir);
  let st = null;
  try {
    st = lstatSync3(name);
  } catch {
    st = null;
  }
  if (st !== null) {
    if (st.isSymbolicLink()) throw new Error(`refusing to use ${dir}: it is a symlink, not a directory Helix owns`);
    if (!st.isDirectory()) throw new Error(`refusing to use ${dir}: it exists and is not a directory`);
    const uid = process.getuid?.();
    if (uid !== void 0 && st.uid !== uid) {
      throw new Error(`refusing to use ${dir}: it is owned by uid ${st.uid}, not by this user (${uid})`);
    }
    if ((st.mode & 63) !== 0) chmodSync(name, 448);
    return;
  }
  const parent = dirname4(name);
  if (!existsSync2(parent)) {
    throw new Error(`refusing to create ${dir}: its parent ${parent} does not exist (Helix creates one directory, never a chain)`);
  }
  try {
    mkdirSync(name, { mode: 448 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    ensureHelixDir(name);
  }
}

// src/memory/ledger-mac.ts
var ILL_FORMED_TAG = Buffer.from([255, 1]);
var LedgerMacError = class extends Error {
};
var MASTER_LEN = 32;
function masterPath(home) {
  return join5(home, "ledger-mac-master.key");
}
function ensureMaster(home) {
  const path = masterPath(home);
  const existing = tryReadMasterStrict(path);
  if (existing) return existing;
  ensureHelixDir(home);
  return withFileLock(path, () => {
    const again = tryReadMasterStrict(path);
    if (again) return again;
    sweepOrphanTmps(path, {});
    const key = randomBytes2(MASTER_LEN);
    const tmp = `${path}.k-${randomBytes2(16).toString("hex")}.tmp`;
    const fd = openSync3(tmp, "wx", 384);
    let published = false;
    try {
      try {
        writeAll(realFsOps, fd, key);
        fsyncSync2(fd);
      } finally {
        closeSync3(fd);
      }
      try {
        linkSync3(tmp, path);
        published = true;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    } finally {
      try {
        unlinkSync3(tmp);
      } catch {
      }
    }
    fsyncDir(dirname5(path));
    if (published) return key;
    const winner = tryReadMasterStrict(path);
    if (!winner) throw new LedgerMacError("master key vanished during concurrent mint");
    return winner;
  });
}
function tryReadMasterStrict(path) {
  let buf;
  try {
    buf = readFileSync2(path);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  if (buf.length !== MASTER_LEN) throw new LedgerMacError(`corrupt master key (${buf.length} bytes, want ${MASTER_LEN})`);
  try {
    if ((statSync3(path).mode & 63) !== 0) chmodSync2(path, 384);
  } catch {
  }
  return buf;
}
function tryReadMaster(home) {
  return tryReadMasterStrict(masterPath(home));
}
var DOMAIN = Buffer.from("helix-ledger-mac");
var NULL_FIELD = Buffer.from([0, 0, 0, 0, 0]);

// src/memory/dir-bound.ts
import { lstatSync as lstatSync4, constants as constants2 } from "node:fs";
import { join as join6 } from "node:path";
var PROC_SELF_FD = "/proc/self/fd";
var memory = /* @__PURE__ */ new WeakMap();
var DIR_OPEN = constants2.O_RDONLY | constants2.O_DIRECTORY | constants2.O_NOFOLLOW;
var DIR_CHANGED_OPEN_ERRORS = /* @__PURE__ */ new Set(["ELOOP", "ENOTDIR", "ENOENT"]);
function procFdAvailable(fsOps) {
  return process.platform === "linux" && memory.get(fsOps.procFd ?? realProcFdSyscalls) !== "absent";
}
function sampleDirIdentity(dir) {
  try {
    const st = lstatSync4(dir, { bigint: true });
    return st.isDirectory() ? { dev: st.dev, ino: st.ino } : null;
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}
function sameHeldObject(seen, held) {
  if (seen.dev !== held.dev) return false;
  return !hasComparableInode(seen) || !hasComparableInode(held) || seen.ino === held.ino;
}
function openJudgedDir(dir, judged, fsOps) {
  if (judged === null) return { kind: "changed" };
  if (!procFdAvailable(fsOps)) return { kind: "unbound", dir: { dir, fd: null } };
  let fd;
  try {
    fd = fsOps.openSync(dir, DIR_OPEN);
  } catch (e) {
    if (DIR_CHANGED_OPEN_ERRORS.has(e.code ?? "")) return { kind: "changed" };
    throw e;
  }
  let bound = false;
  try {
    const st = fsOps.fstatSync(fd);
    const held = { dev: st.dev, ino: st.ino };
    if (hasComparableInode(judged) && hasComparableInode(held) && !sameFile(held, judged)) return { kind: "changed" };
    const sys = fsOps.procFd ?? realProcFdSyscalls;
    const magic = `${PROC_SELF_FD}/${fd}`;
    let ours;
    try {
      ours = sameHeldObject(sys.statSync(magic), held);
    } catch {
      ours = false;
    }
    if (!ours) {
      if (memory.get(sys) === "present") return { kind: "proc-lost" };
      memory.set(sys, "absent");
      return { kind: "unbound", dir: { dir, fd: null } };
    }
    memory.set(sys, "present");
    let named;
    try {
      named = sys.readlinkSync(magic);
    } catch {
      return { kind: "proc-lost" };
    }
    if (named !== dir) return { kind: "changed" };
    bound = true;
    return { kind: "bound", dir: { dir, fd } };
  } finally {
    if (!bound) fsOps.closeSync(fd);
  }
}
function boundPath(held, name) {
  return held.fd === null ? join6(held.dir, name) : `${PROC_SELF_FD}/${held.fd}/${name}`;
}
function fsyncDir2(held, fsOps) {
  fsOps.fsyncDir(held.fd === null ? held.dir : `${PROC_SELF_FD}/${held.fd}`);
}
function unbindError(e, held) {
  if (held.fd === null || e === null || typeof e !== "object") return e;
  const prefix = new RegExp(`${PROC_SELF_FD}/${held.fd}(?=[/']|$)`, "g");
  const fields = e;
  for (const key of ["message", "path", "dest"]) {
    const was = fields[key];
    if (typeof was !== "string") continue;
    const now = was.replace(prefix, () => held.dir);
    if (now !== was) {
      try {
        fields[key] = now;
      } catch {
      }
    }
  }
  return e;
}
function closeHeldDir(held, fsOps) {
  if (held.fd !== null) fsOps.closeSync(held.fd);
}

// src/memory/witness-core.ts
import { createHash as createHash2 } from "node:crypto";
function sha256Hex(bytes) {
  return createHash2("sha256").update(bytes).digest("hex");
}
function matchesAt(bytes, byteLength, prefixHash) {
  if (bytes.length < byteLength) return false;
  return sha256Hex(bytes.subarray(0, byteLength)) === prefixHash;
}
function classifyWitness(bytes, entry, journal) {
  if (journal) {
    const exact = bytes.length === journal.expected.byteLength && matchesAt(bytes, journal.expected.byteLength, journal.expected.prefixHash);
    if (exact) return { kind: "transition-heal", journal };
    const onLineage = matchesAt(bytes, journal.expected.byteLength, journal.expected.prefixHash) || journal.predecessor === null || matchesAt(bytes, journal.predecessor.byteLength, journal.predecessor.prefixHash);
    return onLineage ? { kind: "transition-interrupted", journal } : { kind: "mismatch" };
  }
  if (!entry) return { kind: "first-contact", reason: bytes.length === 0 ? "pristine" : "no-entry" };
  if (!matchesAt(bytes, entry.byteLength, entry.prefixHash)) return { kind: "mismatch" };
  return bytes.length === entry.byteLength ? { kind: "in-sync" } : { kind: "unwitnessed-suffix" };
}
function fenceId(epoch, nonce) {
  return `witness_fence_${epoch}_${nonce}`;
}

// src/memory/witness-store.ts
import { randomBytes as randomBytes3, createHmac as createHmac2, hkdfSync as hkdfSync2, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
import { lstatSync as lstatSync5, openSync as openSync4, fstatSync as fstatSync3, readFileSync as readFileSync3, closeSync as closeSync4, constants as constants3 } from "node:fs";
import { dirname as dirname6, join as join7 } from "node:path";
function witnessPath(home) {
  return join7(home, "witness.json");
}
function witnessLogPath(home) {
  return join7(home, "witness-log.jsonl");
}
function scopeKeyOf(home, projectRoot) {
  return projectRoot === void 0 ? "@global" : canonicalRoot(projectRoot);
}
var WitnessAdvanceError = class extends Error {
  /** The marker `isWitnessAdvanceError` reads. See there for why it is a property and not the class. */
  witnessAdvance = true;
  /** The state of the record that ALREADY LANDED when this throw happened. Set by the ONE caller that
   *  knows it — witness-write.ts's post-append `advanceWitness` call. Undefined for every
   *  rewrite-path throw, which refuses before the ledger moves, so `undefined` reads as "nothing is
   *  known to have landed", never as "nothing landed". */
  landedState;
  constructor(message) {
    super(message);
    this.name = "WitnessAdvanceError";
  }
};
function markRecordStored(e, state) {
  const mark = { recordStored: true, storedState: state };
  if (e instanceof Error) {
    try {
      Object.assign(e, mark);
      if (isRecordStoredError(e)) return e;
    } catch {
    }
  }
  return Object.assign(new Error("a step after the write failed", { cause: e }), mark);
}
var isRecordStoredError = (e) => e instanceof Error && e.recordStored === true;
function macKeyFor(scopeKey, master) {
  return Buffer.from(hkdfSync2("sha256", master, Buffer.from(scopeKey), "helix-witness-mac-v1", 32));
}
function macOf(scopeKey, master, record) {
  const payload = JSON.stringify({ ...record, mac: void 0 });
  return createHmac2("sha256", macKeyFor(scopeKey, master)).update(payload).digest("hex");
}
function verifyMac(scopeKey, master, record) {
  let got;
  try {
    got = Buffer.from(record.mac, "hex");
  } catch {
    return false;
  }
  const want = Buffer.from(macOf(scopeKey, master, record), "hex");
  return got.length === want.length && timingSafeEqual2(got, want);
}
function signedEntry(scopeKey, master, unsigned) {
  const base = { ...unsigned, mac: "" };
  return { ...base, mac: macOf(scopeKey, master, base) };
}
function signedJournal(scopeKey, master, unsigned) {
  const base = { ...unsigned, mac: "" };
  return { ...base, mac: macOf(scopeKey, master, base) };
}
var WITNESS_UNUSABLE_REFUSAL_BODY = (
  // 4.9 row "witness", verbatim after `<op>: `
  "the rollback-witness file cannot be used (its path cannot be resolved, a link stands at its name, it is not a regular file, or it cannot be read or parsed) \u2014 the write is refused rather than replacing that file, which would drop the baseline of every scope. Ask the user whether to restore it from a backup or to remove it, which starts every scope again from first contact; do not choose for them."
);
var WITNESS_TRANSIENT_FAILURE_BODY = (
  // no 4.9 row: no advice to remove the file
  "the rollback-witness file could not be read at this moment (the system is out of file descriptors, or the read was interrupted), so this call failed. The file itself was not found to be damaged; try the call again."
);
function witnessUnusableRefusal(op) {
  return `${op}: ${WITNESS_UNUSABLE_REFUSAL_BODY}`;
}
var WitnessUnusableError = class extends Error {
  // the marker; never `instanceof`
  constructor(op, reason) {
    super(reason === "transient" ? `${op}: ${WITNESS_TRANSIENT_FAILURE_BODY}` : witnessUnusableRefusal(op));
    this.op = op;
    this.reason = reason;
    this.name = "WitnessUnusableError";
  }
  op;
  reason;
  witnessUnusable = true;
};
var isWitnessUnusableError = (e) => e instanceof Error && e.witnessUnusable === true;
var TRANSIENT_READ_CODES = /* @__PURE__ */ new Set(["EMFILE", "ENFILE", "EINTR"]);
var codeOf2 = (e) => e?.code;
var WITNESS_READ_OPEN = constants3.O_RDONLY | constants3.O_NONBLOCK | constants3.O_NOFOLLOW;
var isEnvelope = (parsed) => {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const o = parsed;
  return o.v === 1 && o.scopes !== null && typeof o.scopes === "object" && !Array.isArray(o.scopes);
};
function readWitnessFile(rawPath, asGiven) {
  const r = resolvePath(rawPath);
  try {
    const st = lstatSync5(rawPath);
    if (st.isSymbolicLink()) return { kind: "unusable", reason: "link" };
    if (!st.isFile()) return { kind: "unusable", reason: "not-regular" };
  } catch (e) {
    if (TRANSIENT_READ_CODES.has(codeOf2(e) ?? "")) return { kind: "transient" };
  }
  let path;
  let given = false;
  if (r.kind === "unresolvable") {
    if (!asGiven) return { kind: "unusable", reason: "unresolvable" };
    path = rawPath;
    given = true;
  } else if (r.kind === "uninspectable") {
    const code = r.error.code ?? "";
    if (code === "ENOENT") return { kind: "absent", path: null, asGiven: false };
    return TRANSIENT_READ_CODES.has(code) ? { kind: "transient" } : { kind: "uninspectable", error: r.error };
  } else if (r.dirMissing) {
    return { kind: "absent", path: null, asGiven: false };
  } else path = r.path;
  let fd;
  try {
    fd = openSync4(path, WITNESS_READ_OPEN);
  } catch (e) {
    const code = codeOf2(e) ?? "";
    if (code === "ENOENT") return { kind: "absent", path, asGiven: given };
    if (code === "ELOOP") return { kind: "unusable", reason: "link" };
    return TRANSIENT_READ_CODES.has(code) ? { kind: "transient" } : { kind: "unusable", reason: "unreadable" };
  }
  let text;
  try {
    if (!fstatSync3(fd).isFile()) return { kind: "unusable", reason: "not-regular" };
    text = readFileSync3(fd, "utf8");
  } catch (e) {
    return TRANSIENT_READ_CODES.has(codeOf2(e) ?? "") ? { kind: "transient" } : { kind: "unusable", reason: "unreadable" };
  } finally {
    try {
      closeSync4(fd);
    } catch {
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unusable", reason: "unparseable" };
  }
  if (!isEnvelope(parsed)) return { kind: "unusable", reason: "unparseable" };
  return { kind: "store", path, store: { v: 1, scopes: parsed.scopes }, asGiven: given };
}
function assertWitnessPathLockable(rawPath, op) {
  let link = false;
  try {
    link = lstatSync5(rawPath).isSymbolicLink();
  } catch {
  }
  if (link) throw new WitnessUnusableError(op, "link");
  if (resolvePath(rawPath).kind === "unresolvable") throw new WitnessUnusableError(op, "unresolvable");
}
function loadStoreLocked(rawPath, op) {
  const f = readWitnessFile(rawPath, false);
  if (f.kind === "uninspectable") throw f.error;
  if (f.kind === "unusable") throw new WitnessUnusableError(op, f.reason);
  if (f.kind === "transient") throw new WitnessUnusableError(op, "transient");
  if (f.kind === "store") return { path: f.path, store: f.store };
  return { path: f.path ?? resolvedPathOrThrow(rawPath), store: { v: 1, scopes: {} } };
}
function assertReplaceTarget(path, op) {
  let st;
  try {
    st = lstatSync5(path);
  } catch (e) {
    const code = codeOf2(e) ?? "";
    if (code === "ENOENT") return;
    if (TRANSIENT_READ_CODES.has(code)) throw new WitnessUnusableError(op, "transient");
    throw e;
  }
  if (st.isSymbolicLink()) throw new WitnessUnusableError(op, "link");
  if (!st.isFile()) throw new WitnessUnusableError(op, "not-regular");
}
function writeStoreFileAt(path, store, fsOps = realFsOps, op = "witness") {
  const dir = dirname6(path);
  const tmp = `${path}.w-${randomBytes3(16).toString("hex")}.tmp`;
  sweepOrphanTmps(path, { fsOps, keep: tmp });
  const fd = fsOps.openSync(tmp, "wx");
  try {
    fsOps.fchmodSync(fd, 384);
    writeAll(fsOps, fd, JSON.stringify(store));
    fsOps.fsyncSync(fd);
    fsOps.closeSync(fd);
  } catch (e) {
    try {
      fsOps.closeSync(fd);
    } catch {
    }
    try {
      fsOps.unlinkSync(tmp);
    } catch {
    }
    throw e;
  }
  try {
    assertReplaceTarget(path, op);
  } catch (e) {
    try {
      fsOps.unlinkSync(tmp);
    } catch {
    }
    throw e;
  }
  fsOps.renameSync(tmp, path);
  fsOps.fsyncDir(dir);
}
function deriveState(scopeKey, master, raw) {
  if (!raw) return { entry: null, journal: null, macInvalid: false };
  let macInvalid = false;
  let entry = null;
  let journal = null;
  if (raw.entry) {
    if (master && verifyMac(scopeKey, master, raw.entry)) entry = raw.entry;
    else macInvalid = true;
  }
  if (raw.journal) {
    if (master && verifyMac(scopeKey, master, raw.journal)) journal = raw.journal;
    else macInvalid = true;
  }
  return { entry, journal, macInvalid };
}
function readScopeWitness(home, scopeKey, opts = {}) {
  const f = readWitnessFile(witnessPath(home), opts.unresolvable === "as-given");
  const op = opts.op ?? "witness";
  if (f.kind === "uninspectable") throw f.error;
  if (f.kind === "transient") throw new WitnessUnusableError(op, "transient");
  if (f.kind === "unusable" && opts.unusable !== "mark") throw new WitnessUnusableError(op, f.reason);
  if (f.kind === "absent" && f.path === null) return { entry: null, journal: null, macInvalid: false };
  const master = tryReadMaster(home);
  if (f.kind === "unusable") return { entry: null, journal: null, macInvalid: false, file: "unusable" };
  const state = deriveState(scopeKey, master, f.kind === "store" ? f.store.scopes[scopeKey] : void 0);
  return f.asGiven ? { ...state, file: "as-given" } : state;
}
function classifyState(state, bytes) {
  if (state.macInvalid) return { kind: "first-contact", reason: "mac-invalid" };
  return classifyWitness(bytes, state.entry, state.journal);
}
function appendWitnessLogLine(home, line, fsOps) {
  const fd = fsOps.openSync(witnessLogPath(home), "a", 384);
  try {
    writeAll(fsOps, fd, JSON.stringify(line) + "\n");
    fsOps.fsyncSync(fd);
  } finally {
    fsOps.closeSync(fd);
  }
}
function planTransition(home, scopeKey, kind) {
  void kind;
  const state = readScopeWitness(home, scopeKey);
  const entry = state.macInvalid ? null : state.entry;
  const pending = state.macInvalid ? null : state.journal;
  const epoch = Math.max((entry?.epoch ?? 0) + 1, pending ? pending.epoch + 1 : 0);
  const nonce = randomBytes3(16).toString("hex");
  const predecessor = entry ? { byteLength: entry.byteLength, prefixHash: entry.prefixHash } : null;
  const supersedes = pending?.nonce ?? null;
  return { epoch, nonce, predecessor, supersedes };
}
function openTransition(home, scopeKey, plan, fsOps = realFsOps) {
  const rawPath = witnessPath(home);
  assertWitnessPathLockable(rawPath, "openTransition");
  ensureHelixDir(home);
  const master = ensureMaster(home);
  return withFileLock(rawPath, () => {
    const { path, store } = loadStoreLocked(rawPath, "openTransition");
    const state = deriveState(scopeKey, master, store.scopes[scopeKey]);
    const entry = state.macInvalid ? null : state.entry;
    const pending = state.macInvalid ? null : state.journal;
    const pendingNonce = pending ? pending.nonce : null;
    if (!((entry?.epoch ?? 0) < plan.epoch && pendingNonce === plan.supersedes)) {
      throw new WitnessAdvanceError(
        "openTransition: plan is inconsistent with the current witness state (entry epoch not below plan epoch, or the pending journal to supersede changed) \u2014 the witness moved, re-plan"
      );
    }
    const unsigned = {
      kind: plan.kind,
      epoch: plan.epoch,
      predecessor: plan.predecessor,
      expected: plan.expected,
      nonce: plan.nonce,
      tx: plan.tx,
      supersedes: plan.supersedes
    };
    const journal = signedJournal(scopeKey, master, unsigned);
    appendWitnessLogLine(home, { v: 1, scope: scopeKey, epoch: plan.epoch, kind: plan.kind, tx: plan.tx, nonce: plan.nonce }, fsOps);
    const nextStore = { v: 1, scopes: { ...store.scopes, [scopeKey]: { entry, journal } } };
    writeStoreFileAt(path, nextStore, fsOps, "openTransition");
    return journal;
  });
}
function completeTransition(home, scopeKey, bytes, headTx, fsOps = realFsOps) {
  const rawPath = witnessPath(home);
  assertWitnessPathLockable(rawPath, "completeTransition");
  ensureHelixDir(home);
  const master = ensureMaster(home);
  withFileLock(rawPath, () => {
    const { path, store } = loadStoreLocked(rawPath, "completeTransition");
    const state = deriveState(scopeKey, master, store.scopes[scopeKey]);
    const journal = state.macInvalid ? null : state.journal;
    if (!journal) throw new WitnessAdvanceError("completeTransition: no pending journal for scope");
    const entry = state.macInvalid ? null : state.entry;
    if (entry !== null && entry.epoch >= journal.epoch) {
      throw new WitnessAdvanceError("completeTransition: stale journal \u2014 the witness already reached or passed its target epoch (a journal can never lower the witness)");
    }
    const verdict = classifyWitness(bytes, null, journal);
    if (verdict.kind !== "transition-heal") {
      throw new WitnessAdvanceError("completeTransition: bytes do not exactly match the journaled expected head");
    }
    const unsigned = { epoch: journal.epoch, byteLength: journal.expected.byteLength, prefixHash: journal.expected.prefixHash, headTx };
    const nextEntry = signedEntry(scopeKey, master, unsigned);
    const nextStore = { v: 1, scopes: { ...store.scopes, [scopeKey]: { entry: nextEntry, journal: null } } };
    writeStoreFileAt(path, nextStore, fsOps, "completeTransition");
  });
}
function journalPublished(home, scopeKey, nonce) {
  const state = readScopeWitness(home, scopeKey);
  return !state.macInvalid && state.journal !== null && state.journal.nonce === nonce;
}
function discardTransition(home, scopeKey, nonce, fsOps = realFsOps) {
  const rawPath = witnessPath(home);
  assertWitnessPathLockable(rawPath, "discardTransition");
  ensureHelixDir(home);
  const master = ensureMaster(home);
  withFileLock(rawPath, () => {
    const { path, store } = loadStoreLocked(rawPath, "discardTransition");
    const state = deriveState(scopeKey, master, store.scopes[scopeKey]);
    const journal = state.macInvalid ? null : state.journal;
    if (!journal) throw new WitnessAdvanceError("discardTransition: no pending journal for scope");
    if (journal.nonce !== nonce) {
      throw new WitnessAdvanceError("discardTransition: the pending journal belongs to a different transition (superseded meanwhile?) \u2014 refusing to retract it");
    }
    if (journal.supersedes !== null) {
      throw new WitnessAdvanceError(
        "discardTransition: this transition superseded a still-unresolved one, whose evidence the single journal slot no longer holds \u2014 retracting would clear an alarm this writer cannot vouch for; leaving it pending for a re-drive instead"
      );
    }
    const entry = state.macInvalid ? null : state.entry;
    appendWitnessLogLine(home, { v: 1, scope: scopeKey, epoch: journal.epoch, kind: journal.kind, tx: journal.tx, nonce: journal.nonce, op: "discard" }, fsOps);
    const nextStore = { v: 1, scopes: { ...store.scopes, [scopeKey]: { entry, journal: null } } };
    writeStoreFileAt(path, nextStore, fsOps, "discardTransition");
  });
}

// src/memory/ledger.ts
function witnessFenceRecord(epoch, nonce, tx) {
  return {
    id: fenceId(epoch, nonce),
    tx,
    validFrom: tx,
    validTo: null,
    type: "verify",
    state: "Suspect",
    content: "",
    provenance: { source: "user", sessionId: "witness" },
    supersedes: null,
    blastRadius: null,
    reverifyTrigger: null,
    classification: "normal"
  };
}
function aliasedLedgerMessage(nlink) {
  return `ledger has ${nlink} hard links \u2014 aliased ledgers are unsupported (see SECURITY.md); refusing to write`;
}
function aliasedLedgerRefusal(rawPath) {
  let st;
  const r = resolvePath(rawPath);
  if (r.kind !== "resolved" || r.dirMissing) return null;
  try {
    st = statSync4(r.path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  return st.nlink === 1 ? null : aliasedLedgerMessage(st.nlink);
}
var DESTINATION_CHANGED_REFUSAL = "commit: this project's memory file changed while the write was in progress \u2014 nothing was written. Try the commit again; if it happens again, tell the user.";
var LedgerDestinationChangedError = class extends Error {
  /** The marker isLedgerDestinationChangedError reads (a property, never class identity). */
  ledgerDestinationChanged = true;
  constructor(message = DESTINATION_CHANGED_REFUSAL) {
    super(message);
    this.name = "LedgerDestinationChangedError";
  }
};
var isLedgerDestinationChangedError = (e) => e instanceof Error && e.ledgerDestinationChanged === true;
var LedgerCreateRefusedError = class extends Error {
  constructor(code) {
    super("the memory file could not be created exclusively: something stands at its name");
    this.code = code;
    this.name = "LedgerCreateRefusedError";
  }
  code;
  ledgerCreateRefused = true;
};
var PROC_LOST_REFUSAL = "Helix can no longer confirm which folder this write goes into, because the system's process file table became unavailable after this session started \u2014 nothing was written. Restart the session; if it happens again, tell the user.";
var LedgerProcLostError = class extends Error {
  /** The marker isLedgerProcLostError reads (a property, never class identity). */
  ledgerProcLost = true;
  constructor(message = PROC_LOST_REFUSAL) {
    super(message);
    this.name = "LedgerProcLostError";
  }
};
var APPEND_OPEN = constants4.O_RDWR | constants4.O_APPEND | constants4.O_NOFOLLOW;
var DESTINATION_CHANGED_OPEN_ERRORS = /* @__PURE__ */ new Set(["ELOOP", "EISDIR", "ENOENT"]);
function openForAppend(path, absentWhenJudged, mustCreate, fsOps) {
  if (absentWhenJudged || mustCreate) {
    try {
      return { fd: fsOps.openSync(path, APPEND_OPEN | constants4.O_CREAT | constants4.O_EXCL, 384), created: true };
    } catch (e) {
      const code = e.code;
      if (mustCreate && (code === "EEXIST" || code === "ELOOP")) throw new LedgerCreateRefusedError(code);
      if (DESTINATION_CHANGED_OPEN_ERRORS.has(code ?? "")) throw new LedgerDestinationChangedError();
      if (code !== "EEXIST") throw e;
    }
  }
  try {
    return { fd: fsOps.openSync(path, APPEND_OPEN), created: false };
  } catch (e) {
    if (DESTINATION_CHANGED_OPEN_ERRORS.has(e.code ?? "")) throw new LedgerDestinationChangedError();
    throw e;
  }
}
function destinationUnchanged(rawPath, path, judged, opened) {
  if (hasComparableInode(judged) && hasComparableInode(opened) && !sameFile(judged, opened)) return false;
  const again = resolvePath(rawPath);
  if (again.kind !== "resolved" || again.dirMissing || again.path !== path) return false;
  let now;
  try {
    now = fileIdentityAt(again.path);
  } catch {
    return false;
  }
  if (now === null) return false;
  if (!hasComparableInode(now) || !hasComparableInode(opened)) return true;
  return sameFile(now, opened);
}
function removeOwnCreation(path, opened, fsOps) {
  try {
    if (!sameFile(fileIdentityAt(path), opened)) return;
    fsOps.unlinkSync(path);
    fsOps.fsyncDir(dirname7(path));
  } catch {
  }
}
function appendRecordUnlocked(rawPath, record, fsOps = realFsOps, judged) {
  mkdirSync3(dirname7(rawPath), { recursive: true });
  const path = resolvedPathOrThrow(rawPath);
  if (judged !== void 0 && judged.path !== path) throw new LedgerDestinationChangedError();
  const before = judged !== void 0 ? judged.identity : fileIdentityAt(path);
  const dirSample = judged !== void 0 && judged.dir !== void 0 ? judged.dir : sampleDirIdentity(dirname7(path));
  const bound = openJudgedDir(dirname7(path), dirSample, fsOps);
  if (bound.kind === "changed") throw new LedgerDestinationChangedError();
  if (bound.kind === "proc-lost") throw new LedgerProcLostError();
  const held = bound.dir;
  let rowDurable = false;
  try {
    try {
      const at = boundPath(held, basename4(path));
      const { fd, created } = openForAppend(at, before === null, judged?.createExclusive === true, fsOps);
      let opened = null;
      const undoCreation = () => {
        if (created && opened !== null) removeOwnCreation(at, opened, fsOps);
      };
      try {
        const st = fsOps.fstatSync(fd);
        opened = { dev: st.dev, ino: st.ino };
        if (!destinationUnchanged(rawPath, path, before, opened)) throw new LedgerDestinationChangedError();
        if (st.nlink === 0) throw new LedgerDestinationChangedError();
        if (st.nlink !== 1) throw new Error(`appendRecord: ${aliasedLedgerMessage(st.nlink)}`);
        sweepOrphanTmps(at, { fsOps });
        if (fsOps.fstatSync(fd).nlink === 0) throw new LedgerDestinationChangedError();
        let line = JSON.stringify(record) + "\n";
        if (st.size > 0) {
          const tail = Buffer.alloc(1);
          fsOps.readSync(fd, tail, 0, 1, st.size - 1);
          if (tail[0] !== 10) line = "\n" + line;
        }
        writeAll(fsOps, fd, line);
        fsOps.fsyncSync(fd);
        rowDurable = true;
      } catch (e) {
        undoCreation();
        throw e;
      } finally {
        fsOps.closeSync(fd);
      }
      fsyncDir2(held, fsOps);
    } finally {
      closeHeldDir(held, fsOps);
    }
  } catch (e) {
    throw unbindError(rowDurable ? markRecordStored(e, record.state) : e, held);
  }
}
var MAX_PARSE_DEPTH = 64;
function withinDepth(v, max) {
  const stack = [{ v, d: 0 }];
  while (stack.length) {
    const { v: cur, d } = stack.pop();
    if (cur === null || typeof cur !== "object") continue;
    if (d >= max) return false;
    for (const child of Array.isArray(cur) ? cur : Object.values(cur)) {
      if (child !== null && typeof child === "object") stack.push({ v: child, d: d + 1 });
    }
  }
  return true;
}
function isWellFormedRecord(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v;
  return typeof r.id === "string" && typeof r.content === "string" && typeof r.tx === "string" && typeof r.provenance === "object" && r.provenance !== null && withinDepth(v, MAX_PARSE_DEPTH);
}
var LEDGER_CONTENT_READ_BOUND_BYTES = 1024 * 1024;
var RECORD_KEY_NAMES = ['"id"', '"content"', '"tx"', '"provenance"'].map((k) => Buffer.from(k));
function mayBeRecordLine(line) {
  let e = line.length - 1;
  while (e >= 0 && (line[e] === 32 || line[e] === 9 || line[e] === 13)) e--;
  if (e < 0 || line[e] !== 125) return false;
  if (line.indexOf(92) !== -1) return true;
  for (const k of RECORD_KEY_NAMES) if (line.indexOf(k) === -1) return false;
  return true;
}
function ledgerContentKindOfFd(fd) {
  const LEAD = 0, MAYBE_BLANK = 1, CANDIDATE = 2, SKIP = 3;
  const chunk = Buffer.allocUnsafe(65536);
  let state = LEAD;
  let sawNonBlank = false;
  let pending = [];
  let decoder = null;
  const endLine = () => {
    let record = false;
    if (state === CANDIDATE) {
      const line = pending.length === 1 ? pending[0] : Buffer.concat(pending);
      if (mayBeRecordLine(line)) {
        try {
          record = isWellFormedRecord(JSON.parse(line.toString("utf8")));
        } catch {
        }
      }
      pending = [];
    } else if (state === MAYBE_BLANK) {
      if (decoder.end().trim() !== "") sawNonBlank = true;
      decoder = null;
    }
    state = LEAD;
    return record;
  };
  for (let pos = 0; ; ) {
    if (pos >= LEDGER_CONTENT_READ_BOUND_BYTES) {
      if (readSync3(fd, chunk, 0, 1, pos) === 0) break;
      return "other";
    }
    const n = readSync3(fd, chunk, 0, Math.min(chunk.length, LEDGER_CONTENT_READ_BOUND_BYTES - pos), pos);
    if (n === 0) break;
    pos += n;
    const buf = chunk.subarray(0, n);
    for (let i = 0; i < n; ) {
      const nl = buf.indexOf(10, i);
      const end = nl === -1 ? n : nl;
      let j = i;
      if (state === LEAD) {
        while (j < end && (buf[j] === 32 || buf[j] === 9 || buf[j] === 13)) j++;
        if (j < end) {
          const b = buf[j];
          if (b === 123) {
            state = CANDIDATE;
            sawNonBlank = true;
          } else if (sawNonBlank || b < 128 && b !== 11 && b !== 12) {
            state = SKIP;
            sawNonBlank = true;
          } else {
            state = MAYBE_BLANK;
            decoder = new StringDecoder("utf8");
          }
        }
      }
      if (j < end) {
        if (state === CANDIDATE) pending.push(nl !== -1 && pending.length === 0 ? buf.subarray(j, end) : Buffer.from(buf.subarray(j, end)));
        else if (state === MAYBE_BLANK && decoder.write(buf.subarray(j, end)).trim() !== "") {
          sawNonBlank = true;
          state = SKIP;
          decoder = null;
        }
      }
      if (nl === -1) break;
      if (endLine()) return "rows";
      i = nl + 1;
    }
  }
  if (endLine()) return "rows";
  return sawNonBlank ? "other" : "empty";
}
var LedgerNotRegularError = class extends Error {
  /** The marker isLedgerNotRegularError reads (a property, never class identity: see isWitnessAdvanceError). */
  ledgerNotRegular = true;
  constructor(path) {
    super(`ledger ${path} is not a regular file`);
    this.name = "LedgerNotRegularError";
  }
};
var MAX_LEDGER_READ_BYTES = 2 ** 31 - 1;
function readLedgerFileBytesExact(path, flags, shownAs = path) {
  let fd;
  try {
    fd = openSync5(path, flags);
  } catch (e) {
    const code = e.code;
    if (code !== "ENOENT" && code !== "ELOOP") {
      let st = null;
      try {
        st = statSync4(path);
      } catch {
      }
      if (st !== null && !st.isFile()) throw new LedgerNotRegularError(shownAs);
    }
    throw e;
  }
  try {
    const st = fstatSync4(fd);
    if (!st.isFile()) throw new LedgerNotRegularError(shownAs);
    if (st.size > MAX_LEDGER_READ_BYTES) {
      throw Object.assign(new RangeError(`File size (${st.size}) is greater than 2 GiB`), { code: "ERR_FS_FILE_TOO_LARGE" });
    }
    const buf = Buffer.alloc(st.size);
    let len = 0;
    while (len < buf.length) {
      const n = readSync3(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
    }
    return len === buf.length ? buf : buf.subarray(0, len);
  } finally {
    try {
      closeSync5(fd);
    } catch {
    }
  }
}
function readLedgerFileBytes(rawPath, opts = {}) {
  const flags = constants4.O_RDONLY | constants4.O_NONBLOCK;
  const r = resolvePath(rawPath);
  if (r.kind === "uninspectable") throw r.error;
  if (r.kind === "resolved") {
    if (r.dirMissing) throw r.dirError ?? Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    return readLedgerFileBytesExact(r.path, flags | constants4.O_NOFOLLOW, rawPath);
  }
  if (opts.unresolvable !== "as-given") throw new UnresolvablePathError(r.cause);
  try {
    return readLedgerFileBytesExact(rawPath, flags);
  } catch (e) {
    const code = e.code;
    if (code === "ELOOP" || code === "ENAMETOOLONG") {
      throw Object.assign(new Error("ENOENT: the global memory file cannot be opened by its path as given"), { code: "ENOENT" });
    }
    throw e;
  }
}
function readLedgerBytes(path, opts) {
  try {
    return readLedgerFileBytes(path, opts);
  } catch (err) {
    if (err.code === "ENOENT") return Buffer.alloc(0);
    throw err;
  }
}

// src/memory/ownership.ts
import { mkdirSync as mkdirSync4, readFileSync as readFileSync4, renameSync as renameSync2, unlinkSync as unlinkSync4, lstatSync as lstatSync6, fstatSync as fstatSync5, fchmodSync as fchmodSync2, openSync as openSync6, readSync as readSync4, writeSync as writeSync2, fsyncSync as fsyncSync3, closeSync as closeSync6, constants as constants5 } from "node:fs";
import { join as join8, resolve as resolve2, dirname as dirname8, basename as basename5, isAbsolute as isAbsolute2 } from "node:path";
function projectLedgerPath(projectRoot) {
  return join8(projectRoot, ".helix", "memory.jsonl");
}
var GLOBAL_KEY = "@global";
function registryPath(home) {
  return join8(home, "projects.json");
}
function ownerFile(projectRoot) {
  return join8(projectRoot, ".helix", ".owner");
}
function isPlainObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isValidRegistry(x) {
  if (!isPlainObject(x)) return false;
  for (const v of Object.values(x)) {
    if (!isPlainObject(v)) return false;
    if (typeof v.stamp !== "string" || typeof v.adoptedAt !== "string" || typeof v.macNonce !== "string") return false;
    if (v.trustState !== void 0 && v.trustState !== "active" && v.trustState !== "pending") return false;
  }
  return true;
}
function loadRegistry(home) {
  const path = registryPath(home);
  let st;
  try {
    st = lstatSync6(path);
  } catch (e) {
    return e.code === "ENOENT" ? { kind: "absent" } : { kind: "corrupt" };
  }
  if (st.isSymbolicLink()) return { kind: "corrupt" };
  let text;
  try {
    text = readFileSync4(path, "utf8");
  } catch {
    return { kind: "corrupt" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "corrupt" };
  }
  if (!isValidRegistry(parsed)) return { kind: "corrupt" };
  return { kind: "ok", reg: parsed };
}
function readRegistry(home) {
  const r = loadRegistry(home);
  return r.kind === "ok" ? r.reg : {};
}
function readOwner(projectRoot, ownerDir) {
  const path = ownerPlace(projectRoot, ownerDir);
  try {
    if (!viaDescriptor(ownerDir) && lstatSync6(dirname8(path)).isSymbolicLink()) return null;
    const st = lstatSync6(path);
    if (!st.isFile()) return null;
    if (st.nlink > 1) return null;
    return readFileSync4(path, "utf8").trim();
  } catch {
    return null;
  }
}
function isOwned(projectRoot, home) {
  const entry = readRegistry(home)[canonicalRoot(projectRoot)];
  if (!entry) return false;
  const stamp = readOwner(projectRoot);
  return stamp !== null && stamp === entry.stamp;
}
function ownerPlace(projectRoot, ownerDir) {
  return ownerDir === void 0 ? ownerFile(projectRoot) : boundPath(ownerDir, ".owner");
}
function viaDescriptor(ownerDir) {
  return ownerDir !== void 0 && ownerDir.fd !== null;
}
var under2 = (dir, name) => dir === "/" ? `/${name}` : `${dir}/${name}`;
function withinDir(dir, path) {
  return path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);
}
function standingAt(path) {
  try {
    const st = lstatSync6(path, { bigint: true });
    return { dev: st.dev, ino: st.ino, regular: st.isFile(), nlink: st.nlink };
  } catch (e) {
    return e.code === "ENOENT" ? null : "error";
  }
}
function compareWith(dest, targetPath) {
  const t = resolvePath(targetPath);
  const named = t.kind === "resolved";
  if (t.kind === "resolved" && t.path === dest.path) return { same: true, named };
  if (dest.id === null) return { same: false, named };
  try {
    return { same: sameFile(dest.id, fileIdentityAt(t.kind === "resolved" ? t.path : targetPath, { follow: t.kind !== "resolved" })), named };
  } catch {
    return { same: false, named };
  }
}
var CONTENT_KIND_CACHE_MAX = 64;
var CONTENT_KIND_SETTLED_NS = 2000000000n;
var contentKindCache = /* @__PURE__ */ new Map();
function contentKindOfOpenFile(fd, fresh) {
  if (fresh) return ledgerContentKindOfFd(fd);
  const before = fstatSync5(fd, { bigint: true });
  if (before.ino === 0n) return ledgerContentKindOfFd(fd);
  const key = `${before.dev}:${before.ino}`;
  const hit = contentKindCache.get(key);
  if (hit !== void 0 && hit.size === before.size && hit.mtimeNs === before.mtimeNs && hit.ctimeNs === before.ctimeNs) return hit.kind;
  contentKindCache.delete(key);
  const kind = ledgerContentKindOfFd(fd);
  const after = fstatSync5(fd, { bigint: true });
  const newest = after.mtimeNs > after.ctimeNs ? after.mtimeNs : after.ctimeNs;
  const unchanged = after.size === before.size && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs;
  if (unchanged && BigInt(Date.now()) * 1000000n - newest > CONTENT_KIND_SETTLED_NS) {
    if (contentKindCache.size >= CONTENT_KIND_CACHE_MAX) contentKindCache.clear();
    contentKindCache.set(key, { size: after.size, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs, kind });
  }
  return kind;
}
function openedVerdict(path, readContent, fresh) {
  let fd;
  try {
    fd = openSync6(path, constants5.O_RDONLY | constants5.O_NOFOLLOW | constants5.O_NONBLOCK);
  } catch {
    return "unreadable";
  }
  try {
    if (!fstatSync5(fd).isFile()) return "not-regular";
    if (!readContent) return "ok";
    try {
      return contentKindOfOpenFile(fd, fresh) === "other" ? "not-ledger-content" : "ok";
    } catch {
      return "unreadable";
    }
  } finally {
    closeSync6(fd);
  }
}
function isGlobalLedgerEntry(projectLedger, globalLedger) {
  if (basename5(projectLedger) !== basename5(globalLedger)) return false;
  if (projectLedger !== globalLedger) {
    const da = resolvePath(dirname8(projectLedger)), db = resolvePath(dirname8(globalLedger));
    if (da.kind !== "resolved" || db.kind !== "resolved" || da.path !== db.path) return false;
  }
  try {
    return !lstatSync6(projectLedger).isSymbolicLink();
  } catch {
    return true;
  }
}
function judgeProjectLayer(project, opts = {}) {
  try {
    return judge(project, opts.forAdopt === true, opts.freshContent === true);
  } catch {
    return { state: "unusable", row: "5", cause: "uninspectable" };
  }
}
function judge(project, forAdopt, freshContent) {
  if (!project) return { state: "inactive", row: "1" };
  const owned = isOwned(project.root, project.home);
  if (project.origin === "ancestor" && !owned && !forAdopt) return { state: "ancestor-unadopted", row: "2" };
  let helix = null;
  try {
    helix = lstatSync6(join8(project.root, ".helix"));
  } catch {
  }
  if (helix !== null && !helix.isDirectory()) return { state: "unusable", row: "3", cause: "helix-not-directory" };
  const dest = resolvePath(project.ledger);
  const root = resolvePath(resolve2(project.root));
  if (dest.kind === "unresolvable" || root.kind === "unresolvable") return { state: "aliased", row: "4", cause: "unresolvable" };
  if (dest.kind === "uninspectable" || root.kind === "uninspectable") return { state: "unusable", row: "5", cause: "uninspectable" };
  const destination = dest.path;
  if (!withinDir(root.path, destination)) return { state: "aliased", row: "6", cause: "outside-root", destination };
  const id = standingAt(destination);
  if (id === "error") return { state: "unusable", row: "9", cause: "unreadable", destination };
  let memoryPathIsLink = false;
  try {
    memoryPathIsLink = lstatSync6(project.ledger).isSymbolicLink();
  } catch {
  }
  const isOwnPath = destination === under2(root.path, ".helix/memory.jsonl");
  const g = compareWith({ path: destination, id }, project.globalLedger);
  if (g.same) return { state: "aliased", row: "7", cause: "global-ledger", destination };
  if (!isOwnPath) {
    if (!g.named && memoryPathIsLink) return { state: "aliased", row: "7", cause: "unjudgeable-target", destination };
    const home = resolvePath(project.home);
    if (home.kind === "resolved" && withinDir(home.path, destination)) return { state: "aliased", row: "7", cause: "home-directory", destination };
    const ownKey = canonicalRoot(project.root);
    for (const key of Object.keys(readRegistry(project.home))) {
      if (key === GLOBAL_KEY || key === ownKey) continue;
      const ledgerOfKey = projectLedgerPath(key);
      const c = compareWith({ path: destination, id }, ledgerOfKey);
      if (c.same) return { state: "aliased", row: "7", cause: "other-project", destination };
      if (!c.named) {
        const r = resolvePath(key);
        if (withinDir(r.kind === "resolved" ? r.path : key, destination)) return { state: "aliased", row: "7", cause: "unjudgeable-target", destination };
      }
    }
  }
  if (id !== null) {
    if (id.regular && id.nlink !== 1n) return { state: "aliased", row: "8", cause: "hard-link", destination };
    if (!id.regular) return { state: "unusable", row: "9", cause: "not-regular", destination };
    const opened = openedVerdict(destination, memoryPathIsLink, freshContent);
    if (opened === "not-ledger-content") return { state: "unusable", row: "9a", cause: opened, destination };
    if (opened !== "ok") return { state: "unusable", row: "9", cause: opened, destination };
  } else if (memoryPathIsLink && dest.dirMissing) {
    return { state: "unusable", row: "10", cause: "target-directory-missing", destination };
  }
  const identity = id === null ? null : { dev: id.dev, ino: id.ino };
  const dirIdentity = sampleDirIdentity(dirname8(destination));
  if (owned) return { state: "owned", row: "11", destination, identity, dirIdentity };
  if (id !== null) return { state: "unadopted-present", row: "12", destination, identity, dirIdentity };
  return { state: "inactive", row: "13", destination, identity, dirIdentity };
}

// src/memory/scope-target.ts
function resolveScopeTarget(home, globalLedger, scope) {
  if (scope === "global") return { ok: true, ledger: globalLedger, scopeKey: scopeKeyOf(home) };
  const ledger = projectLedgerPath(scope);
  if (isGlobalLedgerEntry(ledger, globalLedger)) {
    const g = resolvePath(globalLedger);
    return { ok: false, reason: "aliases-global", cause: "global-store", ledger, destination: g.kind === "resolved" ? g.path : void 0 };
  }
  const j = judgeProjectLayer({ root: scope, ledger, home, globalLedger });
  if (j.state === "aliased" || j.state === "unusable") {
    const cause = j.cause ?? "uninspectable";
    const reason = j.state === "unusable" ? "unusable" : cause === "global-ledger" ? "aliases-global" : cause === "other-project" ? "aliases-project" : "aliased";
    return { ok: false, reason, cause, ledger, destination: j.destination };
  }
  return { ok: true, ledger, scopeKey: scopeKeyOf(home, scope), destination: j.destination };
}

// src/memory/global-ledger.ts
import { lstatSync as lstatSync7, statSync as statSync5 } from "node:fs";
import { dirname as dirname9 } from "node:path";
var isLink = (p) => {
  try {
    return lstatSync7(p).isSymbolicLink();
  } catch {
    return false;
  }
};
function danglingFolderLinkAbove(path) {
  for (let dir = dirname9(path); dirname9(dir) !== dir; dir = dirname9(dir)) {
    let link;
    try {
      link = lstatSync7(dir).isSymbolicLink();
    } catch {
      continue;
    }
    if (!link) continue;
    try {
      statSync5(dir);
    } catch (e) {
      return e.code === "ENOENT";
    }
  }
  return false;
}
function globalLedgerWriteState(path) {
  const r = resolvePath(path);
  if (r.kind === "unresolvable") return { kind: "read-only", cause: "unresolvable" };
  if (r.kind === "resolved" && r.dirMissing && (isLink(path) || danglingFolderLinkAbove(path))) {
    return { kind: "read-only", cause: "target-directory-missing" };
  }
  return { kind: "writable" };
}
var isGlobalLedgerReadOnly = (path) => globalLedgerWriteState(path).kind === "read-only";
var CAUSE = "the global memory file's path cannot be resolved (a name that is not valid UTF-8, a path past the system limit, too many links, or a link into a directory that does not exist)";
var TAIL = "Tell the user that the global memory path needs repair; do not repair it for them.";
var refusal = (op) => `${op}: ${CAUSE} \u2014 nothing was written. ${TAIL}`;
var GLOBAL_WRITE_REFUSAL = {
  commit: refusal("commit"),
  erase: refusal("erase"),
  confirm: refusal("confirm"),
  recheck: refusal("recheck"),
  compaction: refusal("compaction")
};

// scripts/rebaseline-cli.ts
var USAGE = "usage: helix-rebaseline --scope global | --scope <absoluteProjectRoot>\n";
var CONFIRM_PROMPT = 'Type "bless" to re-baseline: ';
var GLOBAL_LEDGER_FILE = "memory.jsonl";
function parseScope(argv) {
  if (argv.length !== 2 || argv[0] !== "--scope") return null;
  const scope = argv[1];
  if (!scope) return null;
  if (scope !== "global" && !isAbsolute3(scope)) return null;
  return scope;
}
function resolveHome(env) {
  return env.HELIX_HOME ?? join9(homedir(), ".helix");
}
function resolveGlobalLedger(env, home) {
  return env.HELIX_LEDGER ?? join9(home, GLOBAL_LEDGER_FILE);
}
async function defaultPromptLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
var CAUSE_TEXT = {
  "outside-root": "this project's memory file resolves outside this project.",
  "home-directory": "this project's memory file resolves into the Helix home directory.",
  "unjudgeable-target": "this project's memory file cannot be told from another Helix memory file, because that file's path cannot be resolved.",
  "hard-link": "this project's memory file has more than one hard link.",
  unresolvable: "this project's memory file cannot be resolved (a name that is not valid UTF-8, a path past the system limit, or too many links).",
  uninspectable: "this project's memory file cannot be inspected (a folder on the way cannot be read, or is not a directory).",
  "helix-not-directory": "this project's .helix is not a real directory (a file, a link or another object stands at that name).",
  "not-regular": "this project's memory file is not a regular file.",
  unreadable: "this project's memory file cannot be opened for reading.",
  "not-ledger-content": "this project's memory file is a link to a file that does not hold Helix memory records.",
  "target-directory-missing": "this project's memory file is a link into a folder that does not exist."
};
var TAIL_ELSEWHERE = "Re-baselining it would record a file that is not this project's own under this project's witness identity.\nReplace it with the project's own file, then re-run.\n";
var TAIL_PATH = "Nothing was written. Repair the path (or replace the link with the project's own file), then re-run.\n";
var TAIL_UNUSABLE = "Nothing was written. Repair the project's memory file, then re-run.\n";
var PATH_CAUSES = /* @__PURE__ */ new Set(["unresolvable", "unjudgeable-target"]);
function scopeRefusalText(globalLedger, scope, target) {
  const { cause, destination } = target;
  if (cause === "global-store" || cause === "global-ledger") {
    return `helix-rebaseline: REFUSING - ${scope} resolves to the global ledger, not a separate project ledger.
  resolved ledger: ${destination ?? target.ledger}
  global ledger  : ${globalLedger}
Re-baselining it under a project scope key would record one file under two witness identities.
Use: --scope global
`;
  }
  if (cause === "other-project") {
    return `helix-rebaseline: REFUSING - ${scope}'s ledger resolves to another adopted project's ledger file.
  resolved ledger: ${destination ?? target.ledger}
Re-baselining it would record one file under two project witness identities.
Replace the link with the project's own file, then re-run.
`;
  }
  const tail = target.reason === "unusable" ? TAIL_UNUSABLE : PATH_CAUSES.has(cause) ? TAIL_PATH : TAIL_ELSEWHERE;
  return `helix-rebaseline: REFUSING - ${CAUSE_TEXT[cause]}
` + (destination !== void 0 ? `  resolved ledger: ${destination}
` : "") + tail;
}
function computeAppendedBytes(existing, record) {
  const line = Buffer.from(JSON.stringify(record) + "\n", "utf8");
  const needsSeparator = existing.length > 0 && existing[existing.length - 1] !== 10;
  return needsSeparator ? Buffer.concat([existing, Buffer.from("\n"), line]) : Buffer.concat([existing, line]);
}
var NOTE_APPEND_REFUSED_RETRACTED = "append refused before any byte landed -- the opened witness journal was retracted; nothing written\n";
var NOTE_PUBLISH_FAILED_RETRACTED = "the witness journal was left by a publication that failed -- it was retracted; nothing written\n";
var REBASELINE_GLOBAL_READ_ONLY_REFUSAL = "helix-rebaseline: REFUSING - the global memory file's path cannot be resolved (a name that is not valid UTF-8, a path past the system limit, too many links, or a link into a directory that does not exist).\nNothing was written. Repair that path (HELIX_LEDGER, or a link on it), then re-run.\n";
var REBASELINE_WITNESS_UNUSABLE_REFUSAL = "helix-rebaseline: REFUSING - the rollback-witness file cannot be used (its path cannot be resolved, a link stands at its name, it is not a regular file, or it cannot be read or parsed).\nA re-baseline would replace that file and drop the baseline of every other scope. Nothing was written. Restore the file from a backup, or, if you accept that every scope starts again from first contact, remove it; then re-run.\n";
var REBASELINE_DESTINATION_CHANGED_REFUSAL = "helix-rebaseline: REFUSING - the memory file changed while the re-baseline was in progress, so no fence was written.\nCheck what the memory path leads to now, then re-run.\n";
async function main(argv, deps = {}) {
  const exit = deps.exit ?? ((code) => {
    process.exitCode = code;
  });
  const scope = parseScope(argv);
  if (scope === null) {
    process.stderr.write(USAGE);
    exit(2);
    return 2;
  }
  const isTTY = deps.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!isTTY) {
    process.stderr.write("rebaseline requires an interactive terminal\n");
    exit(2);
    return 2;
  }
  let fenceAppended = false;
  try {
    const env = deps.env ?? process.env;
    const now = deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
    const promptLine = deps.promptLine ?? defaultPromptLine;
    const home = resolveHome(env);
    const globalLedger = resolveGlobalLedger(env, home);
    if (scope === "global" && isGlobalLedgerReadOnly(globalLedger)) {
      process.stderr.write(REBASELINE_GLOBAL_READ_ONLY_REFUSAL);
      exit(2);
      return 2;
    }
    const target = resolveScopeTarget(home, globalLedger, scope);
    if (!target.ok) {
      process.stderr.write(scopeRefusalText(globalLedger, scope, target));
      exit(2);
      return 2;
    }
    const { ledger, scopeKey } = target;
    const aliased = aliasedLedgerRefusal(ledger);
    if (aliased !== null) {
      process.stderr.write(`helix-rebaseline: REFUSING - ${aliased}
`);
      exit(2);
      return 2;
    }
    mkdirSync5(dirname10(ledger), { recursive: true });
    const code = await withFileLockAsync(ledger, async () => {
      const displayedBytes = readLedgerBytes(ledger);
      const displayedHash = sha256Hex(displayedBytes);
      const state = readScopeWitness(home, scopeKey);
      const verdict = classifyState(state, displayedBytes);
      const currentEntry = state.macInvalid ? null : state.entry;
      const currentEpoch = currentEntry?.epoch ?? 0;
      const displayPlan = planTransition(home, scopeKey, "rebaseline");
      process.stdout.write(`scope: ${scope}
`);
      process.stdout.write(`bytes: ${displayedBytes.length}
`);
      process.stdout.write(`sha256: ${displayedHash}
`);
      process.stdout.write(`epoch: ${currentEpoch} -> ${displayPlan.epoch}
`);
      process.stdout.write(`verdict: ${verdict.kind}
`);
      const answer = await promptLine(CONFIRM_PROMPT);
      if (answer.trim() !== "bless") {
        process.stderr.write("confirmation not given -- nothing written\n");
        exit(1);
        return 1;
      }
      const currentBytes = readLedgerBytes(ledger);
      if (sha256Hex(currentBytes) !== displayedHash) {
        process.stderr.write("ledger changed during confirmation\n");
        exit(3);
        return 3;
      }
      const aliasedNow = aliasedLedgerRefusal(ledger);
      if (aliasedNow !== null) {
        process.stderr.write(`ledger changed during confirmation -- ${aliasedNow}
`);
        exit(3);
        return 3;
      }
      const plan = planTransition(home, scopeKey, "rebaseline");
      const fence = witnessFenceRecord(plan.epoch, plan.nonce, now());
      const finalBytes = computeAppendedBytes(currentBytes, fence);
      const expected = { byteLength: finalBytes.length, prefixHash: sha256Hex(finalBytes) };
      let journalOpened = false;
      try {
        openTransition(home, scopeKey, {
          kind: "rebaseline",
          epoch: plan.epoch,
          nonce: plan.nonce,
          predecessor: plan.predecessor,
          supersedes: plan.supersedes,
          expected,
          tx: fence.tx
        });
        journalOpened = true;
        appendRecordUnlocked(ledger, fence);
      } catch (e) {
        try {
          if (journalPublished(home, scopeKey, plan.nonce) && readLedgerBytes(ledger).equals(currentBytes)) {
            discardTransition(home, scopeKey, plan.nonce);
            process.stderr.write(journalOpened ? NOTE_APPEND_REFUSED_RETRACTED : NOTE_PUBLISH_FAILED_RETRACTED);
          }
        } catch {
        }
        throw e;
      }
      fenceAppended = true;
      const landedBytes = readLedgerBytes(ledger);
      completeTransition(home, scopeKey, landedBytes, fence.tx);
      process.stdout.write(`re-baselined ${scope} at epoch ${plan.epoch}
`);
      exit(0);
      return 0;
    });
    return code;
  } catch (e) {
    if (!fenceAppended && isLedgerDestinationChangedError(e)) {
      process.stderr.write(REBASELINE_DESTINATION_CHANGED_REFUSAL);
      exit(2);
      return 2;
    }
    if (!fenceAppended && isWitnessUnusableError(e) && e.reason !== "transient") {
      process.stderr.write(REBASELINE_WITNESS_UNUSABLE_REFUSAL);
      exit(2);
      return 2;
    }
    process.stderr.write(`helix-rebaseline: ${e instanceof Error ? e.message : String(e)}
`);
    exit(1);
    return 1;
  }
}
void main(process.argv.slice(2));
export {
  REBASELINE_DESTINATION_CHANGED_REFUSAL,
  main
};
