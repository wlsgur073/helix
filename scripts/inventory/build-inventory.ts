// Combines the three extractors into one snapshot. Run with no arguments it rewrites the snapshot file.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTools, type ToolFacet } from './extract-tools.js';
import { extractConfigLeaves, extractEnvVars, type ConfigLeaf, type EnvVar } from './extract-config.js';
import { extractHooks, extractClis, type HookFacet, type CliFacet } from './extract-entrypoints.js';

export interface Surface {
  tools: ToolFacet[];
  configLeaves: ConfigLeaf[];
  envVars: EnvVar[];
  hooks: HookFacet[];
  clis: CliFacet[];
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SURFACE_PATH = join(ROOT, 'data', 'inventory', 'surface.json');

export async function buildSurface(): Promise<Surface> {
  return {
    tools: await extractTools(),
    configLeaves: extractConfigLeaves(),
    envVars: extractEnvVars(),
    hooks: extractHooks(),
    clis: extractClis(),
  };
}

if (process.argv[1] && process.argv[1].endsWith('build-inventory.ts')) {
  const surface = await buildSurface();
  mkdirSync(dirname(SURFACE_PATH), { recursive: true });
  writeFileSync(SURFACE_PATH, `${JSON.stringify(surface, null, 2)}\n`);
  process.stdout.write(
    `inventory: ${surface.tools.length} tools, ${surface.configLeaves.length} config leaves, ` +
    `${surface.envVars.length} env vars, ${surface.hooks.length} hooks, ${surface.clis.length} CLIs\n`,
  );
}
