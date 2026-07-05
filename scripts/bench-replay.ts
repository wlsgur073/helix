// Standing replay benchmark + sensor report (spec docs/superpowers/specs/2026-07-05-replay-metrics-sensor-design.md §8).
// Modes: default synthetic sweep | --real (read-only on the actual ledgers) | --report (summarize metrics.jsonl).
// Establishes the HMAC-era baseline — the 2026-06-13 numbers predate the MAC gate and are NOT comparable.
// Generator functions are exported for the future A4 JSONL-vs-SQLite comparison.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { MemoryRecord } from '../src/types.js';
import { ensureMaster, signVerify, digestContent } from '../src/memory/ledger-mac.js';
import { subkeyForScope, verifiedLiveStats } from '../src/memory/verified-read.js';

// --- deterministic RNG (seedable) — reproducible fixtures, no Math.random ---
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x1_0000_0000);
}

const EN = ['build', 'deploy', 'server', 'config', 'test', 'release', 'branch', 'commit', 'timeout', 'retry', 'cache', 'index', 'memory', 'ledger', 'verify'];
const KO = ['빌드', '배포', '서버', '설정', '테스트', '릴리스', '브랜치', '커밋', '메모리', '검증', '캐시', '인덱스', '기록', '규칙', '환경'];

function content(rand: () => number): string {
  const words: string[] = [];
  let len = 0;
  const target = 150 + Math.floor(rand() * 151); // 150-300 chars, the 2026-06-13 mix
  while (len < target) {
    const w = rand() < 0.5 ? EN[Math.floor(rand() * EN.length)]! : KO[Math.floor(rand() * KO.length)]!;
    words.push(w);
    len += w.length + 1;
  }
  return words.join(' ');
}

export interface GenOptions {
  rows: number;
  supersedePct?: number; // default 0.10
  verifyPct?: number;    // default 0.05
  seed?: number;         // default 1
}

/** Build a synthetic ledger with REAL signed verify records, then SELF-CHECK it against the real
 *  verifier (spec §8 / adjudication C2-7): a fixture whose signatures silently failed would clamp
 *  to Fresh and the bench would measure the wrong (HMAC-skipping) path. Throws on self-check failure. */
export function generateLedger(home: string, ledger: string, opts: GenOptions): { rows: number; verifies: number; supersedes: number } {
  const rand = lcg(opts.seed ?? 1);
  const supersedePct = opts.supersedePct ?? 0.10;
  const verifyPct = opts.verifyPct ?? 0.05;
  ensureMaster(home);
  const subkey = subkeyForScope(home);
  if (!subkey) throw new Error('bench: could not resolve the global subkey after ensureMaster');

  const ts = (i: number): string => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
  const base = (i: number): MemoryRecord => ({
    id: `m_${i}`, tx: ts(i), validFrom: ts(i), validTo: null,
    type: 'assert', state: 'Fresh', content: content(rand),
    provenance: { source: 'user', sessionId: 'bench' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  });

  const records: MemoryRecord[] = [];
  const superseded = new Set<string>();
  let verifies = 0;
  let supersedes = 0;
  for (let i = 0; i < opts.rows; i++) {
    const r = rand();
    const priorAsserts = records.filter((x) => (x.type === 'assert' || x.type === 'supersede') && !superseded.has(x.id));
    if (r < verifyPct && priorAsserts.length > 0) {
      const target = priorAsserts[Math.floor(rand() * priorAsserts.length)]!;
      records.push(signVerify({
        ...base(i), id: `v_${i}`, type: 'verify', state: 'Corroborated', content: '',
        provenance: { source: 'reality-check', sessionId: 'bench' },
        supersedes: target.id, gen: 1, targetDigest: digestContent(target.content),
      }, subkey));
      verifies++;
    } else if (r < verifyPct + supersedePct && priorAsserts.length > 0) {
      const target = priorAsserts[Math.floor(rand() * priorAsserts.length)]!;
      records.push({ ...base(i), type: 'supersede', supersedes: target.id });
      superseded.add(target.id);
      supersedes++;
    } else {
      records.push(base(i));
    }
  }
  mkdirSync(dirname(ledger), { recursive: true });
  writeFileSync(ledger, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // Self-check: the REAL verifying read must accept the fixture (key present + >=1 elevation held).
  const { projection, stats } = verifiedLiveStats(ledger, home);
  if (!stats.keyAvailable) throw new Error('bench self-check: fixture read key-absent');
  if (verifies > 0 && ![...projection.live.values()].some((x) => x.state !== 'Fresh')) {
    throw new Error('bench self-check: signed verifies were NOT honored — fixture would measure the clamp path');
  }
  return { rows: records.length, verifies, supersedes };
}

// --- statistics (honest: no p95 at bench-level n; nearest-rank p95 lives in --report) ---
export function computeStats(samples: number[]): { n: number; median: number; min: number; max: number; mean: number; sd: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, x) => s + x, 0) / n;
  const mid = Math.floor(n / 2);
  const median = n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const sd = Math.sqrt(sorted.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
  return { n, median, min: sorted[0]!, max: sorted[n - 1]!, mean, sd };
}

/** Nearest-rank percentile over an ASCENDING-sorted array. */
export function percentileNearestRank(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}
