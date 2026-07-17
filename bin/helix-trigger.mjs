// scripts/trigger-measure.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync3 } from "node:fs";
import { dirname, join as join3, resolve as resolve2 } from "node:path";
import { homedir as homedir2 } from "node:os";

// src/memory/fs-ops.ts
import { openSync, readSync, writeSync, fsyncSync, closeSync, fstatSync, renameSync, unlinkSync, linkSync, fchmodSync, readdirSync } from "node:fs";
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
  unlinkSync,
  linkSync,
  fchmodSync,
  readdirSync: (d) => readdirSync(d),
  fsyncDir
};
function writeAll(fs, fd, text) {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

// src/memory/ownership.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
function projectLedgerPath(projectRoot) {
  return join(projectRoot, ".helix", "memory.jsonl");
}
function registryPath(home) {
  return join(home, "projects.json");
}
function ownerFile(projectRoot) {
  return join(projectRoot, ".helix", ".owner");
}
function readRegistry(home) {
  try {
    return JSON.parse(readFileSync(registryPath(home), "utf8"));
  } catch {
    return {};
  }
}
function readOwner(projectRoot) {
  try {
    return readFileSync(ownerFile(projectRoot), "utf8").trim();
  } catch {
    return null;
  }
}
function isOwned(projectRoot, home) {
  const entry = readRegistry(home)[resolve(projectRoot)];
  if (!entry) return false;
  const stamp = readOwner(projectRoot);
  return stamp !== null && stamp === entry.stamp;
}

// src/config.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
var EGRESS_LEGS = ["memoryEcho", "piiHigh", "piiBulk", "secretHeuristic", "secretEntropy"];
var EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
var MODES = ["compare", "critique"];
var STAKES = ["low", "medium", "high", "xhigh"];
var MODEL_RE = /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/;
var MODEL_MAX_LEN = 64;
function isArgvSafeModel(s) {
  return s.length <= MODEL_MAX_LEN && MODEL_RE.test(s);
}
function q(v) {
  return JSON.stringify(String(v).slice(0, 60));
}
var MAX_TIMEOUT_MS = 36e5;
var DEFAULT_CONFIG = {
  dualVerify: {
    enabled: false,
    mode: "compare",
    stakesFloor: "high",
    // Default: inherit the user's ~/.codex/config.toml (no hardcoding, tracks whatever they set
    // there). Pass -m / -c only when these are set here, to deliberately override codex's own
    // model/effort for dual-verify specifically.
    model: null,
    effort: null,
    // Codex run timeout (ms). 5 min gives heavy prompts headroom (the old 120s cap timed them out);
    // the process is tree-killed on timeout so a higher ceiling does not leak a hung run.
    timeoutMs: 3e5,
    // Block every non-named egress leg to the external Codex model by default. User opts into risk
    // per-leg (a human edit, outside model control). Invalid/unknown => 'block'. Named secrets are
    // override-proof regardless of this map.
    egressPolicy: { memoryEcho: "block", piiHigh: "block", piiBulk: "block", secretHeuristic: "block", secretEntropy: "block" },
    // Content logging OFF by default; audit.jsonl still records metadata. Invalid value => false.
    logContent: false
  },
  // Local metrics sensor ON by default ("local logs always, export opt-in"); content-free records.
  metrics: { enabled: true }
};
function readJson(path) {
  try {
    return JSON.parse(readFileSync2(path, "utf8"));
  } catch {
    return null;
  }
}
function loadConfig(opts = {}) {
  const projectPath = opts.projectPath ?? join2(process.cwd(), ".helix", "config.json");
  const globalPath = opts.globalPath ?? join2(homedir(), ".helix", "config.json");
  const merged = structuredClone(DEFAULT_CONFIG);
  const seen = /* @__PURE__ */ new Set();
  const warn = (msg) => {
    if (!seen.has(msg)) {
      seen.add(msg);
      (opts.warn ?? ((m) => process.stderr.write(m + "\n")))(msg);
    }
  };
  for (const path of [globalPath, projectPath]) {
    const raw = readJson(path);
    const dv = raw?.dualVerify;
    if (dv) {
      if (typeof dv.enabled === "boolean") merged.dualVerify.enabled = dv.enabled;
      if (dv.mode === "compare" || dv.mode === "critique") merged.dualVerify.mode = dv.mode;
      else if (dv.mode !== void 0) warn(`helix: invalid dualVerify.mode ${q(dv.mode)} (valid: ${MODES.join(", ")}) -> ignored`);
      if (dv.stakesFloor === "low" || dv.stakesFloor === "medium" || dv.stakesFloor === "high" || dv.stakesFloor === "xhigh") {
        merged.dualVerify.stakesFloor = dv.stakesFloor;
      } else if (dv.stakesFloor !== void 0) {
        warn(`helix: invalid dualVerify.stakesFloor ${q(dv.stakesFloor)} (valid: ${STAKES.join(", ")}) -> ignored`);
      }
      if (dv.model === null || typeof dv.model === "string" && isArgvSafeModel(dv.model)) {
        merged.dualVerify.model = dv.model;
      } else if (dv.model !== void 0) {
        warn(`helix: invalid dualVerify.model ${q(dv.model)} (argv-safe token, <= ${MODEL_MAX_LEN} chars) -> ignored`);
      }
      if (dv.effort === null || typeof dv.effort === "string" && EFFORTS.includes(dv.effort)) {
        merged.dualVerify.effort = dv.effort;
      } else if (dv.effort !== void 0) {
        warn(`helix: invalid dualVerify.effort ${q(dv.effort)} (valid: ${EFFORTS.join(", ")}) -> ignored`);
      }
      const t = dv.timeoutMs;
      if (typeof t === "number" && Number.isInteger(t) && t >= 1e3) {
        merged.dualVerify.timeoutMs = Math.min(t, MAX_TIMEOUT_MS);
      }
      const ep = dv.egressPolicy;
      if (ep && typeof ep === "object") {
        for (const [key, val] of Object.entries(ep)) {
          if (!EGRESS_LEGS.includes(key)) {
            warn(`helix: ignoring unknown dualVerify.egressPolicy key ${q(key)}`);
            continue;
          }
          if (val === "allow") merged.dualVerify.egressPolicy[key] = "allow";
          else if (val !== "block") warn(`helix: invalid dualVerify.egressPolicy.${key} ${q(val)} -> block`);
        }
      }
      if (dv.memoryEgress !== void 0) {
        warn("helix: dualVerify.memoryEgress was removed; use dualVerify.egressPolicy { memoryEcho, piiHigh, piiBulk, secretHeuristic, secretEntropy }");
      }
      if (typeof dv.logContent === "boolean") merged.dualVerify.logContent = dv.logContent;
    }
    const m = raw?.metrics;
    if (m && typeof m === "object" && typeof m.enabled === "boolean") {
      merged.metrics.enabled = m.enabled;
    }
  }
  return merged;
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
var CONFIG_FILE = "config.json";
var GLOBAL_LEDGER_FILE = "memory.jsonl";
function resolveHome(env) {
  return env.HELIX_HOME ?? join3(homedir2(), ".helix");
}
function resolveGlobalLedger(env, home) {
  return env.HELIX_LEDGER ?? join3(home, GLOBAL_LEDGER_FILE);
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
  if (!existsSync(join3(root, ".helix"))) return "absent";
  const distinctFromGlobal = resolve2(projectLedgerPath(root)) !== resolve2(globalLedger);
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
function resolveMetrics(home, config, readFile) {
  if (config.metrics.enabled === false) return { state: "disabled", events: null };
  let buf;
  try {
    buf = readFile(join3(home, METRICS_FILE));
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
  const path = join3(home, SINK_FILE);
  mkdirSync2(dirname(path), { recursive: true });
  const existedBefore = existsSync(path);
  const fd = fs.openSync(path, "a", 384);
  try {
    writeAll(fs, fd, line + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!existedBefore) fs.fsyncDir(dirname(path));
}
function measureAndRecord(input, deps = {}) {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((p) => readFileSync3(p));
  const now = deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  const fsOps = deps.fs ?? realFsOps;
  const home = resolveHome(env);
  const globalLedger = resolveGlobalLedger(env, home);
  const disposition = resolveProjectDisposition(input.root, home, globalLedger);
  const participants = readTwoParticipants(globalLedger, input.root, home, disposition, readFile);
  const config = loadConfig({ projectPath: join3(input.root, ".helix", CONFIG_FILE), globalPath: join3(home, CONFIG_FILE) });
  const { state: metricsState, events } = resolveMetrics(home, config, readFile);
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
