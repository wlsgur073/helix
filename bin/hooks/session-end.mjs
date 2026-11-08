// src/hooks/session-end.ts
import { closeSync as closeSync2, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname as dirname5 } from "node:path";

// src/limits.ts
var HOOK_STDIN_MAX_BYTES = 1048576;
var MAX_SESSION_ID_CHARS = 128;
var MAX_SESSION_REASON_CHARS = 256;

// src/hooks/session-record.ts
async function readStdinCapped(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = chunk;
    total += buf.length;
    if (total > maxBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function buildSessionEndRecord(stdinText, now = () => (/* @__PURE__ */ new Date()).toISOString()) {
  try {
    const j = JSON.parse(stdinText);
    if (j === null || typeof j !== "object") return null;
    const sessionId = typeof j.session_id === "string" && j.session_id !== "" ? j.session_id : "unknown";
    const reasonRaw = j.reason ?? j.end_reason;
    const reason = typeof reasonRaw === "string" && reasonRaw !== "" ? reasonRaw : "unknown";
    return {
      kind: "session-end",
      sessionId: sessionId.slice(0, MAX_SESSION_ID_CHARS),
      reason: reason.slice(0, MAX_SESSION_REASON_CHARS),
      ts: now()
    };
  } catch {
    return null;
  }
}
var HOME_REFUSED_END_NOTE = "helix: NOTE - HELIX_HOME, HELIX_LEDGER or HELIX_SESSIONS holds a relative path or a path that cannot be resolved; the session-end hook wrote no record.";
var SESSION_RECORD_DROPPED_NOTE = "helix: NOTE - the session-end hook did not write its record because the sessions file cannot be used (its folder or the file cannot be written, it is not a regular file, or it is a file that Helix keeps for another purpose).";

// src/hooks/sessions-destination.ts
import { basename as basename3, dirname as dirname3, join as join3 } from "node:path";

// src/memory/home-env.ts
import { posix, win32 } from "node:path";

// src/memory/path-identity.ts
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
        statSync(p);
      } catch (e) {
        if (codeOf(e) !== "ENOENT") return failureOf(e);
      }
    }
    if (hops === MAX_SYMLINK_HOPS) return { kind: "unresolvable", cause: "too-many-links" };
    let body;
    try {
      body = utf8OrNull(readlinkSync(p, { encoding: "buffer" }));
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

// src/memory/home-env.ts
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
function absoluteOrRefuse(variable, value, isAbsolute2) {
  if (!isAbsolute2(value)) throw new HomeRefusalError("relative-value", RELATIVE_VALUE_TEXT[variable]);
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

// src/memory/home-files.ts
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { basename as basename2, dirname as dirname2, join as join2, win32 as win322 } from "node:path";
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
    regular = fstatSync(fd).isFile();
  } finally {
    if (!regular) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
  if (!regular) throw new NotRegularHomeFileError();
}
function openHomeFileForAppend(path, mode, open = (p, f, m) => openSync(p, f, m)) {
  let fd;
  try {
    fd = open(path, APPEND_FLAGS, mode);
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
var identityOrNull = (path, follow) => {
  try {
    return fileIdentityAt(path, { follow });
  } catch {
    return null;
  }
};
function homeControlFileOf(home, resolved, opts = {}) {
  const allow = opts.allow;
  const onWin32 = (opts.platform ?? process.platform) === "win32";
  let homeDir;
  let dest;
  if (onWin32) {
    homeDir = win322.resolve(home);
    dest = win322.resolve(resolved);
  } else {
    const h = resolvePath(home);
    homeDir = h.kind === "resolved" ? h.path : home;
    dest = resolved;
  }
  const ops = onWin32 ? win322 : { dirname: dirname2, basename: basename2, join: join2 };
  if (ops.dirname(dest) === homeDir) {
    const name = ops.basename(dest);
    if (name === "memory.jsonl") return null;
    if (name !== allow && HOME_CONTROL_NAMES.includes(name)) return name;
    for (const [stem, pattern, gatePrefix] of TEMP_FAMILIES) {
      if (pattern.test(name) || name.startsWith(gatePrefix)) return stem;
    }
  }
  const id = identityOrNull(dest, false);
  if (!hasComparableInode(id)) return null;
  for (const name of CONTROL_FILES) {
    if (name === allow) continue;
    if (sameFile(id, identityOrNull(ops.join(homeDir, name), true))) return name;
  }
  return null;
}
function sameDestination(a, b, probe) {
  if (a === b) return true;
  try {
    return sameFile(fileIdentityAt(a, { follow: true, probe }), fileIdentityAt(b, { follow: true, probe }));
  } catch {
    return false;
  }
}

// src/hooks/sessions-destination.ts
var SESSIONS_DESTINATION_REFUSAL_TEXT = "the sessions file is a file that Helix keeps for another purpose";
function isProjectLedgerName(path) {
  return basename3(path) === "memory.jsonl" && basename3(dirname3(path)) === ".helix";
}
function assertSessionsDestination(paths, probe) {
  const dest = resolvePath(paths.sessionsFile);
  if (dest.kind === "unresolvable") throw new UnresolvablePathError(dest.cause);
  if (dest.kind === "uninspectable") throw dest.error;
  if (homeControlFileOf(paths.home, dest.path, { allow: "sessions.jsonl" }) !== null) {
    throw new HomeRefusalError("home-control-file", SESSIONS_DESTINATION_REFUSAL_TEXT);
  }
  if (isProjectLedgerName(dest.path) || isProjectLedgerName(paths.sessionsFile)) {
    throw new HomeRefusalError("home-control-file", SESSIONS_DESTINATION_REFUSAL_TEXT);
  }
  for (const ledgerPath of [paths.globalLedger, join3(paths.home, "memory.jsonl")]) {
    const ledger = resolvePath(ledgerPath);
    if (ledger.kind === "resolved" && sameDestination(dest.path, ledger.path, probe)) {
      throw new HomeRefusalError("home-control-file", SESSIONS_DESTINATION_REFUSAL_TEXT);
    }
  }
}

// src/memory/home-permissions.ts
import { lstatSync as lstatSync2, chmodSync, readdirSync, mkdirSync, existsSync } from "node:fs";
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
  const parent = dirname4(name);
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

// src/hooks/session-end.ts
function resolvedPathsOrNote() {
  try {
    return resolveHelixPaths({
      HELIX_HOME: process.env.HELIX_HOME,
      HELIX_LEDGER: process.env.HELIX_LEDGER,
      HELIX_SESSIONS: process.env.HELIX_SESSIONS
    }, homedir());
  } catch (e) {
    if (isHomeRefusalError(e)) writeSync(2, `${HOME_REFUSED_END_NOTE}
`);
    return null;
  }
}
try {
  const stdinText = await readStdinCapped(process.stdin, HOOK_STDIN_MAX_BYTES);
  const record = stdinText === null ? null : buildSessionEndRecord(stdinText);
  if (record) {
    const paths = resolvedPathsOrNote();
    if (paths !== null) {
      try {
        assertSessionsDestination(paths);
        ensureHelixDir(dirname5(paths.sessionsFile));
        const fd = openHomeFileForAppend(paths.sessionsFile, 384);
        try {
          writeFileSync(fd, JSON.stringify(record) + "\n");
        } finally {
          closeSync2(fd);
        }
      } catch {
        writeSync(2, `${SESSION_RECORD_DROPPED_NOTE}
`);
      }
    }
  }
} catch {
}
