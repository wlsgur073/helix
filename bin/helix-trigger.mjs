// scripts/trigger-measure.ts
import { constants as constants8, lstatSync as lstatSync8 } from "node:fs";
import { dirname as dirname5, join as join7 } from "node:path";
import { homedir } from "node:os";

// src/memory/fs-ops.ts
import { openSync, readSync, writeSync, fsyncSync, closeSync, fstatSync, statSync, readlinkSync, renameSync, unlinkSync, linkSync, fchmodSync, readdirSync } from "node:fs";
var realDirFsyncSyscalls = { openSync, fsyncSync, closeSync };
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
var realFsOps = {
  openSync,
  readSync,
  writeSync,
  fsyncSync,
  closeSync,
  fstatSync: (fd) => {
    const s = fstatSync(fd, { bigint: true });
    return { size: Number(s.size), nlink: Number(s.nlink), mode: Number(s.mode), dev: s.dev, ino: s.ino };
  },
  renameSync,
  unlinkSync,
  linkSync,
  fchmodSync,
  readdirSync: (d) => readdirSync(d),
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

// src/memory/ownership.ts
import { mkdirSync as mkdirSync4, readFileSync as readFileSync3, renameSync as renameSync2, unlinkSync as unlinkSync3, lstatSync as lstatSync6, fstatSync as fstatSync6, fchmodSync as fchmodSync3, openSync as openSync6, readSync as readSync3, writeSync as writeSync2, fsyncSync as fsyncSync3, closeSync as closeSync6, constants as constants6 } from "node:fs";
import { join as join4, resolve as resolve2, dirname as dirname3, basename as basename2, isAbsolute as isAbsolute2 } from "node:path";

// src/memory/path-identity.ts
import { lstatSync, readlinkSync as readlinkSync2, realpathSync, statSync as statSync2 } from "node:fs";
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
    statSync2(p);
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
  const given2 = input === "" ? "." : input;
  if (namesDirectory(given2)) return directoryAnswer(given2);
  let p = given2;
  for (let hops = 0; ; hops++) {
    let isLink;
    try {
      isLink = lstatSync(p).isSymbolicLink();
    } catch (e) {
      return codeOf(e) === "ENOENT" ? creationAnswer(p) : failureOf(e);
    }
    if (!isLink) return existingAnswer(p);
    if (hops === 0) {
      try {
        statSync2(p);
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
var realIdentityProbe = (path, follow) => {
  try {
    const st = follow ? statSync2(path, { bigint: true }) : lstatSync(path, { bigint: true });
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
var LOCK_READ_MAX_BYTES = 64 * 1024;

// src/memory/home-permissions.ts
import { lstatSync as lstatSync2, chmodSync, readdirSync as readdirSync2, mkdirSync, existsSync } from "node:fs";
import { join as join2, dirname as dirname2, sep } from "node:path";

// src/memory/home-env.ts
import { posix, win32 } from "node:path";
var HomeRefusalError = class extends Error {
  constructor(homeRefusalCause, message) {
    super(message);
    this.homeRefusalCause = homeRefusalCause;
    this.name = "HomeRefusalError";
  }
  homeRefusalCause;
  /** The marker isHomeRefusalError reads (a property, never class identity: a module loaded twice mints two classes). */
  homeRefusal = true;
};
var isHomeRefusalError = (e) => e instanceof Error && e.homeRefusal === true;
var RELATIVE_VALUE_TEXT = {
  HELIX_HOME: "HELIX_HOME is not an absolute path, so it is refused",
  HELIX_LEDGER: "HELIX_LEDGER is not an absolute path, so it is refused",
  HELIX_SESSIONS: "HELIX_SESSIONS is not an absolute path, so it is refused"
};
var UNRESOLVABLE_HOME_TEXT = "the Helix home cannot be resolved (a name that is not valid UTF-8, a path past the system limit, or too many links), so it is refused";
var given = (v) => v === void 0 || v === "" ? null : v;
function absoluteOrRefuse(variable, value, isAbsolute4) {
  if (!isAbsolute4(value)) throw new HomeRefusalError("relative-value", RELATIVE_VALUE_TEXT[variable]);
  return value;
}
function withoutTrailingSlashOrDot(p) {
  let n = p;
  for (; ; ) {
    if (n.length > 1 && n.endsWith("/")) {
      n = n.slice(0, -1);
      continue;
    }
    if (n.length > 2 && n.endsWith("/.")) {
      n = n.slice(0, -2);
      continue;
    }
    return n;
  }
}
function kernelWayHome(path) {
  const name = withoutTrailingSlashOrDot(path);
  const last = name.slice(name.lastIndexOf("/") + 1);
  const namesDirectory2 = last === "" || last === "." || last === "..";
  const r = resolvePath(namesDirectory2 ? name : posix.dirname(name));
  if (r.kind === "unresolvable") throw new HomeRefusalError("unresolvable-home", UNRESOLVABLE_HOME_TEXT);
  if (r.kind === "uninspectable") return path;
  return namesDirectory2 ? r.path : posix.join(r.path, last);
}
function resolveHelixPaths(env, userHome, platform = process.platform) {
  const p = platform === "win32" ? win32 : posix;
  const homeValue = absoluteOrRefuse("HELIX_HOME", given(env.HELIX_HOME) ?? p.join(userHome, ".helix"), p.isAbsolute);
  const ledger = given(env.HELIX_LEDGER);
  if (ledger !== null) absoluteOrRefuse("HELIX_LEDGER", ledger, p.isAbsolute);
  const sessions = given(env.HELIX_SESSIONS);
  if (sessions !== null) absoluteOrRefuse("HELIX_SESSIONS", sessions, p.isAbsolute);
  const home = platform === "win32" ? homeValue : kernelWayHome(homeValue);
  return { home, globalLedger: ledger ?? p.join(home, "memory.jsonl"), sessionsFile: sessions ?? p.join(home, "sessions.jsonl") };
}

// src/memory/home-permissions.ts
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
    st = lstatSync2(name);
  } catch {
    st = null;
  }
  if (st !== null) {
    if (st.isSymbolicLink()) throw new HomeRefusalError("symlinked-home", `refusing to use ${dir}: it is a symlink, not a directory Helix owns`);
    if (!st.isDirectory()) throw new HomeRefusalError("not-a-directory", `refusing to use ${dir}: it exists and is not a directory`);
    const uid = process.getuid?.();
    if (uid !== void 0 && st.uid !== uid) {
      throw new HomeRefusalError("foreign-owner", `refusing to use ${dir}: it is owned by uid ${st.uid}, not by this user (${uid})`);
    }
    return;
  }
  const parent = dirname2(name);
  if (!existsSync(parent)) {
    throw new HomeRefusalError("parent-missing", `refusing to create ${dir}: its parent ${parent} does not exist (Helix creates one directory, never a chain)`);
  }
  try {
    mkdirSync(name, { mode: 448 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    ensureHelixDir(name);
  }
}

// src/memory/home-files.ts
import { closeSync as closeSync2, constants, fstatSync as fstatSync2, openSync as openSync2 } from "node:fs";
var NOT_REGULAR_HOME_FILE_TEXT = "A Helix data file is not a regular file.";
var NotRegularHomeFileError = class extends Error {
  /** The marker isNotRegularHomeFileError reads (a property, never class identity: a module loaded twice mints two classes). */
  notRegularHomeFile = true;
  constructor() {
    super(NOT_REGULAR_HOME_FILE_TEXT);
    this.name = "NotRegularHomeFileError";
  }
};
var READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;
var APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK;
var isEnxio = (e) => e.code === "ENXIO";
function refuseUnlessRegular(fd) {
  let regular = false;
  try {
    regular = fstatSync2(fd).isFile();
  } finally {
    if (!regular) {
      try {
        closeSync2(fd);
      } catch {
      }
    }
  }
  if (!regular) throw new NotRegularHomeFileError();
}
function openHomeFileForRead(path) {
  let fd;
  try {
    fd = openSync2(path, READ_FLAGS);
  } catch (e) {
    if (isEnxio(e)) throw new NotRegularHomeFileError();
    throw e;
  }
  refuseUnlessRegular(fd);
  return fd;
}
var CONTROL_FILES = [
  "audit.jsonl",
  "sessions.jsonl",
  "metrics.jsonl",
  "trigger.jsonl",
  "codex-log.jsonl",
  "witness.json",
  "witness-log.jsonl",
  "projects.json",
  "ledger-mac-master.key",
  "config.json"
];
var HOME_CONTROL_NAMES = [
  ...CONTROL_FILES,
  ...["memory.jsonl", ...CONTROL_FILES].map((name) => `${name}.lock`)
];
var HEX32 = "[0-9a-f]{32}";
var escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var TEMP_FAMILIES = ["memory.jsonl", ...CONTROL_FILES].map((stem) => [stem, new RegExp(`^${escapeRe(stem)}\\.(?:(?:c|lk|k|w)-${HEX32}|[0-9a-f]{16}|\\d+)\\.tmp$`), `${stem}.lock.reap.`]);

// src/memory/ledger.ts
import { mkdirSync as mkdirSync3, statSync as statSync3, openSync as openSync5, fstatSync as fstatSync5, readSync as readSync2, closeSync as closeSync5, constants as constants5 } from "node:fs";
import { StringDecoder } from "node:string_decoder";

// src/memory/ledger-mac.ts
import { openSync as openSync3, fsyncSync as fsyncSync2, closeSync as closeSync3, readFileSync, linkSync as linkSync2, unlinkSync as unlinkSync2, lstatSync as lstatSync3, fstatSync as fstatSync3, fchmodSync as fchmodSync2, constants as constants2 } from "node:fs";
var ILL_FORMED_TAG = Buffer.from([255, 1]);
var KEY_REPAIR_OPEN = constants2.O_RDONLY | constants2.O_NOFOLLOW | constants2.O_NONBLOCK;
var DOMAIN = Buffer.from("helix-ledger-mac");
var NULL_FIELD = Buffer.from([0, 0, 0, 0, 0]);

// src/memory/dir-bound.ts
import { lstatSync as lstatSync4, constants as constants3 } from "node:fs";
import { join as join3 } from "node:path";
var PROC_SELF_FD = "/proc/self/fd";
var DIR_OPEN = constants3.O_RDONLY | constants3.O_DIRECTORY | constants3.O_NOFOLLOW;
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
function boundPath(held, name) {
  return held.fd === null ? join3(held.dir, name) : `${PROC_SELF_FD}/${held.fd}/${name}`;
}

// src/memory/witness-store.ts
import { lstatSync as lstatSync5, openSync as openSync4, fstatSync as fstatSync4, readFileSync as readFileSync2, closeSync as closeSync4, constants as constants4 } from "node:fs";
var WITNESS_READ_OPEN = constants4.O_RDONLY | constants4.O_NONBLOCK | constants4.O_NOFOLLOW;

// src/memory/ledger.ts
var APPEND_OPEN = constants5.O_RDWR | constants5.O_APPEND | constants5.O_NOFOLLOW;
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
      if (readSync2(fd, chunk, 0, 1, pos) === 0) break;
      return "other";
    }
    const n = readSync2(fd, chunk, 0, Math.min(chunk.length, LEDGER_CONTENT_READ_BOUND_BYTES - pos), pos);
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
        st = statSync3(path);
      } catch {
      }
      if (st !== null && !st.isFile()) throw new LedgerNotRegularError(shownAs);
    }
    throw e;
  }
  try {
    const st = fstatSync5(fd);
    if (!st.isFile()) throw new LedgerNotRegularError(shownAs);
    if (st.size > MAX_LEDGER_READ_BYTES) {
      throw Object.assign(new RangeError(`File size (${st.size}) is greater than 2 GiB`), { code: "ERR_FS_FILE_TOO_LARGE" });
    }
    const buf = Buffer.alloc(st.size);
    let len = 0;
    while (len < buf.length) {
      const n = readSync2(fd, buf, len, buf.length - len, null);
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
  const flags = constants5.O_RDONLY | constants5.O_NONBLOCK;
  const r = resolvePath(rawPath);
  if (r.kind === "uninspectable") throw r.error;
  if (r.kind === "resolved") {
    if (r.dirMissing) throw r.dirError ?? Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    return readLedgerFileBytesExact(r.path, flags | constants5.O_NOFOLLOW, rawPath);
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

// src/memory/ownership.ts
function projectLedgerPath(projectRoot) {
  return join4(projectRoot, ".helix", "memory.jsonl");
}
var GLOBAL_KEY = "@global";
function registryPath(home) {
  return join4(home, "projects.json");
}
function ownerFile(projectRoot) {
  return join4(projectRoot, ".helix", ".owner");
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
    const fd = openHomeFileForRead(path);
    try {
      text = readFileSync3(fd, "utf8");
    } finally {
      closeSync6(fd);
    }
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
    if (!viaDescriptor(ownerDir) && lstatSync6(dirname3(path)).isSymbolicLink()) return null;
    const st = lstatSync6(path);
    if (!st.isFile()) return null;
    if (st.nlink > 1) return null;
    return readFileSync3(path, "utf8").trim();
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
  const before = fstatSync6(fd, { bigint: true });
  if (before.ino === 0n) return ledgerContentKindOfFd(fd);
  const key = `${before.dev}:${before.ino}`;
  const hit = contentKindCache.get(key);
  if (hit !== void 0 && hit.size === before.size && hit.mtimeNs === before.mtimeNs && hit.ctimeNs === before.ctimeNs) return hit.kind;
  contentKindCache.delete(key);
  const kind = ledgerContentKindOfFd(fd);
  const after = fstatSync6(fd, { bigint: true });
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
    fd = openSync6(path, constants6.O_RDONLY | constants6.O_NOFOLLOW | constants6.O_NONBLOCK);
  } catch {
    return "unreadable";
  }
  try {
    if (!fstatSync6(fd).isFile()) return "not-regular";
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
    helix = lstatSync6(join4(project.root, ".helix"));
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
  const dirIdentity = sampleDirIdentity(dirname3(destination));
  if (owned) return { state: "owned", row: "11", destination, identity, dirIdentity };
  if (id !== null) return { state: "unadopted-present", row: "12", destination, identity, dirIdentity };
  return { state: "inactive", row: "13", destination, identity, dirIdentity };
}

// src/memory/project-root.ts
import { lstatSync as lstatSync7, readdirSync as readdirSync3, statSync as statSync4 } from "node:fs";
import { dirname as dirname4, isAbsolute as isAbsolute3, join as join5, relative, sep as sep2 } from "node:path";
function hasOwnHelixEntry(dir) {
  try {
    lstatSync7(join5(dir, ".helix"));
    return true;
  } catch {
    return false;
  }
}

// src/config.ts
import { openSync as openSync7, fstatSync as fstatSync7, readSync as readSync4, closeSync as closeSync7, constants as constants7 } from "node:fs";
import { join as join6 } from "node:path";
var MAX_CONFIG_BYTES = 1048576;
function readConfigText(path) {
  const fd = openSync7(path, constants7.O_RDONLY | constants7.O_NONBLOCK);
  try {
    const st = fstatSync7(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > MAX_CONFIG_BYTES) throw new Error(`larger than ${MAX_CONFIG_BYTES} bytes`);
    const buf = Buffer.alloc(st.size);
    let len = 0;
    while (len < buf.length) {
      const n = readSync4(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
    }
    return buf.subarray(0, len).toString("utf8");
  } finally {
    try {
      closeSync7(fd);
    } catch {
    }
  }
}
function readJson(path, onUnusable) {
  let text;
  try {
    text = readConfigText(path);
  } catch (e) {
    if (e.code !== "ENOENT") onUnusable(e.message);
    return null;
  }
  const body = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
  try {
    return JSON.parse(body);
  } catch (e) {
    onUnusable(e.message);
    return null;
  }
}
function metricsEnabledFromGlobalConfig(home) {
  const raw = readJson(join6(home, "config.json"), () => {
  });
  const m = raw?.metrics;
  return m && typeof m === "object" && typeof m.enabled === "boolean" ? m.enabled : true;
}

// scripts/trigger-eval.ts
var ROWS_THRESHOLD = 2500;
var BYTES_THRESHOLD = 4194304;
var SLOW_COUNT_THRESHOLD = 3;
var SLOW_MS_THRESHOLD = 150;
var WINDOW_SIZE = 200;
function deriveLegStatus(min, max, threshold) {
  if (min !== null && min >= threshold) return "true";
  if (max !== null && max < threshold) return "false";
  return "unavailable";
}
function computeSizeLeg(participants, field, threshold) {
  let min = 0;
  let hasReadError = false;
  for (const participant of participants) {
    if (participant.state === "read") {
      min += participant[field] ?? 0;
    } else if (participant.state === "read-error") {
      hasReadError = true;
    }
  }
  const max = hasReadError ? null : min;
  return { min, max, threshold, status: deriveLegStatus(min, max, threshold) };
}
function windowTail(items) {
  return items.slice(Math.max(0, items.length - WINDOW_SIZE));
}
function expandToUnits(events, unknownIsSlow) {
  const units = [];
  for (const event of events) {
    if (event.kind === "recall") {
      units.push(event.ms > SLOW_MS_THRESHOLD);
    } else {
      for (let i = 0; i < event.maxOps; i++) units.push(unknownIsSlow);
    }
  }
  return units;
}
function computeLatencyBound(events, unknownIsSlow) {
  return windowTail(expandToUnits(events, unknownIsSlow)).filter(Boolean).length;
}
function latencyPopulation(events) {
  return windowTail(events).filter((event) => event.kind === "recall").length;
}
function computeLatencyLeg(metricsState, events, threshold) {
  if (metricsState !== "present" || events === null) {
    return { min: null, max: null, threshold, status: "unavailable" };
  }
  const min = computeLatencyBound(events, false);
  const max = computeLatencyBound(events, true);
  return { min, max, threshold, status: deriveLegStatus(min, max, threshold) };
}
function deriveOverall(legs) {
  const statuses = [legs.rows.status, legs.bytes.status, legs.latency.status];
  if (statuses.includes("true")) return "fired";
  if (statuses.every((status) => status === "false")) return "not-fired";
  return "indeterminate";
}
function evaluateTrigger(input) {
  const rows = computeSizeLeg(input.participants, "rows", ROWS_THRESHOLD);
  const bytes = computeSizeLeg(input.participants, "bytes", BYTES_THRESHOLD);
  const latency = computeLatencyLeg(input.metricsState, input.events, SLOW_COUNT_THRESHOLD);
  const legs = { rows, bytes, latency };
  const latencyN = input.metricsState === "present" && input.events !== null ? latencyPopulation(input.events) : null;
  return { schema: 1, legs, latencyN, overall: deriveOverall(legs) };
}

// scripts/trigger-measure.ts
var POLICY = "T1-2026-07-11";
var SINK_FILE = "trigger.jsonl";
var METRICS_FILE = "metrics.jsonl";
var defaultReadFile = (p) => readLedgerFileBytes(p);
var SINK_OPEN = constants8.O_RDWR | constants8.O_APPEND | constants8.O_CREAT | constants8.O_NOFOLLOW | constants8.O_NONBLOCK;
var SINK_NOT_REGULAR_OPEN_ERRORS = /* @__PURE__ */ new Set(["ENXIO", "ELOOP", "EISDIR"]);
function readWholeFile(path, readFile) {
  let buf;
  try {
    buf = readFile(path);
  } catch (e) {
    const code = e?.code;
    return { state: code === "ENOENT" ? "expected-absent" : "read-error" };
  }
  let rows = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) rows++;
  return { state: "read", rows, bytes: buf.length };
}
function toParticipant(id, outcome) {
  return outcome.state === "read" ? { id, state: "read", rows: outcome.rows, bytes: outcome.bytes } : { id, state: outcome.state };
}
function resolveProjectDisposition(root, home, globalLedger) {
  if (!hasOwnHelixEntry(root)) return "absent";
  return judgeProjectLayer({ root, ledger: projectLedgerPath(root), home, globalLedger }).state === "owned" ? "owned" : "unowned";
}
function readTwoParticipants(globalLedger, root, home, disposition, readFile) {
  const global = toParticipant("global", readWholeFile(globalLedger, readFile));
  const project = disposition === "owned" ? toParticipant("project", readWholeFile(projectLedgerPath(root), readFile)) : { id: "project", state: "expected-absent" };
  return [global, project];
}
function parseMetricsLine(lineBuf) {
  const maxOps = Math.max(1, Math.floor(lineBuf.length / 64));
  const unknown = () => ({ kind: "unknown", maxOps });
  let row;
  try {
    row = JSON.parse(lineBuf.toString("utf8"));
  } catch {
    return unknown();
  }
  if (row === null || typeof row !== "object") return unknown();
  const r = row;
  if (typeof r.v === "number" && r.v > 1) return unknown();
  if (r.kind === "op" && typeof r["gen_ai.tool.name"] === "string" && typeof r.duration_ms === "number") {
    return r["gen_ai.tool.name"] === "helix_memory_recall" ? { kind: "recall", ms: r.duration_ms } : null;
  }
  if (r.kind === "replay" || r.kind === "compaction") return null;
  return unknown();
}
function parseMetricsBuffer(buf) {
  const events = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 10) {
      if (i > start) {
        const event = parseMetricsLine(buf.subarray(start, i));
        if (event !== null) events.push(event);
      }
      start = i + 1;
    }
  }
  return events;
}
function resolveMetrics(home, readFile) {
  if (!metricsEnabledFromGlobalConfig(home)) return { state: "disabled", events: null };
  let buf;
  try {
    buf = readFile(join7(home, METRICS_FILE));
  } catch (e) {
    const code = e?.code;
    return { state: code === "ENOENT" ? "absent" : "read-error", events: null };
  }
  return { state: "present", events: parseMetricsBuffer(buf) };
}
function summarizeUnknowns(events) {
  let unknownLines = 0;
  let unknownMaxOps = 0;
  for (const e of events) {
    if (e.kind === "unknown") {
      unknownLines++;
      unknownMaxOps += e.maxOps;
    }
  }
  return { unknownLines, unknownMaxOps };
}
function isLegShape(v) {
  if (!v || typeof v !== "object") return false;
  const o = v;
  return (o.min === null || typeof o.min === "number") && (o.max === null || typeof o.max === "number") && typeof o.threshold === "number" && (o.status === "true" || o.status === "false" || o.status === "unavailable");
}
function validateRecordLine(line) {
  const fail = (field) => {
    throw new Error(`trigger record self-validation failed: ${field}`);
  };
  if (!/^[\x00-\x7F]*$/.test(line)) fail("non-ASCII byte in output");
  const parsed = JSON.parse(line);
  if (parsed.v !== 1) fail("v");
  if (parsed.policy !== POLICY) fail("policy");
  if (parsed.kind !== "evaluation") fail("kind");
  if (typeof parsed.ts !== "string" || Number.isNaN(Date.parse(parsed.ts))) fail("ts");
  if (typeof parsed.run !== "string" || parsed.run === "") fail("run");
  for (const field of ["service_result", "exit_code", "exit_status"]) {
    const v = parsed[field];
    if (v !== null && typeof v !== "string") fail(field);
  }
  const legs = parsed.legs;
  if (!legs || !isLegShape(legs.rows) || !isLegShape(legs.bytes) || !isLegShape(legs.latency)) fail("legs");
  if (parsed.latencyN !== null && typeof parsed.latencyN !== "number") fail("latencyN");
  if (parsed.overall !== "fired" && parsed.overall !== "not-fired" && parsed.overall !== "indeterminate") fail("overall");
  if (parsed.project !== "owned" && parsed.project !== "unowned" && parsed.project !== "absent") fail("project");
  if (parsed.metricsState !== "present" && parsed.metricsState !== "absent" && parsed.metricsState !== "disabled" && parsed.metricsState !== "read-error") {
    fail("metricsState");
  }
  if (typeof parsed.unknownLines !== "number" || parsed.unknownLines < 0) fail("unknownLines");
  if (typeof parsed.unknownMaxOps !== "number" || parsed.unknownMaxOps < 0) fail("unknownMaxOps");
  return parsed;
}
function appendToSink(home, line, fs = realFsOps) {
  const path = join7(home, SINK_FILE);
  ensureHelixDir(home);
  const existedBefore = sinkPresent(path);
  let fd;
  try {
    fd = fs.openSync(path, SINK_OPEN, 384);
  } catch (e) {
    if (SINK_NOT_REGULAR_OPEN_ERRORS.has(e.code ?? "")) throw new NotRegularHomeFileError();
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    if ((st.mode & constants8.S_IFMT) !== constants8.S_IFREG) throw new NotRegularHomeFileError();
    let data = line + "\n";
    if (st.size > 0) {
      const tail = Buffer.alloc(1);
      fs.readSync(fd, tail, 0, 1, st.size - 1);
      if (tail[0] !== 10) data = "\n" + data;
    }
    writeAll(fs, fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!existedBefore) fs.fsyncDir(dirname5(path));
}
function sinkPresent(path) {
  try {
    lstatSync8(path);
    return true;
  } catch {
    return false;
  }
}
function validateAcknowledgementLine(line) {
  const fail = (field) => {
    throw new Error(`trigger acknowledgement self-validation failed: ${field}`);
  };
  if (!/^[\x00-\x7F]*$/.test(line)) fail("non-ASCII byte in output");
  const parsed = JSON.parse(line);
  if (parsed.v !== 1) fail("v");
  if (parsed.policy !== POLICY) fail("policy");
  if (parsed.kind !== "acknowledgement") fail("kind");
  if (typeof parsed.ts !== "string" || Number.isNaN(Date.parse(parsed.ts))) fail("ts");
  if (typeof parsed.evaluationTs !== "string" || Number.isNaN(Date.parse(parsed.evaluationTs))) fail("evaluationTs");
  const legs = parsed.legs;
  if (!legs || !isLegShape(legs.rows) || !isLegShape(legs.bytes) || !isLegShape(legs.latency)) fail("legs");
  return parsed;
}
function tsOf(line) {
  return /"ts":"([^"]*)"/.exec(line)?.[1] ?? "";
}
function acknowledgeLatest(deps = {}) {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? defaultReadFile;
  const now = deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  const { home } = resolveHelixPaths({ HELIX_HOME: env.HELIX_HOME, HELIX_LEDGER: env.HELIX_LEDGER }, homedir());
  let text;
  try {
    text = readFile(join7(home, SINK_FILE)).toString("utf8");
  } catch {
    return { ok: false, reason: "no trigger sink to acknowledge" };
  }
  const lines = text.split("\n");
  const evaluations = lines.filter((l) => l.includes('"kind":"evaluation"'));
  const last = evaluations.at(-1);
  if (last === void 0) return { ok: false, reason: "no evaluation to acknowledge" };
  if (!evaluations.some((l) => l.includes('"overall":"fired"'))) {
    return { ok: false, reason: "no evaluation has ever fired -- nothing to acknowledge" };
  }
  const latestAck = lines.filter((l) => l.includes('"kind":"acknowledgement"')).at(-1);
  if (latestAck !== void 0) {
    const ackTs = tsOf(latestAck);
    if (!evaluations.some((l) => tsOf(l) > ackTs)) {
      return { ok: false, reason: "no evaluation since the latest acknowledgement -- nothing new to acknowledge" };
    }
  }
  const evaluation = validateRecordLine(last);
  const record = {
    v: 1,
    policy: POLICY,
    kind: "acknowledgement",
    ts: now(),
    evaluationTs: evaluation.ts,
    legs: evaluation.legs
  };
  const line = JSON.stringify(record);
  validateAcknowledgementLine(line);
  appendToSink(home, line, deps.fs ?? realFsOps);
  return { ok: true, line };
}
function measureAndRecord(input, deps = {}) {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? defaultReadFile;
  const now = deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  const fsOps = deps.fs ?? realFsOps;
  const { home, globalLedger } = resolveHelixPaths({ HELIX_HOME: env.HELIX_HOME, HELIX_LEDGER: env.HELIX_LEDGER }, homedir());
  const disposition = resolveProjectDisposition(input.root, home, globalLedger);
  const participants = readTwoParticipants(globalLedger, input.root, home, disposition, readFile);
  const { state: metricsState, events } = resolveMetrics(home, readFile);
  const { unknownLines, unknownMaxOps } = summarizeUnknowns(events ?? []);
  const verdict = evaluateTrigger({ participants, metricsState, events });
  const record = {
    v: 1,
    policy: POLICY,
    kind: "evaluation",
    ts: now(),
    run: input.run,
    service_result: input.serviceResult,
    exit_code: input.exitCode,
    exit_status: input.exitStatus,
    legs: verdict.legs,
    latencyN: verdict.latencyN,
    overall: verdict.overall,
    project: disposition,
    metricsState,
    unknownLines,
    unknownMaxOps
  };
  const line = JSON.stringify(record);
  validateRecordLine(line);
  appendToSink(home, line, fsOps);
  process.stdout.write(line + "\n");
  return line;
}

// scripts/trigger-cli.ts
var USAGE = "usage: trigger-cli --root <path> --run <id> [--service-result <s>] [--exit-code <s>] [--exit-status <s>]\n       trigger-cli --acknowledge\n";
var TRIGGER_HOME_REFUSAL_HEAD = "trigger-cli: REFUSING - ";
var EXIT_HOME_REFUSED = 3;
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--root") out.root = argv[++i] ?? "";
    else if (flag === "--run") out.run = argv[++i] ?? "";
    else if (flag === "--service-result") out.serviceResult = argv[++i] ?? "";
    else if (flag === "--exit-code") out.exitCode = argv[++i] ?? "";
    else if (flag === "--exit-status") out.exitStatus = argv[++i] ?? "";
    else if (flag === "--acknowledge") out.acknowledge = true;
  }
  return out;
}
var toNullable = (s) => s === void 0 || s === "" ? null : s;
function main(argv, deps = {}) {
  const exit = deps.exit ?? ((code) => {
    process.exitCode = code;
  });
  const parsed = parseArgs(argv);
  if (parsed.acknowledge) {
    try {
      const r = acknowledgeLatest(deps);
      if (!r.ok) {
        process.stderr.write(`trigger-cli: ${r.reason}
`);
        exit(2);
        return 2;
      }
      process.stdout.write(r.line + "\n");
      exit(0);
      return 0;
    } catch (e) {
      if (isHomeRefusalError(e)) {
        process.stderr.write(`${TRIGGER_HOME_REFUSAL_HEAD}${e.message}
`);
        exit(EXIT_HOME_REFUSED);
        return EXIT_HOME_REFUSED;
      }
      process.stderr.write(`trigger-cli: ${e instanceof Error ? e.message : String(e)}
`);
      exit(1);
      return 1;
    }
  }
  if (!parsed.root || !parsed.run) {
    process.stderr.write(USAGE);
    exit(2);
    return 2;
  }
  try {
    measureAndRecord(
      {
        root: parsed.root,
        run: parsed.run,
        serviceResult: toNullable(parsed.serviceResult),
        exitCode: toNullable(parsed.exitCode),
        exitStatus: toNullable(parsed.exitStatus)
      },
      deps
    );
    exit(0);
    return 0;
  } catch (e) {
    if (isHomeRefusalError(e)) {
      process.stderr.write(`${TRIGGER_HOME_REFUSAL_HEAD}${e.message}
`);
      exit(EXIT_HOME_REFUSED);
      return EXIT_HOME_REFUSED;
    }
    process.stderr.write(`trigger-cli: ${e instanceof Error ? e.message : String(e)}
`);
    exit(1);
    return 1;
  }
}
void main(process.argv.slice(2));
export {
  main
};
