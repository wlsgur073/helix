// Standing replay benchmark + sensor report (spec docs/superpowers/specs/2026-07-05-replay-metrics-sensor-design.md §8).
// Modes: default synthetic sweep | --real (read-only on the actual ledgers) | --report (summarize metrics.jsonl).
// Establishes the HMAC-era baseline — the 2026-06-13 numbers predate the MAC gate and are NOT comparable.
// Generator functions are exported for the future A4 JSONL-vs-SQLite comparison.
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, createReadStream, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type { MemoryRecord } from '../src/types.js';
import { ensureMaster, signVerify, digestContent } from '../src/memory/ledger-mac.js';
import { subkeyForScope, verifiedLiveStats } from '../src/memory/verified-read.js';
import { MemoryStore } from '../src/memory/store.js';
import { isOwned, projectLedgerPath } from '../src/memory/ownership.js';

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

const fmt = (x: number): string => x.toFixed(1).padStart(9);

function measurePhases(ledger: string, home: string, iters: number): { parse: number[]; project: number[] } {
  // parse/project come from verifiedLiveStats (a fresh read each call), independent of any store cache.
  // Recall latency is measured separately and honestly in measureRecallModes (cold vs warm): a single
  // reused store here would hit the A4 rank cache after the first call, so its recall numbers would be
  // warm-path only and duplicate recall.warm — so this loop reports no recall row.
  const parse: number[] = [];
  const project: number[] = [];
  for (let i = 0; i <= iters; i++) { // one extra: index 0 is the discarded warmup
    const { stats } = verifiedLiveStats(ledger, home);
    if (i === 0) continue; // discard warmup (spec §8)
    parse.push(stats.parseMs);
    project.push(stats.projectMs);
  }
  return { parse, project };
}

/** A4: separate the cache regimes honestly. COLD = first recall on a fresh store (cache empty, full
 *  rebuild — today's cost, and also the per-miss cost). WARM = repeated recall on one store, unchanged
 *  ledger (all HITs after the prime). No single number is reported as "the" speedup. */
function measureRecallModes(ledger: string, home: string, iters: number): { cold: number[]; warm: number[] } {
  const cold: number[] = [];
  const warm: number[] = [];
  const q = '배포 config timeout';
  for (let i = 0; i < iters; i++) {
    const fresh = new MemoryStore(ledger, { home, sessionId: 'bench' });   // cache empty -> MISS
    const t0 = performance.now();
    fresh.recall(q);
    cold.push(performance.now() - t0);
  }
  const warmStore = new MemoryStore(ledger, { home, sessionId: 'bench' });
  warmStore.recall(q);                                                     // prime (one MISS, discarded)
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    warmStore.recall(q);                                                   // HIT
    warm.push(performance.now() - t0);
  }
  return { cold, warm };
}

function printStatsRow(label: string, samples: number[]): void {
  const s = computeStats(samples);
  process.stdout.write(`${label.padEnd(10)} n=${String(s.n).padEnd(3)} median=${fmt(s.median)} min=${fmt(s.min)} max=${fmt(s.max)} mean=${fmt(s.mean)} sd=${fmt(s.sd)}\n`);
}

