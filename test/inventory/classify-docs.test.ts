import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBlocks, unclassified, invalidClassifications, DOC_CORPUS, CLAIMS_PATH } from '../../scripts/inventory/classify-docs.js';

describe('document block parsing', () => {
  it('splits every corpus document into non-empty blocks', () => {
    for (const file of DOC_CORPUS) {
      const blocks = parseBlocks(file);
      expect(blocks.length, `${file} produced no blocks`).toBeGreaterThan(5);
      for (const b of blocks) expect(b.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('gives each block a stable content-addressed id', () => {
    const a = parseBlocks('README.md');
    const b = parseBlocks('README.md');
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(new Set(a.map((x) => x.id)).size, 'block ids collide').toBe(a.length);
  });

  it('reports the source line of each block', () => {
    const blocks = parseBlocks('README.md');
    expect(blocks[0]?.line).toBeGreaterThan(0);
    expect(blocks.every((b) => b.line > 0)).toBe(true);
  });
});

describe('classification ledger', () => {
  it('leaves no block unclassified', () => {
    const ledger = JSON.parse(readFileSync(CLAIMS_PATH, 'utf8')) as Record<string, 'claim' | 'procedure' | 'non-normative'>;
    const missing = DOC_CORPUS.flatMap((f) => unclassified(parseBlocks(f), ledger));
    expect(
      missing.map((b) => `${b.file}:${b.line} ${b.text.slice(0, 60)}`),
      'unclassified blocks remain — classify each in data/inventory/claims.json',
    ).toEqual([]);
  });

  // 음성 대조: 분류기가 실제로 미분류를 검출하는지.
  it('reports a block whose classification is absent', () => {
    const blocks = parseBlocks('README.md');
    const partial = Object.fromEntries(blocks.slice(1).map((b) => [b.id, 'non-normative' as const]));
    expect(unclassified(blocks, partial).map((b) => b.id)).toEqual([blocks[0]?.id]);
  });

  it('every classification in the committed ledger is one of the three permitted values', () => {
    const ledger = JSON.parse(readFileSync(CLAIMS_PATH, 'utf8')) as Record<string, string>;
    expect(
      invalidClassifications(ledger),
      'the ledger carries a classification outside the permitted three',
    ).toEqual([]);
  });

  // 음성 대조: 오기가 실제로 검출되는지. 이것이 없으면 위 사례는 검사기가 항상 빈 배열을
  // 반환하는 경우에도 초록색이다.
  it('reports a classification value that is not permitted', () => {
    expect(invalidClassifications({ 'a#1': 'claim', 'b#2': 'clam', 'c#3': 'non-normative' }))
      .toEqual(['b#2']);
  });
});
