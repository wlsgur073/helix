import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type DualVerifyMode = 'compare' | 'critique';
export type StakesFloor = 'low' | 'medium' | 'high' | 'xhigh';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type EgressLegPolicy = 'block' | 'allow';
export type EgressLeg = 'memoryEcho' | 'piiHigh' | 'piiBulk' | 'secretHeuristic' | 'secretEntropy';
export type EgressPolicy = Record<EgressLeg, EgressLegPolicy>;
const EGRESS_LEGS: readonly EgressLeg[] = ['memoryEcho', 'piiHigh', 'piiBulk', 'secretHeuristic', 'secretEntropy'];

export interface CompactionConfig {
  auto: boolean;
  dirtyRatio: number;   // (0, 1]
  minRows: number;      // integer >= 0
  minDirtyBytes: number; // integer >= 1
  graceMs: number;      // integer >= 0
  maxBytes: number;     // integer > 0
}

const DEFAULT_COMPACTION: CompactionConfig = {
  auto: false, dirtyRatio: 0.5, minRows: 200, minDirtyBytes: 1_048_576, graceMs: 86_400_000, maxBytes: 52_428_800,
};

const EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const MODEL_RE = /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/; // argv-safe model token: no leading dash, no shell/space chars

/** Effective Codex run-timeout ceiling (ms). A value above this is clamped, not rejected, so the
 *  scratch-gc floor can assume no run outlives it. Shared with the runner hard-clamp in codex.ts. */
export const MAX_TIMEOUT_MS = 3_600_000; // 1 hour

export interface HelixConfig {
  dualVerify: {
    enabled: boolean;
    mode: DualVerifyMode;
    stakesFloor: StakesFloor;
    /** Codex model. `null` (default) => omit -m so codex uses its own ~/.codex/config.toml model. */
    model: string | null;
    /** Reasoning effort. `null` (default) => omit -c so codex uses its config.toml effort. */
    effort: ReasoningEffort | null;
    /** Codex run timeout in ms. Heavy dual-verify prompts exceed the old hardcoded 120s,
     *  so this is configurable. A valid integer >= 1000 is accepted, clamped to MAX_TIMEOUT_MS (1h);
     *  anything else (non-integer, < 1s, NaN, ∞) falls back to the default. */
    timeoutMs: number;
    /** Per-leg egress policy (memory-echo / high-PII / bulk-PII / heuristic-secret / entropy-secret).
     *  User-edited only; every leg defaults to 'block'. A NAMED provider secret blocks regardless of
     *  policy (deny-dominant, override-proof). Read once at startup (a mid-session flip needs a restart). */
    egressPolicy: EgressPolicy;
    /** Opt-in: persist the exact Codex prompt+response to ~/.helix/codex-log.jsonl. Default false
     *  (OFF). audit.jsonl still records decision metadata regardless of this flag. */
    logContent: boolean;
  };
  /** Local-only, content-free latency/size records (spec 2026-07-05). Read once at startup. */
  metrics: { enabled: boolean };
}

export const DEFAULT_CONFIG: HelixConfig = {
  dualVerify: {
    enabled: false,
    mode: 'compare',
    stakesFloor: 'high',
    // Default: inherit the user's ~/.codex/config.toml (no hardcoding, tracks whatever they set
    // there). Pass -m / -c only when these are set here, to deliberately override codex's own
    // model/effort for dual-verify specifically.
    model: null,
    effort: null,
    // Codex run timeout (ms). 5 min gives heavy prompts headroom (the old 120s cap timed them out);
    // the process is tree-killed on timeout so a higher ceiling does not leak a hung run.
    timeoutMs: 300_000,
    // Block every non-named egress leg to the external Codex model by default. User opts into risk
    // per-leg (a human edit, outside model control). Invalid/unknown => 'block'. Named secrets are
    // override-proof regardless of this map.
    egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block' },
    // Content logging OFF by default; audit.jsonl still records metadata. Invalid value => false.
    logContent: false,
  },
  // Local metrics sensor ON by default ("local logs always, export opt-in"); content-free records.
  metrics: { enabled: true },
};

export interface LoadConfigOptions {
  projectPath?: string; // default .helix/config.json under cwd
  globalPath?: string;  // default ~/.helix/config.json
  warn?: (msg: string) => void; // one-time diagnostics sink (default stderr; injectable for tests)
}

function readJson(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; }
  catch { return null; } // missing or malformed -> ignore
}

