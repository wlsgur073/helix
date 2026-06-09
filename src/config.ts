import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type DualVerifyMode = 'compare' | 'critique';
export type StakesFloor = 'low' | 'medium' | 'high';

export interface HelixConfig {
  dualVerify: { enabled: boolean; mode: DualVerifyMode; stakesFloor: StakesFloor };
}

export const DEFAULT_CONFIG: HelixConfig = {
  dualVerify: { enabled: false, mode: 'compare', stakesFloor: 'high' },
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
    }
  }
  return merged;
}
