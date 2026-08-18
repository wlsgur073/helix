// scripts/trigger-measure.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname3, join as join4 } from "node:path";
import { homedir } from "node:os";

// src/memory/fs-ops.ts
import { openSync, readSync, writeSync, fsyncSync, closeSync, fstatSync, renameSync, unlinkSync, linkSync, fchmodSync, readdirSync } from "node:fs";
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
    const s = fstatSync(fd);
    return { size: s.size, nlink: s.nlink, mode: s.mode };
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
import { existsSync, mkdirSync, readFileSync as readFileSync2, renameSync as renameSync2, unlinkSync as unlinkSync3, lstatSync as lstatSync2, openSync as openSync2, writeSync as writeSync2, fsyncSync as fsyncSync2, closeSync as closeSync2 } from "node:fs";
import { join as join2, resolve, dirname as dirname2, isAbsolute } from "node:path";

// src/memory/lock.ts
import { readFileSync, writeFileSync, unlinkSync as unlinkSync2, linkSync as linkSync2, lstatSync, realpathSync, rmSync, readdirSync as readdirSync2 } from "node:fs";
import { dirname, basename, join } from "node:path";
function canonical(target) {
  try {
    return realpathSync(target);
  } catch {
    return join(realpathSync(dirname(target)), basename(target));
  }
}

// src/memory/ownership.ts
function canonicalRoot(projectRoot) {
  try {
    return canonical(projectRoot);
  } catch {
    return resolve(projectRoot);
  }
}
function projectLedgerPath(projectRoot) {
  return join2(projectRoot, ".helix", "memory.jsonl");
}
function registryPath(home) {
  return join2(home, "projects.json");
}
function ownerFile(projectRoot) {
  return join2(projectRoot, ".helix", ".owner");
}
function isPlainObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isValidRegistry(x) {
  if (!isPlainObject(x)) return false;
  for (const v of Object.values(x)) {
    if (!isPlainObject(v)) return false;
    if (typeof v.stamp !== "string" || typeof v.adoptedAt !== "string" || typeof v.macNonce !== "string") return false;
  }
  return true;
}
function loadRegistry(home) {
  const path = registryPath(home);
  let st;
  try {
    st = lstatSync2(path);
  } catch (e) {
    return e.code === "ENOENT" ? { kind: "absent" } : { kind: "corrupt" };
  }
  if (st.isSymbolicLink()) return { kind: "corrupt" };
  let text;
  try {
    text = readFileSync2(path, "utf8");
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
function readOwner(projectRoot) {
  try {
    return readFileSync2(ownerFile(projectRoot), "utf8").trim();
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

// src/memory/ledger-mac.ts
var ILL_FORMED_TAG = Buffer.from([255, 1]);
var DOMAIN = Buffer.from("helix-ledger-mac");
var NULL_FIELD = Buffer.from([0, 0, 0, 0, 0]);

// src/memory/scope-target.ts
function aliasesGlobalLedger(projectLedger, globalLedger) {
  return canonicalRoot(projectLedger) === canonicalRoot(globalLedger);
}

// src/config.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";
function readJson(path) {
  try {
    return JSON.parse(readFileSync3(path, "utf8"));
  } catch {
    return null;
  }
}
function metricsEnabledFromGlobalConfig(home) {
  const raw = readJson(join3(home, "config.json"));
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
var GLOBAL_LEDGER_FILE = "memory.jsonl";
function resolveHome(env) {
  return env.HELIX_HOME ?? join4(homedir(), ".helix");
}
function resolveGlobalLedger(env, home) {
  return env.HELIX_LEDGER ?? join4(home, GLOBAL_LEDGER_FILE);
}
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
  if (!existsSync2(join4(root, ".helix"))) return "absent";
  const distinctFromGlobal = !aliasesGlobalLedger(projectLedgerPath(root), globalLedger);
  return distinctFromGlobal && isOwned(root, home) ? "owned" : "unowned";
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
    buf = readFile(join4(home, METRICS_FILE));
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
  const path = join4(home, SINK_FILE);
  mkdirSync2(dirname3(path), { recursive: true });
  const existedBefore = existsSync2(path);
  const fd = fs.openSync(path, "a", 384);
  try {
    writeAll(fs, fd, line + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!existedBefore) fs.fsyncDir(dirname3(path));
}
function measureAndRecord(input, deps = {}) {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((p) => readFileSync4(p));
  const now = deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  const fsOps = deps.fs ?? realFsOps;
  const home = resolveHome(env);
  const globalLedger = resolveGlobalLedger(env, home);
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
var USAGE = "usage: trigger-cli --root <path> --run <id> [--service-result <s>] [--exit-code <s>] [--exit-status <s>]\n";
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--root") out.root = argv[++i] ?? "";
    else if (flag === "--run") out.run = argv[++i] ?? "";
    else if (flag === "--service-result") out.serviceResult = argv[++i] ?? "";
    else if (flag === "--exit-code") out.exitCode = argv[++i] ?? "";
    else if (flag === "--exit-status") out.exitStatus = argv[++i] ?? "";
  }
  return out;
}
var toNullable = (s) => s === void 0 || s === "" ? null : s;
function main(argv, deps = {}) {
  const exit = deps.exit ?? ((code) => {
    process.exitCode = code;
  });
  const parsed = parseArgs(argv);
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
