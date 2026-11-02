import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ledgerContentKindOfFd, ledgerContentKindAt, parseLedgerHealth, LEDGER_CONTENT_READ_BOUND_BYTES, type LedgerContentKind } from '../../src/memory/ledger.js';

const BOUND = LEDGER_CONTENT_READ_BOUND_BYTES;
const NOW = '2026-10-01T00:00:00.000Z';
const dir = fs.mkdtempSync(join(tmpdir(), 'lck-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const rec = (id: string, content = `fact ${id}`): string => JSON.stringify({ id, tx: NOW, validFrom: NOW, validTo: null, type: 'assert', state: 'Fresh', content, provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' }) + '\n';
function kindOf(bytes: Buffer | string): LedgerContentKind {
  const p = join(dir, `f${++n}`); fs.writeFileSync(p, bytes);
  const fd = fs.openSync(p, 'r');
  try { return ledgerContentKindOfFd(fd); } finally { fs.closeSync(fd); }
}
/** The definition of 4.4 applied to the first MiB: complete lines inside the bound, the reader's own test, "other" when a longer file shows no record. */
function oracle(bytes: Buffer): LedgerContentKind {
  let view = bytes; let cut = false;
  if (bytes.length > BOUND) { const prefix = bytes.subarray(0, BOUND); view = prefix.subarray(0, prefix.lastIndexOf(0x0a) + 1); cut = true; }
  const { records, skippedNonBlank } = parseLedgerHealth(view.toString('utf8'));
  if (records.length > 0) return 'rows';
  return cut || skippedNonBlank > 0 ? 'other' : 'empty';
}

describe('ledgerContentKindOfFd: the definition of 4.4 on small files', () => {
  it.each<[string, string, LedgerContentKind]>([
    ['an empty file', '', 'empty'],
    ['blank lines only', '\n  \n\t\n', 'empty'],
    ['one record line', rec('a'), 'rows'],
    ['a record line without a trailing newline', rec('a').trimEnd(), 'rows'],
    ['{} only is not a record', '{}\n', 'other'],
    ['garbage then a record', 'not json\n\n{}\n' + rec('a'), 'rows'],
    ['a record then garbage', rec('a') + 'not json\n{}\n[1,2]\n', 'rows'],
    ['a BOM line is skipped by the reader, so a BOM-prefixed record is no record', '\uFEFF' + rec('a'), 'other'],
    ['CRLF line ends', rec('a').replace('\n', '\r\n'), 'rows'],
    ['provenance null is not a record', JSON.stringify({ id: 'x', content: 'c', tx: NOW, provenance: null }) + '\n', 'other'],
    ['a key spelled with an escape is still the key', '{"\\u0069d":"x","content":"c","tx":"t","provenance":{}}\n', 'rows'],
    ['a record line missing provenance', '{"id":"x","content":"c","tx":"t"}\n', 'other'],
  ])('%s', (_label, text, want) => { expect(kindOf(text)).toBe(want); });
});

describe('ledgerContentKindOfFd: the bound (decision 1)', () => {
  it('a record line that ends inside the first MiB is found whatever precedes it', () => {
    expect(kindOf('x\n'.repeat(500_000) + rec('a'))).toBe('rows');
  });
  it('a record line whose newline lies past the bound is not seen: the answer is other', () => {
    const r = rec('a');
    expect(kindOf('x'.repeat(BOUND - 10) + '\n' + r)).toBe('other');
  });
  it('a record line that ends exactly at the bound counts (the file goes on after it)', () => {
    const r = rec('a');
    expect(kindOf('x'.repeat(BOUND - r.length - 1) + '\n' + r + 'x\n')).toBe('rows');
  });
  it('a file that ends exactly at the bound is judged whole, a record without a newline included', () => {
    const r = rec('a').trimEnd();
    expect(kindOf('x'.repeat(BOUND - r.length - 1) + '\n' + r)).toBe('rows');
  });
  it('the first record past 1 MiB of text lines: other (record-after-1.5MiB-text)', () => {
    expect(kindOf('x\n'.repeat(1_000_000) + rec('a'))).toBe('other');
  });
  it('a first line Helix wrote itself, 16,384 U+0001 characters escaped to 6 bytes each, is far below the bound: rows', () => {
    const line = rec('m_big', '\u0001'.repeat(16_384));
    expect(line.length).toBeGreaterThan(98_000);
    expect(line.length).toBeLessThan(BOUND);
    expect(kindOf(line)).toBe('rows');
  });
  it('a blank-only first MiB of a longer file is NOT empty; a blank file of exactly 1 MiB is', () => {
    expect(kindOf(Buffer.alloc(BOUND, 0x0a))).toBe('empty');
    expect(kindOf(Buffer.alloc(BOUND + 1, 0x0a))).toBe('other');
    expect(kindOf(Buffer.from(' \n'.repeat(BOUND / 2 + 1)))).toBe('other');
  });
});

