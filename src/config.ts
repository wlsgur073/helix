import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type DualVerifyMode = 'compare' | 'critique';
export type StakesFloor = 'low' | 'medium' | 'high';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const MODEL_RE = /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/; // argv-safe model token: no leading dash, no shell/space chars

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
     *  so this is configurable. Must be an integer in [1000, 2_147_483_647]; anything else
     *  (non-integer, < 1s, > Node's setTimeout ceiling, NaN, ∞) falls back to the default. */
    timeoutMs: number;
    /** Egress policy for non-secret legs (memory-echo / PII). User-edited only; default 'block'.
     *  Secrets block regardless. Read once at startup (a mid-session flip needs a restart). */
    memoryEgress: 'block' | 'allow';
    /** Opt-in: persist the exact Codex prompt+response to ~/.helix/codex-log.jsonl. Default false
     *  (OFF). audit.jsonl still records decision metadata regardless of this flag. */
    logContent: boolean;
  };
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
    // Block memory-derived / PII egress to the external Codex model by default. User opts into risk
    // by editing this to 'allow' (a human edit, outside model control). Invalid value => 'block'.
    memoryEgress: 'block',
    // Content logging OFF by default; audit.jsonl still records metadata. Invalid value => false.
    logContent: false,
  },
};

export interface LoadConfigOptions {
  projectPath?: string; // default .helix/config.json under cwd
  globalPath?: string;  // default ~/.helix/config.json
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
  for (const path of [globalPath, projectPath]) {
    const raw = readJson(path);
    const dv = raw?.dualVerify as Partial<HelixConfig['dualVerify']> | undefined;
    if (dv) {
      if (typeof dv.enabled === 'boolean') merged.dualVerify.enabled = dv.enabled;
      if (dv.mode === 'compare' || dv.mode === 'critique') merged.dualVerify.mode = dv.mode;
      if (dv.stakesFloor === 'low' || dv.stakesFloor === 'medium' || dv.stakesFloor === 'high') {
        merged.dualVerify.stakesFloor = dv.stakesFloor;
      }
      if (dv.model === null || (typeof dv.model === 'string' && MODEL_RE.test(dv.model))) {
        merged.dualVerify.model = dv.model;
      }
      if (dv.effort === null || (typeof dv.effort === 'string' && EFFORTS.includes(dv.effort as ReasoningEffort))) {
        merged.dualVerify.effort = dv.effort as ReasoningEffort | null;
      }
      // Integer ms within a sane band: >= 1s (a real Codex call never completes faster) and
      // <= the Node setTimeout 32-bit ceiling — above it Node clamps the delay to 1ms, silently
      // inverting intent (asked-for-longer => instant timeout). Anything else keeps the default.
      const t = dv.timeoutMs;
      if (typeof t === 'number' && Number.isInteger(t) && t >= 1_000 && t <= 2_147_483_647) {
        merged.dualVerify.timeoutMs = t;
      }
      if (dv.memoryEgress === 'block' || dv.memoryEgress === 'allow') merged.dualVerify.memoryEgress = dv.memoryEgress;
      if (typeof dv.logContent === 'boolean') merged.dualVerify.logContent = dv.logContent;
    }
  }
  return merged;
}
