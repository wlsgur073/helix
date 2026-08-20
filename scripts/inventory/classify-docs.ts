// Parses the shipped docs into blocks and checks each against the classification ledger.
// An unclassified block is a failure.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Classification = 'claim' | 'procedure' | 'non-normative';
export interface DocBlock { id: string; file: string; line: number; text: string }

const PERMITTED: ReadonlySet<string> = new Set<string>(['claim', 'procedure', 'non-normative']);

/**
 * Returns the ids of blocks whose classification value is not one of the permitted three. A typo
 * puts the block in none of them, so it drops out of claim-row generation in silence — which is why
 * the key merely being present is not enough.
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

/** Splits on blank lines, but keeps a fenced code block together as one piece. */
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
