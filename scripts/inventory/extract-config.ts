// Config leaves are recovered from the authority the parser itself uses. The compaction defaults
// are not exported, so they are recovered by running the accessor against an empty HELIX_HOME —
// by execution, not by reading.
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, compactionConfigFromGlobal } from '../../src/config.js';

export interface ConfigLeaf { path: string; defaultValue: unknown }
export interface EnvVar { name: string; readIn: string[] }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(ROOT, 'bin');

const isBranch = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function walk(node: Record<string, unknown>, prefix: string[], out: ConfigLeaf[]): void {
  for (const [key, value] of Object.entries(node)) {
    // `unreadable` is an output state, not a supported setting.
    if (prefix.length === 0 && key === 'unreadable') continue;
    const path = [...prefix, key];
    if (isBranch(value)) walk(value, path, out);
    else out.push({ path: path.join('.'), defaultValue: value });
  }
}

export function extractConfigLeaves(): ConfigLeaf[] {
  const home = mkdtempSync(join(tmpdir(), 'helix-inv-cfg-'));
  try {
    const out: ConfigLeaf[] = [];
    walk(DEFAULT_CONFIG as unknown as Record<string, unknown>, [], out);
    walk({ compaction: compactionConfigFromGlobal(home) as unknown as Record<string, unknown> }, [], out);
    // Compared by code point. `localeCompare` degrades on a `--without-intl` / small-icu Node and
    // orders differently there, and this snapshot exists precisely to be diffed on another machine.
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  } finally {
    // The function that made the directory owns its lifetime. Inside vitest the global-setup
    // per-run root removes it too, but `npm run inventory` runs outside vitest, so without this
    // removal the directories accumulate.
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function shippedFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) shippedFiles(full, acc);
    else if (full.endsWith('.mjs')) acc.push(full);
  }
  return acc;
}

/** The form that is recovered: `process.env.IDENT`, which is syntactically unambiguous in esbuild output. */
const ENV_READ = /process\.env\.([A-Z][A-Z0-9_]*)/g;
/** A detector that counts the unrecoverable forms too: bracket access and lower-case names. */
const ENV_ANY = /process\.env\s*(?:\.|\[)/g;

/**
 * Recovers environment-variable reads from the shipped bundles. This is not a surface a protocol
 * can be asked about, so it is matched by pattern.
 *
 * A drift test does not cover the gap. A drift test only detects changes the regex can SEE: if a
 * form it cannot see in principle is introduced — `process.env['X']`, or
 * `const { X } = process.env` — the live recovery misses it too, so the snapshot is unchanged and
 * the drift test passes. Instead a broad detector regex is run and its match count compared, so
 * that a single unrecoverable form fails inventory generation outright. That is the "fail on an
 * unrecognised form" behaviour v0.1 adopted. The destructuring form is invisible even to this
 * comparison.
 *
 * `dir` defaults to the shipped bundle directory; passing it is how a test injects a synthetic
 * mutation, so that recovery can be confirmed without planting the mutation in production code.
 */
export function extractEnvVars(dir: string = BIN): EnvVar[] {
  const found = new Map<string, Set<string>>();
  for (const file of shippedFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    const recovered = [...text.matchAll(ENV_READ)];
    const detected = [...text.matchAll(ENV_ANY)].length;
    if (detected > recovered.length) {
      throw new Error(
        `env-read-form-unrecognized: ${rel} carries ${detected} process.env accesses but only ` +
        `${recovered.length} are in the recoverable \`process.env.IDENT\` form. The inventory would ` +
        'silently omit the rest, so it is not built. Extend the extractor to the new form.',
      );
    }
    for (const m of recovered) {
      // `noUncheckedIndexedAccess` is on, so a capture group is typed `string | undefined`. In this
      // regex group 1 always participates on a match, but the type does not know that.
      const name = m[1];
      if (name === undefined) continue;
      if (!found.has(name)) found.set(name, new Set());
      found.get(name)!.add(rel);
    }
  }
  return [...found.entries()]
    .map(([name, files]) => ({ name, readIn: [...files].sort() }))
    // Compared by code point, for the same reason as the `path` sort above — and the degradation
    // that was actually measured was the `HELIX_HOME` vs `HELIXA` pair, so this sort sits closest
    // to that axis.
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
