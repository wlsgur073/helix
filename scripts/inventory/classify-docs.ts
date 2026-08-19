// 배포 문서를 블록 단위로 파싱하고 분류 원장과 대조한다. 미분류 블록은 실패이다.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Classification = 'claim' | 'procedure' | 'non-normative';
export interface DocBlock { id: string; file: string; line: number; text: string }

const PERMITTED: ReadonlySet<string> = new Set<string>(['claim', 'procedure', 'non-normative']);

/**
 * 허용되지 않은 분류 값을 가진 블록 ID를 반환한다. 오기가 있으면 그 블록은 세 부류
 * 어디에도 속하지 않아 이후 청구 행 생성에서 조용히 탈락하므로, 키의 존재만으로는 부족하다.
 */
export function invalidClassifications(ledger: Record<string, string>): string[] {
  return Object.entries(ledger).filter(([, v]) => !PERMITTED.has(v)).map(([k]) => k).sort();
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLAIMS_PATH = join(ROOT, 'data', 'inventory', 'claims.json');

export const DOC_CORPUS: readonly string[] = [
  'README.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'docs/release/recovery-playbook.md',
];

/** 빈 줄로 블록을 나누되, 펜스 코드 블록은 한 덩어리로 유지한다. */
export function parseBlocks(file: string): DocBlock[] {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const out: DocBlock[] = [];
  let buf: string[] = [];
  let start = 1;
  let inFence = false;

  const flush = (): void => {
    const text = buf.join('\n').trim();
    if (text.length > 0) {
      const id = `${file}#${createHash('sha256').update(text.replace(/\s+/g, ' ')).digest('hex').slice(0, 12)}`;
      out.push({ id, file, line: start, text });
    }
    buf = [];
  };

  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === '') { flush(); start = i + 2; return; }
    if (buf.length === 0) start = i + 1;
    buf.push(line);
  });
  flush();
  return out;
}

export function unclassified(blocks: DocBlock[], ledger: Record<string, Classification>): DocBlock[] {
  return blocks.filter((b) => ledger[b.id] === undefined);
}
