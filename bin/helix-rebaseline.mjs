// scripts/rebaseline-cli.ts
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { isAbsolute, dirname as dirname6, join as join6 } from "node:path";
import { mkdirSync as mkdirSync4 } from "node:fs";

// src/memory/lock.ts
import { readFileSync as readFileSync2, writeFileSync, unlinkSync, linkSync, lstatSync, realpathSync, rmSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, basename, join } from "node:path";

// src/memory/lock-liveness.ts
import { readFileSync, readlinkSync } from "node:fs";
import { threadId } from "node:worker_threads";
function parseAfterLastParen(stat) {
  const i = stat.lastIndexOf(")");
  if (i < 0) return null;
  return stat.slice(i + 2).split(" ");
}
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
  bootInstantMs() {
    try {
      return Date.now() - Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1e3;
    } catch {
      return null;
    }
  }
};
function selfIdentity(token, probe = realProbe) {
  return { v: 1, token, pid: process.pid, startTicks: probe.startTicksOf(process.pid), bootId: probe.bootId(), pidNs: probe.pidNs(), threadId, platform: process.platform };
}
var isStringOrNull = (x) => x === null || typeof x === "string";
function tryParsePayload(raw) {
  try {
    const p = JSON.parse(raw);
    if (p === null || typeof p !== "object" || p.v !== 1) return null;
    if (typeof p.token !== "string" || typeof p.pid !== "number" || typeof p.threadId !== "number" || typeof p.platform !== "string") return null;
    if (!isStringOrNull(p.startTicks) || !isStringOrNull(p.bootId) || !isStringOrNull(p.pidNs)) return null;
    return p;
  } catch {
    return null;
  }
}
function classifyHolder(recorded, self, probe) {
  if (recorded.platform !== self.platform) return "alive-unknown";
  if (recorded.bootId !== null && self.bootId !== null && recorded.bootId !== self.bootId) return "dead";
  if (recorded.bootId === null !== (self.bootId === null)) return "alive-unknown";
  if (recorded.pidNs !== self.pidNs) return "alive-unknown";
  if (!Number.isSafeInteger(recorded.pid) || recorded.pid <= 0) return "alive-unknown";
  if (recorded.pid === self.pid && recorded.startTicks === self.startTicks) {
    return recorded.threadId === self.threadId ? "reentrant-self" : "alive";
  }
  const k = probe.kill0(recorded.pid);
  if (k === "dead") return "dead";
  if (k === "unknown") return "alive-unknown";
  if (recorded.startTicks !== null) {
    const cur = probe.startTicksOf(recorded.pid);
    if (cur !== null && cur !== recorded.startTicks) return "dead";
    if (cur === null && k === "alive") return "alive-unknown";
  }
  const st = probe.stateOf(recorded.pid);
  if (st === "Z" || st === "X") return "dead";
  return "alive";
}

