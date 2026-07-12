import { describe, it, expect } from 'vitest';
import { parseLedgerText, parseLedgerHealth } from '../../src/memory/ledger.js';

const base = (over: object) => JSON.stringify({ id: 'x', content: 'x', tx: '2026-01-01T00:00:00.000Z', provenance: { source: 'user', sessionId: 's' }, ...over });

describe('parse boundary', () => {
  it('removing the mac clause: a future object-shaped mac row now SURVIVES parse', () => {
    const rows = parseLedgerText(base({ mac: { algorithm: 'x', value: 'y' }, macVersion: 3 }));
    expect(rows).toHaveLength(1); // was dropped by the old `typeof mac === string` clause
  });
  it('still tolerates a torn line (skips, does not throw)', () => {
    expect(parseLedgerText('{"id":"a","content":"c","tx":"t","provenance":{}}\n{bad')).toHaveLength(1);
  });
  it('rejects a pathologically deep row (depth cap) but keeps a shallow one', () => {
    const deep = base({ classification: JSON.parse('['.repeat(200) + ']'.repeat(200)) });
    expect(parseLedgerText(deep)).toHaveLength(0);          // dropped by MAX_PARSE_DEPTH
    expect(parseLedgerText(base({ classification: 'normal' }))).toHaveLength(1);
  });
  it('depth probe itself does not overflow on a deep row (iterative, not recursive)', () => {
    // Built as raw JSON TEXT, not via JSON.stringify(JSON.parse(...)): V8's JSON.stringify is itself
    // recursive and throws RangeError constructing a 20000-deep fixture on this stack size — a
    // test-scaffolding limit, unrelated to the iterative-vs-recursive probe this test exists to check.
    // JSON.parse (called inside parseLedgerText) tolerates this depth fine; only stringify does not.
    const nested = '['.repeat(20000) + ']'.repeat(20000);
    const veryDeep = `{"id":"x","content":"x","tx":"2026-01-01T00:00:00.000Z","provenance":{"source":"user","sessionId":"s"},"x":${nested}}`;
    expect(() => parseLedgerText(veryDeep)).not.toThrow();  // probe must be iterative
    expect(parseLedgerText(veryDeep)).toHaveLength(0);
  });
  it('parseLedgerHealth counts a skipped nonblank line (mid or final)', () => {
    const h = parseLedgerHealth('{"id":"a","content":"c","tx":"t","provenance":{}}\n{bad mid\n{"id":"b","content":"c","tx":"t","provenance":{}}');
    expect(h.records).toHaveLength(2);
    expect(h.skippedNonBlank).toBe(1);
  });
  it('parseLedgerHealth ignores blank lines', () => {
    expect(parseLedgerHealth('\n\n').skippedNonBlank).toBe(0);
  });
});
