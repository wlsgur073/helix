// 설정 leaf는 파서가 실제로 쓰는 권위에서 회수한다. compaction 기본값은 export되지 않으므로
// 빈 HELIX_HOME에 대해 접근자를 실행하여 회수한다 — 읽기가 아니라 실행이다.
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
    // `unreadable`은 출력 상태이지 지원 설정이 아니다 (설계 문서 5.1).
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
    return out.sort((a, b) => a.path.localeCompare(b.path));
  } finally {
    // 디렉터리를 만든 함수가 수명을 소유한다. vitest 안에서는 global-setup의 실행별 루트가
    // 함께 지우지만, `npm run inventory`는 vitest 밖이라 여기서 지우지 않으면 누적된다.
    try { rmSync(home, { recursive: true, force: true }); } catch { /* 최선 노력 */ }
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

/**
 * 배포 번들에서 환경변수 읽기를 회수한다. 프로토콜로 물어볼 수 있는 표면이 아니므로
 * 패턴 대조를 쓴다. esbuild 출력에서 `process.env.IDENT`는 구문적으로 모호하지 않다.
 * 이 한계는 Task 4의 drift 테스트가 보완한다.
 */
export function extractEnvVars(): EnvVar[] {
  const found = new Map<string, Set<string>>();
  const re = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  for (const file of shippedFiles(BIN)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      const name = m[1];
      if (!found.has(name)) found.set(name, new Set());
      found.get(name)!.add(relative(ROOT, file));
    }
  }
  return [...found.entries()]
    .map(([name, files]) => ({ name, readIn: [...files].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