export function runSweep(opts: { sizes: number[]; iters: number; seed: number }): void {
  const home = mkdtempSync(join(tmpdir(), 'helix-bench-home-'));
  try {
    process.stdout.write(`bench-replay synthetic sweep (HMAC-era baseline; iters=${opts.iters}, warmup discarded)\n`);
    process.stdout.write('NOTE: no p95 column at this n -- nearest-rank p95 <= max for n<=20; true p95 lives in --report.\n');
    for (const rows of opts.sizes) {
      const ledger = join(home, `bench-${rows}.jsonl`);
      const gen = generateLedger(home, ledger, { rows, seed: opts.seed });
      const m = measurePhases(ledger, home, opts.iters);
      process.stdout.write(`\nrows=${rows} (verifies=${gen.verifies} supersedes=${gen.supersedes})  [all ms]\n`);
      printStatsRow('parse', m.parse);
      printStatsRow('project', m.project);
      const modes = measureRecallModes(ledger, home, opts.iters);
      printStatsRow('recall.cold', modes.cold);   // full rebuild — the baseline-comparable recall cost
      printStatsRow('recall.warm', modes.warm);    // A4 cache HIT on an unchanged ledger
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function runReal(): void {
  const home = process.env.HELIX_HOME ?? join(homedir(), '.helix');
  const globalLedger = process.env.HELIX_LEDGER ?? join(home, 'memory.jsonl');
  process.stdout.write(`bench-replay --real (read-only) home=${home}\n`);
  const scopes: Array<{ label: string; ledger: string; root?: string }> = [{ label: 'global', ledger: globalLedger }];
  const cwd = process.cwd();
  if (existsSync(join(cwd, '.helix')) && isOwned(cwd, home)) {
    scopes.push({ label: 'project', ledger: projectLedgerPath(cwd), root: cwd });
  }
  for (const s of scopes) {
    const probe = verifiedLiveStats(s.ledger, home, s.root);
    process.stdout.write(`\nscope=${s.label} rows=${probe.stats.rows} live=${probe.stats.liveRows} bytes=${probe.stats.bytes} key=${probe.stats.keyAvailable}\n`);
    const parse: number[] = []; const project: number[] = [];
    for (let i = 0; i <= 15; i++) {
      const { stats } = verifiedLiveStats(s.ledger, home, s.root);
      if (i === 0) continue;
      parse.push(stats.parseMs); project.push(stats.projectMs);
    }
    printStatsRow('parse', parse);
    printStatsRow('project', project);
  }
}

export interface ReportSummary {
  ops: Map<string, { n: number; p50: number; p95: number; errors: number }>;
  replayCurve: Array<{ bucket: string; scope: string; caller: string; n: number; p50: number; p95: number }>;
  skipped: { malformed: number; newerSchema: number };
  verdict: {
    windowDays: number; recallN: number; recallP95: number | null;
    replayN: number; replayP95: number | null;
    latestRows: number | null; latestBytes: number | null; triggered: boolean;
  };
}

const TRIGGER_MS = 150; // roadmap 2026-06-13 §2: migrate when measured recall p95 exceeds this

/** Pure summarizer over metrics JSONL lines (spec §8). Tolerant: malformed / v>1 / unknown kind /
 *  missing-required-field rows are skipped and counted — never a crash, never silent. */
export function summarizeMetrics(lines: Iterable<string>, opts: { sinceMs: number; nowMs: number }): ReportSummary {
  const cutoff = opts.nowMs - opts.sinceMs;
  const opAll = new Map<string, { all: number[]; errors: number }>();
  const opWindow = new Map<string, number[]>();
  const replayBuckets = new Map<string, number[]>();
  const replayWindow: number[] = [];
  let latestReplay: { ts: number; rows: number; bytes: number } | null = null;
  const skipped = { malformed: 0, newerSchema: 0 };

  for (const line of lines) {
    if (line.trim() === '') continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { skipped.malformed++; continue; }
    if (typeof row.v === 'number' && row.v > 1) { skipped.newerSchema++; continue; }
    const ts = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (row.kind === 'op' && typeof row['gen_ai.tool.name'] === 'string' && typeof row.duration_ms === 'number' && !Number.isNaN(ts)) {
      const tool = row['gen_ai.tool.name'];
      const slot = opAll.get(tool) ?? { all: [], errors: 0 };
      slot.all.push(row.duration_ms);
      if (row.ok === false) slot.errors++;
      opAll.set(tool, slot);
      if (ts >= cutoff) {
        const w = opWindow.get(tool) ?? [];
        w.push(row.duration_ms);
        opWindow.set(tool, w);
      }
    } else if (row.kind === 'replay' && typeof row.rows === 'number' && typeof row.parse_ms === 'number' && typeof row.project_ms === 'number' && !Number.isNaN(ts)) {
      const total = row.parse_ms + (row.project_ms as number);
      const bucket = row.rows < 1000 ? '<1k' : row.rows < 10_000 ? '1k-10k' : row.rows < 50_000 ? '10k-50k' : '>=50k';
      const key = `${bucket}|${String(row.scope)}|${String(row.caller)}`;
      const b = replayBuckets.get(key) ?? [];
      b.push(total);
      replayBuckets.set(key, b);
      if (ts >= cutoff) replayWindow.push(total);
      const bytes = typeof row.bytes === 'number' ? row.bytes : 0;
      if (!latestReplay || ts >= latestReplay.ts) latestReplay = { ts, rows: row.rows, bytes };
    } else {
      skipped.malformed++;
    }
  }

  const ops = new Map<string, { n: number; p50: number; p95: number; errors: number }>();
  for (const [tool, { all, errors }] of opAll) {
    const sorted = [...all].sort((a, b) => a - b);
    ops.set(tool, { n: sorted.length, p50: percentileNearestRank(sorted, 50), p95: percentileNearestRank(sorted, 95), errors });
  }
  const replayCurve = [...replayBuckets.entries()].map(([key, samples]) => {
    const [bucket, scope, caller] = key.split('|') as [string, string, string];
    const sorted = [...samples].sort((a, b) => a - b);
    return { bucket, scope, caller, n: sorted.length, p50: percentileNearestRank(sorted, 50), p95: percentileNearestRank(sorted, 95) };
  });

  const recallWin = (opWindow.get('helix_memory_recall') ?? []).sort((a, b) => a - b);
  const replayWin = [...replayWindow].sort((a, b) => a - b);
  const recallP95 = recallWin.length ? percentileNearestRank(recallWin, 95) : null;
  const replayP95 = replayWin.length ? percentileNearestRank(replayWin, 95) : null;
  return {
    ops, replayCurve, skipped,
    verdict: {
      windowDays: opts.sinceMs / 86_400_000, recallN: recallWin.length, recallP95,
      replayN: replayWin.length, replayP95,
      latestRows: latestReplay?.rows ?? null, latestBytes: latestReplay?.bytes ?? null,
      triggered: recallP95 !== null && recallP95 > TRIGGER_MS,
    },
  };
}

export async function runReport(opts: { file?: string; sinceDays: number }): Promise<void> {
  const home = process.env.HELIX_HOME ?? join(homedir(), '.helix');
  const file = opts.file ?? join(home, 'metrics.jsonl');
  let size = 0;
  try { size = statSync(file).size; } catch { process.stdout.write(`no metrics file at ${file}\n`); return; }
  if (size > 50 * 1024 * 1024) process.stdout.write(`WARNING: metrics file is ${(size / 1048576).toFixed(0)} MB (>50MB) -- consider archiving it\n`);
  const lines: string[] = [];
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) lines.push(line); // streaming read; summarize is pure
  const s = summarizeMetrics(lines, { sinceMs: opts.sinceDays * 86_400_000, nowMs: Date.now() });

  process.stdout.write(`\nper-tool op latency (all data)\n`);
  for (const [tool, o] of s.ops) {
    const flag = o.n < 20 ? '  [insufficient samples]' : '';
    process.stdout.write(`${tool.padEnd(24)} n=${String(o.n).padEnd(5)} p50=${fmt(o.p50)} p95=${fmt(o.p95)} errors=${o.errors}${flag}\n`);
  }
  process.stdout.write(`\nreplay latency vs rows (parse+project ms, all data)\n`);
  for (const c of s.replayCurve) {
    process.stdout.write(`${c.bucket.padEnd(8)} ${c.scope.padEnd(8)} ${c.caller.padEnd(6)} n=${String(c.n).padEnd(5)} p50=${fmt(c.p50)} p95=${fmt(c.p95)}\n`);
  }
  if (s.skipped.malformed + s.skipped.newerSchema > 0) {
    process.stdout.write(`\nskipped: ${s.skipped.malformed + s.skipped.newerSchema} rows (${s.skipped.newerSchema} newer-schema)\n`);
  }
  const v = s.verdict;
  process.stdout.write(`\nverdict (window: last ${v.windowDays} days; current size: rows=${v.latestRows ?? '?'} bytes=${v.latestBytes ?? '?'})\n`);
  process.stdout.write(`  recall op p95: ${v.recallP95 === null ? 'no samples' : `${v.recallP95.toFixed(1)}ms (n=${v.recallN}${v.recallN < 20 ? ', insufficient' : ''})`} vs trigger ${TRIGGER_MS}ms\n`);
  process.stdout.write(`  replay p95:    ${v.replayP95 === null ? 'no samples' : `${v.replayP95.toFixed(1)}ms (n=${v.replayN})`}\n`);
  process.stdout.write(v.triggered ? `  TRIGGER EXCEEDED -- evaluate the Stage-B SQLite migration (roadmap 2026-06-13 section 6)\n` : `  below trigger -- no action\n`);
}

// --- CLI entry ---
interface BenchArgs {
  mode: 'sweep' | 'real' | 'report';
  rows?: number[];
  iters: number;
  seed: number;
  file?: string;
  sinceDays: number;
}

function parseArgs(argv: string[]): BenchArgs {
  const out: BenchArgs = { mode: 'sweep', iters: 15, seed: 1, sinceDays: 14 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--real') out.mode = 'real';
    else if (a === '--report') out.mode = 'report';
    else if (a === '--rows') out.rows = argv[++i]!.split(',').map(Number);
    else if (a === '--iters') out.iters = Number(argv[++i]);
    else if (a === '--seed') out.seed = Number(argv[++i]);
    else if (a === '--file') out.file = argv[++i]!;
    else if (a === '--since') out.sinceDays = Number(argv[++i]);
  }
  return out;
}

const invokedDirectly = process.argv[1]?.endsWith('bench-replay.ts') || process.argv[1]?.endsWith('bench-replay.js');
if (invokedDirectly) {
  const args = parseArgs(process.argv);
  if (args.mode === 'real') runReal();
  else if (args.mode === 'report') void runReport({ file: args.file, sinceDays: args.sinceDays }); // Task 9
  else runSweep({ sizes: args.rows ?? [1000, 5000, 10000, 50000, 100000], iters: args.iters, seed: args.seed });
}
