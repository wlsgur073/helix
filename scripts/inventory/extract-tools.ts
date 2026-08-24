// The tool surface is recovered twice over: once from the bundle the user runs and once from the
// source registry, each read through the protocol, and the two are required to agree. No regex and
// no counting.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../../src/memory/store.js';
import { buildServer } from '../../src/server/helix-server.js';

export interface ToolFacet {
  name: string;
  description: string;
  inputSchema: unknown;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(ROOT, 'bin', 'helix-mcp.mjs');

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_')),
  ) as Record<string, string>;
}

const facet = (t: { name: string; description?: string; inputSchema: unknown }): ToolFacet =>
  ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema });

// Compared by code point. `localeCompare` degrades to a code-point-like comparison on a
// `--without-intl` / small-icu Node and orders pairs such as `HELIX_HOME` vs `HELIXA` differently.
// This snapshot exists to be diffed on another machine, so no axis may depend on the ICU build.
const byName = (a: ToolFacet, b: ToolFacet): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Recovered from the bytes the user actually runs.
 *
 * `bundle` defaults to the shipped bundle; passing it is how a test injects a synthetic mutation.
 * Handing in a mutated temporary copy confirms that this function really reads the bytes it is
 * given rather than returning a constant. `bin/` itself is never mutated.
 */
export async function fromBundle(bundle: string = BUNDLE): Promise<ToolFacet[]> {
  const home = mkdtempSync(join(tmpdir(), 'helix-inv-bundle-'));
  const client = new Client({ name: 'helix-inventory', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    cwd: home,
    env: { ...cleanEnv(), HELIX_HOME: home },
  }));
  try {
    const { tools } = await client.listTools();
    return tools.map(facet).sort(byName);
  } finally {
    await client.close();
    // The function that made the directory owns its lifetime. Inside vitest the global-setup
    // per-run root removes it too, but `npm run inventory` runs outside vitest, so without this
    // removal the directories accumulate.
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Runs `fn` with `process.env.HELIX_HOME` temporarily changed, then restores the previous value.
 * `process.env.X = undefined` stores the string `"undefined"`, so when there was no previous value
 * the restore deletes the key instead of assigning to it — the same discipline as `restoreEnv` in
 * `test/global-setup.ts`.
 */
function withHelixHome<T>(home: string, fn: () => T): T {
  const prior = process.env.HELIX_HOME;
  process.env.HELIX_HOME = home;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.HELIX_HOME;
    else process.env.HELIX_HOME = prior;
  }
}

/** Recovered independently, from the source registry. */
export async function fromSource(): Promise<ToolFacet[]> {
  const home = mkdtempSync(join(tmpdir(), 'helix-inv-src-'));
  const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 'inventory' });
  // Called without `dualDeps`, `buildServer` resolves `process.env.HELIX_HOME ?? homedir()/.helix`
  // on its own and runs `loadConfig` against that path immediately. Handing the temporary directory
  // to `MemoryStore` alone would leave this arm reading the operator's real global config, so the
  // two arms of the double recovery would run under different settings. The scope is narrowed to the
  // single `buildServer` call: tool registration finishes there, and `listTools` drives no handler.
  const server = withHelixHome(home, () => buildServer(store));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'helix-inventory-src', version: '0.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const { tools } = await client.listTools();
    return tools.map(facet).sort(byName);
  } finally {
    await client.close();
    // The function that made the directory owns its lifetime. Inside vitest the global-setup
    // per-run root removes it too, but `npm run inventory` runs outside vitest, so without this
    // removal the directories accumulate.
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const clip = (v: string | undefined): string =>
  v === undefined ? 'undefined' : v.length > 160 ? `${v.slice(0, 160)}\u2026 (${v.length} chars)` : v;

/**
 * The first field the two surfaces disagree on, as `<tool>.<field>` with both values.
 *
 * A name list is not a diagnosis. The three suite failures this refusal hid for two days had
 * IDENTICAL names on both sides, so the reader was handed the one axis that had not moved and
 * had to bisect by hand to find the one that had.
 */
function firstDifference(bundle: ToolFacet[], source: ToolFacet[]): string {
  const bNames = bundle.map((t) => t.name);
  const sNames = source.map((t) => t.name);
  const bundleOnly = bNames.filter((n) => !sNames.includes(n));
  const sourceOnly = sNames.filter((n) => !bNames.includes(n));
  if (bundleOnly.length > 0 || sourceOnly.length > 0) {
    return `tool set \u2014 bundle-only=[${bundleOnly.join(',')}] source-only=[${sourceOnly.join(',')}]`;
  }
  for (const [i, b] of bundle.entries()) {
    const s = source[i];
    if (s === undefined) break;
    if (b.name !== s.name) return `position ${i} name \u2014 bundle=${b.name} source=${s.name}`;
    for (const field of ['description', 'inputSchema'] as const) {
      const bv = JSON.stringify(b[field]);
      const sv = JSON.stringify(s[field]);
      if (bv !== sv) return `${b.name}.${field} \u2014 bundle=${clip(bv)} source=${clip(sv)}`;
    }
  }
  // Every name matches and every compared field matches, so the surfaces differ only in how many
  // entries carry those names: one side repeats an entry the other lists once.
  return `arity \u2014 bundle=${bundle.length} source=${source.length} over matching names`;
}

/** A disagreement is a failure, and no inventory is produced. */
export function compareSurfaces(bundle: ToolFacet[], source: ToolFacet[]): void {
  const b = JSON.stringify(bundle);
  const s = JSON.stringify(source);
  if (b === s) return;
  throw new Error(
    'tool-surface-disagreement: the shipped bundle and the source registry differ. ' +
    `first difference: ${firstDifference(bundle, source)}. ` +
    `bundle=[${bundle.map((t) => t.name).join(',')}] source=[${source.map((t) => t.name).join(',')}]`,
  );
}

export async function extractTools(): Promise<ToolFacet[]> {
  const [bundle, source] = await Promise.all([fromBundle(), fromSource()]);
  compareSurfaces(bundle, source);
  return bundle;
}