describe('ledgerContentKindOfFd against the reader the definition names', () => {
  const POOL = [
    rec('a').trimEnd(), '{}', '[1,2]', 'not json', '', '   ', '\t', '\r', '\v', '\f', '\u00a0', '\u3000', '\ufeff', '\ufeff' + rec('b').trimEnd(),
    '{"id":"x"}', '{\\}', '{', '}', '"{"', rec('c').trimEnd() + '\r', '  ' + rec('d').trimEnd() + ' \t',
    JSON.stringify({ id: 'x', content: 'c', tx: NOW, provenance: null }), JSON.stringify({ id: 'x', content: 'c', tx: NOW, provenance: {} }),
    '{"\\u0069d":"x","content":"c","tx":"t","provenance":{}}', '{"note":"id content tx provenance"}', '{"x":"\\"id\\" \\"content\\" \\"tx\\" \\"provenance\\""}',
  ];
  it('hand-written edge lines, alone', () => {
    for (const line of POOL) expect(kindOf(line + '\n'), JSON.stringify(line)).toBe(oracle(Buffer.from(line + '\n')));
  });
  it('2,000 seeded random files, and the same files shifted across the 64 KiB read boundary: 0 differences', () => {
    let s = 20261028;
    const rand = (m: number): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % m; };
    const diffs: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const lines: string[] = []; for (let k = 0, m = 1 + rand(10); k < m; k++) lines.push(POOL[rand(POOL.length)]!);
      const text = lines.join('\n') + (rand(2) === 0 ? '\n' : '');
      const pad = i % 2 === 0 ? '' : 'x'.repeat(65_536 - 1 - rand(300)) + '\n';   // a line straddles the first chunk
      const b = Buffer.from(pad + text);
      if (kindOf(b) !== oracle(b)) diffs.push(JSON.stringify(pad.length) + JSON.stringify(text.slice(0, 80)));
    }
    expect(diffs).toEqual([]);
  });
  it('a multi-byte blank character cut by the 64 KiB read boundary still counts as blank', () => {
    expect(kindOf('\u3000'.repeat(40_000) + '\n')).toBe('empty');
    expect(kindOf('\u3000'.repeat(40_000) + 'x\n')).toBe('other');
  });
});

describe('ledgerContentKindOfFd: the time the SessionStart hook can be made to spend (Review Focus 1)', () => {
  // Deadlines, not measurements. Under the bound the measured worst cold judgement is 2,753 ms for 4 MiB of { lines
  // WITHOUT the form check and about 1.2 s for crafted {\} lines (options-o1-notes sections 1 and 2); the host's limit is 10 s.
  it('8 MiB of { lines is decided inside the bound, far under the limit', () => {
    const b = Buffer.from('{\n'.repeat(4 * 1024 * 1024));
    const t0 = performance.now(); expect(kindOf(b)).toBe('other'); expect(performance.now() - t0).toBeLessThan(5_000);
  });
  it('8 MiB of crafted {\\} lines (each one reaches JSON.parse) is decided inside the bound', () => {
    const b = Buffer.from('{\\}\n'.repeat(2 * 1024 * 1024));
    const t0 = performance.now(); expect(kindOf(b)).toBe('other'); expect(performance.now() - t0).toBeLessThan(5_000);
  });
  it('32 MiB of text lines costs one bounded read', () => {
    const p = join(dir, 'big'); const fd0 = fs.openSync(p, 'w'); const chunk = Buffer.from('x\n'.repeat(1 << 20));
    for (let i = 0; i < 16; i++) fs.writeSync(fd0, chunk); fs.closeSync(fd0);
    const fd = fs.openSync(p, 'r');
    try { const t0 = performance.now(); expect(ledgerContentKindOfFd(fd)).toBe('other'); expect(performance.now() - t0).toBeLessThan(1_000); } finally { fs.closeSync(fd); }
  });
});

describe('ledgerContentKindAt (adopt\'s content check)', () => {
  it('reads a regular file afresh, never follows a link, never blocks on a FIFO', () => {
    const p = join(dir, 'at-rows'); fs.writeFileSync(p, rec('a'));
    expect(ledgerContentKindAt(p)).toBe('rows');
    fs.writeFileSync(p, 'plain text\n');
    expect(ledgerContentKindAt(p)).toBe('other');
    fs.symlinkSync(p, join(dir, 'at-link'));
    expect(() => ledgerContentKindAt(join(dir, 'at-link'))).toThrow();                // O_NOFOLLOW: ELOOP
    execFileSync('mkfifo', [join(dir, 'at-fifo')]);
    expect(ledgerContentKindAt(join(dir, 'at-fifo'))).toBe('other');                    // not a regular file, opened O_NONBLOCK
    expect(ledgerContentKindAt(dir)).toBe('other');                                     // a directory
    expect(() => ledgerContentKindAt(join(dir, 'absent'))).toThrow();
  });
});