/** Merge defaults <- global <- project (project wins). Unknown/missing keys keep defaults. */
export function loadConfig(opts: LoadConfigOptions = {}): HelixConfig {
  const projectPath = opts.projectPath ?? join(process.cwd(), '.helix', 'config.json');
  const globalPath = opts.globalPath ?? join(homedir(), '.helix', 'config.json');
  const merged: HelixConfig = structuredClone(DEFAULT_CONFIG);
  const seen = new Set<string>();
  const warn = (msg: string): void => { if (!seen.has(msg)) { seen.add(msg); (opts.warn ?? ((m) => process.stderr.write(m + '\n')))(msg); } };
  for (const path of [globalPath, projectPath]) {
    const raw = readJson(path);
    const dv = raw?.dualVerify as (Partial<HelixConfig['dualVerify']> & Record<string, unknown>) | undefined;
    if (dv) {
      if (typeof dv.enabled === 'boolean') merged.dualVerify.enabled = dv.enabled;
      if (dv.mode === 'compare' || dv.mode === 'critique') merged.dualVerify.mode = dv.mode;
      if (dv.stakesFloor === 'low' || dv.stakesFloor === 'medium' || dv.stakesFloor === 'high' || dv.stakesFloor === 'xhigh') {
        merged.dualVerify.stakesFloor = dv.stakesFloor;
      }
      if (dv.model === null || (typeof dv.model === 'string' && MODEL_RE.test(dv.model))) {
        merged.dualVerify.model = dv.model;
      }
      if (dv.effort === null || (typeof dv.effort === 'string' && EFFORTS.includes(dv.effort as ReasoningEffort))) {
        merged.dualVerify.effort = dv.effort as ReasoningEffort | null;
      }
      // Valid integer >= 1s is accepted, clamped to MAX_TIMEOUT_MS (1h). Above 1h was an artifact of
      // Node's setTimeout 32-bit ceiling, not a real use case; clamping (vs reject->default) keeps a
      // "run long" intent at the max we allow instead of silently dropping to the 5-min default.
      const t = dv.timeoutMs;
      if (typeof t === 'number' && Number.isInteger(t) && t >= 1_000) {
        merged.dualVerify.timeoutMs = Math.min(t, MAX_TIMEOUT_MS);
      }
      const ep = dv.egressPolicy as Record<string, unknown> | undefined;
      if (ep && typeof ep === 'object') {
        for (const [key, val] of Object.entries(ep)) {
          if (!EGRESS_LEGS.includes(key as EgressLeg)) { warn(`helix: ignoring unknown dualVerify.egressPolicy key "${key}"`); continue; }
          if (val === 'allow') merged.dualVerify.egressPolicy[key as EgressLeg] = 'allow';
          else if (val !== 'block') warn(`helix: invalid dualVerify.egressPolicy.${key} "${String(val)}" -> block`);
        }
      }
      if (dv.memoryEgress !== undefined) {
        warn('helix: dualVerify.memoryEgress was removed; use dualVerify.egressPolicy { memoryEcho, piiHigh, piiBulk, secretHeuristic, secretEntropy }');
      }
      if (typeof dv.logContent === 'boolean') merged.dualVerify.logContent = dv.logContent;
    }
    const m = raw?.metrics as Record<string, unknown> | undefined;
    if (m && typeof m === 'object' && typeof m.enabled === 'boolean') {
      merged.metrics.enabled = m.enabled;
    }
  }
  return merged;
}

/** Hook-safe metrics gate: GLOBAL config only (a hook's cwd is unreliable, and honoring a foreign
 *  checkout's project config from a hook would let an untrusted repo toggle user-level behavior —
 *  spec §6). Never throws; missing/malformed/absent key => true (the default). */
export function metricsEnabledFromGlobalConfig(home: string): boolean {
  const raw = readJson(join(home, 'config.json'));
  const m = raw?.metrics as Record<string, unknown> | undefined;
  return m && typeof m === 'object' && typeof m.enabled === 'boolean' ? m.enabled : true;
}

/** Merge a raw compaction object over defaults, validating each key's TYPE and BOUNDS. Out-of-range
 *  or wrong-typed values keep the default (never throw). */
function mergeCompaction(raw: unknown): CompactionConfig {
  const c: CompactionConfig = { ...DEFAULT_COMPACTION };
  const o = raw as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object') return c;
  if (typeof o.auto === 'boolean') c.auto = o.auto;
  if (typeof o.dirtyRatio === 'number' && o.dirtyRatio > 0 && o.dirtyRatio <= 1) c.dirtyRatio = o.dirtyRatio;
  if (typeof o.minRows === 'number' && Number.isInteger(o.minRows) && o.minRows >= 0) c.minRows = o.minRows;
  // >= 1, not >= 0: `reclaimableBytes >= 0` is a tautology, so minDirtyBytes: 0 would make
  // dirtyGate's absolute branch fire on a perfectly CLEAN ledger every grace window. Mirrors the
  // dirtyRatio (0,1] bound, which excludes 0 for exactly the same always-fire reason.
  if (typeof o.minDirtyBytes === 'number' && Number.isInteger(o.minDirtyBytes) && o.minDirtyBytes >= 1) c.minDirtyBytes = o.minDirtyBytes;
  if (typeof o.graceMs === 'number' && Number.isInteger(o.graceMs) && o.graceMs >= 0) c.graceMs = o.graceMs;
  if (typeof o.maxBytes === 'number' && Number.isInteger(o.maxBytes) && o.maxBytes > 0) c.maxBytes = o.maxBytes;
  return c;
}

/** Compaction config, GLOBAL only. Compaction is destructive (it can close the soft-erase undo
 *  window), so a foreign checkout's project config must never enable or tune it. Never throws. */
export function compactionConfigFromGlobal(home: string): CompactionConfig {
  return mergeCompaction(readJson(join(home, 'config.json'))?.compaction);
}