// src/memory/lock.ts
var RETRY_MS = 25;
var DEFAULT_MAX_WAIT_MS = 5e3;
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function canonical(target) {
  try {
    return realpathSync(target);
  } catch {
    return join(realpathSync(dirname(target)), basename(target));
  }
}
function timeoutMessage(lockPath, holder, waitedMs) {
  const who = holder ? `held by pid ${holder.pid} (started ticks ${holder.startTicks ?? "unknown"})` : "holder unreadable (never auto-reclaimed)";
  return `withFileLock: timed out after ${waitedMs}ms acquiring ${lockPath} \u2014 ${who}. Verify liveness with: kill -0 <pid>. If (and only if) the holder is truly gone, remove the lock file manually.`;
}
function acquireFileLock(target, opts = {}) {
  const probe = opts.probe ?? realProbe;
  const canon = canonical(target);
  const lockPath = canon + ".lock";
  const token = randomBytes(16).toString("hex");
  const self = selfIdentity(token, probe);
  const payloadText = JSON.stringify(self);
  if (tryParsePayload(payloadText) === null) throw new Error("withFileLock: internal \u2014 payload failed its own well-formedness check");
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  let waited = 0;
  let lastHolder = null;
  for (; ; ) {
    const srcTmp = `${canon}.lk-${randomBytes(16).toString("hex")}.tmp`;
    try {
      writeFileSync(srcTmp, payloadText, { flag: "wx" });
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
        if (waited >= maxWaitMs) throw new Error(timeoutMessage(lockPath, null, waited));
        sleepSync(RETRY_MS);
        waited += RETRY_MS;
        continue;
      }
      if (code !== "EEXIST") throw e;
    }
    let holder;
    lastHolder = null;
    try {
      const st = lstatSync(lockPath);
      if (st.isDirectory()) {
        holder = classifyLegacyDir(lockPath, probe);
      } else {
        const raw = readFileSync2(lockPath, "utf8");
        const parsed = tryParsePayload(raw);
        if (parsed === null) {
          const boot = probe.bootInstantMs();
          holder = boot !== null && st.mtimeMs < boot ? "dead" : "alive-unknown";
        } else {
          lastHolder = parsed;
          holder = classifyHolder(parsed, self, probe);
        }
      }
    } catch {
      continue;
    }
    if (holder === "reentrant-self")
      throw new Error(`withFileLock: re-entrant acquisition of ${lockPath} from the same thread (pid ${process.pid}) \u2014 withFileLock is not re-entrant`);
    if (holder === "dead") stealUnderGate(lockPath, probe);
    if (waited >= maxWaitMs) throw new Error(timeoutMessage(lockPath, lastHolder, waited));
    sleepSync(RETRY_MS);
    waited += RETRY_MS;
  }
  const ctx = {
    stillOwned() {
      try {
        return tryParsePayload(readFileSync2(lockPath, "utf8"))?.token === token;
      } catch {
        return false;
      }
    }
  };
  const release = () => {
    try {
      if (!lstatSync(lockPath).isDirectory() && tryParsePayload(readFileSync2(lockPath, "utf8"))?.token === token) unlinkSync(lockPath);
    } catch {
    }
  };
  return { ctx, release };
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
function classifyLegacyDir(lockPath, probe) {
  let raw;
  try {
    raw = readFileSync2(join(lockPath, "owner"), "utf8");
  } catch {
    return "alive-unknown";
  }
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
  const dir = dirname(lockPath);
  const prefix = `${basename(lockPath)}.reap.`;
  for (const name of readdirSyncSafe(dir)) {
    if (name.startsWith(prefix) && name !== basename(gatePath)) {
      try {
        unlinkSync(join(dir, name));
      } catch {
      }
    }
  }
  const gateToken = randomBytes(16).toString("hex");
  const gateSrc = `${gatePath}.src-${gateToken}.tmp`;
  try {
    writeFileSync(gateSrc, JSON.stringify(selfIdentity(gateToken, probe)), { flag: "wx" });
    try {
      linkSync(gateSrc, gatePath);
    } finally {
      try {
        unlinkSync(gateSrc);
      } catch {
      }
    }
  } catch {
    return;
  }
  try {
    const st = lstatSync(lockPath);
    if (st.isDirectory()) {
      if (classifyLegacyDir(lockPath, probe) !== "dead") return;
      rmSync(lockPath, { recursive: true, force: true });
    } else {
      const raw = readFileSync2(lockPath, "utf8");
      const parsed = tryParsePayload(raw);
      if (parsed !== null) {
        if (classifyHolder(parsed, selfIdentity(gateToken, probe), probe) !== "dead") return;
      } else {
        const boot = probe.bootInstantMs();
        if (boot === null || st.mtimeMs >= boot) return;
      }
      unlinkSync(lockPath);
    }
  } catch {
  } finally {
    try {
      if (tryParsePayload(readFileSync2(gatePath, "utf8"))?.token === gateToken) unlinkSync(gatePath);
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
import { readFileSync as readFileSync5, mkdirSync as mkdirSync3, statSync as statSync2 } from "node:fs";
import { dirname as dirname5 } from "node:path";

// src/memory/fs-ops.ts
import { openSync, readSync, writeSync, fsyncSync, closeSync, fstatSync, renameSync, unlinkSync as unlinkSync2, linkSync as linkSync2, fchmodSync, readdirSync as readdirSync2 } from "node:fs";
function fsyncDir(dir) {
  let dfd;
  try {
    dfd = openSync(dir, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(dfd);
  } catch {
  } finally {
    closeSync(dfd);
  }
}
var realFsOps = {
  openSync,
  readSync,
  writeSync,
  fsyncSync,
  closeSync,
  fstatSync: (fd) => {
    const s = fstatSync(fd);
    return { size: s.size, nlink: s.nlink, mode: s.mode };
  },
  renameSync,
  unlinkSync: unlinkSync2,
  linkSync: linkSync2,
  fchmodSync,
  readdirSync: (d) => readdirSync2(d),
  fsyncDir
};
function writeAll(fs, fd, text) {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

// src/memory/ledger-sweep.ts
import { dirname as dirname2, basename as basename2, join as join2 } from "node:path";
var HEX32 = "[0-9a-f]{32}";
function orphanTmpPattern(base) {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc}\\.(c-${HEX32}|lk-${HEX32}|k-${HEX32}|w-${HEX32}|\\d+)\\.tmp$`);
}
function sweepOrphanTmps(artifactPath, opts = {}) {
  const fs = opts.fsOps ?? realFsOps;
  const dir = dirname2(artifactPath);
  const pat = orphanTmpPattern(basename2(artifactPath));
  const keepName = opts.keep ? basename2(opts.keep) : null;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!pat.test(name) || name === keepName) continue;
    fs.unlinkSync(join2(dir, name));
    removed++;
  }
  if (removed > 0) fs.fsyncDir(dir);
  return removed;
}

// src/memory/witness-core.ts
import { createHash } from "node:crypto";
function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function matchesAt(bytes, byteLength, prefixHash) {
  if (bytes.length < byteLength) return false;
  return sha256Hex(bytes.subarray(0, byteLength)) === prefixHash;
}
function classifyWitness(bytes, entry, journal) {
  if (journal) {
    const exact = bytes.length === journal.expected.byteLength && matchesAt(bytes, journal.expected.byteLength, journal.expected.prefixHash);
    return exact ? { kind: "transition-heal", journal } : { kind: "transition-interrupted", journal };
  }
  if (!entry) return { kind: "first-contact", reason: "no-entry" };
  if (!matchesAt(bytes, entry.byteLength, entry.prefixHash)) return { kind: "mismatch" };
  return bytes.length === entry.byteLength ? { kind: "in-sync" } : { kind: "unwitnessed-suffix" };
}
function fenceId(epoch, nonce) {
  return `witness_fence_${epoch}_${nonce}`;
}

// src/memory/witness-store.ts
import { randomBytes as randomBytes3, createHmac as createHmac2, hkdfSync as hkdfSync2, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync4, openSync as openSync3, writeSync as writeSync3, fsyncSync as fsyncSync3, closeSync as closeSync3 } from "node:fs";
import { dirname as dirname4, join as join4, resolve } from "node:path";

// src/memory/ledger-mac.ts
import { createHash as createHash2, createHmac, hkdfSync, randomBytes as randomBytes2, timingSafeEqual } from "node:crypto";
import { openSync as openSync2, writeSync as writeSync2, fsyncSync as fsyncSync2, closeSync as closeSync2, readFileSync as readFileSync3, linkSync as linkSync3, unlinkSync as unlinkSync3, statSync, chmodSync, mkdirSync } from "node:fs";
import { dirname as dirname3, join as join3 } from "node:path";
var LedgerMacError = class extends Error {
};
var MASTER_LEN = 32;
function masterPath(home) {
  return join3(home, "ledger-mac-master.key");
}
function ensureMaster(home) {
  const path = masterPath(home);
  const existing = tryReadMasterStrict(path);
  if (existing) return existing;
  mkdirSync(home, { recursive: true });
  return withFileLock(path, () => {
    const again = tryReadMasterStrict(path);
    if (again) return again;
    sweepOrphanTmps(path, {});
    const key = randomBytes2(MASTER_LEN);
    const tmp = `${path}.k-${randomBytes2(16).toString("hex")}.tmp`;
    const fd = openSync2(tmp, "wx", 384);
    let published = false;
    try {
      try {
        writeSync2(fd, key);
        fsyncSync2(fd);
      } finally {
        closeSync2(fd);
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
    fsyncDir(dirname3(path));
    if (published) return key;
    const winner = tryReadMasterStrict(path);
    if (!winner) throw new LedgerMacError("master key vanished during concurrent mint");
    return winner;
  });
}
function tryReadMasterStrict(path) {
  let buf;
  try {
    buf = readFileSync3(path);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  if (buf.length !== MASTER_LEN) throw new LedgerMacError(`corrupt master key (${buf.length} bytes, want ${MASTER_LEN})`);
  try {
    if ((statSync(path).mode & 63) !== 0) chmodSync(path, 384);
  } catch {
  }
  return buf;
}
function tryReadMaster(home) {
  return tryReadMasterStrict(masterPath(home));
}
var DOMAIN = Buffer.from("helix-ledger-mac");
var NULL_FIELD = Buffer.from([0, 0, 0, 0, 0]);

// src/memory/witness-store.ts
function witnessPath(home) {
  return join4(home, "witness.json");
}
function witnessLogPath(home) {
  return join4(home, "witness-log.jsonl");
}
function scopeKeyOf(home, projectRoot) {
  return projectRoot === void 0 ? "@global" : resolve(projectRoot);
}
var WitnessAdvanceError = class extends Error {
};
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
function readStoreFileAt(path) {
  try {
    const parsed = JSON.parse(readFileSync4(path, "utf8"));
    return { v: 1, scopes: parsed.scopes ?? {} };
  } catch {
    return { v: 1, scopes: {} };
  }
}
function writeStoreFileAt(path, store, fsOps = realFsOps) {
  const dir = dirname4(path);
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
function readScopeWitness(home, scopeKey) {
  const path = canonical(witnessPath(home));
  const store = readStoreFileAt(path);
  return deriveState(scopeKey, tryReadMaster(home), store.scopes[scopeKey]);
}
function classifyState(state, bytes) {
  if (state.macInvalid) return { kind: "first-contact", reason: "mac-invalid" };
  return classifyWitness(bytes, state.entry, state.journal);
}
function appendWitnessLogLine(home, line) {
  const fd = openSync3(witnessLogPath(home), "a", 384);
  try {
    writeSync3(fd, Buffer.from(JSON.stringify(line) + "\n", "utf8"));
    fsyncSync3(fd);
  } finally {
    closeSync3(fd);
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
  mkdirSync2(home, { recursive: true });
  const master = ensureMaster(home);
  const rawPath = witnessPath(home);
  return withFileLock(rawPath, () => {
    const path = canonical(rawPath);
    const store = readStoreFileAt(path);
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
    appendWitnessLogLine(home, { v: 1, scope: scopeKey, epoch: plan.epoch, kind: plan.kind, tx: plan.tx, nonce: plan.nonce });
    const nextStore = { v: 1, scopes: { ...store.scopes, [scopeKey]: { entry, journal } } };
    writeStoreFileAt(path, nextStore, fsOps);
    return journal;
  });
}
function completeTransition(home, scopeKey, bytes, headTx, fsOps = realFsOps) {
  mkdirSync2(home, { recursive: true });
  const master = ensureMaster(home);
  const rawPath = witnessPath(home);
  withFileLock(rawPath, () => {
    const path = canonical(rawPath);
    const store = readStoreFileAt(path);
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
    writeStoreFileAt(path, nextStore, fsOps);
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
function appendRecordUnlocked(rawPath, record, fsOps = realFsOps) {
  mkdirSync3(dirname5(rawPath), { recursive: true });
  const path = canonical(rawPath);
  sweepOrphanTmps(path, { fsOps });
  const fd = fsOps.openSync(path, "a+");
  try {
    const st = fsOps.fstatSync(fd);
    if (st.nlink !== 1) throw new Error(`appendRecord: ledger has ${st.nlink} hard links \u2014 aliased ledgers are unsupported (see SECURITY.md); refusing to write`);
    let line = JSON.stringify(record) + "\n";
    if (st.size > 0) {
      const tail = Buffer.alloc(1);
      fsOps.readSync(fd, tail, 0, 1, st.size - 1);
      if (tail[0] !== 10) line = "\n" + line;
    }
    writeAll(fsOps, fd, line);
    fsOps.fsyncSync(fd);
  } finally {
    fsOps.closeSync(fd);
  }
  fsOps.fsyncDir(dirname5(path));
}
function readLedgerBytes(path) {
  try {
    return readFileSync5(path);
  } catch (err) {
    if (err.code === "ENOENT") return Buffer.alloc(0);
    throw err;
  }
}

// src/memory/ownership.ts
import { join as join5, resolve as resolve2 } from "node:path";
function projectLedgerPath(projectRoot) {
  return join5(projectRoot, ".helix", "memory.jsonl");
}

// scripts/rebaseline-cli.ts
var USAGE = "usage: helix-rebaseline --scope global | --scope <absoluteProjectRoot>\n";
var CONFIRM_PROMPT = 'Type "bless" to re-baseline: ';
var GLOBAL_LEDGER_FILE = "memory.jsonl";
function parseScope(argv) {
  if (argv.length !== 2 || argv[0] !== "--scope") return null;
  const scope = argv[1];
  if (!scope) return null;
  if (scope !== "global" && !isAbsolute(scope)) return null;
  return scope;
}
function resolveHome(env) {
  return env.HELIX_HOME ?? join6(homedir(), ".helix");
}
function resolveGlobalLedger(env, home) {
  return env.HELIX_LEDGER ?? join6(home, GLOBAL_LEDGER_FILE);
}
async function defaultPromptLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
function computeAppendedBytes(existing, record) {
  const line = Buffer.from(JSON.stringify(record) + "\n", "utf8");
  const needsSeparator = existing.length > 0 && existing[existing.length - 1] !== 10;
  return needsSeparator ? Buffer.concat([existing, Buffer.from("\n"), line]) : Buffer.concat([existing, line]);
}
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
  try {
    const env = deps.env ?? process.env;
    const now = deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
    const promptLine = deps.promptLine ?? defaultPromptLine;
    const home = resolveHome(env);
    const ledger = scope === "global" ? resolveGlobalLedger(env, home) : projectLedgerPath(scope);
    const scopeKey = scope === "global" ? scopeKeyOf(home) : scopeKeyOf(home, scope);
    mkdirSync4(dirname6(ledger), { recursive: true });
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
      const plan = planTransition(home, scopeKey, "rebaseline");
      const fence = witnessFenceRecord(plan.epoch, plan.nonce, now());
      const finalBytes = computeAppendedBytes(currentBytes, fence);
      const expected = { byteLength: finalBytes.length, prefixHash: sha256Hex(finalBytes) };
      openTransition(home, scopeKey, {
        kind: "rebaseline",
        epoch: plan.epoch,
        nonce: plan.nonce,
        predecessor: plan.predecessor,
        supersedes: plan.supersedes,
        expected,
        tx: fence.tx
      });
      appendRecordUnlocked(ledger, fence);
      const landedBytes = readLedgerBytes(ledger);
      completeTransition(home, scopeKey, landedBytes, fence.tx);
      process.stdout.write(`re-baselined ${scope} at epoch ${plan.epoch}
`);
      exit(0);
      return 0;
    });
    return code;
  } catch (e) {
    process.stderr.write(`helix-rebaseline: ${e instanceof Error ? e.message : String(e)}
`);
    exit(1);
    return 1;
  }
}
void main(process.argv.slice(2));
export {
  main
};
