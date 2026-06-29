import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Expansion, ExpansionEntry } from './retrieval.js';

// EH-3 calibration constants (Task 4 refines these against the synonym fixture):
//  - EXP_THETA: runtime neighbor-inclusion cosine, applied OVER the table's build floor (0.50).
//  - EXP_K: max neighbors kept per token.
//  - SEM_DISCOUNT: scales neighbor weights so a semantic match never equals an exact lexical one.
//  - SEM_GATE: min semanticWeight for a semantic-ONLY record to survive (noise guard).
export const EXP_THETA = 0.52;
export const EXP_K = 8;
export const SEM_DISCOUNT = 0.8;
export const SEM_GATE = 0.4;

interface RawAsset { neighbors: Record<string, Array<[string, number]>> }

/** Pure: parse the asset blob into an Expansion, keeping neighbors with cosine >= theta, top-k. */
export function loadExpansion(json: string, theta: number, k: number): Expansion {
  const raw = JSON.parse(json) as RawAsset;
  const map = new Map<string, ReadonlyArray<ExpansionEntry>>();
  for (const [token, arr] of Object.entries(raw.neighbors)) {
    const kept: ExpansionEntry[] = [];
    for (const [nb, wm] of arr) {
      if (kept.length >= k) break;
      const w = wm / 1000;
      if (w >= theta) kept.push({ token: nb, w });
    }
    if (kept.length) map.set(token, kept);
  }
  return map;
}

let cached: Expansion | undefined | null = null; // null = not yet attempted
/**
 * Resolve + load data/semantic-neighbors.json once (cached). Tries the source-tree path first, then
 * the path beside the bundled server (build.mjs copies the asset there). Returns undefined — a
 * graceful pure-lexical fallback — if the asset is absent or malformed.
 */
export function defaultExpansion(): Expansion | undefined {
  if (cached !== null) return cached ?? undefined;
  const candidates = [
    new URL('../../data/semantic-neighbors.json', import.meta.url), // src/memory -> repo/data (source/tests)
    new URL('../data/semantic-neighbors.json', import.meta.url),    // bin/helix-mcp.mjs -> repo/data (bundle)
  ];
  let txt: string | undefined;
  for (const u of candidates) {
    try { txt = readFileSync(fileURLToPath(u), 'utf8'); break; } catch { /* try next */ }
  }
  if (txt === undefined) { cached = undefined; return undefined; }
  try { cached = loadExpansion(txt, EXP_THETA, EXP_K); } catch { cached = undefined; }
  return cached ?? undefined;
}
